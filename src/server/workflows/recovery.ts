import {
  WORKFLOW_LIMITS,
  manualWorkflowTriggerRequestId,
  workflowRunGaveUp,
  workflowRunIsOpen,
  type WorkflowBindingState,
  type WorkflowCompletionPolicy,
  type WorkflowInspectorGateState,
  type WorkflowNodeAttempt,
  type WorkflowRunRecovery,
  type WorkflowRunStatus,
  type WorkflowSubmission,
} from "@shared/workflow.ts";
import { workflowRunPhaseRecognized, type WorkflowRunPhase } from "@shared/workflow-lifecycle.ts";

type PhaseRecovery = "resume" | "decision" | "snapshot" | "repository" | "retry" | "dismiss";

/** A new daemon phase must deliberately choose its recovery policy to compile. */
export const WORKFLOW_PHASE_RECOVERY = {
  activating: "resume",
  binding_archived: "resume",
  capture_error: "resume",
  capture_interrupted: "resume",
  capturing: "resume",
  check_cleanup_unresolved: "resume",
  complete: "resume",
  conversation_changed: "resume",
  delivery_blocked: "decision",
  delivery_prepare_error: "resume",
  delivery_recovery_error: "resume",
  delivery_refused: "decision",
  delivery_uncertain: "decision",
  evidence_readiness: "resume",
  evidence_readiness_capture: "resume",
  external_artifact_mismatch: "resume",
  failed_outcome: "resume",
  image_evidence_capture: "resume",
  infrastructure_error: "retry",
  invalid_version: "resume",
  missing_workflow_version: "resume",
  persona_feedback: "resume",
  persona_review: "resume",
  pr_handoff: "resume",
  pr_handoff_prepare_error: "resume",
  preflight_refinement_exhausted: "resume",
  reattached_resubmit_required: "resume",
  round_limit: "dismiss",
  session_action: "resume",
  session_action_blocked: "resume",
  session_action_capture: "resume",
  session_action_parallel_unsupported: "resume",
  session_disappeared: "dismiss",
  stale_capture: "resume",
  unchanged_evidence: "snapshot",
  unchanged_evidence_exhausted: "snapshot",
  unchanged_repository: "repository",
  inspector_adapter_error: "resume",
  inspector_awaiting_fresh_observation: "resume",
  inspector_disabled: "decision",
  inspector_findings: "decision",
  inspector_gate_context_invalid: "resume",
  inspector_head_mismatch: "resume",
  inspector_missing_pr: "resume",
  inspector_pr_closed: "decision",
  inspector_pr_switch_refused: "resume",
  inspector_review: "resume",
  inspector_review_backoff: "resume",
  inspector_review_error: "resume",
  inspector_round_limit: "dismiss",
  inspector_unadopted_pr: "resume",
  inspector_working_tree_not_pushed: "resume",
  evidence_reconciliation_error: "resume",
} satisfies Record<WorkflowRunPhase, PhaseRecovery>;

export interface WorkflowRecoveryContext {
  status: WorkflowRunStatus;
  phase: string;
  bindingId: string;
  bindingState: WorkflowBindingState;
  sessionId: string | null;
  external: boolean;
  round: number;
  maxRepairRounds: number;
  latest: Pick<WorkflowSubmission, "mode" | "status" | "triggerSource" | "triggerKey"> | null;
  /** Latest attempt per node, from the latest submission only. */
  attempts: Pick<WorkflowNodeAttempt, "state">[];
  gate: WorkflowInspectorGateState | null;
  completionPolicy: WorkflowCompletionPolicy | null;
  bindingHasOtherRun: boolean;
}

export function inspectorRecoveryCanRecheck(run: Pick<WorkflowRecoveryContext, "status" | "phase">): boolean {
  if (!workflowRunPhaseRecognized(run.phase)) return false;
  return run.status === "waiting_for_pr"
    || run.status === "waiting_for_inspector"
    || run.status === "waiting_for_new_head"
    || (run.status === "waiting_for_session" && run.phase === "pr_handoff")
    || (run.status === "blocked" && run.phase === "inspector_disabled");
}

export function infrastructureRecoveryAvailable(
  run: Pick<WorkflowRecoveryContext, "status" | "phase">,
  submission: WorkflowRecoveryContext["latest"],
  hasFailedAttempt: boolean,
): boolean {
  return run.status === "blocked" && run.phase === "infrastructure_error"
    && submission?.status === "failed" && hasFailedAttempt;
}

