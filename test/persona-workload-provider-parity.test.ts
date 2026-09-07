import assert from "node:assert/strict";
import { appendFile, readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { AppServerTransport } from "../src/server/harness/codex/app-server/client.ts";
import type { ClaudeSdkUserMessage } from "../src/server/harness/claude/sdk-types.ts";
import { ClaudePersonaWorkloadAdapter } from "../src/server/workflows/persona-workload/claude.ts";
import {
  CodexPersonaWorkloadAdapter,
  codexInheritedMcpDisableArgs,
} from "../src/server/workflows/persona-workload/codex.ts";
import { LocalPersonaWorkloadExecutor } from "../src/server/workflows/persona-workload/executor.ts";
import type { PersonaProviderLaunch, PersonaWorkloadProviderAdapter } from "../src/server/workflows/persona-workload/provider.ts";
import {
  PERSONA_CODEX_DISABLED_FEATURES,
  PERSONA_WORKLOAD_ALLOWED_TOOLS,
} from "../src/server/workflows/persona-workload/provider.ts";
import { DEFAULT_REPOSITORY_BUDGETS, REPOSITORY_EVIDENCE_PROTOCOL, REPOSITORY_HISTORY_POLICY_V1 } from "../src/shared/repository-access.ts";
import type { LlmImageInput } from "../src/shared/llm.ts";
import type { PersonaWorkloadEvent, PersonaWorkloadRequest, RepositoryEvidenceRange, RepositoryQueryAuditMetadata } from "../src/shared/repository-access.ts";
import { PNG_IMAGE, writeImageDescriptor } from "./helpers/llm-image-fixtures.ts";
import { repositoryViewFixture } from "./helpers/repository-view.ts";

const verdict = {
  verdict: "pass" as const,
  summary: "The workload completed.",
  approvalDetails: { reason: "The repository evidence is consistent.", evidence: [] },
  requestedChanges: null,
  confidence: 0.95,
};

const disabledCodexFeatures = Object.fromEntries(
  PERSONA_CODEX_DISABLED_FEATURES.map((feature) => [feature, false]),
);

function launch(provider: "claude" | "codex", images: readonly LlmImageInput[] = []): PersonaProviderLaunch {
  return {
    provider,
    model: "test-model",
    workingDirectory: "/tmp/persona-provider-cwd",
    prompt: "Review the submission",
    images,
    outputSchema: { type: "object", properties: {}, additionalProperties: false },
    deadline: Date.now() + 60_000,
    budgets: DEFAULT_REPOSITORY_BUDGETS,
    repositoryMcp: { serverName: "repository", command: "/usr/bin/node", args: ["/tmp/repository-mcp.mjs"], env: { MISSION_REPOSITORY_MCP_CONFIG: "/tmp/private.json" } },
    allowedTools: PERSONA_WORKLOAD_ALLOWED_TOOLS,
    hostedSearchMaximum: "cached",
  };
}

test("Claude workload adapter exposes only repository MCP tools across multiple calls and one structured result", async () => {
  let observed: unknown;
  const adapter = new ClaudePersonaWorkloadAdapter({
    executable: async () => "/usr/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    async query(params) {
      observed = params;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__repository__read" }, { type: "tool_use", name: "mcp__repository__git_diff" }] } };
          yield { type: "result", subtype: "success", is_error: false, structured_output: verdict, usage: { input_tokens: 12, output_tokens: 7 } };
        },
      };
    },
  });
  const result = await adapter.run(launch("claude"), new AbortController().signal);
  assert.deepEqual(result.repositoryToolCalls, ["mcp__repository__read", "mcp__repository__git_diff"]);
  const options = (observed as { options: Record<string, unknown> }).options;
  assert.deepEqual(options.tools, PERSONA_WORKLOAD_ALLOWED_TOOLS);
  assert.deepEqual(options.allowedTools, PERSONA_WORKLOAD_ALLOWED_TOOLS);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.deepEqual(Object.keys(options.mcpServers as object), ["repository"]);
  assert.ok((options.disallowedTools as string[]).includes("Bash"));
  assert.ok((options.disallowedTools as string[]).includes("WebSearch"));
});

class ScriptedTransport implements AppServerTransport {
  readonly pid = null;
  readonly sent: Array<Record<string, unknown>> = [];
  private queue: unknown[] = [];
  private wait: (() => void) | null = null;
  private ended = false;

