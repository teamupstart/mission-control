// The `voice-routing` job as the daemon runs it (voice Phase 4): what each transport is handed.
// Thinking off, the job's own short system prompt, a strict schema whose choices are each
// question's own, one attempt, and the provider the caller names with the model the job's
// ladder resolves for that provider. Fake `codex` and `claude` binaries and the Agent SDK seam
// stand in for the providers; nothing here reaches a model.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSdkMessage, ClaudeSdkOneShotDeps, ClaudeSdkOneShotQueryOptions } from "../src/server/harness/claude/sdk-types.ts";
import type { VoiceQuestion } from "../src/shared/voice-decide.ts";

const home = mkdtempSync(join(tmpdir(), "voice-routing-job-"));
const record = (name: string) => join(home, name);
const codex = join(home, "codex");
const claude = join(home, "claude");
process.env.HARNESS_HOME = join(home, "state");
process.env.MISSION_CODEX_BIN = codex;
process.env.MISSION_CLAUDE_BIN = claude;
process.env.VOICE_JOB_RECORD = home;

const ANSWER = { answers: { q1: { choice: "split", confidence: 0.99 } } };

// Each fake records its argv, its stdin and the thinking switch in its environment, then answers
// the way its CLI does: Codex as a `--json` event stream, Claude as the `-p` JSON envelope.
writeFileSync(codex, `#!/bin/sh
printf '%s\\n' "$@" > "$VOICE_JOB_RECORD/codex-argv"
want=0
for a in "$@"; do
  if [ "$want" = "1" ]; then cp "$a" "$VOICE_JOB_RECORD/codex-schema"; want=0; fi
  if [ "$a" = "--output-schema" ]; then want=1; fi
done
cat > "$VOICE_JOB_RECORD/codex-stdin"
if [ -f "$VOICE_JOB_RECORD/block-codex" ]; then
  touch "$VOICE_JOB_RECORD/codex-started"
  sleep 30
fi
printf '%s\\n' '{"type":"thread.started","thread_id":"voice"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(JSON.stringify(ANSWER)).replace(/'/g, "")}}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":90,"cached_input_tokens":0,"output_tokens":9}}'
`);
writeFileSync(claude, `#!/bin/sh
printf '%s\\n' "$@" > "$VOICE_JOB_RECORD/claude-argv"
printf '%s' "$MAX_THINKING_TOKENS" > "$VOICE_JOB_RECORD/claude-thinking"
cat > "$VOICE_JOB_RECORD/claude-stdin"
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"voice","result":${JSON.stringify(JSON.stringify(ANSWER)).replace(/'/g, "")}}'
`);
chmodSync(codex, 0o755);
chmodSync(claude, 0o755);

const { runVoiceRoutingJob } = await import("../src/server/voice/decide.ts");
const { VOICE_ROUTING_SYSTEM_PROMPT } = await import("../src/server/voice/decide-prompt.ts");
const { configureCodexRunnerTransport } = await import("../src/server/llm/codex.ts");
const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const { setLlmConfig } = await import("../src/server/llm/config.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("offline retest summaries distinguish transport-specific results from historical rows", () => {
  const out = join(home, ".tmp", "voice-spike");
  mkdirSync(out, { recursive: true });
  const summarize = (transports: (string | undefined)[]) => {
    const rows = transports.map((transport, index) => ({ id: String(index), runner: "claude", transport,
      category: "split", expected: "split", choice: "split", confidence: 1, member: true, ms: 200, error: null }));
    writeFileSync(join(out, "retest-fixture.jsonl"), rows.map(row => JSON.stringify(row)).join("\n"));
    return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      join(import.meta.dirname, "../scripts/voice-spike/routing-retest.ts"), "--summarize", "fixture"], { cwd: home, encoding: "utf8" });
  };
  for (const mixed of [["sdk", "print"], ["sdk", undefined]]) {
    const result = summarize(mixed);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mixed transports/i);
  }
  for (const transport of ["sdk", "print", undefined]) {
    const result = summarize([transport, transport]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).transport, transport ?? "unrecorded");
  }
});

