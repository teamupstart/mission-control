// The `mcp` transport against a local fixture server with a `get_guidance` tool, over stdio and
// over streamable HTTP on loopback: the arguments each `contextDelivery` mode sends, replies and
// failures, the 256 KiB message cap, one connection per run, header references, redaction, and
// the trace context and work unit id every call carries. No real service, no credential.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const home = mkdtempSync(join(tmpdir(), "mission-shaping-mcp-"));
process.env.MISSION_HOME = home;
const { SHAPING_CONFIG_DEFAULTS, ShaperSchema, ShapingContextSchema } = await import("../src/shared/shaping.ts");
const { callMcp, foldedContextBlock, mcpToolArguments } = await import("../src/server/shaping/transports/mcp.ts");
const { runScope, shapeTask } = await import("../src/server/shaping/engine.ts");
const { startGuidanceHttp } = await import("./fixtures/fake-guidance-mcp.mjs");
import type { Shaper, ShapingContext, ShapingRequest } from "../src/shared/shaping.ts";
import type { ShaperOf, TransportContext, TransportReply } from "../src/server/shaping/transports/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-guidance-mcp.mjs", import.meta.url));
after(() => rmSync(home, { recursive: true, force: true }));

const TRACE = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "mc=launch" };
const TRACEPARENT_SHAPE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const KEY_ENV = "SHAPING_MCP_FIXTURE_KEY";
const KEY = "fixture-key-7f3a9c";

type Delivery = "folded" | "argument";
type Server = { type: "stdio"; mode: string; args?: string[]; env?: string[] } | { type: "http"; url: string; headers?: Record<string, string> };

function shaper(server: Server, delivery: Delivery = "folded", extra: Record<string, unknown> = {}): ShaperOf<"mcp"> {
  const definition = server.type === "stdio"
    ? { type: "stdio", command: process.execPath, args: [FIXTURE, server.mode, ...(server.args ?? [])], env: server.env ?? [] }
    : { type: "http", url: server.url, headers: server.headers ?? {} };
  return ShaperSchema.parse({
    id: "guidance", label: "Guidance", stage: "select",
    transport: { type: "mcp", server: definition, tool: "get_guidance", contextDelivery: delivery },
    timeoutMs: 30_000, ...extra,
  }) as ShaperOf<"mcp">;
}

/** A two-repository task: both on the same branch name, with different base commits. */
function context(local: boolean, target = "repo-01"): ShapingContext {
  return {
    taskId: "t_123", title: "Retry failed charges", kind: "ship", harness: "claude", runtime: "sdk",
    afterWork: { workflowId: "wf_1", name: "Review and merge" }, labels: ["payments"], priority: "high",
    repositories: [
      { slot: "repo-01", name: "billing-api", role: "primary", branch: "task/retry", baseSha: "abc123", ...(local ? { path: "/work/billing-api" } : {}) },
      { slot: "repo-02", name: "ledger", role: "additional", branch: "task/retry", baseSha: "def456", ...(local ? { path: "/work/ledger" } : {}) },
    ],
    target,
    caller: { user: "declared-user", agent: "claude", conversation: "t_123" },
  };
}

function request(local = true, target = "repo-01"): ShapingRequest {
  return {
    protocol: 1, stage: "select", task: "Retry failed charges",
    repo: { name: "billing-api", facts: { language: "python" }, summary: "A payments service." },
    version: "v1.4.0", context: context(local, target), limits: { maxBytes: 16_384, deadlineMs: 30_000 },
  };
}

const scopes: Array<ReturnType<typeof runScope>> = [];
after(() => { for (const scope of scopes) scope.close(); });

function ctx(extra: Partial<TransportContext> = {}, timeoutMs = 30_000): TransportContext {
  const scope = runScope();
  scopes.push(scope);
  return { deadline: Date.now() + timeoutMs, timeoutMs, signal: new AbortController().signal, scope, root: null, trace: null, workUnitId: null, ...extra };
}

/** The decoded value of a data reply: the structured content, or the text it parsed to. */
function data(reply: TransportReply): any {
  assert.equal(reply.kind, "data", JSON.stringify(reply));
  const value = (reply as { data: unknown }).data;
  return typeof value === "string" ? JSON.parse(value) : value;
}

