import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PRIMARY_ACTION_ROUTES, PRIMARY_FEATURES, matchPrimaryAction } from "../src/shared/telemetry-sources/primary-actions.ts";
import { ACTION_RESULT_SCHEMA } from "../src/shared/telemetry-sources/actions.ts";
import { ERROR_SCHEMA, FEATURE_EVENT, FEATURE_SCHEMA } from "../src/shared/telemetry-sources/experience.ts";
import { resolveOperationContext } from "../src/shared/telemetry-ingress.ts";
import { TELEMETRY_LIMITS } from "../src/shared/telemetry.ts";

const home = mkdtempSync(join(tmpdir(), "mission-actions-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb } = await import("../src/server/db.ts");
const { setTelemetryConfig } = await import("../src/server/telemetry/config.ts");
const { registerBuiltinTelemetry } = await import("../src/server/telemetry/service.ts");
const { runProjectionPass } = await import("../src/server/telemetry/projection.ts");
const { listSeries } = await import("../src/server/telemetry/store.ts");
const { recordPrimaryAction, recordSafeError, operationObservation, recordAutomationTransition } = await import("../src/server/telemetry/experience.ts");
const { primaryActionTelemetry, primaryOutcome } = await import("../src/server/telemetry/primary-actions.ts");
const { admitBrowserTelemetry, resetIngressRateLimitForTesting } = await import("../src/server/telemetry/ingress.ts");
registerBuiltinTelemetry();
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  closeDb(); rmSync(join(home, "harness.db"), { force: true }); openDb();
  resetIngressRateLimitForTesting();
  assert.equal(setTelemetryConfig({ enabled: true, user: { enabled: true, endpoint: "http://127.0.0.1:4318" },
    product: { enabled: true, endpoint: "http://127.0.0.1:4319" } }).ok, true);
});
const headers = { host: "127.0.0.1", "content-type": "application/json", "x-mission-operation-id": "0123456789abcdef", "x-mission-operation-surface": "board", "x-mission-operation-actor": "human" };
const context = () => resolveOperationContext(new Headers(headers));
function events(name: string, profile = "local") {
  return (openDb().prepare(`SELECT facts_json, refs_json, actor_json FROM telemetry_journal WHERE name = ? AND EXISTS (SELECT 1 FROM json_each(profiles_json) WHERE value = ?) ORDER BY seq`)
    .all(name, profile) as { facts_json: string; refs_json: string; actor_json: string }[])
    .map((r) => ({ facts: JSON.parse(r.facts_json), refs: JSON.parse(r.refs_json), actor: JSON.parse(r.actor_json) }));
}
function total(name: string, profile: "local" | "user" | "product" = "local") { return listSeries(openDb(), profile).filter((s) => s.instrument === name).reduce((sum, s) => sum + s.value, 0); }

test("every declared action validates, has one route match, and preserves the Phase 4 contract", () => {
  const keys = new Set<string>();
  for (const [method, path, action, feature] of PRIMARY_ACTION_ROUTES) {
    assert.ok(!keys.has(`${method}:${path}`)); keys.add(`${method}:${path}`);
    assert.equal(matchPrimaryAction(method, path.replace(/:[A-Za-z]+/g, "subject"))?.action, action);
    assert.ok(ACTION_RESULT_SCHEMA.safeParse({ feature, action, outcome: "applied", observation: "initial", duration_ms: 0, surface: "board", coverage: "owner_result", intent: "unknown", cause: "unknown" }).success);
    assert.ok(FEATURE_SCHEMA.safeParse({ feature, action: "enter" }).success, `${feature} supports browser feature entry`);
  }
  assert.ok(ACTION_RESULT_SCHEMA.safeParse({ feature: "workflow", action: "workflow.resubmit", outcome: "applied", observation: "applied_update", duration_ms: 1, surface: "runs", coverage: "owner_result", intent: "recovery", cause: "agent_wait" }).success);
  assert.equal(matchPrimaryAction("POST", "/api/sessions/private/send"), null, "Phase 3 owns conversation delivery");
  assert.equal(matchPrimaryAction("POST", "/api/workflow-runs/private/resubmit"), null, "Phase 4 owns workflow outcomes");
});

