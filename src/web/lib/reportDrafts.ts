import { useCallback, useSyncExternalStore } from "react";

/**
 * What the operator is typing on each report card, by report chain (`rootId`).
 *
 * Kept by chain so an agent replacing its report (a new id with the same `rootId`) leaves the
 * words in the new card's box. Kept outside React state on purpose: a keystroke notifies only
 * the card that reads that chain, rather than re-rendering App and, with it, every open
 * conversation (whose transcript merge is the expensive part). One store per window.
 */
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Listen for any draft changing. Exported for the hook and its test. */
export function subscribeReportDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The draft for a chain, or "" when there is none. */
export function reportDraft(rootId: string): string {
  return drafts.get(rootId) ?? "";
}

/** Set a chain's draft. An empty one is removed. */
export function setReportDraft(rootId: string, text: string): void {
  if (reportDraft(rootId) === text) return;
  if (text) drafts.set(rootId, text);
  else drafts.delete(rootId);
  notify();
}

/** An accepted send clears its own words. Dictation or another edit can leave a different draft. */
export function clearReportDraft(rootId: string, sentText?: string): void {
  if (sentText === undefined || reportDraft(rootId) === sentText) setReportDraft(rootId, "");
}

/** A card's draft and its setter, re-rendering only that card when it changes. */
export function useReportDraft(rootId: string): [string, (text: string) => void] {
  const draft = useSyncExternalStore(subscribeReportDrafts, () => reportDraft(rootId), () => reportDraft(rootId));
  const set = useCallback((text: string) => setReportDraft(rootId, text), [rootId]);
  return [draft, set];
}
