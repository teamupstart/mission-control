import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
  ClaudeSdkOneShotQuery,
  ClaudeSdkOneShotQueryOptions,
} from "../src/server/harness/claude/sdk-types.ts";
import { claudeSdkTranscriptPath } from "../src/server/harness/claude/sdk.ts";
import { DENY_PATHS, DENY_SETTINGS, REVIEW_TOOLS } from "../src/server/inspector/worker.ts";
import { HEADLESS_CWD } from "../src/server/claude-cli.ts";
import { headlessTranscriptDir } from "../src/server/goal/prune.ts";
import { CLAUDE_GRANTABLE_TOOLS, claudeSpendReport } from "../src/server/llm/claude.ts";
import {
  killLiveClaudeSdkRuns,
  runClaudeSdkOneShot,
} from "../src/server/llm/claude-sdk.ts";

// What is at stake: this is the new boundary around app-owned Claude calls. A regression
// here is silent in the dangerous cases. Reusing a session lets one review influence the
// next, inheriting tools exposes untrusted prompt material, changing cwd strands transcripts
// outside the pruner, and timing out without aborting leaves a model call spending after its
// caller has given up. Every query below is scripted; the boundary case uses a token-free
// fake binary behind the real vendor serializer, and no model is used.

const root = mkdtempSync(join(tmpdir(), "claude-sdk-oneshot-"));
after(() => rmSync(root, { recursive: true, force: true }));

class FakeQuery implements ClaudeSdkOneShotQuery {
  constructor(
    private readonly frames: ClaudeSdkMessage[] | null,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeSdkMessage> {
    if (this.frames === null) {
      await new Promise<never>(() => {});
    }
    for (const frame of this.frames ?? []) yield frame;
  }
}

interface CapturedQuery {
  prompt: string;
  options: ClaudeSdkOneShotQueryOptions;
}

function fakeDeps(
  frames: ClaudeSdkMessage[] | null,
  onQuery?: (captured: CapturedQuery) => void,
): { deps: ClaudeSdkOneShotDeps; calls: () => number; executableCalls: () => number } {
  let calls = 0;
  let executableCalls = 0;
  return {
    calls: () => calls,
    executableCalls: () => executableCalls,
    deps: {
      executable: async () => {
        executableCalls += 1;
        return "/fake/bin/claude";
      },
      // The production dependency is sdkSubprocessEnv(), whose contract is that pane
      // identity is already absent. Keep the fake at that seam and assert the independent
      // headless marker added by the one-shot adapter below.
      env: () => ({ PATH: "/usr/bin" }),
      query: async ({ prompt, options }) => {
        calls += 1;
        onQuery?.({ prompt, options });
        return new FakeQuery(frames);
      },
    },
  };
}

const SPEND_FRAME: ClaudeSdkMessage = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "OK",
  uuid: "turn-1",
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
};

test("one fresh query has tools off, deterministic settings, and no context options", async () => {
  let captured!: CapturedQuery;
  const fake = fakeDeps([
    { type: "assistant", session_id: "run-1" },
    { ...SPEND_FRAME, session_id: "run-1", result: "the model text" },
  ], (value) => {
    captured = value;
  });

  const result = await runClaudeSdkOneShot("summarise this session", {
    model: "claude-haiku-4-5",
    timeoutMs: 5_000,
    maxBudgetUsd: 2.5,
  }, fake.deps);

  assert.equal(result.text, "the model text");
  assert.equal(fake.calls(), 1, "one app-owned call must construct exactly one query");
  assert.equal(captured.prompt, "summarise this session");
  assert.deepEqual(captured.options.tools, []);
  assert.equal(Object.hasOwn(captured.options, "settings"), false);
  assert.deepEqual(captured.options.settingSources, []);
  assert.equal(captured.options.maxTurns, 1);
  assert.equal(captured.options.maxBudgetUsd, 2.5);
  assert.equal(captured.options.model, "claude-haiku-4-5");
  assert.equal(captured.options.cwd, realpathSync(HEADLESS_CWD));
  assert.equal(captured.options.pathToClaudeCodeExecutable, "/fake/bin/claude");
  assert.equal(captured.options.env.MISSION_HEADLESS, "1");
  assert.ok(captured.options.abortController instanceof AbortController);
  for (const absent of ["resume", "sessionId", "forkSession", "continue", "persistSession"]) {
    assert.equal(
      Object.hasOwn(captured.options, absent),
      false,
      `${absent} was passed and the run is no longer a fresh persisted one-shot`,
    );
  }
});

