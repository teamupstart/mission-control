import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { assertStrictJsonSchema } from "./helpers/strict-json-schema.ts";
import { PNG_IMAGE, writeImageDescriptor } from "./helpers/llm-image-fixtures.ts";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
  ClaudeSdkOneShotQueryOptions,
} from "../src/server/harness/claude/sdk-types.ts";

// What is at stake here is the CONTRACT, not the call shape. `LlmRunner` exists so the
// app's offline work - Foreman's verdicts, the goal refiner, the titler, the digest, the
// Inspector - can run on a provider other than `claude -p` without any of those callers
// learning about it. Three properties have to survive that indirection, and each one is
// silent when it breaks:
//
//   1. Every run starts from an empty context. The Foreman reviews MANY sessions, so a
//      runner that carried context would grow it across every session it ever looked at
//      and let session A's transcript decide the verdict on session B. Nothing throws; the
//      verdicts just quietly start being about the wrong thing.
//   2. Tools are off unless a caller argued for them, and a grant it cannot fully honour
//      is REFUSED rather than partly applied. Every prompt here embeds untrusted
//      transcript or repo text.
//   3. A run cannot be mistaken for a human's session. A headless run of the agent CLI is
//      that CLI, so it fires the same hooks; inheriting the spawner's pane env once fused
//      two different real cards onto one headless run's uuid.
//
// The fake bin records the argv, the cwd and the env it was handed - which is exactly what
// a provider, and a hook underneath it, would see.
const home = mkdtempSync(join(tmpdir(), "llm-runner-"));
process.env.HARNESS_HOME = join(home, "state");

const RUN_ARGS = join(home, "args");
const RUN_CWD = join(home, "cwd");
const RUN_ENV = join(home, "env");
const RUN_SCHEMA_PATH = join(home, "schema-path");
const RUN_SCHEMA = join(home, "schema");
const RUN_STDIN = join(home, "stdin");
const RUN_ORPHAN_READY = join(home, "orphan-ready");
process.env.RUN_ARGS = RUN_ARGS;
process.env.RUN_CWD = RUN_CWD;
process.env.RUN_ENV = RUN_ENV;
process.env.RUN_SCHEMA_PATH = RUN_SCHEMA_PATH;
process.env.RUN_SCHEMA = RUN_SCHEMA;
process.env.RUN_STDIN = RUN_STDIN;
process.env.RUN_NODE = process.execPath;
process.env.RUN_ORPHAN_READY = RUN_ORPHAN_READY;

const fakeBin = join(home, "fake-claude.sh");
writeFileSync(
  fakeBin,
  `#!/bin/sh
cat > "$RUN_STDIN"
: > "$RUN_ARGS"
for a in "$@"; do printf '%s\\n' "$a" >> "$RUN_ARGS"; done
pwd > "$RUN_CWD"
printf '%s\\n%s\\n%s\\n' "$TMUX_PANE" "$WEZTERM_PANE" "$MISSION_HEADLESS" > "$RUN_ENV"
printf '{"result":"the model text"}'
`,
);
chmodSync(fakeBin, 0o755);
// Before the import: `claude-cli.ts` resolves the binary at module load.
process.env.MISSION_CLAUDE_BIN = fakeBin;

