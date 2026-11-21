// The `mcp` transport against a local fixture server with a `get_guidance` tool, over stdio and
// over streamable HTTP on loopback: the arguments each `contextDelivery` mode sends, replies and
// failures, the 256 KiB message cap, one connection per run, header references, redaction, and
// the trace context and work unit id every call carries. No real service, no credential.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
const RAW_STDIO = fileURLToPath(new URL("./fixtures/raw-stdio-mcp.mjs", import.meta.url));
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

/**
 * A bare streamable-HTTP MCP endpoint on loopback that answers the handshake as JSON and the
 * `tools/call` as one event-stream event: a JSON-RPC result split over `lines` data lines, each
 * ended by CRLF. An empty data line adds only a newline to the event's data, which JSON reads as
 * whitespace, so the event is a valid message however many lines it has.
 */
async function startCrlfEventServer(lines: number): Promise<{ url: string; wireBytes: () => number; close(): Promise<void> }> {
  let wireBytes = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (message.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "crlf-fixture", version: "1.0.0" } },
      }));
      return;
    }
    const result = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { guidance: [{ id: "crlf", body: "one event" }] }, content: [] } });
    const event = `event: message\r\ndata: ${result}\r\n${"data: \r\n".repeat(lines)}\r\n`;
    wireBytes = Buffer.byteLength(event);
    res.writeHead(200, { "content-type": "text/event-stream" }).end(event);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    wireBytes: () => wireBytes,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

test("one event of many short CRLF lines is capped by its bytes on the wire, both bytes of each CRLF counted", async () => {
  // 34,000 lines of "data: \r\n", 8 bytes each: about 272 KB on the wire, over the 256 KiB cap,
  // but only about 238 KB if the LF of each CRLF went uncounted.
  const over = await startCrlfEventServer(34_000);
  try {
    const started = Date.now();
    const reply = await callMcp(request(false), shaper({ type: "http", url: over.url }), ctx());
    assert.ok(over.wireBytes() > 256 * 1024, `the event is ${over.wireBytes()} bytes on the wire`);
    assert.ok(over.wireBytes() - 34_000 < 256 * 1024, "and under the cap if the LFs were not counted");
    assert.equal(reply.kind, "failed", JSON.stringify(reply).slice(0, 300));
    assert.match((reply as { reason: string }).reason, /larger than 256 KiB/);
    assert.ok(Date.now() - started < 10_000, "failed at once, not at its deadline");
  } finally { await over.close(); }
  // The same shape under the cap is one valid event and an ordinary reply.
  const under = await startCrlfEventServer(20_000);
  try {
    const reply = await callMcp(request(false), shaper({ type: "http", url: under.url }), ctx());
    assert.ok(under.wireBytes() < 256 * 1024);
    assert.deepEqual(data(reply), { guidance: [{ id: "crlf", body: "one event" }] });
  } finally { await under.close(); }
});

/**
 * A bare streamable-HTTP MCP endpoint on loopback: it answers the handshake as JSON and hands each
 * `tools/call` to `onCall`, with the call's zero-based index, to write whatever response the test needs.
 */
async function startRawMcpServer(onCall: (res: import("node:http").ServerResponse, id: number, index: number) => void) {
  let initializes = 0;
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (message.method === "initialize") {
      initializes += 1;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "raw-fixture", version: "1.0.0" } },
      }));
      return;
    }
    onCall(res, message.id, calls++);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    initializes: () => initializes,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

const OK_RESULT = { structuredContent: { guidance: [{ id: "raw", body: "raw reply" }] }, content: [] };

test("a failed response labelled as an event stream is capped as a whole body, as the client reads it", async () => {
  // 40,000 events of 10 bytes each: every event is tiny, the body is about 400 KB.
  const raw = await startRawMcpServer((res) => res.writeHead(500, { "content-type": "text/event-stream" }).end("data: x\n\n".repeat(40_000)));
  try {
    const started = Date.now();
    const reply = await callMcp(request(false), shaper({ type: "http", url: raw.url }), ctx());
    assert.equal(reply.kind, "failed", JSON.stringify(reply).slice(0, 300));
    assert.match((reply as { reason: string }).reason, /larger than 256 KiB/);
    assert.ok(Date.now() - started < 10_000);
  } finally { await raw.close(); }
});

