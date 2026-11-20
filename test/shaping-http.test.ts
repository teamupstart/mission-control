// The task shaping API end to end over HTTP: the three routes, each intent, 404 with the flag
// off, a dry run of a real `command` shaper, stored entries this build does not understand, and
// a reload after a settings restore.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "mission-shaping-http-"));
process.env.MISSION_HOME = home;
const { openDb, closeDb, setAppConfig, getAppConfig } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { SHAPING_CONFIG_DEFAULTS, credentialsWereRemoved } = await import("../src/shared/shaping.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const shaping = await import("../src/server/shaping/index.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { SettingsBackupService } = await import("../src/server/settings-backups/service.ts");
const { SettingsBackupStore } = await import("../src/server/settings-backups/store.ts");
const { createSettingsBackupEnvelope } = await import("../src/server/settings-backups/format.ts");

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-shaper.mjs", import.meta.url));
const repository = join(home, "repos", "billing-api");
mkdirSync(repository, { recursive: true });
// A real checkout: a dry run refuses a directory that is not inside one.
execFileSync("git", ["init", "-q", repository]);
const plainFolder = join(home, "not-a-checkout");
mkdirSync(plainFolder, { recursive: true });
const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });

const app = buildApp({ registry: new Registry(), reviews: new ReviewManager(new Registry()), tasks: new TaskManager(new Registry()), queues: new QueueManager(new Registry()) });
const get = () => app.request("/api/shaping", { headers });
const put = (body: unknown) => app.request("/api/shaping", { method: "PUT", headers, body: JSON.stringify(body) });
const dryRun = (body: unknown) => app.request("/api/shaping/test", { method: "POST", headers, body: JSON.stringify(body) });
// The longest call timeout a shaper may ask for: a busy machine can take seconds just to start
// Node, and a test that means "it answered" must not become one about how fast it answered.
const fixture = (id: string, stage: "gather" | "select", mode: string, extra: Record<string, unknown> = {}) => ({
  id, label: `Fixture ${mode}`, stage, transport: { type: "command", command: process.execPath, args: [FIXTURE, mode] },
  timeoutMs: 30_000, ...extra,
});
const setFlag = (enabled: boolean) => assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "task-shaping", enabled }).ok, true);

beforeEach(() => {
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
  setFlag(true);
});

test("with the flag off all three routes answer 404 and write nothing", async () => {
  setFlag(false);
  const disabled = { error: "This feature is disabled.", feature: "task-shaping" };
  for (const response of [await get(), await put({ kind: "upsert", shaper: fixture("off", "gather", "ok") }),
    await dryRun({ id: "off", repository })]) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), disabled);
  }
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), SHAPING_CONFIG_DEFAULTS);
});

test("GET returns the config and the final reply shape", async () => {
  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { config: SHAPING_CONFIG_DEFAULTS, discovered: [], references: {} });
});

test("each intent persists, notifies and is reflected by GET", async () => {
  const seen: unknown[] = [];
  const off = shaping.onShapingConfigChanged((config) => seen.push(config));
  try {
    assert.equal((await put({ kind: "upsert", shaper: fixture("gather-one", "gather", "ok") })).status, 200);
    assert.equal((await put({ kind: "upsert", shaper: fixture("select-one", "select", "ok") })).status, 200);
    assert.equal((await put({ kind: "enable", id: "gather-one", enabled: true })).status, 200);
    assert.equal((await put({ kind: "reorder", order: ["select-one", "gather-one"] })).status, 200);
    const settings = await put({ kind: "settings", caller: { user: "declared-user" }, limits: { deadlineMs: 20_000 } });
    assert.equal(settings.status, 200);
    const { config } = await settings.json() as { config: typeof SHAPING_CONFIG_DEFAULTS };
    assert.deepEqual(config.shapers.map((entry) => entry.id), ["gather-one", "select-one"]);
    assert.deepEqual(config.overrides, { "gather-one": true });
    assert.deepEqual(config.order, ["select-one", "gather-one"]);
    assert.deepEqual([config.caller.user, config.limits.deadlineMs], ["declared-user", 20_000]);
    assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), config);
    assert.deepEqual(((await (await get()).json()) as { config: unknown }).config, config);
    assert.equal((await put({ kind: "remove", id: "select-one" })).status, 200);
    assert.deepEqual(shaping.getShapingConfig().order, ["gather-one"]);
    assert.equal(seen.length, 6);
  } finally { off(); }
});