  constructor(
    private readonly mcpServers: Record<string, unknown> = { repository: {} },
    private readonly webSearch: "disabled" | "cached" | "indexed" | "live" = "cached",
    private readonly featureOverrides: Readonly<Record<string, unknown>> = {},
    private readonly nativeWebSearch: boolean | null = false,
    private readonly completedItems: readonly Record<string, unknown>[] = [
      { type: "userMessage", id: "user-1", clientId: null, content: [] },
      { type: "mcpToolCall", server: "repository", tool: "read" },
      { type: "mcpToolCall", server: "repository", tool: "git_diff" },
      { type: "webSearch", id: "cached-search-1", query: "cached context" },
      { type: "agentMessage", text: JSON.stringify(verdict) },
    ],
    private readonly nativeWebSearchSessionFlag: boolean | null = null,
    private readonly featureSessionFlags: Readonly<Record<string, boolean>> = {},
  ) {}

  send(frame: unknown): void {
    const request = frame as Record<string, unknown>;
    this.sent.push(request);
    const id = request.id as number;
    if (request.method === "initialize") this.push({ id, result: {} });
    if (request.method === "config/read") this.push({
      id,
      result: {
        config: { mcp_servers: this.mcpServers, web_search: this.webSearch, tools: { web_search: this.nativeWebSearch }, features: { ...disabledCodexFeatures, ...this.featureOverrides } },
        ...(this.nativeWebSearchSessionFlag === null && Object.keys(this.featureSessionFlags).length === 0 ? {} : {
          origins: {
            ...(this.nativeWebSearchSessionFlag === null ? {} : {
              "tools.web_search": { name: { type: "sessionFlags" }, version: "session-overrides" },
            }),
            ...Object.fromEntries(Object.keys(this.featureSessionFlags).map((feature) => [
              `features.${feature}`,
              { name: { type: "sessionFlags" }, version: "session-overrides" },
            ])),
          },
          layers: [{
            name: { type: "sessionFlags" },
            version: "session-overrides",
            config: {
              ...(this.nativeWebSearchSessionFlag === null ? {} : {
                tools: { web_search: this.nativeWebSearchSessionFlag },
              }),
              features: this.featureSessionFlags,
            },
          }],
        }),
      },
    });
    if (request.method === "thread/start") this.push({ id, result: { thread: { id: "thread-1" } } });
    if (request.method === "turn/start") {
      this.push({ id, result: { turn: { id: "turn-1" } } });
      for (const item of this.completedItems) {
        this.push({ method: "item/completed", params: { item } });
      }
      this.push({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 12, outputTokens: 7 } } } });
      this.push({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } } });
    }
  }

  private push(frame: unknown): void {
    this.queue.push(frame);
    this.wait?.();
    this.wait = null;
  }

  readonly frames = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        while (this.queue.length === 0 && !this.ended) await new Promise<void>((resolve) => (this.wait = resolve));
        return this.queue.length > 0 ? { value: this.queue.shift(), done: false } : { value: undefined, done: true };
      },
    }),
  };

  async close(): Promise<void> {
    this.ended = true;
    this.wait?.();
  }
}

test("Codex workload adapter permits cached hosted search while disabling native execution tools and completing multiple repository MCP calls", async () => {
  const transport = new ScriptedTransport();
  let args: readonly string[] = [];
  const adapter = new CodexPersonaWorkloadAdapter({ async connect(value) { args = value; return transport; } });
  const result = await adapter.run(launch("codex"), new AbortController().signal);
  assert.deepEqual(result.repositoryToolCalls, ["mcp__repository__read", "mcp__repository__git_diff"]);
  assert.ok(args.includes("features.shell_tool=false"));
  assert.ok(args.includes("features.unified_exec=false"));
  assert.ok(args.includes("mcp_servers={}"));
  assert.ok(args.includes("features.plugins=false"));
  assert.ok(args.includes("features.apps=false"));
  for (const feature of PERSONA_CODEX_DISABLED_FEATURES) {
    assert.ok(args.includes(`features.${feature}=false`));
  }
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("tools.web_search=false"));
  assert.ok(args.some((arg) => arg.startsWith("mcp_servers.repository.enabled_tools=")));
  assert.equal(args.some((arg) => arg.startsWith("mcp_servers.mission-control")), false);
  const start = transport.sent.find((frame) => frame.method === "thread/start")?.params as Record<string, unknown>;
  assert.equal(start.approvalPolicy, "on-request");
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.ephemeral, true);
  const turn = transport.sent.find((frame) => frame.method === "turn/start")?.params as Record<string, unknown>;
  assert.equal(turn.approvalPolicy, "on-request");
  assert.ok(turn.outputSchema);
});