const fakeCodexBin = join(home, "fake-codex.sh");
writeFileSync(
  fakeCodexBin,
  `#!/bin/sh
cat > "$RUN_STDIN"
: > "$RUN_ARGS"
want_schema=0
for a in "$@"; do
  printf '%s\\n' "$a" >> "$RUN_ARGS"
  if [ "$want_schema" = "1" ]; then
    printf '%s\\n' "$a" > "$RUN_SCHEMA_PATH"
    cp "$a" "$RUN_SCHEMA"
    want_schema=0
  elif [ "$a" = "--output-schema" ]; then
    want_schema=1
  fi
done
pwd > "$RUN_CWD"
printf '%s\\n%s\\n%s\\n' "$TMUX_PANE" "$WEZTERM_PANE" "$MISSION_HEADLESS" > "$RUN_ENV"
if [ "$RUN_CODEX_FAIL" = "1" ]; then
  printf '%s\\n' 'STDERR OPERATOR BRIEF MUST NOT LEAK' >&2
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"OPERATOR BRIEF MUST NOT LEAK"}}'
  printf '%s\\n' '{"type":"turn.failed","error":{"message":"schema validation failed: missing tasks"}}'
  exit 1
fi
if [ "$RUN_CODEX_ORPHAN" = "1" ]; then
  # A survivor holding this run's stdout from ANOTHER session, which is what the group kill
  # cannot reach - the shape a real launcher leaves when it hands off to a helper. A plain
  # '( ... ) &' would not do: a non-interactive shell puts it in the same process group, so
  # the group kill gets it and nothing is proven. Spawning detached from node calls setsid,
  # and fd 1 is this run's stdout, so the pipe stays open after the shell is gone.
  "$RUN_NODE" -e 'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},6000)"],{detached:true,stdio:["ignore",1,2]}).unref()'
  : > "$RUN_ORPHAN_READY"
  sleep 30
fi
if [ "$RUN_CODEX_WAIT" = "1" ]; then
  sleep 30
fi
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-abc"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"ignore me"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"the codex text"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":200,"cache_write_input_tokens":100,"output_tokens":40,"reasoning_output_tokens":10}}'
`,
);
chmodSync(fakeCodexBin, 0o755);
process.env.MISSION_CODEX_BIN = fakeCodexBin;

const { LLM_RUNNERS, DEFAULT_LLM_RUNNER_ID, allLlmRunners, llmRunner } = await import(
  "../src/server/llm/index.ts"
);
const {
  CLAUDE_GRANTABLE_TOOLS,
  claudeGrantSettings,
  claudeRunner,
  claudeSpendReport,
  configureClaudeRunnerTransport,
} = await import("../src/server/llm/claude.ts");
const { codexRunner } = await import("../src/server/llm/codex.ts");
const { setLlmSpendSink } = await import("../src/server/llm/spend.ts");
type LlmSpendReport = import("../src/shared/llm-spend.ts").LlmSpendReport;
const { HEADLESS_CWD } = await import("../src/server/claude-cli.ts");
const { parseModelJson, runStructured, unwrapEnvelope } = await import("../src/server/llm/structured.ts");
const { LLM_RUNNER_IDS, grantRefusal } = await import("../src/shared/llm.ts");
// The one caller that holds tools, and therefore the one that decides whether the grant
// shape fits. Imported for its real constants: an equality asserted against a copy of them
// would prove only that the copy matches itself.
const { DENY_PATHS, DENY_SETTINGS, REVIEW_TOOLS } = await import("../src/server/inspector/worker.ts");

const { providerJsonSchema } = await import("../src/server/llm/json-schema.ts");
const { InspectorVerdictSchema, InspectorReplySchema } = await import(
  "../src/server/inspector/verdict.ts"
);
const { BacklogReportSchema } = await import("../src/server/foreman/backlog-plan.ts");
const { QueueVerdictSchema } = await import("../src/server/foreman/queue-verify.ts");
const { TriageReportSchema } = await import("../src/server/foreman/triage.ts");

/**
 * The schemas real call sites hand to `LlmRunOptions.schema`, rendered the same way they
 * render them. `providerJsonSchema` is deterministic, so this is the same object each call
 * site holds; that every such call site is represented here is proved separately, by the
 * source scan in `provider-json-schema.test.ts`.
 */
const CALL_SITE_SCHEMAS = {
  "the Inspector verdict": providerJsonSchema(InspectorVerdictSchema),
  "the Inspector reply": providerJsonSchema(InspectorReplySchema),
  "the Foreman backlog plan": providerJsonSchema(BacklogReportSchema),
  "the Foreman queue verdict": providerJsonSchema(QueueVerdictSchema),
  "the Foreman tier-1 triage report": providerJsonSchema(TriageReportSchema),
};

/** Lines a `printf '%s\n'`-per-item file holds, without the trailing empty element. */
function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").slice(0, -1);
}

function argv(): string[] {
  return lines(RUN_ARGS);
}