test("refused intents answer 400 with a reason and change nothing", async () => {
  await put({ kind: "upsert", shaper: fixture("known", "gather", "ok") });
  const before = shaping.getShapingConfig();
  for (const [body, error] of [
    [{ kind: "enable", id: "ghost", enabled: true }, "unknown_shaper"],
    [{ kind: "remove", id: "ghost" }, "unknown_shaper"],
  ] as const) {
    const response = await put(body);
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, error);
  }
  for (const body of [{}, { kind: "upsert", shaper: { ...fixture("x", "gather", "ok"), stage: "route" } },
    { kind: "upsert", shaper: { ...fixture("x", "gather", "ok"), transport: { type: "command", command: "sh -c x" } } },
    { kind: "settings", limits: { totalBytes: 1_000_000 } }]) {
    assert.equal((await put(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(shaping.getShapingConfig(), before);
});

test("an entry this build does not understand survives writes, is never enabled, and cannot be dry-run", async () => {
  const future = { id: "skill-router", label: "Router", stage: "route", transport: { type: "grpc", endpoint: "dns:///r" }, extra: [1] };
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [future] });
  shaping.reloadShaping();
  assert.equal((await put({ kind: "upsert", shaper: fixture("known", "gather", "ok") })).status, 200);
  const enabled = await put({ kind: "enable", id: "skill-router", enabled: true });
  assert.equal(enabled.status, 400);
  assert.equal(((await enabled.json()) as { error: string }).error, "unsupported_shaper");
  assert.equal((await put({ kind: "enable", id: "skill-router", enabled: false })).status, 200);
  assert.deepEqual((getAppConfig(APP_CONFIG_ENTRIES.shaping) as typeof SHAPING_CONFIG_DEFAULTS).shapers[0], future);
  const test = await dryRun({ id: "skill-router", repository });
  assert.equal(test.status, 400);
  assert.equal(((await test.json()) as { error: string }).error, "unsupported_shaper");
});

test("a deeply nested stored entry takes the unreadable path instead of throwing", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  // The row as a corrupt or foreign store would hold it: raw JSON, about 14 KiB, 7,000 levels deep.
  const note = `${"[".repeat(7_000)}"leaf"${"]".repeat(7_000)}`;
  openDb().prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run(APP_CONFIG_ENTRIES.shaping.key,
    `{"shapers":[{"id":"deep","label":"Deep","stage":"route","transport":{"type":"grpc"},"note":${note}}]}`);
  assert.doesNotThrow(() => shaping.reloadShaping());
  assert.deepEqual(shaping.getShapingConfig(), SHAPING_CONFIG_DEFAULTS, "reads fall back to the defaults");
  const response = await put({ kind: "upsert", shaper: fixture("known", "gather", "ok") });
  assert.equal(response.status, 409, "and writes are refused rather than overwriting it");
  assert.equal(warnings.length >= 1, true);
});

test("a stored config this build cannot read is never overwritten", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, limits: { deadlineMs: 600_000 } });
  shaping.reloadShaping();
  const response = await put({ kind: "upsert", shaper: fixture("known", "gather", "ok") });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, "unreadable_config");
  assert.equal((getAppConfig(APP_CONFIG_ENTRIES.shaping) as { limits: { deadlineMs: number } }).limits.deadlineMs, 600_000);
  assert.equal(warnings.length, 1, "the unreadable value is reported once");
});

