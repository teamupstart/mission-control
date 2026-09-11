// A malformed bridge must cost the integration, never the Pi session or its TUI.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { McpClient } from "../src/pi/mcp-client.ts";
import { adaptTool } from "../src/pi/tool-adapter.ts";
import { hookBody, PI_EVENTS, statusBody } from "../src/pi/event-map.ts";
import { piHooks } from "../src/server/harness/pi/hooks.ts";
import { HookIngestSchema, StatusLineIngestSchema } from "../src/shared/protocol.ts";
import { THINKING_LEVELS } from "../src/shared/types.ts";
import extension from "../src/pi/extension.ts";
import type { PiContext, PiEvent, PiTool } from "../src/pi/api.ts";

const root = mkdtempSync(join(tmpdir(), "pi-extension-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
function stub(code: string): string {
  const file = join(root, `${seq++}.mjs`); writeFileSync(file, code); return file;
}
const tool = { name: "request_input", description: "Ask the operator", inputSchema: { type: "object", additionalProperties: false, properties: { question: { type: "string" } }, required: ["question"] } };
const server = stub(`
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (!m.id) return;
 if (m.method === 'tools/call' && m.params.arguments?.wait) return;
 const result = m.method === 'initialize' ? {} : m.method === 'tools/list' ? {tools:[${JSON.stringify(tool)}]} : {content:[{type:'text',text:JSON.stringify(m.params.arguments)}],isError:m.params.arguments?.fail};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);

test("stdio handshake discovers raw schemas and calls, including errors and cancellation", async () => {
  const client = new McpClient(server);
  try {
    const tools = await client.tools(); assert.deepEqual(tools, [tool]);
    const adapted = adaptTool(tools[0]!, () => client);
    assert.equal(adapted.parameters, tools[0]!.inputSchema);
    assert.equal(adapted.description, tool.description);
    assert.match(adapted.promptSnippet, /request_input/);
    assert.deepEqual((await adapted.execute("id", { question: "ready?" })).content, [{ type: "text", text: '{"question":"ready?"}' }]);
    await assert.rejects(adapted.execute("id", { fail: true }), /fail/);
    const abort = new AbortController();
    const waiting = adapted.execute("id", { wait: true }, abort.signal);
    abort.abort(); await assert.rejects(waiting, /cancelled/);
    assert.equal((await adapted.execute("id", {})).content.length, 1, "cancellation does not kill later calls");
    const pending = adapted.execute("id", { wait: true });
    client.close(); await assert.rejects(pending, /closed/);
  } finally { client.close(); }
});

function pagedServer(pages: number): { file: string; cursors: () => unknown[] } {
  const record = join(root, `pages-${seq++}.jsonl`);
  const file = stub(`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let page = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (!m.id) return;
  let result = {};
  if (m.method === 'tools/list') {
    appendFileSync(${JSON.stringify(record)}, JSON.stringify(m.params.cursor ?? null) + '\\n');
    const expected = page === 0 ? undefined : 'page-' + (page + 1);
    if (m.params.cursor !== expected) {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'wrong cursor'}})+'\\n');
      return;
    }
    page++;
    result = { tools: [{...${JSON.stringify(tool)}, name:'tool-' + page}],
      ...(page < ${pages} ? { nextCursor:'page-' + (page + 1) } : {}) };
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  return { file, cursors: () => readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}

for (const pages of [2, 20]) test(`tool discovery follows nextCursor through ${pages} pages`, async () => {
  const fixture = pagedServer(pages);
  const client = new McpClient(fixture.file);
  try {
    const found = await client.tools();
    assert.deepEqual(found, Array.from({ length: pages }, (_, i) => ({ ...tool, name: `tool-${i + 1}` })));
    assert.deepEqual(fixture.cursors(), Array.from({ length: pages }, (_, i) => i === 0 ? null : `page-${i + 1}`));
  } finally { client.close(); }
});

test("tool discovery rejects a continuation after page 20 and closes the connection", async () => {
  const fixture = pagedServer(21);
  const client = new McpClient(fixture.file);
  try {
    await assert.rejects(client.tools(), /tool list exceeded 20 pages/);
    assert.deepEqual(fixture.cursors(), Array.from({ length: 20 }, (_, i) => i === 0 ? null : `page-${i + 1}`));
    await assert.rejects(client.call("tool-1", {}), /connection is closed/);
  } finally { client.close(); }
});

