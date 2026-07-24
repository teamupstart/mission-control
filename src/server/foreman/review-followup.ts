import type { Session } from "@shared/types.ts";
import type { ReportBucket } from "@shared/session.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { hasPane, settledIdle } from "./queue-machine.ts";

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
  /** `ForemanConfig.trackReviewFeedback`. Nothing happens unless this is on. */
  enabled: boolean;
  /** How long a session must sit idle before its work counts as settled. */
  settleMs: number;
}

export interface ReviewFollowupInput {
  session: Session;
  /** The session's bucket, computed cross-session (a parked gate needs the other sessions). */
  bucket: ReportBucket;
  /** Whether Foreman is cleared to type here (live + allowlisted) - the same gate a send passes. */
  mayActLive: boolean;
  /**
   * The signature this session was last nudged for, from the worker's in-memory map, or
   * null if it never has been. The once-per-feedback guard: a nudge fires only when the
   * CURRENT signature differs from this, so a new round of Inspector feedback (or a CI
   * flip) re-arms it and an unchanged PR stays quiet.
   */
  lastSig: string | null;
  cfg: ReviewFollowupConfig;
  now: number;
}

export type ReviewFollowupDecision =
  /** Not a candidate. `why` is for the tests/log - every skip is explicable. */
  | { kind: "skip"; why: string }
  /** Type the follow-up. Carries the signature to stamp and the exact payload to inject. */
  | { kind: "nudge"; sig: string; reason: string; payload: string };

/** What is actionable on this session's PR right now. */
interface Feedback {
  /**
   * The Inspector has open findings that are actually POSTED on the PR. Gated on
   * `mode === "live"`: in dry-run its findings are drafted previews that never reach
   * GitHub, so telling the agent to "address the review comments" would point it at
   * comments that do not exist.
   */
  findings: boolean;
  /** The PR's CI rollup is failing (as opposed to pending or passing). */
  ciFailing: boolean;
}

function feedbackState(s: Session): Feedback {
  const findings = !!s.inspector && s.inspector.mode === "live" && s.inspector.open > 0;
  return { findings, ciFailing: s.prChecks === "failing" };
}

/**
 * The once-per-feedback key. Built from the Inspector's completed-round count and which
 * kinds of feedback are open, NOT from the PR head sha - deliberately.
 *
 * A head sha changes the instant the agent pushes its fix, BEFORE the Inspector has
 * re-reviewed the new head, so keying on it would re-nudge a session that just pushed and
 * is correctly waiting. The round count moves only when the Inspector actually completes
 * a review, which is exactly the cadence a fresh nudge should follow: once per round that
 * still leaves something open. A push that fails CI also earns a new Inspector round (the
 * Inspector reviews every new head), so the CI half rides the same clock.
 */
export function reviewFollowupSignature(s: Session, fb: Feedback): string {
  const key = s.inspector?.prKey ?? (s.prNumber !== null ? `#${s.prNumber}` : "pr");
  const round = s.inspector?.round ?? 0;
  return `${key}:r${round}:${fb.findings ? "F" : "-"}${fb.ciFailing ? "C" : "-"}`;
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
  const { session: s, bucket, mayActLive, lastSig, cfg, now } = input;

  // 1. The trigger is off. First because it is the cheapest and because an off trigger
  //    must reach no branch that decides to type.
  if (!cfg.enabled) return skip("review follow-through is off");

  // 2. Only a harness Foreman can actually drive, and only a live one. No `workQueue`
  //    capability means no hooks and no reliable state to read; an exited session has
  //    nothing left to type into.
  if (!capabilitiesFor(s.agent).workQueue) {
    return skip(`${AGENT_IDENTITY[s.agent].label} sessions can't be followed up`);
  }
  if (s.state === "exited") return skip("the session exited");

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

  // 6. A no-mistakes run is still driving this branch (it opens the PR and then waits on
  //    CI and the merge itself). Relaying feedback now would fight the pipeline that is
  //    already handling it; wait for it to finish and park.
  if (s.nomistakes?.status === "running") return skip("a no-mistakes run is in progress");

  // 7. Is there anything to act on? Open posted findings, or a red CI. Nothing here is
  //    the overwhelmingly common state of an open PR and it is not a fault - say nothing.
  const fb = feedbackState(s);
  if (!fb.findings && !fb.ciFailing) return skip("no open review comments or failing CI");

  // 8. Only a settled-idle session, and only one with a pane. The idle gate is what keeps
  //    this from interrupting an agent already working the fixes: once it acts on a nudge
  //    it is no longer idle, so it is not re-selected until it parks again.
  if (!settledIdle(s, now, cfg.settleMs)) return skip("still working");
  if (!hasPane(s)) return skip("no pane to type into");

  // 9. Typing is a live act, so it needs the same clearance a queue send does - live mode
  //    on an allowlisted repo. Dry-run means dry-run: no card to fall back to here, so it
  //    simply holds.
  if (!mayActLive) return skip("dry-run or off-allowlist - won't type");

  // 10. THE ONCE-PER-FEEDBACK GUARD. We have already nudged this exact feedback state and
  //     nothing the Inspector or CI produced has changed since. Re-typing would nag a PR
  //     that is being handled; the next Inspector round (or CI flip) re-arms it.
  const sig = reviewFollowupSignature(s, fb);
  if (lastSig === sig) return skip("already nudged this round of feedback");

  return { kind: "nudge", sig, reason: describe(s, fb), payload: buildPayload(s, fb) };
}

function skip(why: string): ReviewFollowupDecision {
  return { kind: "skip", why };
}

/** One-line reason for the worker's log. */
function describe(s: Session, fb: Feedback): string {
  const open = s.inspector?.open ?? 0;
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
    const n = s.inspector?.open ?? 0;
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