test("a dry run calls a registered command shaper at both stages, switched off as it is stored", async () => {
  await put({ kind: "settings", limits: { deadlineMs: 60_000 } });
  await put({ kind: "upsert", shaper: fixture("gatherer", "gather", "ok") });
  await put({ kind: "upsert", shaper: fixture("selector", "select", "ok") });
  for (const [id, stage] of [["gatherer", "gather"], ["selector", "select"]] as const) {
    const response = await dryRun({ id, repository, prompt: "Retry failed charges" });
    assert.equal(response.status, 200);
    const run = await response.json() as { summary: { state: string; shapers: Array<{ id: string; outcome: string; origin: string; sha256: string; version: string }> }; section: string; entries: Array<{ id: string; body: string }> };
    assert.equal(run.summary.state, "ok");
    assert.deepEqual(run.summary.shapers.map((entry) => [entry.id, entry.outcome, entry.origin, entry.version]), [[id, "ok", "registered", "v1.4.0"]]);
    assert.match(run.summary.shapers[0]!.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(run.entries.map((entry) => [entry.id, entry.body]), [[`${stage}/one`, "first entry for billing-api"]]);
    assert.match(run.section, /^## Task context\n/);
    assert.match(run.section, /### Fixture ok: One\nfirst entry for billing-api$/);
  }
});

test("a slow, failing or malformed shaper is an outcome in a 200, never an error reply", async () => {
  await put({ kind: "settings", limits: { deadlineMs: 60_000 } });
  await put({ kind: "upsert", shaper: fixture("slow", "select", "slow", { timeoutMs: 300 }) });
  await put({ kind: "upsert", shaper: fixture("failing", "select", "fail") });
  await put({ kind: "upsert", shaper: fixture("garbage", "select", "garbage") });
  await put({ kind: "upsert", shaper: fixture("degraded", "select", "degraded") });
  const expected: Record<string, string> = { slow: "timed_out", failing: "failed", garbage: "invalid", degraded: "degraded" };
  for (const [id, outcome] of Object.entries(expected)) {
    const response = await dryRun({ id, repository });
    assert.equal(response.status, 200, id);
    const run = await response.json() as { summary: { state: string; shapers: Array<{ outcome: string; reason: string | null }> } };
    assert.equal(run.summary.state, "degraded");
    assert.equal(run.summary.shapers[0]!.outcome, outcome, id);
    assert.ok(run.summary.shapers[0]!.reason, `${id} says why`);
  }
});

test("a client that disconnects from a dry run stops the shaper's process group", { timeout: 60_000 }, async () => {
  await put({ kind: "settings", limits: { deadlineMs: 60_000 } });
  const pidFile = join(home, "disconnect-grandchild.pid");
  rmSync(pidFile, { force: true });
  // A gatherer whose descendant sleeps for a minute: only a cancellation ends it in time.
  await put({ kind: "upsert", shaper: { ...fixture("hangs", "gather", "grandchild"),
    transport: { type: "command", command: process.execPath, args: [FIXTURE, "grandchild", pidFile] } } });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const body = JSON.stringify({ id: "hangs", repository });
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/api/shaping/test", method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(body) } });
    client.on("error", () => { /* The test closes it. */ });
    client.end(body);
    const started = Date.now();
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "") {
      assert.ok(Date.now() - started < 30_000, "the shaper started");
      await sleep(25);
    }
    const pid = Number(readFileSync(pidFile, "utf8"));
    client.destroy();
    let alive = true;
    const left = Date.now();
    while (alive && Date.now() - left < 10_000) {
      try { process.kill(pid, 0); await sleep(25); } catch { alive = false; }
    }
    assert.equal(alive, false, "the descendant is gone well before the 30 s call timeout");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a structured error, a degraded note or a version that repeats a passed value is redacted in the dry run", async () => {
  const saved = process.env.SHAPER_FIXTURE_SECRET;
  process.env.SHAPER_FIXTURE_SECRET = "s3cret-passed-value";
  try {
    await put({ kind: "settings", limits: { deadlineMs: 60_000 } });
    const named = { transport: { type: "command", command: process.execPath, env: ["SHAPER_FIXTURE_SECRET"] } };
    for (const [id, mode, outcome, reason] of [
      ["error-leak", "reply-error-leak", "failed", "denied: rejected credential [redacted]"],
      ["notes-leak", "reply-notes-leak", "degraded", "fell back after [redacted] was refused"],
      ["version-leak", "version-leak", "ok", null],
    ] as const) {
      const shaper = fixture(id, "select", mode);
      await put({ kind: "upsert", shaper: { ...shaper, transport: { ...named.transport, args: [FIXTURE, mode, "SHAPER_FIXTURE_SECRET"] } } });
      const response = await dryRun({ id, repository });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(text.includes("s3cret-passed-value"), false, `${id}: the value appears nowhere in the reply`);
      const run = JSON.parse(text) as { summary: { shapers: Array<{ outcome: string; reason: string; version: string | null }> } };
      assert.deepEqual([run.summary.shapers[0]!.outcome, run.summary.shapers[0]!.reason], [outcome, reason]);
      if (id === "version-leak") assert.equal(run.summary.shapers[0]!.version, "v2-[redacted]", "the recorded version is scrubbed");
    }
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SECRET;
    else process.env.SHAPER_FIXTURE_SECRET = saved;
  }
});

test("a dry run refuses an unknown shaper, a missing repository and a malformed request", async () => {
  assert.equal((await dryRun({ id: "ghost", repository })).status, 404);
  await put({ kind: "upsert", shaper: fixture("known", "gather", "ok") });
  assert.equal((await dryRun({ id: "known", repository: join(home, "missing") })).status, 400);
  // An ordinary folder is not run against: a mistyped path must not report a successful run.
  const plain = await dryRun({ id: "known", repository: plainFolder });
  assert.equal(plain.status, 400);
  assert.deepEqual(await plain.json(), { error: "unknown_repository", reason: "The path is not inside a Git checkout." });
  assert.equal((await dryRun({ id: "known", repository: "relative/path" })).status, 400);
  assert.equal((await dryRun({})).status, 400);
});

test("a literal credential is refused, so a settings snapshot holds only the reference", async () => {
  const remote = (authorization: string) => ({ kind: "upsert", shaper: { id: "remote", label: "Remote", stage: "select",
    transport: { type: "http", url: "https://context.example/shape", headers: { authorization } } } });
  const refused = await put(remote("Bearer sk-live-literal-secret"));
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /must be a reference such as \{env:NAME\}/);
  assert.equal((await put(remote("sk-live-lone-word "))).status, 400, "a lone word with trailing whitespace is a secret, not a scheme");
  assert.equal((await put(remote("sk-live-prefix {env:ACME_CONTEXT_TOKEN}"))).status, 400, "nor is a token-shaped prefix before a reference");
  assert.equal((await put(remote("Bearer {env:ACME_CONTEXT_TOKEN}"))).status, 200);
  const backupStore = new SettingsBackupStore(join(home, "snapshots-credentials"));
  const service = new SettingsBackupService(new WorkflowStore(openDb()), backupStore,
    () => new Date("2026-11-21T12:00:00Z"), "test", {
      preflightSkills: () => [], preflightCost: () => {}, reconcileSkills: () => {}, reconcileCost: () => {},
    });
  const saved = await service.ensureDailySnapshot();
  assert.equal(saved.status, "ready");
  const snapshot = JSON.stringify(saved.status === "ready" ? saved.snapshot : null);
  assert.equal(snapshot.includes("sk-live-literal-secret"), false, "the refused secret reached no snapshot");
  assert.equal(snapshot.includes("{env:ACME_CONTEXT_TOKEN}"), true, "the shaping domain carries the reference");
});

test("an entry stored by another path cannot carry a literal credential into a snapshot", async () => {
  // Written straight into app_config, as a restore or a newer build would, past the API's check.
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [{
    id: "future", label: "Future", stage: "route",
    transport: { type: "grpc", url: "https://user:pw-literal@context.example/x",
      headers: { authorization: "Bearer sk-live-bypass", "x-api-key": "sk-live-trailing ", "x-auth-token": "sk-live-prefix {env:X}" } },
  }] });
  shaping.reloadShaping();
  const held = JSON.stringify(shaping.getShapingConfig());
  assert.equal(held.includes("sk-live-bypass") || held.includes("pw-literal") || held.includes("sk-live-trailing") || held.includes("sk-live-prefix"), false,
    "the daemon's config holds no secret, a lone word with trailing whitespace included");
  const backupStore = new SettingsBackupStore(join(home, "snapshots-bypass"));
  const service = new SettingsBackupService(new WorkflowStore(openDb()), backupStore,
    () => new Date("2026-11-22T12:00:00Z"), "test", {
      preflightSkills: () => [], preflightCost: () => {}, reconcileSkills: () => {}, reconcileCost: () => {},
    });
  const saved = await service.ensureDailySnapshot();
  assert.equal(saved.status, "ready");
  const snapshot = JSON.stringify(saved.status === "ready" ? saved.snapshot : null);
  assert.equal(snapshot.includes("sk-live-bypass") || snapshot.includes("pw-literal") || snapshot.includes("sk-live-trailing") || snapshot.includes("sk-live-prefix"), false, "nor does the snapshot");
  assert.equal(snapshot.includes('"future"'), true, "the unsupported entry itself is still kept");
  // A snapshot that itself carries a literal credential, as a hand-edited or foreign one could,
  // is restored as the parsed value: the row the restore writes holds no secret either.
  assert.equal(saved.status, "ready");
  if (saved.status !== "ready") return;
  const { digest: _digest, ...body } = saved.snapshot;
  const crafted = createSettingsBackupEnvelope({ ...body, id: "daily-2026-11-21", localDate: "2026-11-21",
    domains: body.domains.map((domain) => domain.domain !== "shaping" ? domain : { ...domain, payload: {
      ...SHAPING_CONFIG_DEFAULTS, shapers: [{ id: "future", label: "Future", stage: "route",
        transport: { type: "grpc", headers: { authorization: "Bearer sk-live-in-snapshot", "x-api-key": "sk-live-restore-trailing " } } }],
    } }) });
  backupStore.write(crafted);
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
  assert.equal((await service.restore(crafted.id, crafted.digest)).status, "restored");
  const row = JSON.stringify(getAppConfig(APP_CONFIG_ENTRIES.shaping));
  assert.equal(row.includes("sk-live-in-snapshot") || row.includes("sk-live-restore-trailing"), false, "the restored row holds no secret");
  assert.equal(row.includes('"future"'), true, "the entry itself is restored");
  assert.equal(JSON.stringify(shaping.getShapingConfig()).includes("sk-live-in-snapshot"), false);
});

