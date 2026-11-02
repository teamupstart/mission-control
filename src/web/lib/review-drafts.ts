import { useCallback, useSyncExternalStore } from "react";
import type { ServerEvent } from "@shared/types.ts";

/**
 * Half-answered reviews, parked outside the React tree and keyed by review id.
 *
 * A review card holds the operator's answer while they write it - the free-text answer, the
 * note to the agent, the options picked and the "Other" and per-decision notes beside them,
 * and the standing-approval checkbox. All of it used to be `useState` in the card, so the
 * card unmounting took it away: the review modal closing (Escape, a click outside, or the
 * session's review list blinking empty while the event stream reconnects), the attention
 * inbox folding, or the dashboard reloading under the operator. Dispatch already survives a
 * close because its draft lives in a layer that stays mounted; a review is answered on three
 * surfaces (the modal, the attention inbox, an Ensemble member), so its draft lives here,
 * where every one of them reads the same text back.
 *
 * Mirrored into `sessionStorage` as well, so a reload of the tab - the case `drafts.ts`
 * deliberately leaves alone - brings the answer back too. That store is per tab and dies
 * with it, which is the right lifetime: a pending review is a question an agent is blocked
 * on now, not something to resurrect in a window opened next week.
 *
 * Unlike `drafts.ts`, cards render FROM this map rather than hydrating a copy of it. One
 * review can be on screen twice at once - in the modal and in the attention inbox behind it -
 * and two private copies would drift: an edit in one would leave the other stale, and the
 * stale card's next keystroke would write its old picture back over the first. So the map is
 * the one live value, every card subscribes to its own review's entry, and every change is
 * applied to whatever is stored now. Subscriptions are per review, so typing re-renders only
 * the cards showing that review.
 */

/** One decision's answer: chosen option ids, any free-text "Other", and any note. */
export type DecisionAnswer = { selected: string[]; other: string; note: string };
export type DecisionAnswers = Record<string, DecisionAnswer>;

/** Everything a review card lets the operator enter before resolving it. */
export interface ReviewDraft {
  /** The open-ended `input` review's answer box. */
  answer: string;
  /** The diff/plan review's optional note to the agent. */
  note: string;
  /** The decision form's selections, keyed by decision id. */
  decisions: DecisionAnswers;
  /** The final-bundle form's "approve all future bundles" checkbox. */
  approveFuture: boolean;
}

export const EMPTY_REVIEW_DRAFT: ReviewDraft = Object.freeze({
  answer: "",
  note: "",
  decisions: Object.freeze({}) as DecisionAnswers,
  approveFuture: false,
}) as ReviewDraft;

const STORAGE_KEY = "mission.reviewDrafts";

const drafts = new Map<string, ReviewDraft>(loadStored());
const listeners = new Map<string, Set<() => void>>();

function notify(reviewId: string): void {
  for (const listener of listeners.get(reviewId) ?? []) listener();
}

function notifyAll(): void {
  for (const id of listeners.keys()) notify(id);
}

/** Hear every change to one review's draft. Returns the unsubscribe. */
export function subscribeReviewDraft(reviewId: string, listener: () => void): () => void {
  let set = listeners.get(reviewId);
  if (!set) listeners.set(reviewId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(reviewId) === set) listeners.delete(reviewId);
  };
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // A sandboxed frame throws on the property read itself.
    return null;
  }
}