test("Codex workload adapter aborts while provider connection setup is pending", async () => {
  const controller = new AbortController();
  let observedOptions: unknown;
  const adapter = new CodexPersonaWorkloadAdapter({
    async connect(...args: unknown[]) {
      observedOptions = args[2];
      return await new Promise<AppServerTransport>(() => {});
    },
  });
  const run = adapter.run(launch("codex"), controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled during connect"));

  await assert.rejects(
    Promise.race([
      run,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("connect did not observe cancellation")), 250)),
    ]),
    /cancelled during connect/,
  );
  assert.equal((observedOptions as { signal?: AbortSignal } | undefined)?.signal, controller.signal);
});

test("Codex workload verifies the native web-search override through its resolved session layer", async () => {
  const transport = new ScriptedTransport(
    { repository: {} },
    "cached",
    {},
    null,
    undefined,
    false,
  );
  const adapter = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
  const result = await adapter.run(launch("codex"), new AbortController().signal);
  assert.equal(result.rawVerdict, JSON.stringify(verdict));
  const read = transport.sent.find((frame) => frame.method === "config/read");
  assert.ok(read);
  assert.equal((read.params as Record<string, unknown>).includeLayers, true);
});

test("Codex workload verifies disabled features through their resolved session layer", async () => {
  const transport = new ScriptedTransport(
    { repository: {} },
    "cached",
    { memories: null },
    false,
    undefined,
    null,
    { memories: false },
  );
  const adapter = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
  const result = await adapter.run(launch("codex"), new AbortController().signal);
  assert.equal(result.rawVerdict, JSON.stringify(verdict));
});

test("Claude and Codex workload adapters preserve daemon-owned submission images", async () => {
  const fixture = repositoryViewFixture();
  const image = writeImageDescriptor(fixture.root, "submission.png", PNG_IMAGE, "image/png", "submission-image");
  let claudeMessage: ClaudeSdkUserMessage | null = null;
  const claude = new ClaudePersonaWorkloadAdapter({
    executable: async () => "/usr/bin/claude",
    env: () => ({}),
    async query(params) {
      assert.notEqual(typeof params.prompt, "string");
      for await (const message of params.prompt as AsyncIterable<ClaudeSdkUserMessage>) claudeMessage = message;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__repository__read" }, { type: "tool_use", name: "mcp__repository__git_diff" }] } };
          yield { type: "result", subtype: "success", is_error: false, structured_output: verdict, usage: {} };
        },
      };
    },
  });
  const transport = new ScriptedTransport();
  const codex = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
  try {
    await claude.run(launch("claude", [image]), new AbortController().signal);
    await codex.run(launch("codex", [image]), new AbortController().signal);
    const observedClaudeMessage = claudeMessage as unknown as ClaudeSdkUserMessage | null;
    const content = observedClaudeMessage?.message.content;
    assert.ok(Array.isArray(content));
    assert.deepEqual(content[0], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_IMAGE.toString("base64") },
    });
    const turn = transport.sent.find((frame) => frame.method === "turn/start")?.params as { input: unknown[] };
    assert.deepEqual(turn.input[0], { type: "localImage", path: image.path });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Codex workload rejects inherited MCP servers before starting a thread", async () => {
  const transport = new ScriptedTransport({ repository: {}, operator_server: {} });
  const adapter = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
  await assert.rejects(
    adapter.run(launch("codex"), new AbortController().signal),
    /inherited an MCP server outside the repository capability/,
  );
  assert.equal(transport.sent.some((frame) => frame.method === "thread/start"), false);
});

test("Codex workload accepts inherited MCP definitions only when they are explicitly disabled", async () => {
  const transport = new ScriptedTransport({ repository: {}, operator_server: { enabled: false } });
  const adapter = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
  const result = await adapter.run(launch("codex"), new AbortController().signal);
  assert.equal(result.rawVerdict, JSON.stringify(verdict));
  assert.deepEqual(
    codexInheritedMcpDisableArgs(["repository", "z-server", "operator_server", "operator_server"]),
    ["-c", "mcp_servers.operator_server.enabled=false", "-c", "mcp_servers.z-server.enabled=false"],
  );
  assert.throws(
    () => codexInheritedMcpDisableArgs(["repository", "unsafe server"]),
    /cannot safely disable inherited MCP server/,
  );
});

