/** Private fork IPC. Advanced serialization carries PCM bytes without base64 or a temporary file. */
export type SpeechRequest = { type: "warm" } | { type: "synthesize"; text: string; voice: string };
export type SpeechReply =
  | { id: number; ready: true }
  | { id: number; failed: true }
  | { id: number; wav: Uint8Array; durationMs: number };
