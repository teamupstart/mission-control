import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InjectError,
  PANE_BLOCKED_BACKOFF_MS,
  applyQueueAction,
  queueSendStillValid,
  observe,
  resolveLiveSession,
} from "../src/server/foreman/queue-apply.ts";
import type { QueueActions } from "../src/server/foreman/queue-apply.ts";
import { SEND_ATTEMPT_CAP } from "../src/server/foreman/queue-machine.ts";
import type { QueueConfig } from "../src/server/foreman/queue-machine.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import type { Session, SessionQueue, WorkItem } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import { QueueManager } from "../src/server/queue.ts";
import type { Registry } from "../src/server/registry.ts";

// The I/O half, driven against a fake - mirroring foreman-verdict.test.ts's
// ForemanActions fake. What matters here is what does and does NOT reach the pane.

const NOW = 1_000_000;
const CFG: QueueConfig = {
  maxFixAttempts: 3,
  maxFixRounds: 10,
  settleMs: 10_000,
  pickupTimeoutMs: 45_000,
  wrapupTriggers: ["drain"],
  wrapup: "ask",
  skipScoutWrapup: true,
  skipReviewArtifactWrapup: true,
};

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "work",
    runtime: "terminal",
    // A dispatched worktree session, as participate-always semantics modeled it.
    foremanInvite: "dispatch",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 1,
    tty: "ttys001",
    permissionMode: null,
    terminals: [mkMuxHandle({ session: "work", windowName: "w", windowIndex: 0, paneId: "%1" })],
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: "idle",
    startedAt: 0,
    firstSeen: 0,
    lastSeen: NOW,
    lastActivity: NOW - 60_000,
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    pendingEffort: null,
    note: null, cost: null, goal: null,
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    pipeline: null,
    paneDialog: null,
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
  wrapupTriggers: ["drain"],
  wrapup: "ask",
  trackReviewFeedback: true,
  trackCiFailures: true,
  triage: "off",
  maxFixAttempts: 3,
  maxFixRounds: 10,
  skipScoutWrapup: true,
  skipReviewArtifactWrapup: true,
  autoBacklog: false,
  backlogRespectOpenPrs: true,
  backlogDefaultModel: { claude: null, codex: null, pi: null },
  maxSessions: 3,
};

/** Foreman on, but drafting. The default mode - and the one Approve exists for. */
const DRY_CFG: ForemanConfig = { ...LIVE_CFG, mode: "dry-run" };

test("workflow repair re-arms the paired drain guard in one write without touching item state", () => {
  const writes: unknown[][] = [];
  const queues = new QueueManager({
    setQueueWrapup(...args: unknown[]) {
      writes.push(args);
    },
  } as unknown as Registry);
  queues.rearmWorkflowCompletion("agent-1", NOW);
  assert.deepEqual(writes, [["agent-1", { wrapupAskedAt: null, wrapupAnswer: null }, NOW]]);
});

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
  /** Wrap-up answers recorded, in order - the durable "we sent this" record. */
  wrapupAnswers: string[];
  /**
   * The wrap-up's calls in the order they happened. The ORDER is the safety property
   * (mark before typing), and a per-call counter cannot express it.
   */
  order: string[];
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
    /** Recording the wrap-up answer fails, AFTER the instruction reached the pane. */
    answerThrows: boolean;
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
    wrapupAnswers: [],
    order: [],
    sessions: async () => [session],
    getConfig: async () => cfg,
    queue: async (): Promise<SessionQueue> => ({
      noteKey: "agent-1",
      cwd: "/repo",
      branch: "feature",
      wrapupAskedAt: null,
      wrapupAnswer: null,
      promptedGoal: null,
      promptedEvidence: null,
      promptedActivityAt: null,
      promptedLegacyCutoverGeneration: null,
      promptedConsumedGeneration: null,
      promptedDirectHandoff: null,
      promptedDecision: null,
      updatedAt: 0,
      items,
    }),
    setItemState: async (_s, itemId, patch) => void fake.states.push({ itemId, patch }),
    inject: async (_s, text) => {
      fake.order.push("inject");
      if (over.injectFailure !== undefined) throw over.injectFailure;
      // What the real client throws when the paste itself never happened: tmux
      // resolves the buffer and the pane before writing, so nothing reached it.
      if (over.injectThrows) throw new InjectError("tmux paste-buffer failed", false);
      fake.injected.push(text);
    },
    markSent: async () => void fake.sentMarks++,
    recoverItem: async () => void fake.recovered++,
    markWrapupAsked: async () => {
      fake.order.push("mark");
      fake.wrapups++;
    },
    setWrapupAnswer: async (_s, answer) => {
      fake.order.push("answer");
      if (over.answerThrows) throw new Error("the write failed");
      fake.wrapupAnswers.push(answer);
    },
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