test("Codex workload rejects indexed or live hosted search before starting a thread", async () => {
  for (const mode of ["indexed", "live"] as const) {
    const transport = new ScriptedTransport({ repository: {} }, mode);
    const adapter = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
    await assert.rejects(
      adapter.run(launch("codex"), new AbortController().signal),
      /exceeded the cached-only hosted-search policy/,
    );
    assert.equal(transport.sent.some((frame) => frame.method === "thread/start"), false);
  }
});

test("Codex workload rejects any explicitly disabled feature before starting a thread", async () => {
  for (const feature of PERSONA_CODEX_DISABLED_FEATURES) {
    const transport = new ScriptedTransport({ repository: {} }, "cached", { [feature]: true });
    const adapter = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
    await assert.rejects(
      adapter.run(launch("codex"), new AbortController().signal),
      new RegExp(`did not disable ${feature}`),
    );
    assert.equal(transport.sent.some((frame) => frame.method === "thread/start"), false);
  }
});

test("Codex workload rejects an enabled native web search tool before starting a thread", async () => {
  const transport = new ScriptedTransport({ repository: {} }, "cached", {}, true);
  const adapter = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
  await assert.rejects(
    adapter.run(launch("codex"), new AbortController().signal),
    /did not disable tools.web_search/,
  );
  assert.equal(transport.sent.some((frame) => frame.method === "thread/start"), false);
});

test("Codex workload rejects unexpected completed item types", async () => {
  const transport = new ScriptedTransport(
    { repository: {} },
    "cached",
    {},
    false,
    [
      { type: "imageGeneration", id: "image-1" },
      { type: "agentMessage", text: JSON.stringify(verdict) },
    ],
  );
  const adapter = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
  await assert.rejects(
    adapter.run(launch("codex"), new AbortController().signal),
    /forbidden provider item imageGeneration/,
  );
});

test("Claude and Codex adapters propagate cancellation into their live provider sessions", async () => {
  let claudeAbort: AbortSignal | null = null;
  const claude = new ClaudePersonaWorkloadAdapter({
    executable: async () => "/usr/bin/claude",
    env: () => ({}),
    async query({ options }) {
      claudeAbort = options.abortController.signal;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<never>>((_resolve, reject) => {
              options.abortController.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            }),
          };
        },
      };
    },
  });
  const claudeController = new AbortController();
  const claudeRun = claude.run(launch("claude"), claudeController.signal);
  while (!claudeAbort) await new Promise((resolve) => setImmediate(resolve));
  claudeController.abort(new Error("cancelled"));
  await assert.rejects(claudeRun, /cancelled/);
  assert.equal((claudeAbort as AbortSignal | null)?.aborted, true);

  class CancellableTransport extends ScriptedTransport {
    override send(frame: unknown): void {
      const request = frame as Record<string, unknown>;
      if (request.method === "turn/interrupt") {
        (this as unknown as { push(frame: unknown): void }).push({ id: request.id, result: {} });
      }
      super.send(frame);
    }
  }
  const transport = new CancellableTransport();
  // Stop the scripted success frames so the turn remains live until cancellation.
  const originalSend = transport.send.bind(transport);
  transport.send = (frame: unknown) => {
    const request = frame as Record<string, unknown>;
    if (request.method === "turn/start") {
      transport.sent.push(request);
      (transport as unknown as { push(frame: unknown): void }).push({ id: request.id, result: { turn: { id: "turn-1" } } });
      return;
    }
    originalSend(frame);
  };
  const codex = new CodexPersonaWorkloadAdapter({ async connect() { return transport; } });
  const codexController = new AbortController();
  const codexRun = codex.run(launch("codex"), codexController.signal);
  while (!transport.sent.some((frame) => frame.method === "turn/start")) await new Promise((resolve) => setImmediate(resolve));
  codexController.abort(new Error("cancelled"));
  await assert.rejects(codexRun, /cancelled/);
  assert.ok(transport.sent.some((frame) => frame.method === "turn/interrupt"));
});

