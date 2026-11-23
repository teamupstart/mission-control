import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkTask } from "./helpers/session-fixture.ts";

// A session holding Control other sessions completes another session through the real
// `control_session` MCP tool: stdio MCP child -> authenticated HTTP with the caller's signed
// session credential -> delegated route -> the dashboard's task completion and Kill routes ->
// the real TaskManager. Only the agent driver is a stub, and it records the stop it was asked for.

const home = mkdtempSync(join(tmpdir(), "mission-control-complete-mcp-"));
process.env.MISSION_HOME = home;
// Session credentials live in a directory keyed by the daemon's port, so the in-process daemon
// and the MCP child must agree on one before either resolves it.
const port = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
  });
});
process.env.MISSION_PORT = String(port);
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { maintainScoutSessionCredentials } = await import("../src/server/scouts/session-credentials.ts");
const { sessionScoutCredentialLocator } = await import("../src/server/scouts/submission-auth.ts");
const { SCOUT_SESSION_LOCATOR_ENV } = await import("../src/shared/harness-runtime.mjs");

after(() => rmSync(home, { recursive: true, force: true }));
let serial = 0;

async function fixture(t: TestContext) {
  const registry = new Registry();
  t.after(maintainScoutSessionCredentials(registry));
  const make = (name: string) => registry.registerSdkSession({
    id: `sdk:complete-mcp-${++serial}`, name, agent: "claude", cwd: home, agentSessionId: `native-complete-${serial}`,
  });
  const caller = make("Resident");
  const target = make("Finished work");
  const stops: string[] = [];
  /** Each stop with the target's task status at that instant, so the order is observable. */
  const stopsWithTask: Array<{ id: string; taskStatus: string | null }> = [];
  const sdk = {
    requestStop: (id: string) => {
      stops.push(id);
      const task = registry.listTasks().find((candidate) => candidate.sessionId === id);
      stopsWithTask.push({ id, taskStatus: task?.status ?? null });
      t.diagnostic(`driver: stop requested for ${id}; its task ${task?.id ?? "(none)"} was ${task?.status ?? "absent"} at that moment`);
      return true;
    },
  } as unknown as import("../src/server/sdk/supervisor.ts").SdkSupervisor;
  const clicks = new Set<string>();
  const app = buildApp({
    registry, tasks: new TaskManager(registry), reviews: new ReviewManager(registry), queues: new QueueManager(registry), sdkSessions: sdk,
    authorizeSessionControl: async ({ requestId }) => clicks.delete(requestId),
  });
  const server = serve({ hostname: "127.0.0.1", port, fetch: (req) => app.fetch(req) });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new Client({ name: "complete-mcp", version: "1" });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    env: {
      ...process.env,
      MISSION_HOME: home,
      MISSION_API_TOKEN: ensureToken(),
      MISSION_PORT: String(address.port),
      MISSION_SESSION_ID: caller.id,
      // The MCP child of the controller session reads that session's signed credential.
      [SCOUT_SESSION_LOCATOR_ENV]: sessionScoutCredentialLocator(caller.id),
    } as Record<string, string>,
    stderr: "pipe",
  }));
  /** The operator's desktop click on the controller's Control other sessions menu. */
  const grant = async (enabled: boolean) => {
    const requestId = randomUUID();
    clicks.add(requestId);
    const res = await app.request(`/api/sessions/${encodeURIComponent(caller.id)}/session-control`, {
      method: "PUT", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ enabled, requestId }),
    });
    assert.equal(res.status, 200, await res.text());
    t.diagnostic(`operator: Control other sessions turned ${enabled ? "on" : "off"} for ${caller.id}`);
  };
  /** The target's task as the real TaskManager holds it, for the trace. */
  const taskState = () => {
    const task = registry.listTasks().find((candidate) => candidate.sessionId === target.id);
    return task ? `${task.id} status=${task.status} outcome=${JSON.stringify(task.outcome ?? null)}` : "(none)";
  };
  // A readable trace of each call across the MCP boundary and the state on either side of it,
  // printed with the run so the flow is inspectable without a debugger.
  const control = async (command: Record<string, unknown>) => {
    const args = { sessionId: target.id, command };
    t.diagnostic(`before: target task ${taskState()}; stops so far ${JSON.stringify(stops)}`);
    t.diagnostic(`mcp request: control_session ${JSON.stringify(args)} (caller ${caller.id}, grant ${registry.sessionControlEnabled(caller.id) ? "on" : "off"})`);
    const result = await client.callTool({ name: "control_session", arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>).map((item) => item.text).join("\n");
    t.diagnostic(`mcp response: isError=${Boolean(result.isError)} ${text}`);
    t.diagnostic(`after: target task ${taskState()}; stops so far ${JSON.stringify(stops)}`);
    return { isError: Boolean(result.isError), text };
  };
  return { registry, caller, target, stops, stopsWithTask, grant, control };
}

test("a granted session completes another session through the real control_session tool, as the Complete dialog does", async (t) => {
  const f = await fixture(t);
  const taskId = `complete-mcp-task-${serial}`;
  f.registry.upsertTask(mkTask({ id: taskId, title: "Finished work", sessionId: f.target.id, status: "running", repoRoot: home }));
  await f.grant(true);

  const outcome = await f.control({ action: "complete", outcome: "Fix merged in #42" });
  assert.equal(outcome.isError, false, outcome.text);
  assert.deepEqual(JSON.parse(outcome.text), { ok: true, taskId, taskStatus: "done", session: "closing" });
  const task = f.registry.getTask(taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.outcome, "Fix merged in #42");
  assert.deepEqual(f.stops, [f.target.id]);
  // The stop arrived only after the real TaskManager had recorded the task done.
  assert.deepEqual(f.stopsWithTask, [{ id: f.target.id, taskStatus: "done" }]);
});

test("without Control other sessions the real control_session tool cannot complete another session", async (t) => {
  const f = await fixture(t);
  const taskId = `complete-mcp-ungranted-${serial}`;
  f.registry.upsertTask(mkTask({ id: taskId, sessionId: f.target.id, status: "running", repoRoot: home }));

  const refused = await f.control({ action: "complete", outcome: "done" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Session control is not enabled for this caller/);

  await f.grant(true);
  await f.grant(false);
  const revoked = await f.control({ action: "complete", outcome: "done" });
  assert.equal(revoked.isError, true);
  assert.match(revoked.text, /Session control is not enabled for this caller/);

  assert.equal(f.registry.getTask(taskId)?.status, "running");
  assert.deepEqual(f.stops, []);
});