// ---- a pane a human is sitting in ----

/** What the daemon throws when a pane in copy-mode refuses the write: nothing was typed. */
const paneInCopyMode = () =>
  new InjectError(
    "inject s1 -> 500: this pane is in tmux copy-mode, which swallows keystrokes",
    false,
    true,
  );

test("copy-mode refusals never escalate the item, however many of them land", async () => {
  // The regression this pins. A copy-mode refusal is a PERSON reading their own
  // scrollback: nothing was written, and the condition clears when they leave. Charged
  // as an ordinary send failure it hit SEND_ATTEMPT_CAP after three ticks - about twelve
  // seconds of scrolling - and escalated the item permanently, under a "could not
  // deliver this item" reason describing a condition that had since cleared. Nothing
  // recovers a `sendAttempts` that only resets on pickup.
  const session = mkSession();
  let item = mkItem({ id: "blocked-1", sendAttempts: 0 });
  let now = NOW;

  for (let tick = 0; tick < SEND_ATTEMPT_CAP * 4; tick++) {
    const fake = mkFake({ session, items: [item], injectFailure: paneInCopyMode() });
    const out = await applyQueueAction(
      fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, now,
    );

    assert.equal(out.kind, "aborted", `tick ${tick}`);
    assert.equal(fake.sentMarks, 0, `tick ${tick}: a refused send must never look delivered`);
    assert.equal(
      fake.states.find((w) => w.patch.state === "escalated"),
      undefined,
      `tick ${tick}: a refusal that typed nothing must never be terminal`,
    );

    const last = fake.states.at(-1);
    assert.equal(last?.patch.state, "queued", `tick ${tick}: it stays retryable`);
    // The count is incremented BEFORE the write, so declining to escalate is not enough
    // on its own - the attempt has to be given back or the cap is merely deferred.
    assert.equal(last?.patch.sendAttempts, 0, `tick ${tick}: the refusal costs no attempt`);

    item = { ...item, sendAttempts: last?.patch.sendAttempts as number };
    now += PANE_BLOCKED_BACKOFF_MS + 1; // past the backoff, so every tick really tries
  }

  // And the moment the human leaves the mode it delivers, with its budget intact.
  const fake = mkFake({ session, items: [item] });
  const out = await applyQueueAction(
    fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, now,
  );
  assert.equal(out.kind, "sent");
  assert.deepEqual(fake.injected, ["do it"]);
});

test("a blocked item backs off instead of re-sending every tick", async () => {
  // The worker ticks every IDLE_MS (4s). Without a backoff an item parked behind a long
  // copy-mode session re-runs the whole send path - two state writes, a scope capture, a
  // subprocess - every four seconds to re-learn the one fact that hasn't changed.
  const session = mkSession();
  const item = mkItem({ id: "blocked-2", sendAttempts: 0 });

  const first = mkFake({ session, items: [item], injectFailure: paneInCopyMode() });
  assert.equal(
    (await applyQueueAction(first, session, { kind: "send", item, payload: "x", round: 0 }, CFG, NOW)).kind,
    "aborted",
  );

  // Next tick, still inside the backoff: not even attempted.
  const during = mkFake({ session, items: [item], injectFailure: paneInCopyMode() });
  const held = await applyQueueAction(
    during, session, { kind: "send", item, payload: "x", round: 0 }, CFG, NOW + 4_000,
  );
  assert.equal(held.kind, "noop", "a backed-off tick is not a failure to report");
  assert.deepEqual(during.states, [], "it doesn't even write `sending` again");

  // Once it expires the item is tried again - the backoff delays, it never gives up.
  const after = mkFake({ session, items: [item] });
  const out = await applyQueueAction(
    after, session, { kind: "send", item, payload: "x", round: 0 }, CFG, NOW + PANE_BLOCKED_BACKOFF_MS + 1,
  );
  assert.equal(out.kind, "sent");
  assert.deepEqual(after.injected, ["x"]);
});