test("a response stream that ends before its reply fails that call at once, and the next call uses the same connection", async () => {
  const raw = await startRawMcpServer((res, id, index) => {
    if (index === 0) {
      // An event, then the end of the stream, and never the reply.
      res.writeHead(200, { "content-type": "text/event-stream" })
        .end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: OK_RESULT }));
  });
  try {
    const run = ctx();
    const started = Date.now();
    const first = await callMcp(request(false), shaper({ type: "http", url: raw.url }), run);
    assert.deepEqual(first, { kind: "failed", reason: "The MCP server's response stream ended before the reply arrived." });
    assert.ok(Date.now() - started < 5_000, "at once, not at the call's 30 s budget");
    const second = await callMcp(request(false), shaper({ type: "http", url: raw.url }), run);
    assert.deepEqual(data(second), { guidance: [{ id: "raw", body: "raw reply" }] });
    assert.equal(raw.initializes(), 1, "one stream ending early does not break the shared session");
  } finally { await raw.close(); }
});

test("a resumable response stream that closes before its reply is resumed, not failed", async () => {
  // The server primes the stream with an event id, closes it, and answers when it is resumed.
  let resumedFrom: string | undefined;
  let pendingId: number | undefined;
  let initializes = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      const last = req.headers["last-event-id"];
      if (!last || pendingId === undefined) { res.writeHead(405).end(); return; }
      resumedFrom = String(last);
      res.writeHead(200, { "content-type": "text/event-stream" })
        .end(`id: e2\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: pendingId, result: OK_RESULT })}\n\n`);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (message.method === "initialize") {
      initializes += 1;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "resumable", version: "1.0.0" } },
      }));
      return;
    }
    pendingId = message.id;
    res.writeHead(200, { "content-type": "text/event-stream" }).end("id: e1\ndata: \n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const reply = await callMcp(request(false), shaper({ type: "http", url }), ctx({}, 10_000));
    assert.deepEqual(data(reply), { guidance: [{ id: "raw", body: "raw reply" }] });
    assert.equal(resumedFrom, "e1", "resumed from the priming event's id");
    assert.equal(initializes, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("a stdio server that exits during the handshake after echoing a passed value is scrubbed and marked", async () => {
  const value = "exit-secret-a41b";
  const reply = await withEnv({ [KEY_ENV]: value }, () => callMcp(request(), shaper({ type: "stdio", mode: "stderr-exit" }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "stderr-exit", KEY_ENV, "1"], env: [KEY_ENV] } },
  }), ctx()));
  assert.equal(reply.kind, "failed", JSON.stringify(reply));
  assert.equal(reply.redacted, true, JSON.stringify(reply));
  assert.equal((reply as { reason: string }).reason.includes(value), false);
  assert.match((reply as { reason: string }).reason, /\[redacted\]/);
});

test("one call's interrupted response stream fails only that call, never another call on the same connection", async () => {
  const raw = await startRawMcpServer((res, id, index) => {
    if (index === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" })
        .end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`);
      return;
    }
    // The healthy call answers on its own stream a little later, after the other stream ended.
    res.writeHead(200, { "content-type": "text/event-stream" });
    setTimeout(() => res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: OK_RESULT })}\n\n`), 400);
  });
  try {
    const run = ctx();
    const [first, second] = await Promise.all([
      callMcp(request(false), shaper({ type: "http", url: raw.url }), run),
      new Promise((done) => setTimeout(done, 50)).then(() => callMcp(request(false), shaper({ type: "http", url: raw.url }), run)),
    ]);
    assert.deepEqual(first, { kind: "failed", reason: "The MCP server's response stream ended before the reply arrived." });
    assert.deepEqual(data(second), { guidance: [{ id: "raw", body: "raw reply" }] });
    assert.equal(raw.initializes(), 1, "both calls shared one connection");
  } finally { await raw.close(); }
});

