import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTINE_FOLLOWUP_SKIPS,
  SKIP_ALREADY_NUDGED,
  SKIP_NOTHING_OPEN,
  SKIP_ROUND_MISMATCH,
  SKIP_STILL_WORKING,
  heldSkipReason,
  activeWorkflowOwnsSession,
  advanceFollowupMark,
  buildPayload,
  decideReviewFollowup,
  followupPrs,
  reviewFollowupPrs,
  workflowHoldsReviewFollowup,
  workflowReleasedFollowupOnly,
} from "../src/server/foreman/review-followup.ts";
import type {
  AdoptedInspection,
  FollowupMark,
  FollowupPr,
  ReviewFollowupInput,
} from "../src/server/foreman/review-followup.ts";
import type {
  InspectorComment,
  InspectorInspection,
  InspectorSummary,
  Session,
  SessionQueueSummary,
  TaskRepoPrSummary,
  TaskSummary,
} from "../src/shared/types.ts";
import type { TerminalHandle } from "../src/shared/terminal.ts";
import { inspectorSummaryOf } from "../src/shared/inspector.ts";
import { mkInspection } from "./helpers/inspection-fixture.ts";
import { WORKFLOW_LIMITS, WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from "../src/shared/workflow.ts";

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
    blocker: null,
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
    pendingEffort: null,
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

/** One finding as the findings route returns it. Posted on GitHub unless a case says not. */
function finding(over: Partial<InspectorComment> = {}): InspectorComment {
  const fingerprint = over.fingerprint ?? "fp-1";
  return {
    id: `id-${fingerprint}`,
    prKey: "owner/repo#7",
    fingerprint,
    path: "src/a.ts",
    line: 12,
    title: "Null check missing",
    body: "The handler dereferences `user` before checking it.",
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    postedAt: NOW - 30_000,
    githubUrl: `https://github.com/owner/repo/pull/7#discussion_${fingerprint}`,
    legacyPosted: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...over,
  };
}

/**
 * What the worker's read of the findings route would return for this pull request's
 * snapshot: `postedOpen` posted rows, and the rest of `open` as drafts.
 */
function findingsFor(pr: FollowupPr | null): InspectorComment[] {
  const summary = pr?.inspector;
  if (!summary) return [];
  return Array.from({ length: summary.open }, (_, i) =>
    finding({
      prKey: summary.prKey,
      fingerprint: `fp-${i + 1}`,
      ...(i < summary.postedOpen ? {} : { status: "drafted", postedAt: null, githubUrl: null }),
    }));
}

/**
 * Decide as the worker does once it has read the findings. A case that names `findings`,
 * even as undefined, gets exactly that; every other case gets the snapshot's own findings,
 * so it reads as the whole decision rather than its first, pre-read half. The read answers
 * for the snapshot's own round unless a case names `findingsRound`.
 */
function decide(over: Partial<ReviewFollowupInput> = {}) {
  const session = over.session ?? mkSession();
  // The session's own pull request unless a case names one, which is what the worker
  // passes for a single-repo session and keeps every case below reading as it did.
  const pr = "pr" in over ? (over.pr ?? null) : (followupPrs(session)[0] ?? null);
  return decideReviewFollowup({
    session,
    pr,
    findings: findingsFor(pr),
    findingsRound: pr?.inspector?.round ?? 0,
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
  assert.match(d.reason, /2 unresolved finding/);
  assert.match(d.payload, /Do NOT open a new pull request/);
});

test("a nudge that includes findings asks for them first, and stamps nothing", () => {
  // The decision stays zero-I/O: with no findings read yet it cannot build a payload that
  // carries their text, so it says the read is needed and leaves the mark alone.
  const session = mkSession({ inspector: inspector({ open: 2, postedOpen: 0, mode: "dry-run" }) });
  const d = decide({ session, findings: undefined });
  assert.deepEqual(d, { kind: "read-findings", prKey: "owner/repo#7", reason: "2 unresolved finding(s)" });
});

test("a CI-only nudge needs no findings read", () => {
  const d = decide({ session: mkSession({ prChecks: "failing" }), findings: undefined });
  assert.equal(d.kind, "nudge");
});

test("findings resolved between the snapshot and the read drop out of the nudge", () => {
  const session = mkSession({ inspector: inspector({ open: 2 }), prChecks: "failing" });
  // Nothing else open: the pass skips, and since nothing is stamped the round stays unrelayed.
  assert.deepEqual(
    decide({ session: mkSession({ inspector: inspector({ open: 2 }) }), findings: [] }),
    { kind: "skip", why: "no enabled review comments or failing CI" },
  );
  assert.deepEqual(
    decide({
      session: mkSession({ inspector: inspector({ open: 1 }) }),
      findings: [finding({ status: "resolved" })],
    }),
    { kind: "skip", why: "no enabled review comments or failing CI" },
  );

  // Something else open: the nudge goes out without its findings part, and the findings
  // round is left unstamped so the next round with findings is still relayed.
  const ciOnly = decide({ session, findings: [] });
  assert.equal(ciOnly.kind, "nudge");
  if (ciOnly.kind !== "nudge") return;
  assert.equal(ciOnly.reason, "CI failing");
  assert.doesNotMatch(ciOnly.payload, /unresolved finding/);
  assert.equal(ciOnly.mark.findingsRound, null);
  assert.equal(ciOnly.mark.ciNudged, true);
});

test("findings read for a different Inspector round than the snapshot are held, unstamped", () => {
  // The read and the fresh snapshot are two requests, and a round can finish between them.
  // Typing would stamp round 2 with round 3's set, and the next pass would relay round 3 again.
  const session = mkSession({ inspector: inspector({ open: 1, round: 2 }) });
  const raced = decide({ session, findingsRound: 3 });
  assert.deepEqual(raced, {
    kind: "skip",
    why: "the findings read and the snapshot are from different GitHub Inspector rounds",
  });
  // A read that named no round is refused the same way, never assumed current.
  assert.equal(decide({ session, findingsRound: undefined }).kind, "skip");
  // The same round goes out.
  assert.equal(decide({ session, findingsRound: 2 }).kind, "nudge");

  // A round mismatch says nothing about CI: findings that dropped out leave no round to match.
  const ciOnly = decide({
    session: mkSession({ inspector: inspector({ open: 1, round: 2 }), prChecks: "failing" }),
    findings: [],
    findingsRound: 3,
  });
  assert.equal(ciOnly.kind, "nudge");
});

test("an already-relayed CI episode is not repeated because the findings dropped out", () => {
  const session = mkSession({ inspector: inspector({ open: 2, round: 2 }), prChecks: "failing" });
  const mark = { ...observe(session), ciNudged: true, findingsRound: 1 };
  assert.deepEqual(
    decide({ session, mark, findings: [] }),
    { kind: "skip", why: "already nudged this round of feedback" },
  );
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
  assert.match(d.reason, /1 unresolved finding.*\+ CI failing/);
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
    assert.doesNotMatch(ciOnly.payload, /unresolved finding/);
  }

  const commentsOnly = decide({
    session: both,
    cfg: { trackReviewComments: true, trackCiFailures: false, settleMs: SETTLE },
  });
  assert.equal(commentsOnly.kind, "nudge");
  if (commentsOnly.kind === "nudge") {
    assert.match(commentsOnly.reason, /2 unresolved finding/);
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

// ---- a PR the Inspector adopted that the session card does not carry ----

const ADOPTED_KEY = "owner/repo#9";
const ADOPTED_URL = "https://github.com/owner/repo/pull/9";

function adoptedRow(over: Partial<InspectorInspection> = {}): AdoptedInspection {
  const row = mkInspection({ key: ADOPTED_KEY, url: ADOPTED_URL, number: 9, ...over });
  return { row, inspector: inspectorSummaryOf(row, { mode: "dry-run" }) };
}

/** The live example: the card shows no PR while the checkout sits on an adopted PR's branch. */
const detached = () => mkSession({ prUrl: null, prNumber: null, prState: null, inspector: null });

test("reviewFollowupPrs keeps the card's PR first and appends an adopted PR on the session's branch", () => {
  const session = mkSession({ inspector: inspector({ open: 1 }) });
  const prs = reviewFollowupPrs(session, [adoptedRow()]);
  assert.deepEqual(prs.map((pr) => pr.prKey), ["owner/repo#7", ADOPTED_KEY]);
  assert.deepEqual(prs[0], followupPrs(session)[0]);
  assert.deepEqual(prs[1], {
    prKey: ADOPTED_KEY,
    url: ADOPTED_URL,
    number: 9,
    repoRoot: null,
    inspector: adoptedRow().inspector,
    checks: null,
  });
});

test("reviewFollowupPrs follows an adopted row by its agent id across a session id re-mint", () => {
  const card = { prUrl: null, prNumber: null, prState: null, inspector: null };
  const byAgent = adoptedRow({ sessionId: "s1", noteKey: "agent-1" });
  // The row names the predecessor's synthetic id; the restarted session kept its agent id.
  const restarted = mkSession({ ...card, id: "s1-restarted", agentSessionId: "agent-1" });
  assert.deepEqual(reviewFollowupPrs(restarted, [byAgent]).map((pr) => pr.prKey), [ADOPTED_KEY]);
  // The same live session keeps it after its agent id binds or rotates: the id still names it.
  const rebound = mkSession({ ...card, id: "s1", agentSessionId: "agent-after-clear" });
  assert.deepEqual(reviewFollowupPrs(rebound, [byAgent]).map((pr) => pr.prKey), [ADOPTED_KEY]);
  // Adopted before the agent id was bound: the session id is the only match, as before.
  const provisional = adoptedRow({ sessionId: "s1", noteKey: null });
  assert.deepEqual(reviewFollowupPrs(mkSession({ ...card, id: "s1", agentSessionId: "agent-1" }), [provisional]).map((pr) => pr.prKey), [ADOPTED_KEY]);
  assert.deepEqual(reviewFollowupPrs(restarted, [provisional]), []);
  // Another agent on another session is never this one.
  const stranger = mkSession({ ...card, id: "s9", agentSessionId: "agent-9" });
  assert.deepEqual(reviewFollowupPrs(stranger, [byAgent]), []);
});

test("reviewFollowupPrs ignores an adopted row that is not this session's open PR on this branch", () => {
  const session = detached();
  const ignored: Array<[string, Partial<InspectorInspection>]> = [
    ["another session", { sessionId: "s2" }],
    ["another repository", { repoRoot: "/work/beta" }],
    ["another branch", { headRefName: "feat/y" }],
    ["an unknown branch", { headRefName: null }],
    ["a closed row", { state: "closed" }],
  ];
  for (const [label, over] of ignored) {
    assert.deepEqual(reviewFollowupPrs(session, [adoptedRow(over)]), [], label);
  }
  // A row whose key the card already carries is not offered twice.
  const carried = mkSession({ inspector: inspector({ open: 1 }) });
  const duplicate = adoptedRow({ key: "owner/repo#7", url: "https://github.com/owner/repo/pull/7", number: 7 });
  assert.deepEqual(reviewFollowupPrs(carried, [duplicate]), followupPrs(carried));
  assert.equal(reviewFollowupPrs(detached(), [adoptedRow(), adoptedRow()]).length, 1, "one entry per key");
});

test("reviewFollowupPrs does not offer a card PR twice when the card has no Inspector summary yet", () => {
  // The card falls back to `#7` until its registry projection sees the adoption; the route,
  // read from the database, already names the same pull request `owner/repo#7`.
  const unqualified = mkSession({ inspector: null });
  assert.equal(followupPrs(unqualified)[0]?.prKey, "#7");
  const sameUrl = adoptedRow({ key: "owner/repo#7", url: "https://github.com/owner/repo/pull/7", number: 7 });
  assert.deepEqual(reviewFollowupPrs(unqualified, [sameUrl]), followupPrs(unqualified));
  const otherCase = adoptedRow({ key: "Owner/Repo#7", url: "https://github.com/Owner/Repo/pull/7", number: 7 });
  assert.deepEqual(reviewFollowupPrs(unqualified, [otherCase]), followupPrs(unqualified), "GitHub names are case-insensitive");
});

test("an adopted-only PR with unresolved findings asks for them, and with none it is left alone", () => {
  const session = detached();
  const [pr] = reviewFollowupPrs(session, [adoptedRow()]);
  assert.ok(pr);
  const first = decide({ session, pr, findings: undefined });
  assert.equal(first.kind, "read-findings");
  assert.equal(first.kind === "read-findings" && first.prKey, ADOPTED_KEY);

  const relayed = decide({ session, pr });
  assert.equal(relayed.kind, "nudge");

  // An adopted-only entry carries no CI, so a row without findings has nothing to relay.
  const [quiet] = reviewFollowupPrs(session, [adoptedRow({ openFindings: 0 })]);
  assert.deepEqual(decide({ session, pr: quiet ?? null }), {
    kind: "skip",
    why: "no enabled review comments or failing CI",
  });
});

test("a clean open PR - no findings, CI not red - is left alone", () => {
  const d = decide({ session: mkSession({ inspector: inspector({ open: 0 }), prChecks: "passing" }) });
  assert.deepEqual(d, { kind: "skip", why: "no enabled review comments or failing CI" });
});

test("a dry-run draft triggers the relay, and its text travels in the message", () => {
  // open > 0 but postedOpen = 0: the findings were drafted and never posted. They are on no
  // pull request, so the relay types them rather than pointing at GitHub.
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 4, postedOpen: 0, mode: "dry-run" }) }),
  });
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.match(d.reason, /4 unresolved finding/);
  assert.match(d.payload, /4 unresolved findings on it \(0 posted on GitHub, 4 not posted\)/);
  assert.match(d.payload, /Not posted on GitHub\. This message is the only copy\./);
  assert.match(d.payload, /The handler dereferences `user` before checking it\./);
});

