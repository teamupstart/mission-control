import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
  ClaudeSdkOneShotQueryOptions,
} from "../src/server/harness/claude/sdk-types.ts";

const home = mkdtempSync(join(tmpdir(), "foreman-codex-runner-"));
const argvPath = join(home, "argv");
const fake = join(home, "codex");
process.env.HARNESS_HOME = join(home, "state");
process.env.MISSION_CODEX_BIN = fake;
process.env.CODEX_TEST_ARGV = argvPath;
// The verdict arrives the way the real CLI delivers it under `--json`: as the `text` of an
// `agent_message` item, not as bare stdout. That is the runner's contract now, and a fake
// still printing raw text would be asserting against a CLI this code no longer speaks to.
writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > "$CODEX_TEST_ARGV"
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-review"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"purpose\\":\\"Routine dependency approval.\\",\\"classification\\":\\"access\\",\\"action\\":\\"answer\\",\\"answer\\":{\\"text\\":\\"Approve.\\",\\"submit\\":true},\\"confidence\\":0.99}"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":0}}'
`);
chmodSync(fake, 0o755);

const { reviewSession } = await import("../src/server/foreman/review.ts");
const { configureClaudeRunnerTransport } = await import("../src/server/llm/claude.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("Foreman structured review actually routes through Codex with the selected model", async () => {
  const result = await reviewSession({
    session: {
      agent: "codex",
      runtime: "terminal",
      name: "worker",
      cwd: "/repo",
      gitBranch: "feature",
      state: "idle",
      activity: "waiting",
      goal: "Finish the change",
    },
    surface: "input-review",
    question: "May I read package.json?",
    transcript: [],
    truncated: false,
    instructions: "",
  }, "gpt-5.6-terra", "codex");

  assert.equal(result.kind, "verdict");
  const argv = readFileSync(argvPath, "utf8").split("\n");
  assert.ok(argv.includes("exec"));
  assert.ok(argv.includes("gpt-5.6-terra"));
  assert.ok(argv.includes("features.shell_tool=false"));
});

test("Foreman structured review routes through the SDK transport with tools disabled", async () => {
  let options!: ClaudeSdkOneShotQueryOptions;
  let calls = 0;
  const verdict = {
    purpose: "Routine dependency approval.",
    classification: "access",
    action: "answer",
    answer: { text: "Approve.", submit: true },
    confidence: 0.99,
  };
  const deps: ClaudeSdkOneShotDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async (params) => {
      calls += 1;
      options = params.options;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: JSON.stringify(verdict),
            session_id: "foreman-sdk-review",
          } satisfies ClaudeSdkMessage;
        },
      };
    },
  };
  const restore = configureClaudeRunnerTransport(() => "sdk", deps);
  try {
    const result = await reviewSession({
      session: {
        agent: "claude",
        runtime: "terminal",
        name: "worker",
        cwd: "/repo",
        gitBranch: "feature",
        state: "idle",
        activity: "waiting",
        goal: "Finish the change",
      },
      surface: "input-review",
      question: "May I read package.json?",
      transcript: [],
      truncated: false,
      instructions: "",
    }, "claude-opus-5", "claude");

    assert.deepEqual(result, { kind: "verdict", verdict });
    assert.equal(calls, 1);
    assert.equal(options.model, "claude-opus-5");
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.maxTurns, 1);
    for (const absent of ["resume", "sessionId", "forkSession"]) {
      assert.equal(Object.hasOwn(options, absent), false, `${absent} leaked context into the review`);
    }
  } finally {
    restore();
  }
});
