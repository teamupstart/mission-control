import { createHash } from "node:crypto";
import type { WorkflowHumanDecision, WorkflowRunIntentSnapshot } from "@shared/workflow.ts";

/**
 * One review's intent identity, in the one place that knows how to compute it.
 *
 * Split out of `context.ts` so the STORE can derive a snapshot's fingerprint on the way in
 * without importing capture's registry, harness, and provider machinery. That mattered as soon
 * as the fingerprint stopped being something a caller supplies: a derived value has to be
 * derivable at the boundary that owns the invariant, and this module is small enough to be
 * imported anywhere without dragging a subsystem behind it.
 */
interface WorkflowIntentBearing {
  primaryGoal: { rawPrompt: string; refined: string | null };
  humanDecisions: readonly WorkflowHumanDecision[];
}

/**
 * The intent fields themselves, deduplicated and ordered.
 *
 * Exported because compaction sends exactly these to the model. The prompt and the identity
 * being one projection is the point: criteria are distilled from precisely the bytes the
 * fingerprint covers, so two submissions with the same fingerprint were compacted from the
 * same input.
 */
export function workflowIntentFields(raw: WorkflowIntentBearing): object {
  const decisions: Array<{ decision: string; rationale: string | null }> = [];
  const seen = new Set<string>();
  for (const item of raw.humanDecisions) {
    const decision = { decision: item.decision, rationale: item.rationale };
    const key = JSON.stringify(decision);
    if (seen.has(key)) continue;
    seen.add(key);
    decisions.push(decision);
  }
  return {
    rawGoal: raw.primaryGoal.rawPrompt,
    refinedGoal: raw.primaryGoal.refined,
    decisions,
  };
}

/** Stable intent identity. Repository state, evidence, coverage, and Persona feedback are excluded. */
export function workflowIntentFingerprint(raw: WorkflowIntentBearing): string {
  return createHash("sha256")
    .update(JSON.stringify(workflowIntentFields(raw)))
    .digest("hex");
}

/**
 * The intent fields a run is created from, WITHOUT the identity derived from them.
 *
 * The fingerprint is not an input. A caller that could supply one could supply a wrong one,
 * and nothing downstream would know: the criteria-provenance check compares a run's criteria
 * against this fingerprint, so an unverified value there quietly weakens the check that is
 * supposed to catch criteria distilled from another ask.
 */
export type WorkflowRunIntentInput = Omit<WorkflowRunIntentSnapshot, "fingerprint">;

/** The same identity over the fields of a run snapshot, derived rather than trusted. */
export function workflowRunIntentFingerprint(
  intent: Pick<WorkflowRunIntentSnapshot, "rawGoal" | "refinedGoal" | "decisions">,
): string {
  return workflowIntentFingerprint({
    primaryGoal: { rawPrompt: intent.rawGoal, refined: intent.refinedGoal },
    humanDecisions: intent.decisions,
  });
}

/** Complete an intent input by deriving its identity. The one place a snapshot is minted. */
export function freezeWorkflowRunIntent(
  intent: WorkflowRunIntentInput,
): WorkflowRunIntentSnapshot {
  return { ...intent, fingerprint: workflowRunIntentFingerprint(intent) };
}
