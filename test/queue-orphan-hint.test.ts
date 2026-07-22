import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ServerEvent, Session, WorkItem } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// Whether a stranded queue ever REACHES a card. The hint is computed correctly by
// `orphanedQueueFor` - the failures here are all about emission: a queue orphans
// because a DIFFERENT session went away, so the card that should show the hint
// typically hasn't changed in any way of its own, and every "did anything change?"
// check in the path is happy to say no.

const home = mkdtempSync(join(tmpdir(), "mission-orphan-"));
process.env.MISSION_HOME = home;

const { openDb, upsertQueue, upsertQueueItem } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

let n = 0;
/** A queue at `key` holding one waiting item, as a dead session would leave it. */
function seedQueue(key: string, cwd: string): void {
  upsertQueue({ noteKey: key, cwd, branch: "feature", wrapupAskedAt: null, wrapupAnswer: null, promptedGoal: null, updatedAt: 1000 });
  const item: WorkItem = {
    id: `orphan-${++n}`,
    noteKey: key,
    seq: 0,
    intent: "resume me",
    state: "queued",
    round: 0,
    baseSha: null,
    transcriptAnchor: null,
    gaps: [],
    sendAttempts: 0,
    verifyFailures: 0,
    escalationReason: null,
    lastVerdict: null,
    approvedAt: null,
    proposedPayload: null,
    recoveredAt: null,
    revision: 0,
    createdAt: 1000,
    updatedAt: 1000,
    sentAt: null,
    completedAt: null,
  };
  upsertQueueItem(item);
}

/** Collect the sessions broadcast while `fn` runs - what an open tab would receive. */
function captureUpserts(registry: InstanceType<typeof Registry>, fn: () => void): Session[] {
  const seen: Session[] = [];
  const unsub = registry.subscribe((e: ServerEvent) => {
    if (e.type === "session_upsert") seen.push(e.session);
  });
  try {
    fn();
  } finally {
    unsub();
  }
  return seen;
}

test("a discovery sweep BROADCASTS a newly-orphaned queue, not just stores it", () => {
  // The sweep recomputes `orphanedQueue` on every card, but the session it lands on
  // is otherwise untouched - an idle sibling at the orphan's cwd is equal by name,
  // state, activity, pid and everything else the change check compares. If the hint
  // isn't compared too, the sweep quietly absorbs it into the map and no client ever
  // hears: /api/sessions would show the hint to a fresh page load while every open
  // tab renders a card without it, indefinitely.
  const registry = new Registry();
  const live = mkDiscovered({ syntheticId: "live-1", cwd: "/repo" });

  registry.applyDiscovery([live]); // first sight - emits because it's new
  assert.equal(registry.getSession("live-1")?.orphanedQueue, null);

  // A queue left behind at /repo by a session that is already gone.
  seedQueue("ghost-key", "/repo");

  const seen = captureUpserts(registry, () => registry.applyDiscovery([live]));
  const hinted = seen.find((s) => s.id === "live-1");
  assert.ok(hinted, "the sweep has to tell open tabs the stranded batch is there");
  assert.equal(hinted.orphanedQueue?.noteKey, "ghost-key");
  assert.equal(hinted.orphanedQueue?.itemCount, 1);
});

test("an identical sweep with no orphan stays quiet", () => {
  // The other half - the reason the check exists at all. Comparing the hint must not
  // turn every poll into a broadcast.
  const registry = new Registry();
  const live = mkDiscovered({ syntheticId: "quiet-1", cwd: "/elsewhere" });
  registry.applyDiscovery([live]);

  const seen = captureUpserts(registry, () => registry.applyDiscovery([live]));
  assert.deepEqual(seen, [], "an unchanged session must not re-emit");
});

