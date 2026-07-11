import { test } from "node:test";
import assert from "node:assert/strict";
import { latestTodoNarration, parseLines, toMessage } from "../src/server/transcript.ts";

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

// ---- no-mistakes narration (current TodoWrite item) ----

const todoWrite = (uuid: string, todos: Array<Record<string, unknown>>, extra: object = {}): string =>
  JSON.stringify({
    type: "assistant",
    uuid,
    message: { role: "assistant", content: [{ type: "tool_use", name: "TodoWrite", input: { todos } }] },
    ...extra,
  });

test("latestTodoNarration returns the in-progress item's activeForm", () => {
  const line = todoWrite("t1", [
    { content: "Implement dispatch", status: "completed", activeForm: "Implementing dispatch" },
    { content: "Run no-mistakes to open PR #2", status: "in_progress", activeForm: "Running no-mistakes to open PR #2" },
    { content: "Write docs", status: "pending", activeForm: "Writing docs" },
  ]);
  assert.equal(latestTodoNarration([line]), "Running no-mistakes to open PR #2");
});

test("latestTodoNarration falls back to content when activeForm is absent", () => {
  const line = todoWrite("t1", [{ content: "Push the branch", status: "in_progress" }]);
  assert.equal(latestTodoNarration([line]), "Push the branch");
});

test("latestTodoNarration uses the newest TodoWrite, even if it has nothing in progress", () => {
  const older = todoWrite("t1", [{ content: "Old step", status: "in_progress", activeForm: "Doing old step" }]);
  const newer = todoWrite("t2", [{ content: "Old step", status: "completed", activeForm: "Doing old step" }]);
  // Newest wins and it's all done -> null, not the stale earlier in-progress item.
  assert.equal(latestTodoNarration([older, newer]), null);
});

test("latestTodoNarration ignores sidechain TodoWrites and non-TodoWrite lines", () => {
  const sidechainTodo = todoWrite(
    "s1",
    [{ content: "Subagent task", status: "in_progress", activeForm: "Doing subagent task" }],
    { isSidechain: true },
  );
  const mainTodo = todoWrite("t1", [{ content: "Real task", status: "in_progress", activeForm: "Doing real task" }]);
  assert.equal(latestTodoNarration([mainTodo, sidechainTodo, asstText, "{bad json"]), "Doing real task");
  assert.equal(latestTodoNarration([asstText, asstTool, userPrompt]), null);
});