test("a JSON body that carries a credential is refused, and a stored one never reaches a snapshot", async () => {
  const curl = (args: string[]) => ({ kind: "upsert", shaper: { id: "json-body", label: "JSON body", stage: "gather",
    transport: { type: "command", command: "/usr/bin/curl", args: ["-s", ...args, "https://context.example/shape"] } } });
  for (const args of [["--json", '{"api_key":"sk-live-json-1"}'], ["-d", '{"auth":{"password":"pw-json-2"}}'], ["--data-raw={\"token\":\"sk-live-json-3\"}"],
    ["--json", '{"token":"sk-live-json-dup","token":""}']]) {
    const refused = await put(curl(args));
    assert.equal(refused.status, 400, args.join(" "));
    assert.match(await refused.text(), /Name the variable in env instead/);
  }
  assert.equal((await put(curl(["--json", '{"query":"billing"}']))).status, 200, "a body without a credential is fine");
  // Stored past the API's check, as a restore or another build could: read back without it.
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [{ id: "stored-json", label: "Stored", stage: "gather",
    transport: { type: "command", command: "/usr/bin/curl", args: ["--json", '{"auth":{"password":"pw-json-stored"}}', "--data", '{"token":"pw-json-stored-dup","token":""}', "https://context.example/x"] } }] });
  shaping.reloadShaping();
  assert.equal(JSON.stringify(shaping.getShapingConfig()).includes("pw-json-stored"), false, "the daemon's config holds no secret");
  const backupStore = new SettingsBackupStore(join(home, "snapshots-json-body"));
  const service = new SettingsBackupService(new WorkflowStore(openDb()), backupStore,
    () => new Date("2026-11-23T12:00:00Z"), "test", {
      preflightSkills: () => [], preflightCost: () => {}, reconcileSkills: () => {}, reconcileCost: () => {},
    });
  const saved = await service.ensureDailySnapshot();
  assert.equal(saved.status, "ready");
  const snapshot = JSON.stringify(saved.status === "ready" ? saved.snapshot : null);
  assert.equal(snapshot.includes("pw-json-stored") || snapshot.includes("sk-live-json"), false, "no snapshot carries the body's secret");
  assert.equal(snapshot.includes('"stored-json"'), true, "the entry itself is kept, marked as stripped");
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
});

