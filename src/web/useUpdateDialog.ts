import { useCallback, useEffect, useState } from "react";
import {
  isUpdateDialogRequest,
  type UpdateDialogChoice,
  type UpdateDialogRequest,
} from "@shared/update-dialog.ts";

/**
 * The questions the auto-updater is asking right now, oldest first.
 *
 * A queue rather than one slot, for two reasons that are the same reason. Main re-offers
 * every unanswered question when the dashboard announces itself, so a reload delivers a
 * burst rather than one message; and the updater can legitimately have two in flight (the
 * outcome notice at launch, and a check the operator started from the menu bar while it was
 * up). Keying by id makes a re-offer idempotent instead of a duplicate.
 */
export function queueUpdateDialog(
  queue: readonly UpdateDialogRequest[],
  request: UpdateDialogRequest,
): UpdateDialogRequest[] {
  const existing = queue.findIndex((entry) => entry.id === request.id);
  if (existing < 0) return [...queue, request];
  const next = [...queue];
  next[existing] = request;
  return next;
}

interface DesktopUpdateDialogs {
  onDialog?(cb: (request: UpdateDialogRequest) => void): () => void;
  answerDialog?(id: string, choice: UpdateDialogChoice): void;
}

export interface UpdateDialogState {
  /** The question on screen, or null when the updater is not asking anything. */
  request: UpdateDialogRequest | null;
  answer(id: string, choice: UpdateDialogChoice): void;
}

export function useUpdateDialog(): UpdateDialogState {
  const [queue, setQueue] = useState<readonly UpdateDialogRequest[]>([]);
  // Optional on the declaration, so a preload that predates these members - which is what a
  // partly-applied desktop update looks like - leaves the dashboard rendering rather than
  // throwing out of a mount effect.
  const updates = window.missionDesktop?.updates as DesktopUpdateDialogs | undefined;

  useEffect(() => {
    const subscribe = updates?.onDialog;
    if (!subscribe) return;
    return subscribe((next) => {
      // The bridge is trusted, the payload is not: an older shell pushing a shape this
      // bundle cannot draw must be dropped, not rendered as a modal with no buttons that
      // nothing can dismiss.
      if (isUpdateDialogRequest(next)) setQueue((current) => queueUpdateDialog(current, next));
    });
  }, [updates]);

  const answer = useCallback(
    (id: string, choice: UpdateDialogChoice) => {
      updates?.answerDialog?.(id, choice);
      setQueue((current) => current.filter((entry) => entry.id !== id));
    },
    [updates],
  );

  return { request: queue[0] ?? null, answer };
}
