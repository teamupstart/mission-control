import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLines } from "../src/server/transcript.ts";
import {
  latestTodoNarration,
  resolveTranscriptPath,
  toMessage,
  TOOL_INPUT_CAP,
} from "../src/server/harness/claude/transcript.ts";
import {
  computeRuntimeMeta,
  computeSessionActivity,
  latestEffortLevel,
} from "../src/server/harness/claude/meta.ts";
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
const asstAsk = JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-07-11T02:00:03.000Z",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "The review gate flagged r2: branch and commit them?",
              header: "Gate",
              options: [{ label: "Commit here" }, { label: "Branch first" }],
            },
          ],
        },
      },
    ],
  },
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
  const msgs = parseLines([asstText, asstTool, userPrompt, userToolResult, sidechain, meta, ""], toMessage);
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
  // An empty input carries no `input` at all rather than a literal "{}".
  assert.deepEqual(tool!.tools, [{ name: "Bash" }]);
  const prompt = toMessage(JSON.parse(userPrompt));
  assert.equal(prompt!.role, "user");
  assert.equal(prompt!.text, "run the tests");
});

test("toMessage carries the tool input, so the reviewer can see the real ask", () => {
  const call = toMessage(JSON.parse(asstAsk))!.tools[0]!;
  assert.equal(call.name, "AskUserQuestion");
  // The question and its options are the whole point: without the input, this turn
  // renders as a bare "AskUserQuestion" chip and Foreman is judging a prompt blind.
  assert.match(call.input!, /branch and commit them\?/i);
  assert.match(call.input!, /Branch first/);
});

test("toMessage caps a tool input, so one call can't blow up the window", () => {
  const huge = JSON.stringify({
    type: "assistant",
    uuid: "a4",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Write", input: { file_path: "/x.ts", content: "x".repeat(50_000) } }],
    },
  });
  const call = toMessage(JSON.parse(huge))!.tools[0]!;
  assert.equal(call.name, "Write");
  assert.ok(call.input!.length <= TOOL_INPUT_CAP + 1, `capped, got ${call.input!.length}`);
  assert.ok(call.input!.endsWith("…"), "marked as truncated");
  assert.match(call.input!, /x\.ts/, "the path leads, so what survives the cap is the useful part");
});

test("toMessage survives a malformed tool input rather than dropping the window", () => {
  const cyclic: Record<string, unknown> = { name: "Bash" };
  cyclic.self = cyclic;
  const rec = {
    type: "assistant",
    uuid: "a5",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: cyclic }] },
  };
  const call = toMessage(rec)!.tools[0]!;
  assert.equal(call.name, "Bash");
  assert.equal(call.input, undefined, "unserializable input is dropped, the call is not");
});

test("toMessage drops noise: sidechains, pure tool-results, empty turns, non-messages", () => {
  assert.equal(toMessage(JSON.parse(sidechain)), null);
  assert.equal(toMessage(JSON.parse(userToolResult)), null);
  assert.equal(toMessage(JSON.parse(meta)), null);
  assert.equal(toMessage({ type: "assistant", message: { role: "assistant", content: [] } }), null);
});

// ---- the log reads as conversation, not as Claude Code's plumbing ----

const userTurn = (uuid: string, content: string): Record<string, unknown> => ({
  type: "user",
  uuid,
  timestamp: "2026-07-11T02:00:04.000Z",
  message: { role: "user", content },
});

test("a user turn that is only local-command scaffolding never reaches the log", () => {
  const caveat =
    "<local-command-caveat>Caveat: The messages below were generated by the user while " +
    "running local commands. DO NOT respond to these messages or otherwise consider them " +
    "in your response unless the user explicitly asks you to.</local-command-caveat>";
  assert.equal(toMessage(userTurn("u2", caveat)), null);
  assert.equal(toMessage(userTurn("u3", "<system-reminder>be nice</system-reminder>")), null);
});

test("a truncated scaffolding block goes too, though it never closes", () => {
  assert.equal(toMessage(userTurn("u4", "<task-notification> <task-id>byc4fw3pc")), null);
});

test("a slash command shows as the human typed it, not as the tags around it", () => {
  const m = toMessage(
    userTurn(
      "u5",
      "<command-name>/reload-skills</command-name>\n" +
        "        <command-message>reload-skills</command-message>\n" +
        "        <command-args></command-args>",
    ),
  );
  assert.equal(m?.text, "/reload-skills");
});

test("a command's args stay attached to it, and stay separate words", () => {
  const m = toMessage(
    userTurn("u6", "<command-name>/no-mistakes</command-name><command-args>fix the arrows</command-args>"),
  );
  // Each unwrapped block lands on its own line, so back-to-back tags with no whitespace
  // between them can't fuse into "/no-mistakesfix the arrows".
  assert.equal(m?.text, "/no-mistakes\n\nfix the arrows");
});

