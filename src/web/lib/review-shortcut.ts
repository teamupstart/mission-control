import type { Session } from "@shared/types.ts";
import { hasOpenAsks, stoppedAsking, type QuestionAgent } from "./async-questions.ts";

/**
 * What the chord reads about a session. `openQuestions` and the state fields only matter for a
 * message-mode question (`async-input`), so a caller that predates them may leave them out and
 * reads as a session with none.
 */
export type ChordSession = Pick<Session, "id" | "pendingReviews">
  & Partial<Pick<Session, "openQuestions" | "state" | "stateConfirmed" | "task">>
  & { residentPaused?: boolean };

function filled(session: ChordSession): Pick<Session, "pendingReviews" | "openQuestions"> & QuestionAgent {
  return {
    pendingReviews: session.pendingReviews,
    openQuestions: session.openQuestions ?? 0,
    state: session.state ?? "idle",
    stateConfirmed: session.stateConfirmed ?? false,
    task: session.task ?? null,
    // A resident its operator paused has stopped on its questions (`questionAgentStatus`); the
    // caller marks it with `asQuestionAgent`.
    residentPaused: session.residentPaused === true,
  };
}

const asksNow = (session: ChordSession): boolean => stoppedAsking(filled(session));
const asksAtAll = (session: ChordSession): boolean => hasOpenAsks(filled(session));

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
 * A session whose agent is still working past its message-mode questions (`async-input`) is
 * reached too, but only after every session that has stopped: its questions are open, and the
 * agent is not waiting on them yet.
 *
 * Returns null when nothing anywhere is waiting. The caller must not `preventDefault` on
 * a null: an unclaimed chord belongs to the browser, and this one is a bare letter that
 * costs nothing to leave alone.
 */
export function reviewShortcutTarget(
  visible: readonly ChordSession[],
  selectedId: string | null,
): ReviewShortcutTarget | null {
  const selected = selectedId ? visible.find((s) => s.id === selectedId) : null;
  if (selected && asksAtAll(selected)) {
    return { sessionId: selected.id, refocus: false };
  }
  const asking = visible.find(asksNow) ?? visible.find(asksAtAll);
  return asking ? { sessionId: asking.id, refocus: true } : null;
}

/**
 * What the review chord does, once the Residents drawer's Needs you group is counted too.
 *
 * - `fleet`: a fleet session's review queue, by `reviewShortcutTarget`'s rule, over `visible`
 *   less every resident in the drawer's group, except that a fleet session still working past its
 *   message-mode questions waits until every stopped resident has been reached. The fleet always comes first: the drawer sits to
 *   its right, and a fleet session asking is what the chord has always meant. A resident in the
 *   group is the drawer step's even while it is also a rail row, and even while it is the
 *   selected session, so its review never jumps ahead of a fleet session's.
 * - `resident`: otherwise the first resident in the drawer's Needs you group, in the order it is
 *   drawn. One asking through a review opens that review queue (`opens: "review"`). One that needs
 *   you any other way - parked on a menu, or waiting on a reply - has no queue to open, so the
 *   chord opens its conversation instead (`opens: "conversation"`), where every kind of ask can be
 *   answered. The resident whose conversation is already open is passed over while another is
 *   asking, unless it has a review, since opening its queue is still something to do. Either way
 *   the group's `e` keycap never names a resident the key would leave alone.
 *
 * `drawerAsking` is every resident in the group, including one that is also a row in the Needs
 * you rail because a conversation is open; empty while the drawer is not on screen, when the
 * fleet step sees every row in `visible` as it always has. `openDetailId` is the session whose
 * conversation is open.
 */
export type ReviewChordTarget =
  | ({ kind: "fleet" } & ReviewShortcutTarget)
  | { kind: "resident"; sessionId: string; opens: "review" | "conversation" };

export function reviewChordTarget(
  visible: readonly ChordSession[],
  selectedId: string | null,
  drawerAsking: readonly ChordSession[],
  openDetailId: string | null = null,
): ReviewChordTarget | null {
  const inGroup = new Set(drawerAsking.map((session) => session.id));
  const fleetRows = inGroup.size > 0 ? visible.filter((session) => !inGroup.has(session.id)) : visible;
  const selected = selectedId ? fleetRows.find((session) => session.id === selectedId) : null;
  if (selected && asksAtAll(selected)) return { kind: "fleet", sessionId: selected.id, refocus: false };
  // Every session that has stopped comes before any still working past its message-mode questions
  // (`async-input`), the drawer's included: the stopped fleet sessions, then the stopped residents,
  // then the working fleet sessions, then the residents listed for their open questions alone.
  // With no message-mode question anywhere the last two steps find nothing new, so the order is
  // exactly what it was.
  const fleetNow = fleetRows.find(asksNow);
  if (fleetNow) return { kind: "fleet", sessionId: fleetNow.id, refocus: true };
  // No fallback here: a stopped resident whose conversation is already open, with nothing to open
  // a queue on, must not keep the chord from reaching a working fleet session's questions (step 4).
  // It is still reached by the last step when nothing else is asking.
  const residentNow = firstResident(
    drawerAsking.filter((session) => asksNow(session) || !asksAtAll(session)),
    openDetailId,
    false,
  );
  if (residentNow) return residentNow;
  const fleetLater = fleetRows.find(asksAtAll);
  if (fleetLater) return { kind: "fleet", sessionId: fleetLater.id, refocus: true };
  return firstResident(drawerAsking, openDetailId);
}

function firstResident(
  asking: readonly ChordSession[],
  openDetailId: string | null,
  fallBackToOpenDetail = true,
): ReviewChordTarget | null {
  const resident = asking.find((session) => session.id !== openDetailId || asksAtAll(session))
    ?? (fallBackToOpenDetail ? asking[0] : undefined);
  if (!resident) return null;
  return { kind: "resident", sessionId: resident.id, opens: asksAtAll(resident) ? "review" : "conversation" };
}