test("pending, failure and successful retry share one action across restart, pruning and both audience policies", () => {
  const input = { action: "pipeline.start", feature: "pipelines", context: context(), operationId: "0123456789abcdef", startedAt: Date.now() } as const;
  recordPrimaryAction({ ...input, outcome: "pending" });
  recordPrimaryAction({ ...input, outcome: "pending" });
  recordPrimaryAction({ ...input, outcome: "failed" });
  closeDb(); openDb();
  recordPrimaryAction({ ...input, outcome: "applied" });
  recordPrimaryAction({ ...input, outcome: "applied" });
  runProjectionPass();
  for (const profile of ["local", "user", "product"] as const) {
    assert.deepEqual(events("mission.action.result", profile).map((e) => e.facts.outcome), ["pending", "failed", "applied"]);
    assert.equal(total("mission.action.count", profile), 1);
    assert.equal(total("mission.feature.used", profile), 1);
    assert.equal(total("mission.workflow.interventions", profile), 0);
  }
  openDb().exec("DELETE FROM telemetry_journal");
  recordPrimaryAction({ ...input, outcome: "applied" }); runProjectionPass();
  assert.equal(events("mission.action.result").length, 0);
  assert.equal(total("mission.action.count"), 1);
});

test("owner outcomes distinguish queued acknowledgements, nested schedule refusals and cancelled results", () => {
  assert.equal(primaryOutcome("schedule.run_now", 200, { occurrence: { status: "skipped_overlap" } }), "refused");
  assert.equal(primaryOutcome("schedule.run_now", 200, { occurrence: { status: "created" } }), "applied");
  assert.equal(primaryOutcome("setup.installer_launch", 200, { outcome: "maybe-opening" }), "pending");
  assert.equal(primaryOutcome("foreman.completion_claim", 200, { claimed: false }), "refused");
  assert.equal(primaryOutcome("ensemble.action", 200, { outcome: "cancelled" }), "cancelled");
  assert.equal(primaryOutcome("task.create", 202, { ok: true }), "pending");
  assert.equal(primaryOutcome("task.create", 200, { ok: false }), "refused");
  assert.equal(primaryOutcome("pipeline.retry", 504, { outcomeUnknown: true }), "pending", "a lost provider acknowledgement is not a proven failed launch");
  assert.equal(primaryOutcome("queue.enqueue", 200, { id: "item", state: "pending" }), "applied", "creating an item does not claim it was delivered");
  assert.equal(primaryOutcome("attention.request", 200, { status: "pending" }), "applied");
});

for (const feature of PRIMARY_FEATURES) test(`${feature}: HTTP owner result, refusal, replay and unavailable capture preserve response`, async () => {
  const [method, path] = PRIMARY_ACTION_ROUTES.find((r) => r[3] === feature)!;
  const url = path.replace(/:[A-Za-z]+/g, "subject");
  const app = new Hono(); app.use("*", primaryActionTelemetry());
  let refused = true;
  app.on(method, path, (c) => refused ? c.json({ ok: false }, 409) : c.json({ ok: true }));
  const request = () => app.request(url, { method, headers, body: JSON.stringify({ requestId: "stable-owner-request", private: "PRIVATE_SENTINEL" }) });
  assert.equal((await request()).status, 409);
  refused = false;
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200);
  runProjectionPass();
  assert.equal(total("mission.action.count"), 1);
  assert.equal(events("mission.action.result").length, 2);
  openDb().exec(`CREATE TEMP TRIGGER refuse_capture BEFORE INSERT ON telemetry_journal BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`);
  try {
    const result = await app.request(url, { method, headers: { ...headers, "x-mission-operation-id": "fedcba9876543210" }, body: "{}" });
    assert.equal(result.status, 200);
  } finally { openDb().exec("DROP TRIGGER refuse_capture"); }
  assert.ok(!JSON.stringify(openDb().prepare("SELECT facts_json, refs_json FROM telemetry_journal").all()).includes("PRIVATE_SENTINEL"));
});

test("MCP, Foreman, unknown and conflicting provenance never become human usage", async () => {
  const app = new Hono(); app.use("*", primaryActionTelemetry()); app.post("/api/tasks", async (c) => { await c.req.json(); return c.json({ ok: true }); });
  for (const [surface, actor, by, expected, basis] of [
    ["mcp", "agent", undefined, "agent", "declared"], ["automation", "foreman", "foreman", "foreman", "declared"],
    ["board", "human", "foreman", "unknown", "unknown"], ["unknown", "unknown", undefined, "unknown", "declared"],
  ] as const) {
    await app.request("/api/tasks", { method: "POST", headers: { ...headers, "x-mission-operation-id": crypto.randomUUID().replaceAll("-", ""), "x-mission-operation-surface": surface, "x-mission-operation-actor": actor }, body: JSON.stringify({ by }) });
    const event = events("mission.action.result").at(-1)!;
    assert.equal(event.actor.kind, expected); assert.equal(event.actor.basis, basis);
  }
});

