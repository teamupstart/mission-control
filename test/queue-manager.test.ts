import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// The QueueManager's own writes - the ones the daemon owns rather than the pure
// machine. Everything here is about a clock or a guard that only the write boundary
// can enforce, so a machine-level test cannot reach any of it.

const home = mkdtempSync(join(tmpdir(), "mission-queue-manager-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { QueueManager } = await import("../src/server/queue.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

let paneN = 0;
function mkDiscovered(
  syntheticId: string,
  over: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    syntheticId,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: `ttys${++paneN}`,
    wezterm: null,
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: `%${paneN}` },
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** A hook-instrumented claude session, i.e. one that can actually hold a queue. */
function seedSession(
  registry: InstanceType<typeof Registry>,
  syntheticId: string,
  agentSessionId: string,
  over: Partial<DiscoveredSession> = {},
): void {
  const d = mkDiscovered(syntheticId, over);
  registry.applyDiscovery([d]);
  registry.applyHook({
    event: "Stop",
    sessionId: agentSessionId,
    cwd: d.cwd,
    transcriptPath: null,
    env: { tmuxPane: d.tmux!.paneId },
  });
}

// ---- sentAt is the SEND's clock, on every round ----

test("recover adopts a fix round's OWN send time, not the previous round's", () => {
  // The invariant this protects: a crash mid-`sending` never auto-retries and never
  // guesses - it escalates. That adjudication is `lastActivity > sentAt`, so a
  // `sentAt` left over from an EARLIER round makes every scrap of that round's work
  // look like a pickup of THIS round's prompt, and the escalation branch becomes
  // unreachable for every round >= 1.
  const registry = new Registry();
  const queues = new QueueManager(registry);
  seedSession(registry, "s-round", "agent-round");

  const T0 = 1_000_000;
  const item = queues.add("s-round", "add the retry", T0)!;
  assert.ok(item);

  // Round 0: delivered, and picked up.
  assert.ok(queues.setState(item.id, { state: "sending" }, T0).ok);
  assert.ok(queues.markSent(item.id, "abc1234", 0, T0).ok);

  // Verify raises a blocking gap, so the machine parks it back at `queued`. Nothing
  // clears `sentAt` - it is only ever set - so the round-0 stamp is still on the row.
  const T1 = T0 + 60_000;
  assert.ok(queues.setState(item.id, { state: "queued", round: 1 }, T1).ok);

  // Round 1's send is attempted... and the daemon dies before it can mark it sent.
  const T2 = T0 + 120_000;
  assert.ok(queues.setState(item.id, { state: "sending", round: 1 }, T2).ok);

  const T3 = T0 + 130_000;
  const r = queues.recover(item.id, T3);
  assert.ok(r.ok, "a sending item is adoptable");
  const adopted = (r as { ok: true; item: typeof item }).item;

  assert.equal(
    adopted.sentAt,
    T2,
    "the adopted send time must be THIS round's attempt, not round 0's delivery",
  );
  // The teeth: all of round 0's activity happened after T0. If `sentAt` were T0, the
  // pickup detector would read that stale activity as evidence this round's prompt
  // landed and skip the escalation entirely.
  assert.ok(
    (adopted.sentAt ?? 0) > T1,
    "round 0's activity must not be able to masquerade as a round-1 pickup",
  );
});

test("a round-0 send stamps sentAt at the `sending` write, before anything is typed", () => {
  // `updated_at` is not a proxy for "when this send was attempted": a reorder stamps
  // it on every row in the queue, in-flight ones included. Owning `sentAt` at the
  // write is what makes the crash window readable at all.
  const registry = new Registry();
  const queues = new QueueManager(registry);
  seedSession(registry, "s-zero", "agent-zero");

  const T0 = 2_000_000;
  const item = queues.add("s-zero", "do the thing", T0)!;
  assert.equal(item.sentAt, null, "a waiting item has never been sent");

  const T1 = T0 + 5_000;
  const sending = queues.setState(item.id, { state: "sending" }, T1);
  assert.ok(sending.ok);
  assert.equal(
    (sending as { ok: true; item: typeof item }).item.sentAt,
    T1,
    "the send attempt is stamped before the tmux write, which is what a crash leaves behind",
  );
});

test("a reorder cannot move an in-flight item's recorded send time", () => {
  // The reorder renumbers the whole queue and stamps `updated_at` on every row it
  // touches. That must not be able to rewrite when a send was attempted.
  const registry = new Registry();
  const queues = new QueueManager(registry);
  seedSession(registry, "s-reorder", "agent-reorder");

  const T0 = 3_000_000;
  const flight = queues.add("s-reorder", "in flight", T0)!;
  const waiting = queues.add("s-reorder", "still waiting", T0)!;

  const T1 = T0 + 5_000;
  assert.ok(queues.setState(flight.id, { state: "sending" }, T1).ok);

  // The human drags the waiting item while the send is in flight.
  const T2 = T0 + 90_000;
  assert.ok(queues.reorder("s-reorder", [waiting.id, flight.id], T2).ok);

  const r = queues.recover(flight.id, T2 + 1_000);
  assert.ok(r.ok);
  assert.equal(
    (r as { ok: true; item: typeof flight }).item.sentAt,
    T1,
    "the send time survives an unrelated reorder",
  );
});

// ---- only a session that can RUN a queue may be given one ----

test("add refuses a non-claude session rather than stranding the batch", () => {
  // Every tick filters to `agent === "claude"`, so a queue on a Codex session never
  // advances - and because the session is LIVE its key is live, so neither the
  // re-attach hint nor the orphan sweep will ever offer the batch to anyone.
  // `reattachQueue` already refuses this for the identical reason.
  const registry = new Registry();
  const queues = new QueueManager(registry);
  registry.applyDiscovery([mkDiscovered("s-codex", { agent: "codex" })]);

  assert.equal(queues.add("s-codex", "do the thing"), null);
  assert.equal(queues.get("s-codex"), null, "and no empty queue row is left behind");
});

// ---- re-attach is guarded at the WRITE, not by a hint round-tripped through a browser ----

test("re-attach refuses a source key a live session still holds", () => {
  // The hint is stale by construction: a sibling card's copy only re-resolves on the
  // next discovery sweep, and a browser tab holds whatever it last received over SSE
  // for longer still. So a click can arrive for a queue that has since come back to
  // life - and re-keying it would move an item Foreman just typed into a DIFFERENT
  // live session onto the wrong key, verifying it against the wrong transcript and
  // diff, and deleting the source row inside the transaction with no undo.
  const registry = new Registry();
  const queues = new QueueManager(registry);
  registry.applyDiscovery([
    mkDiscovered("s-live"),
    mkDiscovered("s-other", { cwd: "/repo" }),
  ]);
  registry.applyHook({
    event: "Stop",
    sessionId: "agent-live",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: registry.getSession("s-live")!.tmux!.paneId },
  });
  registry.applyHook({
    event: "Stop",
    sessionId: "agent-other",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: registry.getSession("s-other")!.tmux!.paneId },
  });

  const item = queues.add("s-live", "work on the live session")!;
  assert.equal(item.noteKey, "agent-live");

  // "agent-live" is held by a live session, so it is not orphaned and its queue is
  // not up for grabs - whatever a stale card believes.
  const r = queues.reattach("agent-live", "s-other");
  assert.equal(r.ok, false);
  assert.equal(
    queues.getByKey("agent-live")?.items.length,
    1,
    "the source queue is untouched by a refused re-attach",
  );
  assert.equal(queues.getByKey("agent-other"), null, "and nothing landed on the target");
});

