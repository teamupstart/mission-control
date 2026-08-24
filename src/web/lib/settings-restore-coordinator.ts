import type { SettingsRestoredEvent } from "@shared/settings-backups.ts";

interface PendingRestore {
  requestId: string;
  onCommitted: () => void;
}

const pending = new Map<string, PendingRestore>();

/** A first snapshot is a baseline; only a changed marker after a stream gap is invalidation. */
export function settingsRestoreMarkerChanged(
  marker: SettingsRestoredEvent | null,
  previousRequestId: string | null,
  hasPreviousSnapshot: boolean,
): marker is SettingsRestoredEvent {
  return hasPreviousSnapshot && marker !== null && marker.requestId !== previousRequestId;
}

/** Register before POST so a fast SSE event cannot be misidentified as another window's. */
export function beginSettingsRestore(requestId: string, onCommitted: () => void): void {
  pending.set(requestId, { requestId, onCommitted });
}

export function observeSettingsRestored(
  event: SettingsRestoredEvent,
): "initiating" | "external" {
  const restore = pending.get(event.requestId);
  if (!restore) return "external";
  pending.delete(event.requestId);
  const complete = restore.onCommitted;
  complete();
  return "initiating";
}

/** Resolve the HTTP leg. A transport failure keeps the request registered for a later event. */
export function finishSettingsRestore(requestId: string, committed: boolean): void {
  const restore = pending.get(requestId);
  if (!restore) return;
  pending.delete(requestId);
  if (!committed) {
    return;
  }
  const complete = restore.onCommitted;
  complete();
}

export function abandonSettingsRestore(requestId: string): void {
  pending.delete(requestId);
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
