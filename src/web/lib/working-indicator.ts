import type { TranscriptMessage } from "@shared/types.ts";

// When the turn a working session is on began, for the in-progress row's clock.
//
// Read off the transcript rather than off the session, because the session carries no
// such time: `lastActivity` is the newest EVENT, which a busy agent refreshes every few
// seconds, and the daemon's own turn-start evidence is terminal-only and never leaves it.
// The transcript has the one fact that means "the work started here" for every runtime -
// the prompt that set it going.
//
// The normalized transcript makes that a simple walk. A `user` record that was nothing but
// a tool result is dropped at normalization (`harness/claude/transcript.ts`), so every
// `user` message left is a prompt: the operator's, Foreman's, or a workflow's. Whichever of
// them was last is what the session is working on, and whoever typed it is irrelevant to
// how long ago it was typed.

/**
 * When the current turn began: the newest prompt in the loaded conversation, or null.
 *
 * Null rather than a guess in both cases that have no honest answer. A record with no
 * timestamp normalizes to `ts: 0`, and a clock counting from the epoch would read as
 * twenty thousand days. And a turn long enough to push its own prompt out of the loaded
 * page has no prompt here to read - the first loaded message would undercount it by
 * however much was not loaded, so the row draws no clock rather than a wrong one.
 */
export function currentTurnStartedAt(messages: readonly TranscriptMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return m.ts > 0 ? m.ts : null;
  }
  return null;
}
