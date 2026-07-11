import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLines, toMessage } from "../src/server/transcript.ts";

// Records shaped like real Claude Code JSONL transcript lines.
const asstText = JSON.stringify({
  type: "assistant",
  isSidechain: false,
  uuid: "a1",
  timestamp: "2026-07-11T02:00:00.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] },
});
const asstTool = JSON.stringify({
  type: "assistant",
  uuid: "a2",
  timestamp: "2026-07-11T02:00:01.000Z",
  message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
});
const userPrompt = JSON.stringify({
  type: "user",
  uuid: "u1",
  timestamp: "2026-07-11T02:00:02.000Z",
  message: { role: "user", content: "run the tests" },
});
const userToolResult = JSON.stringify({
  type: "user",
  uuid: "u2",
  message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
});
const sidechain = JSON.stringify({
  type: "assistant",
  isSidechain: true,
  uuid: "s1",
  message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] },
});
const meta = JSON.stringify({ type: "file-history-snapshot", uuid: "m1" });

test("parseLines keeps prompts + assistant turns, drops sidechains/tool-results/meta", () => {
  const msgs = parseLines([asstText, asstTool, userPrompt, userToolResult, sidechain, meta, ""]);
  assert.deepEqual(
    msgs.map((m) => m.id),
    ["a1", "a2", "u1"],
  );
});

test("toMessage extracts text, tools, role, and timestamp", () => {
  const t = toMessage(JSON.parse(asstText));
  assert.deepEqual(t, {
    id: "a1",
    role: "assistant",
    text: "Hello there",
    tools: [],
    ts: Date.parse("2026-07-11T02:00:00.000Z"),
  });
  const tool = toMessage(JSON.parse(asstTool));
  assert.equal(tool!.text, "");
  assert.deepEqual(tool!.tools, ["Bash"]);
  const prompt = toMessage(JSON.parse(userPrompt));
  assert.equal(prompt!.role, "user");
  assert.equal(prompt!.text, "run the tests");
});

test("toMessage drops noise: sidechains, pure tool-results, empty turns, non-messages", () => {
  assert.equal(toMessage(JSON.parse(sidechain)), null);
  assert.equal(toMessage(JSON.parse(userToolResult)), null);
  assert.equal(toMessage(JSON.parse(meta)), null);
  assert.equal(toMessage({ type: "assistant", message: { role: "assistant", content: [] } }), null);
});

test("parseLines honors the tail limit and ignores malformed lines", () => {
  const msgs = parseLines([asstText, "{not json", asstTool, userPrompt], 2);
  assert.deepEqual(
    msgs.map((m) => m.id),
    ["a2", "u1"],
  );
});