/** The value `flag` was given, or null when the flag is absent. */
function flag(name: string): string | null {
  const args = argv();
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function clearRecording(): void {
  for (const f of [RUN_ARGS, RUN_CWD, RUN_ENV, RUN_SCHEMA_PATH, RUN_SCHEMA, RUN_STDIN, RUN_ORPHAN_READY]) {
    rmSync(f, { force: true });
  }
}

async function assertSoon(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition did not become true before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeClaudeSdk(): {
  deps: ClaudeSdkOneShotDeps;
  calls(): number;
  options(): ClaudeSdkOneShotQueryOptions | null;
} {
  let calls = 0;
  let options: ClaudeSdkOneShotQueryOptions | null = null;
  return {
    calls: () => calls,
    options: () => options,
    deps: {
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
              result: "the sdk model text",
              session_id: "sdk-run-1",
            } satisfies ClaudeSdkMessage;
          },
        };
      },
    },
  };
}

async function withPrintTransport<T>(run: () => Promise<T>): Promise<T> {
  const restore = configureClaudeRunnerTransport(() => "print");
  try {
    return await run();
  } finally {
    restore();
  }
}

test("the registry answers for every declared runner", () => {
  // The whole enforcement mechanism: a new id that is not implemented must not compile,
  // and this catches the other half - an entry filed under the wrong key, which typecheck
  // cannot see because both sides are the same union.
  assert.deepEqual(Object.keys(LLM_RUNNERS).sort(), [...LLM_RUNNER_IDS].sort());
  for (const id of LLM_RUNNER_IDS) {
    assert.equal(LLM_RUNNERS[id].id, id, `${id} is filed under someone else's key`);
    assert.ok(LLM_RUNNERS[id].label.trim().length > 0, `${id} has no label to display`);
  }
  assert.equal(allLlmRunners().length, LLM_RUNNER_IDS.length);
  assert.equal(llmRunner().id, DEFAULT_LLM_RUNNER_ID, "the no-argument runner is the default");
});

test("a run carries no way to see a previous one", async () => {
  await withPrintTransport(() =>
    claudeRunner.run("summarise this session", { model: "claude-haiku-4-5", timeoutMs: 5000 })
  );
  const args = argv();
  // Absence is the guarantee, so absence is what is asserted. Without one of these three
  // flags every `claude -p` mints a new session with an empty context; WITH one, Foreman's
  // context would grow across every session it ever reviewed and one session's transcript
  // could decide another's verdict. A "hold the process open to skip the spawn"
  // optimisation reintroduces exactly this, and is worth ~2s of a 4-6s call.
  for (const forbidden of ["--resume", "--continue", "--session-id"]) {
    assert.equal(args.includes(forbidden), false, `a run passed ${forbidden}: context is no longer fresh`);
  }
  assert.ok(args.includes("-p"), "not a one-shot run");
  assert.equal(flag("--model"), "claude-haiku-4-5", "the caller's model did not reach the provider");
});

test("the Claude runner routes an sdk transport choice through the SDK one-shot", async () => {
  clearRecording();
  const fake = fakeClaudeSdk();
  const restore = configureClaudeRunnerTransport(() => "sdk", fake.deps);
  try {
    const text = await claudeRunner.run("summarise this session", { timeoutMs: 5000 });
    assert.equal(text, "the sdk model text");
    assert.equal(fake.calls(), 1, "the configured SDK transport did not construct a query");
    assert.deepEqual(fake.options()?.tools, []);
    assert.equal(Object.hasOwn(fake.options() ?? {}, "settings"), false);
    assert.equal(existsSync(RUN_ARGS), false, "the SDK route also spawned the print binary");
  } finally {
    restore();
  }
});

test("a grant follows the configured SDK transport with the Inspector's exact sandbox", async () => {
  clearRecording();
  const fake = fakeClaudeSdk();
  const dir = mkdtempSync(join(tmpdir(), "llm-sdk-grant-"));
  const restore = configureClaudeRunnerTransport(() => "sdk", fake.deps);
  try {
    const text = await claudeRunner.run("review this diff", {
      timeoutMs: 5000,
      grant: { tools: [...CLAUDE_GRANTABLE_TOOLS], cwd: dir, denyPaths: DENY_PATHS },
    });
    assert.equal(text, "the sdk model text");
    assert.equal(fake.calls(), 1);
    assert.equal(existsSync(RUN_ARGS), false, "the granted SDK call also spawned print");
    assert.deepEqual(fake.options()?.tools, REVIEW_TOOLS.split(","));
    assert.equal(fake.options()?.cwd, realpathSync(dir));
    assert.equal(fake.options()?.settings, DENY_SETTINGS);
    assert.deepEqual(fake.options()?.settingSources, []);
    assert.equal(Object.hasOwn(fake.options() ?? {}, "maxTurns"), false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude renders an exact JSON Schema and omits the flag when none was supplied", async () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  await withPrintTransport(async () => {
    await claudeRunner.run("answer as JSON", { timeoutMs: 5000, schema });
    assert.equal(flag("--json-schema"), JSON.stringify(schema));
    assert.deepEqual(claudeRunner.structuredOutput, { guaranteesInputShape: true });

    await claudeRunner.run("answer as text", { timeoutMs: 5000 });
    assert.equal(flag("--json-schema"), null);
  });
});

