import type { TranscriptMessage } from "../../src/shared/types.ts";
import type { TranscriptMessages } from "../../src/server/harness/types.ts";
import type { DelegatedConversation } from "../../src/server/delegated-turns.ts";

/** Bytes each fake turn occupies, so offsets read like a real append-only file. */
const TURN_BYTES = 100;

/**
 * An append-only transcript for delegated-turn binding: `size` and the forward `after` walk
 * behave like the real readers, and turns are appended as the agent would write them.
 */
export function fakeTranscript() {
  const turns: TranscriptMessage[] = [];
  let sizeFails: boolean | "missing" = false;
  const read = {
    size: () => {
      if (sizeFails === "missing") return null;
      if (sizeFails) throw new Error("transcript size unreadable");
      return turns.length * TURN_BYTES;
    },
    after: (_path: string, after: number, want = 50) => {
      const first = Math.ceil(after / TURN_BYTES);
      const messages = turns.slice(first, first + want);
      return { messages, start: after, end: (first + messages.length) * TURN_BYTES, atEnd: first + messages.length >= turns.length };
    },
  } as unknown as TranscriptMessages;
  return {
    turns,
    size: () => turns.length * TURN_BYTES,
    /** Make the reader's `size` throw, as a transient stat failure would, or report a missing file. */
    failSize(on: boolean | "missing") {
      sizeFails = on;
    },
    append(id: string, text: string, ts: number): TranscriptMessage {
      const turn: TranscriptMessage = { id, role: "user", text, tools: [], ts };
      turns.push(turn);
      return turn;
    },
    conversation: (key: string): DelegatedConversation => ({ key, transcript: { read, path: "fake" } }),
  };
}
