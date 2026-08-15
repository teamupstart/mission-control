import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeWorkflowOwnsSession,
  advanceFollowupMark,
  buildPayload,
  decideReviewFollowup,
  followupPrs,
} from "../src/server/foreman/review-followup.ts";
import type {
  FollowupMark,
  FollowupPr,
  ReviewFollowupInput,
} from "../src/server/foreman/review-followup.ts";
import type {
  InspectorSummary,
  Session,
  SessionQueueSummary,
  TaskRepoPrSummary,
  TaskSummary,
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
    pipeline: null,
    paneDialog: null,
    ...over,
  };
}

function decide(over: Partial<ReviewFollowupInput> = {}) {
  const session = over.session ?? mkSession();
  return decideReviewFollowup({
    session,
    // The session's own pull request unless a case names one, which is what the worker
    // passes for a single-repo session and keeps every case below reading as it did.
    pr: followupPrs(session)[0] ?? null,
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

test("an UNINVITED session is never followed up - the personal-chat regression", () => {
  // THE bug this whole plan exists for. This path iterated every session with an open PR
  // and typed "create a PR" / "CI is red" into personal Claude chats, because a
  // machine-scoped hook made them look like sessions Mission Control had launched. The
  // subject below is otherwise a perfect nudge candidate - open findings, red CI, idle,
  // hooked, a pane - and the invite is the only thing standing between it and a nudge.
  const personal = mkSession({
    foremanInvite: null,
    inspector: inspector({ open: 2 }),
    prChecks: "failing",
  });
  const d = decide({ session: personal });
  assert.equal(d.kind, "skip");
  // C7: phase 3 reads this concept, so the reason names it.
  if (d.kind === "skip") assert.match(d.why, /not invited/);

  // The same session, invited, IS nudged - so the refusal above is the invite talking and
  // not some other gate quietly holding.
  assert.equal(decide({ session: { ...personal, foremanInvite: "operator" } }).kind, "nudge");
});

test("an operator invite is enough for PR follow-through", () => {
  // Approved decision 2: an operator invite grants triage, wrapup and PR follow-through.
  // Only the backlog autopilot demands more (see backlog-machine.test.ts).
  for (const invite of ["sdk", "dispatch", "operator"] as const) {
    const d = decide({ session: mkSession({ foremanInvite: invite, prChecks: "failing" }) });
    assert.equal(d.kind, "nudge", `${invite} should be followed up`);
  }
});

test("the invite refusal outranks every other reason a session cannot be nudged", () => {
  // Ordered first among the gates, above even the capability check, so the log says the
  // true thing about the session that matters most. A hookless, incapable (pi declares no
  // work queue), uninvited session reports the invite.
  const d = decide({
    session: mkSession({ foremanInvite: null, agent: "pi", hooksSeen: false }),
  });
  assert.deepEqual(d, { kind: "skip", why: "Foreman is not invited into this session" });
});

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

/** The one pull request a single-repo session owns - what the worker decides about. */
function onlyPr(session: Session): FollowupPr {
  const prs = followupPrs(session);
  assert.equal(prs.length, 1, "this fixture is meant to own exactly one pull request");
  const [pr] = prs;
  assert.ok(pr);
  return pr;
}

/** Fold the observation for a fresh session, exactly as the worker does each pass. */
function observe(session: Session, prev: FollowupMark | null = null): FollowupMark {
  return advanceFollowupMark(prev, onlyPr(session));
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
  const p = buildPayload(onlyPr(mkSession()), { findings: true, ciFailing: true });
  assert.match(p, /PR #7/);
  assert.match(p, /Do NOT open a new pull request/);
  assert.match(p, /gh pr view 7 --comments/);
  assert.match(p, /gh pr checks 7/);
  // A session with one repository is told nothing about repositories.
  assert.doesNotMatch(p, /repositor/);
});

test("the payload only mentions the feedback that is actually open", () => {
  const ciOnly = buildPayload(onlyPr(mkSession()), { findings: false, ciFailing: true });
  assert.doesNotMatch(ciOnly, /review comment/);
  assert.match(ciOnly, /CI/);

  const findingsOnly = buildPayload(
    onlyPr(mkSession({ inspector: inspector({ open: 1 }) })),
    { findings: true, ciFailing: false },
  );
  assert.match(findingsOnly, /review comment/);
  assert.doesNotMatch(findingsOnly, /failing CI/);
});

// ---- one session, several pull requests (a multi-repo task) ----
//
// The premise this half exists for: a multi-repo task's session opens one pull request per
// repository it changed, and the session scalars (`prUrl`, `prChecks`, `inspector`) answer
// for its own checkout alone. Everything below is about the ones that reach no scalar.

/** One repository's line on a multi-repo task's card, with a pull request the poll saw open. */
function repoPr(over: Partial<TaskRepoPrSummary> & { repoRoot: string }): TaskRepoPrSummary {
  return {
    primary: false,
    prUrl: null,
    prState: "open",
    mergedAt: null,
    feedback: null,
    ...over,
  };
}

/** A session running a two-repo task: the primary at /work/alpha, a secondary at /work/beta. */
function mkMultiRepoSession(repoPrs: TaskRepoPrSummary[], over: Partial<Session> = {}): Session {
  const task: TaskSummary = {
    id: "t1",
    title: "cross-repo change",
    fullTitle: "cross-repo change",
    kind: "ship",
    status: "running",
    outcome: null,
    outcomeUrl: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    ensemble: null,
    repoPrs,
  };
  return mkSession({ task, ...over });
}

const ALPHA_PR = repoPr({
  repoRoot: "/work/alpha",
  primary: true,
  prUrl: "https://github.com/owner/alpha/pull/7",
  feedback: {
    prNumber: 7,
    prChecks: null,
    inspector: inspector({
      prKey: "owner/alpha#7",
      url: "https://github.com/owner/alpha/pull/7",
      open: 0,
    }),
  },
});

const BETA_PR = repoPr({
  repoRoot: "/work/beta",
  prUrl: "https://github.com/owner/beta/pull/9",
  feedback: {
    prNumber: 9,
    prChecks: null,
    inspector: inspector({
      prKey: "owner/beta#9",
      url: "https://github.com/owner/beta/pull/9",
      open: 0,
    }),
  },
});

test("a multi-repo session offers every repository's open pull request, primary first", () => {
  const prs = followupPrs(mkMultiRepoSession([ALPHA_PR, BETA_PR]));
  assert.deepEqual(
    prs.map((pr) => [pr.prKey, pr.repoRoot, pr.number]),
    [
      ["owner/alpha#7", "/work/alpha", 7],
      ["owner/beta#9", "/work/beta", 9],
    ],
  );
});

test("a repository with no pull request, or one no poll still sees open, is not offered", () => {
  const noPr = repoPr({ repoRoot: "/work/gamma" });
  // A pull request the durable row still calls open, whose live observation was retracted -
  // what a closed-unmerged sibling looks like. Trusting `prState` here would nudge about it.
  const closed = repoPr({
    repoRoot: "/work/delta",
    prUrl: "https://github.com/owner/delta/pull/3",
    prState: "open",
    feedback: null,
  });
  const prs = followupPrs(mkMultiRepoSession([ALPHA_PR, noPr, closed]));
  assert.deepEqual(prs.map((pr) => pr.prKey), ["owner/alpha#7"]);
});

test("a single-repo session still yields exactly its own pull request", () => {
  // `repoPrs` is empty for every single-repo task, and the session scalars answer instead.
  const prs = followupPrs(mkSession({ inspector: inspector({ open: 2 }) }));
  assert.equal(prs.length, 1);
  assert.deepEqual(prs.map((pr) => [pr.prKey, pr.repoRoot, pr.number]), [
    ["owner/repo#7", null, 7],
  ]);
});

test("each pull request carries its OWN feedback, not the session's", () => {
  // The whole degradation this lifts: the secondary is red and full of findings while the
  // session scalars - the primary's - are clean.
  const beta = repoPr({
    ...BETA_PR,
    repoRoot: "/work/beta",
    feedback: {
      prNumber: 9,
      prChecks: "failing",
      inspector: inspector({
        prKey: "owner/beta#9",
        url: "https://github.com/owner/beta/pull/9",
        open: 3,
      }),
    },
  });
  const session = mkMultiRepoSession([ALPHA_PR, beta]);
  const prs = followupPrs(session);

  const quiet = decide({ session, pr: prs[0] });
  assert.deepEqual(quiet, { kind: "skip", why: "no enabled review comments or failing CI" });

  const loud = decide({ session, pr: prs[1] });
  assert.equal(loud.kind, "nudge");
  if (loud.kind !== "nudge") return;
  assert.equal(loud.prKey, "owner/beta#9");
  assert.match(loud.reason, /3 review comment.*\+ CI failing/);
  assert.match(loud.reason, /\/work\/beta/);
});

test("a nudge about one repository's pull request names it, and only forbids a second OF IT", () => {
  const pr = followupPrs(mkMultiRepoSession([ALPHA_PR, BETA_PR]))[1];
  assert.ok(pr);
  const payload = buildPayload(pr, { findings: true, ciFailing: true });
  assert.match(payload, /PR #9/);
  assert.match(payload, /\/work\/beta/);
  assert.match(payload, /one of several repositories/);
  assert.match(payload, /Do NOT open a new pull request for it/);
  // `gh` runs in the session's own checkout, which is the PRIMARY repo's worktree, so a
  // sibling's pull request has to be named by repository or the command answers about the
  // wrong one.
  assert.match(payload, /gh pr view 9 --repo owner\/beta --comments/);
  assert.match(payload, /gh pr checks 9 --repo owner\/beta/);
});

test("two pull requests on one session hold independent marks", () => {
  // The collision a session-keyed mark caused: nudging repo B erased what repo A had been
  // told, so A's unchanged findings were relayed again - and then A erased B's, for ever.
  const session = mkMultiRepoSession([
    {
      ...ALPHA_PR,
      feedback: {
        prNumber: 7,
        prChecks: null,
        inspector: inspector({
          prKey: "owner/alpha#7",
          url: "https://github.com/owner/alpha/pull/7",
          open: 2,
          round: 1,
        }),
      },
    },
    {
      ...BETA_PR,
      feedback: {
        prNumber: 9,
        prChecks: null,
        inspector: inspector({
          prKey: "owner/beta#9",
          url: "https://github.com/owner/beta/pull/9",
          open: 4,
          round: 1,
        }),
      },
    },
  ]);
  const [alpha, beta] = followupPrs(session);
  assert.ok(alpha && beta);

  const first = decide({ session, pr: alpha });
  assert.equal(first.kind, "nudge");
  if (first.kind !== "nudge") return;

  // The worker keys marks by PR key, so beta's decision never sees alpha's mark.
  const marks = new Map<string, FollowupMark>([[first.prKey, first.mark]]);
  const second = decide({ session, pr: beta, mark: marks.get(beta.prKey) ?? null });
  assert.equal(second.kind, "nudge", "beta has never been nudged and must be");
  if (second.kind !== "nudge") return;
  marks.set(second.prKey, second.mark);

  // And alpha's history survived beta's nudge: same round, same findings, nothing new.
  assert.deepEqual(
    decide({
      session,
      pr: alpha,
      mark: advanceFollowupMark(marks.get(alpha.prKey) ?? null, alpha),
    }),
    { kind: "skip", why: "already nudged this round of feedback" },
  );
  assert.equal(marks.get(alpha.prKey)?.findingsRound, 1);
  assert.equal(marks.get(beta.prKey)?.findingsRound, 1);
});

test("a mark advances on its own pull request's CI, not a sibling's", () => {
  const failing: FollowupPr = {
    prKey: "owner/beta#9",
    url: "https://github.com/owner/beta/pull/9",
    number: 9,
    repoRoot: "/work/beta",
    inspector: null,
    checks: "failing",
  };
  const nudged = advanceFollowupMark({ prKey: failing.prKey, findingsRound: null, ciNudged: true }, failing);
  assert.equal(nudged.ciNudged, true, "still the same failing episode");
  const recovered = advanceFollowupMark(nudged, { ...failing, checks: "passing" });
  assert.equal(recovered.ciNudged, false, "this pull request's own checks recovered");
});

test("two repositories holding the same pull request NUMBER do not share a mark", () => {
  // Only reachable with the Inspector switched off, which is a supported configuration: with
  // no ledger row there is no `owner/repo#n` key, and a bare `#7` in each of two repositories
  // is one key for two pull requests - the collision this file is keyed per PR to avoid.
  const unadopted = (repoRoot: string, url: string): TaskRepoPrSummary =>
    repoPr({
      repoRoot,
      prUrl: url,
      feedback: { prNumber: 7, prChecks: "failing", inspector: null },
    });
  const prs = followupPrs(
    mkMultiRepoSession([
      { ...unadopted("/work/alpha", "https://github.com/owner/alpha/pull/7"), primary: true },
      unadopted("/work/beta", "https://github.com/owner/beta/pull/7"),
    ]),
  );
  assert.equal(new Set(prs.map((pr) => pr.prKey)).size, 2, "one key per pull request");
});
