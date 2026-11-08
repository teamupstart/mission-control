import type { Session } from "@shared/types.ts";

/**
 * Which session the review chord should open, and whether it has to move the selection to
 * get there.
 *
 * `refocus` is the whole reason this returns a shape rather than an id. Opening the review
 * queue for a session the operator is not looking at, and leaving the selection behind on
 * some other card, puts the modal and the highlighted card in disagreement about which
 * session is being talked about - so the jump case says so, and the caller focuses first.
 *
 * Pure, and in `lib/` rather than inline in the key handler, for the reason
 * `conversationReveal` documents: nothing in `test/` can dispatch a keydown into that
 * handler, so a decision left inside it is a decision with no test.
 */
export interface ReviewShortcutTarget {
  sessionId: string;
  /** The chord had to leave the selected card to find a queue. Focus it before opening. */
  refocus: boolean;
}

/**
 * Resolve the review chord against the sessions the grid is actually showing.
 *
 * The selected session wins whenever it has a queue of its own, so the chord means the
 * same thing as clicking the badge on the card you are looking at. Only when it has
 * nothing waiting does the chord travel, and then to the FIRST session in `visible` that
 * is asking - which is grid order, and a pending review tones a session `attention`, so
 * that is the top of the "needs you" group rather than an arbitrary session.
 *
 * Returns null when nothing anywhere is waiting. The caller must not `preventDefault` on
 * a null: an unclaimed chord belongs to the browser, and this one is a bare letter that
 * costs nothing to leave alone.
 */
export function reviewShortcutTarget(
  visible: readonly Pick<Session, "id" | "pendingReviews">[],
  selectedId: string | null,
): ReviewShortcutTarget | null {
  const selected = selectedId ? visible.find((s) => s.id === selectedId) : null;
  if (selected && selected.pendingReviews > 0) {
    return { sessionId: selected.id, refocus: false };
  }
  const asking = visible.find((s) => s.pendingReviews > 0);
  return asking ? { sessionId: asking.id, refocus: true } : null;
}

/**
 * What the review chord does, once the Residents drawer's Needs you group is counted too.
 *
 * - `fleet`: a fleet session's review queue, by `reviewShortcutTarget`'s rule. The fleet always
 *   comes first: the drawer sits to its right, and a fleet session asking is what the chord has
 *   always meant.
 * - `resident`: otherwise the first resident in the drawer's Needs you group, in the order it is
 *   drawn, passing over the one whose conversation is already open while another is asking. One
 *   asking through a review opens that review queue (`opens: "review"`). One that needs you any
 *   other way - parked on a menu, or waiting on a reply - has no queue to open, so the chord opens
 *   its conversation instead (`opens: "conversation"`), where every kind of ask can be answered.
 *   Either way the group's `e` keycap never names a resident the key would leave alone.
 *
 * `drawerAsking` is every resident in the group, including one that is also a row in the Needs
 * you rail because a conversation is open; empty while the drawer is not on screen. A resident
 * there with a review is already found by the fleet step, so the drawer step only ever adds the
 * residents asking without one. `openDetailId` is the session whose conversation is open.
 */
export type ReviewChordTarget =
  | ({ kind: "fleet" } & ReviewShortcutTarget)
  | { kind: "resident"; sessionId: string; opens: "review" | "conversation" };

export function reviewChordTarget(
  visible: readonly Pick<Session, "id" | "pendingReviews">[],
  selectedId: string | null,
  drawerAsking: readonly Pick<Session, "id" | "pendingReviews">[],
  openDetailId: string | null = null,
): ReviewChordTarget | null {
  const fleet = reviewShortcutTarget(visible, selectedId);
  if (fleet) return { kind: "fleet", ...fleet };
  const resident = drawerAsking.find((session) => session.id !== openDetailId) ?? drawerAsking[0];
  if (!resident) return null;
  return { kind: "resident", sessionId: resident.id, opens: resident.pendingReviews > 0 ? "review" : "conversation" };
}