/** What the echo tool saw. */
function echoed(reply: TransportReply): {
  arguments: Record<string, unknown>; meta: Record<string, unknown> | null; env: Record<string, string | null>;
  envKeys: string[]; headers: Record<string, string> | null; pid: number;
} {
  return JSON.parse(data(reply).guidance[0].body);
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { return await run(); } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Both server types, each started for one test and stopped after it. */
async function eachServer(mode: string, args: string[], run: (server: Server, label: string) => Promise<void>, json = true): Promise<void> {
  await run({ type: "stdio", mode, args }, "stdio");
  const http = await startGuidanceHttp({ mode, args, json });
  try { await run({ type: "http", url: http.url }, "streamable HTTP"); } finally { await http.close(); }
}

// ---------------------------------------------------------------------------------------------
// The folded block

test("the folded block states every field of the context except local paths, in its fixed text", () => {
  assert.equal(foldedContextBlock(context(true)), [
    "Task context from Mission Control:",
    "- Task: t_123",
    "- Title: Retry failed charges",
    "- Kind: ship",
    "- Harness: claude (sdk)",
    "- After-work step: Review and merge (workflow wf_1)",
    "- Labels: payments",
    "- Priority: high",
    "- Caller: declared-user (agent claude, conversation t_123)",
    "- This call is about: repo-01",
    "- Repositories: repo-01 billing-api (primary, branch task/retry, base abc123), repo-02 ledger (additional, branch task/retry, base def456)",
  ].join("\n"));
  assert.equal(foldedContextBlock(context(true)).includes("/work/"), false, "never a local path");
  const dry = foldedContextBlock({
    ...context(false), taskId: null, harness: null, runtime: null, afterWork: null, labels: [], priority: null,
    caller: { user: null, agent: null, conversation: null }, title: "Two\nlines",
  });
  assert.match(dry, /^- Task: none$/m);
  assert.match(dry, /^- Title: Two\\nlines$/m, "a line break in a value cannot start a line of its own");
  assert.match(dry, /^- Caller: undeclared \(agent none, conversation none\)$/m);
});

/** Every leaf of a Zod schema, as a path, with two different values it accepts. */
function leaves(schema: z.ZodType, path: Array<string | number> = []): Array<{ path: Array<string | number>; values: [unknown, unknown] }> {
  let inner: z.ZodType = schema;
  while (inner instanceof z.ZodNullable || inner instanceof z.ZodOptional) inner = (inner as z.ZodNullable<z.ZodType>).unwrap() as z.ZodType;
  if (inner instanceof z.ZodObject) return Object.entries(inner.shape as Record<string, z.ZodType>).flatMap(([key, child]) => leaves(child, [...path, key]));
  if (inner instanceof z.ZodArray) return leaves(inner.element as z.ZodType, [...path, 0]);
  if (inner instanceof z.ZodEnum) {
    const options = inner.options as string[];
    return [{ path, values: [options[0], options[1]] }];
  }
  const name = path.join(".");
  // A slot must look like one; every other leaf is free text.
  return [{ path, values: /slot$|^target$/.test(name) ? ["repo-01", "repo-02"] : [`first-${name}`, `second-${name}`] }];
}

function setAt(value: any, path: Array<string | number>, leaf: unknown): any {
  const copy = structuredClone(value);
  let node = copy;
  for (const key of path.slice(0, -1)) {
    node[key] ??= typeof key === "number" ? [] : {};
    node = node[key];
  }
  node[path.at(-1)!] = leaf;
  return copy;
}

test("every field the context schema declares has a line in the folded block, except local paths", () => {
  const all = leaves(ShapingContextSchema);
  const names = all.map(({ path }) => path.join("."));
  for (const nested of ["afterWork.workflowId", "repositories.0.slot", "repositories.0.baseSha", "caller.conversation", "target"]) {
    assert.ok(names.includes(nested), `the walk reached ${nested}`);
  }
  for (const { path, values } of all) {
    const first = foldedContextBlock(setAt(context(true), path, values[0]));
    const second = foldedContextBlock(setAt(context(true), path, values[1]));
    if (path.at(-1) === "path") {
      assert.equal(first, second, `${path.join(".")} is a local path and never reaches the block`);
      assert.equal(first.includes(String(values[0])), false);
    } else {
      assert.notEqual(first, second, `${path.join(".")} has no line in the folded block`);
    }
  }
});

test("the tool's arguments: exactly FR-02's three in folded mode, four with the whole context in argument mode", () => {
  const folded = mcpToolArguments(request(), "folded");
  assert.deepEqual(Object.keys(folded).sort(), ["repo", "task", "version"]);
  assert.equal(folded.task, `Retry failed charges\n\n${foldedContextBlock(context(true))}`);
  assert.deepEqual(folded.repo, { name: "billing-api", facts: { language: "python" }, summary: "A payments service." });
  const argument = mcpToolArguments(request(), "argument");
  assert.deepEqual(Object.keys(argument).sort(), ["context", "repo", "task", "version"]);
  assert.equal(argument.task, "Retry failed charges", "the prompt alone");
  assert.deepEqual(argument.context, context(true));
});

// ---------------------------------------------------------------------------------------------
// Over the wire, on both server types

test("folded mode calls the tool with exactly three arguments that carry every collected field", async () => {
  await eachServer("echo", [], async (server, label) => {
    const local = server.type === "stdio";
    const seen = echoed(await callMcp(request(local), shaper(server, "folded"), ctx()));
    assert.deepEqual(Object.keys(seen.arguments).sort(), ["repo", "task", "version"], label);
    assert.deepEqual(seen.arguments.repo, { name: "billing-api", facts: { language: "python" }, summary: "A payments service." }, `${label}: no path in repo`);
    const task = String(seen.arguments.task);
    for (const field of ["t_123", "Retry failed charges", "ship", "claude (sdk)", "Review and merge (workflow wf_1)", "payments", "high",
      "declared-user (agent claude, conversation t_123)", "This call is about: repo-01",
      "repo-01 billing-api (primary, branch task/retry, base abc123)", "repo-02 ledger (additional, branch task/retry, base def456)"]) {
      assert.ok(task.includes(field), `${label}: the folded task carries ${field}`);
    }
    assert.equal(task.includes("/work/"), false, `${label}: never a local path`);
  });
});

test("argument mode calls the tool with four arguments, the fourth the request's whole context", async () => {
  await eachServer("echo", [], async (server, label) => {
    const local = server.type === "stdio";
    const seen = echoed(await callMcp(request(local), shaper(server, "argument"), ctx()));
    assert.deepEqual(Object.keys(seen.arguments).sort(), ["context", "repo", "task", "version"], label);
    assert.equal(seen.arguments.task, "Retry failed charges");
    assert.deepEqual(seen.arguments.context, context(local), `${label}: every collected field, both repositories told apart by base`);
  });
});

test("two attached worktrees of one repository are told apart by the target slot in each mode", async () => {
  const twins = (target: string): ShapingRequest => {
    const base = request(false, target);
    return {
      ...base,
      context: { ...base.context, repositories: base.context.repositories.map((repo) => ({ ...repo, name: "billing-api" })) },
    };
  };
  await eachServer("echo", [], async (server, label) => {
    for (const delivery of ["folded", "argument"] as const) {
      const scope = ctx();
      const first = echoed(await callMcp(twins("repo-01"), shaper(server, delivery), scope)).arguments;
      const second = echoed(await callMcp(twins("repo-02"), shaper(server, delivery), scope)).arguments;
      assert.deepEqual(first.repo, second.repo, `${label} ${delivery}: the same repository by name`);
      if (delivery === "folded") {
        assert.match(String(first.task), /^- This call is about: repo-01$/m);
        assert.match(String(second.task), /^- This call is about: repo-02$/m);
        assert.match(String(first.task), /repo-01 billing-api \(primary.*repo-02 billing-api \(additional/);
      } else {
        assert.equal((first.context as ShapingContext).target, "repo-01");
        assert.equal((second.context as ShapingContext).target, "repo-02");
      }
    }
  });
});

test("a structured reply and a text reply both reach the engine as data, and a degraded one passes through", async () => {
  for (const mode of ["ok", "text"]) {
    await eachServer(mode, [], async (server, label) => {
      const reply = await callMcp(request(server.type === "stdio"), shaper(server), ctx());
      assert.deepEqual(data(reply), { version: "v1.4.0", guidance: [{ id: "guide/billing-api", title: "Guide", body: "guidance for billing-api" }] }, `${mode} over ${label}`);
      assert.equal(reply.redacted, undefined);
    });
  }
  await eachServer("degraded", [], async (server) => {
    const value = data(await callMcp(request(server.type === "stdio"), shaper(server), ctx()));
    assert.equal(value.degraded, true);
    assert.deepEqual(value.notes, ["The guidance index is rebuilding."]);
  });
});

test("a tool error is failed with its text, and a slow tool times out at the call's budget", async () => {
  await eachServer("error", [], async (server) => {
    assert.deepEqual(await callMcp(request(server.type === "stdio"), shaper(server), ctx()),
      { kind: "failed", reason: "The tool returned an error: the caller may not read this guidance" });
  });
  await eachServer("slow", ["10000"], async (server, label) => {
    const started = Date.now();
    const reply = await callMcp(request(server.type === "stdio"), shaper(server), ctx({}, 1_500));
    assert.equal(reply.kind, "timed_out", `${label}: ${JSON.stringify(reply)}`);
    assert.ok(Date.now() - started < 5_000, `${label} answered at its budget, not the tool's pace`);
  });
});

test("a message over 256 KiB is failed at once, naming the cap, on each server type and both HTTP replies", async () => {
  const check = async (server: Server, label: string) => {
    const started = Date.now();
    const reply = await callMcp(request(server.type === "stdio"), shaper(server), ctx());
    assert.equal(reply.kind, "failed", `${label}: ${JSON.stringify(reply).slice(0, 300)}`);
    assert.match((reply as { reason: string }).reason, /larger than 256 KiB/);
    assert.ok(Date.now() - started < 10_000, `${label} failed at once, not at its 30 s deadline`);
  };
  await eachServer("overflow", [String(300 * 1024)], check, true);
  const stream = await startGuidanceHttp({ mode: "overflow", args: [String(300 * 1024)], json: false });
  try { await check({ type: "http", url: stream.url }, "streamable HTTP event stream"); } finally { await stream.close(); }
  // Just under the cap is an ordinary reply, which the engine refuses as not JSON.
  await eachServer("overflow", [String(200 * 1024)], async (server, label) => {
    const reply = await callMcp(request(server.type === "stdio"), shaper(server), ctx());
    assert.equal(reply.kind, "data", label);
  });
});

test("the cap applies to each message, not the stream: two events together over 256 KiB are read whole", async () => {
  // A notification and then the reply, each about 120 KiB and so under the cap, together over it.
  // On an event stream they are two events of one response, so a reader that capped the whole
  // stream instead of each event would fail this call. Over stdio they are two lines.
  const bytes = 120 * 1024;
  const check = async (server: Server, label: string) => {
    const reply = await callMcp(request(server.type === "stdio"), shaper(server), ctx());
    const value = data(reply);
    assert.equal(value.guidance[0].body.length, bytes, `${label}: the reply arrived whole`);
    assert.equal(value.guidance[0].id, "guide/billing-api");
  };
  const stream = await startGuidanceHttp({ mode: "two-messages", args: [String(bytes)], json: false });
  try {
    await check({ type: "http", url: stream.url }, "streamable HTTP event stream");
    const call = stream.requests.find(({ method, headers }) => method === "POST" && String(headers.accept).includes("text/event-stream"));
    assert.ok(call, "the call accepted an event stream");
  } finally { await stream.close(); }
  await check({ type: "stdio", mode: "two-messages", args: [String(bytes)] }, "stdio");
  // The same two messages, one of them over the cap, still fail: the count is per message.
  const over = await startGuidanceHttp({ mode: "two-messages", args: [String(300 * 1024)], json: false });
  try {
    const reply = await callMcp(request(false), shaper({ type: "http", url: over.url }), ctx());
    assert.equal(reply.kind, "failed");
    assert.match((reply as { reason: string }).reason, /larger than 256 KiB/);
  } finally { await over.close(); }
});

test("a run over two repositories starts one server process and closes it when the run ends", async () => {
  const config = {
    ...SHAPING_CONFIG_DEFAULTS,
    shapers: [shaper({ type: "stdio", mode: "echo" })],
    overrides: { guidance: true },
  };
  const result = await shapeTask({
    task: "Retry failed charges",
    context: {
      taskId: "t_123", title: "Retry", kind: "ship", harness: "claude", runtime: "sdk", afterWork: null, labels: [], priority: null,
      repositories: [
        { name: "billing-api", role: "primary", branch: "task/retry", baseSha: "abc123", path: home },
        { name: "ledger", role: "additional", branch: "task/retry", baseSha: "def456", path: home },
      ],
    },
  }, { config, discovered: [], enabled: true });
  const pids = result.entries.map((entry) => JSON.parse(entry.body).pid as number);
  assert.equal(pids.length, 2, JSON.stringify(result.summary));
  assert.equal(pids[0], pids[1], "one server process for the whole run");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; alive(pids[0]!) && waited < 10_000; waited += 100) await new Promise((done) => setTimeout(done, 100));
  assert.equal(alive(pids[0]!), false, "the server was closed when the run ended");
});

test("in argument mode a server started locally receives worktree paths, and a remote one never does", async () => {
  const http = await startGuidanceHttp({ mode: "echo" });
  try {
    const config = {
      ...SHAPING_CONFIG_DEFAULTS,
      shapers: [
        ShaperSchema.parse({ ...shaper({ type: "stdio", mode: "echo" }, "argument"), id: "local" }),
        ShaperSchema.parse({ ...shaper({ type: "http", url: http.url }, "argument"), id: "remote" }),
      ],
      overrides: { local: true, remote: true },
    };
    const result = await shapeTask({
      task: "Retry",
      context: {
        taskId: "t_1", title: "Retry", kind: "ship", harness: "claude", runtime: "sdk", afterWork: null, labels: [], priority: null,
        repositories: [{ name: "billing-api", role: "primary", branch: null, baseSha: null, path: "/work/billing-api" }],
      },
    }, { config, discovered: [], enabled: true });
    const byShaper = Object.fromEntries(result.entries.map((entry) => [entry.shaperId, JSON.parse(entry.body).arguments.context]));
    assert.equal(byShaper.local.repositories[0].path, "/work/billing-api");
    assert.equal("path" in byShaper.remote.repositories[0], false);
  } finally { await http.close(); }
});

// ---------------------------------------------------------------------------------------------
// References, egress and redaction

test("header references resolve at call time, and a missing one sends no request", async () => {
  const http = await startGuidanceHttp({ mode: "echo" });
  try {
    const headers = { "x-api-key": `{env:${KEY_ENV}}`, "x-caller": "{caller.user} via {caller.agent}" };
    const reply = await withEnv({ [KEY_ENV]: KEY }, () => callMcp(request(false), shaper({ type: "http", url: http.url, headers }), ctx()));
    const seen = echoed(reply);
    assert.equal(seen.headers?.["x-caller"], "[caller.user redacted] via [caller.agent redacted]", "a resolved caller value is redacted too");
    assert.equal(http.requests.at(-1)?.headers["x-caller"], "declared-user via claude");
    // The server received the resolved value, which is why its echo comes back redacted.
    assert.equal(seen.headers?.["x-api-key"], `[${KEY_ENV} redacted]`);
    assert.equal(reply.redacted, true);
    assert.equal(http.requests.at(-1)?.headers["x-api-key"], KEY);
    const before = http.requests.length;
    for (const value of [undefined, ""]) {
      const reply = await withEnv({ [KEY_ENV]: value }, () => callMcp(request(false), shaper({ type: "http", url: http.url, headers }), ctx()));
      assert.deepEqual(reply, { kind: "unavailable", reason: `The reference {env:${KEY_ENV}} did not resolve to a value, so the shaper was not called.` });
    }
    assert.equal(http.requests.length, before, "no request at all");
  } finally { await http.close(); }
});

test("a plain http URL to a host that is not loopback gets no request, with or without a credential header", async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { fetched += 1; return original(...args); }) as typeof fetch;
  try {
    for (const headers of [{}, { authorization: `Bearer {env:${KEY_ENV}}` }] as Array<Record<string, string>>) {
      const reply = await withEnv({ [KEY_ENV]: KEY }, () => callMcp(request(false), shaper({ type: "http", url: "http://guidance.example.invalid/mcp", headers }), ctx()));
      assert.equal(reply.kind, "unavailable");
      assert.match((reply as { reason: string }).reason, /plain http to a host that is not this machine/);
    }
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = original; }
});

