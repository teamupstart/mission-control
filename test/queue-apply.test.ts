import { test } from "node:test";
import assert from "node:assert/strict";
import { applyQueueAction, queueSendStillValid, observe } from "../src/server/foreman/queue-apply.ts";
import type { QueueActions } from "../src/server/foreman/queue-apply.ts";
import { SEND_ATTEMPT_CAP } from "../src/server/foreman/queue-machine.ts";
import type { QueueConfig } from "../src/server/foreman/queue-machine.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import type { Session, SessionQueue, WorkItem } from "../src/shared/types.ts";

// The I/O half, driven against a fake - mirroring foreman-verdict.test.ts's
// ForemanActions fake. What matters here is what does and does NOT reach the pane.

const NOW = 1_000_000;
const CFG: QueueConfig = { maxFixAttempts: 3, maxFixRounds: 10, settleMs: 10_000, pickupTimeoutMs: 45_000 };

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    gitBranch: "feature",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys001",
    permissionMode: null,
    wezterm: null,
    tmux: { session: "work", window: "w", windowIndex: 0, paneId: "%1" },
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    activity: "idle",
    startedAt: 0,
    firstSeen: 0,
    lastSeen: NOW,
    lastActivity: NOW - 60_000,
    pendingReviews: 0,
    nomistakes: null,
    task: null,
    nomistakesNarration: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
    queue: null,
    orphanedQueue: null,
    ...over,
  };
}

function mkItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "i1",
    noteKey: "agent-1",
    seq: 0,
    intent: "add the retry",
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
    createdAt: 0,
    updatedAt: 0,
    sentAt: null,
    completedAt: null,
    ...over,
  };
}

const LIVE_CFG: ForemanConfig = {
  enabled: true,
  mode: "live",
  repoAllowlist: ["/repo"],
  autoApproveAccess: true,
  triage: "off",
  maxFixAttempts: 3,
  maxFixRounds: 10,
};

interface Fake extends QueueActions {
  injected: string[];
  states: Array<{ itemId: string; patch: Record<string, unknown> }>;
  sentMarks: number;
  recovered: number;
  wrapups: number;
}

function mkFake(over: Partial<{ session: Session; items: WorkItem[]; cfg: ForemanConfig; lease: boolean; injectThrows: boolean }> = {}): Fake {
  const session = over.session ?? mkSession();
  const items = over.items ?? [mkItem()];
  const cfg = over.cfg ?? LIVE_CFG;
  const fake: Fake = {
    injected: [],
    states: [],
    sentMarks: 0,
    recovered: 0,
    wrapups: 0,
    sessions: async () => [session],
    getConfig: async () => cfg,
    queue: async (): Promise<SessionQueue> => ({
      noteKey: "agent-1",
      cwd: "/repo",
      branch: "feature",
      wrapupAskedAt: null,
      wrapupAnswer: null,
      updatedAt: 0,
      items,
    }),
    setItemState: async (_s, itemId, patch) => void fake.states.push({ itemId, patch }),
    inject: async (_s, text) => {
      if (over.injectThrows) throw new Error("tmux paste-buffer failed");
      fake.injected.push(text);
    },
    markSent: async () => void fake.sentMarks++,
    recoverItem: async () => void fake.recovered++,
    markWrapupAsked: async () => void fake.wrapups++,
    captureScope: async () => ({ baseSha: "abc123", transcriptAnchor: 4096 }),
    holdsLease: () => over.lease ?? true,
  };
  return fake;
}

// ---- what reaches the pane ----

test("a live send injects exactly once, and stamps sent only AFTER it resolves", async () => {
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item] });
  const out = await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);

  assert.equal(out.kind, "sent");
  assert.deepEqual(fake.injected, ["do it"]);
  assert.equal(fake.sentMarks, 1);
  // `sending` is written BEFORE the tmux write - that's what makes a crash
  // detectable at all.
  assert.equal(fake.states[0]?.patch.state, "sending");
});

test("a dry-run propose types NOTHING", async () => {
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item] });
  const out = await applyQueueAction(fake, session, { kind: "propose", item, payload: "do it", round: 0 }, CFG, NOW);

  assert.equal(out.kind, "proposed");
  assert.deepEqual(fake.injected, [], "dry-run must never type");
  assert.equal(fake.states[0]?.patch.state, "proposed");
});

test("an escalate types NOTHING and records why", async () => {
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item] });
  const out = await applyQueueAction(fake, session, { kind: "escalate", item, reason: "no pane" }, CFG, NOW);

  assert.equal(out.kind, "done");
  assert.deepEqual(fake.injected, []);
  assert.equal(fake.states[0]?.patch.state, "escalated");
  assert.equal(fake.states[0]?.patch.escalationReason, "no pane");
});

