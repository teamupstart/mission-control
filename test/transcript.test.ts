import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeRuntimeMeta,
  latestEffortLevel,
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

// ---- runtime metadata (model / context% / thinking level) ----

const effortSet = (lvl: string): string =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: `<local-command-stdout>Set effort level to ${lvl} (saved as your default)</local-command-stdout>`,
    },
  });
const modelWithEffort = (lvl: string): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: `<local-command-stdout>Set model to Opus 4.8 with ${lvl} effort</local-command-stdout>` },
  });
const asstUsage = (model: string | null, usage: Record<string, number>, extra: object = {}): string =>
  JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", model, usage }, ...extra });

test("latestEffortLevel reads /effort and /model-with-effort echoes, newest wins", () => {
  assert.equal(latestEffortLevel([effortSet("xhigh")]), "xhigh");
  assert.equal(latestEffortLevel([modelWithEffort("high")]), "high");
  assert.equal(latestEffortLevel([effortSet("low"), effortSet("max")]), "max");
  // "xhigh" must not be mis-sliced to "high".
  assert.equal(latestEffortLevel([effortSet("xhigh")]), "xhigh");
  assert.equal(latestEffortLevel([asstText, userPrompt]), null);
});

test("computeRuntimeMeta derives model + context% from the newest assistant usage", () => {
  // A standard-window model (Haiku) exercises the plain 200k arithmetic.
  const m = computeRuntimeMeta([
    asstUsage("claude-haiku-4-5", {
      input_tokens: 10_000,
      cache_read_input_tokens: 60_000,
      cache_creation_input_tokens: 30_000,
      output_tokens: 500,
    }),
  ]);
  assert.deepEqual(m, {
    modelId: "claude-haiku-4-5",
    contextTokens: 100_000, // output excluded
    contextWindow: 200_000,
    contextPct: 50,
    longContext: false,
    thinkingLevel: null,
  });
});

test("computeRuntimeMeta defaults a marker-less long-context model (Opus 4.x) to 1M", () => {
  const m = computeRuntimeMeta([asstUsage("claude-opus-4-8", { input_tokens: 100_000 })]);
  assert.equal(m?.contextWindow, 1_000_000);
  assert.equal(m?.contextPct, 10); // 100k / 1M, not 50% of 200k
  assert.equal(m?.longContext, true);
});

test("computeRuntimeMeta infers a 1M window from the model id", () => {
  const m = computeRuntimeMeta([asstUsage("claude-opus-4-8[1m]", { input_tokens: 100_000 })]);
  assert.equal(m?.contextWindow, 1_000_000);
  assert.equal(m?.contextPct, 10);
  assert.equal(m?.longContext, true);
});

test("computeRuntimeMeta recovers a 1M window when the id lacks the marker but usage exceeds 200k", () => {
  // The transcript records the bare `claude-opus-4-8` (no `[1m]`); 490k tokens
  // can't fit a 200k window, so the real window must be 1M - and % must not peg.
  const m = computeRuntimeMeta([
    asstUsage("claude-opus-4-8", {
      input_tokens: 2,
      cache_read_input_tokens: 470_000,
      cache_creation_input_tokens: 20_000,
    }),
  ]);
  assert.equal(m?.contextTokens, 490_002);
  assert.equal(m?.contextWindow, 1_000_000);
  assert.equal(m?.contextPct, 49);
  assert.equal(m?.longContext, true);
});

test("computeRuntimeMeta keeps the 200k window for a standard-window model under 200k", () => {
  const m = computeRuntimeMeta([asstUsage("claude-haiku-4-5", { input_tokens: 120_000 })]);
  assert.equal(m?.contextWindow, 200_000);
  assert.equal(m?.contextPct, 60);
  assert.equal(m?.longContext, false);
});

test("computeRuntimeMeta still floors a standard model up when usage proves a bigger window", () => {
  // Even a normally-200k id must not clamp: 260k tokens can't fit 200k.
  const m = computeRuntimeMeta([asstUsage("claude-haiku-4-5", { input_tokens: 260_000 })]);
  assert.equal(m?.contextWindow, 1_000_000);
  assert.equal(m?.contextPct, 26);
  assert.equal(m?.longContext, true);
});

test("computeRuntimeMeta skips sidechain + api-error records and folds in effort", () => {
  const main = asstUsage("claude-sonnet-5", { input_tokens: 20_000 });
  const sidechain = asstUsage("claude-haiku-4-5", { input_tokens: 999_999 }, { isSidechain: true });
  const apiErr = asstUsage("claude-haiku-4-5", { input_tokens: 999_999 }, { isApiErrorMessage: true });
  const m = computeRuntimeMeta([effortSet("high"), main, sidechain, apiErr]);
  assert.equal(m?.modelId, "claude-sonnet-5"); // the main-chain record, not the noise
  assert.equal(m?.contextTokens, 20_000);
  assert.equal(m?.thinkingLevel, "high");
});

test("computeRuntimeMeta returns null when nothing useful is present", () => {
  assert.equal(computeRuntimeMeta(["", "{}", userToolResult]), null);
});

test("computeRuntimeMeta keeps the model when usage has only output tokens", () => {
  const m = computeRuntimeMeta([asstUsage("claude-opus-4-8", { output_tokens: 400 })]);
  assert.equal(m?.modelId, "claude-opus-4-8");
  assert.equal(m?.contextPct, null); // no context-length tokens -> no %
  assert.equal(m?.contextWindow, null);
});

// ---- transcript path resolution ----

const UUID = "4aa3d50a-9232-49cf-9ad9-67b8a9e8b51a";
const encode = (cwd: string): string => cwd.replace(/[/.]/g, "-");
const session = (p: Partial<Session>): Session =>
  ({ agent: "claude", agentSessionId: UUID, cwd: "/Users/me/work/app", transcriptPath: null, ...p }) as Session;

test("resolveTranscriptPath uses the hook-reported transcriptPath verbatim", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  const dir = join(root, encode("/Users/me/.treehouse/x/4/app"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${UUID}.jsonl`);
  writeFileSync(file, "{}\n");
  // cwd is deliberately wrong (the launcher's dir); the exact hook path wins and
  // needs no cwd derivation.
  const s = session({ cwd: "/Users/me/work/app", transcriptPath: file });
  assert.equal(resolveTranscriptPath(s, root), file);
});

test("resolveTranscriptPath falls back to the cwd-derived path when no hook path", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  const cwd = "/Users/me/work/app";
  const dir = join(root, encode(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${UUID}.jsonl`);
  writeFileSync(file, "{}\n");
  assert.equal(resolveTranscriptPath(session({ cwd }), root), file);
});

test("resolveTranscriptPath returns null when neither locates a file", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  // A stale hook path that no longer exists, and no cwd-derived file either.
  const s = session({ cwd: "/Users/me/work/app", transcriptPath: join(root, "gone.jsonl") });
  assert.equal(resolveTranscriptPath(s, root), null);
});

test("resolveTranscriptPath ignores non-claude, id-less, and cwd-less sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  assert.equal(resolveTranscriptPath(session({ agent: "codex" }), root), null);
  assert.equal(resolveTranscriptPath(session({ agentSessionId: null }), root), null);
  assert.equal(resolveTranscriptPath(session({ cwd: null }), root), null);
});
