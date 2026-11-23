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
      assert.equal(refused.body.error, "Only the operator can open, mark read, reply to, follow up or mute reports, or change their guidance");
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
  // Reading a report is not acting on it, so an agent's token may read it too.
  assert.equal((await call(`/api/reports/${v1.id}`, undefined, agent)).status, 200);
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

// ---- noise controls (Phase 7): guidance, mutes and Mark all read ----

test("report guidance: the default until saved, the operator's text once saved, refused past the limit, and reset by null", async () => {
  const { call, agent } = setup();
  const { DEFAULT_REPORT_GUIDANCE, REPORT_GUIDANCE_LIMIT } = await import("../src/shared/reports.ts");
  const initial = await call("/api/reports/guidance");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, { guidance: null, effective: DEFAULT_REPORT_GUIDANCE, defaultGuidance: DEFAULT_REPORT_GUIDANCE, limit: REPORT_GUIDANCE_LIMIT });
  // The MCP child's read: the machine token, and the guidance in force.
  assert.equal((await call("/mcp/reports/guidance")).status, 401);
  assert.deepEqual((await call("/mcp/reports/guidance", undefined, agent)).body, { guidance: DEFAULT_REPORT_GUIDANCE });

  const custom = "Only post a report when a pull request is ready for review.";
  const saved = await call("/api/reports/guidance", { guidance: `  ${custom}\n` }, {}, "PUT");
  assert.equal(saved.status, 200);
  assert.equal(saved.body.guidance, custom, "trimmed");
  assert.equal(saved.body.effective, custom);
  assert.deepEqual((await call("/mcp/reports/guidance", undefined, agent)).body, { guidance: custom });

  const tooLong = await call("/api/reports/guidance", { guidance: "x".repeat(REPORT_GUIDANCE_LIMIT + 1) }, {}, "PUT");
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, `report guidance can be at most ${REPORT_GUIDANCE_LIMIT} characters`);
  assert.equal((await call("/api/reports/guidance")).body.guidance, custom, "a refused save changes nothing");
  // Exactly the limit is accepted.
  assert.equal((await call("/api/reports/guidance", { guidance: "y".repeat(REPORT_GUIDANCE_LIMIT) }, {}, "PUT")).status, 200);

  // An agent never changes it.
  assert.equal((await call("/api/reports/guidance", { guidance: "post everything" }, agent, "PUT")).status, 403);
  assert.equal((await call("/api/reports/guidance", { guidance: "post everything" }, { "x-mission-operation-actor": "agent" }, "PUT")).status, 403);

  // Reset: null, or blank text, is the default again.
  const reset = await call("/api/reports/guidance", { guidance: null }, {}, "PUT");
  assert.deepEqual([reset.body.guidance, reset.body.effective], [null, DEFAULT_REPORT_GUIDANCE]);
  await call("/api/reports/guidance", { guidance: custom }, {}, "PUT");
  const blank = await call("/api/reports/guidance", { guidance: "   " }, {}, "PUT");
  assert.deepEqual([blank.body.guidance, blank.body.effective], [null, DEFAULT_REPORT_GUIDANCE]);
});

test("a mute is the operator's, names the author, rides the snapshot and one event, and never marks a report read", async () => {
  const { registry, call, agent, events } = setup();
  const { cwd, id } = liveSession(registry);
  const report = (await call("/mcp/reports", { env: {}, cwd, title: "Chatty", body: "b" }, agent)).body.report as ReportItem;
  const authorKey = report.author.key;
  assert.equal(authorKey, `session:${id}`);

  for (const headers of [agent, { "x-mission-operation-actor": "agent" }, { "x-mission-operation-actor": "foreman" }] as Record<string, string>[]) {
    assert.equal((await call("/api/reports/mutes", { authorKey }, headers)).status, 403);
  }
  assert.equal((await call("/api/reports/mutes", { authorKey: "session:never-posted" })).status, 404, "no report from that author");
  assert.equal((await call("/api/reports/mutes", { authorKey: "nobody" })).status, 400);

  const before = events.length;
  const muted = await call("/api/reports/mutes", { authorKey });
  assert.equal(muted.status, 200);
  const mute = muted.body.mute as { authorKey: string; authorName: string; mutedAt: number };
  assert.deepEqual([mute.authorKey, mute.authorName], [authorKey, report.author.name]);
  const told = events.slice(before).filter((event) => event.type === "report_mutes");
  assert.equal(told.length, 1);
  assert.ok(told[0]!.type === "report_mutes" && told[0]!.mutes.some((m) => m.authorKey === authorKey));
  assert.ok(registry.snapshot().reportMutes?.some((m) => m.authorKey === authorKey));
  // Muting again keeps the first mute's time.
  const again = await call("/api/reports/mutes", { authorKey });
  assert.equal((again.body.mute as { mutedAt: number }).mutedAt, mute.mutedAt);

  // A muted agent can still post, and nothing it posted was marked read.
  const later = await call("/mcp/reports", { env: {}, cwd, title: "Still chatty", body: "b" }, agent);
  assert.equal(later.status, 200);
  const history = (await call(`/api/sessions/${id}/reports`)).body.reports as ReportItem[];
  assert.deepEqual(history.map((r) => [r.title, r.readAt]), [["Chatty", null], ["Still chatty", null]]);
  // Both still ride the snapshot: the dashboard's fold, not the daemon, leaves them out.
  assert.ok(registry.snapshot().reports?.some((r) => r.title === "Still chatty"));

  // Unmute is the operator's too; once gone, a second unmute is a 404.
  const path = `/api/reports/mutes/${encodeURIComponent(authorKey)}`;
  assert.equal((await call(path, undefined, agent, "DELETE")).status, 403);
  const unmuted = await call(path, undefined, {}, "DELETE");
  assert.equal(unmuted.status, 200);
  assert.ok(!(unmuted.body.mutes as { authorKey: string }[]).some((m) => m.authorKey === authorKey));
  assert.ok(!registry.snapshot().reportMutes?.some((m) => m.authorKey === authorKey));
  assert.equal((await call(path, undefined, {}, "DELETE")).status, 404);
});