test("a pane-blocked failure that may have LANDED still escalates", async () => {
  // The post-paste Enter: refused for the mode, but the text is already in the composer.
  // `paneBlocked` says the cause is transient; it does not say nothing was written, and
  // `mayHaveLanded` still outranks it. Retrying would paste a second copy on top.
  const session = mkSession();
  const item = mkItem({ id: "blocked-3" });
  const fake = mkFake({
    session,
    items: [item],
    injectFailure: new InjectError("inject s1 -> 500: the text is sitting unsubmitted", true, true),
  });
  const out = await applyQueueAction(
    fake, session, { kind: "send", item, payload: "do it", round: 0 }, CFG, NOW,
  );

  assert.equal(out.kind, "aborted");
  assert.equal(fake.states.at(-1)?.patch.state, "escalated");
  assert.equal(
    fake.states.find((w) => w.patch.state === "queued"),
    undefined,
    "text that may be in the pane must never go back to be re-typed",
  );
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

test("the guard refuses when the invite was WITHDRAWN mid-verify", async () => {
  // The invite is the one clause here that a human can change while the verify is running -
  // Withdraw is a click, and the click's whole meaning is "stop typing in here". A verify
  // takes minutes, so re-asking on the fresh snapshot rather than the observed one is what
  // makes the click take effect on the send already in flight instead of the one after it.
  const session = mkSession();
  const item = mkItem();
  const obs = observe(session, item);
  const withdrawn = mkSession({ foremanInvite: null, lastActivity: session.lastActivity });
  const r = await queueSendStillValid(mkFake({ session: withdrawn, items: [item] }), obs, CFG, NOW);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.why : "", /not invited/);
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
  const repaned = mkSession({ terminals: [mkMuxHandle({ session: "work", paneId: "%99" })] });
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

test("a hookless resumed Codex process cannot inherit an authorized queue send", async () => {
  const observed = mkSession({ id: "launched", agent: "codex" });
  const item = mkItem();
  const resumed = mkSession({
    id: "operator-resume",
    agent: "codex",
    instrumented: false,
    hooksSeen: false,
  });
  const fake = mkFake({ session: resumed, items: [item] });

  const out = await applyQueueAction(
    fake,
    observed,
    { kind: "send", item, payload: "do it", round: 0 },
    CFG,
    NOW,
  );
  assert.equal(out.kind, "aborted");
  assert.deepEqual(fake.injected, []);
  assert.match(out.kind === "aborted" ? out.why : "", /not authorized/);
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
  assert.deepEqual(fake.injected, [], "the ask hands the decision to the human - it never types");
});

test("skip-wrapup answers before retiring and never exposes or types a shipping action", async () => {
  const session = mkSession();
  const fake = mkFake({ session });
  const queue = await fake.queue("s1");
  const out = await applyQueueAction(
    fake,
    session,
    { kind: "skip-wrapup", queue: queue!, reason: "the linked task kind is scout" },
    CFG,
    NOW,
  );

  assert.equal(out.kind, "done");
  assert.deepEqual(fake.order, ["answer", "mark"]);
  assert.deepEqual(fake.wrapupAnswers, ["foreman:automatic-wrapup-skipped"]);
  assert.equal(fake.wrapups, 1);
  assert.deepEqual(fake.injected, []);
});

// ---- auto-wrapup: the drain Foreman answers itself (the `wrapup` config) ----
//
// Every test here is about NOT pushing twice. A doubled wrap-up is two shipping
// instructions racing on one branch, which is the harm the latch prevents.

async function autoWrapup(fake: Fake, payload = "Commit this work, push the branch, and open a PR.") {
  const queue = await fake.queue("s1");
  return applyQueueAction(
    fake,
    mkSession(),
    {
      kind: "auto-wrapup",
      queue: queue!,
      payload,
      intentGuard: {
        objective: "Ship the feature",
        objectiveVersion: 1,
        promptRevision: 1,
        episodeKey: "intent:1:1",
      },
    },
    CFG,
    NOW,
  );
}

test("auto-wrapup retires the drain BEFORE typing, then records what it sent", async () => {
  const fake = mkFake();
  const out = await autoWrapup(fake);
  assert.equal(out.kind, "done");
  // The order IS the safety argument: `mark` stamps the once-only guard, so no later
  // tick can re-decide auto-wrapup even if the process dies on the next line.
  assert.deepEqual(fake.order, ["mark", "inject", "answer"]);
  assert.deepEqual(fake.injected, ["Commit this work, push the branch, and open a PR."]);
  assert.deepEqual(fake.wrapupAnswers, ["Commit this work, push the branch, and open a PR."], "the card must not re-offer this");
});

test("a wrap-up whose send fails degrades to the human, and never retries", async () => {
  const fake = mkFake({ injectThrows: true });
  const out = await autoWrapup(fake);
  assert.equal(out.kind, "aborted");
  assert.deepEqual(fake.injected, []);
  assert.equal(fake.wrapups, 1, "still retired - a retry next tick would be the second push");
  assert.deepEqual(
    fake.wrapupAnswers,
    [],
    "no answer recorded, so the card renders with this text prefilled - i.e. exactly `ask`",
  );
});

test("a wrap-up that sends but cannot be recorded reports it rather than throwing", async () => {
  // The instruction IS in the pane. Throwing here reads to the loop like the send
  // never happened, and the card would re-offer an instruction the agent already has.
  const fake = mkFake({ answerThrows: true });
  const out = await autoWrapup(fake);
  assert.equal(out.kind, "done");
  assert.deepEqual(fake.injected, ["Commit this work, push the branch, and open a PR."]);
  assert.match(out.kind === "done" ? out.what : "", /could not record/);
});

test("auto-wrapup sends the payload it was given, verbatim", async () => {
  // The machine decides WHAT to send (it holds the config); apply holds no policy.
  const fake = mkFake();
  await autoWrapup(fake, "Please commit this work, push the branch, and open a PR.");
  assert.deepEqual(fake.injected, ["Please commit this work, push the branch, and open a PR."]);
});

// ---- resolveLiveSession: the one predicate two callers must agree on ----
//
// `queueSendStillValid` (before typing) and the worker's per-target re-resolve
// (before deciding anything) both answer "who holds this note key right now?". They
// used to answer it with separate copies, and the copies disagreed: the worker's
// omitted the `exited` filter, so a transiently-exited session resolved as a live
// target and `decideQueueTick` terminally escalated its in-flight item.

test("resolveLiveSession finds the holder of a key, by KEY and not by id", () => {
  // The id churns with pid/tty; the key is the identity the queue is stored under.
  const a = mkSession({ id: "s1", agentSessionId: "agent-a" });
  const b = mkSession({ id: "s2", agentSessionId: "agent-b" });

  assert.equal(resolveLiveSession([a, b], "agent-b")?.id, "s2");
  assert.equal(resolveLiveSession([a, b], "agent-missing"), null);
  assert.equal(resolveLiveSession([], "agent-a"), null);
});

test("resolveLiveSession REFUSES a transiently-exited session", () => {
  // `exited` is provisional: applyDiscovery marks any session missing from a single
  // `ps` sweep as exited and only evicts it EXIT_LINGER_MS later, cancelling that
  // timer if it reappears. Both callers act irreversibly on the answer - a typed work
  // instruction, or an escalation with no undo - so one hiccuping poll must cost a
  // tick, not the item.
  const dead = mkSession({ id: "s1", agentSessionId: "agent-a", state: "exited" });
  assert.equal(resolveLiveSession([dead], "agent-a"), null);

  // ...and it resolves again the moment the session is seen alive, so the cost really
  // is only the tick.
  const back = { ...dead, state: "idle" as const };
  assert.equal(resolveLiveSession([back], "agent-a")?.id, "s1");
});

test("resolveLiveSession falls back to the synthetic id when no agent binding exists", () => {
  // noteKeyOf is `agentSessionId ?? id` - a session that has never reported a hook
  // binding is keyed on its synthetic id, and must still be resolvable.
  const bare = mkSession({ id: "synth-1", agentSessionId: null });
  assert.equal(resolveLiveSession([bare], "synth-1")?.id, "synth-1");
});
