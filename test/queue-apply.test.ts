import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InjectError,
  applyQueueAction,
  queueSendStillValid,
  observe,
} from "../src/server/foreman/queue-apply.ts";
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

/** Foreman on, but drafting. The default mode - and the one Approve exists for. */
const DRY_CFG: ForemanConfig = { ...LIVE_CFG, mode: "dry-run" };

/** A drafted item the human has said yes to. */
function mkApproved(over: Partial<WorkItem> = {}): WorkItem {
  return mkItem({ state: "proposed", proposedPayload: "do it", approvedAt: NOW - 5_000, ...over });
}

interface Fake extends QueueActions {
  injected: string[];
  states: Array<{ itemId: string; patch: Record<string, unknown> }>;
  sentMarks: number;
  recovered: number;
  wrapups: number;
}

function mkFake(
  over: Partial<{
    session: Session;
    items: WorkItem[];
    cfg: ForemanConfig;
    lease: boolean;
    /** The delivery fails before any text reaches the pane (retryable). */
    injectThrows: boolean;
    /** The delivery fails with the text already pasted, or in an unknown state. */
    injectFailure: unknown;
  }> = {},
): Fake {
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
      if (over.injectFailure !== undefined) throw over.injectFailure;
      // What the real client throws when the paste itself never happened: tmux
      // resolves the buffer and the pane before writing, so nothing reached it.
      if (over.injectThrows) throw new InjectError("tmux paste-buffer failed", false);
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

test("a send that may have HALF-LANDED escalates instead of re-typing over it", async () => {
  // Delivery is a non-atomic paste-then-Enter. If the paste landed and the Enter
  // failed, the prompt is sitting unsubmitted in the pane - so going back to
  // `queued` would paste a second copy after the first and mangle the instruction.
  // Same rule the crash path follows: absence of evidence is not evidence.
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({
    session,
    items: [item],
    injectFailure: new InjectError("inject s1 -> 500: tmux Enter failed", true),
  });
  const out = await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);

  assert.equal(out.kind, "aborted");
  assert.equal(fake.sentMarks, 0, "a failed send must never look delivered");
  assert.equal(fake.states.at(-1)?.patch.state, "escalated");
  assert.equal(
    fake.states.find((w) => w.patch.state === "queued"),
    undefined,
    "text that may be in the pane must never go back to be re-typed",
  );
});

test("an UNRECOGNISED delivery failure escalates - it says nothing about the pane", async () => {
  // The conservative default is the whole point. Only a positive `pasted: false`
  // earns a retry; anything else (a bug, a dropped connection mid-request) leaves
  // the pane's state unknown, and guessing "nothing landed" is the guess that
  // double-types.
  const session = mkSession();
  const item = mkItem();
  const fake = mkFake({ session, items: [item], injectFailure: new Error("socket hang up") });
  const out = await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);

  assert.equal(out.kind, "aborted");
  assert.equal(fake.states.at(-1)?.patch.state, "escalated");
});

test("a half-landed send escalates even well below the attempt cap", async () => {
  // The cap governs RETRIES. An item that may already be in the pane has no safe
  // retry to spend, so the remaining attempts are irrelevant to it.
  const session = mkSession();
  const item = mkItem({ sendAttempts: 0 });
  const fake = mkFake({
    session,
    items: [item],
    injectFailure: new InjectError("inject s1 -> 500: wezterm Enter failed", true),
  });
  await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);
  assert.equal(fake.states.at(-1)?.patch.state, "escalated");
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

// ---- Approve is consent, in any mode ----

test("an APPROVED item passes the guard in dry-run, and sends", async () => {
  // The whole point of the dry-run Approve workflow: draft, human reads it, human
  // says yes, Foreman types THAT text. Step 8 asks "would this item still need to be
  // a draft?" - and an approved one would not, because the human already read it.
  const session = mkSession();
  const item = mkApproved();
  const fake = mkFake({ session, items: [item], cfg: DRY_CFG });

  const r = await queueSendStillValid(fake, observe(session, item), CFG, NOW);
  assert.equal(r.ok, true, "consent clears step 8");

  const out = await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);
  assert.equal(out.kind, "sent");
  assert.deepEqual(fake.injected, ["do it"], "an approved draft is what actually reaches the pane");
  assert.equal(fake.sentMarks, 1);
});

