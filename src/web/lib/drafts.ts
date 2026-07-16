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
 * Forget every box on one session, because that session is gone for good.
 *
 * Without some collection the map is a slow leak in a tab left open for days, and
 * worse, a draft could outlive its session and be re-hydrated into a reused id.
 *
 * Collection must be driven by a positive "this one is gone" signal, and
 * `session_remove` is that signal: Registry emits it only from its eviction timer,
 * after a COMPLETED sweep confirmed the session missing. It names exactly one id and
 * cannot mean anything else.
 *
 * Do not replace this with a prune that diffs the map against the list of live
 * sessions. That infers "gone" from ABSENCE, and the client's session list is
 * authoritative only at snapshot time. A sweep emits one upsert per session and each
 * arrives as its own EventSource task, so a fleet rebuilding after a daemon restart
 * renders as a list of 1, then 2, then 3 - and every draft not yet re-added looks
 * departed. Guarding on "the list is non-empty" only moves the wipe from a list of 0
 * to a list of 1. Absence is not evidence here, and deleting nothing is the safe
 * failure: these are short, tab-scoped strings, so leaking one costs far less than
 * destroying typing the user still wanted.
 */
export function dropSessionDrafts(sessionId: string): void {
  for (const k of [...drafts.keys()]) {
    if (k.slice(0, k.lastIndexOf(":")) === sessionId) drafts.delete(k);
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