test("a rendered schema becomes outputFormat and structured_output becomes JSON text", async () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  let options!: ClaudeSdkOneShotQueryOptions;
  const fake = fakeDeps([
    {
      ...SPEND_FRAME,
      result: "provider display text is not the structured answer",
      structured_output: { answer: "yes" },
    },
  ], (captured) => {
    options = captured.options;
  });

  const result = await runClaudeSdkOneShot("answer as JSON", { schema }, fake.deps);
  assert.equal(result.text, JSON.stringify({ answer: "yes" }));
  assert.deepEqual(options.outputFormat, { type: "json_schema", schema });
});

test("a validated grant reaches the SDK with the Inspector's exact tools, cwd, and deny settings", async () => {
  const cwd = mkdtempSync(join(root, "inspector-worktree-"));
  let options!: ClaudeSdkOneShotQueryOptions;
  const fake = fakeDeps([SPEND_FRAME], (captured) => {
    options = captured.options;
  });

  const result = await runClaudeSdkOneShot("review this diff", {
    grant: { tools: [...CLAUDE_GRANTABLE_TOOLS], cwd, denyPaths: DENY_PATHS },
  }, fake.deps);

  assert.equal(result.text, "OK");
  assert.deepEqual(options.tools, REVIEW_TOOLS.split(","));
  assert.equal(options.cwd, realpathSync(cwd));
  assert.equal(options.settings, DENY_SETTINGS);
  assert.deepEqual(options.settingSources, []);
  assert.equal(
    Object.hasOwn(options, "maxTurns"),
    false,
    "a granted review needs a later turn after its tool result",
  );
});

test("an invalid grant is refused before the binary is resolved or query is called", async () => {
  const cases = [
    { tools: ["Read", "Bash"], cwd: "/tmp/checkout", denyPaths: ["**/.env"] },
    { tools: ["Read"], cwd: "checkout", denyPaths: ["**/.env"] },
    { tools: [], cwd: "/tmp/checkout", denyPaths: ["**/.env"] },
  ];
  for (const grant of cases) {
    const fake = fakeDeps([SPEND_FRAME]);
    await assert.rejects(
      runClaudeSdkOneShot("review this diff", { grant }, fake.deps),
      /refused the tool grant/,
    );
    assert.equal(fake.executableCalls(), 0);
    assert.equal(fake.calls(), 0);
  }
});

test("a denied-path result is a failed SDK run, never model text", async () => {
  const cwd = mkdtempSync(join(root, "denied-result-"));
  const fake = fakeDeps([{
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: "denied-run",
    terminal_reason: "permission_denied",
    errors: ["Read denied by rule: **/.env"],
    result: "SECRET=must-not-be-returned",
  }]);

  await assert.rejects(
    runClaudeSdkOneShot("read .env", {
      grant: { tools: [...CLAUDE_GRANTABLE_TOOLS], cwd, denyPaths: DENY_PATHS },
    }, fake.deps),
    /permission_denied.*Read denied by rule: \*\*\/\.env/,
  );
});