test("an UNAPPROVED item still refuses to send in dry-run", async () => {
  // The other half. Without consent there is nothing authorising the keystrokes, so
  // dry-run must stay a draft - this is what keeps step 8 a real gate rather than a
  // formality that any item walks through.
  const session = mkSession();
  const item = mkItem({ state: "proposed", proposedPayload: "do it" });
  const fake = mkFake({ session, items: [item], cfg: DRY_CFG });

  const r = await queueSendStillValid(fake, observe(session, item), CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /no longer cleared/);

  const out = await applyQueueAction(fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW);
  assert.equal(out.kind, "aborted");
  assert.deepEqual(fake.injected, [], "no consent, no keystrokes");
});

test("step 8 reads the FRESHLY-FETCHED item's consent, not the caller's snapshot", async () => {
  // The guard re-fetches the item at step 6 precisely so it re-plans from current
  // state. A human who approves between the machine's decision and the guard has
  // consented; reading a stale snapshot would ignore that yes and demote the draft.
  const session = mkSession();
  const stale = mkItem({ state: "proposed", proposedPayload: "do it" }); // approvedAt: null
  const approved = mkApproved(); // same id/state/round/revision, now with consent
  const fake = mkFake({ session, items: [approved], cfg: DRY_CFG });

  const r = await queueSendStillValid(fake, observe(session, stale), CFG, NOW);
  assert.equal(r.ok, true);
});

test("an approved dry-run send STILL aborts when another guard fails, costing no round or strike", async () => {
  // Approve records consent; it does not bypass guards 1-7 and 9. The human's yes
  // arrives minutes after the draft, so the session may have moved on since - and
  // that abort is not evidence about the work.
  const observed = mkSession({ lastActivity: NOW - 60_000 });
  const item = mkApproved({ round: 2 });
  const moved = mkSession({ lastActivity: NOW - 1_000 }); // a human typed in the pane
  const fake = mkFake({ session: moved, items: [item], cfg: DRY_CFG });

  const r = await queueSendStillValid(fake, observe(observed, item), CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /did something since/);

  const out = await applyQueueAction(
    fake,
    observed,
    { kind: "send", item, payload: "do it", round: 3 },
    CFG,
    NOW,
  );
  assert.equal(out.kind, "aborted");
  assert.deepEqual(fake.injected, [], "consent does not survive a session that moved on");
  for (const w of fake.states) {
    assert.notEqual(w.patch.round, 3, "the round must not advance on an abort");
    assert.equal(w.patch.gaps, undefined, "and no strike is recorded");
  }
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

test("an aborted RESEND leaves the item in flight, so it is never typed twice", async () => {
  // `resend` acts ONLY on `awaiting_pickup`, which means the prompt is already in
  // the pane. Demoting it to `queued` on an abort drops it out of the in-flight set,
  // so the next tick never re-enters decideInFlight, the `picked-up` branch that
  // would adjudicate the delivery is unreachable, and step 9 simply types the item a
  // SECOND time.
  //
  // The abort reason here IS the race: the guard refuses because "the session did
  // something since we looked", which is exactly what the agent picking the item up
  // looks like. The abort fires precisely when re-typing is most wrong.
  const observed = mkSession({ lastActivity: NOW - 60_000 });
  const item = mkItem({ state: "awaiting_pickup", sentAt: NOW - 50_000, sendAttempts: 1 });
  // The guard re-resolves the session and finds it has moved since we observed it.
  const moved = mkSession({ lastActivity: NOW - 1_000 });
  const fake = mkFake({ session: moved, items: [item] });

  const out = await applyQueueAction(
    fake,
    observed,
    { kind: "resend", item, payload: "do it", round: 0 },
    CFG,
    NOW,
  );

  assert.equal(out.kind, "aborted");
  assert.deepEqual(fake.injected, [], "an aborted resend types nothing");
  assert.equal(
    fake.states.find((w) => w.patch.state === "queued"),
    undefined,
    "an already-delivered item must never be demoted to `queued` - that re-types it",
  );
});

test("an aborted send DOES fall back a proposed item - nothing was typed", async () => {
  // The other half of that rule: a draft holds no single-flight slot and no keystroke
  // reached the pane, so re-deciding it from scratch next tick is free.
  const observed = mkSession({ lastActivity: NOW - 60_000 });
  const item = mkItem({ state: "proposed", approvedAt: NOW - 5_000 });
  const moved = mkSession({ lastActivity: NOW - 1_000 });
  const fake = mkFake({ session: moved, items: [item] });

  const out = await applyQueueAction(
    fake,
    observed,
    { kind: "send", item, payload: "do it", round: 0 },
    CFG,
    NOW,
  );

  assert.equal(out.kind, "aborted");
  assert.deepEqual(fake.injected, []);
  assert.ok(
    fake.states.some((w) => w.patch.state === "queued"),
    "a proposed item falls back to queued",
  );
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
