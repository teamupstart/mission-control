// F1: headless mode is safe to ship. Flag off changes nothing; flag on only reaches stubs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-flag-"));
process.env.MISSION_HOME = home;

const { openDb, closeDb, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/server/db.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { FEATURE_FLAGS } = await import("../src/shared/feature-flag-registry.ts");
const {
  DISPATCH_FEATURE_DISABLED, HOME_DISPATCH_CAPABILITY, HOME_DISPATCH_KIND_ORDER, HOME_DISPATCH_KINDS,
  HOME_DISPATCH_SURFACES, HOME_DISPATCH_ROUTES, homeDispatchRouteLabel,
} = await import("../src/shared/home-dispatch.ts");
const { TASK_KIND_INFO } = await import("../src/shared/task.ts");
const { MISSION_MCP_TOOLS, HOME_DISPATCH_MCP_TOOLS, kindMissionMcpRequirement } = await import("../src/server/mission-mcp.ts");

const FLAG = "headless-mode" as const;
const JSON_HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: false });
});

function app() {
  const registry = new Registry();
  return buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
}
const authed = () => ({ ...JSON_HEADERS, "x-harness-token": ensureToken() });

const CALLER = { sessionId: "s1", cwd: "/tmp/repo" };
const ROUTES: Array<{ name: string; method: "GET" | "POST"; path: string; body?: unknown; owner: string }> = [
  { name: "sessions", method: "POST", path: "/mcp/dispatch/sessions", body: { sessionId: "s1", harness: "claude", cwd: "/tmp/repo" }, owner: "WP2a" },
  { name: "inbox", method: "GET", path: "/mcp/dispatch/inbox?repo=%2Ftmp%2Frepo", owner: "WP2b" },
  { name: "answers", method: "POST", path: "/mcp/dispatch/answers", body: { ...CALLER, action: "answer", reviewId: "r1", option: "Keep" }, owner: "WP2b" },
  { name: "dispatch-options", method: "POST", path: "/mcp/dispatch/dispatch-options", body: { cwd: "/tmp/repo", entry: "command" }, owner: "WP3" },
  { name: "drafts", method: "POST", path: "/mcp/dispatch/drafts", body: { ...CALLER, kind: "ship" }, owner: "WP3" },
  { name: "drafts/{id}", method: "POST", path: "/mcp/dispatch/drafts/d1", body: { ...CALLER, words: "x" }, owner: "WP3" },
  { name: "drafts/{id}/confirm", method: "POST", path: "/mcp/dispatch/drafts/d1/confirm", body: { ...CALLER, choice: "start" }, owner: "WP3" },
  { name: "checkins", method: "POST", path: "/mcp/dispatch/checkins", body: CALLER, owner: "WP3" },
  { name: "config", method: "GET", path: "/mcp/dispatch/config", owner: "WP2b" },
  { name: "jump", method: "POST", path: "/mcp/dispatch/jump", body: { target: "home" }, owner: "WP10" },
];
/** Work packages whose routes answer for real now; the rest still answer their 501 stub. */
const LANDED_OWNERS = new Set(["WP3"]);
const STUB_ROUTES = ROUTES.filter((r) => !LANDED_OWNERS.has(r.owner));
const call = (a: ReturnType<typeof app>, r: (typeof ROUTES)[number], headers = authed()) =>
  a.request(r.path, { method: r.method, headers, body: r.body === undefined ? undefined : JSON.stringify(r.body) });

function dispatchRowCount(): number {
  const d = openDb();
  const count = (sql: string) => Number((d.prepare(sql).get() as { n: number }).n);
  return count("SELECT COUNT(*) n FROM home_dispatch_sessions") + count("SELECT COUNT(*) n FROM home_dispatch_turns")
    + count("SELECT COUNT(*) n FROM home_dispatch_receipts")
    + count("SELECT COUNT(*) n FROM tasks WHERE origin_surface IS NOT NULL OR origin_repo IS NOT NULL OR origin_session_id IS NOT NULL OR origin_terminal IS NOT NULL");
}

test("F1 registry: headless-mode is one preview flag, off by default", () => {
  const def = FEATURE_FLAGS.find((f) => f.id === FLAG);
  assert.deepEqual(def, {
    id: "headless-mode", label: "Headless mode",
    description: "Dispatch work to Mission Control from a Claude Code terminal session.",
    stage: "preview", keywords: ["headless", "terminal", "cli", "dispatch"],
  });
  assert.equal(flags.featureEnabled(FLAG), false);
});