for (const [name, code] of [
  ["unanswered initialize", "setInterval(() => {}, 1000)"],
  ["unterminated flood", "process.stdout.write('x'.repeat(5000)); setInterval(() => {},1000)"],
  ["oversized complete frame", "process.stdout.write('x'.repeat(5000)+'\\n'); setInterval(() => {},1000)"],
  ["malformed frame", "process.stdout.write('not json\\n'); setInterval(() => {},1000)"],
] as const) test(name, async () => {
  const client = new McpClient(stub(code), { maxFrame: 1024, killGrace: 20 });
  await assert.rejects(client.tools(150), /closed/); client.close();
});

const ctx: PiContext = {
  cwd: "/repo", sessionManager: { getSessionId: () => "pi-id", getSessionFile: () => "/tmp/pi-id.jsonl" },
  model: { id: "probe", name: "Probe" }, thinkingLevel: "high",
  getContextUsage: () => ({ tokens: 250, contextWindow: 1000, percent: 25 }),
};
test("Pi preserves exact submitted prompts while normalizing display prompts", () => {
  for (const prompt of ["  hello\n", "\n\t ", "", undefined]) {
    const event = { event: "UserPromptSubmit" as const, prompt, sessionId: "pi-id", ts: Date.now() };
    assert.equal(piHooks.submittedPromptText(event), prompt ?? null);
    assert.equal(piHooks.promptText(event), prompt?.trim() || null);
    assert.equal(piHooks.submittedPromptText({ ...event, event: "Stop" }), null);
  }
});
test("Pi fixture imports filesystem paths containing URL delimiters", () => {
  const file = join(root, "session #?.mjs");
  writeFileSync(file, 'export function runExtensionSession() { console.log("fixture loaded"); process.exit(0); }');
  const result = spawnSync(process.execPath, ["e2e/fixtures/fake-pi.mjs", "--mission-extension-test"], {
    env: { ...process.env, MC_E2E_PI_SESSION_FIXTURE: file }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "fixture loaded");
});
test("every lifecycle event maps to a valid ingest and settled alone completes work", () => {
  for (const [type, mapped] of Object.entries(PI_EVENTS)) {
    const body = hookBody({ type, source: "interactive", text: "hello", toolName: "bash", kind: "select", title: "Pick one" }, ctx)!;
    assert.equal(HookIngestSchema.safeParse(body).success, true);
    assert.equal(body.event, mapped); assert.equal(body.agent, "pi");
    assert.equal(body.sessionId, "pi-id"); assert.equal(body.transcriptPath, "/tmp/pi-id.jsonl");
    assert.equal(piHooks.workCycleSignal(body) === "turn_completed", type === "agent_settled");
    const states: Record<string, string> = { SessionStart: "idle", Stop: "idle", SessionEnd: "exited", PermissionRequest: "awaiting_input" };
    assert.equal(piHooks.toState(body).state, states[mapped] ?? "working");
  }
  assert.equal(hookBody({ type: "agent_end" }, ctx), null);
  assert.equal(hookBody({ type: "input", source: "extension" }, ctx), null);
  const input = hookBody({ type: "input", source: "rpc", text: " hello " }, ctx)!;
  assert.equal(piHooks.promptText(input), "hello");
  assert.equal(piHooks.workCycleSignal(input), "work_started");
});
test("PR output is attributed without leaking the bash command", () => {
  const body = hookBody({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "Creating pull request...\nhttps://github.com/acme/repo/pull/42\n" }] } }, ctx, "gh pr create --body secret")!;
  assert.equal(body.prCreated, true);
  assert.deepEqual(body.prUrls, ["https://github.com/acme/repo/pull/42"]);
  assert.ok(!JSON.stringify(body).includes("secret"));
});
test("statusline reports the event's live selection and native effort without inventing a picker level", () => {
  const status = statusBody({ type: "model_select", model: { id: "new" }, level: "minimal" }, ctx);
  assert.equal(StatusLineIngestSchema.safeParse(status).success, true);
  assert.equal(status.model?.id, "new"); assert.equal(status.nativeEffort, "minimal"); assert.equal(status.effort, undefined);
  assert.equal(status.contextWindow?.usedPercentage, 25);
  assert.equal(statusBody({ type: "thinking_level_select", level: "off" }, ctx).thinkingEnabled, false);
});
test("statusline and ingest share the effort vocabulary and classify native levels exclusively", () => {
  for (const level of THINKING_LEVELS) {
    const status = statusBody({ type: "thinking_level_select", level }, ctx);
    assert.equal(status.effort, level);
    assert.equal(status.nativeEffort, undefined);
    assert.equal(StatusLineIngestSchema.safeParse(status).success, true);
  }
  for (const level of ["off", "minimal", "future-native-level"]) {
    const status = statusBody({ type: "thinking_level_select", level }, ctx);
    assert.equal(status.effort, undefined);
    assert.equal(status.nativeEffort, level);
    assert.equal(StatusLineIngestSchema.safeParse(status).success, true);
    assert.equal(StatusLineIngestSchema.safeParse({ ...status, effort: level }).success, false);
  }
  const unset = statusBody({ type: "turn_end" }, { ...ctx, thinkingLevel: undefined });
  assert.equal(unset.effort, undefined);
  assert.equal(unset.nativeEffort, undefined);
  assert.equal(unset.thinkingEnabled, undefined);
});
test("factory owns no child and shutdown is safe before startup", async () => {
  const handlers = new Map<string, (event: PiEvent, ctx: PiContext) => Promise<unknown>>();
  const tools: PiTool[] = [];
  extension({ on: (name, handler) => { handlers.set(name, handler); }, registerTool: (tool) => tools.push(tool) });
  assert.equal(tools.length, 0);
  assert.ok(!handlers.has("agent_end"));
  // An invalid context must not escape any subscribed handler, even during shutdown.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("isolated daemon-down fixture"); };
  try {
    for (const [type, handler] of handlers) await assert.doesNotReject(handler({ type }, {} as PiContext));
  } finally { globalThis.fetch = originalFetch; }
});

