import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeWorkflowOwnsSession,
  advanceFollowupMark,
  buildPayload,
  decideReviewFollowup,
} from "../src/server/foreman/review-followup.ts";
import type {
  FollowupMark,
  ReviewFollowupInput,
} from "../src/server/foreman/review-followup.ts";
import type {
  InspectorSummary,
  Session,
  SessionQueueSummary,
} from "../src/shared/types.ts";
import type { TerminalHandle } from "../src/shared/terminal.ts";
import { WORKFLOW_RUN_STATUSES } from "../src/shared/workflow.ts";

// What is at stake: Foreman must re-engage a session whose PR is carrying feedback nobody
// is acting on - unresolved Inspector comments or a red CI - WITHOUT interrupting live
// work, relaying feedback a human owns, or nagging a PR that is being handled. Every gate
// below is a case where typing would be wrong, and there is no model call to catch a
// mistake, so the whole policy is pinned here as a table.

const NOW = 10_000_000;
const SETTLE = 10_000;

const PANE: TerminalHandle = {
  kind: "multiplexer",
  backend: "tmux",
  session: "sess",
  windowIndex: 0,
  paneId: "%1",
  sessionName: "sess",
  windowName: "sess",
};

function inspector(over: Partial<InspectorSummary> = {}): InspectorSummary {
  const open = over.open ?? 0;
  return {
    prKey: "owner/repo#7",
    url: "https://github.com/owner/repo/pull/7",
    mode: "live",
    open,
    postedOpen: over.postedOpen ?? open,
    round: 1,
    lastReviewedAt: NOW - 60_000,
    failed: false,
    ...over,
  };
}

function queue(openCount: number): SessionQueueSummary {
  return {
    openCount,
    totalCount: openCount,
    inFlightState: null,
    inFlightIntent: null,
    round: 0,
    blockingGaps: 0,
    verifiedCount: 0,
    escalatedCount: 0,
    drained: false,
    wrapupAskedAt: null,
    wrapupAnswered: false,
    updatedAt: 0,
  };
}

/** A session parked idle on an OPEN PR - the base case a nudge fires on. Override per test. */
function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "atlas",
    runtime: "terminal",
    // A dispatched worktree session parked on its PR - the base case a nudge fires on.
    foremanInvite: "dispatch",
    nameSource: "process",
    state: "idle",
    cwd: "/work/alpha",
    gitBranch: "feat/x",
    gitRoot: "/work/alpha",
    repoRoot: "/work/alpha",
    pid: 1,
    tty: "/dev/ttys001",
    permissionMode: null,
    terminals: [PANE],
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: NOW,
    lastActivity: NOW - 20_000, // older than SETTLE, so settledIdle is true
    pendingReviews: 0,
    task: null,
    prUrl: "https://github.com/owner/repo/pull/7",
    prNumber: 7,
    prState: "open",
    prChecks: null,
    meta: null,
    effortBaselineReady: false,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

function decide(over: Partial<ReviewFollowupInput> = {}) {
  const session = over.session ?? mkSession();
  return decideReviewFollowup({
    session,
    bucket: "idle",
    mayActLive: true,
    workflowOwnsSession: false,
    mark: null,
    cfg: { trackReviewComments: true, trackCiFailures: true, settleMs: SETTLE },
    now: NOW,
    ...over,
  });
}

// ---- what fires ----

test("open findings on a live-posted review earn a nudge", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 2 }) }) });
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.match(d.reason, /2 review comment/);
  assert.match(d.payload, /Do NOT open a new pull request/);
});

test("a failing CI alone earns a nudge, even with no findings", () => {
  const d = decide({ session: mkSession({ prChecks: "failing" }) });
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.equal(d.reason, "CI failing");
});

test("findings and a red CI together are reported together", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 1 }), prChecks: "failing" }) });
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.match(d.reason, /1 review comment.*\+ CI failing/);
});

// ---- what stays quiet ----

test("the trigger off is the first and cheapest skip", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 3 }) }),
    cfg: { trackReviewComments: false, trackCiFailures: false, settleMs: SETTLE },
  });
  assert.deepEqual(d, { kind: "skip", why: "PR follow-through is off" });
});

