import { sha1Hex } from "./session.ts";
import type { PromptedRecoveryReason } from "./types.ts";

/** Deterministic idempotency key shared by the worker, daemon and persisted reader. */
export function shipRecoveryMarker(input: {
  taskId: string;
  logicalKey: string;
  generation: number;
  reason: PromptedRecoveryReason;
  attempt: number;
}): string {
  return `ship-recovery:${sha1Hex(JSON.stringify([
    input.taskId,
    input.logicalKey,
    input.generation,
    input.reason,
    input.attempt,
  ]))}`;
}
