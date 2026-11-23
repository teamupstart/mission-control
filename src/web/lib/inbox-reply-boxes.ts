import { createContext } from "react";

/**
 * The sessions whose Stuck row in the attention inbox is drawing a message box (or an
 * escalation's reply box) right now (`inbox` flag).
 *
 * The same `onReplyBox` contract the transcript's reply box reports through: a session has one
 * compose box at a time and a reply box wins, so the session's `ActionBar` closes its own send
 * composer while one of these is open. Provided once by App; the session detail reads it.
 */
export const InboxReplyBoxesContext = createContext<ReadonlySet<string>>(new Set());

/**
 * `boxes` with this session's Stuck-row reply box recorded as present or gone. Returns the
 * same set when nothing changed, so a row re-reporting what it already said does not render.
 */
export function withInboxReplyBox(boxes: ReadonlySet<string>, sessionId: string, present: boolean): ReadonlySet<string> {
  if (boxes.has(sessionId) === present) return boxes;
  const next = new Set(boxes);
  if (present) next.add(sessionId);
  else next.delete(sessionId);
  return next;
}