test("a reply that echoes a resolved header value comes back redacted and marked, and so does a tool error", async () => {
  const echo = await startGuidanceHttp({ mode: "echo-header", args: ["x-api-key"] });
  const error = await startGuidanceHttp({ mode: "error-header", args: ["x-api-key"] });
  try {
    const headers = { "x-api-key": `{env:${KEY_ENV}}` };
    await withEnv({ [KEY_ENV]: KEY }, async () => {
      const reply = await callMcp(request(false), shaper({ type: "http", url: echo.url, headers }), ctx());
      assert.equal(reply.redacted, true);
      assert.equal(data(reply).guidance[0].body, `the server received [${KEY_ENV} redacted]`);
      assert.equal(JSON.stringify(reply).includes(KEY), false);
      const failed = await callMcp(request(false), shaper({ type: "http", url: error.url, headers }), ctx());
      assert.deepEqual(failed, { kind: "failed", reason: `The tool returned an error: denied for [${KEY_ENV} redacted]`, redacted: true });
    });
  } finally { await echo.close(); await error.close(); }
});

test("a value a local server receives through env pass-through is removed from its replies, as for a command shaper", async () => {
  const reply = await withEnv({ [KEY_ENV]: KEY }, () =>
    callMcp(request(), shaper({ type: "stdio", mode: "echo-env", args: [KEY_ENV], env: [KEY_ENV] }), ctx()));
  assert.equal(reply.redacted, true);
  assert.equal(data(reply).guidance[0].body, `the server holds [${KEY_ENV} redacted]`);
});

