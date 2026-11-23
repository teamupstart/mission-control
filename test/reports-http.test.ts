import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportItem } from "../src/shared/reports.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// The report routes, as the MCP tool and the dashboard reach them.
//
// `POST /mcp/reports` is the tool's own channel: the machine token and the caller's own session,
// never a body-named target. With the `inbox` flag off it refuses with a 404 carrying `feature`,
// which the tool turns into "turned off in Settings". Opening and marking read are the
// operator's: the machine token, an agent-attributed request and Foreman are refused, so nothing
// but a person takes a report out of to read. A session's history is answered after the session
// has gone, because the session is a report's permanent home.

const home = mkdtempSync(join(tmpdir(), "mission-reports-http-"));
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ReportManager } = await import("../src/server/reports.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const LOOPBACK = { host: "127.0.0.1:7317", "content-type": "application/json" };

function setup(withManager = true) {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((event) => events.push(event));
  const reports = withManager ? new ReportManager(registry) : undefined;
  after(() => reports?.stop());
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks: {} as unknown as TaskManager,
    queues: {} as unknown as QueueManager,
    ...(reports ? { reports } : {}),
  });
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string) => {
    const res = await app.request(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { ...LOOPBACK, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const agent = { "x-harness-token": ensureToken() };
  return { registry, events, call, agent };
}

let n = 0;
/** A live session discovered in its own checkout, which is how the tool's `cwd` finds it. */
function liveSession(registry: InstanceType<typeof Registry>): { id: string; cwd: string } {
  const id = `s-http-${++n}`;
  const cwd = join(home, id);
  mkdirSync(cwd, { recursive: true });
  registry.applyDiscovery([{
    syntheticId: id, agent: "claude", name: "work", nameSource: "process", cwd, gitBranch: "b",
    pid: 1, tty: "ttys015", terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: `%${id}` })],
    startedAt: 0,
  } as DiscoveredSession]);
  return { id, cwd };
}

const setInbox = (enabled: boolean) => flags.applyFeatureFlagIntent({ kind: "flag", id: "inbox", enabled });
setInbox(true);

test("the tool's post is token-guarded, bound to its caller, and answers with the receipt", async () => {
  const { registry, call, agent, events } = setup();
  const { id, cwd } = liveSession(registry);
  assert.equal((await call("/mcp/reports", { env: {}, cwd, title: "t", body: "b" })).status, 401);
  const posted = await call("/mcp/reports", { env: {}, cwd, title: "Build failure\n  diagnosed", body: "Stale cache." }, agent);
  assert.equal(posted.status, 200);
  const report = posted.body.report as ReportItem;
  assert.equal(report.sessionId, id);
  assert.equal(report.title, "Build failure diagnosed", "a title is one line");
  assert.match(posted.body.receipt as string, new RegExp(`^Report ${report.id} posted to your operator's inbox\\. Do not wait for a reply`));
  assert.ok(events.some((event) => event.type === "report_upsert" && event.report.id === report.id));
  // No matching session, and an invalid body, are refused before anything is stored.
  assert.equal((await call("/mcp/reports", { env: {}, cwd: join(home, "nowhere"), title: "t", body: "b" }, agent)).status, 404);
  assert.equal((await call("/mcp/reports", { env: {}, cwd, title: "", body: "b" }, agent)).status, 400);
  assert.equal((await call("/mcp/reports", { env: {}, cwd, title: "t", body: "b", url: "javascript:alert(1)" }, agent)).status, 400);
  assert.equal((await call("/mcp/reports", { env: {}, cwd, title: "t", body: "b", replaces: "42" }, agent)).status, 400);
  assert.equal((await call("/mcp/reports", { env: {}, cwd, title: "t", body: "x".repeat(4001) }, agent)).status, 400);
});

test("a bad replaces is refused with the agent's own open reports", async () => {
  const { registry, call, agent } = setup();
  const { cwd } = liveSession(registry);
  const first = (await call("/mcp/reports", { env: {}, cwd, title: "Alpha", body: "a" }, agent)).body.report as ReportItem;
  const refused = await call("/mcp/reports", { env: {}, cwd, title: "x", body: "y", replaces: "r-999999" }, agent);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error as string, new RegExp(`${first.id} "Alpha"`));
  const replaced = await call("/mcp/reports", { env: {}, cwd, title: "Alpha 2", body: "a2", replaces: first.id }, agent);
  assert.equal(replaced.status, 200);
  assert.match(replaced.body.receipt as string, /It replaces your earlier report/);
});

test("an attached file must be an .html or .md inside the checkout, within the size cap", async () => {
  const { registry, call, agent } = setup();
  const { cwd } = liveSession(registry);
  writeFileSync(join(cwd, "report.html"), "<h1>Findings</h1>");
  writeFileSync(join(home, "secret.md"), "outside");
  writeFileSync(join(cwd, "big.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  const post = (file: string) => call("/mcp/reports", { env: {}, cwd, title: "t", body: "b", file }, agent);
  const ok = await post("report.html");
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body.report as ReportItem).document, { name: "report.html", kind: "html" });
  assert.equal((await post("../secret.md")).status, 403);
  assert.equal((await post(join(home, "secret.md"))).status, 400, "an absolute path is not checkout-relative");
  assert.equal((await post("big.md")).status, 413);
  assert.equal((await post("missing.html")).status, 404);
});