test("a caveat wrapping real prose loses the caveat and keeps the prose - with its shape", () => {
  const m = toMessage(
    userTurn(
      "u7",
      "<local-command-caveat>Caveat: ignore this.</local-command-caveat>\n\n" +
        "the stack trace:\n\n    at foo()\n    at bar()\n\nwhy?",
    ),
  );
  // Indentation is the shape of a paste, and blank lines are the author's paragraphs;
  // only the gap the strip left behind is closed up.
  assert.equal(m?.text, "the stack trace:\n\n    at foo()\n    at bar()\n\nwhy?");
});

test("a tag a human MENTIONS in prose is left alone - it's what they said", () => {
  const m = toMessage(userTurn("u8", "why does <command-name> show up in the goal?"));
  assert.equal(m?.text, "why does <command-name> show up in the goal?");
});

test("an assistant turn is never scrubbed - it isn't the channel the plumbing arrives on", () => {
  const m = toMessage({
    type: "assistant",
    uuid: "a9",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "You'll see <system-reminder>x</system-reminder> in the log." }],
    },
  });
  assert.equal(m?.text, "You'll see <system-reminder>x</system-reminder> in the log.");
});

test("parseLines honors the tail limit and ignores malformed lines", () => {
  const msgs = parseLines([asstText, "{not json", asstTool, userPrompt], toMessage, 2);
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

// The "non-claude session" case that used to be asserted here is gone, and not because it
// stopped mattering: this resolver is reachable only through `HARNESSES.claude`, so the
// decision moved UP to the registry, where `harness-transcript.test.ts` pins it. Left in
// place it would have gone quietly green - the probe session it used has no file under a
// fresh root either way, so it would have passed with the agent check deleted.
test("resolveTranscriptPath has nothing to derive from without an id or a cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  assert.equal(resolveTranscriptPath(session({ agentSessionId: null }), root), null);
  assert.equal(resolveTranscriptPath(session({ cwd: null }), root), null);
});

// ---- computeSessionActivity (hook-free idle/working) -----------------------

/** A main-chain record with the given role/stop_reason/timestamp. */
const rec = (over: Record<string, unknown>): string =>
  JSON.stringify({
    type: over.role ?? "assistant",
    isSidechain: false,
    timestamp: "2026-07-11T02:00:00.000Z",
    ...over,
    message: {
      role: over.role ?? "assistant",
      stop_reason: over.stop_reason ?? null,
      content: over.content ?? [{ type: "text", text: "x" }],
    },
  });

test("computeSessionActivity reads idle off a cleanly-ended assistant turn", () => {
  const a = computeSessionActivity([
    rec({ role: "user", content: "go" }),
    rec({ role: "assistant", stop_reason: "end_turn", timestamp: "2026-07-11T02:05:00.000Z" }),
  ]);
  assert.deepEqual(a, { state: "idle", lastActivity: Date.parse("2026-07-11T02:05:00.000Z") });
});

test("computeSessionActivity reads working off a pending tool call", () => {
  const a = computeSessionActivity([
    rec({ role: "assistant", stop_reason: "end_turn" }),
    rec({
      role: "assistant",
      stop_reason: "tool_use",
      timestamp: "2026-07-11T02:06:00.000Z",
      content: [{ type: "tool_use", name: "Bash", input: {} }],
    }),
  ]);
  assert.equal(a?.state, "working");
  assert.equal(a?.lastActivity, Date.parse("2026-07-11T02:06:00.000Z"));
});

test("computeSessionActivity reads working off an unanswered tool result", () => {
  // The interrupted-mid-turn tail (a /clear right after a tool returned): the last
  // main-chain record is a user tool_result with no assistant continuation. Ambiguous
  // by content, so it falls to `working` - the settle-gap age is what proves it idle.
  const a = computeSessionActivity([
    rec({ role: "assistant", stop_reason: "tool_use" }),
    rec({ role: "user", content: [{ type: "tool_result", content: "ok" }] }),
  ]);
  assert.equal(a?.state, "working");
});

test("computeSessionActivity scans newest-first and skips sidechains + undatable tails", () => {
  const a = computeSessionActivity([
    rec({ role: "assistant", stop_reason: "end_turn", timestamp: "2026-07-11T02:01:00.000Z" }),
    rec({ role: "assistant", isSidechain: true, stop_reason: "tool_use" }), // subagent noise
    JSON.stringify({ type: "system", timestamp: "2026-07-11T02:09:00.000Z" }), // no role
    JSON.stringify({ type: "bridge-session" }), // no timestamp, no role
  ]);
  // The newest datable main-chain record is the end_turn assistant - the sidechain and
  // the role-less system/bridge tails are skipped.
  assert.deepEqual(a, { state: "idle", lastActivity: Date.parse("2026-07-11T02:01:00.000Z") });
});

test("computeSessionActivity returns null when nothing datable is found", () => {
  assert.equal(computeSessionActivity([]), null);
  assert.equal(computeSessionActivity(["", "not json", "{}"]), null);
  assert.equal(
    computeSessionActivity([rec({ role: "assistant", stop_reason: "end_turn", timestamp: 42 })]),
    null,
    "a non-string timestamp is not datable",
  );
});