test("triage and none do nothing at all", async () => {
  const session = mkSession();
  const fake = mkFake({ session });
  assert.equal((await applyQueueAction(fake, session, { kind: "triage" }, CFG, NOW)).kind, "noop");
  assert.equal((await applyQueueAction(fake, session, { kind: "none" }, CFG, NOW)).kind, "noop");
  assert.deepEqual(fake.injected, []);
  assert.deepEqual(fake.states, []);
});

test("a failed inject leaves the item retryable and never marks it sent", async () => {
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item], injectThrows: true });
  const out = await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);

  assert.equal(out.kind, "aborted");
  assert.equal(fake.sentMarks, 0, "a failed send must never look delivered");
  assert.equal(fake.states.at(-1)?.patch.state, "queued", "it goes back to be retried");
});

test("a repeatedly-failing inject escalates instead of retrying forever", async () => {
  const session = mkSession();
  // Derived from the constant, not hardcoded to 3: this path and the machine's own
  // escalation branch must escalate at the SAME count, and a literal here would let
  // them agree only by coincidence - so tuning the cap would silently move one.
  const item = mkItem({ sendAttempts: SEND_ATTEMPT_CAP - 1 }); // this attempt hits the cap
  const fake = mkFake({ session, items: [item], injectThrows: true });
  const out = await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);

  assert.equal(out.kind, "aborted");
  assert.equal(fake.states.at(-1)?.patch.state, "escalated");

  // One attempt below the cap it is still retryable, not escalated.
  const under = mkItem({ sendAttempts: SEND_ATTEMPT_CAP - 2 });
  const fake2 = mkFake({ session, items: [under], injectThrows: true });
  await applyQueueAction(fake2, session, { kind: "send", item: under, payload: "do it", round: 0 }, CFG, NOW);
  assert.equal(fake2.states.at(-1)?.patch.state, "queued");
});

// ---- the stale-send guard ----

test("the guard passes for an unchanged, settled, allowlisted session", async () => {
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item] });
  const r = await queueSendStillValid(fake, observe(session, item), CFG, NOW);
  assert.equal(r.ok, true);
});

test("the guard catches A HUMAN TYPING IN THE PANE via lastActivity", async () => {
  // The strongest check, and the reason bucket-checking is insufficient: a human
  // turn can start AND finish inside a 2-minute verify and land back at idle with
  // an identical bucket. Only lastActivity moves.
  const observed = mkSession({ lastActivity: NOW - 60_000 });
  const item = mkItem();
  const obs = observe(observed, item);
  const moved = mkSession({ lastActivity: NOW - 30_000 }); // same bucket, newer activity
  const fake = mkFake({ session: moved, items: [item] });

  const r = await queueSendStillValid(fake, obs, CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /did something since/);
});

test("the guard refuses when the session left for needs-you", async () => {
  const session = mkSession();
  const item = mkItem();
  const obs = observe(session, item);
  const blocked = mkSession({ state: "awaiting_input", lastActivity: session.lastActivity });
  const r = await queueSendStillValid(mkFake({ session: blocked, items: [item] }), obs, CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /needs you/);
});

test("the guard refuses when the pane was recreated under the same session", async () => {
  // inject targets a RAW pane id, and a recreated pane can reuse one - so a stale
  // id could type a work instruction into someone else's terminal.
  const session = mkSession();
  const item = mkItem();
  const obs = observe(session, item);
  const repaned = mkSession({ tmux: { session: "work", window: "w", windowIndex: 0, paneId: "%99" } });
  const r = await queueSendStillValid(mkFake({ session: repaned, items: [item] }), obs, CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /pane was recreated/);
});

test("the guard refuses when the human edited the item mid-verify (revision moved)", async () => {
  const session = mkSession();
  const item = mkItem({ revision: 0 });
  const obs = observe(session, item);
  const edited = mkItem({ revision: 1, intent: "actually, do it differently" });
  const r = await queueSendStillValid(mkFake({ session, items: [edited] }), obs, CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /changed while/);
});

test("the guard RE-PLANS from a fresh config: a mid-verify flip out of live aborts", async () => {
  // Re-checking a cached mayActLive would miss this. The config is re-read, so
  // every "toggle stops acting" switch is honoured even for an in-flight verify.
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item], cfg: { ...LIVE_CFG, mode: "dry-run" } });
  const r = await queueSendStillValid(fake, observe(session, item), CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /no longer cleared/);
});

