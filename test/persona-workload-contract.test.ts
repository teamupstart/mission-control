import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, appendFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PersonaWorkloadRequestSchema,
  PersonaWorkloadEventSchema,
  REPOSITORY_DEFAULT_BUDGETS,
  REPOSITORY_OPERATION_IDS,
  REPOSITORY_HISTORY_POLICY_V1,
  type PersonaWorkloadRequest,
  type RepositoryQueryAuditMetadata,
  type RepositoryViewDescriptor,
} from "../src/shared/repository-access.ts";
import {
  LocalPersonaWorkloadExecutor,
  type LocalPersonaWorkloadExecutorOptions,
} from "../src/server/workflows/persona-workload/executor.ts";
import {
  codexRepositoryConfig,
  isSupportedProviderBuild,
  REPOSITORY_PROVIDERS,
  repositoryWorkerResult,
  runCodexRepositoryWorkload,
  REPOSITORY_TOOL_NAMES,
  type RepositoryProvider,
  type RepositoryProviderLaunch,
} from "../src/server/workflows/persona-workload/providers.ts";
import { tempDirAsync } from "./temp-root.mjs";

function request(
  provider: "claude" | "codex" = "codex",
): PersonaWorkloadRequest {
  return PersonaWorkloadRequestSchema.parse({
    version: 1,
    workloadId: "workload",
    attemptId: "attempt",
    submissionId: "submission",
    idempotencyKey: "key",
    accounting: {
      callId: "call",
      runId: "run",
      purpose: "persona_review",
      attempt: 1,
    },
    persona: {
      sourcePersonaId: "reviewer",
      sourceRevision: 1,
      name: "Reviewer",
      description: "",
      guidanceMarkdown: "Review",
      runner: "claude",
      model: "persona-model",
    },
    execution: { provider, model: "node-override" },
    prompt: "Review the captured repository",
    images: [],
    artifact: { locator: "artifact", digest: "a".repeat(64) },
    policy: { version: 1, operations: REPOSITORY_OPERATION_IDS },
    budgets: REPOSITORY_DEFAULT_BUDGETS,
    deadline: Date.now() + 30000,
    cancellationGeneration: 1,
    requiredCapability: "repository_evidence_v1",
  });
}
const view: RepositoryViewDescriptor = {
  version: 1,
  snapshotDigest: "a".repeat(64),
  policyVersion: 1,
  objectView: "fixture",
  head: null,
  base: null,
  indexTree: "0".repeat(40),
  worktreeTree: "0".repeat(40),
  historyPolicy: REPOSITORY_HISTORY_POLICY_V1,
  retainedRevisions: [],
  frontier: [],
  retainedCommitCount: 0,
  retainedBlobBytes: 0,
  worktree: [],
  index: [],
};
const pass = {
  verdict: "pass",
  summary: "Checked",
  approvalDetails: { reason: "Checked", evidence: [] },
  confidence: 1,
};
function executor(
  provider: RepositoryProvider,
  overrides: Partial<LocalPersonaWorkloadExecutorOptions> = {},
) {
  let released = 0,
    materializations = 0;
  const instance = new LocalPersonaWorkloadExecutor({
    materializer: {
      materialize: async (identity) => {
        materializations++;
        return {
          identity,
          descriptor: view,
          objectDirectory: "/fixture",
          release: async () => {
            released++;
          },
        };
      },
    },
    repositoryMcpBundle: "/bundle",
    nodeBinary: process.execPath,
    gitBinary: "/usr/bin/git",
    providerBinary: async () => "/fake",
    providerEnvironment: async () => ({}),
    providers: { claude: provider, codex: provider },
    ...overrides,
  });
  return {
    instance,
    get released() {
      return released;
    },
    get materializations() {
      return materializations;
    },
  };
}
test("both resolved providers get one isolated launch, safe audit replay and one append-only result kind", async () => {
  for (const provider of ["claude", "codex"] as const) {
    let launches = 0;
    const f = executor(async (launch) => {
      launches++;
      assert.equal(launch.request.execution.model, "node-override");
      assert.notEqual(launch.cwd, process.cwd());
      assert.equal(launch.env.MISSION_HOME, undefined);
      assert.equal(launch.mcp.command, "/usr/bin/env");
      assert.equal(launch.mcp.args[0], "-i");
      assert.deepEqual(launch.mcp.env, {});
      const descriptor = launch.mcp.args
        .find((a) => a.startsWith("REPOSITORY_MCP_DESCRIPTOR="))!
        .split("=")[1]!;
      const config = JSON.parse(await readFile(descriptor, "utf8"));
      await appendFile(
        config.auditPath,
        JSON.stringify({
          operationId: randomUUID(),
          operation: "glob",
          workloadId: "workload",
          attemptId: "attempt",
          snapshotDigest: view.snapshotDigest,
          inputHash: "b".repeat(64),
          status: "ok",
          code: null,
          bytes: 0,
          items: 0,
          durationMs: 1,
          truncated: false,
          handles: [],
        }) + "\n",
      );
      const auditBytes = await readFile(config.auditPath);
      await writeFile(
        config.auditPath + ".seal",
        JSON.stringify({
          workloadId: "workload",
          attemptId: "attempt",
          count: 1,
          sha256: createHash("sha256").update(auditBytes).digest("hex"),
        }),
      );
      return { verdict: pass, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const req = request(provider);
    const events = await collect(
      f.instance.dispatch(req, new AbortController().signal),
    );
    for (const event of events) PersonaWorkloadEventSchema.parse(event);
    assert.deepEqual(
      events.map((e) => e.sequence),
      events.map((_, i) => i + 1),
    );
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, "terminal");
    if (terminal.type === "terminal") {
      assert.equal(terminal.result.status, "completed");
      if (terminal.result.status === "completed")
        assert.equal(terminal.result.result.kind, "persona_verdict");
    }
    assert.equal(events.filter((e) => e.type === "repository_query").length, 1);
    assert.deepEqual(
      (await f.instance.reconcile("workload", 2)).events,
      events.slice(2),
    );
    assert.deepEqual(
      await collect(f.instance.dispatch(req, new AbortController().signal)),
      events,
    );
    assert.equal(launches, 1);
    assert.equal(f.materializations, 1);
    assert.equal(f.released, 1);
  }
});
test("cancellation generations reject stale commands and late verdicts", async () => {
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const f = executor(async (launch) => {
    started();
    await new Promise<void>((r) =>
      launch.signal.addEventListener("abort", () => r(), { once: true }),
    );
    return { verdict: pass, usage: {} };
  });
  const run = collect(
    f.instance.dispatch(request(), new AbortController().signal),
  );
  await ready;
  await f.instance.cancel("workload", 0);
  assert.equal((await f.instance.reconcile("workload", 0)).state, "running");
  await f.instance.cancel("workload", 2);
  const events = await run;
  const terminal = events.at(-1)!;
  assert.equal(terminal.type, "terminal");
  if (terminal.type === "terminal")
    assert.deepEqual(terminal.result, {
      status: "failed",
      code: "cancelled",
      usage: {},
    });
  assert.equal(f.released, 1);
});

test("abandoning or aborting a replay detaches only that observer; the owner receives its verdict", async (t) => {
  let signalStart!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => { signalStart = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const req = request();
  const f = executor(async (launch) => {
    launch.signal.addEventListener("abort", resume, { once: true });
    signalStart();
    await held;
    const prefix = "REPOSITORY_MCP_DESCRIPTOR=";
    const descriptor = launch.mcp.args.find((arg) => arg.startsWith(prefix))!;
    const { auditPath } = JSON.parse(await readFile(descriptor.slice(prefix.length), "utf8"));
    await writeFile(auditPath + ".seal", JSON.stringify({
      workloadId: req.workloadId, attemptId: req.attemptId,
      count: 0, sha256: createHash("sha256").digest("hex"),
    }));
    return { verdict: pass, usage: {} };
  });
  const owner = collect(f.instance.dispatch(req, new AbortController().signal));
  t.after(async () => { resume(); await owner; });
  await started;
  for await (const event of f.instance.dispatch(req, new AbortController().signal)) {
    assert.equal(event.type, "accepted");
    break;
  }
  assert.equal((await f.instance.reconcile(req.workloadId, 0)).state, "running");

  const observer = new AbortController();
  const replay = f.instance.dispatch(req, observer.signal)[Symbol.asyncIterator]();
  for (const expected of ["accepted", "repository_verified", "persona_started"])
    assert.equal((await replay.next()).value?.type, expected);
  const pending = replay.next();
  observer.abort();
  assert.equal((await pending).done, true);
  assert.equal(f.released, 0);
  resume();
  const terminal = (await owner).at(-1)!;
  assert.equal(terminal.type, "terminal");
  assert.equal(terminal.result.status, "completed");
  assert.equal(f.materializations, 1);
  assert.equal(f.released, 1);
});
test("invalid request capability, artifact identity mismatch and malformed verdict cannot degrade to prompt-only", async () => {
  let launches = 0;
  const provider: RepositoryProvider = async (launch) => {
    launches++;
    const descriptor = launch.mcp.args
      .find((a) => a.startsWith("REPOSITORY_MCP_DESCRIPTOR="))!
      .split("=")[1]!;
    const config = JSON.parse(await readFile(descriptor, "utf8"));
    await writeFile(
      config.auditPath + ".seal",
      JSON.stringify({
        workloadId: "workload",
        attemptId: "attempt",
        count: 0,
        sha256: createHash("sha256").digest("hex"),
      }),
    );
    return { verdict: { verdict: "pass" }, usage: {} };
  };
  const invalid = {
    ...request(),
    requiredCapability: "future",
  } as unknown as PersonaWorkloadRequest;
  const f = executor(provider);
  await assert.rejects(() =>
    collect(f.instance.dispatch(invalid, new AbortController().signal)),
  );
  assert.equal(launches, 0);
  const wrong = executor(provider, {
    materializer: {
      materialize: async (identity) => ({
        identity: { ...identity, submissionId: "wrong" },
        descriptor: view,
        objectDirectory: "/fixture",
        release: async () => {},
      }),
    },
  });
  const failure = (
    await collect(
      wrong.instance.dispatch(request(), new AbortController().signal),
    )
  ).at(-1)!;
  assert.equal(failure.type, "terminal");
  if (failure.type === "terminal")
    assert.deepEqual(failure.result, {
      status: "failed",
      code: "artifact_unavailable",
    });
  assert.equal(launches, 0);
  const malformed = (
    await collect(f.instance.dispatch(request(), new AbortController().signal))
  ).at(-1)!;
  if (malformed.type === "terminal")
    assert.deepEqual(malformed.result, {
      status: "failed",
      code: "invalid_verdict",
      usage: {},
    });
});
test("Codex capability config disables native action tools and registers only repository MCP", () => {
  const config = codexRepositoryConfig({
    command: "node",
    args: ["repository"],
    env: {},
  });
  assert.equal(config.features.shell_tool, false);
  assert.equal(config.features.view_image, false);
  assert.equal(config.web_search, "disabled");
  assert.deepEqual(config.features.code_mode.excluded_tool_namespaces, [
    "functions",
    "clock",
    "collaboration",
  ]);
  assert.equal(config.agents.enabled, false);
  assert.deepEqual(Object.keys(config.mcp_servers), ["repository"]);
  assert.deepEqual(config.mcp_servers.repository.enabled_tools, [
    ...REPOSITORY_OPERATION_IDS,
  ]);
});

async function capabilityFixture(
  t: TestContext,
  provider: "codex" | "claude",
  capabilities: { version: string; servers?: { name: string; enabled: boolean }[]; tools?: string[]; omitStructuredOutput?: boolean },
) {
  const cwd = await tempDirAsync("repository-provider-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const binary = join(cwd, "provider.mjs");
  const script = new URL("./fixtures/repository-provider-cli.mjs", import.meta.url);
  await writeFile(binary, await readFile(script), { mode: 0o700 });
  await writeFile(join(cwd, "capabilities.json"), JSON.stringify({ ...capabilities, verdict: pass }));
  const launch: RepositoryProviderLaunch = {
    request: request(provider),
    cwd,
    binary,
    env: { HOME: cwd, PATH: dirname(process.execPath) },
    mcp: { command: process.execPath, args: [], env: {} },
    signal: AbortSignal.timeout(10_000),
  };
  return {
    launch,
    run: () => REPOSITORY_PROVIDERS[provider](launch),
    launches: async () => (await readFile(join(cwd, "launches.log"), "utf8")).trim().split("\n"),
  };
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} rejects an unverified CLI build before starting a review session`, async (t) => {
    const fixture = await capabilityFixture(t, provider, { version: "unverified fixture build" });
    await assert.rejects(fixture.run, { reason: "unverified_build" });
    assert.deepEqual(await fixture.launches(), ["version"]);
  });
}

// Each provider's verified floor is a minimum, compared numerically by semver component.
const providerBuildCases = {
  codex: {
    banner: (v: string) => `codex-cli ${v}`,
    accepted: ["0.166.0", "0.166.1", "0.167.0", "0.172.0", "0.1000.0", "1.0.0"],
    refused: ["0.165.9", "0.165.999", "0.99.0", "0.9.0"],
  },
  claude: {
    banner: (v: string) => `${v} (Claude Code)`,
    accepted: ["2.1.319", "2.1.320", "2.1.332", "2.1.1000", "2.2.0", "3.0.0"],
    refused: ["2.1.318", "2.1.99", "2.0.999", "1.9.999"],
  },
} as const;
for (const [provider, { banner, accepted, refused }] of Object.entries(providerBuildCases) as
  [keyof typeof providerBuildCases, (typeof providerBuildCases)[keyof typeof providerBuildCases]][]) {
  test(`${provider} accepts its verified build and every newer one, and refuses older builds`, () => {
    // The CLI prints its banner with a trailing newline.
    for (const version of accepted)
      assert.equal(isSupportedProviderBuild(provider, `${banner(version)}\n`), true, `${provider} ${version}`);
    for (const version of refused)
      assert.equal(isSupportedProviderBuild(provider, banner(version)), false, `${provider} ${version}`);
  });
}

test("a version banner that is not that provider's CLI fails closed", () => {
  const unparseable = {
    codex: ["", "codex-cli", "codex-cli 0.172", "codex-cli 0.172.0-alpha.1", "codex-cli v0.172.0",
      "codex 0.172.0", "codex-cli 0.172.0.1", "2.1.332 (Claude Code)", "codex-cli 0.172.0 extra",
      "codex-cli 0.1234567890.0"],
    claude: ["", "(Claude Code)", "2.1 (Claude Code)", "2.1.332-beta (Claude Code)", "v2.1.332 (Claude Code)",
      "2.1.332", "2.1.332 (Claude)", "codex-cli 0.172.0", "2.1.332 (Claude Code)\nextra",
      "2.1.1234567890 (Claude Code)"],
  } as const;
  for (const provider of ["codex", "claude"] as const)
    for (const output of unparseable[provider])
      assert.equal(isSupportedProviderBuild(provider, output), false, `${provider} ${JSON.stringify(output)}`);
});

for (const [provider, version] of [
  ["codex", "codex-cli 0.165.9"], ["claude", "2.1.318 (Claude Code)"],
] as const) {
  test(`${provider} refuses a build older than its floor before starting a review session`, async (t) => {
    const fixture = await capabilityFixture(t, provider, { version });
    await assert.rejects(fixture.run, { reason: "unverified_build" });
    assert.deepEqual(await fixture.launches(), ["version"]);
  });
}

test("a newer Codex build passes the build check and still faces the MCP server preflight", async (t) => {
  const fixture = await capabilityFixture(t, "codex", {
    version: "codex-cli 1.0.0",
    servers: [{ name: "repository", enabled: true }, { name: "other", enabled: true }],
  });
  await assert.rejects(fixture.run, { reason: "tool_inventory" });
  assert.deepEqual(await fixture.launches(), ["version", "mcp list"]);
});

test("a newer Claude build that exposes an extra tool is still refused at initialization", async (t) => {
  const fixture = await capabilityFixture(t, "claude", {
    version: "2.1.332 (Claude Code)",
    tools: [...REPOSITORY_TOOL_NAMES, "StructuredOutput", "Bash"],
  });
  await assert.rejects(fixture.run, { reason: "tool_inventory" });
  assert.deepEqual(await fixture.launches(), ["version", "session", "init"]);
});

test("a newer Claude build with the exact repository inventory runs the review", async (t) => {
  const fixture = await capabilityFixture(t, "claude", {
    version: "3.0.0 (Claude Code)",
    tools: [...REPOSITORY_TOOL_NAMES, "StructuredOutput"],
  });
  const output = await fixture.run();
  assert.deepEqual(output.verdict, pass);
  assert.deepEqual(await fixture.launches(), ["version", "session", "init"]);
});

test("Codex refuses an extra enabled MCP server before starting a review session", async (t) => {
  const fixture = await capabilityFixture(t, "codex", {
    version: "codex-cli 0.166.0",
    servers: [{ name: "repository", enabled: true }, { name: "other", enabled: true }],
  });
  await assert.rejects(fixture.run, { reason: "tool_inventory" });
  assert.deepEqual(await fixture.launches(), ["version", "mcp list"]);
});

test("Claude rejects an unexpected tool at initialization even when the provider offers a verdict", async (t) => {
  const fixture = await capabilityFixture(t, "claude", {
    version: "2.1.319 (Claude Code)",
    tools: [...REPOSITORY_TOOL_NAMES, "StructuredOutput", "Bash"],
  });
  await assert.rejects(fixture.run, { reason: "tool_inventory" });
  assert.deepEqual(await fixture.launches(), ["version", "session", "init"]);
});

// A reply the provider returned must reach the executor, which records the return before it
// judges the content. Throwing here would refund it as a provider that never answered.
test("Codex hands back a returned non-JSON reply and malformed usage instead of failing", async (t) => {
  const fixture = await capabilityFixture(t, "codex", {
    version: "codex-cli 0.166.0",
    servers: [{ name: "repository", enabled: true }],
  });
  const output = await runCodexRepositoryWorkload(fixture.launch, {
    createClient: () => ({
      startThread: () => ({
        run: async () => ({ finalResponse: "I reviewed it and it looks fine", usage: { input_tokens: "many" } }),
      }),
    }) as never,
  });
  assert.deepEqual(output, { verdict: undefined, usage: { input_tokens: "many" } });
});

test("Claude hands back a returned result without structured output instead of failing", async (t) => {
  const fixture = await capabilityFixture(t, "claude", {
    version: "2.1.319 (Claude Code)",
    tools: [...REPOSITORY_TOOL_NAMES, "StructuredOutput"],
    omitStructuredOutput: true,
  });
  const output = await fixture.run();
  assert.equal(output.verdict, undefined);
  assert.deepEqual(output.usage, { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    output_tokens: 1, total_cost_usd: 0 });
});

test("the provider worker reports any returned reply it cannot carry as invalid_verdict, never a provider failure", () => {
  const req = request();
  // A valid verdict keeps its usage and completes.
  assert.deepEqual(repositoryWorkerResult(req, { verdict: pass, usage: { input_tokens: 3 }, providerRunId: "run-1" }), {
    status: "completed", result: { kind: "persona_verdict", verdict: pass }, usage: { input_tokens: 3 }, providerRunId: "run-1",
  });
  // A returned reply with no usable verdict keeps the usage the provider reported.
  assert.deepEqual(repositoryWorkerResult(req, { verdict: undefined, usage: { input_tokens: 3 } }), {
    status: "failed", code: "invalid_verdict", usage: { input_tokens: 3 },
  });
  // Usage the result cannot carry is still a returned reply: never provider_unavailable.
  for (const usage of [{ input_tokens: "many" }, { input_tokens: -1 }, "garbage"]) {
    assert.deepEqual(repositoryWorkerResult(req, { verdict: pass, usage }), { status: "failed", code: "invalid_verdict" });
  }
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

test("env-node provider launchers use the configured Node and report a body-free capability failure", async (t) => {
  const root = await tempDirAsync("provider-launcher-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "codex.mjs");
  const nodeBinary = join(root, "runtime");
  // The recording shim distinguishes the configured runtime even on hosts with /usr/bin/node.
  await writeFile(nodeBinary, `#!/bin/sh\necho "$2" >> "$1.calls"\nexec "${process.execPath}" "$@"\n`, { mode: 0o700 });
  await writeFile(binary, "#!/usr/bin/env node\nconsole.log('unknown build with arbitrary output');\n", { mode: 0o700 });
  const f = executor(REPOSITORY_PROVIDERS.codex, { nodeBinary, providerBinary: async () => binary });
  const events = await collect(f.instance.dispatch(request(), new AbortController().signal));
  const terminal = events.at(-1)!;
  assert.equal(terminal.type, "terminal");
  if (terminal.type === "terminal")
    assert.deepEqual(terminal.result, {
      status: "failed", code: "capability_mismatch", capabilityReason: "unverified_build",
    });
  assert.equal(await readFile(binary + ".calls", "utf8"), "--version\n");
  assert.ok(!JSON.stringify(events).includes("arbitrary output"));
  assert.equal(f.released, 1);
});

// Run the same cited read through the executor, varying only the shutdown seal.
async function dispatchCitedRead(
  sealOverrides: { count?: number; sha256?: string } = {},
) {
  const req = request();
  const query = {
    workloadId: req.workloadId,
    attemptId: req.attemptId,
    snapshotDigest: req.artifact.digest,
    operationId: randomUUID(),
    operation: "read",
    truncated: false,
  } as const;
  const handle = {
    ...query,
    evidenceHandleId: randomUUID(),
    itemOrdinal: 0,
    path: "README.md",
    policyVersion: 1,
    range: { kind: "line", startLine: 1, endLineExclusive: 2 },
  } as const;
  const audit: RepositoryQueryAuditMetadata = {
    ...query,
    inputHash: "b".repeat(64),
    status: "ok",
    code: null,
    bytes: 200,
    items: 1,
    durationMs: 1,
    handles: [handle],
  };
  const reference = {
    kind: "repository",
    operationId: query.operationId,
    evidenceHandleId: handle.evidenceHandleId,
  };
  const verdict = {
    ...pass,
    approvalDetails: { reason: "Checked", evidence: [reference] },
  };
  const f = executor(async (launch) => {
    const prefix = "REPOSITORY_MCP_DESCRIPTOR=";
    const descriptor = launch.mcp.args.find((arg) => arg.startsWith(prefix));
    assert.ok(descriptor);
    const { auditPath } = JSON.parse(
      await readFile(descriptor.slice(prefix.length), "utf8"),
    );
    const bytes = JSON.stringify(audit) + "\n";
    await writeFile(auditPath, bytes);
    await writeFile(
      auditPath + ".seal",
      JSON.stringify({
        workloadId: req.workloadId,
        attemptId: req.attemptId,
        count: 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...sealOverrides,
      }),
    );
    return { verdict, usage: {} };
  });
  const events = await collect(f.instance.dispatch(req, new AbortController().signal));
  const audits = events.filter((event) => event.type === "repository_query");
  assert.deepEqual(audits.map((event) => event.audit), [audit]);
  assert.equal(events.at(-1)?.type, "terminal");
  const terminals = events.filter((event) => event.type === "terminal");
  return { verdict, results: terminals.map((event) => event.result) };
}

test("a verdict citing the audited operation and handle completes with that repository reference", async () => {
  const { results, verdict } = await dispatchCitedRead();
  assert.deepEqual(results, [
    { status: "completed", result: { kind: "persona_verdict", verdict }, usage: {} },
  ]);
});

for (const [field, override] of [
  ["count", { count: 0 }],
  ["sha256", { sha256: createHash("sha256").digest("hex") }],
] as const) {
  test(`a valid audited read with a mismatched seal ${field} ends only in audit_unavailable`, async () => {
    const { results } = await dispatchCitedRead(override);
    assert.deepEqual(results, [{ status: "failed", code: "audit_unavailable", usage: {} }]);
  });
}

test("forged references, cross-attempt audits and body-bearing audits fail closed", async () => {
  for (const scenario of ["reference", "attempt", "body"] as const) {
    const f = executor(async (launch) => {
      const descriptor = launch.mcp.args
        .find((a) => a.startsWith("REPOSITORY_MCP_DESCRIPTOR="))!
        .slice("REPOSITORY_MCP_DESCRIPTOR=".length);
      const config = JSON.parse(await readFile(descriptor, "utf8"));
      const operationId = randomUUID(),
        evidenceHandleId = randomUUID();
      const record = {
        operationId,
        operation: "read",
        workloadId: "workload",
        attemptId: scenario === "attempt" ? "other" : "attempt",
        snapshotDigest: view.snapshotDigest,
        inputHash: "b".repeat(64),
        status: "ok",
        code: null,
        bytes: 200,
        items: 1,
        durationMs: 1,
        truncated: false,
        handles: [],
        ...(scenario === "body" ? { text: "body must not cross" } : {}),
      };
      const bytes =
        scenario === "reference" ? "" : JSON.stringify(record) + "\n";
      await writeFile(config.auditPath, bytes);
      await writeFile(
        config.auditPath + ".seal",
        JSON.stringify({
          workloadId: "workload",
          attemptId: "attempt",
          count: bytes ? 1 : 0,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
      return {
        verdict: {
          ...pass,
          approvalDetails: {
            reason: "checked",
            evidence: [{ kind: "repository", operationId, evidenceHandleId }],
          },
        },
        usage: { input_tokens: 7 },
      };
    });
    const events = await collect(
      f.instance.dispatch(request(), new AbortController().signal),
    );
    assert.equal(
      events.some((e) => e.type === "repository_query"),
      false,
    );
    const terminal = events.at(-1)!;
    assert.equal(terminal.type, "terminal");
    if (terminal.type === "terminal")
      assert.deepEqual(terminal.result, {
        status: "failed",
        code:
          scenario === "reference" ? "invalid_verdict" : "audit_unavailable",
        usage: { input_tokens: 7 },
      });
    assert.equal(f.released, 1);
  }
});

test("expired and cancelled-before-dispatch work never launches; iterator abandonment releases its lease", async () => {
  let launches = 0;
  const f = executor(async (launch) => {
    launches++;
    await new Promise<void>((resolve) => {
      if (launch.signal.aborted) resolve();
      else
        launch.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });
    return { verdict: pass, usage: {} };
  });
  await f.instance.cancel("workload", 2);
  const stopped = await collect(
    f.instance.dispatch(request(), new AbortController().signal),
  );
  assert.equal(launches, 0);
  assert.equal(stopped.at(-1)!.type, "terminal");
  const expired = executor(async () => {
    throw Error("must not launch");
  });
  const old = { ...request(), deadline: Date.now() - 1 };
  const events = await collect(
    expired.instance.dispatch(old, new AbortController().signal),
  );
  const terminal = events.at(-1)!;
  if (terminal.type === "terminal")
    assert.deepEqual(terminal.result, { status: "failed", code: "deadline" });
  assert.equal(expired.materializations, 0);
  const abandoned = executor(async (launch) => {
    await new Promise<void>((resolve) => {
      if (launch.signal.aborted) resolve();
      else
        launch.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });
    return { verdict: pass, usage: {} };
  });
  for await (const event of abandoned.instance.dispatch(
    request(),
    new AbortController().signal,
  )) {
    if (event.type === "persona_started") break;
  }
  assert.equal(abandoned.released, 1);
  assert.equal(
    (await abandoned.instance.reconcile("workload", 0)).state,
    "terminal",
  );
});
