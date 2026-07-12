import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  latestTodoNarration,
  parseLines,
  resolveTranscriptPath,
  toMessage,
} from "../src/server/transcript.ts";
import type { Session } from "@shared/types.ts";

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

// ---- transcript path resolution ----

const UUID = "4aa3d50a-9232-49cf-9ad9-67b8a9e8b51a";
const encode = (cwd: string): string => cwd.replace(/[/.]/g, "-");
const session = (p: Partial<Session>): Session =>
  ({ agent: "claude", agentSessionId: UUID, cwd: "/Users/me/work/app", ...p }) as Session;

test("resolveTranscriptPath finds the file under the cwd-encoded dir", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  const cwd = "/Users/me/work/app";
  const dir = join(root, encode(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${UUID}.jsonl`);
  writeFileSync(file, "{}\n");
  assert.equal(resolveTranscriptPath(session({ cwd }), root), file);
});

test("resolveTranscriptPath falls back to id search when cwd is wrong (worktree case)", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  // The file actually lives under the worktree-encoded dir...
  const dir = join(root, encode("/Users/me/.treehouse/x/4/app"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${UUID}.jsonl`);
  writeFileSync(file, "{}\n");
  // ...but discovery reported the launcher's cwd (the main repo). Still resolves.
  assert.equal(resolveTranscriptPath(session({ cwd: "/Users/me/work/app" }), root), file);
});

test("resolveTranscriptPath returns null when no transcript exists for the id", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  mkdirSync(join(root, encode("/Users/me/work/app")), { recursive: true });
  assert.equal(resolveTranscriptPath(session({ cwd: "/Users/me/work/app" }), root), null);
});

test("resolveTranscriptPath ignores non-claude or id-less sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  assert.equal(resolveTranscriptPath(session({ agent: "codex" }), root), null);
  assert.equal(resolveTranscriptPath(session({ agentSessionId: null }), root), null);
  assert.equal(resolveTranscriptPath(session({ cwd: null }), root), null);
});