test("a run that ended while a stdio command was being resolved starts no server", async () => {
  const pidFile = join(home, `raw-stdio-closed-${Date.now()}.pid`);
  const run = ctx();
  (run.scope as ReturnType<typeof runScope>).close();
  const reply = await callMcp(request(), shaper({ type: "stdio", mode: "overflow-init" }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "overflow-init", "10", pidFile] } },
  }), run);
  assert.deepEqual(reply, { kind: "unavailable", reason: "The shaping run ended before the MCP server could start." });
  await new Promise((done) => setTimeout(done, 500));
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(pidFile), false, "no server process was started");
});

test("a stdio server receives exactly the filtered environment, never an SDK default that was filtered out", async () => {
  const { tokenPath } = await import("../src/shared/harness-runtime.mjs");
  const { mkdirSync, writeFileSync, rmSync: removeFile } = await import("node:fs");
  const { dirname } = await import("node:path");
  const token = "daemon-token-3f9e2a";
  mkdirSync(dirname(tokenPath()), { recursive: true });
  writeFileSync(tokenPath(), token);
  try {
    // LOGNAME carries the daemon's token, so the filtered environment drops it; the SDK would
    // have put it back from the daemon's own environment.
    const seen = await withEnv({ LOGNAME: `user-${token}` }, async () => echoed(await callMcp(request(), shaper({ type: "stdio", mode: "echo" }), ctx())));
    assert.equal(seen.envKeys.includes("LOGNAME"), false, seen.envKeys.join(","));
    assert.ok(seen.envKeys.includes("PATH"), "the rest of the environment still arrives");
  } finally { removeFile(tokenPath(), { force: true }); }
});

test("a value cut at the front of the retained stderr leaves no fragment in the reason", async () => {
  // The value is the longest the server receives, so the transport keeps 4,000 characters plus a
  // margin of six times its length, 40,000 in all. 37,000 newlines after it put the cut 3,000
  // characters into it: the retained text
  // starts with the value's last 3,000 characters, which no search for the whole value finds.
  // Collapsed, those newlines would bring that surviving end into the recorded tail.
  const { randomBytes } = await import("node:crypto");
  const value = randomBytes(3_000).toString("hex");
  const reply = await withEnv({ [KEY_ENV]: value }, () => callMcp(request(), shaper({ type: "stdio", mode: "stderr-exit" }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "stderr-exit", KEY_ENV, "37000"], env: [KEY_ENV] } },
  }), ctx()));
  assert.equal(reply.kind, "failed", JSON.stringify(reply).slice(0, 300));
  const reason = (reply as { reason: string }).reason;
  assert.equal(reason.includes(value.slice(-24)), false, "the value's surviving end is not in the reason");
  assert.equal(reason.includes(value.slice(-6)), false);
});

test("the handshake budget reads no wall clock: a deadline in the past does not cut it short", async () => {
  // A deadline already in the past, as a wall-clock jump during the run would leave it.
  const reply = await callMcp(request(), shaper({ type: "stdio", mode: "ok" }), ctx({ deadline: Date.now() - 60_000 }));
  assert.equal(reply.kind, "data", JSON.stringify(reply));
});

