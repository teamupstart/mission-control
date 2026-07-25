import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent, Session } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { SdkEvent, SdkSessionHandle } from "../src/server/harness/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: a session with no process, no tty and no pane has to live in the same
// map, leave by the same door, and be reasoned about by the same code as every session the
// dashboard has ever shown. Three specific ways that goes wrong, all of them quiet:
//
//  1. The discovery sweep evicts it. "Unseen by a completed sweep" is a statement about the
//     process table, and an embedded session is not in it - so an unscoped sweep marks it
//     exited 1.5 seconds after it was registered, for ever, and no dispatch can survive.
//  2. It leaves by a path of its own. `session_remove` is THE durable signal: WorkflowManager
//     orphans its bindings on it and TaskManager settles the task the session was running.
//     A teardown that skips it makes a card vanish while its task stays `running` for ever.
//  3. Its identity never lands. `agentSessionId` / `transcriptPath` are what the entire
//     file-based read path keys on, and the instrumentation flags are what the work queue
//     and the report buckets gate on. A bind that fills neither is a session nobody can
//     read, queue, or see the state of.
//
// The supervisor is driven here on a scripted handle - the `PaneDeps` pattern, one axis over:
// real registry, real supervisor, a fake driver whose events a test writes.

const home = mkdtempSync(join(tmpdir(), "mission-session-runtime-"));
// MISSION_HOME *is* the state dir, so the db lands at <home>/harness.db. Set before
// importing anything that resolves it, which is why every server import below is dynamic.
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry, SDK_SESSION_ID_PREFIX } = await import("../src/server/registry.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { getSdkSession } = await import("../src/server/sdk/store.ts");
const { activePaneDialog, reportBucket } = await import("../src/shared/session.ts");
const { canMessage, canWriteTo } = await import("../src/shared/pane.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const SDK_ID = `${SDK_SESSION_ID_PREFIX}11111111-1111-4111-8111-111111111111`;

function registration(over: Partial<{ id: string; name: string; cwd: string }> = {}) {
  return {
    id: over.id ?? SDK_ID,
    agent: "claude" as const,
    name: over.name ?? "Embedded work",
    cwd: over.cwd ?? "/wt/embedded",
    gitBranch: "mancej/embedded",
    now: 1_000,
  };
}

function discovered(syntheticId: string): DiscoveredSession {
  return {
    syntheticId,
    agent: "claude",
    name: "pane work",
    nameSource: "process",
    cwd: "/wt/pane",
    gitBranch: "main",
    nomistakesGated: false,
    pid: 4242,
    tty: "ttys9",
    terminals: [mkMuxHandle({ session: "s", paneId: "%7" })],
    startedAt: 0,
  } as DiscoveredSession;
}

/** A driver whose events a test pushes by hand, and whose calls it can read back. */
function fakeHandle(): {
  handle: SdkSessionHandle;
  emit: (evt: SdkEvent) => void;
  end: () => void;
  sent: string[];
  stopped: () => number;
} {
  const queue: SdkEvent[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const sent: string[] = [];
  let stops = 0;
  const events = (async function* () {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const handle: SdkSessionHandle = {
    events,
    send: async (turn) => void sent.push(turn.text),
    interrupt: async () => {},
    answer: async () => {},
    setPermissionMode: null,
    setModel: null,
    clearContext: null,
    stop: async () => {
      stops += 1;
      done = true;
      wake?.();
    },
  };
  return {
    handle,
    emit: (evt) => {
      queue.push(evt);
      wake?.();
      wake = null;
    },
    end: () => {
      done = true;
      wake?.();
      wake = null;
    },
    sent,
    stopped: () => stops,
  };
}

/** Let the detached event pump drain what a test just pushed at it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("a registered SDK session is a full Session with no pane and no tty", () => {
  const r = new Registry();
  const s = r.registerSdkSession(registration());
  assert.equal(s.runtime, "sdk");
  assert.equal(s.nameSource, "sdk");
  assert.equal(s.state, "starting");
  assert.deepEqual(s.terminals, []);
  assert.equal(s.tty, null);
  assert.equal(s.agentSessionId, null, "identity arrives with the driver's bound event");
  assert.equal(s.hooksSeen, false);
  assert.equal(s.stateConfirmed, false);
  // The two predicates come apart here, which is the whole reason `canMessage` exists.
  assert.equal(canWriteTo(s), false);
  assert.equal(canMessage(s), true);
  // And it is in the snapshot every reconnecting dashboard reads, not a side list.
  assert.deepEqual(
    r.snapshot().sessions.map((row) => row.id),
    [s.id],
  );
});

test("registration refuses an id outside the sdk space, and refuses a second holder", () => {
  const r = new Registry();
  // The prefix exists so discovery's `proc:` ids and the supervisor's cannot collide. It is
  // checked here and nowhere else - no behaviour anywhere may branch on the spelling.
  assert.throws(() => r.registerSdkSession(registration({ id: "proc:ttys1:1:0" })), /sdk:/);
  r.registerSdkSession(registration());
  // Two handles believing they own one card would leave the loser pumping events into a
  // session it does not drive, so this is loud rather than idempotent.
  assert.throws(() => r.registerSdkSession(registration()), /already registered/);
});

test("adoption refusals do not create or overwrite durable rows", async () => {
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: "task-original", model: "model-original", effort: null },
  });
  driver.emit({
    kind: "bound",
    agentSessionId: "agent-original",
    transcriptPath: "/transcripts/agent-original.jsonl",
    pid: null,
  });
  await settle();
  const before = getSdkSession(SDK_ID);

  assert.throws(
    () =>
      sup.adopt({
        registration: registration(),
        handle: fakeHandle().handle,
        durable: { taskId: "task-replacement", model: "model-replacement", effort: null },
      }),
    /already registered/,
  );
  assert.deepEqual(getSdkSession(SDK_ID), before);

  const invalidId = "proc:ttys1:1:0";
  assert.throws(
    () =>
      sup.adopt({
        registration: registration({ id: invalidId }),
        handle: fakeHandle().handle,
        durable: { taskId: null, model: null, effort: null },
      }),
    /sdk:/,
  );
  assert.equal(getSdkSession(invalidId), null);
  await sup.stop(SDK_ID);
});

test("a completed discovery sweep does not evict an SDK session", () => {
  const r = new Registry();
  r.registerSdkSession(registration());
  // A sweep that sees an entirely different session. For a pane-backed entry this is the
  // eviction signal; for an embedded one it is no information at all, because there was
  // never a process on a tty to find.
  r.applyDiscovery([discovered("proc:ttys9:4242:0")]);
  r.applyDiscovery([discovered("proc:ttys9:4242:0")]);
  assert.equal(r.getSession(SDK_ID)?.state, "starting");
  // And the pane-backed session in the same sweep is still evicted normally when it goes.
  r.applyDiscovery([]);
  assert.equal(r.getSession("proc:ttys9:4242:0")?.state, "exited");
  assert.equal(r.getSession(SDK_ID)?.state, "starting");
});

test("bound fills the identity the read path needs and confirms instrumentation", async () => {
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });
  driver.emit({
    kind: "bound",
    agentSessionId: "agent-abc",
    transcriptPath: "/transcripts/agent-abc.jsonl",
    pid: 4321,
  });
  await settle();
  const s = r.getSession(SDK_ID)!;
  assert.equal(s.agentSessionId, "agent-abc");
  assert.equal(s.transcriptPath, "/transcripts/agent-abc.jsonl");
  assert.equal(s.pid, 4321);
  // All three, and each buys something: `hooksSeen` is what the work queue refuses on,
  // `stateConfirmed` is what the report buckets trust, `instrumented` is the live badge.
  // An embedded session is instrumented BY CONSTRUCTION - the handle IS the push channel.
  assert.equal(s.hooksSeen, true);
  assert.equal(s.stateConfirmed, true);
  assert.equal(s.instrumented, true);
  // Durable too, so a restart can cut a resume from it.
  assert.equal(getSdkSession(SDK_ID)?.agentSessionId, "agent-abc");
  assert.equal(getSdkSession(SDK_ID)?.status, "running");

  driver.emit({
    kind: "bound",
    agentSessionId: "agent-def",
    transcriptPath: "/transcripts/agent-def.jsonl",
    pid: null,
  });
  await settle();
  assert.equal(r.getSession(SDK_ID)?.pid, 4321, "a driver with no separate process keeps the pid");
  await sup.stop(SDK_ID);
});

test("driver state and turn_done move the card the way a hook does", async () => {
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });
  driver.emit({ kind: "state", state: "working", activity: "editing registry.ts" });
  await settle();
  assert.equal(r.getSession(SDK_ID)?.state, "working");
  assert.equal(r.getSession(SDK_ID)?.activity, "editing registry.ts");
  assert.equal(reportBucket(r.getSession(SDK_ID)!), "working");
  driver.emit({ kind: "turn_done", usage: null });
  await settle();
  assert.equal(r.getSession(SDK_ID)?.state, "idle", "the turn ended, so the session is idle");
  await sup.stop(SDK_ID);
});

test("a driver request is the dialog every surface already renders", async () => {
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });
  driver.emit({
    kind: "request",
    request: {
      id: "req-1",
      kind: "permission",
      prompt: "Run npm test?",
      options: [
        { number: 1, label: "Yes" },
        { number: 2, label: "No" },
      ],
    },
  });
  await settle();
  const dialog = activePaneDialog(r.getSession(SDK_ID)!);
  assert.ok(dialog, "a pending driver request lives in the same field a pane dialog does");
  assert.equal(dialog.source, "driver");
  assert.equal(dialog.requestId, "req-1");
  assert.equal(dialog.kind, "permission");
  assert.equal(dialog.prompt, "Run npm test?");
  // No cursor, so no default row: nothing can confirm an answer nobody chose.
  assert.equal(dialog.highlighted, 0);
  assert.equal(dialog.multiSelect, undefined);
  // Which is what makes the session read as needing a human with no new arm anywhere.
  assert.equal(reportBucket(r.getSession(SDK_ID)!), "needs-you");

  // Resolving clears it - but only the request that is actually on the card.
  driver.emit({ kind: "request_resolved", requestId: "someone-elses" });
  await settle();
  assert.ok(activePaneDialog(r.getSession(SDK_ID)!), "a stale resolve must not clear a live ask");
  driver.emit({ kind: "request_resolved", requestId: "req-1" });
  await settle();
  assert.equal(activePaneDialog(r.getSession(SDK_ID)!), null);
  await sup.stop(SDK_ID);
});

test("a multi-question ask becomes a form, with its questions intact", async () => {
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });
  driver.emit({
    kind: "request",
    request: {
      id: "req-form",
      kind: "question",
      prompt: "Two things",
      options: [],
      questions: [
        { question: "Which database?", options: [{ number: 1, label: "sqlite" }] },
        {
          question: "Which runtimes?",
          multiSelect: true,
          options: [
            { number: 1, label: "node" },
            { number: 2, label: "bun" },
          ],
        },
      ],
    },
  });
  await settle();
  const dialog = activePaneDialog(r.getSession(SDK_ID)!)!;
  assert.equal(dialog.multiSelect, true, "a form is answered as a whole, not row by row");
  assert.equal(dialog.questions?.length, 2);
  // Deliberately NOT flattened into one numbered list: those numbers would mean nothing to
  // the driver, which answers per question.
  assert.deepEqual(dialog.options, []);
  await sup.stop(SDK_ID);
});

test("an exited driver leaves through session_remove, on the ordinary linger", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 5_000 });
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  const events: ServerEvent[] = [];
  r.subscribe((e) => events.push(e));
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });
  driver.emit({ kind: "exited", reason: "turn complete", resumable: true });
  // The pump is detached, and mocked timers do not stop microtasks resolving.
  for (let i = 0; i < 200; i++) await Promise.resolve();

  const exited = events.filter(
    (e): e is Extract<ServerEvent, { type: "session_upsert" }> =>
      e.type === "session_upsert" && e.session.id === SDK_ID && e.session.state === "exited",
  );
  assert.ok(exited.length > 0, "the card greys out at once, as a vanished pane's does");
  assert.equal(
    events.some((e) => e.type === "session_remove"),
    false,
    "and lingers first - removal is not immediate for either runtime",
  );
  assert.equal(getSdkSession(SDK_ID)?.status, "exited");
  assert.equal(
    sup.handleFor(SDK_ID),
    null,
    "an exited event is terminal even when the iterable stays open",
  );

  // The same 8s eviction timer `applyDiscovery` starts. Not a second teardown: both
  // subscribers of `session_remove` (workflow bindings, task settling) depend on this exact
  // event, and a lookalike would leave a task `running` with no session to settle it.
  t.mock.timers.tick(9_000);
  assert.deepEqual(
    events.filter((e) => e.type === "session_remove").map((e) => e.id),
    [SDK_ID],
  );
  assert.equal(r.getSession(SDK_ID), undefined);
});

test("a driver stream that just ends still evicts the session", async () => {
  // An adapter that returns (or throws) without an `exited` event is the same fact for the
  // dashboard: nothing is driving this card any more, so a Send box on it would lie.
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });
  driver.end();
  await settle();
  assert.equal(r.getSession(SDK_ID)?.state, "exited");
  assert.equal(sup.handleFor(SDK_ID), null);
});

test("delivery is acked and serialized per session, and refused when nothing is driving", async () => {
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });
  await Promise.all([
    sup.send(SDK_ID, { text: "first" }),
    sup.send(SDK_ID, { text: "second" }),
  ]);
  // Order preserved: this is the pane lock's job without the pane, and two turns
  // interleaved into one conversation is the same hazard as two pastes into one composer.
  assert.deepEqual(driver.sent, ["first", "second"]);
  await sup.stop(SDK_ID);
  await settle();
  // Rejects rather than resolving. "Delivered to nobody" is precisely the failure the acked
  // send exists to remove, and must not come back in as a silent success.
  await assert.rejects(sup.send(SDK_ID, { text: "third" }), /no live driver/);
});

test("queued delivery is refused when its driver exits before it runs", async () => {
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  driver.handle.send = async (turn) => {
    driver.sent.push(turn.text);
    if (turn.text === "first") {
      markFirstStarted();
      await firstBlocked;
    }
  };
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });

  const first = sup.send(SDK_ID, { text: "first" });
  await firstStarted;
  const second = sup.send(SDK_ID, { text: "second" });
  const secondRefused = assert.rejects(second, /no live driver/);
  await sup.stop(SDK_ID);
  await settle();
  releaseFirst();

  await first;
  await secondRefused;
  assert.deepEqual(driver.sent, ["first"]);
});

test("a driver event about a pane-backed session is refused", async () => {
  const r = new Registry();
  r.applyDiscovery([discovered("proc:ttys9:4242:0")]);
  const before = r.getSession("proc:ttys9:4242:0") as Session;
  r.applyDriverEvent("proc:ttys9:4242:0", {
    kind: "bound",
    agentSessionId: "not-ours",
    transcriptPath: "/nope.jsonl",
    pid: 9999,
  });
  // Same shape of refusal `applyHook` makes for a harness that declares no hooks: a card we
  // reach by typing must not have its identity rewritten by something claiming its handle.
  assert.equal(r.getSession("proc:ttys9:4242:0")?.agentSessionId, before.agentSessionId);
  // And an event about a session nobody knows is dropped rather than creating one.
  r.applyDriverEvent(`${SDK_SESSION_ID_PREFIX}unknown`, { kind: "turn_done", usage: null });
  assert.equal(r.getSession(`${SDK_SESSION_ID_PREFIX}unknown`), undefined);
});

test("a driver-observed gh pr create decorates the card and proves authorship once", async () => {
  const r = new Registry();
  const sup = new SdkSupervisor(r);
  const driver = fakeHandle();
  const opened: string[] = [];
  r.onPrOpened((e) => opened.push(e.url));
  sup.adopt({
    registration: registration(),
    handle: driver.handle,
    durable: { taskId: null, model: null, effort: null },
  });
  driver.emit({ kind: "pr_created", url: "https://github.com/o/r/pull/7" });
  await settle();
  assert.equal(r.getSession(SDK_ID)?.prUrl, "https://github.com/o/r/pull/7");
  assert.equal(r.getSession(SDK_ID)?.prNumber, 7);
  assert.equal(r.getSession(SDK_ID)?.prState, "open");
  // Authorship evidence, which is the only thing `adoptPr` accepts - a `prUrl` sniff proves
  // nothing about who opened it, and commenting on a stranger's PR is what that costs.
  assert.deepEqual(opened, ["https://github.com/o/r/pull/7"]);
  await sup.stop(SDK_ID);
});
