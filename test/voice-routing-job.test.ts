// The `voice-routing` job as the daemon runs it (voice Phase 4): what each transport is handed.
// Thinking off, the job's own short system prompt, a strict schema whose choices are each
// question's own, one attempt, and the provider the caller names with the model the job's
// ladder resolves for that provider. Fake `codex` and `claude` binaries and the Agent SDK seam
// stand in for the providers; nothing here reaches a model.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
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

const retestArgs = ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "../scripts/voice-spike/routing-retest.ts")];
const retestEnv = { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "../tsconfig.json") };
function retest(...args: string[]) {
  return spawnSync(process.execPath, [...retestArgs, ...args], { cwd: home, encoding: "utf8", env: retestEnv });
}

test("offline retest summaries distinguish transport-specific results from historical rows", () => {
  const out = join(home, ".tmp", "voice-spike");
  mkdirSync(out, { recursive: true });
  const summarize = (transports: (string | undefined)[]) => {
    const rows = transports.map((transport, index) => ({ id: String(index), runner: "claude", transport,
      category: "split", expected: "split", choice: "split", confidence: 1, member: true, ms: 200, error: null }));
    writeFileSync(join(out, "retest-fixture A+B.1.jsonl"), rows.map(row => JSON.stringify(row)).join("\n"));
    return retest("--summarize", "fixture A+B.1");
  };
  for (const mixed of [["sdk", "print"], ["sdk", undefined]]) {
    const result = summarize(mixed);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mixed transports/i);
  }
  for (const transport of ["sdk", "print", undefined]) {
    const result = summarize([transport, transport]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.transport, transport ?? "unrecorded");
    assert.equal(summary.corpusSha256, "unrecorded");
  }
});

const QUESTION: VoiceQuestion = {
  kind: "split",
  text: "Steve, check the build, and Alice, review the PR",
  first: { id: "task:steve", label: "Steve", detail: "build engineer" },
  second: { id: "task:alice", label: "Alice", detail: "code reviewer" },
};

test("the retest sends the specified occurrence of a repeated name through the job prompt", () => {
  const text = "Steve, Alice is busy. Alice, review the PR";
  const nameOffset = text.lastIndexOf("Alice");
  const cases = record("split-cases.json");
  const run = (label: string) => retest("--yes", "--transport", "print", "--cases", cases, "--label", label);
  const corpus = { roster: { Steve: "build", Alice: "review" }, cards: {}, cases: [{ id: "repeat", category: "split",
    question: { kind: "split", first: "Steve", second: "Alice", nameOffset, text }, expected: "split" }] };
  writeFileSync(cases, JSON.stringify(corpus));
  const result = run("occurrence");
  assert.equal(result.status, 0, result.stderr);
  const prompt = readFileSync(record("claude-stdin"), "utf8");
  assert.ok(prompt.includes(`Judge only the name at offset ${nameOffset}.`));
  assert.ok(prompt.includes(JSON.stringify(text.slice(nameOffset))));
  const row = JSON.parse(readFileSync(join(home, ".tmp/voice-spike/retest-occurrence.jsonl"), "utf8"));
  assert.equal(row.nameOffset, nameOffset);
  const args = readFileSync(record("claude-argv"), "utf8").split("\n");
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]!);
  assert.equal(row.promptSchemaSha256, createHash("sha256").update(JSON.stringify(VOICE_ROUTING_SYSTEM_PROMPT))
    .update(JSON.stringify([prompt, schema])).digest("hex"));
  corpus.cases.push({ ...corpus.cases[0]!, id: "bad-offset", question: { ...corpus.cases[0]!.question, nameOffset: 1 } });
  writeFileSync(cases, JSON.stringify(corpus));
  const invalid = run("invalid");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Case bad-offset: nameOffset/);
  assert.equal(existsSync(join(home, ".tmp/voice-spike/retest-invalid.jsonl")), false);
});