test("a call that joins a slow shared handshake is bounded by its own budget, not the opener's", async () => {
  let initializes = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (message.method === "initialize") {
      initializes += 1;
      // Slower than the opening call's budget, well within the joining call's.
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1.0.0" } },
      })), 800);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: OK_RESULT }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const run = ctx();
    const short = { ...run, timeoutMs: 300 };
    const long = { ...run, timeoutMs: 10_000 };
    const [opener, joiner] = await Promise.all([
      callMcp(request(false), shaper({ type: "http", url }), short),
      new Promise((done) => setTimeout(done, 50)).then(() => callMcp(request(false), shaper({ type: "http", url }), long)),
    ]);
    assert.equal(opener.kind, "timed_out", JSON.stringify(opener));
    assert.deepEqual(data(joiner), { guidance: [{ id: "raw", body: "raw reply" }] });
    assert.equal(initializes, 1, "one shared handshake served both");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("a handshake error that echoes a header value in JSON escapes is scrubbed and marked", async () => {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    for await (const _chunk of req) { /* drained */ }
    const echoed = [...String(req.headers["x-api-key"] ?? "")].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    res.writeHead(500, { "content-type": "application/json" }).end(`{"error":"no session for ${echoed}"}`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const reply = await withEnv({ [KEY_ENV]: KEY }, () => callMcp(request(false), shaper({ type: "http", url, headers: { "x-api-key": `{env:${KEY_ENV}}` } }), ctx()));
    assert.equal(reply.kind, "failed");
    assert.equal(reply.redacted, true, JSON.stringify(reply));
    const reason = (reply as { reason: string }).reason;
    assert.match(reason, /^The MCP server did not complete its handshake: /);
    assert.ok(reason.includes(`[${KEY_ENV} redacted]`), reason);
    assert.equal(reason.includes("\\u0066"), false, "no escaped spelling of the value is left");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("an id on an event the stream never finished is not resumable, so its early end fails the call at once", async () => {
  // The id and data lines arrive, the blank line that would end the event never does.
  const raw = await startRawMcpServer((res) => res.writeHead(200, { "content-type": "text/event-stream" }).end("id: e1\ndata: partial"));
  try {
    const started = Date.now();
    const reply = await callMcp(request(false), shaper({ type: "http", url: raw.url }), ctx());
    assert.deepEqual(reply, { kind: "failed", reason: "The MCP server's response stream ended before the reply arrived." });
    assert.ok(Date.now() - started < 5_000, "at once, not at the call's 30 s budget");
  } finally { await raw.close(); }
});

test("a stdio diagnostic that spells a passed value in JSON escapes is scrubbed and marked", async () => {
  const value = "json-stderr-secret-29fd";
  const reply = await withEnv({ [KEY_ENV]: value }, () => callMcp(request(), shaper({ type: "stdio", mode: "json-stderr-exit" }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "json-stderr-exit", KEY_ENV], env: [KEY_ENV] } },
  }), ctx()));
  assert.equal(reply.kind, "failed", JSON.stringify(reply));
  assert.equal(reply.redacted, true, JSON.stringify(reply));
  const reason = (reply as { reason: string }).reason;
  assert.ok(reason.includes(`auth failed for [${KEY_ENV} redacted]`), reason);
  assert.equal(reason.includes("\\u006a"), false, "no escaped spelling is left");
});

test("a named __proto__ variable reaches a stdio MCP server's process", async () => {
  const saved = Object.getOwnPropertyDescriptor(process.env, "__proto__")?.value as string | undefined;
  process.env["__proto__"] = "proto-value-91be";
  try {
    const seen = echoed(await callMcp(request(), shaper({ type: "stdio", mode: "echo", args: ["env=__proto__"], env: ["__proto__"] }), ctx()));
    // The echoed value is the passed variable, which the reply scrub removes under its name.
    assert.equal(seen.env["__proto__"], "[__proto__ redacted]");
    assert.ok(seen.envKeys.includes("__proto__"), "the server's environment holds it");
  } finally {
    if (saved === undefined) delete process.env["__proto__"];
    else process.env["__proto__"] = saved;
  }
});

test("an unset pass-through variable named after an inherited property cannot break reply scrubbing", async () => {
  const reply = await callMcp(request(), shaper({ type: "stdio", mode: "ok", env: ["constructor", "toString"] }), ctx());
  assert.deepEqual(data(reply), { version: "v1.4.0", guidance: [{ id: "guide/billing-api", title: "Guide", body: "guidance for billing-api" }] });
});

