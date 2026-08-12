import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: `POST /api/sessions/:id/interrupt` is the one door between "wait for
// this agent to finish work nobody wants" and "kill the session that holds all the context
// worth keeping". Everything below is about that door refusing HONESTLY.
//
// The three refusals are three different facts and none of them may be silent. A session
// that does not exist is a 404. A harness/runtime pair with no mechanism at all is a 400
// carrying the capability's own sentence - the same one the disabled button's tooltip shows,
// so a client cannot be told two things. A pair that HAS a mechanism whose driver has gone
// is a 500, because that is a failure of this request rather than a property of the session.
//
// And one success, which is the whole gesture: the driver was asked to stop, the queue
// behind it went, and the rows that had already left or were in doubt did not.

const home = mkdtempSync(join(tmpdir(), "mission-session-interrupt-http-"));
process.env.MISSION_HOME = home;

const { buildApp } = await import("../src/server/routes.ts");
const { PendingTurnManager } = await import("../src/server/pending-turns.ts");
const { Registry } = await import("../src/server/registry.ts");
const { claimNextPendingTurn, createPendingTurn, listPendingTurns } = await import(
  "../src/server/db.ts"
);
const { interruptSession } = await import("../src/server/sdk/control.ts");
const { HARNESS_CAPABILITIES } = await import("../src/shared/harness-capabilities.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Session = import("../src/shared/types.ts").Session;

after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317" };

let fixtureSerial = 0;

/**
 * One embedded session, one supervisor recording what it was asked to do, one real outbox.
 *
 * `interrupted` is an array rather than a flag on purpose: several cases below turn on the
 * driver having been reached exactly once, or not at all.
 */
function fixture(options: { interrupt?: () => Promise<"interrupted" | "idle" | null> } = {}) {
  fixtureSerial += 1;
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: `sdk:interrupt-http:${fixtureSerial}`,
    agent: "claude",
    name: "interrupt routes",
    cwd: `/repo/interrupt-${fixtureSerial}`,
    agentSessionId: `agent:interrupt-http:${fixtureSerial}`,
  });
  // Working, so the session is genuinely mid-turn for every case that asks to stop one.
  registry.applyDriverEvent(session.id, { kind: "state", state: "working", activity: null });
  const interrupted: string[] = [];
  const supervisor = {
    interrupt: async (id: string) => {
      interrupted.push(id);
      return options.interrupt ? await options.interrupt() : "interrupted";
    },
    sendWhenIdle: async () => "started" as const,
  } as unknown as SdkSupervisor;
  const pending = new PendingTurnManager(registry, supervisor, { idleSettleMs: 0 });
  pending.start();
  const app = buildApp(
    registry,
    {} as ReviewManager,
    {} as TaskManager,
    {} as QueueManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    supervisor,
    undefined,
    undefined,
    undefined,
    pending,
  );
  // The outbox is keyed on the CONVERSATION, not the card: `noteKeyFor` prefers the
  // harness-native id, so rows follow the conversation across a restart.
  const key = `agent:interrupt-http:${fixtureSerial}`;
  return { registry, session, supervisor, interrupted, pending, app, key };
}

function interrupt(app: ReturnType<typeof buildApp>, id: string) {
  return app.request(`/api/sessions/${encodeURIComponent(id)}/interrupt`, {
    method: "POST",
    headers: HEADERS,
  });
}

test("a session nobody has heard of is a 404, before any mechanism is consulted", async () => {
  const f = fixture();
  const response = await interrupt(f.app, "sdk:not-a-session");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no such session" });
  assert.deepEqual(f.interrupted, [], "nothing was asked to stop");
  f.pending.stop();
});

test("interrupting stops the turn and takes the queue behind it with it", async () => {
  const f = fixture();
  // Three rows: one already gone to the harness, two still editable. Oldest first, because
  // the claim takes the head of the queue.
  createPendingTurn({ id: "in-flight", noteKey: f.key, text: "already sending", now: 1 });
  createPendingTurn({ id: "drop-1", noteKey: f.key, text: "wrong path, part two", now: 2 });
  createPendingTurn({ id: "drop-2", noteKey: f.key, text: "wrong path, part three", now: 3 });
  claimNextPendingTurn(f.key, 4);
  f.registry.refreshPendingTurns(f.key);

  const response = await interrupt(f.app, f.session.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, stoppedTurn: true, droppedQueued: 2 });
  assert.deepEqual(f.interrupted, [f.session.id]);
  // The count is not the assertion - what survived is. Leaving the queue armed would have
  // restarted the work the operator just stopped; deleting the row that already left would
  // have erased the only record of a message that may be mid-flight.
  assert.deepEqual(
    listPendingTurns(f.key).map((turn) => [turn.text, turn.state]),
    [["already sending", "sending"]],
  );
  f.pending.stop();
});

test("a driver that has gone is a 500 naming what is missing, not a silent success", async () => {
  const f = fixture({ interrupt: async () => null });
  createPendingTurn({ id: "survives", noteKey: f.key, text: "still wanted", now: 1 });
  f.registry.refreshPendingTurns(f.key);

  const response = await interrupt(f.app, f.session.id);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "this session has no live embedded driver",
  });
  // And the queue is untouched. A refused interrupt changed nothing about what the agent is
  // doing, so discarding what was waiting for it would destroy work for no reason.
  assert.deepEqual(
    listPendingTurns(f.key).map((turn) => turn.text),
    ["still wanted"],
  );
  f.pending.stop();
});

