import type { SessionBlocker } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { workflowRunIsOpen, workflowRunResumesItself, sessionActionWaitsOnOperator, workflowResumptionWithheldSentence } from "@shared/workflow.ts";
import { blockedPhaseClause } from "@shared/workflow-lifecycle.ts";
import { actionWaitSentence, gateWaitSentence } from "../workflows/run-model.ts";

export interface WorkflowHold {
  actor: "Operator" | "Session" | "Workflow" | "GitHub Inspector" | "Owning workflow" | "Blocker owner";
  actorLabel?: string;
  reason: string;
  inProgress: boolean;
  runId: string;
}

/** Display projection only. Never writes a blocker or participates in resumption. */
export function workflowHold(run: WorkflowRunSummary, blocker?: Pick<SessionBlocker, "waitingOn"> | null): WorkflowHold | null {
  if (!workflowRunIsOpen(run.status)) return null;
  const describe = (actor: WorkflowHold["actor"], reason: string, inProgress = false,
    runId = run.id): WorkflowHold => ({ actor, reason, inProgress, runId });
  if (run.deliveryHold) {
    const owner = run.deliveryHold.repoRoot?.split(/[\\/]/).filter(Boolean).at(-1);
    return describe("Owning workflow", `Queued behind ${owner ?? "another workflow"}; waiting for it to release the conversation.`, true, run.deliveryHold.runId);
  }
  if (run.status === "blocked") return describe("Operator", blockedPhaseClause(run.phase));
  if (run.status === "waiting_for_session") {
    if (!workflowRunResumesItself(run)) {
      return describe("Operator", run.deliveryMode === "preview"
        ? "Review feedback is ready in preview; start the next round."
        : "Review is waiting for you to start the next round.");
    }
    if (run.resumption) {
      const reason = workflowResumptionWithheldSentence(run.resumption.reason, run.resumption.round ?? run.round);
      if (reason) {
        if (run.resumption.reason === "session_blocked") {
          return { ...describe("Blocker owner", reason), ...(blocker?.waitingOn ? { actorLabel: blocker.waitingOn } : {}) };
        }
        const actor = run.resumption.reason === "session_needs_you" || run.resumption.reason === "session_unavailable"
          ? "Operator" : run.resumption.reason === "packet_undelivered" ? "Workflow" : "Session";
        return describe(actor, reason, ["session_busy", "packet_undelivered"].includes(run.resumption.reason));
      }
    }
    if (["unchanged_repository", "unchanged_evidence", "reattached_resubmit_required"].includes(run.phase)) {
      return describe("Operator", `${blockedPhaseClause(run.phase)}; review the run before continuing.`);
    }
    return describe("Session", "Repairing review feedback; the workflow resumes after the session settles.", true);
  }
  if (run.status === "waiting_for_action") {
    return describe(run.actionWait && sessionActionWaitsOnOperator(run.actionWait) ? "Operator" : "Session",
      run.actionWait ? actionWaitSentence(run.actionWait) : "Session action in progress.",
      !run.actionWait || !sessionActionWaitsOnOperator(run.actionWait));
  }
  if (run.gateWaitReason) {
    const operator = ["missing_pr", "unadopted_pr", "inspector_disabled", "pr_closed"].includes(run.gateWaitReason);
    const session = ["working_tree_not_pushed", "head_mismatch", "findings"].includes(run.gateWaitReason);
    return describe(operator ? "Operator" : session ? "Session" : "GitHub Inspector",
      gateWaitSentence(run.gateWaitReason), !operator);
  }
  switch (run.status) {
    case "capturing": return describe("Workflow", "Capturing review evidence.", true);
    case "running": return describe("Workflow", run.activePersonaNames.length
      ? `Review in progress: ${run.activePersonaNames.join(", ")}.` : "Reviewers and checks in progress.", true);
    case "waiting_for_pr": return describe("Operator", "A pull request is needed to continue review.");
    case "waiting_for_inspector": return describe("GitHub Inspector", "Review of the pushed head is in progress.", true);
    case "waiting_for_new_head": return describe("Session", "Waiting for a repaired head to be pushed.", true);
    case "waiting_for_evidence_readiness": return describe("Workflow", "Evidence preflight in progress with the session.", true);
  }
  return null;
}
