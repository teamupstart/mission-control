import type { PendingTurn } from "@shared/types.ts";
import { activePaneDialog, type DialogBearing } from "@shared/session.ts";

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

/**
 * What is stopping this queued row from reaching the agent, or null when nothing is.
 *
 * Not a presentation flourish - it is the daemon's own precondition read back. `canDrain`
 * in `src/server/pending-turns.ts` refuses to deliver while a dialog covers the session,
 * and refuses again unless the session is `idle`. A row caught by either is not on its way,
 * and every queued row used to be drawn identically in working-blue whichever was true.
 *
 * Takes the SESSION rather than a boolean, so this and the gate read one fact through one
 * helper. `dialogOpen` as a parameter is what let the display and the rule drift: the gate
 * read `session.paneDialog` and the caller passed `activePaneDialog(...) !== null`, which
 * differ exactly on `exited` and `stopping`.
 *
 * `shutdown` is tested FIRST and is not merely the dialog case in disguise. A dying session
 * holds every queued row whether or not a menu is up, and it is the answer that stays true:
 * `activePaneDialog` reports nothing for those two states, so a dialog raised just before a
 * kill is neither rendered nor answerable, and naming it as the blocker would point the
 * operator at a card that is not on screen and cannot be acted on.
 *
 * Scoped to `queued` deliberately. A `sending` row has already been claimed and crossed the
 * boundary these gates guard, and an `uncertain` one has its own louder story to tell.
 */
export function pendingTurnHold(turn: PendingTurn, session: DialogBearing): PendingTurnHold {
  if (turn.state !== "queued") return null;
  if (session.state === "exited" || session.state === "stopping") return "shutdown";
  return activePaneDialog(session) === null ? null : "review";
}

/** Why a queued row is not moving, or null when it is on its way. */
export type PendingTurnHold = "review" | "shutdown" | null;

/** The sentence each hold carries, in both composer surfaces. */
export const PENDING_TURN_HELD_REASON: Record<NonNullable<PendingTurnHold>, string> = {
  review: "Held until you answer the review above",
  shutdown: "Held - this session is ending and will not receive it",
};

/** The status a held row reports, replacing the bare "queued" it would otherwise show. */
export const PENDING_TURN_HELD_STATUS = "queued · held";
