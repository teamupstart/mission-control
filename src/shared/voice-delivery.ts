export const VOICE_TURN_PREFIX = "voice:";

export function openQuestionsNote(asks: readonly { id: string; title: string }[]): string | null {
  if (!asks.length) return null;
  return [
    "Your open questions:",
    ...asks.map((ask) => `- ${ask.id}: ${ask.title}`),
    "Withdraw any question this message settles, with a reason.",
  ].join("\n");
}

export function spokenMessageText(words: string, notes: { openQuestions: string | null; unseenReports: string | null }): string {
  return [words, notes.openQuestions, notes.unseenReports].filter(part => part !== null).join("\n\n");
}