test("a curl credential grouped after a switch, or dash-led after a long option, is refused, and a stored one never reaches a snapshot", async () => {
  const curl = (args: string[]) => ({ kind: "upsert", shaper: { id: "grouped", label: "Grouped", stage: "gather",
    transport: { type: "command", command: "/usr/bin/curl", args: [...args, "https://context.example/shape"] } } });
  for (const args of [["-sH", "Authorization: Bearer sk-live-grouped-1"], ["-svuname:pw-grouped-2"], ["-sSLd", "token=sk-live-grouped-3"],
    ["--user", "-name:pw-grouped-4"], ["--header", "-X-Api-Key: sk-live-grouped-5"]]) {
    const refused = await put(curl(args));
    assert.equal(refused.status, 400, args.join(" "));
    assert.match(await refused.text(), /Name the variable in env instead/);
  }
  assert.equal((await put(curl(["-sSL"]))).status, 200, "switches alone are fine");
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [{ id: "stored-grouped", label: "Stored", stage: "gather",
    transport: { type: "command", command: "/usr/bin/curl", args: ["-sH", "Authorization: Bearer sk-live-grouped-stored", "-svuname:pw-grouped-stored", "--user", "-dash:pw-grouped-stored-long", "https://context.example/x"] } }] });
  shaping.reloadShaping();
  const held = JSON.stringify(shaping.getShapingConfig());
  assert.equal(held.includes("sk-live-grouped-stored") || held.includes("pw-grouped-stored"), false, "the daemon's config holds no secret");
  const backupStore = new SettingsBackupStore(join(home, "snapshots-grouped"));
  const service = new SettingsBackupService(new WorkflowStore(openDb()), backupStore,
    () => new Date("2026-11-24T12:00:00Z"), "test", {
      preflightSkills: () => [], preflightCost: () => {}, reconcileSkills: () => {}, reconcileCost: () => {},
    });
  const saved = await service.ensureDailySnapshot();
  assert.equal(saved.status, "ready");
  const snapshot = JSON.stringify(saved.status === "ready" ? saved.snapshot : null);
  assert.equal(snapshot.includes("grouped-stored") || snapshot.includes("sk-live-grouped"), false, "no snapshot carries the grouped credential");
  assert.equal(snapshot.includes('"stored-grouped"'), true, "the entry itself is kept, marked as stripped");
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
});