test("re-attach still moves a genuinely orphaned queue, and heals BOTH cards", () => {
  // The guard must not break the affordance it protects: a `/clear` mints a new agent
  // session id, orphaning the queue keyed on the old one, and resuming it is the
  // entire point.
  const registry = new Registry();
  const queues = new QueueManager(registry);
  seedSession(registry, "s-cleared", "agent-old");

  const item = queues.add("s-cleared", "survive the clear")!;
  assert.equal(item.noteKey, "agent-old");

  // The `/clear`: same pane, new agent session id. The old key now belongs to nobody.
  registry.applyHook({
    event: "Stop",
    sessionId: "agent-new",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: registry.getSession("s-cleared")!.tmux!.paneId },
  });
  assert.equal(registry.getSession("s-cleared")?.agentSessionId, "agent-new");

  const r = queues.reattach("agent-old", "s-cleared");
  assert.ok(r.ok, "a genuinely orphaned queue re-attaches");
  assert.equal(queues.getByKey("agent-old"), null, "the source row is gone");
  assert.equal(queues.get("s-cleared")?.items[0]?.intent, "survive the clear");
  assert.equal(
    registry.getSession("s-cleared")?.queue?.openCount,
    1,
    "the target card sees the queue it just adopted",
  );
});

test("re-attach is refused before the sessions has ever been observed", () => {
  // "No live session holds this key" read off a map nobody has filled in is not a
  // finding. The daemon answers routes the instant it binds its port, so a tab that
  // survives a restart can land a click in exactly that window.
  const registry = new Registry();
  const queues = new QueueManager(registry);

  // A queue exists in the DB (it is durable), but no sweep has run in this registry.
  const fresh = new Registry();
  const freshQueues = new QueueManager(fresh);
  seedSession(fresh, "s-seed", "agent-seed");
  freshQueues.add("s-seed", "durable work");

  registry.applyDiscovery([mkDiscovered("s-target")]);
  registry.applyHook({
    event: "Stop",
    sessionId: "agent-target",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: registry.getSession("s-target")!.tmux!.paneId },
  });

  assert.ok(registry.sessionsObserved(), "applyDiscovery is what marks the sessions observed");

  // ...and a registry that has NOT swept refuses outright.
  const unswept = new Registry();
  const unsweptQueues = new QueueManager(unswept);
  unswept.applyHook({
    event: "Stop",
    sessionId: "agent-seed-2",
    cwd: "/repo",
    transcriptPath: null,
    env: {},
  });
  assert.equal(unswept.sessionsObserved(), false);
  assert.equal(unsweptQueues.reattach("agent-seed", "s-target").ok, false);
});
