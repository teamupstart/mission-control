/** Persisted vocabulary: append, never rename or reorder. */
export const SESSION_TRANSFER_STATES = [
  "prepared", "stopping", "launching", "awaiting_successor", "adopted", "aborted", "failed", "recovery_required",
] as const;
export type SessionTransferState = typeof SESSION_TRANSFER_STATES[number];
export const SESSION_TRANSFER_SNAPSHOT_LIMIT = 100;

/** Unknown future states keep their reservation and are shown as recovery required. */
export function sessionTransferUnresolved(state: string): boolean {
  return !["adopted", "aborted", "failed"].includes(state);
}

/** Sanitized projection. Private lease paths and process records never cross the wire. */
export interface SessionTransferSummary {
  id: string;
  revision: number;
  sourceSessionId: string;
  sourceName: string;
  taskId: string | null;
  successorSessionId: string | null;
  state: SessionTransferState;
  reason: string;
  createdAt: number;
  updatedAt: number;
  canEnd: boolean;
}

export interface SessionTransferPage {
  transfers: SessionTransferSummary[];
  overflow: number;
}