test("coordinator refreshes identity and credentials, delivers instructions once and keeps daemon failures quiet", async () => {
  const handlers = new Map<string, (event: PiEvent, ctx: PiContext) => Promise<unknown>>();
  const tools: PiTool[] = [];
  const originalFetch = globalThis.fetch;
  const priorServer = process.env.MISSION_MCP_SERVER;
  const priorToken = process.env.MISSION_API_TOKEN;
  process.env.MISSION_MCP_SERVER = server;
  process.env.MISSION_API_TOKEN = "first-test-token";
  const posts: { path: string; token: string; body: unknown }[] = [];
  let down = false;
  globalThis.fetch = async (input, init) => {
    if (down) throw new Error("daemon is down");
    const path = new URL(String(input)).pathname;
    posts.push({ path, token: new Headers(init?.headers).get("x-harness-token") ?? "", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/instructions/resolved") return new Response(JSON.stringify({ text: "Operator rules" }));
    if (path === "/hooks/UserPromptSubmit") return new Response(JSON.stringify({ decision: "block", reason: "closed session" }));
    return new Response(null, { status: 204 });
  };
  extension({ on: (name, fn) => { handlers.set(name, fn); }, registerTool: (tool) => tools.push(tool) });
  const emit = async (event: PiEvent, context = { ...ctx, cwd: root }) => handlers.get(event.type)!(event, context);
  try {
    await emit({ type: "session_start" });
    assert.equal(tools.length, 1);
    process.env.MISSION_API_TOKEN = "rotated-test-token";
    await emit({ type: "thinking_level_select", level: "low" });
    assert.equal(posts.at(-1)?.token, "rotated-test-token");
    const statusTimes = posts.filter((post) => post.path === "/statusline")
      .map((post) => (post.body as { ts: number }).ts);
    assert.ok(statusTimes.every((ts, index) => index === 0 || ts > statusTimes[index - 1]!));
    const appended = await emit({ type: "before_agent_start", systemPrompt: "Pi prompt", systemPromptOptions: {} });
    assert.deepEqual(appended, { systemPrompt: "Pi prompt\n\nOperator rules" });
    assert.equal(await emit({ type: "before_agent_start", systemPromptOptions: { appendSystemPrompt: "already delivered" } }), undefined);
    assert.deepEqual(await emit({ type: "input", source: "interactive", text: "new work" }), { action: "handled" });
    const before = posts.length;
    await emit({ type: "input", source: "extension", text: "automation" });
    assert.equal(posts.length, before);
    await emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "bash-1", args: { command: "gh pr create --body secret" } });
    await emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "bash-1", result: { content: [{ type: "text", text: "https://github.com/acme/repo/pull/3" }] } });
    assert.equal((posts.findLast((post) => post.path === "/hooks/PostToolUse")?.body as { prCreated: boolean } | undefined)?.prCreated, true);
    assert.ok(!JSON.stringify(posts).includes("secret"));
    await emit({ type: "session_start" }, { ...ctx, cwd: root, sessionManager: { ...ctx.sessionManager, getSessionId: () => "new-session" } });
    assert.equal(tools.length, 1, "a session switch reuses the registered adapter");
    down = true;
    await assert.doesNotReject(emit({ type: "agent_settled" }));
    await emit({ type: "session_shutdown" });
    await assert.rejects(tools.at(-1)!.execute("id", {}), /unavailable/);
    await emit({ type: "session_shutdown" });
  } finally {
    await emit({ type: "session_shutdown" });
    globalThis.fetch = originalFetch;
    if (priorServer === undefined) delete process.env.MISSION_MCP_SERVER; else process.env.MISSION_MCP_SERVER = priorServer;
    if (priorToken === undefined) delete process.env.MISSION_API_TOKEN; else process.env.MISSION_API_TOKEN = priorToken;
  }
});

