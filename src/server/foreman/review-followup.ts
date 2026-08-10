import type { Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import type { ReportBucket } from "@shared/session.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { hasPane } from "./queue-machine.ts";
import { settledIdle } from "@shared/session.ts";

// The review follow-through trigger's decision core: a session's work has become an
// OPEN pull request, it has parked, and the PR now carries feedback nobody is acting on
// - unresolved Inspector comments, a failing CI, or both. Should Foreman type the
// session back onto it?
//
// Zero I/O and `now` always injected, exactly like queue-machine.ts and
// prompted-wrapup.ts, so the whole policy is a unit-testable table and the worker holds
// none of it. Unlike those two this needs no `claude -p`: the question is not "is this
// work done" (a judgement) but "does this PR carry feedback we have not relayed yet" (a
// fact), and every input to that fact is already on the session snapshot - `inspector`,
// `prChecks`, `prState`. So there is no verify step; decide, then type.
//
// WHY THIS IS ITS OWN TRIGGER, NOT A WRAP-UP
//
// The wrap-up triggers (`drain`, `prompted`) answer "has the work finished, so ship it".
// By the time this fires the work HAS shipped - there is a PR - and what is left is the
// review loop the PR opened. `tickTargets` never selects a parked straight-to-PR session
// (no queue, no armed prompted trigger), so this runs FLEET-LEVEL in the worker's loop,
// over every session, the same shape as the backlog autopilot.

/** The knobs this trigger reads. A projection of ForemanConfig, like QueueConfig. */
export interface ReviewFollowupConfig {
  /** Relay posted Inspector comments from `ForemanConfig.trackReviewFeedback`. */
  trackReviewComments: boolean;
  /** Relay failing CI episodes from `ForemanConfig.trackCiFailures`. */
  trackCiFailures: boolean;
  /** How long a session must sit idle before its work counts as settled. */
  settleMs: number;
}

export interface ReviewFollowupInput {
  session: Session;
  /** The session's bucket, computed from the current fleet snapshot. */
  bucket: ReportBucket;
  /** Whether Foreman is cleared to type here (live + allowlisted) - the same gate a send passes. */
  mayActLive: boolean;
  /** Whether a non-terminal workflow run currently owns this session and its checkout. */
  workflowOwnsSession: boolean;
  /**
   * What we have already nudged THIS session about on its current PR, advanced by
   * `advanceFollowupMark` for this pass's observation. Null when we have never nudged it.
   */
  mark: FollowupMark | null;
  cfg: ReviewFollowupConfig;
  now: number;
}

export type ReviewFollowupDecision =
  /** Not a candidate. `why` is for the tests/log - every skip is explicable. */
  | { kind: "skip"; why: string }
  /** Type the follow-up. Carries the mark to stamp on delivery and the exact payload. */
  | { kind: "nudge"; mark: FollowupMark; reason: string; payload: string };

/**
 * What we have already relayed to a session about its CURRENT PR, so we neither nag an
 * unchanged state nor miss a genuinely new one. In-memory only.
 *
 * The two feedback sources have different "newness" clocks, and one signature string
 * cannot track both (that was the bug the Inspector caught): findings are keyed by the
 * Inspector ROUND, which advances with every push, while a CI failure is an EPISODE that
 * can recur on the same round (a flaky rerun, a re-triggered check) and so needs its own
 * observed-recovery bit. Keyed alongside `prKey` so a new PR on the same session resets
 * everything.
 */
export interface FollowupMark {
  /** The PR this mark is about. A different PR key resets the other two fields. */
  prKey: string;
  /** The Inspector round we last nudged POSTED findings for, or null if never. */
  findingsRound: number | null;
  /** Whether we have nudged for the CURRENT CI-failing episode; re-armed on recovery. */
  ciNudged: boolean;
}

/** The PR a mark is keyed to. Prefers the Inspector's key, falls back to the PR number. */
function prKeyOf(s: Session): string {
  return s.inspector?.prKey ?? (s.prNumber !== null ? `#${s.prNumber}` : "pr");
}

/**
 * Fold this pass's observation into the mark: reset it on a new PR, and RE-ARM CI when the
 * checks are no longer failing, so a later failure counts as a fresh episode.
 *
 * Pure, and called every pass for EVERY open-PR session - not only the ones about to be
 * nudged - because that is the whole fix: a CI recovery seen while the session was working
 * (or while Foreman was dry-run) has to be remembered so the next failure re-arms once the
 * session parks. Without a PR head sha on the snapshot this observed-recovery bit is the
 * only thing that can tell a re-failure from the one we already relayed.
 */
export function advanceFollowupMark(prev: FollowupMark | null, s: Session): FollowupMark {
  const prKey = prKeyOf(s);
  const base: FollowupMark =
    prev && prev.prKey === prKey ? prev : { prKey, findingsRound: null, ciNudged: false };
  // CI is no longer failing: whatever episode we may have nudged is over. Re-arm it.
  if (base.ciNudged && s.prChecks !== "failing") return { ...base, ciNudged: false };
  return base;
}

/** What is actionable on this session's PR right now. */
interface Feedback {
  /** The Inspector has open findings that are actually posted on the PR. */
  findings: boolean;
  /** The PR's CI rollup is failing (as opposed to pending or passing). */
  ciFailing: boolean;
}

/** Terminal runs have released their session; every other durable state still owns it. */
export function activeWorkflowOwnsSession(
  runs: readonly Pick<WorkflowRunSummary, "status">[],
): boolean {
  return runs.some((run) => !["completed", "cancelled", "failed"].includes(run.status));
}

function feedbackState(s: Session, cfg: ReviewFollowupConfig): Feedback {
  const findings = cfg.trackReviewComments && !!s.inspector && s.inspector.postedOpen > 0;
  return { findings, ciFailing: cfg.trackCiFailures && s.prChecks === "failing" };
}

/**
 * Is this session a candidate for a review follow-through nudge? Every branch is an early
 * return and the order is the policy.
 *
 * Strict on purpose. Each gate below is a case where typing would be WRONG - interrupting
 * live work, relaying feedback a human is already handling, or nagging a PR that is being
 * dealt with - and there is no model call here to catch a mistake the gates let through.
 */
export function decideReviewFollowup(input: ReviewFollowupInput): ReviewFollowupDecision {
  const { session: s, bucket, mayActLive, workflowOwnsSession, mark, cfg, now } = input;

  // 1. The trigger is off. First because it is the cheapest and because an off trigger
  //    must reach no branch that decides to type.
  if (!cfg.trackReviewComments && !cfg.trackCiFailures) {
    return skip("PR follow-through is off");
  }

  // 2. Only a session Foreman was invited into, and only one it can actually drive, and
  //    only a live one.
  //
  //    The invite comes FIRST of the three, above even the capability check, because it is
  //    the refusal that matters most here and the one a reader needs to see reported
  //    plainly: this path is the one that typed "create a PR" into personal Claude chats,
  //    and it did so because it iterated every session with an open PR. A hand-started
  //    session with a PR on its branch is capable, hooked, live, and still none of
  //    Foreman's business.
  if (s.foremanInvite === null) return skip("Foreman is not invited into this session");
  // No `workQueue` capability means no hooks and no reliable state to read; an exited
  // session has nothing left to type into.
  // `workQueue` is the reliable-idle/drivable proxy for this automation.
  if (!capabilitiesFor(s.agent).workQueue) {
    return skip(`${AGENT_IDENTITY[s.agent].label} sessions can't be followed up`);
  }
  if (s.state === "exited") return skip("the session exited");
  if (!s.hooksSeen) return skip("the session is not hook-instrumented");

  // 3. There has to be an OPEN pull request on this session's branch. A merged one is
  //    done; a closed-unmerged one is dropped like no PR at all (see `Session.prUrl`).
  if (s.prState !== "open" || !s.prUrl) return skip("no open pull request");

  // 4. Something needs a human. An unanswered question or an input wait means the agent
  //    is stopped ON that, not free to be handed the PR - triage owns it until it doesn't.
  if (bucket === "needs-you") return skip("the session needs a human");
  if (s.state === "awaiting_input") return skip("the session is waiting on input");

  // 5. THE OVERLAP RULE, the same shape prompted-wrapup states: a checkout with live work
  //    queue items belongs to the drain path. Gated on open ITEMS, via the card summary
  //    already on the session - a row exists for any session Foreman ever touched.
  if ((s.queue?.openCount ?? 0) > 0) {
    return skip("this checkout has a work queue - the drain trigger owns it");
  }

  // 6. A non-terminal workflow run owns its bound session and checkout. It may be
  //    reviewing, delivering repair guidance, waiting for the session to act, or driving
  //    PR/Inspector gates. A separate Foreman nudge must never type across that ownership.
  if (workflowOwnsSession) {
    return skip("an active workflow owns this session");
  }

  // 7. Is there anything to act on? Open posted findings, or a red CI. Nothing here is
  //    the overwhelmingly common state of an open PR and it is not a fault - say nothing.
  const fb = feedbackState(s, cfg);
  if (!fb.findings && !fb.ciFailing) return skip("no enabled review comments or failing CI");

  // 8. Only a settled-idle session with a delivery channel. The idle gate is what keeps
  //    this from interrupting an agent already working the fixes: once it acts on a nudge
  //    it is no longer idle, so it is not re-selected until it parks again.
  if (!settledIdle(s, now, cfg.settleMs)) return skip("still working");
  if (!hasPane(s)) return skip("no pane to type into");

  // 9. Typing is a live act, so it needs the same clearance a queue send does - live mode
  //    on an allowlisted repo. Dry-run means dry-run: no card to fall back to here, so it
  //    simply holds.
  if (!mayActLive) return skip("dry-run or off-allowlist - won't type");

  // Is anything here NEW since we last nudged? The two sources are judged on their own
  // clocks (see `FollowupMark`): findings by the Inspector round, CI by whether the
  // current failing episode has been relayed. `mark` has already had this pass's recovery
  // folded in by `advanceFollowupMark`, so a re-failure after a recovery reads as new.
  const prKey = prKeyOf(s);
  const cur: FollowupMark = mark && mark.prKey === prKey
    ? mark
    : { prKey, findingsRound: null, ciNudged: false };
  const round = s.inspector?.round ?? 0;
  const findingsNew = fb.findings && cur.findingsRound !== round;
  const ciNew = fb.ciFailing && !cur.ciNudged;
  if (!findingsNew && !ciNew) return skip("already nudged this round of feedback");

  // Stamp both currently-open dimensions as relayed. The payload covers everything open,
  // so once it lands the agent has heard about both - not only whichever one was new.
  const next: FollowupMark = {
    prKey,
    findingsRound: fb.findings ? round : cur.findingsRound,
    ciNudged: cur.ciNudged || fb.ciFailing,
  };
  return { kind: "nudge", mark: next, reason: describe(s, fb), payload: buildPayload(s, fb) };
}

function skip(why: string): ReviewFollowupDecision {
  return { kind: "skip", why };
}

/** One-line reason for the worker's log. */
function describe(s: Session, fb: Feedback): string {
  const open = s.inspector?.postedOpen ?? 0;
  if (fb.findings && fb.ciFailing) return `${open} review comment(s) + CI failing`;
  if (fb.findings) return `${open} review comment(s)`;
  return "CI failing";
}

/**
 * The instruction typed back at the session. Harness-neutral - it is plain text that
 * lands in whatever composer the session has - and it names the concrete PR so the agent
 * does not have to rediscover which one it is.
 *
 * The load-bearing line is "do not open a new pull request": a session told to fix its
 * work will, left to its own devices, sometimes branch and open a second PR, orphaning
 * the review threads on the first. Everything else is guidance the agent could infer, but
 * spelled out so a cheaper model on a fresh turn does the right thing.
 */
export function buildPayload(s: Session, fb: Feedback): string {
  const ref = s.prNumber !== null ? `PR #${s.prNumber}` : "your open pull request";
  const num = s.prNumber !== null ? ` ${s.prNumber}` : "";

  const problems: string[] = [];
  if (fb.findings) {
    const n = s.inspector?.postedOpen ?? 0;
    problems.push(`the Inspector left ${n} unresolved review comment${n === 1 ? "" : "s"} on it`);
  }
  if (fb.ciFailing) problems.push("its CI checks are failing");

  const steps: string[] = [];
  steps.push("Do NOT open a new pull request - push your fixes to this same branch.");
  if (fb.findings) {
    steps.push(
      `Read the Inspector's review comments (\`gh pr view${num} --comments\`, and the ` +
        `line threads under Files changed) and address every one.`,
    );
  }
  if (fb.ciFailing) {
    steps.push(
      `Look at the failing CI (\`gh pr checks${num}\`), reproduce it locally, and fix it.`,
    );
  }
  steps.push("Commit and push.");
  steps.push(
    "Then keep watching the PR until CI is green and the review threads are resolved - " +
      "the Inspector re-reviews each push automatically, so wait for it and answer anything new.",
  );

  return (
    `${ref} needs follow-through: ${problems.join(", and ")}.\n\n` +
    steps.map((step, i) => `${i + 1}. ${step}`).join("\n")
  );
}