// ---------------------------------------------------------------------------------------------
// Trace context and the work unit id

test("streamable HTTP sends the trace context and work unit id on every request, and removes configured ones", async () => {
  const configured = { TraceParent: "00-11111111111111111111111111111111-2222222222222222-01", TRACESTATE: "vendor=configured", "X-Work-Unit-Id": "wu-configured" };
  /** One call against a server of its own, so no request of another call's connection is counted. */
  const call = async (extra: Partial<TransportContext>) => {
    const http = await startGuidanceHttp({ mode: "echo" });
    try {
      const seen = echoed(await callMcp(request(false), shaper({ type: "http", url: http.url, headers: configured }), ctx(extra)));
      return { seen, requests: [...http.requests] };
    } finally { await http.close(); }
  };
  const full = await call({ trace: TRACE, workUnitId: "wu_01JD5Z" });
  assert.ok(full.requests.length >= 3, "initialize, its notification and the call");
  for (const { method, headers } of full.requests) {
    assert.match(String(headers.traceparent), TRACEPARENT_SHAPE, `${method} carries a well-formed traceparent`);
    assert.equal(headers.traceparent, TRACE.traceparent);
    assert.equal(headers.tracestate, TRACE.tracestate);
    assert.equal(headers["x-work-unit-id"], "wu_01JD5Z", `${method} carries the work unit id`);
  }
  assert.deepEqual(full.seen.meta, { traceparent: TRACE.traceparent, tracestate: TRACE.tracestate, work_unit_id: "wu_01JD5Z" });

  const parentOnly = await call({ trace: { traceparent: TRACE.traceparent } });
  for (const { headers } of parentOnly.requests) {
    assert.equal(headers.traceparent, TRACE.traceparent);
    assert.equal(headers.tracestate, undefined, "the configured tracestate is never sent");
    assert.equal(headers["x-work-unit-id"], undefined, "with no work unit id, none at all");
  }
  assert.deepEqual(parentOnly.seen.meta, { traceparent: TRACE.traceparent });

  const none = await call({});
  for (const { headers } of none.requests) {
    assert.equal(Object.keys(headers).some((name) => /^(traceparent|tracestate|x-work-unit-id)$/i.test(name)), false);
  }
  assert.equal(none.seen.meta, null, "no _meta at all");
});