test("review comments and CI can be followed independently", () => {
  const both = mkSession({ inspector: inspector({ open: 2 }), prChecks: "failing" });

  const ciOnly = decide({
    session: both,
    cfg: { trackReviewComments: false, trackCiFailures: true, settleMs: SETTLE },
  });
  assert.equal(ciOnly.kind, "nudge");
  if (ciOnly.kind === "nudge") {
    assert.equal(ciOnly.reason, "CI failing");
    assert.doesNotMatch(ciOnly.payload, /review comment/);
  }

  const commentsOnly = decide({
    session: both,
    cfg: { trackReviewComments: true, trackCiFailures: false, settleMs: SETTLE },
  });
  assert.equal(commentsOnly.kind, "nudge");
  if (commentsOnly.kind === "nudge") {
    assert.match(commentsOnly.reason, /2 review comment/);
    assert.doesNotMatch(commentsOnly.payload, /failing CI/);
  }
});

test("CI follow-through waits for an existing PR and never creates one", () => {
  const d = decide({
    session: mkSession({ prState: null, prUrl: null, prChecks: "failing" }),
    cfg: { trackReviewComments: false, trackCiFailures: true, settleMs: SETTLE },
  });
  assert.deepEqual(d, { kind: "skip", why: "no open pull request" });
});

test("no open PR is nothing to follow through on", () => {
  assert.equal(decide({ session: mkSession({ prState: null, prUrl: null }) }).kind, "skip");
  // A merged PR is done, not open.
  assert.equal(decide({ session: mkSession({ prState: "merged", prChecks: "failing" }) }).kind, "skip");
});

test("a clean open PR - no findings, CI not red - is left alone", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 0 }), prChecks: "passing" }) });
  assert.deepEqual(d, { kind: "skip", why: "no enabled review comments or failing CI" });
});

test("dry-run Inspector findings are previews, not comments on the PR, so they do not fire", () => {
  // open > 0 but postedOpen = 0: the findings are drafted, never posted - pointing the agent
  // at "the review comments" would point it at comments that are not there.
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 4, postedOpen: 0, mode: "dry-run" }) }),
  });
  assert.deepEqual(d, { kind: "skip", why: "no enabled review comments or failing CI" });
});

test("unposted findings do not fire even when the current Inspector mode is live", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 4, postedOpen: 0, mode: "live" }) }),
  });
  assert.deepEqual(d, { kind: "skip", why: "no enabled review comments or failing CI" });
});

test("a session that needs a human is not free to be handed its PR", () => {
  assert.equal(
    decide({ session: mkSession({ inspector: inspector({ open: 1 }) }), bucket: "needs-you" }).kind,
    "skip",
  );
  assert.equal(
    decide({ session: mkSession({ state: "awaiting_input", inspector: inspector({ open: 1 }) }) }).kind,
    "skip",
  );
});

test("a checkout with a live work queue belongs to the drain trigger", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 1 }), queue: queue(1) }) });
  assert.match((d as { why: string }).why, /work queue/);
});

test("an active workflow owns the session and blocks an independent PR nudge", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 1 }) }),
    workflowOwnsSession: true,
  });
  assert.deepEqual(d, { kind: "skip", why: "an active workflow owns this session" });
});

test("every non-terminal workflow state retains ownership until the run ends", () => {
  const terminal = new Set(["completed", "cancelled", "failed"]);
  for (const status of WORKFLOW_RUN_STATUSES) {
    assert.equal(activeWorkflowOwnsSession([{ status }]), !terminal.has(status), status);
  }
  assert.equal(activeWorkflowOwnsSession([]), false);
});

test("a still-working session is not interrupted", () => {
  const d = decide({ session: mkSession({ state: "working", inspector: inspector({ open: 2 }) }) });
  assert.deepEqual(d, { kind: "skip", why: "still working" });
});

test("an idle session too recently active has not settled", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 2 }), lastActivity: NOW - 1000 }),
  });
  assert.deepEqual(d, { kind: "skip", why: "still working" });
});

test("no pane means nowhere to type", () => {
  const d = decide({ session: mkSession({ terminals: [], inspector: inspector({ open: 2 }) }) });
  assert.deepEqual(d, { kind: "skip", why: "no pane to type into" });
});

test("an exited session has nothing to type into", () => {
  const d = decide({ session: mkSession({ state: "exited", inspector: inspector({ open: 2 }) }) });
  assert.deepEqual(d, { kind: "skip", why: "the session exited" });
});

test("an operator-started Codex session without hooks is not automated", () => {
  const d = decide({
    session: mkSession({
      agent: "codex",
      hooksSeen: false,
      inspector: inspector({ open: 2 }),
    }),
  });
  assert.deepEqual(d, { kind: "skip", why: "the session is not hook-instrumented" });
});

test("typing is a live act - dry-run or off-allowlist holds", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 2 }) }), mayActLive: false });
  assert.match((d as { why: string }).why, /won't type/);
});

// ---- the once-per-feedback guard (the mark) ----