const QUESTION: VoiceQuestion = {
  kind: "split",
  text: "Steve, check the build, and Alice, review the PR",
  first: { id: "task:steve", label: "Steve", detail: "build engineer" },
  second: { id: "task:alice", label: "Alice", detail: "code reviewer" },
};

test("on Codex: reasoning effort none, the system prompt ahead of the questions, the strict schema and Luna", async () => {
  const answers = await runVoiceRoutingJob([QUESTION], { runner: "codex", timeoutMs: 10_000 });
  assert.deepEqual(answers, [{ choice: "split", confidence: 0.99 }]);
  const argv = readFileSync(record("codex-argv"), "utf8").split("\n");
  assert.ok(argv.includes('model_reasoning_effort="none"'), "thinking is off");
  assert.equal(argv[argv.indexOf("--model") + 1], "gpt-6-luna");
  assert.ok(argv.includes("features.shell_tool=false"), "no tools");
  const stdin = readFileSync(record("codex-stdin"), "utf8");
  assert.ok(stdin.startsWith(VOICE_ROUTING_SYSTEM_PROMPT), "the system prompt leads");
  assert.match(stdin, /Question q1 \(split\):/);
  const schema = JSON.parse(readFileSync(record("codex-schema"), "utf8"));
  assert.deepEqual(schema.properties.answers.properties.q1.properties.choice.enum, ["split", "mention", "not sure"]);
  assert.deepEqual(schema.properties.answers.required, ["q1"]);
});

test("the background effort preview cannot override Luna's measured thinking setting", async (t) => {
  const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
  applyFeatureFlagIntent({ kind: "flag", id: "background-reasoning-effort", enabled: true });
  t.after(() => {
    setLlmConfig({ efforts: { "voice-routing": null } });
    applyFeatureFlagIntent({ kind: "flag", id: "background-reasoning-effort", enabled: false });
  });
  setLlmConfig({ efforts: { "voice-routing": "high" } });
  await runVoiceRoutingJob([QUESTION], { runner: "codex", timeoutMs: 10_000 });
  const settings = readFileSync(record("codex-argv"), "utf8").split("\n");
  assert.deepEqual(settings.filter(arg => arg.startsWith("model_reasoning_effort=")), ['model_reasoning_effort="none"']);
});

test("on Claude through the Agent SDK: thinking disabled, the system prompt replacing Claude Code's, tools off and Haiku", async () => {
  let options!: ClaudeSdkOneShotQueryOptions;
  const deps: ClaudeSdkOneShotDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async (params) => {
      options = params.options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", is_error: false, result: "", structured_output: ANSWER, session_id: "voice" } as ClaudeSdkMessage;
        },
      };
    },
  };
  const restore = configureClaudeRunnerTransport(() => "sdk", deps);
  try {
    const answers = await runVoiceRoutingJob([QUESTION], { runner: "claude", timeoutMs: 10_000 });
    assert.deepEqual(answers, [{ choice: "split", confidence: 0.99 }]);
  } finally {
    restore();
  }
  const seen = options as ClaudeSdkOneShotQueryOptions & { thinking?: unknown; systemPrompt?: unknown; outputFormat?: { schema: { properties: { answers: unknown } } } };
  assert.deepEqual(seen.thinking, { type: "disabled" });
  assert.equal(seen.systemPrompt, VOICE_ROUTING_SYSTEM_PROMPT);
  assert.equal(seen.model, "claude-haiku-4-5");
  assert.deepEqual(seen.tools, []);
  assert.deepEqual(seen.settingSources, []);
  assert.ok(seen.outputFormat, "the schema is enforced by the provider");
});

test("cancelling a voice job waiting for a slot prevents it from starting a provider", async (t) => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const restore = configureClaudeRunnerTransport(() => "sdk", {
    executable: async () => "/fake/bin/claude",
    env: () => ({}),
    query: async () => {
      calls++;
      await held;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", is_error: false, result: "", structured_output: ANSWER } as ClaudeSdkMessage;
        },
      };
    },
  });
  t.after(restore);
  const run = (signal?: AbortSignal) => runVoiceRoutingJob([QUESTION], { runner: "claude", timeoutMs: 10_000, signal });
  const inFlight = Promise.all([run(), run()]);
  const card = new AbortController();
  const queued = run(card.signal);
  card.abort();
  release();
  await Promise.all([inFlight, assert.rejects(queued, { name: "AbortError" })]);
  assert.equal(calls, 2);
});