test("one provider failure propagated through a route has one occurrence and a shared action trace", async () => {
  const error = new Error("PRIVATE_SENTINEL /Users/private/file secret prompt");
  const app = new Hono(); app.use("*", primaryActionTelemetry());
  app.post("/api/tasks", () => {
    recordSafeError({ component: "provider", family: "provider", code: "unavailable", retryable: "unknown", handled: true, fingerprint: "unknown", suppressed: 0 }, error);
    throw error;
  });
  app.onError((_error, c) => c.json({ error: "failed" }, 500));
  const result = await app.request("/api/tasks", { method: "POST", headers, body: "{}" });
  assert.equal(result.status, 500); assert.match(result.headers.get("x-mission-error-id")!, /^[a-f0-9]{32}$/);
  assert.equal(events("mission.error.occurrence").length, 1);
  assert.equal(events("mission.action.result")[0]!.refs.__trace_id, events("mission.error.occurrence")[0]!.refs.__trace_id);
  runProjectionPass();
  assert.equal(total("mission.errors"), 1);
  const captured = openDb().prepare("SELECT facts_json, refs_json, actor_json FROM telemetry_journal").all();
  assert.ok(captured.length > 0, "inspect captured facts even before an exporter creates a batch");
  assert.ok(!JSON.stringify(captured).includes("PRIVATE_SENTINEL"));
  assert.equal(operationObservation.getStore(), undefined, "async contexts cannot leak between actions");
  assert.equal(ERROR_SCHEMA.safeParse({ message: "PRIVATE_SENTINEL" }).success, false);
});

test("expected refusal is a domain result, and browser ingress cannot forge an owner error", async () => {
  const app = new Hono(); app.use("*", primaryActionTelemetry()); app.post("/api/tasks", (c) => c.json({ error: "refused" }, 409));
  await app.request("/api/tasks", { method: "POST", headers, body: "{}" });
  assert.equal(events("mission.error.occurrence").length, 0);
  const result = admitBrowserTelemetry([{ event: "mission.error.occurrence", facts: {} }], context());
  assert.equal(result.rejected[0]!.reason, "not_browser_eligible");
  const feature = { event: FEATURE_EVENT.name, facts: { feature: "files", action: "enter" } };
  assert.equal(admitBrowserTelemetry([feature], context()).accepted, 1);
  assert.equal(admitBrowserTelemetry([feature], context()).rejected[0]!.reason, "duplicate");
  assert.equal(admitBrowserTelemetry([{ ...feature, facts: { ...feature.facts, path: "PRIVATE_SENTINEL" } }], context()).rejected[0]!.reason, "invalid_facts");
});

test("owner automation outcomes dedupe across restart without importing external content", () => {
  const facts = { feature: "pipelines", action: "stage", outcome: "applied", coverage: "external_observation" } as const;
  const actor = { kind: "unknown", origin: "external_observation", basis: "unknown" } as const;
  recordAutomationTransition("/Users/PRIVATE_SENTINEL/repo:run:step", facts, actor); closeDb(); openDb(); recordAutomationTransition("/Users/PRIVATE_SENTINEL/repo:run:step", facts, actor);
  runProjectionPass(); assert.equal(total("mission.automation.actions"), 1);
  assert.equal(events("mission.automation.transition")[0]!.actor.kind, "unknown");
  const stored = openDb().prepare("SELECT source_id, refs_json FROM telemetry_journal WHERE name = ?").all("mission.automation.transition");
  assert.ok(stored.length > 0);
  assert.ok(!JSON.stringify(stored).includes("PRIVATE_SENTINEL"), "opaque business identifiers enter the journal before export minimization");
});

test("the manifest is an explicit list, never a prefix catch-all", () => {
  assert.equal(matchPrimaryAction("POST", "/api/tasks/not-real/unknown"), null);
  assert.equal(matchPrimaryAction("POST", "/api/tasks-extra"), null);
  assert.equal(matchPrimaryAction("GET", "/api/tasks"), null);
});