/** Fold the observation for a fresh session, exactly as the worker does each pass. */
function observe(session: Session, prev: FollowupMark | null = null): FollowupMark {
  return advanceFollowupMark(prev, session);
}

test("the same feedback state, already nudged, stays quiet", () => {
  const session = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const first = decide({ session });
  assert.equal(first.kind, "nudge");
  if (first.kind !== "nudge") return;
  // Feed the stamped mark back through the pass's observation: nothing changed.
  const again = decide({ session, mark: observe(session, first.mark) });
  assert.deepEqual(again, { kind: "skip", why: "already nudged this round of feedback" });
});

test("a later PR resets the mark - no collision with the prior PR at the same round", () => {
  const firstSession = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const first = decide({ session: firstSession });
  assert.equal(first.kind, "nudge");
  if (first.kind !== "nudge") return;

  const nextSession = mkSession({
    prUrl: "https://github.com/owner/repo/pull/8",
    prNumber: 8,
    inspector: inspector({
      prKey: "owner/repo#8",
      url: "https://github.com/owner/repo/pull/8",
      open: 2,
      round: 1,
    }),
  });
  // Same session id, new PR: advanceFollowupMark resets the mark to the new prKey.
  const next = decide({ session: nextSession, mark: observe(nextSession, first.mark) });
  assert.equal(next.kind, "nudge");
});

test("a new Inspector round with posted findings re-arms the nudge", () => {
  const round1 = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const d1 = decide({ session: round1 });
  assert.equal(d1.kind, "nudge");
  if (d1.kind !== "nudge") return;

  // Agent pushed, the Inspector reviewed again and still found two things: new round.
  const round2 = mkSession({ inspector: inspector({ open: 2, round: 2 }) });
  const d2 = decide({ session: round2, mark: observe(round2, d1.mark) });
  assert.equal(d2.kind, "nudge");
});

test("CI clearing does not redundantly re-nudge open findings", () => {
  // Nudge findings + failing CI, then CI goes green while the same findings stay open at
  // the same round. The findings were already relayed; there is nothing new to say.
  const both = mkSession({ inspector: inspector({ open: 1, round: 1 }), prChecks: "failing" });
  const d1 = decide({ session: both });
  assert.equal(d1.kind, "nudge");
  if (d1.kind !== "nudge") return;

  const ciGreen = mkSession({ inspector: inspector({ open: 1, round: 1 }), prChecks: "passing" });
  const d2 = decide({ session: ciGreen, mark: observe(ciGreen, d1.mark) });
  assert.deepEqual(d2, { kind: "skip", why: "already nudged this round of feedback" });
});

test("CI that recovers and fails again re-arms, even on the same Inspector round", () => {
  // The Inspector's finding: a CI-only nudge must re-arm after checks recover and fail
  // again, without waiting for a new Inspector round.
  const round = { open: 0, round: 1 };
  const failing1 = mkSession({ inspector: inspector(round), prChecks: "failing" });
  const d1 = decide({ session: failing1 });
  assert.equal(d1.kind, "nudge");
  if (d1.kind !== "nudge") return;

  // Checks recover (still same round) - observed each pass even though nothing is nudged.
  const passing = mkSession({ inspector: inspector(round), prChecks: "passing" });
  const markAfterRecovery = observe(passing, d1.mark);
  assert.equal(markAfterRecovery.ciNudged, false, "recovery re-arms the CI episode");
  assert.equal(
    decide({ session: passing, mark: markAfterRecovery }).kind,
    "skip",
    "a green PR is not actionable",
  );

  // A fresh failure on the same round is a new episode - nudge again.
  const failing2 = mkSession({ inspector: inspector(round), prChecks: "failing" });
  const d2 = decide({ session: failing2, mark: observe(failing2, markAfterRecovery) });
  assert.equal(d2.kind, "nudge");
});

// ---- the payload ----

test("the payload names the PR and forbids opening a second one", () => {
  const p = buildPayload(mkSession(), { findings: true, ciFailing: true });
  assert.match(p, /PR #7/);
  assert.match(p, /Do NOT open a new pull request/);
  assert.match(p, /gh pr view 7 --comments/);
  assert.match(p, /gh pr checks 7/);
});

test("the payload only mentions the feedback that is actually open", () => {
  const ciOnly = buildPayload(mkSession(), { findings: false, ciFailing: true });
  assert.doesNotMatch(ciOnly, /review comment/);
  assert.match(ciOnly, /CI/);

  const findingsOnly = buildPayload(
    mkSession({ inspector: inspector({ open: 1 }) }),
    { findings: true, ciFailing: false },
  );
  assert.match(findingsOnly, /review comment/);
  assert.doesNotMatch(findingsOnly, /failing CI/);
});
