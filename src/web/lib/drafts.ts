import { useCallback, useState } from "react";

/**
 * Half-written compose text, parked outside the React tree and keyed by session.
 *
 * A card's queue and reply panels are mounted only while it is expanded, and only ONE
 * card expands at a time - so opening any other card unmounts the one you were typing
 * in and took the text with it. Nothing was wrong with the state; the component
 * holding it simply stopped existing. A card dropping out of the nav filter did the
 * same thing, and so did a `composing` send box on Escape.
 *
 * That is the whole bug, and it is why this is a module-level map rather than state
 * anywhere in the tree: the text has to outlive every mount that can end under it,
 * and each of those mounts is exactly what the old state was tied to.
 *
 * It is deliberately NOT a store with subscribers - nothing renders from it. Inputs
 * hydrate from it on mount and write through on change, which is also what keeps
 * DispatchLayer's bargain: a keystroke must never re-render the session grid (dozens
 * of cards, each with an ActionBar) to save itself. Uncontrolled boxes stay
 * uncontrolled, and a write here costs a Map set.
 *
 * Its scope is honestly the tab - a reload starts over, the same deal `wrapupSent`
 * makes. What it buys is that no click on the dashboard can lose your typing.
 */

/** Which box on a card the text was typed into. */
export type DraftKind =
  /** The work queue's "queue more work" add box. */
  | "queue"
  /** The expanded card's transcript reply box. */
  | "reply"
  /** The collapsed card's ActionBar send box. */
  | "send";

const drafts = new Map<string, string>();

const keyOf = (sessionId: string, kind: DraftKind): string => `${sessionId}:${kind}`;

/** The text left in this box, or "" when there is none. */
export function readDraft(sessionId: string, kind: DraftKind): string {
  return drafts.get(keyOf(sessionId, kind)) ?? "";
}

/**
 * Remember what's in this box. Emptying it forgets the draft rather than storing "":
 * a cleared box and a box never typed in are the same state, and only one of them
 * should survive to be re-hydrated.
 */
export function writeDraft(sessionId: string, kind: DraftKind, text: string): void {
  if (text) drafts.set(keyOf(sessionId, kind), text);
  else drafts.delete(keyOf(sessionId, kind));
}

/**
 * Forget this draft - it has been delivered.
 *
 * Only a send calls this. Closing, collapsing, filtering and Escape deliberately do
 * not: "it should persist unless manually deleted" is the rule, and none of those is
 * a human deleting anything.
 */
export function clearDraft(sessionId: string, kind: DraftKind): void {
  drafts.delete(keyOf(sessionId, kind));
}

/**
 * Drop drafts belonging to sessions that no longer exist.
 *
 * Without this the map is a slow leak in a tab left open for days, and worse, a draft
 * could outlive its session and be re-hydrated into a reused id.
 *
 * This is a dumb primitive and the caller owns the guard: it prunes against whatever
 * it is handed, so handed an empty list it cheerfully deletes every draft on the page.
 * Callers must only pass a list they KNOW is complete, which means a snapshot having
 * arrived is NOT enough - an empty session list is indistinguishable from a daemon that
 * simply hasn't swept yet, so App additionally refuses to prune against one.
 */
export function pruneDrafts(liveSessionIds: Iterable<string>): void {
  const live = new Set(liveSessionIds);
  for (const k of [...drafts.keys()]) {
    if (!live.has(k.slice(0, k.lastIndexOf(":")))) drafts.delete(k);
  }
}

/** Test seam: forget everything. Never called by the app. */
export function resetDrafts(): void {
  drafts.clear();
}

/**
 * A controlled input's value, backed by the draft map instead of by this mount.
 *
 * For boxes that already re-render as you type (the work queue's, which drives a
 * disabled Add button off the text). An uncontrolled box wants `readDraft` +
 * `writeDraft` directly instead, so it keeps costing nothing to type in.
 *
 * The session id is fixed for the life of a mount - cards are keyed by it - so
 * reading the map once, on mount, is the whole hydration story.
 */
export function useSessionDraft(
  sessionId: string,
  kind: DraftKind,
): [string, (next: string) => void] {
  const [value, setValue] = useState(() => readDraft(sessionId, kind));
  const set = useCallback(
    (next: string) => {
      writeDraft(sessionId, kind, next);
      setValue(next);
    },
    [sessionId, kind],
  );
  return [value, set];
}