function request(provider: "claude" | "codex", descriptorDigest: string): PersonaWorkloadRequest {
  return {
    schemaVersion: 1,
    workloadId: `workload-${provider}`,
    workflowAttemptId: `attempt-${provider}`,
    submissionId: `submission-${provider}`,
    idempotencyKey: `key-${provider}`,
    persona: { id: "persona-1", name: "Reviewer", description: "", guidance: "Review carefully" },
    provider,
    model: "test-model",
    prompt: "Review",
    images: [],
    textEvidence: [{ id: "text-1", kind: "submission", text: "daemon-owned evidence", sha256: "b".repeat(64) }],
    artifactLocator: "fixture-artifact",
    artifactDigest: descriptorDigest,
    historyPolicy: REPOSITORY_HISTORY_POLICY_V1,
    budgets: DEFAULT_REPOSITORY_BUDGETS,
    deadline: Date.now() + 60_000,
    cancellationGeneration: 0,
    repositoryEvidenceProtocol: REPOSITORY_EVIDENCE_PROTOCOL,
    hostedSearchMaximum: "cached",
    llmCall: { callId: `call-${provider}`, purpose: "persona_review", attempt: 1 },
  };
}

function audit(operation: "read" | "git_diff", range: RepositoryEvidenceRange, ordinal: number): RepositoryQueryAuditMetadata {
  return {
    operationInstanceId: `operation-${ordinal}`,
    operation,
    normalizedInputHash: `${ordinal}`.repeat(64),
    status: "ok",
    failureCode: null,
    byteCount: 10,
    itemCount: 1,
    truncated: false,
    durationMs: 2,
    handles: [{ handleId: `handle-${ordinal}` as never, snapshotDigest: "DIGEST", workloadId: "WORKLOAD", workflowAttemptId: "ATTEMPT", operationInstanceId: `operation-${ordinal}`, operation, itemOrdinal: 1, path: "source.txt", policyVersion: 1, truncated: false, range }],
  };
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fallback = setTimeout(() => reject(new Error("executor did not enforce the workload deadline")), 1_000);
    const abort = () => {
      clearTimeout(fallback);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

test("local Claude and Codex workloads preserve identical line, byte, diff, evidence, and call-accounting contracts", async () => {
  const fixture = repositoryViewFixture();
  const launches: PersonaProviderLaunch[] = [];
  const materializations: unknown[] = [];
  const ranges: RepositoryEvidenceRange[] = [
    { kind: "line", startLine: 1, endLineExclusive: 3 },
    { kind: "byte", startByte: 0, endByteExclusive: 5, encoding: "raw" },
    { kind: "diff", old: { startLine: 2, endLineExclusive: 2 }, new: { startLine: 2, endLineExclusive: 4 } },
  ];
  const provider = (id: "claude" | "codex"): PersonaWorkloadProviderAdapter => ({
    id,
    async run(value) {
      launches.push(value);
      const configPath = value.repositoryMcp.env.MISSION_REPOSITORY_MCP_CONFIG!;
      const config = JSON.parse(await readFile(configPath, "utf8")) as { auditPath: string; descriptor: { snapshotDigest: string }; workloadId: string; workflowAttemptId: string };
      for (const [index, range] of ranges.entries()) {
        const row = audit(index === 2 ? "git_diff" : "read", range, index + 1);
        row.handles[0]!.snapshotDigest = config.descriptor.snapshotDigest;
        row.handles[0]!.workloadId = config.workloadId;
        row.handles[0]!.workflowAttemptId = config.workflowAttemptId;
        await appendFile(config.auditPath, `${JSON.stringify(row)}\n`);
      }
      return { rawVerdict: JSON.stringify(verdict), usage: { inputTokens: 5 }, repositoryToolCalls: ["mcp__repository__read", "mcp__repository__read", "mcp__repository__git_diff"] };
    },
  });
  const executor = new LocalPersonaWorkloadExecutor({
    materializer: {
      async materialize(value) {
        materializations.push(value);
        return { descriptor: fixture.descriptor, async release() {} };
      },
    },
    providers: { claude: provider("claude"), codex: provider("codex") },
    repositoryMcpEntrypoint: "/tmp/repository-mcp.mjs",
  });
  try {
    const collect = async (providerId: "claude" | "codex") => {
      const events: PersonaWorkloadEvent[] = [];
      for await (const event of executor.dispatch(request(providerId, fixture.descriptor.snapshotDigest), new AbortController().signal)) events.push(event);
      return events;
    };
    const claude = await collect("claude");
    const codex = await collect("codex");
    assert.deepEqual(claude.map((event) => event.kind), codex.map((event) => event.kind));
    const queryRanges = (events: PersonaWorkloadEvent[]) => events.filter((event) => event.kind === "repository_query").flatMap((event) => event.audit.handles.map((handle) => handle.range));
    assert.deepEqual(queryRanges(claude), ranges);
    assert.deepEqual(queryRanges(codex), ranges);
    for (const value of materializations as Array<Record<string, string>>) {
      assert.ok(value.submissionId && value.workloadId && value.workflowAttemptId && value.artifactLocator && value.artifactDigest);
    }
    assert.equal(launches.length, 2);
    assert.deepEqual(launches[0]?.allowedTools, launches[1]?.allowedTools);
    assert.match(launches[0]!.prompt, /daemon-owned evidence/);
    assert.equal(launches.some((value) => value.workingDirectory === fixture.root), false);
    for (const events of [claude, codex]) {
      const terminal = events.at(-1);
      assert.equal(terminal?.kind, "completed");
      if (terminal?.kind === "completed") {
        assert.equal(terminal.result.kind, "succeeded");
        if (terminal.result.kind === "succeeded") assert.ok(terminal.result.llmCall.inputBytes > 0);
      }
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the workload deadline aborts materialization and returns a structured deadline failure", async () => {
  const fixture = repositoryViewFixture();
  let providerStarted = false;
  const provider: PersonaWorkloadProviderAdapter = {
    id: "claude",
    async run() {
      providerStarted = true;
      throw new Error("provider must not start before materialization");
    },
  };
  const executor = new LocalPersonaWorkloadExecutor({
    materializer: {
      async materialize(_value, signal) {
        return rejectWhenAborted(signal);
      },
    },
    providers: { claude: provider, codex: { ...provider, id: "codex" } },
    repositoryMcpEntrypoint: "/tmp/repository-mcp.mjs",
  });
  try {
    const events: PersonaWorkloadEvent[] = [];
    const input = { ...request("claude", fixture.descriptor.snapshotDigest), deadline: Date.now() + 100 };
    for await (const event of executor.dispatch(input, new AbortController().signal)) events.push(event);
    assert.equal(providerStarted, false);
    const completed = events.at(-1);
    assert.equal(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assert.equal(completed.result.kind, "failed");
      assert.equal(completed.result.kind === "failed" ? completed.result.code : null, "deadline_exceeded");
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the workload deadline aborts provider execution and releases the repository lease", async () => {
  const fixture = repositoryViewFixture();
  let releases = 0;
  const provider: PersonaWorkloadProviderAdapter = {
    id: "claude",
    async run(_launch, signal) {
      return rejectWhenAborted(signal);
    },
  };
  const executor = new LocalPersonaWorkloadExecutor({
    materializer: {
      async materialize() {
        return {
          descriptor: fixture.descriptor,
          async release() {
            releases += 1;
          },
        };
      },
    },
    providers: { claude: provider, codex: { ...provider, id: "codex" } },
    repositoryMcpEntrypoint: "/tmp/repository-mcp.mjs",
  });
  try {
    const events: PersonaWorkloadEvent[] = [];
    const input = { ...request("claude", fixture.descriptor.snapshotDigest), deadline: Date.now() + 100 };
    for await (const event of executor.dispatch(input, new AbortController().signal)) events.push(event);
    const completed = events.at(-1);
    assert.equal(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assert.equal(completed.result.kind, "failed");
      assert.equal(completed.result.kind === "failed" ? completed.result.code : null, "deadline_exceeded");
    }
    assert.equal(releases, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation generations are monotonic and replay cannot revive a workload", async () => {
  const fixture = repositoryViewFixture();
  let started = false;
  const slow: PersonaWorkloadProviderAdapter = {
    id: "claude",
    async run(_launch, signal) {
      started = true;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      throw new Error("unreachable");
    },
  };
  const executor = new LocalPersonaWorkloadExecutor({ materializer: { async materialize() { return { descriptor: fixture.descriptor, async release() {} }; } }, providers: { claude: slow, codex: { ...slow, id: "codex" } }, repositoryMcpEntrypoint: "/tmp/repository-mcp.mjs" });
  try {
    const events: PersonaWorkloadEvent[] = [];
    const collecting = (async () => { for await (const event of executor.dispatch(request("claude", fixture.descriptor.snapshotDigest), new AbortController().signal)) events.push(event); })();
    while (!started) await new Promise((resolve) => setImmediate(resolve));
    await executor.cancel("workload-claude", 2);
    await executor.cancel("workload-claude", 1);
    await collecting;
    assert.equal(events.filter((event) => event.kind === "cancel_requested").length, 1);
    const reconciled = await executor.reconcile("workload-claude", 2);
    assert.equal(reconciled.cancellationGeneration, 2);
    assert.equal(reconciled.state, "cancelled");
    assert.ok(reconciled.events.every((event) => event.sequence > 2));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a provider result arriving after cancellation preserves only audit and call accounting", async () => {
  const fixture = repositoryViewFixture();
  let started = false;
  const late: PersonaWorkloadProviderAdapter = {
    id: "claude",
    async run(value, signal) {
      const config = JSON.parse(await readFile(value.repositoryMcp.env.MISSION_REPOSITORY_MCP_CONFIG!, "utf8")) as {
        auditPath: string;
        descriptor: { snapshotDigest: string };
        workloadId: string;
        workflowAttemptId: string;
      };
      for (const [index, operation] of (["read", "git_diff"] as const).entries()) {
        const row = audit(operation, index === 0
          ? { kind: "line", startLine: 1, endLineExclusive: 2 }
          : { kind: "diff", old: { startLine: 1, endLineExclusive: 1 }, new: { startLine: 1, endLineExclusive: 2 } }, index + 1);
        row.handles[0]!.snapshotDigest = config.descriptor.snapshotDigest;
        row.handles[0]!.workloadId = config.workloadId;
        row.handles[0]!.workflowAttemptId = config.workflowAttemptId;
        await appendFile(config.auditPath, `${JSON.stringify(row)}\n`);
      }
      started = true;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return {
        rawVerdict: JSON.stringify(verdict),
        usage: { inputTokens: 5, outputTokens: 3 },
        repositoryToolCalls: ["mcp__repository__read", "mcp__repository__git_diff"],
      };
    },
  };
  const executor = new LocalPersonaWorkloadExecutor({
    materializer: { async materialize() { return { descriptor: fixture.descriptor, async release() {} }; } },
    providers: { claude: late, codex: { ...late, id: "codex" } },
    repositoryMcpEntrypoint: "/tmp/repository-mcp.mjs",
  });
  try {
    const events: PersonaWorkloadEvent[] = [];
    const collecting = (async () => {
      for await (const event of executor.dispatch(request("claude", fixture.descriptor.snapshotDigest), new AbortController().signal)) events.push(event);
    })();
    while (!started) await new Promise((resolve) => setImmediate(resolve));
    await executor.cancel("workload-claude", 1);
    await collecting;
    assert.equal(events.filter((event) => event.kind === "repository_query").length, 2);
    const completed = events.at(-1);
    assert.equal(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assert.equal(completed.result.kind, "failed");
      assert.equal(completed.result.kind === "failed" ? completed.result.code : null, "cancelled");
      assert.equal(completed.result.llmCall?.providerUsage?.outputTokens, 3);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the local executor retains only a bounded terminal reconciliation window", async () => {
  const fixture = repositoryViewFixture();
  let providerRuns = 0;
  const failing: PersonaWorkloadProviderAdapter = {
    id: "claude",
    async run() {
      providerRuns += 1;
      throw new Error("synthetic provider failure");
    },
  };
  const executor = new LocalPersonaWorkloadExecutor({
    materializer: { async materialize() { return { descriptor: fixture.descriptor, async release() {} }; } },
    providers: { claude: failing, codex: { ...failing, id: "codex" } },
    repositoryMcpEntrypoint: "/tmp/repository-mcp.mjs",
    maxRetainedTerminalWorkloads: 1,
  });
  const collect = async (input: PersonaWorkloadRequest) => {
    const events: PersonaWorkloadEvent[] = [];
    for await (const event of executor.dispatch(input, new AbortController().signal)) events.push(event);
    return events;
  };
  try {
    const first = { ...request("claude", fixture.descriptor.snapshotDigest), workloadId: "workload-first", idempotencyKey: "key-first" };
    const second = { ...request("claude", fixture.descriptor.snapshotDigest), workloadId: "workload-second", idempotencyKey: "key-second" };
    await collect(first);
    await collect(second);

    assert.equal((await executor.reconcile(first.workloadId, 0)).state, "unknown");
    assert.equal((await executor.reconcile(second.workloadId, 0)).state, "completed");
    const replay = await collect(second);
    assert.equal(replay.at(-1)?.kind, "completed");
    assert.equal(providerRuns, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