test("evicting a session surfaces its queue on an idle sibling AT ONCE", async (t) => {
  // The moment a queue becomes orphaned is the moment its session is evicted -
  // `orphanedQueueFor` derives liveness from the session map itself. Nothing else
  // emits at that instant: the sibling is idle, so it has no change of its own to
  // ride, and an idle sibling at the dead session's cwd is exactly when a human
  // wants the offer to re-attach.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const registry = new Registry();
  const dying = mkDiscovered({ syntheticId: "dying-1", cwd: "/work" });
  const sibling = mkDiscovered({ syntheticId: "sibling-1", cwd: "/work", pid: 2, tty: "ttys2" });
  registry.applyDiscovery([dying, sibling]);
  // Keyed to the dying session itself (noteKeyFor is `agentSessionId ?? id`), so the
  // queue is genuinely ITS queue - orphaned only once it's evicted, not before.
  seedQueue("dying-1", "/work");

  // While the dying session is still in the map its queue isn't orphaned at all.
  registry.applyDiscovery([dying, sibling]);
  assert.equal(registry.getSession("sibling-1")?.orphanedQueue, null, "its own session still holds it");

  // It vanishes from a sweep: marked exited, then evicted EXIT_LINGER_MS later.
  registry.applyDiscovery([sibling]);

  const seen = captureUpserts(registry, () => t.mock.timers.tick(9000));
  const hinted = seen.find((s) => s.id === "sibling-1");
  assert.ok(hinted, "the eviction has to re-resolve the other cards' hints");
  assert.equal(hinted.orphanedQueue?.noteKey, "dying-1");
  assert.equal(hinted.orphanedQueue?.itemCount, 1);
});

test("re-attach requires hook authorization for a Codex session", () => {
  const registry = new Registry();
  const codex = mkDiscovered({
    syntheticId: "codex-1",
    agent: "codex",
    cwd: "/mixed",
    terminals: [mkMuxHandle({ paneId: "%codex" })],
  });
  registry.applyDiscovery([codex]);
  seedQueue("stranded-key", "/mixed");

  assert.equal(registry.reattachQueue("stranded-key", "codex-1"), false);
  registry.applyHook({
    agent: "codex",
    event: "Stop",
    sessionId: "codex-launched",
    cwd: "/mixed",
    transcriptPath: null,
    env: { tmuxPane: "%codex" },
  });
  assert.equal(registry.reattachQueue("stranded-key", "codex-1"), true);
  assert.equal(registry.getQueue("codex-1")?.items.length, 1);
  assert.equal(registry.getSession("codex-1")?.orphanedQueue, null);
});

test("a session the SessionEnd hook marked exited stops holding its key", async (t) => {
  // The zombie. `applyHook` writes `state: "exited"` straight into the map with no
  // exit timer, and the eviction loop used to skip anything already exited - so
  // `remove` (the timer's only caller) never ran and the entry lived forever.
  //
  // That split the two readers apart: the worker's `liveNoteKeys` skipped the zombie
  // and its orphan sweep escalated the in-flight item, deliberately leaving the rest
  // `queued` so a human could resume them - while `orphanedQueueFor` still counted
  // the zombie's key as live, so the hint offering exactly that never appeared on any
  // card. The batch was stranded with nothing left to surface it.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const registry = new Registry();
  const ending = mkDiscovered({
    syntheticId: "ctrl-d-1",
    cwd: "/zombie",
    terminals: [mkMuxHandle({ session: "z", paneId: "%9" })],
  });
  const sibling = mkDiscovered({ syntheticId: "zsib-1", cwd: "/zombie", pid: 2, tty: "ttys2" });
  registry.applyDiscovery([ending, sibling]);
  seedQueue("ctrl-d-1", "/zombie");

  // Ctrl-D: the hook reports the session ended, with no eviction timer behind it.
  registry.applyHook({
    agent: "claude",
    event: "SessionEnd",
    sessionId: null,
    transcriptPath: null,
    cwd: "/zombie",
    env: { tmuxPane: "%9" },
  } as never);
  assert.equal(registry.getSession("ctrl-d-1")?.state, "exited", "the hook marked it exited");

  // The process is gone, so the next sweep no longer lists it. That sweep must put it
  // on its way out rather than skipping it for being already exited.
  registry.applyDiscovery([sibling]);
  t.mock.timers.tick(9000);

  assert.equal(registry.getSession("ctrl-d-1"), undefined, "the zombie is evicted, not kept forever");
  assert.ok(
    !registry.liveNoteKeys().has("ctrl-d-1"),
    "the sweep says the key is dead...",
  );
  assert.equal(
    registry.getSession("zsib-1")?.orphanedQueue?.noteKey,
    "ctrl-d-1",
    "...so the hint must agree and offer the stranded batch",
  );
});