test("F1 routes: the registered dispatch routes are exactly the shared table, and each stub names its own entry", async () => {
  const a = app();
  const registered = a.routes
    .filter((r) => r.method !== "ALL" && r.path.startsWith("/mcp/dispatch"))
    .map((r) => r.method + " " + r.path).sort();
  assert.deepEqual(registered, Object.values(HOME_DISPATCH_ROUTES).map(homeDispatchRouteLabel).sort());
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  const labels = new Set<string>();
  for (const r of STUB_ROUTES) {
    const res = await call(a, r);
    labels.add(((await res.json()) as { route: string }).route);
  }
  const landed = ROUTES.filter((r) => LANDED_OWNERS.has(r.owner)).map((r) => r.path.split("?")[0]!);
  const expected = Object.values(HOME_DISPATCH_ROUTES).filter((route) => !landed.some((path) => path === route.path || (route.path.includes(":id") && path.startsWith(route.path.split(":id")[0]!))));
  assert.deepEqual([...labels].sort(), expected.map(homeDispatchRouteLabel).sort());
});

test("F1 flag off: every dispatch route answers the 404 disabled body and runs no handler", async () => {
  const a = app();
  for (const r of ROUTES) {
    const res = await call(a, r);
    assert.equal(res.status, 404, r.name);
    assert.deepEqual(await res.json(), DISPATCH_FEATURE_DISABLED, r.name);
  }
});

test("F1 flag off: nothing is written to the dispatch tables or origin columns", async () => {
  const a = app();
  for (const r of ROUTES) await call(a, r);
  assert.equal(dispatchRowCount(), 0);
});

test("F1 auth: a dispatch route without the token is 401 whether the flag is on or off", async () => {
  const a = app();
  for (const on of [false, true]) {
    flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: on });
    for (const r of ROUTES) assert.equal((await call(a, r, JSON_HEADERS as ReturnType<typeof authed>)).status, 401, r.name);
  }
});

test("F1 flag on: each route validates its body (400) and otherwise answers its 501 stub", async () => {
  const a = app();
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  for (const r of ROUTES) {
    const res = LANDED_OWNERS.has(r.owner) ? null : await call(a, r);
    if (res === null) {
      const bad = await a.request(r.path, { method: r.method, headers: authed(), body: JSON.stringify({}) });
      assert.equal(bad.status, 400, `${r.name} rejects an empty body`);
      continue;
    }
    assert.equal(res.status, 501, r.name);
    const body = (await res.json()) as { error: string; feature: string; route: string; owner: string };
    assert.equal(body.error, "not implemented", r.name);
    assert.equal(body.feature, FLAG, r.name);
    assert.equal(body.owner, r.owner, r.name);
    assert.ok(body.route.includes("/mcp/dispatch"), r.name);
    if (r.body !== undefined) {
      const bad = await a.request(r.path, { method: r.method, headers: authed(), body: JSON.stringify({}) });
      assert.equal(bad.status, 400, `${r.name} rejects an empty body`);
    }
  }
  assert.equal((await a.request("/mcp/dispatch/inbox", { headers: authed() })).status, 400, "inbox needs repo");
  assert.equal(dispatchRowCount(), 0, "a stub writes nothing");
});

test("F1 answers route: each action needs its own fields (400) and its valid form reaches the 501 stub", async () => {
  const a = app();
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  const post = async (body: unknown) => (await a.request("/mcp/dispatch/answers", { method: "POST", headers: authed(), body: JSON.stringify(body) })).status;
  const base = { ...CALLER, reviewId: "r1" };
  const refused: unknown[] = [
    { ...base, action: "approve_plan" },
    { ...base, action: "approve_plan", revisionHash: "" },
    { ...base, action: "request_changes" },
    { ...base, action: "request_changes", text: "" },
    { ...base, action: "bogus" },
    { ...base, action: "answer", reviewId: "" },
    { ...base, action: "answer" },
    { ...base },
    { sessionId: "s1", action: "approve_review", reviewId: "r1" },
  ];
  for (const body of refused) assert.equal(await post(body), 400, JSON.stringify(body));
  const accepted: unknown[] = [
    { ...base, action: "approve_plan", revisionHash: "abc123" },
    { ...base, action: "request_changes", text: "Needs revision" },
    { ...base, action: "answer", option: "Keep" },
    { ...base, action: "answer", text: "typed" },
    { ...base, action: "approve_review" },
    { ...base, action: "reject_review", text: "no" },
  ];
  for (const body of accepted) assert.equal(await post(body), 501, JSON.stringify(body));
  assert.equal(dispatchRowCount(), 0, "validation and stubs write nothing");
});

