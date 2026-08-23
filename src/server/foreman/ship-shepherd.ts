import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { settledIdle } from "@shared/session.ts";
import { shipRecoveryMarker } from "@shared/ship-recovery.ts";
import type {
  PromptedCompletionDecision,
  PromptedRecoveryReason,
  PromptedRecoveryState,
  Session,
  SessionQueue,
} from "@shared/types.ts";
import { hasPane } from "./queue-machine.ts";

/** Fixed safety policy approved for the pre-PR shepherd. */
export const SHIP_RECOVERY_ATTEMPT_LIMIT = 3;
export const SHIP_RECOVERY_LATER_DELAYS_MS = [40 * 60_000, 80 * 60_000] as const;

export interface ShipShepherdInput {
  session: Session;
  queue: SessionQueue | null;
  /** Full-fleet report/input ownership, already resolved by the caller. */
  humanOwnsSession: boolean;
  workflowOwnsSession: boolean;
  hasTaskOwnedOpenPr: boolean;
  /** A daemon/worker read of the current complete checkout diff. */
  diffHasChanges: boolean;
  /** Feature-level and global/repository authorization, kept separate for useful skips. */
  featureEnabled: boolean;
  mayActLive: boolean;
  recoveryMinutes: number;
  now: number;
}

export type ShipShepherdDecision =
  | { kind: "skip"; why: string }
  | {
      kind: "recover";
      reason: Exclude<PromptedRecoveryReason, "verification_failed">;
      generation: number;
      attempt: number;
      marker: string;
      payload: string | null;
      needsReview: boolean;
      decision: PromptedCompletionDecision | null;
    }
  | {
      kind: "escalate";
      reason: PromptedRecoveryReason;
      generation: number;
      attempt: 4;
      marker: string;
      summary: string;
      decision: PromptedCompletionDecision | null;
    };

interface RecoveryCause {
  reason: PromptedRecoveryReason;
  decision: PromptedCompletionDecision | null;
}

/** Server-time wait after a successfully claimed delivery attempt. */
export function nextShipRecoveryAt(attempt: number, now: number): number | null {
  if (attempt === 1) return now + SHIP_RECOVERY_LATER_DELAYS_MS[0];
  if (attempt === 2) return now + SHIP_RECOVERY_LATER_DELAYS_MS[1];
  // Attempt three exhausts the delivery budget. The next pass records attention without
  // another instruction; there is no hidden fourth wait or fourth send.
  if (attempt === 3) return now;
  return null;
}

/** Does the persisted current projection still describe this exact candidate? */
export function recoveryStateMatches(
  state: PromptedRecoveryState,
  input: {
    taskId: string;
    logicalKey: string;
    generation: number;
    reason: PromptedRecoveryReason;
    decision: PromptedCompletionDecision | null;
  },
): boolean {
  return state.taskId === input.taskId
    && state.logicalKey === input.logicalKey
    && state.generation === input.generation
    && state.reason === input.reason
    && state.decisionGeneration === (input.decision?.generation ?? null)
    && state.decisionOutcome === (input.decision?.outcome ?? null);
}

/**
 * Pure pre-PR shepherd policy. Gate order is policy: cheap authority and ownership
 * refusals precede quiet/diff reasoning, and every actionable branch names one owner.
 */