test("a run without a grant has every tool disabled, in a directory of no consequence", async () => {
  await withPrintTransport(() =>
    claudeRunner.run("summarise this session", { timeoutMs: 5000 })
  );
  assert.equal(flag("--tools"), "", "tools were not disabled for an ungranted run");
  assert.equal(flag("--settings"), null, "an ungranted run should carry no permission payload");
  // Not the daemon's cwd and not a repo: with no tools a working directory is meaningless
  // to the run, and a real one only risks it noticing a checkout it has no business in.
  assert.equal(lines(RUN_CWD)[0], realpathSync(HEADLESS_CWD));
});

test("the provider's envelope never reaches the caller", async () => {
  // `--output-format json` is this runner's own flag, so unwrapping `{ result: "…" }` is
  // its own job. A caller that did it would be undoing its runner's choice, and would
  // break outright against a provider whose envelope looks different.
  const text = await withPrintTransport(() =>
    claudeRunner.run("summarise this session", { timeoutMs: 5000 })
  );
  assert.equal(text, "the model text");
});

test("envelope unwrapping accepts result text but never mistakes an object result for the reply", () => {
  assert.equal(unwrapEnvelope('{"result":"the model text"}'), "the model text");
  const objectResult = '{"result":{"answer":"yes"},"session_id":"run-1"}';
  assert.equal(unwrapEnvelope(objectResult), objectResult);
  assert.notEqual(unwrapEnvelope(objectResult), '{"answer":"yes"}');
});

