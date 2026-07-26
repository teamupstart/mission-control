import type { TranscriptMessage } from "@shared/types.ts";
import { originOf } from "./injections.ts";

export function attributeTranscript(
  sessionId: string | undefined,
  messages: TranscriptMessage[],
): TranscriptMessage[] {
  if (!sessionId) return messages;
  return messages.map((message) => {
    if (message.role !== "user" || !message.text) return message;
    const origin = originOf(sessionId, message.text);
    return origin ? { ...message, origin } : message;
  });
}