export function projectWorkflowRecovery(c: WorkflowRecoveryContext): WorkflowRunRecovery {
  const phaseKnown = workflowRunPhaseRecognized(c.phase);
  const recovery: WorkflowRunRecovery = {
    operations: [], primary: null, triage: null, phaseKnown, resubmit: null, grantRounds: 0,
  };
  const active = c.bindingState === "active" && c.sessionId !== null;
  if (!workflowRunIsOpen(c.status)) {
    // Terminal phases include free-form cancellation reasons. Starting a separate run does
    // not resume that phase, but must not collide with a newer run on the binding.
    if (active && !c.external && !c.bindingHasOtherRun && c.completionPolicy) {
      recovery.operations.push("run-again");
      recovery.primary = "run-again";
    }
    return recovery;
  }
  recovery.operations.push("cancel");
  if (!phaseKnown || !c.completionPolicy) return recovery;
  const policy = WORKFLOW_PHASE_RECOVERY[c.phase as WorkflowRunPhase];
  const inspectorOnly = Boolean(c.gate && c.latest?.mode === "inspector_only");
  const withinBudget = c.round <= c.maxRepairRounds;
  if (c.gate && c.latest && withinBudget
    && (c.status === "waiting_for_new_head" || inspectorOnly)) {
    recovery.operations.push("restart-full");
    if (c.status === "waiting_for_new_head") recovery.triage = "restart-full";
  }
  if (c.gate && inspectorRecoveryCanRecheck(c)) {
    if (c.status === "waiting_for_pr" && active && c.latest
      && c.completionPolicy?.kind === "inspector"
      && ["offer_prepare_pr", "prepare_pr"].includes(c.completionPolicy.missingPrAction)
      && ["missing_pr", "unadopted_pr"].includes(c.gate.waitReason ?? "")) {
      recovery.operations.push("prepare-pr");
    }
    if (c.gate.waitReason !== null) recovery.operations.push("recheck-inspector");
    if (["waiting_for_pr", "waiting_for_inspector", "waiting_for_new_head"].includes(c.status)) {
      recovery.primary = recovery.operations.includes("prepare-pr") ? "prepare-pr"
        : recovery.operations.includes("recheck-inspector") ? "recheck-inspector" : null;
      return recovery;
    }
  }
  if (c.status !== "blocked" && c.status !== "waiting_for_session") return recovery;
  if (policy === "retry" && infrastructureRecoveryAvailable(c, c.latest, c.attempts.some((a) => a.state === "error"))) {
    recovery.operations.push("retry");
    recovery.primary = "retry";
    recovery.triage = "retry";
    return recovery;
  }
  if (workflowRunGaveUp(c) && c.latest && active && (inspectorOnly || !c.external)
    && c.maxRepairRounds < WORKFLOW_LIMITS.repairRoundsMax) {
    recovery.operations.push("grant-rounds");
    recovery.primary = "grant-rounds";
    recovery.grantRounds = Math.min(2, WORKFLOW_LIMITS.repairRoundsMax - c.maxRepairRounds);
  }
  if (c.status === "blocked" && policy === "dismiss") recovery.triage = "cancel";
  if (inspectorOnly) return recovery;
  const refusal = !active ? "The bound session is gone, so no further round can be prepared"
    : c.external ? "An externally sourced run cannot take a manual round"
    : !withinBudget ? "This run has used every repair round its binding allows"
    : !c.latest || !c.completionPolicy ? "The run's submission or immutable workflow version is unavailable"
    : null;
  recovery.resubmit = {
    resuming: c.status === "blocked", refusal,
    unchanged: policy === "repository" ? "repository" : policy === "snapshot" ? "snapshot" : null,
    requestId: c.status === "waiting_for_session" && c.phase === "unchanged_evidence"
      && c.latest?.status === "failed" && c.latest.triggerSource === "manual"
      ? manualWorkflowTriggerRequestId(c.bindingId, c.latest.triggerKey) : null,
  };
  if (recovery.primary || refusal || (c.status === "blocked" && policy === "decision")) return recovery;
  recovery.primary = recovery.resubmit.unchanged ? "resubmit-unchanged" : "resubmit";
  recovery.operations.push(recovery.primary);
  if (c.phase === "reattached_resubmit_required") recovery.triage = "resubmit";
  return recovery;
}