test("F1 live toggle: the same app follows the flag per request, with no restart", async () => {
  const a = app();
  const r = ROUTES.find((x) => x.name === "config")!;
  const statuses: number[] = [];
  for (const on of [false, true, false, true]) {
    flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: on });
    statuses.push((await call(a, r)).status);
  }
  assert.deepEqual(statuses, [404, 501, 404, 501]);
});

test("F1 health: home-dispatch-v1 is listed only while the flag is on", async () => {
  const a = app();
  const caps = async () => ((await (await a.request("/api/health", { headers: JSON_HEADERS })).json()) as { capabilities: string[] }).capabilities;
  const before = await caps();
  assert.ok(!before.includes(HOME_DISPATCH_CAPABILITY));
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: true });
  const on = await caps();
  assert.ok(on.includes(HOME_DISPATCH_CAPABILITY));
  assert.deepEqual(on.filter((c) => c !== HOME_DISPATCH_CAPABILITY), before, "every other capability is unchanged");
  flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: false });
  assert.deepEqual(await caps(), before);
});

test("F1 hook route: flag off and on both keep today's empty 204 until WP2a adds output", async () => {
  const a = app();
  for (const on of [false, true]) {
    flags.applyFeatureFlagIntent({ kind: "flag", id: FLAG, enabled: on });
    const res = await a.request("/hooks/SessionStart", {
      method: "POST", headers: authed(), body: JSON.stringify({ sessionId: "hook-s1", cwd: "/tmp/repo" }),
    });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  }
  assert.equal(dispatchRowCount(), 0, "the stub hook output registers no home session");
});

test("F1 schema 36: new tables and origin columns exist and start empty", () => {
  assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 36);
  const d = openDb();
  const cols = (table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["origin_surface", "origin_repo", "origin_session_id", "origin_terminal"]) assert.ok(cols("tasks").includes(c), c);
  assert.ok(cols("session_standing_instructions").includes("repo_task_skills"));
  assert.deepEqual(cols("home_dispatch_sessions"), [
    "session_id", "harness", "cwd", "repo_root", "claude_pid", "hook_version", "start_source", "entrypoint", "terminal",
    "launcher_offered_at", "launcher_disabled", "started_at", "last_turn_at", "last_stop_at",
  ]);
  assert.deepEqual(cols("home_dispatch_turns"), [
    "session_id", "prompt_id", "opened_at", "closed_at", "excerpt", "contains_approval", "mentioned_hashes", "cards_shown",
  ]);
  assert.deepEqual(cols("home_dispatch_receipts"), ["review_id", "task_id", "session_id", "surface", "sent", "from_words", "created_at"]);
  const index = d.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_home_dispatch_turns_session'").get() as { sql: string };
  assert.match(index.sql, /\(session_id, opened_at\)/);
});

test("F1 contracts: the kind order holds exactly the dispatch kinds, each a registry kind", () => {
  assert.deepEqual([...HOME_DISPATCH_KIND_ORDER].sort(), [...HOME_DISPATCH_KINDS].sort());
  for (const kind of HOME_DISPATCH_KINDS) assert.ok(kind in TASK_KIND_INFO, kind);
  assert.deepEqual([...HOME_DISPATCH_SURFACES], ["home-session", "mctl"], "persisted values never change");
});

test("F1 MCP vocabulary: no launch requirement for any task kind declares a dispatch tool", () => {
  const dispatch = HOME_DISPATCH_MCP_TOOLS as readonly string[];
  for (const tool of MISSION_MCP_TOOLS) assert.ok(!dispatch.includes(tool), tool);
  for (const kind of Object.keys(TASK_KIND_INFO)) {
    // The most a launch can add: grill first, workflow evidence and plan inputs together.
    const requirement = kindMissionMcpRequirement(
      { kind, workflowId: null, planInputs: [{ path: "p" }], grillFirst: true } as never, null, true,
    );
    for (const tool of requirement?.tools ?? []) assert.ok(!dispatch.includes(tool), kind + " requires " + tool);
  }
  assert.deepEqual([...HOME_DISPATCH_MCP_TOOLS], [
    "start_dispatch", "submit_brief", "checkin", "read_inbox", "answer_task", "read_dispatch_options",
  ]);
});
