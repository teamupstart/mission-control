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
  /** The session detail's transcript reply box. */
  | "reply"
  /** The ActionBar send box, which opens on a collapsed OR an session detail. */
  | "send";

const drafts = new Map<string, string>();

const keyOf = (sessionId: string, kind: DraftKind): string => `${sessionId}:${kind}`;

/**
 * Every change to a draft, from any box, as a stamp off one clock that only moves forward.
 *
 * Two boxes share the `reply` draft - the Conversation's and the Residents drawer's - and a
 * send that finishes late must not clear text the person wrote in the meantime, in either of
 * them, even when it repeats the words that were sent. Comparing text cannot see that; this
 * can. One global clock rather than a counter per key, so a forgotten key can never come
 * back at a stamp a pending send still holds.
 */
const revisions = new Map<string, number>();
let clock = 0;
const touch = (key: string): void => {
  clock += 1;
  revisions.set(key, clock);
};

/** This draft's last-change stamp; unchanged between two reads means nobody wrote to it. */
export function draftRevision(sessionId: string, kind: DraftKind): number {
  return revisions.get(keyOf(sessionId, kind)) ?? 0;
}

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
  touch(keyOf(sessionId, kind));
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
  touch(keyOf(sessionId, kind));
  drafts.delete(keyOf(sessionId, kind));
}

/**
 * Forget this session's unsent message text - the send box and the transcript reply -
 * because it was just reset.
 *
 * A reset discards the task those messages were about (the branch is wiped and the
 * agent's context cleared), so text still parked for it is stale - the same reason the
 * reset clears the work queue. Deliberately leaves the "queue" add-box draft: that box
 * composes NEW work to queue, not a reply to the task that was thrown away.
 *
 * Distinct from `clearDraft`, which a send calls for one delivered box, and from
 * `dropSessionDrafts`, which wipes ALL of a departed session's boxes.
 */
export function dropMessageDrafts(sessionId: string): void {
  clearDraft(sessionId, "send");
  clearDraft(sessionId, "reply");
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
  // Its stamps go too. The clock does not rewind, so no later stamp can repeat one of these.
  for (const k of [...revisions.keys()]) {
    if (k.slice(0, k.lastIndexOf(":")) === sessionId) revisions.delete(k);
  }
}

/** Test seam: forget everything. Never called by the app. */
export function resetDrafts(): void {
  drafts.clear();
  revisions.clear();
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