test("the hint is never computed from a HALF-MERGED session map", () => {
  // `mergeDiscovered` resolved each session's hint as it merged, against a map still
  // being filled one session at a time. On the first sweep after a daemon restart the
  // map starts empty, so the FIRST session merged saw only its own key as live and
  // every other live session's queue looked orphaned to it.
  //
  // That hint is actionable, and `reattachQueue` trusts it: it checks only that the
  // target is queue-eligible and holds no open items, never that the source is really
  // orphaned. So a click inside that window re-keys B's healthy live queue onto A and
  // drops B's row. The hint's correctness is the only guard on that write.
  const registry = new Registry();
  const a = mkDiscovered({ syntheticId: "restart-a", cwd: "/shared", pid: 1, tty: "ttysA" });
  const b = mkDiscovered({ syntheticId: "restart-b", cwd: "/shared", pid: 2, tty: "ttysB" });
  // Both sessions are alive with their own persisted queues, as after a restart.
  seedQueue("restart-a", "/shared");
  seedQueue("restart-b", "/shared");

  // A merges first, and must NOT conclude B's live queue is orphaned.
  registry.applyDiscovery([a, b]);

  assert.equal(registry.getSession("restart-a")?.orphanedQueue, null, "B's queue is B's - it is alive");
  assert.equal(registry.getSession("restart-b")?.orphanedQueue, null, "and vice versa");
});

test("removing a TERMINAL item moves the queue's change token", () => {
  // The panel re-fetches on `updatedAt`, `openCount` and `inFlightState` - and a
  // finished item contributes to none of them. So deleting one produced a
  // byte-identical summary, no other viewer ever re-fetched, and every other open
  // card kept rendering an item that is no longer there. Nothing heals that on an
  // idle queue. Removing a WAITING item happened to work only because `openCount`
  // moved: a coincidence of the projection, not a rule.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "rm-1", cwd: "/rm" })]);
  seedQueue("rm-1", "/rm");

  const items = registry.getQueue("rm-1")?.items ?? [];
  assert.equal(items.length, 1);
  registry.putQueueItem({ ...items[0]!, state: "verified", updatedAt: 2000 });

  const before = registry.getQueue("rm-1")!.updatedAt;
  registry.removeQueueItem(items[0]!.id, before + 500);
  const after = registry.getQueue("rm-1")!.updatedAt;

  assert.ok(after > before, `the change token must move (${before} -> ${after})`);
  assert.equal(registry.getQueue("rm-1")?.items.length, 0);
});

test("clearQueue retracts a sibling's re-attach hint at once", () => {
  // A reset clears the stranded queue its own /clear just orphaned. The re-attach
  // offer on any sibling at that cwd must vanish the instant the queue does, not
  // linger until the next sweep re-derives the hint against a row that's now gone.
  // A cwd of its own: this file shares one DB, and other tests strand queues at /repo.
  const registry = new Registry();
  const sibling = mkDiscovered({ syntheticId: "reset-sib", cwd: "/reset-repo" });
  registry.applyDiscovery([sibling]);
  seedQueue("wiped-key", "/reset-repo");
  registry.applyDiscovery([sibling]); // the sweep surfaces the orphan hint
  assert.equal(registry.getSession("reset-sib")?.orphanedQueue?.noteKey, "wiped-key");

  const seen = captureUpserts(registry, () => registry.clearQueue("wiped-key"));
  const cleared = seen.find((s) => s.id === "reset-sib");
  assert.ok(cleared, "the sibling re-emits");
  assert.equal(cleared.orphanedQueue, null, "with the hint retracted");
  assert.equal(registry.getSession("reset-sib")?.orphanedQueue, null);
});
