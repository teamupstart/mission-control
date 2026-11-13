import { useSyncExternalStore } from "react";

/**
 * Which Residents drawer cards the operator has compressed, by session id.
 *
 * The drawer's answer to the Board's repository fold (`lib/repo-collapse.ts`): every card starts
 * open, a click on its title compresses it to the name, the live status line and the controls,
 * and another click opens it again. Each card folds on its own, so several can be open at once.
 *
 * A MODULE STORE rather than the drawer's own state, because the drawer is not one mount: it
 * unmounts every time it closes and every time the page leaves Fleet. A fold kept in `useState`
 * would spring open again on each of those.
 *
 * UN-PERSISTED, for the same reason the repository fold is: it is "let me see more residents at
 * once", not a setting, and nothing should survive a reload.
 */

let collapsed: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ReadonlySet<string> {
  return collapsed;
}

function publish(next: ReadonlySet<string>): void {
  collapsed = next;
  for (const listener of listeners) listener();
}

/** Compress an open card, or open a compressed one. */
export function toggleResidentCardCollapsed(sessionId: string): void {
  const next = new Set(collapsed);
  if (!next.delete(sessionId)) next.add(sessionId);
  publish(next);
}

/** The compressed set, for the drawer that draws the cards. */
export function useResidentCardsCollapsed(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
