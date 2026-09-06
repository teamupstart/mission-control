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
const { bindSession } = await import("../src/server/terminal/registry.ts");
const { resolveBin, TMUX_BIN } = await import("../src/server/terminal/bin.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;
type SdkSupervisor = import("../src/server/sdk/supervisor.ts").SdkSupervisor;
type Session = import("../src/shared/types.ts").Session;
type SessionState = import("../src/shared/types.ts").SessionState;
type Registry = import("../src/server/registry.ts").Registry;
type PaneDeps = import("../src/server/actions.ts").PaneDeps;
type TerminalExec = import("../src/server/terminal/exec.ts").TerminalExec;

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

/**
 * A pane-backed Claude session, registered the only way one is ever born: through discovery.
 *
 * `applyDiscovery` is what stamps `runtime: "terminal"` (`registry.ts:mergeDiscovered`), so
 * building the `Session` literal by hand would be asserting against a shape production never
 * produces. `working` is applied on top because the interrupt's queue drop is gated on a turn
 * having genuinely been in flight.
 */
function paneSession(registry: Registry, state: "idle" | "working" = "working") {
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
    terminals: [mkMuxHandle({ session: "pane session", paneId: "%1" })],
    startedAt: 0,
  };
  registry.applyDiscovery([discovered]);
  const found = registry.snapshot().sessions[0]!;
  // The passive path, because that is how a pane-backed session's state is actually known:
  // re-derived from its transcript on a poll tick, not pushed by an event pump. Using the
  // driver-event door would assert against a signal a terminal session never has.
  //
  // Two sweeps, and the second is not ceremony - a passive reading is recorded against the
  // session key and folded in when discovery next merges, so a single sweep would leave the
  // card on the `working` a freshly discovered session starts at. That is the real poller's
  // order, and asserting through it is what makes an `idle` here mean what it means live.
  registry.applyPassiveActivity(found, { state, lastActivity: 1 });
  registry.applyDiscovery([discovered]);
  return registry.getSession(found.id)!;
}

/**
 * The real tmux adapter over a faked subprocess, so the assertion is on the ARGV the daemon
 * would have run.
 *
 * `bindSession(session, exec)` rather than a hand-built `BoundPane`: the point of this test
 * is the rendering of `escape` into one backend's own convention, and a fake pane would
 * assert only that the string "escape" was passed to a function I also wrote. `inMode`
 * drives the copy-mode probe, which tmux answers through `display-message`.
 */
function recordingPane(inMode = "0"): { deps: PaneDeps; argv: string[] } {
  const argv: string[] = [];
  const exec: TerminalExec = async (bin, args) => {
    const ok = { code: 0, stderr: "", outcomeUnknown: false, overflowed: false };
    if (args.includes("display-message")) return { ...ok, stdout: `${inMode} copy-mode` };
    argv.push([bin, ...args].join(" "));
    return { ...ok, stdout: "" };
  };
  return { argv, deps: { pane: (s) => bindSession(s, exec), capture: async () => null } };
}

test("a terminal session is stopped by writing Escape into its pane", async () => {
  // The claim this phase makes, end to end through the route: a pane-backed Claude session
  // is no longer refused, and what reaches the pane is `Escape` - NOT the operator's literal
  // Ctrl+C, which the TUI reads as "clear the line" and, twice, as "quit". Asserting the
  // rendered argv is the only way to tell those two apart; a 200 says nothing about it.
  const registry = new Registry();
  const session = paneSession(registry);
  assert.equal(session.runtime, "terminal");
  const pane = recordingPane();
  const app = buildApp(
    registry, {} as ReviewManager, {} as TaskManager, {} as QueueManager,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, pane.deps,
  );

  const response = await interrupt(app, session.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, stoppedTurn: true, droppedQueued: 0 });
  assert.deepEqual(pane.argv, [`${resolveBin(TMUX_BIN)} send-keys -t %1 -- Escape`]);
});

test("a pane in copy-mode is refused with 409 and is NOT pulled out of it", async () => {
  // The deliberate decision, and the one a later reader is most likely to "fix". Escape is
  // the key that EXITS tmux copy-mode, so an ungated interrupt would yank the operator out
  // of the scrollback they are reading AND leave the agent running - strictly worse than
  // refusing. 409 rather than 500 because the cause is a person, and it clears when they
  // leave the mode.
  const registry = new Registry();
  const session = paneSession(registry);
  const pane = recordingPane("1");
  const app = buildApp(
    registry, {} as ReviewManager, {} as TaskManager, {} as QueueManager,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, pane.deps,
  );

  const response = await interrupt(app, session.id);
  assert.equal(response.status, 409);
  const body = (await response.json()) as { ok: boolean; error: string; paneBlocked: boolean };
  assert.equal(body.ok, false);
  assert.equal(body.paneBlocked, true);
  assert.match(body.error, /copy-mode/, "the refusal names the mode the operator has to leave");
  assert.deepEqual(pane.argv, [], "not one keystroke was attempted, so nothing cancelled the mode");
});

test("a pane interrupt that found no turn running leaves the queue alone", async () => {
  // The terminal half of the race phase 1 closed for the driver. A card renders `working`
  // from a poll tick, so it is always slightly behind; a turn that ended just before the
  // request landed leaves the control live and the request legitimate, and yet nothing was
  // stopped. Dropping durable outbox rows on the strength of that is data loss.
  const registry = new Registry();
  const session = paneSession(registry, "idle");
  const pane = recordingPane();

  const dropped: string[] = [];
  const result = await interruptSession(session, undefined, {
    dropQueued: (id) => { dropped.push(id); return 1; },
  }, pane.deps);

  assert.equal(result.ok, true);
  assert.equal(result.stoppedTurn, false, "an idle pane session had no turn to stop");
  assert.equal(result.droppedQueued, undefined);
  assert.deepEqual(dropped, [], "nothing queued was deleted for a stop that did not happen");
  // The Escape still went, because the reading is a tick old and the opposite race is real.
  assert.deepEqual(pane.argv, [`${resolveBin(TMUX_BIN)} send-keys -t %1 -- Escape`]);
});

test("a session with no pane to write to is a 500, not a silent success", async () => {
  const registry = new Registry();
  const session = paneSession(registry);
  const app = buildApp(
    registry, {} as ReviewManager, {} as TaskManager, {} as QueueManager,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, { pane: () => null, capture: async () => null },
  );

  const response = await interrupt(app, session.id);
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /no terminal pane/);
});

test("a harness with no interrupt mechanism at all is still refused by the route", async () => {
  // The 400 arm survives this phase - it just has a different occupant. Every shipped
  // harness can now be interrupted on some runtime, so the refusal is reached by taking the
  // capability away, which is what a harness that genuinely cannot be stopped would declare.
  const registry = new Registry();
  const session = paneSession(registry);
  const app = buildApp(registry, {} as ReviewManager, {} as TaskManager, {} as QueueManager);
  const prior = HARNESS_CAPABILITIES.claude.interrupt;
  HARNESS_CAPABILITIES.claude.interrupt = null;
  try {
    const response = await interrupt(app, session.id);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /can't stop a Claude Code turn once it has started/);
  } finally {
    HARNESS_CAPABILITIES.claude.interrupt = prior;
  }
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