test("unposted findings fire when the current Inspector mode is live too", () => {
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 4, postedOpen: 0, mode: "live" }) }),
  });
  assert.equal(d.kind, "nudge");
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

test("only a blocked run that the operator or the session must restart releases the follow-through", () => {
  const run = (status: WorkflowRunStatus, phase: string, round = 2) => ({ status, phase, round, maxRepairRounds: 3 });
  const cases: Array<[string, ReturnType<typeof run>, boolean]> = [
    ["running", run("running", "persona_review"), true],
    ["waiting for PR", run("waiting_for_pr", "pr_handoff"), true],
    ["waiting for Inspector", run("waiting_for_inspector", "inspector_review"), true],
    ["waiting for new head", run("waiting_for_new_head", "inspector_findings"), true],
    ["waiting for session", run("waiting_for_session", "persona_feedback"), true],
    ["spent round_limit", run("blocked", "round_limit", 4), false],
    ["round_limit granted more rounds", run("blocked", "round_limit", 3), true],
    ["spent inspector_round_limit", run("blocked", "inspector_round_limit", 4), false],
    ["inspector_round_limit granted more rounds", run("blocked", "inspector_round_limit", 3), true],
    ["unchanged_evidence_exhausted", run("blocked", "unchanged_evidence_exhausted"), false],
    ["session_disappeared", run("blocked", "session_disappeared"), false],
    ["check_cleanup_unresolved", run("blocked", "check_cleanup_unresolved"), true],
    ["an unclassified blocked phase", run("blocked", "a_phase_added_later"), true],
    ["completed", run("completed", "completed"), false],
    ["cancelled", run("cancelled", "cancelled"), false],
    ["failed", run("failed", "failed"), false],
  ];
  for (const [label, r, holds] of cases) {
    assert.equal(workflowHoldsReviewFollowup([r]), holds, label);
    assert.equal(workflowReleasedFollowupOnly([r]), r.status === "blocked" && !holds, label);
  }
  const noPhase = { status: "blocked" } as unknown as ReturnType<typeof run>;
  assert.equal(workflowHoldsReviewFollowup([noPhase]), true, "a run with no phase");
  assert.equal(workflowHoldsReviewFollowup([]), false);
  assert.equal(workflowHoldsReviewFollowup([run("blocked", "session_disappeared"), run("running", "persona_review")]), true);
  assert.equal(workflowReleasedFollowupOnly([]), false);
});