test("a stored entry at the size limit stays within it once a credential is stripped, and the config still saves", async () => {
  const limit = 16 * 1024;
  const entry = (padding: string) => ({ id: "at-limit", label: "At limit", stage: "select",
    transport: { type: "http", url: "https://context.example/shape", headers: { authorization: "Bearer sk-live-at-limit" } },
    notes: padding });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const atLimit = entry("x".repeat(limit - bytes(entry(""))));
  assert.equal(bytes(atLimit), limit, "the fixture sits exactly at the limit");
  // Stored past the API, as a restore or another build could: valid, and exactly 16 KiB.
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [atLimit] });
  shaping.reloadShaping();
  const read = await get();
  assert.equal(read.status, 200);
  assert.equal((await read.text()).includes("sk-live-at-limit"), false, "the credential is gone from the read");
  // A change that keeps the entry reparses it: it must save, not answer 500.
  const saved = await put({ kind: "settings", limits: { timeoutMs: 7_000 } });
  assert.equal(saved.status, 200, await saved.text());
  const held = shaping.getShapingConfig().shapers.find((stored) => stored.id === "at-limit")!;
  assert.ok(bytes(held) <= limit, `the stripped entry is ${bytes(held)} bytes`);
  assert.equal(credentialsWereRemoved(held), true, "and marked, so it stays unsupported");
  const row = getAppConfig(APP_CONFIG_ENTRIES.shaping) as { shapers: unknown[] };
  assert.equal(row.shapers.length, 1, "the entry is kept");
  assert.ok(bytes(row.shapers[0]) <= limit);
  assert.equal(JSON.stringify(row).includes("sk-live-at-limit"), false);
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
});

test("a settings restore reloads the shaping config; a backup without the domain leaves it alone", async () => {
  await put({ kind: "upsert", shaper: fixture("kept", "gather", "ok") });
  const backupStore = new SettingsBackupStore(join(home, "snapshots"));
  const service = new SettingsBackupService(new WorkflowStore(openDb()), backupStore,
    () => new Date("2026-11-19T12:00:00Z"), "test", {
      preflightSkills: () => [], preflightCost: () => {}, reconcileSkills: () => {}, reconcileCost: () => {},
    });
  const saved = await service.ensureDailySnapshot();
  assert.equal(saved.status, "ready");
  await put({ kind: "remove", id: "kept" });
  let notified = 0;
  const off = shaping.onShapingConfigChanged(() => { notified++; });
  try {
    const restored = await service.restore(saved.snapshot.id, saved.snapshot.digest);
    assert.equal(restored.status, "restored");
    if (restored.status === "restored") assert.deepEqual(restored.warnings, []);
    assert.deepEqual(shaping.getShapingConfig().shapers.map((entry) => entry.id), ["kept"]);
    assert.equal(notified, 1);
    const { digest: _digest, ...body } = saved.snapshot;
    const legacy = createSettingsBackupEnvelope({ ...body, id: "daily-2026-11-18", localDate: "2026-11-18",
      domains: body.domains.filter((domain) => domain.domain !== "shaping") });
    backupStore.write(legacy);
    await put({ kind: "upsert", shaper: fixture("newer", "gather", "ok") });
    assert.equal((await service.restore(legacy.id, legacy.digest)).status, "restored");
    assert.deepEqual(shaping.getShapingConfig().shapers.map((entry) => entry.id), ["kept", "newer"]);
  } finally { off(); }
});
