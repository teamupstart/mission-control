import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPayload,
  decideReviewFollowup,
  reviewFollowupSignature,
} from "../src/server/foreman/review-followup.ts";
import type { ReviewFollowupInput } from "../src/server/foreman/review-followup.ts";
import type { InspectorSummary, Session, SessionQueueSummary } from "../src/shared/types.ts";
import type { TerminalHandle } from "../src/shared/terminal.ts";

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
  return {
    prKey: "owner/repo#7",
    url: "https://github.com/owner/repo/pull/7",
    mode: "live",
    open: 0,
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
    nameSource: "process",
    state: "idle",
    cwd: "/work/alpha",
    gitBranch: "feat/x",
    gitRoot: "/work/alpha",
    repoRoot: "/work/alpha",
    nomistakesGated: false,
    nomistakesNarration: null,
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
    nomistakes: null,
    nomistakesFixes: [],
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
    lastSig: null,
    cfg: { enabled: true, settleMs: SETTLE },
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
    cfg: { enabled: false, settleMs: SETTLE },
  });
  assert.deepEqual(d, { kind: "skip", why: "review follow-through is off" });
});

test("no open PR is nothing to follow through on", () => {
  assert.equal(decide({ session: mkSession({ prState: null, prUrl: null }) }).kind, "skip");
  // A merged PR is done, not open.
  assert.equal(decide({ session: mkSession({ prState: "merged", prChecks: "failing" }) }).kind, "skip");
});

test("a clean open PR - no findings, CI not red - is left alone", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 0 }), prChecks: "passing" }) });
  assert.deepEqual(d, { kind: "skip", why: "no open review comments or failing CI" });
});

test("dry-run Inspector findings are previews, not comments on the PR, so they do not fire", () => {
  // open > 0 but mode dry-run: the findings are drafted, never posted - pointing the agent
  // at "the review comments" would point it at comments that are not there.
  const d = decide({ session: mkSession({ inspector: inspector({ open: 4, mode: "dry-run" }) }) });
  assert.deepEqual(d, { kind: "skip", why: "no open review comments or failing CI" });
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

test("an in-flight no-mistakes run is already driving the PR", () => {
  const d = decide({
    session: mkSession({
      prChecks: "failing",
      nomistakes: {
        id: "r", status: "running", branch: "feat/x", startedAt: NOW - 1000, endedAt: null,
        prUrl: null, awaitingAgent: null, findingsSummary: null,
        gateStep: null, gateSummary: null, gateRisk: null, steps: [],
        activeSteps: [], findings: [], outcome: null,
      },
    }),
  });
  assert.match((d as { why: string }).why, /no-mistakes run/);
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

test("typing is a live act - dry-run or off-allowlist holds", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 2 }) }), mayActLive: false });
  assert.match((d as { why: string }).why, /won't type/);
});

// ---- the once-per-feedback guard ----

test("the same feedback state, already nudged, stays quiet", () => {
  const session = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const first = decide({ session });
  assert.equal(first.kind, "nudge");
  if (first.kind !== "nudge") return;
  // Feed the stamped signature back: nothing has changed, so no second nudge.
  const again = decide({ session, lastSig: first.sig });
  assert.deepEqual(again, { kind: "skip", why: "already nudged this round of feedback" });
});

test("a new Inspector round re-arms the nudge, even for the same open count", () => {
  const round1 = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const d1 = decide({ session: round1 });
  assert.equal(d1.kind, "nudge");
  if (d1.kind !== "nudge") return;

  // Agent pushed, the Inspector reviewed again and still found two things: new round.
  const round2 = mkSession({ inspector: inspector({ open: 2, round: 2 }) });
  const d2 = decide({ session: round2, lastSig: d1.sig });
  assert.equal(d2.kind, "nudge");
  if (d2.kind !== "nudge") return;
  assert.notEqual(d2.sig, d1.sig);
});

test("the signature turns on the PR, the round and which feedback is open", () => {
  const base = mkSession({ inspector: inspector({ open: 1, round: 3 }), prChecks: "failing" });
  const sig = reviewFollowupSignature(base, { findings: true, ciFailing: true });
  assert.equal(sig, "owner/repo#7:r3:FC");
  // The head sha is deliberately NOT in it - a push changes the head before the Inspector
  // re-reviews, and keying on it would re-nudge a session that just pushed and is waiting.
  assert.equal(reviewFollowupSignature(base, { findings: true, ciFailing: false }), "owner/repo#7:r3:F-");
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
