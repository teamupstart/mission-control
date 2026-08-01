import type { PendingTurn } from "@shared/types.ts";

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
