import type { PendingTurn } from "@shared/types.ts";

interface PendingTurnRecallResponse {
  ok: boolean;
  text?: string;
  error?: string;
  /** Present whenever the daemon returned an HTTP response, including a CAS refusal. */
  status?: number;
}

interface PendingTurnRecallClient {
  recallPendingTurn: (
    sessionId: string,
    turnId: string,
    revision: number,
  ) => Promise<PendingTurnRecallResponse>;
}

export interface PendingTurnDraftRecallResult extends PendingTurnRecallResponse {
  /** The daemon may have committed recall, but its acknowledgement did not arrive intact. */
  acknowledgementLost?: boolean;
}

export const RECALL_ACKNOWLEDGEMENT_LOST_MESSAGE =
  "Recall acknowledgement was lost. Your text is restored; confirm the queued copy disappears before sending.";

/**
 * Atomically pair the server's recall acknowledgement with restoring the local draft.
 *
 * The browser already holds the exact durable row it is asking to recall. If transport
 * drops before an HTTP response arrives, or a successful response loses its JSON body,
 * the server may already have committed the delete. Preserve that known text locally
 * instead of losing the only remaining copy. An explicit HTTP refusal is different:
 * especially for a 409 CAS conflict, the daemon positively said the row was not recalled,
 * so the caller must leave the composer alone.
 *
 * Both composer surfaces use this abstraction so acknowledgement loss cannot be handled
 * safely in one and destructively in the other.
 */
export async function recallPendingTurnIntoDraft(o: {
  client: PendingTurnRecallClient;
  sessionId: string;
  turn: PendingTurn;
  restore: (text: string) => void;
}): Promise<PendingTurnDraftRecallResult> {
  const result = await o.client.recallPendingTurn(o.sessionId, o.turn.id, o.turn.revision);
  if (result.ok && result.text !== undefined) {
    o.restore(result.text);
    return result;
  }
  if (result.status !== undefined && !result.ok) return result;

  // No HTTP response means the request may or may not have committed. A 2xx without
  // its body is equally ambiguous. In both cases the exact text from the selected row
  // is safer in the draft than silently disappearing with a committed server delete.
  o.restore(o.turn.text);
  return {
    ok: true,
    text: o.turn.text,
    status: result.status,
    acknowledgementLost: true,
  };
}

/** Arrow Up and Edit both target the last editable message, matching shell history. */
export function latestEditablePendingTurn(turns: readonly PendingTurn[]): PendingTurn | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.state === "queued") return turn;
  }
  return null;
}

export function shouldRecallPendingTurn(input: {
  key: string;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  composing: boolean;
  modified: boolean;
  busy: boolean;
  hasAttachments: boolean;
}): boolean {
  return (
    input.key === "ArrowUp" &&
    input.value.length === 0 &&
    (input.selectionStart ?? 0) === 0 &&
    (input.selectionEnd ?? 0) === 0 &&
    !input.composing &&
    !input.modified &&
    !input.busy &&
    !input.hasAttachments
  );
}

export function pendingTurnStatus(turn: PendingTurn): string {
  switch (turn.state) {
    case "queued":
      return "queued";
    case "sending":
      return "sending";
    case "uncertain":
      return "delivery uncertain";
  }
}