test("Codex passes a materialized schema, cleans it up, and keeps command tools disabled", async () => {
  const schema = {
    type: "object",
    properties: { tasks: { type: "array" } },
    required: ["tasks"],
    additionalProperties: false,
  };
  const text = await codexRunner.run("summarise this session", {
    model: "gpt-5.6-sol",
    timeoutMs: 5000,
    schema,
  });
  const args = argv();
  assert.equal(text, "the codex text");
  assert.ok(args.includes("exec"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.equal(flag("--sandbox"), "read-only");
  assert.equal(flag("--model"), "gpt-5.6-sol");
  assert.ok(args.includes("features.shell_tool=false"));
  assert.ok(args.includes("features.unified_exec=false"));
  // The event stream, not the human transcript. Load-bearing twice over: it is what makes
  // the returned text the model's own `agent_message` rather than a banner the caller has
  // to parse around, and an `--ephemeral` run writes no rollout file, so this is the only
  // place its token usage is ever stated.
  assert.ok(args.includes("--json"));
  const schemaPath = lines(RUN_SCHEMA_PATH)[0]!;
  assert.equal(flag("--output-schema"), schemaPath);
  assert.deepEqual(JSON.parse(readFileSync(RUN_SCHEMA, "utf8")), schema);
  assert.equal(existsSync(schemaPath), false, "the per-run schema file survived the process");
  assert.equal(
    codexRunner.structuredOutput,
    null,
    "argv coverage alone must not advertise real-CLI mismatch enforcement",
  );
  for (const forbidden of ["resume", "--dangerously-bypass-approvals-and-sandbox"]) {
    assert.equal(args.includes(forbidden), false);
  }
  assert.equal(lines(RUN_ENV)[2], "1");
});

// The test above proves the plumbing with a schema written by hand, which is exactly the gap
// that let `invalid_json_schema` reach production: the hand-written literal already listed
// every key in `required`, while every schema a REAL call site renders did not. Codex hands
// this file to strict Structured Outputs, so a schema that omits one key of `properties` from
// `required` fails the whole call - which is what the Inspector did on every open pull request.
//
// So run the real ones through the real runner and check the bytes Codex actually received.
// Rendering them in isolation is a weaker claim; this pins the file on disk at the far end of
// `materializeSchema`, past every place the schema could have been substituted.
for (const [label, rendered] of Object.entries(CALL_SITE_SCHEMAS)) {
  test(`Codex receives a strict Structured Outputs schema for ${label}`, async () => {
    clearRecording();
    await codexRunner.run("review this", { model: "gpt-5.6-sol", timeoutMs: 5000, schema: rendered });
    const onDisk = JSON.parse(readFileSync(RUN_SCHEMA, "utf8")) as unknown;
    assert.deepEqual(onDisk, rendered, "the file Codex read must be the schema we rendered");
    assertStrictJsonSchema(onDisk, `${label} as handed to codex exec --output-schema`);
  });
}

test("Codex omits the schema flag when none was supplied", async () => {
  clearRecording();
  await codexRunner.run("answer as text", { timeoutMs: 5000 });
  assert.equal(flag("--output-schema"), null);
  assert.equal(existsSync(RUN_SCHEMA_PATH), false);
});

test("Codex text-only and empty-image calls retain the exact historical argv and stdin", async () => {
  const expected = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-c",
    'approval_policy="never"',
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.unified_exec=false",
    "--json",
    "-",
  ];
  for (const images of [undefined, []] as const) {
    clearRecording();
    await codexRunner.run("text-only prompt", { timeoutMs: 5_000, images });
    assert.deepEqual(argv(), expected);
    assert.equal(readFileSync(RUN_STDIN, "utf8"), "text-only prompt");
  }
});

test("Codex appends repeated ordered image arguments before the stdin prompt", async () => {
  const dir = mkdtempSync(join(home, "codex-images-"));
  try {
    const first = writeImageDescriptor(dir, "first.png", PNG_IMAGE, "image/png", "first");
    const second = writeImageDescriptor(dir, "second.png", PNG_IMAGE, "image/png", "second");
    clearRecording();
    await codexRunner.run("compare these", { timeoutMs: 5_000, images: [first, second] });
    assert.deepEqual(argv().slice(-5), [
      "--image",
      first.path,
      "--image",
      second.path,
      "-",
    ]);
    assert.equal(readFileSync(RUN_STDIN, "utf8"), "compare these");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex refuses an unreadable image before spawning", async () => {
  const dir = mkdtempSync(join(home, "codex-refusal-"));
  try {
    const image = writeImageDescriptor(dir, "gone.png", PNG_IMAGE, "image/png", "gone");
    rmSync(image.path);
    clearRecording();
    await assert.rejects(
      codexRunner.run("inspect this", { timeoutMs: 5_000, images: [image] }),
      /LLM image input refused/,
    );
    assert.equal(existsSync(RUN_ARGS), false, "an invalid image still spawned codex exec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex keeps a bounded JSON-stream failure reason without leaking agent text", async () => {
  clearRecording();
  process.env.RUN_CODEX_FAIL = "1";
  try {
    await assert.rejects(
      codexRunner.run("the real operator brief", {
        timeoutMs: 5000,
        schema: { type: "object" },
      }),
      (err: Error) => {
        assert.match(err.message, /codex exited 1: schema validation failed: missing tasks/);
        assert.doesNotMatch(err.message, /STDERR|OPERATOR BRIEF|real operator brief/);
        assert.ok(err.message.length <= 340, "the bounded provider diagnostic grew without limit");
        return true;
      },
    );
    const schemaPath = lines(RUN_SCHEMA_PATH)[0]!;
    assert.equal(existsSync(schemaPath), false, "a failed run kept its schema file");
  } finally {
    delete process.env.RUN_CODEX_FAIL;
  }
});

test("Codex cleans a live schema synchronously when shutdown kills the run", async () => {
  clearRecording();
  process.env.RUN_CODEX_WAIT = "1";
  const run = codexRunner.run("wait for shutdown", {
    timeoutMs: 5000,
    schema: { type: "object" },
  });
  try {
    await assertSoon(() => existsSync(RUN_SCHEMA_PATH));
    const schemaPath = lines(RUN_SCHEMA_PATH)[0]!;
    assert.equal(existsSync(schemaPath), true);

    codexRunner.killLiveRuns?.();
    assert.equal(existsSync(schemaPath), false, "shutdown left the live schema directory behind");
    await assert.rejects(run, /codex exited/);
  } finally {
    delete process.env.RUN_CODEX_WAIT;
    codexRunner.killLiveRuns?.();
  }
});

test("a killed Codex run settles when the process dies, not when its stdio does", async () => {
  // The failure this pins is a HANG, and it hid behind a wrong error message. `close` fires
  // only once nothing holds the run's stdio, so a survivor of the kill - a helper the group
  // signal could not reach - kept the promise pending until the run's own `timeoutMs` fired
  // and reported "timed out" for work that was killed immediately. Killing must settle the
  // run at the process's death, which is a fact about the process rather than about who else
  // is holding a pipe.
  clearRecording();
  process.env.RUN_CODEX_ORPHAN = "1";
  const started = Date.now();
  // Far longer than this should ever take, so a pass cannot come from the timeout instead.
  const run = codexRunner.run("wait for shutdown", { timeoutMs: 60_000 });
  try {
    await assertSoon(() => existsSync(RUN_ORPHAN_READY));
    codexRunner.killLiveRuns?.();
    await assert.rejects(run, /codex exited/);
    const elapsed = Date.now() - started;
    // Well under the 6s the survivor holds the pipe for: this is the whole assertion, and a
    // looser bound would pass on the `close` that eventually arrives when the survivor exits.
    assert.ok(elapsed < 3_000, `a killed run must settle at once, took ${elapsed}ms`);
  } finally {
    delete process.env.RUN_CODEX_ORPHAN;
    codexRunner.killLiveRuns?.();
  }
});

test("provider validation trims only the retry, never the caller's Zod parse", async () => {
  const schema = z.object({ answer: z.string().transform((value) => value.trim()) });
  let guaranteedCalls = 0;
  let guaranteedParses = 0;
  const guaranteed = await runStructured(
    async () => {
      guaranteedCalls += 1;
      return "{}";
    },
    "answer as JSON",
    (raw) => {
      guaranteedParses += 1;
      return parseModelJson(raw, schema);
    },
    "The test model",
    undefined,
    { shapeGuaranteed: true },
  );
  assert.equal(guaranteed.kind, "failed");
  assert.equal(guaranteedCalls, 1);
  assert.equal(guaranteedParses, 1, "provider validation must not bypass safeParse");

  let defaultCalls = 0;
  const retried = await runStructured(
    async () => {
      defaultCalls += 1;
      return "{}";
    },
    "answer as JSON",
    (raw) => parseModelJson(raw, schema),
  );
  assert.equal(retried.kind, "failed");
  assert.equal(defaultCalls, 2, "the default ladder remains available to lossy or unsupported schemas");

  const transformed = await runStructured(
    async () => '{"answer":"  yes  "}',
    "answer as JSON",
    (raw) => parseModelJson(raw, schema),
    "The test model",
    undefined,
    { shapeGuaranteed: true },
  );
  assert.deepEqual(transformed, { kind: "ok", value: { answer: "yes" } });
});

test("a Codex run reports what it spent, under the role that asked for it", async () => {
  clearRecording();
  const seen: LlmSpendReport[] = [];
  const previous = setLlmSpendSink((r) => void seen.push(r));
  try {
    await codexRunner.run("verify this item", { model: "gpt-5.6-terra", role: "foreman:verify" });
  } finally {
    setLlmSpendSink(previous);
  }
  assert.equal(seen.length, 1);
  const report = seen[0]!;
  assert.equal(report.role, "foreman:verify");
  assert.equal(report.runner, "codex");
  // The thread id is the dedup identity: a retried report must replace its own row rather
  // than add a second one.
  assert.equal(report.runId, "thread-abc");
  // Codex reports `input_tokens` INCLUSIVE of both cache tiers; the ledger stores them
  // disjoint. 1200 - 200 - 100 = 900 is that subtraction, and getting it wrong would
  // inflate every headless row by the cached tier forever.
  assert.deepEqual(report.models, [{
    modelId: "gpt-5.6-terra",
    input: 900,
    output: 40,
    reasoningOutput: 10,
    cacheRead: 200,
    cacheWrite: 100,
    reportedCostUsd: null,
  }]);
});

test("a Claude envelope is read for the run's own id, models and reported cost", () => {
  // A REAL envelope, captured from `claude -p --output-format json --tools ""` on this
  // machine and trimmed only of fields the parser ignores. A hand-written approximation
  // would prove the parser matches the approximation.
  const raw = JSON.stringify({
    is_error: false,
    subtype: "success",
    result: "OK",
    session_id: "19de2f1f-c04d-4cfd-a218-719095efe008",
    total_cost_usd: 0.013531,
    usage: {
      input_tokens: 9,
      cache_creation_input_tokens: 6661,
      cache_read_input_tokens: 0,
      output_tokens: 40,
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 9,
        outputTokens: 40,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 6661,
        costUSD: 0.013531,
        canonicalModel: "claude-haiku-4-5",
      },
    },
  });
  const report = claudeSpendReport(raw, "inspector:review", "opus", 1_700_000_000_000);
  assert.ok(report);
  // The run's own minted session id. This is what makes the row dedup - and it is the same
  // id its OTel export arrives under, which is how that twin is later excluded from session
  // spend instead of billing the run twice.
  assert.equal(report.runId, "19de2f1f-c04d-4cfd-a218-719095efe008");
  // The model that ACTUALLY served the request, not the "opus" that was asked for.
  assert.deepEqual(report.models, [{
    modelId: "claude-haiku-4-5-20251001",
    input: 9,
    output: 40,
    reasoningOutput: 0,
    cacheRead: 0,
    cacheWrite: 6661,
    reportedCostUsd: 0.013531,
  }]);
  // Anthropic reports the input tier already exclusive of cache, so unlike Codex there is
  // no subtraction to do - asserting the raw 9 is what would catch someone adding one.
  assert.equal(claudeRunner.price(report.models[0]!)?.basis, "reported");
  assert.equal(claudeRunner.price(report.models[0]!)?.costUsd, 0.013531);
});

test("an envelope that states no usage produces no report", () => {
  // The fake claude bin returns exactly this shape, and a failed run returns it for real -
  // an auth fast-fail reports zeroes. A $0 row for a call that never reached the model
  // would put a fictitious run in the automation line.
  assert.equal(
    claudeSpendReport('{"result":"the model text"}', "foreman:review", "opus", 1),
    null,
  );
});

test("a run with no role reports nothing at all", async () => {
  clearRecording();
  const seen: LlmSpendReport[] = [];
  const previous = setLlmSpendSink((r) => void seen.push(r));
  try {
    await codexRunner.run("summarise", { model: "gpt-5.6-terra" });
  } finally {
    setLlmSpendSink(previous);
  }
  // Accounting is opt-in per call site, so a caller that has not been given a role - a
  // workflow step, a future subsystem - stays out of the automation line rather than
  // landing in whichever bucket happened to be last.
  assert.equal(seen.length, 0);
});

test("Codex refuses Inspector-style tool grants instead of weakening their deny rules", async () => {
  clearRecording();
  await assert.rejects(
    codexRunner.run("review", {
      grant: { tools: ["Read"], cwd: "/tmp/checkout", denyPaths: ["**/.env"] },
    }),
    /refused the tool grant/,
  );
  assert.equal(existsSync(RUN_ARGS), false);
});

test("a run cannot be attributed to the card the daemon was launched from", async () => {
  const prev = { tmux: process.env.TMUX_PANE, wez: process.env.WEZTERM_PANE };
  process.env.TMUX_PANE = "%42";
  process.env.WEZTERM_PANE = "7";
  try {
    await withPrintTransport(() =>
      claudeRunner.run("summarise this session", { timeoutMs: 5000 })
    );
  } finally {
    if (prev.tmux === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prev.tmux;
    if (prev.wez === undefined) delete process.env.WEZTERM_PANE;
    else process.env.WEZTERM_PANE = prev.wez;
  }
  const [tmuxPane, weztermPane, marker] = lines(RUN_ENV);
  // The pane ids are what `overlayKeyFromEnv` binds a hook event on; the marker is the
  // independent second layer, letting a hook decline to report the run at all. Both,
  // because the hook script is installed globally from a checkout that may lag this code.
  assert.equal(tmuxPane, "", "the run inherited a tmux pane and would impersonate that card");
  assert.equal(weztermPane, "", "the run inherited a wezterm pane and would impersonate that card");
  assert.equal(marker, "1", "the run is not marked headless for the hook to see");
});

test("a tool grant renders exactly the deny rules the Inspector ships today", () => {
  const rendered = claudeGrantSettings({
    tools: REVIEW_TOOLS.split(","),
    cwd: "/tmp/checkout",
    denyPaths: DENY_PATHS,
  });
  // Byte-for-byte, against the Inspector's own constant. This is what makes migrating that
  // call site onto the runner a provable no-op: the reviewer keeps the identical sandbox,
  // not a similar one. If this ever has to change, the deny list on a live PR review is
  // what changed with it.
  assert.equal(rendered, DENY_SETTINGS);
  // The generalisation that produces it: every path denied for every tool held, because
  // `Grep` on an absolute path prints the lines a `Read(...)`-only rule pretended to
  // protect, and `Glob` confirms the file is there.
  assert.equal(
    claudeGrantSettings({ tools: ["Read", "Grep"], cwd: "/tmp/checkout", denyPaths: ["**/.env"] }),
    JSON.stringify({ permissions: { deny: ["Read(**/.env)", "Grep(**/.env)"] } }),
  );
});

test("a granted run is scoped to the grant's directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-grant-"));
  await withPrintTransport(() =>
    claudeRunner.run("review this diff", {
      timeoutMs: 5000,
      grant: { tools: [...CLAUDE_GRANTABLE_TOOLS], cwd: dir, denyPaths: DENY_PATHS },
    })
  );
  assert.equal(flag("--tools"), "Read,Grep,Glob");
  assert.equal(flag("--settings"), DENY_SETTINGS);
  // The cwd is not a convenience here: under a one-shot run there is nobody to approve a
  // read outside it, so the directory IS the read scope that pays for the tools.
  assert.equal(lines(RUN_CWD)[0], realpathSync(dir));
});

test("a grant this runner cannot honour is refused before anything is spawned", async () => {
  const cases: Array<[string, { tools: string[]; cwd: string; denyPaths: string[] }]> = [
    ["a tool outside the read-only set", { tools: ["Read", "Bash"], cwd: "/tmp", denyPaths: [] }],
    ["a relative cwd", { tools: ["Read"], cwd: "checkout", denyPaths: [] }],
    ["no tools at all", { tools: [], cwd: "/tmp", denyPaths: [] }],
  ];
  const fake = fakeClaudeSdk();
  const restore = configureClaudeRunnerTransport(() => "sdk", fake.deps);
  try {
    for (const [what, grant] of cases) {
      clearRecording();
      await assert.rejects(
        claudeRunner.run("review this diff", { timeoutMs: 5000, grant }),
        /refused the tool grant/,
        `${what} was accepted`,
      );
      // Refused, not partly applied: a caller that asked for a deny list and silently did not
      // get one cannot tell until something it named turns up in a prompt.
      assert.equal(existsSync(RUN_ARGS), false, `${what} still spawned a print run`);
      assert.equal(fake.calls(), 0, `${what} still constructed an SDK query`);
    }
  } finally {
    restore();
  }
});

test("a runner with no sandbox refuses every grant", () => {
  // `null` is a real answer rather than a stub - a provider with no way to bound a tool
  // grant must decline one. Asserted on the shared predicate because that is what a future
  // runner inherits; nothing about this is Claude-specific.
  assert.match(
    grantRefusal(null, { tools: ["Read"], cwd: "/tmp", denyPaths: [] }) ?? "",
    /cannot sandbox/,
  );
  assert.equal(grantRefusal(claudeRunner.sandbox, { tools: ["Read"], cwd: "/tmp", denyPaths: [] }), null);
});

test("the runner declares the litter its runs leave behind", () => {
  // Every run writes a real transcript that nothing reads and nothing used to delete - 153
  // of 250 transcripts sampled on one machine were this app's. A provider that litters has
  // to say where, or the sweeper learns about it when someone's disk fills.
  assert.ok(claudeRunner.litter, "the claude runner leaves transcripts and must declare them");
  assert.equal(claudeRunner.litter.ext, ".jsonl");
  assert.ok(claudeRunner.litter.dir().startsWith("/"), "the litter directory must be absolute");
  assert.equal(typeof claudeRunner.killLiveRuns, "function");
  // Null rather than a throwing stub, so a caller can branch on the absence. If it is ever
  // implemented the key must be one supervised session, never a shared thread.
  assert.equal(claudeRunner.runInThread, null);
});