export function decideShipShepherd(input: ShipShepherdInput): ShipShepherdDecision {
  const { session: s, queue, now } = input;
  const task = s.task;
  if (!input.featureEnabled) return skip("pre-PR ship recovery is off");
  if (!task || task.kind !== "ship" || !["running", "dispatching"].includes(task.status)) {
    return skip("no running managed ship task is bound");
  }
  if (s.foremanInvite === null) return skip("Foreman is not invited into this session");
  if (!capabilitiesFor(s.agent).workQueue || s.state === "exited" || s.state === "stopping") {
    return skip("the session is not drivable");
  }
  if (!s.hooksSeen) return skip("the session is not hook-instrumented");
  if (!hasPane(s)) return skip("no delivery channel");
  if (input.humanOwnsSession || s.state === "awaiting_input" || s.state === "awaiting_review") {
    return skip("the session needs a human");
  }
  if ((queue?.items.length ?? 0) > 0 || s.pendingTurns.length > 0) {
    return skip("a queue item or pending turn owns the session");
  }
  if (input.workflowOwnsSession) return skip("an active workflow owns the session");
  if (input.hasTaskOwnedOpenPr) return skip("a task-owned pull request already exists");
  const cycle = s.workCycle;
  if (
    !cycle
    || cycle.logicalKey !== queue?.noteKey
    || cycle.generation < 1
    || cycle.active
    || cycle.completedAt === null
  ) {
    return skip("there is no exact settled work cycle");
  }
  if (!settledIdle(s, now, input.recoveryMinutes * 60_000)) return skip("the quiet window is not due");
  if (!input.mayActLive) return skip("Foreman is not live in a trusted repository");

  const cause = recoveryCause(queue, cycle.generation, input.diffHasChanges);
  if (!cause) return skip("prompted completion or another owner still owns this state");

  const current = queue.promptedRecovery;
  let attempt = 1;
  if (current && recoveryStateMatches(current, {
    taskId: task.id,
    logicalKey: queue.noteKey,
    generation: cycle.generation,
    reason: cause.reason,
    decision: cause.decision,
  })) {
    if (current.lastDelivery === "escalated") return skip("ship recovery is already escalated");
    if (current.nextEligibleAt !== null && now < current.nextEligibleAt) {
      return skip("the next recovery attempt is not due");
    }
    // A positive non-delivery retries the SAME identity. Every other outcome, including
    // unknown, is spent and advances. That is what prevents a lost response double-send.
    attempt = current.lastDelivery === "confirmed_undelivered"
      ? current.attempt
      : current.attempt + 1;
  }

  const marker = shipRecoveryMarker({
    taskId: task.id,
    logicalKey: queue.noteKey,
    generation: cycle.generation,
    reason: cause.reason,
    attempt,
  });
  if (cause.reason === "verification_failed") {
    return {
      kind: "escalate",
      reason: cause.reason,
      generation: cycle.generation,
      attempt: 4,
      marker: shipRecoveryMarker({
        taskId: task.id,
        logicalKey: queue.noteKey,
        generation: cycle.generation,
        reason: cause.reason,
        attempt: 4,
      }),
      summary: cause.decision?.summary || "Foreman's completion verifier failed repeatedly.",
      decision: cause.decision,
    };
  }
  if (attempt > SHIP_RECOVERY_ATTEMPT_LIMIT) {
    return {
      kind: "escalate",
      reason: cause.reason,
      generation: cycle.generation,
      attempt: 4,
      marker,
      summary: escalationSummary(cause),
      decision: cause.decision,
    };
  }

  return {
    kind: "recover",
    reason: cause.reason,
    generation: cycle.generation,
    attempt,
    marker,
    payload: structuralPayload(cause),
    needsReview: cause.reason === "idle_ambiguous",
    decision: cause.decision,
  };
}

function recoveryCause(
  queue: SessionQueue,
  generation: number,
  diffHasChanges: boolean,
): RecoveryCause | null {
  const decision = queue.promptedDecision;
  if (decision?.outcome === "verification_failed") return { reason: "verification_failed", decision };
  if (decision?.outcome === "held" && decision.generation === generation) {
    return { reason: "held_gaps", decision };
  }
  // A direct handoff's instruction creates the later settled cycle we are now looking at,
  // so its decision generation may be older. The current task/key/cycle and PR-absence
  // checks above are what keep it scoped to this handoff.
  if (decision?.outcome === "direct_handoff") {
    return { reason: "direct_handoff_missing_pr", decision };
  }
  if (decision) return null;
  // No decision is actionable only for a legacy generation already consumed. A fresh or
  // retryable completion belongs to ordinary prompted completion and must never be typed over.
  if (queue.promptedConsumedGeneration !== generation) return null;
  return { reason: diffHasChanges ? "idle_ambiguous" : "idle_empty", decision: null };
}

function structuralPayload(cause: RecoveryCause): string | null {
  switch (cause.reason) {
    case "held_gaps": {
      const gaps = cause.decision?.gaps ?? [];
      const detail = gaps.length > 0
        ? gaps.map((gap, i) => `${i + 1}. ${gap.path ? `${gap.path}: ` : ""}${gap.detail}`).join("\n")
        : cause.decision?.summary || "The completion review found unfinished implementation work.";
      return `Foreman's completion review found blocking work that still belongs in this implementation turn:\n\n${detail}\n\nAddress only these implementation, documentation, test, or evidence gaps. Do not commit, push, create a pull request, merge, or expand repository scope. When the requested work is verified, report completion and end the turn so Mission Control can re-run the normal handoff.`;
    }
    case "idle_empty":
      return "This invited ship task is still open, but its checkout has no changes and the session has been quiet. Re-read the durable task objective and begin or resume the requested implementation. Complete the required documentation, focused verification, and evidence registration, then report completion and end the turn. Do not commit, push, create a pull request, merge, delete work, or expand repository scope.";
    case "direct_handoff_missing_pr":
      return "Continue the task's existing Straight-to-PR handoff on this same branch. First check whether this task already has an open pull request in any attached repository; if one exists, do not create another. If none exists, finish the already-authorized commit, push, and pull-request creation for the task-owned changes only, then follow its CI on the same branch. Do not merge, delete work, create another task, or expand repository scope.";
    case "idle_ambiguous":
      return null;
    case "verification_failed":
      return null;
  }
}

function escalationSummary(cause: RecoveryCause): string {
  if (cause.decision?.summary) return cause.decision.summary;
  switch (cause.reason) {
    case "held_gaps": return "The implementation remained stalled after three targeted gap recoveries.";
    case "idle_empty": return "The task remained unchanged after three requests to resume implementation.";
    case "idle_ambiguous": return "The implementation remained stalled after three bounded recovery turns.";
    case "direct_handoff_missing_pr": return "No task-owned pull request appeared after three shipping continuations.";
    case "verification_failed": return "Foreman's completion verifier failed repeatedly.";
  }
}

function skip(why: string): ShipShepherdDecision {
  return { kind: "skip", why };
}