test("a stdio server starts with TRACEPARENT and WORK_UNIT_ID, and each tools/call carries them in _meta", async () => {
  await withEnv({ TRACEPARENT: "00-33333333333333333333333333333333-4444444444444444-01", WORK_UNIT_ID: "wu-inherited" }, async () => {
    const named = { type: "stdio" as const, mode: "echo", env: ["TRACEPARENT", "WORK_UNIT_ID"] };
    const seen = echoed(await callMcp(request(), shaper(named), ctx({ trace: TRACE, workUnitId: "wu_01JD5Z" })));
    assert.match(String(seen.env.TRACEPARENT), TRACEPARENT_SHAPE);
    assert.deepEqual(seen.env, { TRACEPARENT: TRACE.traceparent, TRACESTATE: TRACE.tracestate, WORK_UNIT_ID: "wu_01JD5Z" });
    assert.deepEqual(seen.meta, { traceparent: TRACE.traceparent, tracestate: TRACE.tracestate, work_unit_id: "wu_01JD5Z" });
    const none = echoed(await callMcp(request(), shaper(named), ctx()));
    assert.deepEqual(none.env, { TRACEPARENT: null, TRACESTATE: null, WORK_UNIT_ID: null }, "never a value inherited or passed through");
    assert.equal(none.meta, null);
  });
});

