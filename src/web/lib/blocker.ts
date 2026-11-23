import type { SessionBlocker, SessionBlockerKind } from "@shared/types.ts";

/** The word a card and the detail band print for each blocker kind. */
export const BLOCKER_KIND_LABELS: Record<SessionBlockerKind, string> = {
  question: "Question",
  dependency: "Dependency",
  service: "Service",
  other: "Other",
};

/** How long a blocker has stood, compactly: "42s", "3m", "3h", "2d". */
export function blockerAge(startedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Who flagged a reply, in the operator's words. */
export function blockerFlaggedBy(flaggedBy: string): string {
  if (flaggedBy === "operator") return "you";
  return flaggedBy.startsWith("session:") ? "a controlling session" : flaggedBy;
}

/** The tooltip on a card's `Blocked · age` flag. */
export function blockerFlagTitle(blocker: SessionBlocker): string {
  return `Blocked on ${blocker.waitingOn}: ${blocker.reason}. Resumes when ${blocker.resumeWhen}.`;
}

/** A blocker link the dashboard may open: http(s) only, whatever was stored. */
export function blockerHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}