test("the vendor SDK binds inline deny settings with empty setting sources at the subprocess boundary", async () => {
  const cwd = mkdtempSync(join(root, "vendor-boundary-worktree-"));
  const fakeBin = join(root, "vendor-boundary-claude");
  writeFileSync(fakeBin, `#!/usr/bin/env node
const value = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
let sent = false;
process.stdin.on("data", () => {
  if (sent) return;
  sent = true;
  const bound = value("--tools") === "Read,Grep,Glob"
    && value("--settings") === process.env.MC_EXPECTED_DENY_SETTINGS
    && process.argv.includes("--setting-sources=")
    && process.cwd() === process.env.MC_EXPECTED_GRANT_CWD;
  const frame = bound
    ? {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "vendor-denied-run",
        terminal_reason: "permission_denied",
        errors: ["Read denied at subprocess boundary: **/.env"],
      }
    : {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "vendor-leaked-run",
        result: "SECRET=transport-dropped-the-deny-rules",
      };
  process.stdout.write(JSON.stringify(frame) + "\\n", () => process.exit(0));
});
`);
  chmodSync(fakeBin, 0o755);

  const previous = {
    bin: process.env.MISSION_CLAUDE_BIN,
    settings: process.env.MC_EXPECTED_DENY_SETTINGS,
    cwd: process.env.MC_EXPECTED_GRANT_CWD,
  };
  process.env.MISSION_CLAUDE_BIN = fakeBin;
  process.env.MC_EXPECTED_DENY_SETTINGS = DENY_SETTINGS;
  process.env.MC_EXPECTED_GRANT_CWD = realpathSync(cwd);
  try {
    // This call uses defaultClaudeSdkOneShotDeps: the real vendor `query()` serializes the
    // options and spawns the fake Claude subprocess. The fake reports a denial only when
    // the exact rules, tools, empty setting-source layer, and cwd all crossed that boundary;
    // otherwise it returns a sentinel secret and this assertion fails.
    await assert.rejects(
      runClaudeSdkOneShot("read .env", {
        timeoutMs: 10_000,
        grant: { tools: [...CLAUDE_GRANTABLE_TOOLS], cwd, denyPaths: DENY_PATHS },
      }),
      /permission_denied.*Read denied at subprocess boundary: \*\*\/\.env/,
    );
  } finally {
    if (previous.bin === undefined) delete process.env.MISSION_CLAUDE_BIN;
    else process.env.MISSION_CLAUDE_BIN = previous.bin;
    if (previous.settings === undefined) delete process.env.MC_EXPECTED_DENY_SETTINGS;
    else process.env.MC_EXPECTED_DENY_SETTINGS = previous.settings;
    if (previous.cwd === undefined) delete process.env.MC_EXPECTED_GRANT_CWD;
    else process.env.MC_EXPECTED_GRANT_CWD = previous.cwd;
  }
});

test("a timeout aborts the controller and rejects without waiting for the stream", async () => {
  let controller: AbortController | undefined;
  const fake = fakeDeps(null, ({ options }) => {
    controller = options.abortController;
  });
  await assert.rejects(
    runClaudeSdkOneShot("never finishes", { timeoutMs: 5 }, fake.deps),
    /timed out/,
  );
  assert.equal(fake.calls(), 1);
  assert.equal(controller?.signal.aborted, true);
});

test("killLiveRuns aborts every in-flight SDK query", async () => {
  let controller: AbortController | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fake = fakeDeps(null, ({ options }) => {
    controller = options.abortController;
    started?.();
  });
  const pending = runClaudeSdkOneShot("still running", { timeoutMs: 60_000 }, fake.deps);
  await ready;
  killLiveClaudeSdkRuns();
  await assert.rejects(pending, /aborted/);
  assert.equal(controller?.signal.aborted, true);
});

test("stderr and result failure details remain visible to the caller", async () => {
  const fake = fakeDeps([
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "run-error",
      terminal_reason: "api_error",
      errors: ["request failed"],
    },
  ], ({ options }) => {
    options.stderr?.("authentication unavailable");
  });
  await assert.rejects(
    runClaudeSdkOneShot("fail", {}, fake.deps),
    /api_error.*request failed.*authentication unavailable/,
  );
});

test("the SDK result frame produces the same Claude spend report as print", async () => {
  const fake = fakeDeps([SPEND_FRAME]);
  const result = await runClaudeSdkOneShot("verify this", { model: "opus" }, fake.deps);
  const report = claudeSpendReport(
    JSON.stringify(result.envelope),
    "inspector:review",
    "opus",
    1_700_000_000_000,
  );
  assert.ok(report);
  assert.equal(report.runId, "19de2f1f-c04d-4cfd-a218-719095efe008");
  assert.deepEqual(report.models, [{
    modelId: "claude-haiku-4-5-20251001",
    input: 9,
    output: 40,
    reasoningOutput: 0,
    cacheRead: 0,
    cacheWrite: 6661,
    reportedCostUsd: 0.013531,
  }]);
});

test("the persisted SDK transcript path lands inside the existing pruner directory", () => {
  const projectsDir = join(root, "projects");
  const sessionId = "sdk-headless-run";
  const sweptDir = headlessTranscriptDir(projectsDir);
  mkdirSync(sweptDir, { recursive: true });
  writeFileSync(join(sweptDir, `${sessionId}.jsonl`), '{"type":"user"}\n');

  const reported = claudeSdkTranscriptPath(
    realpathSync(HEADLESS_CWD),
    sessionId,
    projectsDir,
  );
  assert.ok(reported);
  assert.equal(dirname(reported), sweptDir);
});
