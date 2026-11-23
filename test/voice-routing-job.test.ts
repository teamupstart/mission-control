// The `voice-routing` job as the daemon runs it (voice Phase 4): what each transport is handed.
// Thinking off, the job's own short system prompt, a strict schema whose choices are each
// question's own, one attempt, and the provider the caller names with the model the job's
// ladder resolves for that provider. Fake `codex` and `claude` binaries and the Agent SDK seam
// stand in for the providers; nothing here reaches a model.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");
const { setLlmConfig } = await import("../src/server/llm/config.ts");

after(() => rmSync(home, { recursive: true, force: true }));

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