test("every mutating HTTP/MCP operation has exactly one phase owner or explicit exclusion", async () => {
  const { WORKFLOW_ACTION_ROUTES } = await import("../src/shared/workflow-actions.ts");
  const { ACTION_EXCLUSIONS } = await import("../src/shared/telemetry-sources/action-exclusions.ts");
  const canonical = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/:[A-Za-z]+/g, ":id")}`;
  const accounted = [...PRIMARY_ACTION_ROUTES, ...WORKFLOW_ACTION_ROUTES, ...ACTION_EXCLUSIONS].map(([method, path]) => canonical(method, path));
  assert.equal(new Set(accounted).size, accounted.length, "no route may count in two phases");
  const source = readFileSync(new URL("../src/server/routes.ts", import.meta.url), "utf8");
  const routes = [...source.matchAll(/app\.(post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => canonical(m[1]!, m[2]!));
  assert.deepEqual(routes.filter((r) => !accounted.includes(r)), [], "new operations must declare ownership or an exclusion");
  assert.deepEqual(accounted.filter((r) => !routes.includes(r)), [], "the manifest may not claim hooks that do not exist");
});

test("real owners create, configure and complete actions without exporting their private inputs", async () => {
  const { runPrimaryOwnerFixture } = await import("./helpers/primary-telemetry.ts");
  const { execFileSync } = await import("node:child_process");
  const repo = mkdtempSync(join(home, "repo-"));
  execFileSync("git", ["init", "--quiet", repo]);
  await runPrimaryOwnerFixture(repo);
  const actions = events("mission.action.result");
  for (const action of ["attention.resolve", "session.rename", "setup.installer_launch", "task.create", "task.edit", "library.action_create", "file.comment", "queue.enqueue", "foreman.invite", "foreman.withdraw", "settings.appearance", "away.configure", "inspector.configure", "schedule.create", "schedule.run_now"]) {
    assert.ok(actions.some((e) => e.facts.action === action && e.facts.outcome === "applied"), `${action} must observe an applied real owner result`);
  }
  assert.equal(actions.filter((e) => e.facts.action === "task.create").length, 3, "count both distinct HTTP creations and the scheduled task once each");
  assert.equal(actions.filter((e) => e.facts.action === "task.create" && e.actor.kind === "scheduler").length, 1);
  const automation = events("mission.automation.transition");
  assert.ok(automation.some((e) => e.facts.feature === "queues" && e.facts.outcome === "applied"));
  assert.ok(automation.some((e) => e.facts.feature === "schedules" && e.facts.outcome === "applied"));
  runProjectionPass();
  const captured = openDb().prepare("SELECT facts_json, refs_json, actor_json FROM telemetry_journal").all();
  assert.ok(captured.length > 0, "privacy assertions must inspect admitted owner facts");
  assert.ok(!JSON.stringify(captured).includes("PRIVATE_SENTINEL"));
});

test("bootstrap registration is idempotent and a provider observer preserves the original rejection", async () => {
  registerBuiltinTelemetry(); registerBuiltinTelemetry();
  const { observedRunner, LLM_RUNNERS } = await import("../src/server/llm/index.ts");
  const error = new Error("PRIVATE_SENTINEL");
  const runner = observedRunner({ ...LLM_RUNNERS.claude, run: async () => { throw error; } });
  await assert.rejects(runner.run("PRIVATE_SENTINEL"), (caught) => caught === error);
  recordSafeError({ component: "route", family: "execution", code: "unexpected", retryable: "unknown", handled: true, fingerprint: "unknown", suppressed: 0 }, error);
  assert.equal(events("mission.error.occurrence").length, 1);
});

test("declared automation surfaces do not replace the caller's independently known origin", () => {
  for (const surface of ["mcp", "automation"]) {
    const declared = new Headers({ ...headers, "x-mission-operation-surface": surface, "x-mission-operation-actor": "foreman" });
    assert.deepEqual(resolveOperationContext(declared).actor, { kind: "foreman", basis: "declared", origin: "dashboard" });
    assert.equal(resolveOperationContext(declared, "unknown").actor.origin, "unknown");
    assert.equal(resolveOperationContext(declared, "mcp").actor.origin, "mcp");
  }
});

test("capture refusal cannot escape automation owners or nested pending-action settlement", async () => {
  const { runPrimaryOwnerFixture } = await import("./helpers/primary-telemetry.ts");
  const { retainPendingAction, settlePendingAction } = await import("../src/server/telemetry/experience.ts");
  const { execFileSync } = await import("node:child_process");
  const repo = mkdtempSync(join(home, "full-store-repo-"));
  execFileSync("git", ["init", "--quiet", repo]);
  retainPendingAction("commission:1", { action: "pipeline.start", feature: "pipelines", context: context(),
    operationId: "0123456789abcdef", startedAt: Date.now() });
  const limits = TELEMETRY_LIMITS as unknown as { maxTotalBytes: number };
  const original = limits.maxTotalBytes;
  limits.maxTotalBytes = 1;
  try {
    assert.doesNotThrow(() => settlePendingAction("commission:1", "applied"));
    const { queues, sessionId } = await runPrimaryOwnerFixture(repo);
    assert.equal(queues.get(sessionId)!.items[0]!.state, "verified", "queue publication survives capture refusal");
    assert.equal(events("mission.automation.transition").length, 0, "the store really refused automation capture");
    assert.equal(events("mission.action.result").length, 0, "owner responses survived refused primary capture");
  } finally { limits.maxTotalBytes = original; }
  settlePendingAction("commission:1", "applied");
  assert.equal(events("mission.action.result").filter((e) => e.facts.action === "pipeline.start").length, 1,
    "refusal retained the pending observation for later settlement");
});
