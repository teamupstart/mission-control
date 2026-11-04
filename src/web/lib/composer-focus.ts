import { useEffect, useRef } from "react";

/**
 * "Put the cursor in this session's message box", asked from outside the session's view.
 *
 * The asker is a review answered with "Chat about it": the question moved to the
 * conversation, so the next thing the operator does is type in it. But the review is answered
 * in a modal or the attention inbox, which own no composer, and the session's detail view may
 * not even be mounted yet - selecting the session is what mounts it. So a request is parked
 * here by session id and taken by whichever detail view shows that session, now or once it
 * mounts.
 *
 * A request expires quickly. It answers one click; a detail view that mounts minutes later
 * for some unrelated reason must not steal focus on that click's behalf.
 */

const TTL_MS = 3_000;

const pending = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export function requestComposerFocus(sessionId: string, now: number = Date.now()): void {
  pending.set(sessionId, now + TTL_MS);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

/**
 * Take the parked request for `sessionId`, if one is still live. Taking clears it, so one
 * request focuses one view once.
 */
export function takeComposerFocus(sessionId: string, now: number = Date.now()): boolean {
  const expires = pending.get(sessionId);
  if (expires === undefined) return false;
  pending.delete(sessionId);
  return expires > now;
}

export function subscribeComposerFocus(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(sessionId) === set) listeners.delete(sessionId);
  };
}

/**
 * Focus this view's message box whenever a request for its session arrives, including one
 * parked before it mounted. `focus` reports whether it found a box to focus.
 */
export function useComposerFocusRequest(sessionId: string, focus: () => boolean): void {
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    const take = () => {
      if (!takeComposerFocus(sessionId)) return;
      // A frame later, so the modal or inbox that asked has finished unmounting and nothing
      // it owned is left to take focus back.
      requestAnimationFrame(() => focusRef.current());
    };
    take();
    return subscribeComposerFocus(sessionId, take);
  }, [sessionId]);
}