test("Mark all read marks exactly the ids it was sent, as mark-all, and leaves any other report unread", async () => {
  const { registry, call, agent } = setup();
  const first = liveSession(registry);
  const second = liveSession(registry);
  const a = (await call("/mcp/reports", { env: {}, cwd: first.cwd, title: "A", body: "a" }, agent)).body.report as ReportItem;
  const b = (await call("/mcp/reports", { env: {}, cwd: second.cwd, title: "B", body: "b" }, agent)).body.report as ReportItem;
  // Arrives after the click: the section never listed it, so it was not sent.
  const late = (await call("/mcp/reports", { env: {}, cwd: first.cwd, title: "Late", body: "c" }, agent)).body.report as ReportItem;

  assert.equal((await call("/api/reports/read-all", { ids: [a.id, b.id] }, agent)).status, 403);
  assert.equal((await call("/api/reports/read-all", { ids: [] })).status, 400);
  assert.equal((await call("/api/reports/read-all", { ids: ["nope"] })).status, 400);

  const done = await call("/api/reports/read-all", { ids: [a.id, b.id, a.id] });
  assert.equal(done.status, 200);
  assert.deepEqual((done.body.reports as ReportItem[]).map((r) => [r.id, r.readBy]), [[a.id, "mark-all"], [b.id, "mark-all"]]);
  const read = async (sessionId: string) => (await call(`/api/sessions/${sessionId}/reports`)).body.reports as ReportItem[];
  assert.deepEqual((await read(first.id)).map((r) => [r.id, r.readBy]), [[a.id, "mark-all"], [late.id, null]]);
  assert.deepEqual((await read(second.id)).map((r) => [r.id, r.readBy]), [[b.id, "mark-all"]]);
  // Already read: changed by nothing, and not answered as cleared again.
  const repeat = await call("/api/reports/read-all", { ids: [a.id, "r-424242"] });
  assert.deepEqual(repeat.body.reports, []);
  assert.equal((await read(first.id))[0]!.readAt, (done.body.reports as ReportItem[])[0]!.readAt);
});

test("Mark all read clears a Reports section of 1,001 reports in one press, batched under the route's bound", async () => {
  const { registry, call, agent } = setup();
  const { REPORT_READ_ALL_BATCH } = await import("../src/shared/reports.ts");
  const { markAllReportsRead } = await import("../src/web/lib/report-state.ts");
  const { id, cwd } = liveSession(registry);
  const ids: string[] = [];
  for (let n = 0; n < REPORT_READ_ALL_BATCH + 1; n++) {
    ids.push(((await call("/mcp/reports", { env: {}, cwd, title: `Report ${n}`, body: "b" }, agent)).body.report as ReportItem).id);
  }
  // The route stays bounded: one request may not carry the whole section.
  assert.equal((await call("/api/reports/read-all", { ids })).status, 400);
  // What the dashboard's button does with the ids it lists.
  const batches: number[] = [];
  const refused = await markAllReportsRead(ids, async (batch) => {
    batches.push(batch.length);
    const answer = await call("/api/reports/read-all", { ids: batch });
    return answer.status === 200 ? { ok: true } : { ok: false, error: String(answer.body.error) };
  });
  assert.equal(refused, null);
  assert.deepEqual(batches, [REPORT_READ_ALL_BATCH, 1]);
  const history = (await call(`/api/sessions/${id}/reports`)).body.reports as ReportItem[];
  assert.equal(history.length, REPORT_READ_ALL_BATCH + 1);
  assert.ok(history.every((report) => report.readBy === "mark-all"), "every listed report is read, as mark-all");
  assert.ok(!registry.reportsToRead().some((report) => report.sessionId === id), "none left to read");
});

test("both guidance routes answer the whole view the dashboard's contract requires", async () => {
  const { call } = setup();
  const { ReportGuidanceViewSchema } = await import("../src/shared/protocol.ts");
  assert.ok(ReportGuidanceViewSchema.safeParse((await call("/api/reports/guidance")).body).success);
  const saved = await call("/api/reports/guidance", { guidance: "Post when a review is ready." }, {}, "PUT");
  assert.ok(ReportGuidanceViewSchema.safeParse(saved.body).success, JSON.stringify(saved.body));
  const reset = await call("/api/reports/guidance", { guidance: null }, {}, "PUT");
  assert.ok(ReportGuidanceViewSchema.safeParse(reset.body).success, JSON.stringify(reset.body));
});
