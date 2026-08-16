import { createHash } from "node:crypto";
import { WorkflowCompletionClaimResultSchema } from "@shared/protocol.ts";
import type { WorkflowCompletionClaim, WorkflowCompletionClaimResult } from "@shared/workflow.ts";
import type { SessionIntentGuard, SessionQueue } from "@shared/types.ts";

export interface WorkflowClaimActions {
  claimWorkflowCompletion(
    sessionId: string,
    claim: WorkflowCompletionClaim,
  ): Promise<WorkflowCompletionClaimResult>;
}

export type WorkflowClaimAttempt =
  | { kind: "claimed"; result: Extract<WorkflowCompletionClaimResult, { claimed: true }> }
  | { kind: "unclaimed"; result: Extract<WorkflowCompletionClaimResult, { claimed: false }> }
  | { kind: "failed"; error: string };

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function drainCompletionClaim(
  queue: SessionQueue,
  headSha: string | null,
  transcriptAnchor: number | null,
  expectedIntent: SessionIntentGuard | null = null,
): WorkflowCompletionClaim {
  const proof = {
    noteKey: queue.noteKey,
    generation: queue.updatedAt,
    items: queue.items.map((item) => ({ id: item.id, round: item.round, state: item.state })),
    headSha,
    transcriptAnchor,
  };
  return {
    completionKind: "drain",
    marker: sha256(proof),
    activityAt: null,
    summary: `Foreman queue drained after ${queue.items.length} terminal item${queue.items.length === 1 ? "" : "s"}.`,
    evidenceFingerprint: sha256({ headSha, transcriptAnchor, items: proof.items }),
    expectedIntent,
  };
}

export function promptedCompletionClaim(input: {
  noteKey: string;
  intent: SessionIntentGuard;
  headSha: string | null;
  transcriptAnchor: number | null;
  activityAt: number;
  summary: string;
}): WorkflowCompletionClaim {
  return {
    completionKind: "prompted",
    marker: promptedCompletionMarker(input),
    activityAt: input.activityAt,
    summary: input.summary,
    evidenceFingerprint: sha256({
      headSha: input.headSha,
      transcriptAnchor: input.transcriptAnchor,
      summary: input.summary,
    }),
    expectedIntent: input.intent,
  };
}

/**
 * Durable identity of one prompted completion boundary.
 *
 * Kept separate from `promptedCompletionClaim` so an incomplete verifier result can
 * retire the same evidence without pretending it was a workflow claim. A background
 * task notification leaves the human intent alone; its later work advances HEAD or the
 * transcript anchor, which is what makes the next settled Stop a different boundary.
 */
export function promptedCompletionMarker(input: {
  noteKey: string;
  intent: SessionIntentGuard;
  headSha: string | null;
  transcriptAnchor: number | null;
}): string {
  return sha256({
    noteKey: input.noteKey,
    intent: input.intent,
    headSha: input.headSha,
    transcriptAnchor: input.transcriptAnchor,
  });
}

/** Non-throwing seam: a failed HTTP call is distinct from an explicit unclaimed answer. */
export async function tryWorkflowCompletionClaim(
  actions: WorkflowClaimActions,
  sessionId: string,
  claim: WorkflowCompletionClaim,
): Promise<WorkflowClaimAttempt> {
  try {
    const result = WorkflowCompletionClaimResultSchema.parse(
      await actions.claimWorkflowCompletion(sessionId, claim),
    );
    return result.claimed
      ? { kind: "claimed", result }
      : { kind: "unclaimed", result };
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