test("a session held only by a spent blocked run is asked to read its findings", () => {
  const runs = [{ status: "blocked" as const, phase: "round_limit", round: 4, maxRepairRounds: 3 }];
  const session = mkSession({ inspector: inspector({ open: 2, postedOpen: 0, mode: "dry-run" }) });
  const d = decide({ session, findings: undefined, workflowOwnsSession: workflowHoldsReviewFollowup(runs) });
  assert.deepEqual(d, { kind: "read-findings", prKey: "owner/repo#7", reason: "2 unresolved finding(s)" });
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

test("every gate still refuses a dry-run draft, before and after the findings are read", () => {
  // The trigger widened to drafts; nothing else did. Each case is a gate that refused a
  // posted finding before, and must refuse a never-posted one now, at both halves of the
  // decision - the pre-read one the worker acts on first and the post-read one it types.
  const draft = inspector({ open: 2, postedOpen: 0, mode: "dry-run" });
  const base = mkSession({ inspector: draft });
  const cases: Array<[string, Partial<ReviewFollowupInput>, string | RegExp]> = [
    ["off", { cfg: { trackReviewComments: false, trackCiFailures: false, settleMs: SETTLE } }, "PR follow-through is off"],
    ["uninvited", { session: mkSession({ inspector: draft, foremanInvite: null }) }, /not invited/],
    ["exited", { session: mkSession({ inspector: draft, state: "exited" }) }, "the session exited"],
    ["hookless", { session: mkSession({ inspector: draft, hooksSeen: false }) }, "the session is not hook-instrumented"],
    ["no PR", { session: mkSession({ inspector: draft, prState: null, prUrl: null }) }, "no open pull request"],
    ["needs you", { bucket: "needs-you" }, "the session needs a human"],
    ["input wait", { session: mkSession({ inspector: draft, state: "awaiting_input" }) }, "the session is waiting on input"],
    ["work queue", { session: mkSession({ inspector: draft, queue: queue(1) }) }, /work queue/],
    ["workflow", { workflowOwnsSession: true }, "an active workflow owns this session"],
    [
      "review comments off",
      { cfg: { trackReviewComments: false, trackCiFailures: true, settleMs: SETTLE } },
      "no enabled review comments or failing CI",
    ],
    ["working", { session: mkSession({ inspector: draft, state: "working" }) }, "still working"],
    ["no pane", { session: mkSession({ inspector: draft, terminals: [] }) }, "no pane to type into"],
    ["dry-run Foreman", { mayActLive: false }, /won't type/],
    ["already relayed", { mark: { ...observe(base), findingsRound: 1 } }, "already nudged this round of feedback"],
  ];
  for (const [name, over, why] of cases) {
    for (const findings of [undefined, findingsFor(onlyPr(base))]) {
      const d = decide({ session: base, ...over, findings });
      assert.equal(d.kind, "skip", `${name} (${findings ? "after" : "before"} the read)`);
      if (d.kind !== "skip") continue;
      if (typeof why === "string") assert.equal(d.why, why, name);
      else assert.match(d.why, why, name);
    }
  }
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

test("the routine waiting skips are the exported constants the gates return, and only those", () => {
  const working = decide({ session: mkSession({ inspector: inspector({ open: 2 }), state: "working" }) });
  assert.deepEqual(working, { kind: "skip", why: SKIP_STILL_WORKING });

  const session = mkSession({ inspector: inspector({ open: 2, round: 1 }) });
  const first = decide({ session });
  assert.equal(first.kind, "nudge");
  if (first.kind !== "nudge") return;
  const again = decide({ session, mark: observe(session, first.mark) });
  assert.deepEqual(again, { kind: "skip", why: SKIP_ALREADY_NUDGED });

  assert.deepEqual([...ROUTINE_FOLLOWUP_SKIPS].sort(), [SKIP_ALREADY_NUDGED, SKIP_STILL_WORKING].sort());
  const held = decide({ session, workflowOwnsSession: true });
  assert.ok(held.kind === "skip" && !ROUTINE_FOLLOWUP_SKIPS.has(held.why));
});

test("the held log reports a stale read's 'nothing to act on' as the round mismatch, and nothing else", () => {
  const pr = onlyPr(mkSession({ inspector: inspector({ open: 1, round: 4 }) }));
  const nothing = decide({ session: mkSession({ inspector: inspector({ open: 0 }) }) });
  assert.deepEqual(nothing, { kind: "skip", why: SKIP_NOTHING_OPEN });

  assert.equal(heldSkipReason(pr, SKIP_NOTHING_OPEN, 3, true), SKIP_ROUND_MISMATCH);
  assert.equal(heldSkipReason(pr, SKIP_NOTHING_OPEN, 3, false), SKIP_NOTHING_OPEN, "untracked review feedback is the real reason");
  assert.equal(heldSkipReason(pr, SKIP_NOTHING_OPEN, 4, true), SKIP_NOTHING_OPEN);
  assert.equal(heldSkipReason(pr, SKIP_NOTHING_OPEN, undefined, true), SKIP_NOTHING_OPEN);
  assert.equal(heldSkipReason(pr, "an active workflow owns this session", 3, true), "an active workflow owns this session");
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
  const p = buildPayload(onlyPr(mkSession()), { findings: true, ciFailing: true }, [finding()]);
  assert.match(p, /PR #7/);
  assert.match(p, /Do NOT open a new pull request/);
  assert.match(p, /gh pr checks 7/);
  // A session with one repository is told nothing about repositories.
  assert.doesNotMatch(p, /repositor/);
});

test("the payload only mentions the feedback that is actually open", () => {
  const ciOnly = buildPayload(onlyPr(mkSession()), { findings: false, ciFailing: true });
  assert.doesNotMatch(ciOnly, /unresolved finding/);
  assert.match(ciOnly, /CI/);

  const findingsOnly = buildPayload(
    onlyPr(mkSession({ inspector: inspector({ open: 1 }) })),
    { findings: true, ciFailing: false },
    [finding()],
  );
  assert.match(findingsOnly, /GitHub Inspector has 1 unresolved finding on it/);
  assert.doesNotMatch(findingsOnly, /failing CI/);
});

test("the payload opens with the posted counts and carries every finding's text, never a gh pointer", () => {
  const findings = [
    finding({ fingerprint: "posted", title: "Posted one", body: "Posted body." }),
    finding({
      fingerprint: "draft",
      title: "Draft one",
      body: "Draft body.",
      severity: "minor",
      status: "drafted",
      postedAt: null,
      githubUrl: null,
    }),
    finding({
      fingerprint: "again",
      title: "Raised again",
      body: "Again body.",
      severity: "minor",
      path: "src/b.ts",
      status: "drafted",
      githubUrl: "https://github.com/owner/repo/pull/7#discussion_old",
    }),
  ];
  const p = buildPayload(
    onlyPr(mkSession({ inspector: inspector({ open: 3, postedOpen: 1 }) })),
    { findings: true, ciFailing: false },
    findings,
  );
  assert.ok(
    p.startsWith(
      "PR #7 needs follow-through: GitHub Inspector has 3 unresolved findings on it " +
        "(1 posted on GitHub, 2 not posted).",
    ),
    p,
  );
  assert.match(p, /1\. Do NOT open a new pull request - push your fixes to this same branch\./);
  assert.match(
    p,
    /2\. Address every GitHub Inspector finding listed below\. A finding marked Not posted exists only in this message: do not look for it on GitHub or reply to it there\. If you think a posted finding is wrong, you may answer in its GitHub thread\. If you disagree with a finding that was not posted, say which one and why in your reply\./,
  );
  assert.match(p, /3\. Commit and push\./);
  assert.match(p, /4\. Then keep watching the PR/);
  // The pointer that sent the agent looking for drafts on GitHub is gone.
  assert.doesNotMatch(p, /gh pr view/);
  assert.doesNotMatch(p, /--comments/);

  // The findings come from the shared renderer, after the steps, each with its marker.
  const listing = p.slice(p.indexOf("4. Then keep watching"));
  assert.match(listing, /## MAJOR - Posted one\nLocation: src\/a\.ts:12\nPosted on GitHub: https:\/\/github\.com\/owner\/repo\/pull\/7#discussion_posted\nPosted body\.\nFingerprint: posted/);
  assert.match(listing, /## MINOR - Draft one\n.*\nNot posted on GitHub\. This message is the only copy\.\nDraft body\./);
  assert.match(listing, /Not posted again\. An earlier version was posted on GitHub: https:\/\/github\.com\/owner\/repo\/pull\/7#discussion_old/);
  assert.ok(listing.indexOf("Posted one") < listing.indexOf("Draft one"), "severity order");
});

test("the payload stays under the 8,000-byte ceiling by dropping whole findings", () => {
  const findings = Array.from({ length: 12 }, (_, i) =>
    finding({ fingerprint: `fp-${String(i).padStart(2, "0")}`, title: `Finding ${i}`, body: "x".repeat(900) }));
  const p = buildPayload(
    onlyPr(mkSession({ inspector: inspector({ open: 12 }) })),
    { findings: true, ciFailing: true },
    findings,
  );
  assert.ok(Buffer.byteLength(p, "utf8") <= WORKFLOW_LIMITS.feedbackPayloadBytes, String(Buffer.byteLength(p)));
  // The header counts all twelve; the listing says how many it left out.
  assert.match(p, /GitHub Inspector has 12 unresolved findings on it \(12 posted on GitHub, 0 not posted\)/);
  const shown = p.match(/^## MAJOR - /gm)?.length ?? 0;
  assert.ok(shown > 0 && shown < 12, String(shown));
  assert.match(p, new RegExp(`${12 - shown} more unresolved findings are not listed here`));
  // A finding is listed whole or not at all.
  assert.equal(p.match(/x{900}/g)?.length, shown);
});

test("a finding being posted is counted on its own", () => {
  const p = buildPayload(
    onlyPr(mkSession({ inspector: inspector({ open: 2 }) })),
    { findings: true, ciFailing: false },
    [finding({ fingerprint: "a" }), finding({ fingerprint: "b", status: "posting" })],
  );
  assert.match(p, /\(1 posted on GitHub, 0 not posted, 1 being posted now\)/);
  assert.match(p, /Being posted now/);
});

// A refused draft stays unresolved. GitHub will not take it, so the relay is the only place
// the session reads it: Foreman still relays it, and says GitHub refused it and why.
test("a draft GitHub refused is still relayed, with how many times and why", () => {
  const reason = "Line could not be resolved (HTTP 422)";
  const drafts = [
    finding({ fingerprint: "once", title: "Refused once", status: "drafted", postedAt: null, githubUrl: null, postRefusals: 1, lastPostError: reason }),
    finding({ fingerprint: "capped", title: "Refused three times", status: "drafted", postedAt: null, githubUrl: null, postRefusals: 3, lastPostError: reason }),
  ];
  const d = decide({
    session: mkSession({ inspector: inspector({ open: 2, postedOpen: 0 }) }),
    findings: drafts,
  });
  assert.equal(d.kind, "nudge");
  if (d.kind !== "nudge") return;
  assert.match(d.payload, /GitHub Inspector has 2 unresolved findings on it \(0 posted on GitHub, 2 not posted \(1 refused by GitHub\)\)/);
  assert.match(
    d.payload,
    /## MAJOR - Refused once\n.*\nNot posted yet\. GitHub refused it 1 time: Line could not be resolved \(HTTP 422\)\. Mission Control offers it again on the next push\.\n/,
  );
  assert.match(
    d.payload,
    /## MAJOR - Refused three times\n.*\nNot posted\. GitHub refused it 3 times: Line could not be resolved \(HTTP 422\)\n/,
  );
  assert.doesNotMatch(d.payload, /only copy/, "a refused draft carries its refusal line instead");
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
    workflowId: null,
    status: "running",
    outcome: null,
    outcomeUrl: null,
    pipelineRun: null,
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
  assert.match(loud.reason, /3 unresolved finding.*\+ CI failing/);
  assert.match(loud.reason, /\/work\/beta/);
});

test("a nudge about one repository's pull request names it, and only forbids a second OF IT", () => {
  const pr = followupPrs(mkMultiRepoSession([ALPHA_PR, BETA_PR]))[1];
  assert.ok(pr);
  const payload = buildPayload(
    pr,
    { findings: true, ciFailing: true },
    [finding({ prKey: "owner/beta#9" })],
  );
  assert.match(payload, /PR #9/);
  assert.match(payload, /\/work\/beta/);
  assert.match(payload, /one of several repositories/);
  assert.match(payload, /Do NOT open a new pull request for it/);
  // `gh` runs in the session's own checkout, which is the PRIMARY repo's worktree, so a
  // sibling's pull request has to be named by repository or the command answers about the
  // wrong one.
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

test("a blocked session is not nudged about review feedback until the blocker clears", () => {
  const blocker = { id: "blk-fixture", kind: "dependency" as const, reason: "Needs #1402", waitingOn: "Platform", resumeWhen: "#1402 merges", details: null, referenceUrl: null, startedAt: 1, updatedAt: 1, checkedAt: null, reply: null };
  const held = decide({ session: mkSession({ blocker, inspector: inspector({ open: 2 }) }) });
  assert.deepEqual(held, { kind: "skip", why: "the session is blocked" });
  assert.equal(decide({ session: mkSession({ inspector: inspector({ open: 2 }) }) }).kind, "nudge");
});
