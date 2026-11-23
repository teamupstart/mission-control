import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MissionSchedule, SchedulePreviewResult } from "../src/shared/schedules.ts";

const home = mkdtempSync(join(tmpdir(), "mission-mcp-schedules-"));
process.env.MISSION_HOME = home;
const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-schedule-repo-")));
execFileSync("git", ["init", "-q", repo]);
after(() => { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); });
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ScheduleManager } = await import("../src/server/schedules/manager.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { listTasks } = await import("../src/server/db.ts");
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

// Real stdio -> token-authenticated HTTP -> shared validation -> scheduler -> SQLite.
test("MCP recurring missions use the existing durable scheduler", async (t) => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const now = Date.parse("2026-07-23T08:00:00Z");
  const schedules = new ScheduleManager({ tasks, now: () => now, log: () => {}, notifier: {
    upsert: s => registry.upsertSchedule(s), remove: id => registry.removeSchedule(id),
  } });
  const app = buildApp({ registry, tasks, schedules, reviews: {} as ReviewManager, queues: {} as QueueManager });
  let oldDaemon = false;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: req => oldDaemon
    ? new Response("Not Found", { status: 404 }) : app.fetch(req) });
  const client = new Client({ name: "schedule-test", version: "1" });
  t.after(async () => {
    await client.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  });
  await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", fileURLToPath(import.meta.resolve("tsx")), fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    cwd: repo,
    env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.json", import.meta.url)), MISSION_HOME: home, MISSION_API_TOKEN: ensureToken(), MISSION_PORT: String(address.port) } as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  await client.connect(transport).catch(error => { throw new Error(`${String(error)}\n${stderr}`); });
  async function call<T>(name: string, args: Record<string, unknown> = {}, error?: RegExp): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>).map(c => c.text).join("\n");
    assert.equal(Boolean(result.isError), Boolean(error), text);
    if (error) { assert.match(text, error); return undefined as T; }
    return JSON.parse(text) as T;
  }
  const definition = { name: "Daily audit", expression: "0 9 * * *", timezone: "UTC", template: {
    title: "Audit dependencies", intent: "Report dependency issues and verify findings.",
  } };
  const flag = (enabled: boolean) => applyFeatureFlagIntent({ kind: "flag", id: "mcp-schedules", enabled });

  await t.test("tools are discoverable; authentication and the live flag refuse access", async () => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ["create_schedule", "preview_schedule", "list_schedules"]) assert.ok(names.includes(name));
    await call("create_schedule", definition, /mcp-schedules/);
    for (const [path, method] of [["/mcp/schedules", "GET"], ["/mcp/schedules", "POST"], ["/mcp/schedules/preview", "POST"]] as const) {
      assert.equal((await app.request(path, { method })).status, 401);
    }
    flag(true);
    assert.deepEqual(await call("list_schedules"), []);
  });
  await t.test("preview validates without writing and defaults to the caller checkout", async () => {
    const preview = await call<SchedulePreviewResult>("preview_schedule", definition);
    assert.equal(preview.ok, true);
    assert.deepEqual(await call("list_schedules"), []);
    assert.equal(listTasks().length, 0);
  });
  await t.test("invalid cadence, zone, repository and template write nothing", async () => {
    for (const [over, error] of [
      [{ expression: "* * * * *" }, /hour|interval|60/i],
      [{ expression: "0 0 9 * * *" }, /five/],
      [{ timezone: "Invalid/Zone" }, /zone/i],
      [{ template: { ...definition.template, repoRoot: home } }, /repo/i],
      [{ template: { ...definition.template, model: "some-model" } }, /inherits its agent/],
      [{ template: { ...definition.template, intent: " " } }, /intent|small/i],
      [{ executionMode: "remote-runner" }, /local-catchup/],
    ] as const) await call("create_schedule", { ...definition, ...over }, error);
    await call("preview_schedule", { ...definition, sleepStartedAt: now }, /both/);
    assert.deepEqual(await call("list_schedules"), []);
  });
  let saved: MissionSchedule;
  await t.test("enabled and paused creations retain configuration and return canonical state", async () => {
    saved = await call<MissionSchedule>("create_schedule", { ...definition, completionPolicy: "auto-on-conclusion" });
    assert.equal(saved.enabled, true);
    assert.equal(saved.nextRunAt, now + 3600_000);
    assert.equal(saved.template?.repoRoot, repo);
    assert.equal(saved.template?.intent, definition.template.intent);
    assert.equal(saved.template?.agent, null);
    assert.equal(saved.template?.workflowId, null);
    assert.equal(saved.overlapPolicy, "skip-active");
    assert.equal(saved.missedPolicy, "coalesce-latest");
    assert.equal(saved.completionPolicy, "auto-on-conclusion");
    const paused = await call<MissionSchedule>("create_schedule", { ...definition, name: "Paused audit", enabled: false,
      template: { ...definition.template, repoRoot: repo, agent: "claude", model: "claude-opus-4-6", effort: "high" } });
    assert.equal(paused.enabled, false);
    assert.equal(paused.nextRunAt, null);
    assert.equal(paused.template?.model, "claude-opus-4-6");
    assert.equal(paused.template?.effort, "high");
    assert.equal(paused.completionPolicy, "manual");
    assert.equal((await call<MissionSchedule[]>("list_schedules")).length, 2);
    assert.equal(listTasks().length, 0, "saving never launches or creates a task immediately");
  });
  await t.test("a due enabled mission files exactly one backlog task, even after MCP access is disabled", async () => {
    flag(false);
    await call("create_schedule", definition, /mcp-schedules/);
    await call("preview_schedule", definition, /mcp-schedules/);
    await call("list_schedules", {}, /mcp-schedules/);
    await schedules.tick(now + 3600_000);
    await schedules.tick(now + 3600_000);
    const filed = listTasks();
    assert.equal(filed.length, 1);
    assert.ok(filed[0]);
    assert.equal(filed[0].status, "backlog");
    assert.equal(filed[0].intent, definition.template.intent);
    assert.equal(filed[0].scheduleId, saved.id);
  });
  await t.test("an older daemon gets upgrade guidance without a fallback mutation", async () => {
    oldDaemon = true;
    await call("create_schedule", definition, /Update or restart.*no schedule was created/);
  });
  await t.test("an unreachable daemon returns an MCP error with guidance before retrying creation", async () => {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await call("create_schedule", definition,
      /Could not reach Mission Control:.*check list_schedules before retrying; the outcome may be unknown\./);
  });
});

