import type { SettingsRestoredEvent } from "@shared/settings-backups.ts";

interface PendingRestore {
  requestId: string;
  onCommitted: () => void;
}

let pending: PendingRestore | null = null;

/** Register before POST so a fast SSE event cannot be misidentified as another window's. */
export function beginSettingsRestore(requestId: string, onCommitted: () => void): void {
  pending = { requestId, onCommitted };
}

export function observeSettingsRestored(
  event: SettingsRestoredEvent,
): "initiating" | "external" {
  if (pending?.requestId !== event.requestId) return "external";
  const complete = pending.onCommitted;
  pending = null;
  complete();
  return "initiating";
}

/** Resolve the HTTP leg. A transport failure keeps the request registered for a later event. */
export function finishSettingsRestore(requestId: string, committed: boolean): void {
  if (pending?.requestId !== requestId) return;
  if (!committed) {
    pending = null;
    return;
  }
  const complete = pending.onCommitted;
  pending = null;
  complete();
}

export function abandonSettingsRestore(requestId: string): void {
  if (pending?.requestId === requestId) pending = null;
}

/** Rebuild the first-paint cache before taking the initiating window through startup again. */
export async function reloadAfterSettingsRestore(
  hydrate: () => Promise<void>,
  reload: () => void,
): Promise<void> {
  try {
    await hydrate();
  } finally {
    reload();
  }
}
