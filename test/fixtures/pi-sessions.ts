// A verbatim capture of a real Pi (`@earendil-works/pi-coding-agent` 0.80.10) session
// transcript, taken from `~/.pi/agent/sessions/--Users-jordanmance--/<...>.jsonl` on the
// machine the Phase 5 spike ran on. Verbatim, never hand-written - the same rule
// `claude-panes.ts` / `codex-panes.ts` hold, for the same reason: a fixture edited into a
// shape that was never observed protects nothing.
//
// It is a TEXT-ONLY session (a `session` header, a `model_change`, a `thinking_level_change`,
// user/assistant `message` records, and one aborted turn). pi was not logged in to a provider
// during the spike, so no tool call could be driven - the adapter's `tool_call` parsing is
// documented as best-effort in `harness/pi/transcript.ts` and is not pinned here. What IS
// pinned is what was captured: text parsing, the `thinking` part being dropped, the aborted
// turn falling out, model/token/effort metadata, and the idle/working read.
//
// One deviation from byte-verbatim, called out because the rule is strict: the opaque
// `thinkingSignature` / `textSignature` / `encrypted_content` base64 blobs (each ~2KB of
// noise the parser never reads) are shortened. Every RECORD SHAPE - the keys, the part types,
// the usage/stopReason fields - is exactly as captured.

/** The nine raw JSONL lines of the captured session, in file order. */
export const PI_SESSION_LINES: readonly string[] = [
  `{"type":"session","version":3,"id":"019f7d35-beb8-7ae4-8b33-049e4f65cacd","timestamp":"2026-07-20T01:48:22.072Z","cwd":"/Users/jordanmance"}`,
  `{"type":"model_change","id":"6bd3cf16","parentId":null,"timestamp":"2026-07-20T01:48:22.510Z","provider":"openai","modelId":"gpt-5.5"}`,
  `{"type":"thinking_level_change","id":"3f4da2dd","parentId":"6bd3cf16","timestamp":"2026-07-20T01:48:22.510Z","thinkingLevel":"medium"}`,
  `{"type":"message","id":"4ffc0252","parentId":"3f4da2dd","timestamp":"2026-07-20T01:48:40.068Z","message":{"role":"user","content":[{"type":"text","text":"exot"}],"timestamp":1784512120067}}`,
  `{"type":"message","id":"c3997974","parentId":"4ffc0252","timestamp":"2026-07-20T01:48:43.746Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"**Clarifying user input**\\n\\nThe user said \\"exot\\" - likely a typo. I'll ask what they meant.","thinkingSignature":"{\\"id\\":\\"rs_abc\\",\\"type\\":\\"reasoning\\"}"},{"type":"text","text":"Could you clarify what you'd like me to do?","textSignature":"{\\"v\\":1,\\"id\\":\\"msg_abc\\",\\"phase\\":\\"final_answer\\"}"}],"api":"openai-responses","provider":"openai","model":"gpt-5.5","usage":{"input":1230,"output":37,"cacheRead":0,"cacheWrite":0,"reasoning":20,"totalTokens":1267,"cost":{"input":0.00615,"output":0.00111,"cacheRead":0,"cacheWrite":0,"total":0.00726}},"stopReason":"stop","timestamp":1784512120106,"responseId":"resp_abc"}}`,
  `{"type":"message","id":"bee727f1","parentId":"c3997974","timestamp":"2026-07-20T01:48:43.747Z","message":{"role":"user","content":[{"type":"text","text":"exit"}],"timestamp":1784512120953}}`,
  `{"type":"message","id":"d2653bab","parentId":"bee727f1","timestamp":"2026-07-20T01:48:44.850Z","message":{"role":"assistant","content":[{"type":"text","text":"Goodbye.","textSignature":"{\\"v\\":1,\\"id\\":\\"msg_def\\",\\"phase\\":\\"final_answer\\"}"}],"api":"openai-responses","provider":"openai","model":"gpt-5.5","usage":{"input":228,"output":7,"cacheRead":1024,"cacheWrite":0,"reasoning":0,"totalTokens":1259,"cost":{"input":0.00114,"output":0.00021,"cacheRead":0.000512,"cacheWrite":0,"total":0.001862}},"stopReason":"stop","timestamp":1784512123749,"responseId":"resp_def"}}`,
  `{"type":"message","id":"98669cde","parentId":"d2653bab","timestamp":"2026-07-21T10:48:10.144Z","message":{"role":"user","content":[{"type":"text","text":"exit"}],"timestamp":1784630890143}}`,
  `{"type":"message","id":"b70e3d09","parentId":"98669cde","timestamp":"2026-07-21T10:48:12.152Z","message":{"role":"assistant","content":[],"api":"openai-responses","provider":"openai","model":"gpt-5.5","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"aborted","timestamp":1784630890146,"errorMessage":"Operation aborted"}}`,
];

/** The captured session as a single JSONL blob, for writing to a temp file. */
export const PI_SESSION_JSONL = PI_SESSION_LINES.join("\n") + "\n";