test("a retest label cannot append or summarize results from different corpora", () => {
  const run = (kind: string, label: string, start = "0") => retest("--yes", "--transport", "print", "--label", label,
    "--cases", join(import.meta.dirname, `../scripts/voice-spike/routing-${kind}.json`), "--start", start, "--limit", "1");
  const log = (label: string) => join(home, ".tmp/voice-spike", `retest-${label}.jsonl`);
  assert.equal(run("tuning", "one-corpus").status, 0);
  assert.equal(run("tuning", "one-corpus", "1").status, 0);
  const prior = readFileSync(log("one-corpus"), "utf8");
  const append = run("holdout", "one-corpus");
  assert.equal(append.status, 1);
  assert.match(append.stderr, /mixed corpora/i);
  assert.equal(readFileSync(log("one-corpus"), "utf8"), prior);
  assert.equal(run("holdout", "other-corpus").status, 0);
  const held = readFileSync(log("other-corpus"), "utf8");
  const identity = JSON.parse(held).corpusSha256;
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(retest("--summarize", "other-corpus").stdout).corpusSha256, identity);
  writeFileSync(log("pooled"), prior + held);
  const pooled = retest("--summarize", "pooled");
  assert.equal(pooled.status, 1);
  assert.match(pooled.stderr, /mixed corpora/i);
  const legacy = JSON.parse(held);
  delete legacy.corpusSha256;
  writeFileSync(log("pooled"), prior + JSON.stringify(legacy) + "\n");
  assert.match(retest("--summarize", "pooled").stderr, /mixed corpora/i);
});

test("the retest measures the unrounded deadline for recorded calls", () => {
  const clock = record("retest-clock.mjs");
  writeFileSync(clock, `import { existsSync } from "node:fs";
    performance.now = () => existsSync(process.env.VOICE_JOB_RECORD + "/claude-argv") ? Number(process.env.FIXTURE_MS) : 0;`);
  const corpus = join(import.meta.dirname, "../scripts/voice-spike/routing-tuning.json");
  const start = JSON.parse(readFileSync(corpus, "utf8")).cases.findIndex((row: { category: string }) => row.category === "split");
  assert.ok(start >= 0);
  for (const ms of [4999.6, 5000]) {
    const label = `deadline-${ms}`;
    const records = record(label);
    mkdirSync(records);
    const run = spawnSync(process.execPath, ["--import", clock, ...retestArgs, "--yes", "--transport", "print",
      "--label", label, "--cases", corpus, "--start", String(start), "--limit", "1"], {
      cwd: home, encoding: "utf8", env: { ...retestEnv, FIXTURE_MS: String(ms), VOICE_JOB_RECORD: records },
    });
    assert.equal(run.status, 0, run.stderr);
    const row = JSON.parse(readFileSync(record(`.tmp/voice-spike/retest-${label}.jsonl`), "utf8"));
    assert.equal(row.ms, ms);
    const summary = JSON.parse(retest("--summarize", label).stdout);
    assert.equal(summary.overDeadline, ms < 5000 ? 0 : 1);
    const split = summary.byFloor[0].perCategory.find((c: { category: string }) => c.category === "split");
    assert.equal(split.acceptedBeforeDeadline, ms < 5000 ? 1 : 0);
  }
});

test("retest and summary labels must be single file names", () => {
  for (const label of ["batch/one", "batch\\one", ""]) {
    for (const args of [["--yes", "--cases", "unused.json", "--label", label], ["--summarize", label]]) {
      const result = retest(...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /label must be a single file name/i);
      assert.equal(result.stdout, "");
    }
  }
});