test("a resumable stream whose priming event's CRLF is split across chunks is still resumed", async () => {
  let resumedFrom: string | undefined;
  let pendingId: number | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      const last = req.headers["last-event-id"];
      if (!last || pendingId === undefined) { res.writeHead(405).end(); return; }
      resumedFrom = String(last);
      res.writeHead(200, { "content-type": "text/event-stream" })
        .end(`id: e2\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: pendingId, result: OK_RESULT })}\r\n\r\n`);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { protocolVersion?: string } };
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    if (message.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "split", version: "1.0.0" } },
      }));
      return;
    }
    pendingId = message.id;
    // The priming event's id line ends with a CR in one chunk and its LF opens the next.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("id: e1\r");
    setTimeout(() => res.end("\ndata: \r\n\r\n"), 100);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const reply = await callMcp(request(false), shaper({ type: "http", url }), ctx({}, 10_000));
    assert.deepEqual(data(reply), { guidance: [{ id: "raw", body: "raw reply" }] });
    assert.equal(resumedFrom, "e1");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("a passed value whose multibyte character stderr splits across chunks is still redacted", async () => {
  const value = "sécret-ünïcode-4f2a";
  const reply = await withEnv({ [KEY_ENV]: value }, () => callMcp(request(), shaper({ type: "stdio", mode: "split-utf8-exit" }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "split-utf8-exit", KEY_ENV], env: [KEY_ENV] } },
  }), ctx()));
  assert.equal(reply.kind, "failed", JSON.stringify(reply));
  const reason = (reply as { reason: string }).reason;
  for (const piece of ["cret-", "nïcode", "4f2a", "\ufffd"]) assert.equal(reason.includes(piece), false, reason);
  assert.equal(reply.redacted, true);
});

test("a run that ended while the MCP client was loading sends no handshake", async () => {
  const http = await startGuidanceHttp({ mode: "ok" });
  try {
    const run = ctx();
    (run.scope as ReturnType<typeof runScope>).close();
    const reply = await callMcp(request(false), shaper({ type: "http", url: http.url }), run);
    assert.deepEqual(reply, { kind: "unavailable", reason: "The shaping run ended before the MCP server could be reached." });
    assert.equal(http.requests.length, 0, "no request reached the server");
  } finally { await http.close(); }
});

test("a stdio server that writes a line that is not an MCP message fails the call at once", async () => {
  const started = Date.now();
  const reply = await callMcp(request(), shaper({ type: "stdio", mode: "garbage-reply" }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "garbage-reply"] } },
  }), ctx());
  assert.deepEqual(reply, { kind: "failed", reason: "The MCP server wrote a line on stdout that is not JSON, so it is not an MCP message." });
  assert.ok(Date.now() - started < 10_000, "at once, not at the call's 30 s budget");
});

test("a malformed stdout line that holds a passed value never quotes any piece of it", async () => {
  // Nothing a fixed reason could spell: every six-character piece of it is checked below.
  const value = "zq7k9x2vv41mp8rq";
  const reply = await withEnv({ [KEY_ENV]: value }, () => callMcp(request(), shaper({ type: "stdio", mode: "garbage-reply" }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "garbage-reply", KEY_ENV], env: [KEY_ENV] } },
  }), ctx()));
  assert.equal(reply.kind, "failed");
  const reason = (reply as { reason: string }).reason;
  for (let at = 0; at + 6 <= value.length; at++) assert.equal(reason.includes(value.slice(at, at + 6)), false, reason);
});

test("a reply for a request not yet in flight cannot mark that request answered when it is sent", async () => {
  // The first call's stream carries, ahead of its own reply, a stray reply for the next request
  // id. The second call's stream then ends with no reply: it must fail at once, not wait out its
  // budget as though the stray reply had answered it.
  const raw = await startRawMcpServer((res, id, index) => {
    if (index === 0) {
      res.writeHead(200, { "content-type": "text/event-stream" })
        .end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: id + 1, result: OK_RESULT })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: OK_RESULT })}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" }).end(": no reply\n\n");
  });
  try {
    const run = ctx();
    assert.deepEqual(data(await callMcp(request(false), shaper({ type: "http", url: raw.url }), run)), { guidance: [{ id: "raw", body: "raw reply" }] });
    const started = Date.now();
    const second = await callMcp(request(false), shaper({ type: "http", url: raw.url }), run);
    assert.deepEqual(second, { kind: "failed", reason: "The MCP server's response stream ended before the reply arrived." });
    assert.ok(Date.now() - started < 5_000, "at once, not at the call's 30 s budget");
  } finally { await raw.close(); }
});

test("a stream whose only event id is empty is not resumable, so its early end fails the call at once", async () => {
  const raw = await startRawMcpServer((res) => res.writeHead(200, { "content-type": "text/event-stream" }).end("id:\ndata: \n\n"));
  try {
    const started = Date.now();
    const reply = await callMcp(request(false), shaper({ type: "http", url: raw.url }), ctx());
    assert.deepEqual(reply, { kind: "failed", reason: "The MCP server's response stream ended before the reply arrived." });
    assert.ok(Date.now() - started < 5_000, "at once, not at the call's 30 s budget");
  } finally { await raw.close(); }
});