test("tool registrations survive session switches and refresh only changed or new definitions", async () => {
  const catalog = join(root, `catalog-${seq++}.json`);
  writeFileSync(catalog, JSON.stringify([tool]));
  const identityServer = stub(`
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (!m.id) return;
  if (m.method === 'tools/call' && m.params.arguments?.wait) return;
  const result = m.method === 'initialize' ? {} : m.method === 'tools/list'
    ? {tools:JSON.parse(readFileSync(${JSON.stringify(catalog)}, 'utf8'))}
    : {content:[{type:'text',text:JSON.stringify({sessionId:process.env.MISSION_AGENT_SESSION_ID,pid:process.pid})}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  const handlers = new Map<string, (event: PiEvent, ctx: PiContext) => Promise<unknown>>();
  const registrations: PiTool[] = [];
  const originalFetch = globalThis.fetch;
  const priorServer = process.env.MISSION_MCP_SERVER;
  process.env.MISSION_MCP_SERVER = identityServer;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  extension({ on: (name, handler) => { handlers.set(name, handler); }, registerTool: (definition) => registrations.push(definition) });
  const start = (sessionId: string) => handlers.get("session_start")!({ type: "session_start" }, {
    ...ctx, cwd: root, sessionManager: { ...ctx.sessionManager, getSessionId: () => sessionId },
  });
  const identity = async (adapter: PiTool) => JSON.parse((await adapter.execute("id", {})).content[0]!.text);
  try {
    await start("first");
    assert.equal(registrations.length, 1);
    const original = registrations[0]!;
    let previous = await identity(original);
    assert.equal(previous.sessionId, "first");
    for (const sessionId of ["second", "third", "third"]) {
      const pending = assert.rejects(original.execute("pending", { wait: true }), /closed/);
      await start(sessionId);
      await pending;
      assert.equal(registrations.length, 1, "unchanged definitions register only once per extension");
      const current = await identity(original);
      assert.equal(current.sessionId, sessionId, "the retained adapter uses the current session identity");
      assert.notEqual(current.pid, previous.pid, "the session owns a replacement MCP child");
      previous = current;
    }
    const updated = { ...tool, description: "Updated operator question", inputSchema: { type: "object", properties: { prompt: { type: "string" } } } };
    writeFileSync(catalog, JSON.stringify([updated, { ...tool, name: "new_tool" }]));
    await start("updated");
    assert.deepEqual(registrations.map((registered) => registered.name), ["request_input", "request_input", "new_tool"]);
    assert.equal(registrations[1]!.description, updated.description);
    assert.deepEqual(registrations[1]!.parameters, updated.inputSchema);
    await start("unchanged-after-update");
    assert.equal(registrations.length, 3, "updated definitions are also registered idempotently");
    for (const adapter of registrations) assert.equal((await identity(adapter)).sessionId, "unchanged-after-update");
  } finally {
    await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
    globalThis.fetch = originalFetch;
    if (priorServer === undefined) delete process.env.MISSION_MCP_SERVER; else process.env.MISSION_MCP_SERVER = priorServer;
  }
});
