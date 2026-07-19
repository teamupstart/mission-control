import { foremanAllowlisted } from "@shared/foreman.ts";
import type { NoteDisposition, Session } from "@shared/types.ts";
import type { ResolveEpisode, SetNote } from "@shared/protocol.ts";

// Why Foreman isn't sending for a session - the one rule behind every "why is this
// still asking me?" the dashboard has to answer. Pure, and out of the components,
// for the reason `lib/queue.ts` and `lib/alerts.ts` are: it's a rule about what is
// true, and rules get tested without a DOM.
//
// Shared by the work-queue panel AND the session note because they ask the SAME
// question about the same session, and the bug that created this module was them
// disagreeing: the queue explained an off-allowlist draft while the note rendered
// the identical draft with an Approve button and no reason at all.

/**
 * The reason Foreman will draft rather than send for a session, or null when it's
 * cleared to send (so the surface owes no explanation).
 *
 * Ordered by what actually stops a send FIRST. Foreman being off short-circuits the
 * worker's entire loop before it reads anything, so it outranks whatever the mode and
 * the allowlist would say: "it will draft and wait for your Approve" describes a draft
 * that is never coming, and work sitting untouched under that sentence reads as a bug
 * rather than a switch the human hasn't flipped. Queueing first and enabling after is
 * a perfectly natural order of work - the UI just has to be honest about which one
 * you're in.
 *
 * `no-cwd` is a separate answer from `not-allowlisted` rather than folded into it:
 * `foremanMayActLive` returns false on a null cwd, so the OUTCOME is the same, but the
 * allowlist sentence names the repo to add and here there isn't one. The case is
 * reachable - a session whose cwd discovery failed while its hooks report is otherwise
 * fully working - and it used to fall through every branch to silence, which is the
 * exact failure these hints exist to prevent.
 */
export type ForemanSendBlock = "foreman-off" | "not-allowlisted" | "no-cwd" | "drafts-only" | null;

export function foremanSendBlock(o: {
  enabled: boolean;
  mode: string;
  allowlisted: boolean;
  cwd: string | null;
}): ForemanSendBlock {
  if (!o.enabled) return "foreman-off";
  if (o.mode !== "live") return "drafts-only";
  if (!o.cwd) return "no-cwd";
  if (!o.allowlisted) return "not-allowlisted";
  return null; // live, enabled, allowlisted: it sends, so there's nothing to explain
}

/**
 * `foremanSendBlock` for a whole session, deciding `allowlisted` with the SAME
 * predicate the server gates on rather than a copy that could drift.
 */
export function sessionSendBlock(
  session: Session,
  o: { enabled: boolean; mode: string; allowlist: readonly string[] | undefined },
): ForemanSendBlock {
  return foremanSendBlock({
    enabled: o.enabled,
    mode: o.mode,
    allowlisted: foremanAllowlisted(session.cwd, session.repoRoot, o.allowlist ?? []),
    cwd: session.cwd,
  });
}

/**
 * The allowlist entry that would clear this session for live sends.
 *
 * The REPO root, not the cwd: a worktree's own directory is throwaway (a new one per
 * task, under `~/.treehouse/...` or the daemon's worktrees dir), so allowlisting it
 * buys exactly one worktree and silently stops working on the next one. The repo root
 * is the stable thing the human means by "this project", and `foremanAllowlisted`
 * matches every worktree of it. Falls back to the cwd only when git told us nothing.
 */
export function allowlistSuggestion(session: Session): string | null {
  return session.repoRoot ?? session.cwd;
}

/**
 * What each disposition says the note is, in the human's terms.
 *
 * One copy, read by every live surface (the grid card, the console strip) and by the
 * episode record. The drawer's rows word two of these differently on purpose - they
 * print the author beside the state - so they keep their own map rather than bending
 * this one to serve both.
 */
export const DISPOSITION_LABEL: Record<NoteDisposition, string> = {
  answered: "answered for you",
  pending: "drafted a reply",
  escalated: "needs your decision",
  skipped: "left for you",
};

/** Where an approved draft should be delivered, or that it can no longer be. */
export type DeliveryTarget =
  | { kind: "review"; reviewId: string }
  | { kind: "send" }
  | { kind: "stale" };

/**
 * Deliver to the channel the draft was actually made FOR, read from the note's
 * `handledMarker` rather than from the live review map (which can drift while a draft
 * sits pending). A `review:<id>` draft resolves *that* review; if it is no longer
 * pending the draft is stale and must be dismissed, never redirected elsewhere - the
 * text was written to answer a question that is now closed, and sending it at whatever
 * review happens to be open next answers the wrong one in the human's name.
 *
 * A terminal marker types into the session; a marker-less draft falls back to the live
 * input review, else the terminal.
 *
 * Pure, and out here with `foremanSendBlock`, because that stale rule is invisible
 * unless you know why it exists and it was previously written out once per surface.
 */
export function deliveryTarget(o: {
  handledMarker: string | null;
  inputReviewId: string | null;
  pendingReviewIds: ReadonlySet<string> | undefined;
}): DeliveryTarget {
  const marker = o.handledMarker;
  if (marker?.startsWith("review:")) {
    const reviewId = marker.slice("review:".length);
    if (o.pendingReviewIds?.has(reviewId) ?? false) return { kind: "review", reviewId };
    return { kind: "stale" };
  }
  if (marker) return { kind: "send" };
  return o.inputReviewId ? { kind: "review", reviewId: o.inputReviewId } : { kind: "send" };
}

/**
 * The minimum of `api` this module calls, so a test can hand it a recorder.
 *
 * Narrowed to two methods rather than taking the whole client: what is being pinned
 * here is an ORDER between exactly these two writes, and a wider surface would invite
 * a caller to slip a third one in between them.
 */
export interface ForemanWriter {
  resolveEpisode: (id: string, p: ResolveEpisode) => Promise<unknown>;
  setNote: (id: string, note: SetNote) => Promise<unknown>;
}

/**
 * Close out a Foreman note you just acted on, in the one order that keeps the record.
 *
 * The episode is stamped FIRST and this is not stylistic. The `setNote` below nulls
 * `recommendation` and `brief` - correctly, because after you answer there is no
 * current recommendation - and before the episode log existed that null was the end of
 * the text: approving erased the very words that had just been sent to the child.
 * Writing the record afterwards would read a recommendation that had already been
 * cleared, and file the decision with the evidence missing.
 *
 * `marker` identifies the episode, and a note without one predates the log (or came
 * from a path that sets no marker). That is a no-op, deliberately: a missing audit row
 * must never be able to fail the human's actual decision.
 *
 * Shared by `ForemanNote` (the grid card) and `ForemanStrip` (the console), which
 * otherwise had this sequence written out twice - two copies of an ordering
 * constraint that is invisible unless you know why it exists.
 */
export async function closeForemanNote(
  writer: ForemanWriter,
  sessionId: string,
  o: {
    marker: string | null;
    disposition: "answered" | "skipped";
    lastAction: string;
    /** What was actually delivered; null when the note was dismissed unanswered. */
    sentText: string | null;
  },
): Promise<void> {
  if (o.marker) {
    await writer.resolveEpisode(sessionId, {
      marker: o.marker,
      disposition: o.disposition,
      sentText: o.sentText,
    });
  }
  await writer.setNote(sessionId, {
    disposition: o.disposition,
    lastAction: o.lastAction,
    recommendation: null,
    brief: null,
  });
}