test("a stdio server that overflows during the handshake fails at once and is stopped", async () => {
  const pidFile = join(home, `raw-stdio-${Date.now()}.pid`);
  const started = Date.now();
  const reply = await callMcp(request(), shaper({ type: "stdio", mode: "overflow-init", args: [String(300 * 1024), pidFile] }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "overflow-init", String(300 * 1024), pidFile] } },
  }), ctx());
  assert.equal(reply.kind, "failed", JSON.stringify(reply));
  assert.match((reply as { reason: string }).reason, /larger than 256 KiB/);
  // The fixture ignores SIGTERM, so waiting for the client's own close would take over four seconds.
  assert.ok(Date.now() - started < 3_000, `answered in ${Date.now() - started} ms, not after the close escalated`);
  const { readFileSync } = await import("node:fs");
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; alive() && waited < 15_000; waited += 200) await new Promise((done) => setTimeout(done, 200));
  assert.equal(alive(), false, "the server was stopped without waiting for the run to end");
});

test("a stdio handshake error that repeats a passed-through value is scrubbed and marked", async () => {
  const reply = await withEnv({ [KEY_ENV]: KEY }, () => callMcp(request(), shaper({ type: "stdio", mode: "error-init" }, "folded", {
    transport: { type: "mcp", tool: "get_guidance", server: { type: "stdio", command: process.execPath, args: [RAW_STDIO, "error-init", KEY_ENV], env: [KEY_ENV] } },
  }), ctx()));
  assert.equal(reply.kind, "failed");
  assert.equal(reply.redacted, true);
  const reason = (reply as { reason: string }).reason;
  assert.equal(reason.includes(KEY), false, reason);
  assert.match(reason, /^The MCP server did not complete its handshake: .*denied for \[redacted\]/);
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

test("an MCP server header named twice in different letter case is refused before connecting", async () => {
  const http = await startGuidanceHttp({ mode: "ok" });
  try {
    const headers = { "X-Api-Key": `{env:${KEY_ENV}}`, "x-api-key": "{env:SHAPING_MCP_OTHER_KEY}" };
    const reply = await withEnv({ [KEY_ENV]: KEY, SHAPING_MCP_OTHER_KEY: "other" }, () => callMcp(request(false), shaper({ type: "http", url: http.url, headers }), ctx()));
    assert.equal(reply.kind, "unavailable");
    assert.match((reply as { reason: string }).reason, /configures the header "X-Api-Key" twice, also as "x-api-key"/);
    assert.equal(http.requests.length, 0, "no connection was opened");
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

test("a tool error that echoes a value with runs of whitespace is scrubbed before it is flattened", async () => {
  const error = await startGuidanceHttp({ mode: "error-header", args: ["x-api-key"] });
  try {
    const spaced = "alpha  secret\tvalue";
    const reply = await withEnv({ [KEY_ENV]: spaced }, () =>
      callMcp(request(false), shaper({ type: "http", url: error.url, headers: { "x-api-key": `{env:${KEY_ENV}}` } }), ctx()));
    assert.deepEqual(reply, { kind: "failed", reason: `The tool returned an error: denied for [${KEY_ENV} redacted]`, redacted: true });
  } finally { await error.close(); }
});

test("a configured Content-Type or Accept, in any case, does not break a streamable-HTTP call", async () => {
  const http = await startGuidanceHttp({ mode: "echo" });
  try {
    const headers = { "Content-Type": "text/plain", ACCEPT: "text/html", "x-tenant": "kept" };
    const seen = echoed(await callMcp(request(false), shaper({ type: "http", url: http.url, headers }), ctx()));
    assert.equal(seen.headers?.["x-tenant"], "kept");
    for (const { method, headers: sent } of http.requests.filter(({ method }) => method === "POST")) {
      assert.equal(sent["content-type"], "application/json", `${method} keeps the client's body type`);
      assert.match(String(sent.accept), /application\/json/);
    }
  } finally { await http.close(); }
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
