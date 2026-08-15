import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertStrictJsonSchema } from "./helpers/strict-json-schema.ts";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
  ClaudeSdkOneShotQueryOptions,
} from "../src/server/harness/claude/sdk-types.ts";

const home = mkdtempSync(join(tmpdir(), "foreman-codex-runner-"));
const argvPath = join(home, "argv");
const schemaPath = join(home, "schema.json");
const replyPath = join(home, "reply.json");
const fake = join(home, "codex");
process.env.HARNESS_HOME = join(home, "state");
process.env.MISSION_CODEX_BIN = fake;
process.env.CODEX_TEST_ARGV = argvPath;
process.env.CODEX_TEST_SCHEMA = schemaPath;
process.env.CODEX_TEST_REPLY = replyPath;
// The verdict arrives the way the real CLI delivers it under `--json`: as the `text` of an
// `agent_message` item, not as bare stdout. That is the runner's contract now, and a fake
// still printing raw text would be asserting against a CLI this code no longer speaks to.
//
// The reply comes from a FILE rather than being baked in, for the reason `goal-refiner.test.ts`
// uses the same trick: `codex.ts` resolves `MISSION_CODEX_BIN` at module load, so the fake
// cannot be swapped once the imports below have run, and different call sites need differently
// shaped replies. The schema is copied out for the same reason it is in `llm-runner-contract`:
// `materializeSchema` deletes the file the moment the run settles.
writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > "$CODEX_TEST_ARGV"
rm -f "$CODEX_TEST_SCHEMA"
want=0
for a in "$@"; do
  if [ "$want" = "1" ]; then cp "$a" "$CODEX_TEST_SCHEMA"; want=0; fi
  if [ "$a" = "--output-schema" ]; then want=1; fi
done
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-review"}'
printf '{"type":"item.completed","item":{"type":"agent_message","text":%s}}\\n' "$(cat "$CODEX_TEST_REPLY")"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":900,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":0}}'
`);
chmodSync(fake, 0o755);

/** Set the next reply, JSON-encoded as the string the `agent_message.text` field carries. */
function replyWith(value: unknown): void {
  writeFileSync(replyPath, JSON.stringify(JSON.stringify(value)));
}
replyWith({
  purpose: "Routine dependency approval.",
  classification: "access",
  action: "answer",
  answer: { text: "Approve.", submit: true },
  confidence: 0.99,
});

const { reviewSession } = await import("../src/server/foreman/review.ts");
const { verifyItem } = await import("../src/server/foreman/queue-verify.ts");
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

// `reviewSession` above sends NO schema, which is why it kept working while the schema-backed
// Foreman calls did not. This is the one that would have failed: `verifyItem` hands Codex the
// real `QUEUE_VERDICT_JSON_SCHEMA` the module holds, and before the fix that schema left
// `gaps`, `resolved` and `confidence` out of `required` - which strict Structured Outputs
// rejects outright with `invalid_json_schema`, failing the call rather than degrading it.
//
// Latent rather than live only because Foreman currently runs on Claude. The moment an
// operator selects Codex, every queue verification stops.
test("Foreman queue verification hands Codex a strict schema and still reads a spare reply", async () => {
  // Every semantic optional declined the way a strict provider declines one: with null, since
  // the key is now always present. This is the reply shape the fix has to keep readable.
  replyWith({
    complete: true,
    summary: "The change is done.",
    gaps: null,
    resolved: null,
    confidence: null,
  });

  const result = await verifyItem(
    {
      session: { name: "worker", cwd: "/repo", gitBranch: "feature" },
      intent: "Finish the change",
      round: 1,
      diff: "diff --git a/a.ts b/a.ts",
      diffTruncated: false,
      diffMayIncludeOtherWork: false,
      transcript: [],
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
      instructions: "",
      priorGaps: [],
    },
    "gpt-5.6-terra",
    "codex",
  );

  assert.equal(result.kind, "verdict");
  assert.equal(result.kind === "verdict" && result.verdict.complete, true);
  // The nulls landed on exactly the defaults an omitted key used to produce. `confidence`
  // matters most: it gates whether the verdict is acted on at all, so a null that failed the
  // parse would have discarded a complete verdict.
  assert.deepEqual(result.kind === "verdict" ? result.verdict.gaps : null, []);
  assert.deepEqual(result.kind === "verdict" ? result.verdict.resolved : null, []);
  assert.equal(result.kind === "verdict" ? result.verdict.confidence : null, 0.5);

  const argv = readFileSync(argvPath, "utf8").split("\n");
  assert.ok(argv.includes("--output-schema"), "the verifier must send its schema at all");
  const sent: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  assertStrictJsonSchema(sent, "QUEUE_VERDICT_JSON_SCHEMA as handed to codex exec");
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
