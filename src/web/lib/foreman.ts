import { foremanAllowlisted } from "@shared/foreman.ts";
import type { Session } from "@shared/types.ts";

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
