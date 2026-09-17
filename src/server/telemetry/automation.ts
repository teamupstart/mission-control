import type { EnsembleRunDetail } from "@shared/ensemble.ts";
import type { PipelineRun, PipelineCommission } from "@shared/pipeline.ts";
import { pipelineRunKey } from "@shared/pipeline.ts";
import type { ScheduleOccurrence } from "@shared/schedules.ts";
import { recordAutomationTransition, settlePendingAction, type ActionOutcome } from "./experience.ts";
import { getTelemetryConfig } from "./config.ts";
const automationActor = { kind: "system", origin: "daemon", basis: "owner" } as const;
/** Only normalized operational enum values reach the event. No strategy-specific branches. */
export function automationOutcome(status: string | null): ActionOutcome | "running" | "waiting" | "unknown" {
  switch (status) {
    case "completed": case "verified": case "succeeded": case "submitted": case "advanced": case "retained": case "created": case "coalesced": case "done": case "sent": return "applied";
    case "failed": case "error": return "failed";
    case "cancelled": case "withdrawn": case "eliminated": return "cancelled";
    case "skipped_overlap": case "skipped_policy": case "refused": case "conflict": return "refused";
    case "pending": case "eligible": case "queued": case "claimed": case "planning": return "pending";
    case "running": case "sending": case "verifying": case "in_progress": case "building": case "binding": case "launching": case "active": case "evaluating": case "finalizing": case "reviewing": return "running";
    case "waiting": case "proposed": case "awaiting_pickup": case "escalated": case "parked": case "awaiting_decision": case "halted": return "waiting";
    default: return "unknown";
  }
}
export function observeScheduleOccurrence(occurrence: ScheduleOccurrence | null): void {
  if (!occurrence) return;
  recordAutomationTransition(occurrence.id, { feature: "schedules", action: "occurrence", outcome: automationOutcome(occurrence.status), coverage: "owner_transition" },
    { kind: "scheduler", origin: "daemon", basis: "owner" });
}
export function observeEnsemble(read: () => EnsembleRunDetail | null): void {
  let detail: EnsembleRunDetail | null;
  try { if (!getTelemetryConfig().enabled) return; detail = read(); }
  catch { return; } // Observation must never prevent publication of the business state.
  if (!detail) return;
  recordAutomationTransition(detail.run.id, { feature: "ensembles", action: "run", outcome: automationOutcome(detail.run.status), coverage: "owner_transition" }, automationActor);
  for (const member of detail.members) recordAutomationTransition(member.id,
    { feature: "ensembles", action: "member", outcome: automationOutcome(member.status), coverage: "owner_transition" }, automationActor);
  for (const stage of detail.stageAttempts) recordAutomationTransition(stage.id,
    { feature: "ensembles", action: "stage", outcome: automationOutcome(stage.status), coverage: "owner_transition" }, automationActor);
  if (detail.run.workflowHandoff) recordAutomationTransition(detail.run.id,
    { feature: "ensembles", action: "handoff", outcome: automationOutcome(detail.run.workflowHandoff.state), coverage: "owner_transition" }, automationActor);
}
export function observePipeline(run: PipelineRun): void {
  const id = pipelineRunKey(run.provider, run.repoRoot, run.slug);
  const actor = { kind: "unknown", origin: "external_observation", basis: "unknown" } as const;
  recordAutomationTransition(id, { feature: "pipelines", action: "run", outcome: automationOutcome(run.group), coverage: "external_observation" }, actor);
  // Unknown provider step names are usable identities, never dimensions or fingerprints.
  for (const step of run.steps) recordAutomationTransition(`${id}:${step.name}`,
    { feature: "pipelines", action: "stage", outcome: automationOutcome(step.state), coverage: "external_observation" }, actor);
}

export function observePipelineCommission(commission: PipelineCommission): void {
  const attempt = commission.attempts.find((a) => a.attempt === commission.activeAttempt);
  if (!attempt) return;
  const outcome = attempt.state === "reserved" ? "pending" : attempt.state === "failed" ? "failed"
    : attempt.state === "cancelled" ? "cancelled" : "applied";
  settlePendingAction(`${commission.id}:${attempt.attempt}`, outcome);
  recordAutomationTransition(`${commission.id}:${attempt.attempt}`, { feature: "pipelines", action: "run",
    outcome: attempt.state === "authoring" ? "running" : attempt.state === "awaiting_spec_merge" ? "waiting" : outcome,
    coverage: "external_observation" }, { kind: "unknown", origin: "external_observation", basis: "unknown" });
}
