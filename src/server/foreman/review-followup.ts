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
  marker: ReviewFollowupMarker | null;
  cfg: ReviewFollowupConfig;
  now: number;
}

export interface ReviewFollowupMarker {
  findingsRound: number | null;
  ciFailing: boolean;
}

export interface ReviewFollowupSignal {
  findingsRound: number | null;
  ciFailing: boolean;
}

export type ReviewFollowupDecision =
  /** Not a candidate. `why` is for the tests/log - every skip is explicable. */
  | { kind: "skip"; why: string; marker?: ReviewFollowupMarker }
  /** Type the follow-up. Carries the marker to stamp and the exact payload to inject. */
  | {
      kind: "nudge";
      signal: ReviewFollowupSignal;
      marker: ReviewFollowupMarker;
      reason: string;
      payload: string;
    };

/** What is actionable on this session's PR right now. */
interface Feedback {
  /** The Inspector has open findings that are actually posted on the PR. */
  findings: boolean;
  /** The PR's CI rollup is failing (as opposed to pending or passing). */
  ciFailing: boolean;
}

function feedbackState(s: Session): Feedback {
  const findings = !!s.inspector && s.inspector.postedOpen > 0;
  return { findings, ciFailing: s.prChecks === "failing" };
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
  const { session: s, bucket, mayActLive, marker: lastMarker, cfg, now } = input;
  const previous = lastMarker ?? { findingsRound: null, ciFailing: false };
  const marker = {
    ...previous,
    ciFailing: s.prChecks === "failing" ? previous.ciFailing : false,
  };
  const markerChanged =
    marker.findingsRound !== previous.findingsRound || marker.ciFailing !== previous.ciFailing;
  const hold = (why: string): ReviewFollowupDecision =>
    markerChanged ? { kind: "skip", why, marker } : { kind: "skip", why };

  // 1. The trigger is off. First because it is the cheapest and because an off trigger
  //    must reach no branch that decides to type.
  if (!cfg.enabled) return hold("review follow-through is off");

  // 2. Only a harness Foreman can actually drive, and only a live one. No `workQueue`
  //    capability means no hooks and no reliable state to read; an exited session has
  //    nothing left to type into.
  // `workQueue` is the reliable-idle/drivable proxy for this automation.
  if (!capabilitiesFor(s.agent).workQueue) {
    return hold(`${AGENT_IDENTITY[s.agent].label} sessions can't be followed up`);
  }
  if (s.state === "exited") return hold("the session exited");

  // 3. There has to be an OPEN pull request on this session's branch. A merged one is
  //    done; a closed-unmerged one is dropped like no PR at all (see `Session.prUrl`).
  if (s.prState !== "open" || !s.prUrl) return hold("no open pull request");

  // 4. Something needs a human. An unanswered question or an input wait means the agent
  //    is stopped ON that, not free to be handed the PR - triage owns it until it doesn't.
  if (bucket === "needs-you") return hold("the session needs a human");
  if (s.state === "awaiting_input") return hold("the session is waiting on input");

  // 5. THE OVERLAP RULE, the same shape prompted-wrapup states: a checkout with live work
  //    queue items belongs to the drain path. Gated on open ITEMS, via the card summary
  //    already on the session - a row exists for any session Foreman ever touched.
  if ((s.queue?.openCount ?? 0) > 0) {
    return hold("this checkout has a work queue - the drain trigger owns it");
  }

  // 6. A no-mistakes run is still driving this branch (it opens the PR and then waits on
  //    CI and the merge itself). Relaying feedback now would fight the pipeline that is
  //    already handling it; wait for it to finish and park.
  if (s.nomistakes?.status === "running") return hold("a no-mistakes run is in progress");

  // 7. Is there anything to act on? Open posted findings, or a red CI. Nothing here is
  //    the overwhelmingly common state of an open PR and it is not a fault - say nothing.
  const fb = feedbackState(s);
  if (!fb.findings && !fb.ciFailing) return hold("no open review comments or failing CI");

  // 8. Only a settled-idle session, and only one with a pane. The idle gate is what keeps
  //    this from interrupting an agent already working the fixes: once it acts on a nudge
  //    it is no longer idle, so it is not re-selected until it parks again.
  if (!settledIdle(s, now, cfg.settleMs)) return hold("still working");
  if (!hasPane(s)) return hold("no pane to type into");

  // 9. Typing is a live act, so it needs the same clearance a queue send does - live mode
  //    on an allowlisted repo. Dry-run means dry-run: no card to fall back to here, so it
  //    simply holds.
  if (!mayActLive) return hold("dry-run or off-allowlist - won't type");

  const findingsRound =
    fb.findings && s.inspector!.round !== marker.findingsRound ? s.inspector!.round : null;
  const ciFailing = fb.ciFailing && !marker.ciFailing;
  if (findingsRound === null && !ciFailing) {
    return hold("already nudged this round of feedback");
  }

  const signal = { findingsRound, ciFailing };
  const actionable = { findings: findingsRound !== null, ciFailing };
  return {
    kind: "nudge",
    signal,
    marker: {
      findingsRound: findingsRound ?? marker.findingsRound,
      ciFailing: ciFailing || marker.ciFailing,
    },
    reason: describe(s, actionable),
    payload: buildPayload(s, actionable),
  };
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
