import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ServerEvent, Session, WorkItem } from "../src/shared/types.ts";

// Whether a stranded queue ever REACHES a card. The hint is computed correctly by
// `orphanedQueueFor` - the failures here are all about emission: a queue orphans
// because a DIFFERENT session went away, so the card that should show the hint
// typically hasn't changed in any way of its own, and every "did anything change?"
// check in the path is happy to say no.

const home = mkdtempSync(join(tmpdir(), "fleet-orphan-"));
process.env.FLEET_HOME = home;

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
    wezterm: null,
    tmux: null,
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

let n = 0;
/** A queue at `key` holding one waiting item, as a dead session would leave it. */
function seedQueue(key: string, cwd: string): void {
  upsertQueue({ noteKey: key, cwd, branch: "feature", wrapupAskedAt: null, wrapupAnswer: null, updatedAt: 1000 });
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