function loadStored(): [string, ReviewDraft][] {
  const raw = (() => {
    try {
      return storage()?.getItem(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const out: [string, ReviewDraft][] = [];
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const draft = normalize(value);
      if (draft) out.push([id, draft]);
    }
    return out;
  } catch {
    return [];
  }
}

/** A stored value read back through the shape, so a stale or hand-edited entry cannot crash a card. */
function normalize(value: unknown): ReviewDraft | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const decisions: DecisionAnswers = {};
  if (v.decisions && typeof v.decisions === "object") {
    for (const [id, a] of Object.entries(v.decisions as Record<string, unknown>)) {
      if (!a || typeof a !== "object") continue;
      const d = a as Record<string, unknown>;
      decisions[id] = {
        selected: Array.isArray(d.selected) ? d.selected.filter((x): x is string => typeof x === "string") : [],
        other: typeof d.other === "string" ? d.other : "",
        note: typeof d.note === "string" ? d.note : "",
      };
    }
  }
  const draft: ReviewDraft = {
    answer: typeof v.answer === "string" ? v.answer : "",
    note: typeof v.note === "string" ? v.note : "",
    decisions,
    approveFuture: v.approveFuture === true,
  };
  return isEmpty(draft) ? null : draft;
}

function isEmpty(draft: ReviewDraft): boolean {
  return (
    !draft.answer
    && !draft.note
    && !draft.approveFuture
    && Object.values(draft.decisions).every((a) => a.selected.length === 0 && !a.other && !a.note)
  );
}

function persist(): void {
  try {
    const store = storage();
    if (!store) return;
    if (drafts.size === 0) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // Quota or a locked-down store: the in-memory copy still covers a close and reopen.
  }
}

/** What was entered on this review, or the empty draft when nothing was. */
export function readReviewDraft(reviewId: string): ReviewDraft {
  return drafts.get(reviewId) ?? EMPTY_REVIEW_DRAFT;
}

/**
 * Remember what's on this review. A draft emptied back to nothing is forgotten rather than
 * stored, for `writeDraft`'s reason: a cleared form and an untouched one are the same state.
 */
export function writeReviewDraft(reviewId: string, draft: ReviewDraft): void {
  if (isEmpty(draft)) drafts.delete(reviewId);
  else drafts.set(reviewId, draft);
  persist();
  notify(reviewId);
}

/**
 * Apply a change to whatever this review's draft holds NOW, not to a caller's copy of it, so
 * an edit made on another card showing the same review is built on rather than overwritten.
 */
export function updateReviewDraft(
  reviewId: string,
  change: (prev: ReviewDraft) => ReviewDraft,
): void {
  writeReviewDraft(reviewId, change(readReviewDraft(reviewId)));
}

/**
 * Forget this review's draft - it was resolved, here or anywhere else.
 *
 * Driven by a positive signal only: a resolve this tab sent, or the daemon reporting the
 * review as no longer pending or removed. Never by a review being ABSENT from a list, for
 * `dropSessionDrafts`'s reason - a list rebuilding after a reconnect is briefly missing
 * reviews that are still waiting on the answer being typed.
 */
export function clearReviewDraft(reviewId: string): void {
  if (!drafts.delete(reviewId)) return;
  persist();
  notify(reviewId);
}

/**
 * Forget the drafts a server event says have nothing left to come back to: a review the
 * daemon now reports as answered, approved, rejected or dismissed - by Foreman, another tab,
 * or a standing approval - or one it removed outright. The event stream calls this for every
 * event, so the rule lives beside the store it protects rather than spread across its cases.
 */
export function settleReviewDrafts(msg: ServerEvent): void {
  switch (msg.type) {
    case "snapshot":
      for (const r of msg.reviews) if (r.status !== "pending") clearReviewDraft(r.id);
      break;
    case "review_upsert":
      if (msg.review.status !== "pending") clearReviewDraft(msg.review.id);
      break;
    case "review_remove":
      clearReviewDraft(msg.id);
      break;
    default:
      break;
  }
}

/** Test seam: forget everything, in memory and in storage. Never called by the app. */
export function resetReviewDrafts(): void {
  drafts.clear();
  persist();
  notifyAll();
}

/** Test seam: re-read storage as a freshly loaded page would. Never called by the app. */
export function reloadReviewDraftsFromStorage(): void {
  drafts.clear();
  for (const [id, draft] of loadStored()) drafts.set(id, draft);
  notifyAll();
}

/**
 * A review card's draft, live: the stored value for this review, re-read whenever any card
 * showing the same review changes it. `update` goes through `updateReviewDraft`, so it always
 * builds on the latest stored draft and two fields changed in one tick cannot overwrite each
 * other.
 */
export function useReviewDraft(
  reviewId: string,
): [ReviewDraft, (change: (prev: ReviewDraft) => ReviewDraft) => void] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeReviewDraft(reviewId, listener),
    [reviewId],
  );
  const read = useCallback(() => readReviewDraft(reviewId), [reviewId]);
  const draft = useSyncExternalStore(subscribe, read, read);
  const update = useCallback(
    (change: (prev: ReviewDraft) => ReviewDraft) => updateReviewDraft(reviewId, change),
    [reviewId],
  );
  return [draft, update];
}
