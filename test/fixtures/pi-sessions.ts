// A verbatim capture of a real Pi (`@earendil-works/pi-coding-agent` 0.80.10) session
// transcript, taken from `~/.pi/agent/sessions/--Users-jordanmance--/<...>.jsonl` on the
// machine the Phase 5 spike ran on. Verbatim, never hand-written - the same rule
// `claude-panes.ts` / `codex-panes.ts` hold, for the same reason: a fixture edited into a
// shape that was never observed protects nothing.
//
// It is a TEXT-ONLY session (a `session` header, a `model_change`, a `thinking_level_change`,
// user/assistant `message` records, and one aborted turn). pi was not logged in to a provider
// during the spike, so no tool call could be driven. What it pins is what was captured: text
// parsing, the `thinking` part being dropped, the aborted turn's interrupt marker,
// model/token/effort metadata, and the idle/working read. `PI_TOOL_SESSION_LINES` below is the
// capture that finally drove tools, and it is what pins that half.
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

// A second verbatim capture, from `@earendil-works/pi-coding-agent` 0.84.2 in
// `~/.pi/agent/sessions/--private-tmp-pi-fixture--/`, taken because the capture above could
// not drive a tool and the tool-call parse was therefore guessed rather than measured - it
// read `tool_call`, pi's EXTENSION EVENT name, while a content part is `toolCall` with
// `arguments`. Every tool-only assistant turn was silently dropped, so a pi session's commands
// reached neither the conversation nor the activity rail.
//
// Byte-verbatim, including the opaque `textSignature` blob, the `call_…|fc_…` composite tool
// call id and the cost floats: a fixture edited into a shape that was never observed protects
// nothing, and the point of this one is the exact spelling of the record.
//
// One `read` call (pi names its file argument `path`, not Claude's `file_path`) and one `bash`
// call (`command`, as Claude spells it), each with its own `toolResult` record under a third
// role, then a closing text turn.
export const PI_TOOL_SESSION_LINES: readonly string[] = [
  `{"type":"session","version":3,"id":"01a0a2e9-9d06-7fa1-bf47-1a455a2547be","timestamp":"2026-09-15T02:33:34.214Z","cwd":"/private/tmp/pi-fixture"}`,
  `{"type":"model_change","id":"8d988b8d","parentId":null,"timestamp":"2026-09-15T02:33:34.262Z","provider":"openai-codex","modelId":"gpt-5.6-luna"}`,
  `{"type":"thinking_level_change","id":"603519c1","parentId":"8d988b8d","timestamp":"2026-09-15T02:33:34.262Z","thinkingLevel":"low"}`,
  `{"type":"message","id":"9ac5d0fe","parentId":"603519c1","timestamp":"2026-09-15T02:33:34.267Z","message":{"role":"user","content":[{"type":"text","text":"Read the file notes.txt, then run the bash command: echo done. Reply with one word."}],"timestamp":1789439614266}}`,
  `{"type":"message","id":"927bbfd3","parentId":"9ac5d0fe","timestamp":"2026-09-15T02:33:36.425Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_Fwnbxpxoce0GylWNeF4nv8go|fc_0188afd38a9406af016aa8ae8029f487d1ba118c2df40e5073","name":"read","arguments":{"path":"notes.txt"}}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.6-luna","usage":{"input":1806,"output":18,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":1824,"cost":{"input":0.00036120000000000005,"output":0.0000216,"cacheRead":0,"cacheWrite":0,"total":0.00038280000000000003}},"stopReason":"toolUse","timestamp":1789439614273,"responseId":"resp_0188afd38a9406af016aa8ae7f1ab087d19ca48ef8d6358181","rawStopReason":"completed"}}`,
  `{"type":"message","id":"c990b079","parentId":"927bbfd3","timestamp":"2026-09-15T02:33:36.428Z","message":{"role":"toolResult","toolCallId":"call_Fwnbxpxoce0GylWNeF4nv8go|fc_0188afd38a9406af016aa8ae8029f487d1ba118c2df40e5073","toolName":"read","content":[{"type":"text","text":"alpha\\nbeta\\n"}],"isError":false,"timestamp":1789439616428}}`,
  `{"type":"message","id":"e06c8f8b","parentId":"c990b079","timestamp":"2026-09-15T02:33:38.098Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_lpx28YDoQbtIZeceE5fq9oN1|fc_0188afd38a9406af016aa8ae81d48487d18f781afc7e7241ae","name":"bash","arguments":{"command":"echo done"}}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.6-luna","usage":{"input":1838,"output":19,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":1857,"cost":{"input":0.00036760000000000004,"output":0.0000228,"cacheRead":0,"cacheWrite":0,"total":0.00039040000000000006}},"stopReason":"toolUse","timestamp":1789439616429,"responseId":"resp_0188afd38a9406af016aa8ae80f4ac87d1a9a798810426f354","rawStopReason":"completed"}}`,
  `{"type":"message","id":"5cd8a7e0","parentId":"e06c8f8b","timestamp":"2026-09-15T02:33:38.103Z","message":{"role":"toolResult","toolCallId":"call_lpx28YDoQbtIZeceE5fq9oN1|fc_0188afd38a9406af016aa8ae81d48487d18f781afc7e7241ae","toolName":"bash","content":[{"type":"text","text":"done\\n"}],"isError":false,"timestamp":1789439618102}}`,
  `{"type":"message","id":"ad905272","parentId":"5cd8a7e0","timestamp":"2026-09-15T02:33:39.748Z","message":{"role":"assistant","content":[{"type":"text","text":"done","textSignature":"{\\"v\\":1,\\"id\\":\\"msg_0188afd38a9406af016aa8ae83a8f087d1b0d9cd897bab55f9\\",\\"phase\\":\\"final_answer\\"}"}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.6-luna","usage":{"input":334,"output":5,"cacheRead":1536,"cacheWrite":0,"reasoning":0,"totalTokens":1875,"cost":{"input":0.00006680000000000001,"output":0.000006,"cacheRead":0.000030720000000000004,"cacheWrite":0,"total":0.00010352000000000001}},"stopReason":"stop","timestamp":1789439618103,"responseId":"resp_0188afd38a9406af016aa8ae829b7487d1bee0e9a42feddcf6","rawStopReason":"completed"}}`,
];

/** The captured tool-driving session as a single JSONL blob, for writing to a temp file. */
export const PI_TOOL_SESSION_JSONL = PI_TOOL_SESSION_LINES.join("\n") + "\n";