test("stalled schedule requests time out without retrying and preserve unknown-outcome guidance", { timeout: 30_000 }, async (t) => {
  const requests: string[] = [];
  const server = createServer((req) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume(); // Accept the request, but deliberately never send a response.
  });
  const client = new Client({ name: "schedule-timeout-test", version: "1" });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  // Accelerate only the child's 30-second deadline, keeping the real fetch/abort path.
  const preload = "data:text/javascript," + encodeURIComponent(
    "const timeout = AbortSignal.timeout; AbortSignal.timeout = ms => timeout(ms === 30_000 ? 1_000 : ms);",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, "--import", fileURLToPath(import.meta.resolve("tsx")), fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url))],
    cwd: repo,
    env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.json", import.meta.url)), MISSION_HOME: home, MISSION_API_TOKEN: ensureToken(), MISSION_PORT: String(address.port) } as Record<string, string>,
    stderr: "pipe",
  });
  await client.connect(transport);
  const definition = { name: "Stalled audit", expression: "0 9 * * *", timezone: "UTC", template: {
    title: "Audit dependencies", intent: "Report dependency issues and verify findings.",
  } };
  await Promise.all(["create_schedule", "preview_schedule", "list_schedules"].map(async (name) => {
    const result = await client.callTool({ name, arguments: name === "list_schedules" ? {} : definition }, undefined, { timeout: 10_000 });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /TimeoutError.*check list_schedules before retrying; the outcome may be unknown/);
  }));
  assert.deepEqual(requests.sort(), ["GET /mcp/schedules", "POST /mcp/schedules", "POST /mcp/schedules/preview"],
    "each tool sends one request and never retries an uncertain outcome");
});
