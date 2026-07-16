import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// What the worker's orphan sweep is allowed to escalate.
//
// The sweep terminalizes the in-flight item of every queue whose note key matches
// no live session, and escalation is TERMINAL - there is no undo. So the only thing
// it may act on is positive evidence that a session is gone. Two different routes
// used to fake that evidence, and both reported it about perfectly healthy sessions:
//
//  - A queue is keyed on `noteKeyFor(s)` = `agentSessionId ?? syntheticId`, and for
//    a hook-instrumented session (which is the only kind that can hold a queue at
//    all) that's the agentSessionId. It was in-memory only, so a daemon restart
//    rebuilt every session under its synthetic id instead and no stored queue
//    matched anything live.
//  - The daemon answers /api/queues the moment it binds its port, while the first
//    discovery sweep is an async `ps` scan landing later. In that window the session
//    map is empty - not because the sessions are gone, but because nobody has looked.
//
// Every queue here is therefore keyed on an `agentSessionId`, the way a real
// hook-instrumented session's queue is. Keying on the synthetic id is the ONE case
// where neither bug can show, which is exactly why they survived their first tests.

const home = mkdtempSync(join(tmpdir(), "mission-orphan-sweep-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { QueueManager } = await import("../src/server/queue.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

function mkDiscovered(syntheticId: string, paneId: string): DiscoveredSession {
  return {
    syntheticId,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: { session: "s", window: "w", windowIndex: 0, paneId },
    startedAt: 0,
  } as DiscoveredSession;
}

/**
 * A hook-instrumented session with an in-flight work item - i.e. exactly the state
 * the sweep is dangerous in. Returns its note key, which is the AGENT session id.
 */
function seedQueue(syntheticId: string, agentSessionId: string, paneId: string): string {
  const registry = new Registry();
  const queues = new QueueManager(registry);
  registry.applyDiscovery([mkDiscovered(syntheticId, paneId)]);
  registry.applyHook({
    event: "Stop",
    sessionId: agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: paneId },
  });
  assert.equal(
    registry.getSession(syntheticId)?.agentSessionId,
    agentSessionId,
    "the hook must bind the agent session id, or this fixture isn't the real shape",
  );

  const item = queues.add(syntheticId, "add the retry");
  assert.ok(item);
  assert.equal(item.noteKey, agentSessionId, "the queue is keyed on the AGENT session id");
  assert.ok(queues.setState(item.id, { state: "in_progress" }).ok);
  // Membership, not equality: the DB is shared across tests here, so earlier tests'
  // deliberately-orphaned queues are still in it.
  assert.ok(
    !orphanKeys(queues).includes(item.noteKey),
    "a live session's queue is never orphaned",
  );
  return item.noteKey;
}

const orphanKeys = (queues: InstanceType<typeof QueueManager>): string[] =>
  queues.orphaned().map((q) => q.noteKey);

test("a daemon RESTART does not orphan a healthy session's queue", () => {
  // The agent session id is reported only by a live hook, so on restart a quiet
  // session (an item in `verifying` IS quiet - the agent finished and is idle, so
  // nothing will emit a hook to rebind it) rebuilt with a null binding. Its key
  // reverted to the synthetic id, the stored queue matched nothing, and the sweep -
  // which runs every 4s - escalated its in-flight item claiming "the session
  // vanished while this item was in flight", about a session that is right there.
  const key = seedQueue("restart-1", "agent-restart-1", "%1");

  // The daemon restarts: a brand-new Registry, an empty overlay map, no hooks yet.
  const restarted = new Registry();
  const queues = new QueueManager(restarted);
  restarted.applyDiscovery([mkDiscovered("restart-1", "%1")]);

  const s = restarted.getSession("restart-1");
  assert.equal(s?.instrumented, false, "no overlay survived the restart - it never does");
  assert.equal(s?.agentSessionId, "agent-restart-1", "but the binding is read back from the DB");
  assert.ok(!orphanKeys(queues).includes(key), "so its queue still belongs to it");
});

test("a queue is not orphaned before the first discovery sweep has even run", () => {
  // Persistence doesn't cover this one: the daemon serves /api/* from the moment it
  // binds its port, and the worker polls the sweep several times a second, so it
  // WILL ask before the first `ps` scan lands. An empty session map is an absence of
  // evidence, not evidence of absence.
  const key = seedQueue("presweep-1", "agent-presweep-1", "%2");

  const restarted = new Registry();
  const queues = new QueueManager(restarted);
  // No applyDiscovery: the poller's first tick hasn't finished.
  assert.ok(
    !orphanKeys(queues).includes(key),
    "nobody has looked at the sessions yet - the sweep must not escalate off that",
  );

  // And the moment a sweep confirms the session is there, it's still not orphaned.
  restarted.applyDiscovery([mkDiscovered("presweep-1", "%2")]);
  assert.ok(!orphanKeys(queues).includes(key));
});

test("a session that is GENUINELY gone still hands its queue to the sweep", () => {
  // The other half of the contract. Both guards above are about not escalating from
  // a session list we can't vouch for - neither may become "never escalate", or an item
  // stranded mid-cycle by a real exit would hold the single-flight index forever and
  // block the queue behind a phantom.
  const key = seedQueue("gone-1", "agent-gone-1", "%3");

  const restarted = new Registry();
  const queues = new QueueManager(restarted);
  // A sweep that COMPLETED and found this session nowhere. That's a session list we looked
  // at, so the absence is a finding.
  restarted.applyDiscovery([]);

  assert.ok(orphanKeys(queues).includes(key), "the session really is gone - escalate it");
});

test("a hook that lands BEFORE discovery still gets its binding persisted", () => {
  // The launch ordering, and the ordinary one: hooks bind to a pane, so a session's
  // first hook can easily beat the `ps` sweep that discovers it. That hook has no
  // live session to apply to - it only reaches an overlay - so the binding arrives
  // on the card via `mergeDiscovered`, never through applyHook's live-session
  // branch. Persisting only from the latter looks right and quietly stores nothing:
  // the overlay has already set the id, so the next hook sees no change to record.
  const registry = new Registry();
  const queues = new QueueManager(registry);
  registry.applyHook({
    event: "UserPromptSubmit",
    sessionId: "agent-early",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%5" },
  });
  registry.applyDiscovery([mkDiscovered("early-1", "%5")]);
  assert.equal(registry.getSession("early-1")?.agentSessionId, "agent-early");

  const item = queues.add("early-1", "add the retry");
  assert.equal(item?.noteKey, "agent-early");
  assert.ok(queues.setState(item!.id, { state: "in_progress" }).ok);

  const restarted = new Registry();
  const afterRestart = new QueueManager(restarted);
  restarted.applyDiscovery([mkDiscovered("early-1", "%5")]);
  assert.equal(restarted.getSession("early-1")?.agentSessionId, "agent-early");
  assert.ok(
    !orphanKeys(afterRestart).includes("agent-early"),
    "the binding it was only ever told about by an overlay still survived",
  );
});

test("a /clear orphans the queue it left behind, even across a restart", () => {
  // The binding is remembered, not frozen: a `/clear` mints a new agent session id
  // on the same pane, so the queue keyed on the OLD id is genuinely orphaned and
  // must still be offered for re-attach. Persisting the binding must not resurrect
  // the pre-clear key.
  const stale = seedQueue("clear-1", "agent-before-clear", "%4");

  const registry = new Registry();
  const queues = new QueueManager(registry);
  registry.applyDiscovery([mkDiscovered("clear-1", "%4")]);
  registry.applyHook({
    event: "UserPromptSubmit",
    sessionId: "agent-after-clear",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%4" },
  });
  assert.ok(orphanKeys(queues).includes(stale), "the queue the /clear abandoned is orphaned");

  // And the new binding is the one that survives the next restart.
  const restarted = new Registry();
  restarted.applyDiscovery([mkDiscovered("clear-1", "%4")]);
  assert.equal(restarted.getSession("clear-1")?.agentSessionId, "agent-after-clear");
});