test("opened and read are the operator's alone, and idempotent", async () => {
  const { registry, call, agent } = setup();
  const { cwd } = liveSession(registry);
  const report = (await call("/mcp/reports", { env: {}, cwd, title: "t", body: "b" }, agent)).body.report as ReportItem;
  for (const path of [`/api/reports/${report.id}/opened`, `/api/reports/${report.id}/read`]) {
    // Each guard alone: the machine token, a signed agent credential with no token, and the two
    // agent-attributed actors.
    for (const headers of [
      agent,
      { "x-mission-scout-credential": "signed-agent-credential" },
      { "x-mission-operation-actor": "agent" },
      { "x-mission-operation-actor": "foreman" },
    ] as Record<string, string>[]) {
      const refused = await call(path, {}, headers);
      assert.equal(refused.status, 403, `${path} refuses ${JSON.stringify(headers)}`);
      assert.equal(refused.body.error, "Only the operator can open, mark read, reply to, follow up or publish a report");
    }
  }
  // None of those refusals opened or read it.
  const untouched = (await call(`/api/sessions/${report.sessionId}/reports`)).body.reports as ReportItem[];
  assert.deepEqual(untouched.map((r) => [r.openedAt, r.readAt]), [[null, null]]);
  const opened = await call(`/api/reports/${report.id}/opened`, {});
  assert.equal(opened.status, 200);
  assert.equal((opened.body.report as ReportItem).readAt, null, "opening is not reading");
  const read = await call(`/api/reports/${report.id}/read`, {});
  assert.equal((read.body.report as ReportItem).readBy, "mark-read");
  const again = await call(`/api/reports/${report.id}/read`, {});
  assert.equal((again.body.report as ReportItem).readAt, (read.body.report as ReportItem).readAt);
  assert.equal((await call("/api/reports/r-424242/read", {})).status, 404);
});

test("a session's history lists every version, read or not, after the session is gone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { registry, call, agent } = setup();
  const { id, cwd } = liveSession(registry);
  const a = (await call("/mcp/reports", { env: {}, cwd, title: "v1", body: "b" }, agent)).body.report as ReportItem;
  const b = (await call("/mcp/reports", { env: {}, cwd, title: "v2", body: "b", replaces: a.id }, agent)).body.report as ReportItem;
  await call(`/api/reports/${b.id}/read`, {});
  registry.applyDiscovery([]);
  t.mock.timers.tick(10_000);
  assert.equal(registry.getSession(id), undefined);
  const history = await call(`/api/sessions/${id}/reports`);
  assert.equal(history.status, 200);
  assert.deepEqual((history.body.reports as ReportItem[]).map((r) => [r.id, r.version, r.readBy]), [[a.id, 1, null], [b.id, 2, "mark-read"]]);
});

test("with the inbox flag off every report route refuses with the feature named, and stored rows are kept", async () => {
  const { registry, call, agent } = setup();
  const { id, cwd } = liveSession(registry);
  const report = (await call("/mcp/reports", { env: {}, cwd, title: "kept", body: "b" }, agent)).body.report as ReportItem;
  setInbox(false);
  try {
    for (const [path, body, headers] of [
      ["/mcp/reports", { env: {}, cwd, title: "t", body: "b" }, agent],
      [`/api/reports/${report.id}/opened`, {}, {}],
      [`/api/reports/${report.id}/read`, {}, {}],
      [`/api/sessions/${id}/reports`, undefined, {}],
    ] as const) {
      const refused = await call(path, body, headers);
      assert.equal(refused.status, 404, path);
      assert.equal(refused.body.feature, "inbox", path);
    }
    assert.equal(registry.snapshot().reports, undefined);
  } finally {
    setInbox(true);
  }
  const history = await call(`/api/sessions/${id}/reports`);
  assert.deepEqual((history.body.reports as ReportItem[]).map((r) => [r.id, r.readAt]), [[report.id, null]]);
});

test("GET /api/reports/:id answers a read report, and a replaced one with the latest of its chain", async () => {
  const { registry, call, agent } = setup();
  const { cwd } = liveSession(registry);
  const post = async (body: Record<string, unknown>) =>
    (await call("/mcp/reports", { env: {}, cwd, body: "b", ...body }, agent)).body.report as ReportItem;
  const read = await post({ title: "Read already" });
  await call(`/api/reports/${read.id}/read`, {});
  const answered = await call(`/api/reports/${read.id}`);
  assert.equal(answered.status, 200);
  assert.equal((answered.body.report as ReportItem).readBy, "mark-read");
  assert.equal(answered.body.latest, null);
  // Replaced twice: the answer carries the chain's latest, not the middle version.
  const v1 = await post({ title: "v1" });
  const v2 = await post({ title: "v2", replaces: v1.id });
  const v3 = await post({ title: "v3", replaces: v2.id });
  const chained = await call(`/api/reports/${v1.id}`);
  assert.equal((chained.body.report as ReportItem).id, v1.id);
  assert.equal((chained.body.latest as ReportItem).id, v3.id);
  assert.equal((await call("/api/reports/r-424242")).status, 404);
  // Any report on any session, whole: the operator's to read, never an agent's.
  const agentRead = await call(`/api/reports/${v1.id}`, undefined, agent);
  assert.equal(agentRead.status, 403);
  assert.equal(agentRead.body.report, undefined);
  setInbox(false);
  try {
    const refused = await call(`/api/reports/${v1.id}`);
    assert.equal(refused.status, 404);
    assert.equal(refused.body.feature, "inbox");
  } finally {
    setInbox(true);
  }
});

test("an app built without the manager answers 503 rather than building a second owner", async () => {
  const { registry, call, agent } = setup(false);
  const { cwd } = liveSession(registry);
  assert.equal((await call("/mcp/reports", { env: {}, cwd, title: "t", body: "b" }, agent)).status, 503);
  assert.equal((await call("/api/reports/r-1/read", {})).status, 503);
});