test("invalid retest ranges fail before a previous label can be summarized or extended", () => {
  const label = "invalid-ranges";
  const args = ["--yes", "--transport", "print", "--label", label, "--cases", join(import.meta.dirname, "../scripts/voice-spike/routing-tuning.json")];
  assert.equal(retest(...args, "--limit", "1").status, 0);
  const file = join(home, ".tmp/voice-spike", `retest-${label}.jsonl`);
  const before = readFileSync(file, "utf8");
  for (const range of [["--start", "all"], ["--limit", "0"], ["--start", "-1"], ["--start", "9000"],
    ["--start", "1.5"], ["--limit"], ["--limit", "9007199254740992"]]) {
    const result = retest(...args, ...range);
    assert.equal(result.status, 1, range.join(" "));
    assert.match(result.stderr, /--start|--limit/);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

test("the Codex retest records its actual transport and refuses to mix launch paths", () => {
  const corpus = record("codex-transport-cases.json");
  const text = "Steve, check the build, and Alice, review the PR";
  writeFileSync(corpus, JSON.stringify({ roster: { Steve: "build", Alice: "review" }, cards: {}, cases: ["first", "next"].map(id => ({
    id, category: "split", expected: "split", question: { kind: "split", text, first: "Steve", second: "Alice", nameOffset: text.indexOf("Alice") },
  })) }));
  const run = (transport: string, label: string, start = "0") => spawnSync(process.execPath, [...retestArgs,
    "--yes", "--runner", "codex", "--cases", corpus,
    "--start", start, "--limit", "1", "--label", label], {
    cwd: home, encoding: "utf8", env: { ...retestEnv, MISSION_CODEX_TRANSPORT: transport },
  });
  for (const [transport, arg] of [["sdk", "--experimental-json"], ["exec", "--json"]] as const) {
    const label = "codex-" + transport;
    const result = run(transport, label);
    assert.equal(result.status, 0, result.stderr);
    const row = JSON.parse(readFileSync(join(home, ".tmp/voice-spike", `retest-${label}.jsonl`), "utf8"));
    assert.equal(row.transport, transport);
    assert.equal(row.error, null);
    assert.ok(readFileSync(record("codex-argv"), "utf8").split("\n").includes(arg));
  }
  const resumed = run("exec", "codex-sdk", "1");
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /mixed transports/i);
});

test("a retest records the model sent to the runner and rejects mixed or unrecorded model IDs", () => {
  const label = "model-revision";
  const run = (start: string) => retest("--yes", "--transport", "print", "--label", label,
    "--cases", join(import.meta.dirname, "../scripts/voice-spike/routing-tuning.json"), "--start", start, "--limit", "1");
  assert.equal(run("0").status, 0);
  const file = join(home, ".tmp/voice-spike", `retest-${label}.jsonl`);
  const original = readFileSync(file, "utf8");
  const row = JSON.parse(original);
  const argv = readFileSync(record("claude-argv"), "utf8").split("\n");
  assert.equal(row.model, argv[argv.indexOf("--model") + 1]);
  assert.equal(JSON.parse(retest("--summarize", label).stdout).model, row.model);
  for (const model of ["different-model", undefined]) {
    const changed = JSON.stringify({ ...row, id: "another", model }) + "\n";
    writeFileSync(file, changed);
    assert.match(run("1").stderr, /mixed model/i);
    assert.equal(readFileSync(file, "utf8"), changed);
    writeFileSync(file, original + changed);
    assert.match(retest("--summarize", label).stderr, /mixed model/i);
  }
});

test("resuming or summarizing a retest refuses a different prompt and schema revision", () => {
  const label = "prompt-revision";
  const run = (start: string) => retest("--yes", "--transport", "print", "--label", label,
    "--cases", join(import.meta.dirname, "../scripts/voice-spike/routing-tuning.json"), "--start", start, "--limit", "1");
  assert.equal(run("0").status, 0);
  const file = join(home, ".tmp/voice-spike", `retest-${label}.jsonl`);
  const original = readFileSync(file, "utf8");
  const row = JSON.parse(original);
  const revised = { ...row, promptSchemaSha256: "a".repeat(64) };
  writeFileSync(file, JSON.stringify(revised) + "\n");
  const resumed = run("1");
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /mixed prompt and schema revisions/i);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(revised) + "\n");
  assert.match(row.promptSchemaSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(revised.promptSchemaSha256, row.promptSchemaSha256);
  writeFileSync(file, original + JSON.stringify({ ...revised, id: "later" }) + "\n");
  assert.match(retest("--summarize", label).stderr, /mixed prompt and schema revisions/i);
});

test("a running retest reserves its label before the first result and releases it for the next slice", async () => {
  const waiting = record("waiting-claude");
  writeFileSync(waiting, `#!/bin/sh
touch "$VOICE_JOB_RECORD/retest-started"
while [ ! -f "$VOICE_JOB_RECORD/retest-release" ]; do sleep 0.05; done
exec "$VOICE_JOB_RECORD/claude" "$@"
`, { mode: 0o755 });
  const args = ["--yes", "--transport", "print", "--label", "concurrent", "--limit", "1",
    "--cases", join(import.meta.dirname, "../scripts/voice-spike/routing-tuning.json")];
  const first = promisify(execFile)(process.execPath, [...retestArgs, ...args], {
    cwd: home, env: { ...retestEnv, MISSION_CLAUDE_BIN: waiting },
  });
  try {
    const started = record("retest-started");
    const until = Date.now() + 10_000;
    while (!existsSync(started) && Date.now() < until) await delay(25);
    assert.ok(existsSync(started), "the first retest entered its fixture provider");
    const overlapping = retest(...args);
    assert.equal(overlapping.status, 1);
    assert.match(overlapping.stderr, /label.*already in use/i);
    assert.equal(existsSync(record(".tmp/voice-spike/retest-concurrent.jsonl")), false);
  } finally {
    writeFileSync(record("retest-release"), "");
    await first;
  }
  assert.equal(retest(...args, "--start", "1").status, 0);
  assert.equal(JSON.parse(retest("--summarize", "concurrent").stdout).n, 2);
});

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