test("on Claude through claude -p: MAX_THINKING_TOKENS=0 and --system-prompt", async () => {
  const restore = configureClaudeRunnerTransport(() => "print");
  try {
    const answers = await runVoiceRoutingJob([QUESTION], { runner: "claude", timeoutMs: 10_000 });
    assert.deepEqual(answers, [{ choice: "split", confidence: 0.99 }]);
  } finally {
    restore();
  }
  const argv = readFileSync(record("claude-argv"), "utf8").split("\n");
  assert.equal(argv[argv.indexOf("--system-prompt") + 1], VOICE_ROUTING_SYSTEM_PROMPT.split("\n")[0]);
  assert.equal(argv[argv.indexOf("--model") + 1], "claude-haiku-4-5");
  assert.ok(argv.includes("--json-schema"));
  assert.equal(readFileSync(record("claude-thinking"), "utf8"), "0");
});

test("the caller's provider wins over the job's configured one, and the model stays pinned to the measured rung", async () => {
  const codexModel = () => {
    const argv = readFileSync(record("codex-argv"), "utf8").split("\n");
    return argv[argv.indexOf("--model") + 1];
  };
  setLlmConfig({ runners: { "voice-routing": "claude" }, models: { "voice-routing": "claude-sonnet-5" } });
  await runVoiceRoutingJob([QUESTION], { runner: "codex", timeoutMs: 10_000 });
  assert.equal(codexModel(), "gpt-6-luna", "a Claude model is never handed to Codex");
  setLlmConfig({ models: { "voice-routing": "gpt-6-sol" } });
  await runVoiceRoutingJob([QUESTION], { runner: "codex", timeoutMs: 10_000 });
  assert.equal(codexModel(), "gpt-6-luna", "a stored override cannot substitute an unmeasured model");
});

test("cancelling active Luna jobs releases their slots, and clock rollback cannot start expired work", async (t) => {
  let bothStarted!: () => void;
  const started = new Promise<void>(resolve => { bothStarted = resolve; });
  let calls = 0;
  const restore = configureCodexRunnerTransport(() => "sdk", {
    createClient: () => ({ startThread: () => ({
      async run(_prompt, options) {
        if (++calls === 2) bothStarted();
        if (calls <= 2) {
          const signal = options!.signal!;
          await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        }
        return { finalResponse: JSON.stringify(ANSWER) };
      },
    }) }),
  });
  t.after(restore);
  let elapsed = 100;
  t.mock.method(performance, "now", () => elapsed);
  const wall = t.mock.method(Date, "now", () => 10_000);
  const card = new AbortController();
  const run = (timeoutMs: number, signal?: AbortSignal) => runVoiceRoutingJob([QUESTION], { runner: "codex", timeoutMs, signal });
  const active = [run(2000, card.signal), run(2000, card.signal)];
  await started;
  const expired = assert.rejects(run(100), /timed out waiting for a slot/);
  elapsed += 101;
  wall.mock.mockImplementation(() => 1000);
  const next = run(1000);
  card.abort();
  await Promise.all([...active.map(job => assert.rejects(job, /aborted/)), expired]);
  assert.deepEqual(await next, [{ choice: "split", confidence: 0.99 }]);
  assert.equal(calls, 3);
});

test("cancelling a running Codex exec job stops the provider process", async (t) => {
  const restore = configureCodexRunnerTransport(() => "exec");
  t.after(restore);
  writeFileSync(record("block-codex"), "");
  t.after(() => rmSync(record("block-codex"), { force: true }));
  const card = new AbortController();
  const stopped = assert.rejects(runVoiceRoutingJob([QUESTION], { runner: "codex", timeoutMs: 10_000, signal: card.signal }), /aborted/);
  try {
    await t.waitFor(() => assert.ok(existsSync(record("codex-started"))), { timeout: 5000 });
  } finally {
    card.abort();
    await stopped;
  }
});