test("the guard refuses when the repo dropped off the allowlist", async () => {
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item], cfg: { ...LIVE_CFG, repoAllowlist: [] } });
  const r = await queueSendStillValid(fake, observe(session, item), CFG, NOW);
  assert.equal(r.ok, false);
});

test("the guard refuses when we no longer hold the lease", async () => {
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item], lease: false });
  const r = await queueSendStillValid(fake, observe(session, item), CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /another worker/);
});

test("the guard refuses when another item is already in flight", async () => {
  const session = mkSession();
  const item = mkItem({ id: "mine" });
  const other = mkItem({ id: "other", seq: 1, state: "in_progress" });
  const fake = mkFake({ session, items: [item, other] });
  const r = await queueSendStillValid(fake, observe(session, item), CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /already in flight/);
});

test("the guard re-resolves by noteKey, not a cached session id", async () => {
  // session.id churns with pid/tty across a multi-minute verify; noteKeyFor is what
  // survives it. A cached id would 404 or, worse, hit a different session.
  const observed = mkSession({ id: "old-synthetic" });
  const item = mkItem();
  const obs = observe(observed, item);
  const rediscovered = mkSession({ id: "new-synthetic", agentSessionId: "agent-1" });
  const fake = mkFake({ session: rediscovered, items: [item] });

  const r = await queueSendStillValid(fake, obs, CFG, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ok === true ? r.session.id : "", "new-synthetic", "it resolved the CURRENT id");
});

test("a failure of the re-check ITSELF aborts the send", async () => {
  // An abort costs a tick; a bad send costs the human's afternoon.
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item] });
  fake.sessions = async () => {
    throw new Error("daemon unreachable");
  };
  const r = await queueSendStillValid(fake, observe(session, item), CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /re-check failed/);
});

test("an aborted send consumes NO round and NO strike", async () => {
  // A stale-send abort is not evidence about the work.
  const session = mkSession();
  const item = mkItem({ state: "in_progress", round: 2 });
  const fake = mkFake({ session, items: [item], lease: false }); // guard will refuse
  const out = await applyQueueAction(fake, session, { kind: "send", item, payload: "x", round: 3 }, CFG, NOW);

  assert.equal(out.kind, "aborted");
  assert.deepEqual(fake.injected, []);
  for (const w of fake.states) {
    assert.notEqual(w.patch.round, 3, "the round must not advance on an abort");
    assert.equal(w.patch.gaps, undefined, "and no strike is recorded");
  }
});

// ---- the remaining transitions ----

test("recover-send adopts the item rather than re-injecting it", async () => {
  const session = mkSession();
  const item = mkItem({ state: "sending" });
  const fake = mkFake({ session, items: [item] });
  const out = await applyQueueAction(fake, session, { kind: "recover-send", item }, CFG, NOW);

  assert.equal(out.kind, "done");
  assert.equal(fake.recovered, 1);
  assert.deepEqual(fake.injected, [], "a crash-adopted item is never re-typed");
});

test("picked-up moves the item to in_progress", async () => {
  const session = mkSession();
  const item = mkItem({ state: "awaiting_pickup" });
  const fake = mkFake({ session, items: [item] });
  await applyQueueAction(fake, session, { kind: "picked-up", item }, CFG, NOW);
  assert.equal(fake.states[0]?.patch.state, "in_progress");
});

test("picked-up CLEARS the send-attempt count - the cap counts consecutive failures", async () => {
  // A pickup proves the send landed, so the count starts over. Without this it is
  // cumulative across the item's whole life and a fix round inherits it: an item
  // that took two tries in round 0 and is now on round 2 sits AT the cap, so its
  // first pickup timeout escalates - no resend - claiming "the agent never picked
  // this up after 3 attempts" about an agent that has picked it up twice.
  const session = mkSession();
  const item = mkItem({ state: "awaiting_pickup", sendAttempts: 2, round: 1 });
  const fake = mkFake({ session, items: [item] });
  await applyQueueAction(fake, session, { kind: "picked-up", item }, CFG, NOW);
  assert.equal(fake.states[0]?.patch.sendAttempts, 0);
});

test("ask-wrapup stamps the ask and types nothing", async () => {
  const session = mkSession();
  const fake = mkFake({ session });
  const queue = await fake.queue("s1");
  const out = await applyQueueAction(fake, session, { kind: "ask-wrapup", queue: queue! }, CFG, NOW);
  assert.equal(out.kind, "done");
  assert.equal(fake.wrapups, 1);
  assert.deepEqual(fake.injected, [], "Foreman always asks - it never auto-launches the wrap-up");
});
