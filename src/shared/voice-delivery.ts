import { POST_REPORT_LINE } from "./reports.ts";
import type { Session } from "./types.ts";

export const VOICE_TURN_PREFIX = "voice:";

/** The registry counts questions the agent can work past separately in openQuestions. */
export function voiceHeldByReview(session: Pick<Session, "pendingReviews">): boolean {
  return session.pendingReviews > 0;
}

export function openQuestionsNote(asks: readonly { id: string; title: string }[]): string | null {
  if (!asks.length) return null;
  return [
    "Your open questions:",
    ...asks.map((ask) => `- ${ask.id}: ${ask.title}`),
    "Withdraw any question this message settles, with a reason.",
  ].join("\n");
}

export function spokenMessageText(words: string, notes: { openQuestions: string | null; unseenReports: string | null }): string {
  return [words, notes.openQuestions, notes.unseenReports, POST_REPORT_LINE].filter(part => part !== null).join("\n\n");
}