test("a reply that echoes the trace context or the work unit id keeps it, unredacted and unmarked", async () => {
  const http = await startGuidanceHttp({ mode: "echo-header", args: ["traceparent"] });
  const unit = await startGuidanceHttp({ mode: "echo-header", args: ["x-work-unit-id"] });
  try {
    await withEnv({ [KEY_ENV]: KEY }, async () => {
      const headers = { "x-api-key": `{env:${KEY_ENV}}` };
      const trace = await callMcp(request(false), shaper({ type: "http", url: http.url, headers }), ctx({ trace: TRACE }));
      assert.equal(data(trace).guidance[0].body, `the server received ${TRACE.traceparent}`);
      assert.equal(trace.redacted, undefined);
      const id = await callMcp(request(false), shaper({ type: "http", url: unit.url, headers }), ctx({ workUnitId: "wu_01JD5Z" }));
      assert.equal(data(id).guidance[0].body, "the server received wu_01JD5Z");
      assert.equal(id.redacted, undefined);
    });
  } finally { await http.close(); await unit.close(); }
});

test("an echoed credential is absent from the engine's section and summary, and the shaper is marked redacted", async () => {
  const http = await startGuidanceHttp({ mode: "echo-header", args: ["x-api-key"] });
  try {
    const remote: Shaper = shaper({ type: "http", url: http.url, headers: { "x-api-key": `{env:${KEY_ENV}}` } });
    const result = await withEnv({ [KEY_ENV]: KEY }, () => shapeTask({
      task: "Retry",
      context: {
        taskId: "t_1", title: "Retry", kind: "ship", harness: "claude", runtime: "sdk", afterWork: null, labels: [], priority: null,
        repositories: [{ name: "billing-api", role: "primary", branch: null, baseSha: null, path: null }],
      },
    }, { config: { ...SHAPING_CONFIG_DEFAULTS, shapers: [remote], overrides: { guidance: true } }, discovered: [], enabled: true }));
    assert.ok(result.section.includes(`[${KEY_ENV} redacted]`), result.section);
    assert.equal(result.section.includes(KEY), false);
    assert.equal(JSON.stringify(result.summary).includes(KEY), false);
    assert.equal(result.summary?.shapers[0]?.redacted, true, JSON.stringify(result.summary));
  } finally { await http.close(); }
});