test("a driver that throws is reported rather than swallowed", async () => {
  const f = fixture({
    interrupt: async () => {
      throw new Error("the app-server connection is closed");
    },
  });
  const response = await interrupt(f.app, f.session.id);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "the app-server connection is closed",
  });
  f.pending.stop();
});

test("a harness with no interrupt at all is a 400 carrying the capability's own sentence", async () => {
  // pi is the slot's real null declarer, and the sentence a client gets here is the one the
  // card's disabled tooltip shows - composed once, in the capability, so the two cannot
  // drift into telling an operator different things about the same session.
  const f = fixture();
  const restore = HARNESS_CAPABILITIES.claude.interrupt;
  HARNESS_CAPABILITIES.claude.interrupt = null;
  try {
    const response = await interrupt(f.app, f.session.id);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /can't stop a Claude Code turn once it has started/);
    assert.deepEqual(f.interrupted, [], "the mechanism was never consulted");
  } finally {
    HARNESS_CAPABILITIES.claude.interrupt = restore;
  }
  f.pending.stop();
});

test("a runtime this harness cannot be stopped on is refused by runtime, and says which", async () => {
  // The state of the world this phase ships: Claude declares only its Agent SDK turn
  // interruptible, so a pane-backed session is refused - with a sentence naming the runtime,
  // because the same session dispatched the other way WOULD answer to the key. The next
  // phase widens the declaration and this stops being a refusal without any route change.
  const registry = new Registry();
  const discovered: DiscoveredSession = {
    syntheticId: "terminal-interrupt",
    agent: "claude",
    name: "pane session",
    nameSource: "tmux",
    cwd: "/repo/pane",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    pid: 4242,
    tty: "ttys009",
    terminals: [mkMuxHandle({ session: "pane session", paneId: "%deadpane" })],
    startedAt: 0,
  };
  registry.applyDiscovery([discovered]);
  const session = registry.snapshot().sessions[0]!;
  assert.equal(session.runtime, "terminal");
  const app = buildApp(registry, {} as ReviewManager, {} as TaskManager, {} as QueueManager);

  const response = await interrupt(app, session.id);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /can't yet stop a Claude Code turn running in a terminal/);
});

test("the fan-out's pane arm refuses in its own words, which is the next phase's edit point", async () => {
  // Unreachable through the route today, because the capability gate above answers first.
  // Called directly so the arm cannot rot into a silent success while nothing exercises it:
  // this is the ONE function body the terminal phase replaces, and the contract it inherits
  // is that a refusal here leaves the queue alone.
  const f = fixture();
  createPendingTurn({ id: "untouched", noteKey: f.key, text: "still queued", now: 1 });
  f.registry.refreshPendingTurns(f.key);
  const pane = { ...f.session, runtime: "terminal" } as Session;

  const result = await interruptSession(pane, f.supervisor, f.pending);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /cannot yet write an interrupt into a terminal session's pane/);
  assert.equal(result.droppedQueued, undefined);
  assert.deepEqual(f.interrupted, [], "the pane arm must never reach the embedded driver");
  assert.deepEqual(
    listPendingTurns(f.key).map((turn) => turn.text),
    ["still queued"],
  );
  f.pending.stop();
});

test("a build with no supervisor answers rather than pretending the stop landed", async () => {
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: "sdk:no-supervisor",
    agent: "claude",
    name: "no supervisor",
    cwd: "/repo/none",
    agentSessionId: "agent:no-supervisor",
  });
  registry.applyDriverEvent(session.id, { kind: "state", state: "working", activity: null });
  const app = buildApp(registry, {} as ReviewManager, {} as TaskManager, {} as QueueManager);

  const response = await interrupt(app, session.id);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "this build has no session supervisor",
  });
});

test("a turn that ended on its own is not a stop, and takes nothing with it", async () => {
  // The race, at the surface that acts on it. A card renders `working` from an SSE frame, so
  // it is always a little behind: a turn that finishes between the operator's keypress and
  // the request landing leaves the control live and the request legitimate, while there is
  // nothing left to stop. Both drivers accept a late interrupt happily, so a 200 proves
  // nothing on its own.
  //
  // What must NOT happen then is the destructive half. Those queued rows were not work
  // anybody asked to restart - they are about to be delivered normally by the outbox's idle
  // drain - so deleting them is data loss, and answering "Stopped, and dropped 1 queued
  // message" is a claim the operator would act on.
  const f = fixture({ interrupt: async () => "idle" });
  createPendingTurn({ id: "still-wanted", noteKey: f.key, text: "deliver me normally", now: 1 });
  f.registry.refreshPendingTurns(f.key);

  const response = await interrupt(f.app, f.session.id);
  // A success, because the request was serviced and the driver was asked. Not the operator's
  // mistake, and not a failure worth an error flash.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, stoppedTurn: false });
  assert.deepEqual(f.interrupted, [f.session.id], "the driver is still asked, just not claimed");
  assert.deepEqual(
    listPendingTurns(f.key).map((turn) => [turn.text, turn.state]),
    [["deliver me normally", "queued"]],
    "a stop that found nothing must not delete the queue behind it",
  );
  f.pending.stop();
});
