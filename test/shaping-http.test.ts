// The task shaping API end to end over HTTP: the three routes, each intent, 404 with the flag
// off, a dry run of a real `command` shaper, stored entries this build does not understand, and
// a reload after a settings restore.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
const { wireShapingConfigEvents } = await import("../src/server/shaping/events.ts");
const { SHAPING_LIMITS, ShapingConfigSchema } = await import("../src/shared/shaping.ts");
const { daemonShapingView } = await import("../src/server/shaping/revisions.ts");
type ShapingFrame = { type: "shaping_config"; config: unknown };

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
  assert.deepEqual(await response.json(), { config: daemonShapingView(SHAPING_CONFIG_DEFAULTS), discovered: [], references: {} });
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
    assert.deepEqual(config.overrides, { "gather-one": true, "select-one": false }, "an upsert stores an explicit off");
    assert.deepEqual(config.order, ["select-one", "gather-one"]);
    assert.deepEqual([config.caller.user, config.limits.deadlineMs], ["declared-user", 20_000]);
    assert.deepEqual(daemonShapingView(getAppConfig(APP_CONFIG_ENTRIES.shaping)!), config, "the reply is the view of what was stored");
    assert.deepEqual(((await (await get()).json()) as { config: unknown }).config, config);
    // Replacing a shaper that is on stores an explicit off, in the reply and in storage.
    const replaced = await put({ kind: "upsert", shaper: fixture("gather-one", "gather", "degraded") });
    assert.equal(replaced.status, 200);
    assert.equal(((await replaced.json()) as { config: typeof SHAPING_CONFIG_DEFAULTS }).config.overrides["gather-one"], false);
    assert.equal((getAppConfig(APP_CONFIG_ENTRIES.shaping) as typeof SHAPING_CONFIG_DEFAULTS).overrides["gather-one"], false);
    assert.equal((await put({ kind: "remove", id: "select-one" })).status, 200);
    assert.deepEqual(shaping.getShapingConfig().order, ["gather-one"]);
    assert.equal(shaping.getShapingConfig().overrides["select-one"], undefined, "remove still clears the choice");
    assert.equal(seen.length, 7);
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

test("a stored row that is not valid JSON is unreadable, never treated as missing", async (t) => {
  t.mock.method(console, "warn", () => {});
  const raw = '{"shapers":[{"id":"kept","label":"Kept"'; // truncated mid-write, as a crash could leave it
  openDb().prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run(APP_CONFIG_ENTRIES.shaping.key, raw);
  shaping.reloadShaping();
  assert.deepEqual(shaping.getShapingConfig(), SHAPING_CONFIG_DEFAULTS, "reads fall back to the defaults");
  const response = await put({ kind: "upsert", shaper: fixture("known", "gather", "ok") });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, "unreadable_config");
  const row = openDb().prepare("SELECT value FROM app_config WHERE key = ?").get(APP_CONFIG_ENTRIES.shaping.key) as { value: string };
  assert.equal(row.value, raw, "the row is left exactly as it was");
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
});

test("an oversized body is refused with 413 after the flag's gate, before it is parsed", async () => {
  const huge = JSON.stringify({ kind: "upsert", shaper: { id: "big", label: "x".repeat(200 * 1024), stage: "gather", transport: { type: "command", command: "/bin/x" } } });
  const putBig = await app.request("/api/shaping", { method: "PUT", headers, body: huge });
  assert.equal(putBig.status, 413);
  const testBig = await app.request("/api/shaping/test", { method: "POST", headers,
    body: JSON.stringify({ id: "x", repository, prompt: "p".repeat(7 * 1024 * 1024) }) });
  assert.equal(testBig.status, 413);
  setFlag(false);
  try {
    assert.equal((await app.request("/api/shaping", { method: "PUT", headers, body: huge })).status, 404, "a disabled route reads no body");
  } finally {
    setFlag(true);
  }
});

test("a working-tree check Git never answered is unknown, never reported as a bare repository", async () => {
  const { insideWorkTree } = await import("../src/server/repos.ts");
  assert.equal(await insideWorkTree(repository), "worktree");
  const bare = join(home, "repos", "bare-check.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  assert.equal(await insideWorkTree(bare), "not-worktree");
  const unanswered = async () => ({ code: null, stdout: "", stderr: "", outcomeUnknown: true, overflowed: false, timedOut: true }) as never;
  assert.equal(await insideWorkTree(repository, unanswered), "unknown", "a timed-out check is not a no");
  const overflowed = async () => ({ code: 0, stdout: "true", stderr: "", outcomeUnknown: false, overflowed: true }) as never;
  assert.equal(await insideWorkTree(repository, overflowed), "unknown");
  const neverStarted = async () => ({ code: null, stdout: "", stderr: "spawn git ENOENT", outcomeUnknown: false, overflowed: false }) as never;
  assert.equal(await insideWorkTree(repository, neverStarted), "unknown", "nor is a check that never started");
  // `run`'s own shape for Git that could not start: a code of 1, with no process behind it.
  const notFound = async () => ({ code: 1, childPid: null, stdout: "", stderr: 'executable "git" was not found', outcomeUnknown: false, overflowed: false }) as never;
  assert.equal(await insideWorkTree(repository, notFound), "unknown", "a code of 1 with no process is not Git saying no");
  // Git that ran and said no is still a no.
  const refused = async () => ({ code: 128, childPid: 4242, stdout: "", stderr: "not a git repository", outcomeUnknown: false, overflowed: false }) as never;
  assert.equal(await insideWorkTree(repository, refused), "not-worktree");
});

test("a repository check Git never answers is 503, never an invalid checkout", async () => {
  const { checkoutFor } = await import("../src/server/shaping/routes.ts");
  const silent = async () => "unknown" as const;
  // Root resolution fails because Git did not answer: a second probe says so.
  const duringRoot = await checkoutFor(repository, { resolveRepoRoot: async () => null, insideWorkTree: silent });
  assert.deepEqual([duringRoot.ok, !duringRoot.ok && duringRoot.status, !duringRoot.ok && duringRoot.error], [false, 503, "repository_check_failed"]);
  // Root resolved, then the working-tree check went unanswered.
  const duringTree = await checkoutFor(repository, { resolveRepoRoot: async () => repository, insideWorkTree: silent });
  assert.deepEqual([duringTree.ok, !duringTree.ok && duringTree.status], [false, 503]);
  // Root resolution failed although Git confirms a working tree: still an unanswered check.
  const confirmedTree = await checkoutFor(repository, { resolveRepoRoot: async () => null, insideWorkTree: async () => "worktree" });
  assert.deepEqual([confirmedTree.ok, !confirmedTree.ok && confirmedTree.status], [false, 503]);
  // Git answered no: still 400, for an ordinary folder and for a bare repository.
  const rejected = await checkoutFor(plainFolder, { resolveRepoRoot: async () => null, insideWorkTree: async () => "not-worktree" });
  assert.deepEqual([!rejected.ok && rejected.status, !rejected.ok && rejected.error], [400, "unknown_repository"]);
  assert.deepEqual(await checkoutFor(repository), { ok: true, repoRoot: realpathSync(repository) }, "the real probes accept the checkout");
});

test("a dry run resolves its path once: the gatherer runs where Git checked, and a dangling link is refused", async () => {
  await put({ kind: "settings", limits: { deadlineMs: 60_000 } });
  await put({ kind: "upsert", shaper: fixture("where", "gather", "echo") });
  const link = join(home, "repos", "billing-api-link");
  rmSync(link, { force: true });
  symlinkSync(repository, link);
  const response = await dryRun({ id: "where", repository: link });
  assert.equal(response.status, 200);
  const run = await response.json() as { entries: Array<{ body: string }> };
  assert.equal((JSON.parse(run.entries[0]!.body) as { cwd: string }).cwd, realpathSync(repository), "the canonical path, not the link");
  const dangling = join(home, "repos", "dangling-link");
  rmSync(dangling, { force: true });
  symlinkSync(join(home, "repos", "gone"), dangling);
  const refused = await dryRun({ id: "where", repository: dangling });
  assert.equal(refused.status, 400, "a path that cannot be resolved stops the dry run");
});

test("a dry run refuses a bare repository and accepts a linked worktree", async () => {
  const bare = join(home, "repos", "bare.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  await put({ kind: "upsert", shaper: fixture("bare-check", "gather", "ok") });
  const refused = await dryRun({ id: "bare-check", repository: bare });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { reason: string }).reason, /bare repository/);
  // A linked worktree of an ordinary checkout is a working tree, and still runs.
  // Independent of the machine's Git config: no signing and no hooks for a fixture commit.
  execFileSync("git", ["-C", repository, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "--allow-empty", "-m", "init"]);
  const linked = join(home, "repos", "billing-api-linked");
  execFileSync("git", ["-C", repository, "worktree", "add", "-q", "--detach", linked]);
  assert.equal((await dryRun({ id: "bare-check", repository: linked })).status, 200);
});

test("a stored JSON null is unreadable, never treated as a missing row", async (t) => {
  t.mock.method(console, "warn", () => {});
  openDb().prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run(APP_CONFIG_ENTRIES.shaping.key, "null");
  shaping.reloadShaping();
  const response = await put({ kind: "upsert", shaper: fixture("known", "gather", "ok") });
  assert.equal(response.status, 409);
  const row = openDb().prepare("SELECT value FROM app_config WHERE key = ?").get(APP_CONFIG_ENTRIES.shaping.key) as { value: string };
  assert.equal(row.value, "null", "the row is left as it was");
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
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
      // Scrubbed from the reply's content before the engine reads it, under the variable's name.
      ["error-leak", "reply-error-leak", "failed", "denied: rejected credential [SHAPER_FIXTURE_SECRET redacted]"],
      ["notes-leak", "reply-notes-leak", "degraded", "fell back after [SHAPER_FIXTURE_SECRET redacted] was refused"],
      ["version-leak", "version-leak", "ok", null],
    ] as const) {
      const shaper = fixture(id, "select", mode);
      await put({ kind: "upsert", shaper: { ...shaper, transport: { ...named.transport, args: [FIXTURE, mode, "SHAPER_FIXTURE_SECRET"] } } });
      const response = await dryRun({ id, repository });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(text.includes("s3cret-passed-value"), false, `${id}: the value appears nowhere in the reply`);
      const run = JSON.parse(text) as { summary: { shapers: Array<{ outcome: string; reason: string; version: string | null; redacted: boolean }> } };
      assert.deepEqual([run.summary.shapers[0]!.outcome, run.summary.shapers[0]!.reason], [outcome, reason]);
      assert.equal(run.summary.shapers[0]!.redacted, true, `${id}: the record says a credential value was removed`);
      if (id === "version-leak") assert.equal(run.summary.shapers[0]!.version, "v2-[SHAPER_FIXTURE_SECRET redacted]", "the recorded version is scrubbed");
    }
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SECRET;
    else process.env.SHAPER_FIXTURE_SECRET = saved;
  }
});

test("a dry run never returns a named credential the shaper echoed in its guidance", async () => {
  const saved = process.env.SHAPER_FIXTURE_SECRET;
  process.env.SHAPER_FIXTURE_SECRET = "s3cret-passed-value";
  try {
    await put({ kind: "settings", limits: { deadlineMs: 60_000 } });
    await put({ kind: "upsert", shaper: { ...fixture("guidance-leak", "gather", "guidance-leak"),
      transport: { type: "command", command: process.execPath, args: [FIXTURE, "guidance-leak", "SHAPER_FIXTURE_SECRET"], env: ["SHAPER_FIXTURE_SECRET"] } } });
    const response = await dryRun({ id: "guidance-leak", repository });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("s3cret-passed-value"), false, "neither entries nor section nor summary carry it");
    const run = JSON.parse(text) as { section: string; entries: Array<{ id: string; body: string }>; summary: { shapers: Array<{ outcome: string; redacted: boolean; reason: string | null }> } };
    assert.deepEqual(run.entries.map((entry) => [entry.id, entry.body]), [["kept", "use [SHAPER_FIXTURE_SECRET redacted] to sign in"]]);
    assert.match(run.section, /use \[SHAPER_FIXTURE_SECRET redacted\] to sign in/);
    assert.deepEqual(run.summary.shapers.map((row) => [row.outcome, row.redacted]), [["ok", true]], "redaction is not degradation");
    assert.match(run.summary.shapers[0]!.reason ?? "",
      /An entry was dropped because its id contained the value of SHAPER_FIXTURE_SECRET\..*A fact was dropped/,
      "and the dry run says what was dropped");
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
  // The exact values the stored entry carried, each checked on its own.
  for (const secret of ["sk-live-grouped-stored", "pw-grouped-stored", "pw-grouped-stored-long"]) {
    assert.equal(snapshot.includes(secret), false, `no snapshot carries ${secret}`);
  }
  assert.equal(snapshot.includes('"stored-grouped"'), true, "the entry itself is kept, marked as stripped");
  setAppConfig(APP_CONFIG_ENTRIES.shaping, SHAPING_CONFIG_DEFAULTS);
  shaping.reloadShaping();
});

test("a well-known token as a positional argument is refused, and a stored one never reaches a snapshot", async () => {
  const token = `ghp_${"z".repeat(36)}`;
  const shaperWith = (id: string, args: string[]) => ({ id, label: "Positional", stage: "gather",
    transport: { type: "command", command: "/usr/local/bin/shaper", args } });
  const refused = await put({ kind: "upsert", shaper: shaperWith("positional", ["billing-api", token]) });
  assert.equal(refused.status, 400);
  assert.equal((await refused.text()).includes(token), false, "the refusal never names the value");
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [shaperWith("stored-positional", ["billing-api", token])] });
  shaping.reloadShaping();
  assert.equal(JSON.stringify(shaping.getShapingConfig()).includes(token), false, "the daemon's config holds no secret");
  const backupStore = new SettingsBackupStore(join(home, "snapshots-positional"));
  const service = new SettingsBackupService(new WorkflowStore(openDb()), backupStore,
    () => new Date("2026-11-25T12:00:00Z"), "test", {
      preflightSkills: () => [], preflightCost: () => {}, reconcileSkills: () => {}, reconcileCost: () => {},
    });
  const saved = await service.ensureDailySnapshot();
  assert.equal(saved.status, "ready");
  const snapshot = JSON.stringify(saved.status === "ready" ? saved.snapshot : null);
  assert.equal(snapshot.includes(token), false, "no snapshot carries the token");
  assert.equal(snapshot.includes('"stored-positional"'), true, "the entry itself is kept, marked as stripped");
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

test("GET and PUT /api/shaping return the config view, never an unsupported entry's raw envelope", async () => {
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [{ id: "future", label: "Future", stage: "route",
    note: "sk-live-envelope-note", transport: { type: "grpc", endpoint: "grpc://sk-live-envelope-endpoint" } }] });
  shaping.reloadShaping();
  const read = await get();
  assert.equal(read.status, 200);
  const text = await read.text();
  assert.equal(text.includes("sk-live-envelope"), false, "the envelope's own values stay in the daemon");
  const body = JSON.parse(text) as { config: { shapers: unknown[] } };
  assert.deepEqual(body.config.shapers, [{ id: "future", label: "Future", unsupported: "stage: This build does not support the stage this entry names." }]);
  const written = await put({ kind: "settings", limits: { timeoutMs: 6_000 } });
  assert.equal(written.status, 200);
  assert.equal((await written.text()).includes("sk-live-envelope"), false, "nor through a write's reply");
  assert.equal(JSON.stringify(getAppConfig(APP_CONFIG_ENTRIES.shaping)).includes("sk-live-envelope-note"), true,
    "the raw envelope is kept in storage, where its backup reads it");
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

// ---------------------------------------------------------------------------------------------
// The `shaping_config` event and the snapshot's `shaping` field, both behind the flag.

/** A daemon's wiring over a fresh Registry, recording every `shaping_config` frame. */
function wired(): { registry: InstanceType<typeof Registry>; frames: ShapingFrame[]; stop: () => void } {
  const registry = new Registry();
  const frames: ShapingFrame[] = [];
  const unsubscribe = registry.subscribe((event) => { if (event.type === "shaping_config") frames.push(event as ShapingFrame); });
  const unwire = wireShapingConfigEvents((config) => registry.emitShapingConfig(config));
  return { registry, frames, stop: () => { unwire(); unsubscribe(); } };
}

test("with the flag off and shapers stored, no snapshot or frame carries the config", async () => {
  assert.equal((await put({ kind: "upsert", shaper: fixture("stored", "gather", "ok") })).status, 200);
  setFlag(false);
  const { registry, frames, stop } = wired();
  try {
    assert.equal("shaping" in registry.snapshot(), false, "the snapshot has no shaping field");
    assert.deepEqual(frames, [{ type: "shaping_config", config: null }], "only the startup clear");
    // A change to the stored config while the flag is off - a settings restore, say - sends nothing.
    setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, caller: { user: "restored" } });
    shaping.reloadShaping();
    assert.equal(shaping.applyShapingIntent({ kind: "settings", caller: { user: "offline" } }).ok, true);
    assert.equal(frames.length, 1, "no frame while the flag is off");
    assert.equal("shaping" in registry.snapshot(), false);
  } finally {
    stop();
  }
});

test("turning the flag on emits the config to open windows, a write emits once, and turning it off clears it", async () => {
  setFlag(false);
  const { registry, frames, stop } = wired();
  try {
    assert.deepEqual(frames, [{ type: "shaping_config", config: null }]);
    setFlag(true);
    assert.deepEqual(frames.at(-1), { type: "shaping_config", config: daemonShapingView(SHAPING_CONFIG_DEFAULTS) });
    assert.deepEqual(registry.snapshot().shaping, daemonShapingView(SHAPING_CONFIG_DEFAULTS), "and the snapshot carries it now");
    const before = frames.length;
    assert.equal((await put({ kind: "upsert", shaper: fixture("live", "gather", "ok") })).status, 200);
    assert.equal(frames.length, before + 1, "one frame per committed write");
    const written = frames.at(-1)!.config as { shapers: Array<{ id: string }>; overrides: Record<string, boolean> };
    assert.deepEqual(written.shapers.map((entry) => entry.id), ["live"]);
    assert.equal(written.overrides.live, false);
    // Another flag's change restates nothing.
    assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "resident-active-hours", enabled: true }).ok, true);
    assert.equal(frames.length, before + 1, "an unrelated flag sends no shaping frame");
    assert.equal(flags.applyFeatureFlagIntent({ kind: "flag", id: "resident-active-hours", enabled: false }).ok, true);
    setFlag(false);
    assert.deepEqual(frames.at(-1), { type: "shaping_config", config: null });
    assert.equal("shaping" in registry.snapshot(), false);
    // The route is closed while the flag is off, so write through the store: no window hears it.
    const count = frames.length;
    assert.equal(shaping.applyShapingIntent({ kind: "settings", caller: { user: "offline" } }).ok, true);
    assert.equal(frames.length, count, "no frame while the flag is off");
    setFlag(true);
    assert.equal((frames.at(-1)!.config as { caller: { user: string } }).caller.user, "offline", "the current config on the way back on");
  } finally {
    stop();
  }
});

test("an import over an id a discovered shaper had switched on is saved off", async () => {
  // A stored on for an id with no registered shaper is what switching a discovered one on leaves.
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, overrides: { "found-on-disk": true } });
  shaping.reloadShaping();
  const { frames, stop } = wired();
  try {
    const saved = await put({ kind: "upsert", shaper: fixture("found-on-disk", "select", "ok") });
    assert.equal(saved.status, 200);
    const body = await saved.json() as { config: { overrides: Record<string, boolean> } };
    assert.equal(body.config.overrides["found-on-disk"], false);
    assert.equal((frames.at(-1)!.config as { overrides: Record<string, boolean> }).overrides["found-on-disk"], false);
    assert.equal((getAppConfig(APP_CONFIG_ENTRIES.shaping) as { overrides: Record<string, boolean> }).overrides["found-on-disk"], false);
  } finally {
    stop();
  }
});

test("an import with a literal token in an authorization header is refused, stores nothing and sends no frame", async () => {
  const { frames, stop } = wired();
  try {
    const before = frames.length;
    const refused = await put({ kind: "upsert", shaper: { id: "leaky", label: "Leaky", stage: "select",
      transport: { type: "http", url: "https://context.example/shape", headers: { authorization: "Bearer sk-live-import-secret" } } } });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /must be a reference such as \{env:NAME\}/);
    assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), SHAPING_CONFIG_DEFAULTS, "nothing stored");
    assert.equal(frames.length, before, "no shaping_config frame");
  } finally {
    stop();
  }
});

test("a stored unsupported entry holding a literal token reaches the snapshot, a frame and the reply only as its id, label and reason", async () => {
  const secret = "sk-live-unsupported-envelope-token";
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [{ id: "future", label: "Future", stage: "route",
    note: secret, transport: { type: "grpc", endpoint: "grpc://" + secret } }] });
  shaping.reloadShaping();
  setFlag(false);
  const { registry, frames, stop } = wired();
  try {
    setFlag(true);
    const view = [{ id: "future", label: "Future", unsupported: "stage: This build does not support the stage this entry names." }];
    const snapshot = registry.snapshot().shaping;
    assert.deepEqual(snapshot?.shapers, view);
    assert.deepEqual((frames.at(-1)!.config as { shapers: unknown[] }).shapers, view);
    const reply = await (await get()).text();
    for (const text of [JSON.stringify(snapshot), JSON.stringify(frames), reply]) {
      assert.equal(text.includes(secret), false, "the envelope's token never leaves the daemon");
    }
  } finally {
    stop();
  }
});

test("the shaping_config frame stays bounded at the stored maximum", () => {
  // Every bound at once: 32 shapers of nearly 16 KiB each, and 128 choices of 64-character ids.
  const longId = (n: number) => "s" + String(n).padStart(63, "0");
  // An argument is at most 4,096 characters, so four of them fill most of an entry's 16 KiB.
  const padding = Array.from({ length: 4 }, () => "x".repeat(3_950));
  const shapers = Array.from({ length: SHAPING_LIMITS.shapers }, (_, n) => ({
    id: longId(n), label: "Bounded", stage: "gather",
    transport: { type: "command", command: "/usr/bin/true", args: padding },
  }));
  const overrides = Object.fromEntries(Array.from({ length: SHAPING_LIMITS.choices }, (_, n) => [longId(n), n % 2 === 0]));
  const order = Array.from({ length: SHAPING_LIMITS.choices }, (_, n) => longId(n));
  const view = daemonShapingView(ShapingConfigSchema.parse({ shapers, overrides, order }));
  assert.equal(view.shapers.length, SHAPING_LIMITS.shapers);
  assert.ok(view.shapers.every((entry) => !("unsupported" in entry)), "every entry is a known shaper at full size");
  const bytes = Buffer.byteLength(JSON.stringify({ type: "shaping_config", config: view }));
  assert.ok(bytes > SHAPING_LIMITS.shapers * 15 * 1024, "the fixture really is at the maximum, " + bytes + " bytes");
  assert.ok(bytes < 560 * 1024, "the frame is " + bytes + " bytes");
});

// ---------------------------------------------------------------------------------------------
// Intents bound to the definition the sender showed, and moves applied to the stored order.

test("enable, remove and a dry run that name a replaced definition answer 409 and change nothing", async () => {
  assert.equal((await put({ kind: "upsert", shaper: fixture("bound", "gather", "ok") })).status, 200);
  // The daemon's revision, as the view carries it: the browser never computes one.
  const revision = ((await (await get()).json()) as { config: { revisions: Record<string, string> } }).config.revisions.bound!;
  // Another window replaces it: same id, a different command line.
  assert.equal((await put({ kind: "upsert", shaper: fixture("bound", "gather", "degraded") })).status, 200);
  const before = getAppConfig(APP_CONFIG_ENTRIES.shaping);
  for (const intent of [
    { kind: "enable", id: "bound", enabled: true, expect: revision },
    { kind: "remove", id: "bound", expect: revision },
  ]) {
    const refused = await put(intent);
    assert.equal(refused.status, 409, intent.kind);
    assert.equal(((await refused.json()) as { error: string }).error, "shaper_changed");
  }
  const run = await dryRun({ id: "bound", repository, expect: revision });
  assert.equal(run.status, 409);
  assert.equal(((await run.json()) as { error: string }).error, "shaper_changed");
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), before, "nothing was stored");
  // The definition actually stored goes through.
  const current = ((await (await get()).json()) as { config: { revisions: Record<string, string> } }).config.revisions.bound!;
  assert.equal((await put({ kind: "enable", id: "bound", enabled: true, expect: current })).status, 200);
});

test("an unsupported entry replaced with a different raw envelope answers 409 to the revision shown before", async () => {
  // Two envelopes this build cannot run: the view shows both only as id, label and reason, so
  // only the daemon's revision over the stored entry can tell them apart.
  const envelope = (endpoint: string) => ({ id: "future", label: "Future shaper", stage: "route",
    transport: { type: "grpc", endpoint } });
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [envelope("grpc://first")] });
  shaping.reloadShaping();
  const read = async () => ((await (await get()).json()) as {
    config: { shapers: unknown[]; revisions: Record<string, string> };
  }).config;
  const shown = await read();
  // Another writer replaces the stored envelope; the projection the browser sees is unchanged.
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [envelope("grpc://second")] });
  shaping.reloadShaping();
  const replaced = await read();
  assert.deepEqual(replaced.shapers, shown.shapers, "the two envelopes project to the same row");
  assert.notEqual(replaced.revisions.future, shown.revisions.future, "the revision is over the stored entry");
  const before = getAppConfig(APP_CONFIG_ENTRIES.shaping);
  const refused = await put({ kind: "remove", id: "future", expect: shown.revisions.future });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { error: string }).error, "shaper_changed");
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), before, "the replacement was not removed");
  assert.equal((await put({ kind: "remove", id: "future", expect: replaced.revisions.future })).status, 200);
});

test("move places a shaper against the stored order, so moves from two windows in different stages both survive", async () => {
  for (const [id, stage] of [["g1", "gather"], ["g2", "gather"], ["s1", "select"], ["s2", "select"]] as const) {
    assert.equal((await put({ kind: "upsert", shaper: fixture(id, stage, "ok") })).status, 200);
  }
  // Each window saw the same order; each moves a shaper in its own stage. Neither sends an order.
  assert.equal((await put({ kind: "move", id: "g2", after: null })).status, 200);
  const second = await put({ kind: "move", id: "s2", after: null });
  assert.equal(second.status, 200);
  assert.deepEqual(((await second.json()) as { config: { order: string[] } }).config.order, ["g2", "g1", "s2", "s1"]);
  // Repeating a move changes nothing.
  assert.deepEqual(((await (await put({ kind: "move", id: "s2", after: null })).json()) as { config: { order: string[] } }).config.order,
    ["g2", "g1", "s2", "s1"]);
  // An anchor in another stage is refused.
  const wrong = await put({ kind: "move", id: "g1", after: "s1" });
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { error: string }).error, "unknown_shaper");
});

test("a replacement written while the dry run resolves its checkout is not what runs", async () => {
  const { Hono } = await import("hono");
  const { registerShapingRoutes } = await import("../src/server/shaping/routes.ts");
  const { resolveRepoRoot, insideWorkTree } = await import("../src/server/repos.ts");
  assert.equal((await put({ kind: "upsert", shaper: fixture("snapshot", "gather", "ok") })).status, 200);
  const revision = ((await (await get()).json()) as { config: { revisions: Record<string, string> } }).config.revisions.snapshot!;
  // While Git is asked about the checkout, another window replaces the shaper with one that
  // answers degraded. The revision check already passed; the engine must run what it checked.
  let replaced = false;
  const routes = new Hono();
  registerShapingRoutes(routes, {
    checkoutProbes: {
      resolveRepoRoot: async (path) => {
        if (!replaced) {
          replaced = true;
          assert.equal(shaping.applyShapingIntent({ kind: "upsert", shaper: fixture("snapshot", "gather", "degraded") as never }).ok, true);
        }
        return resolveRepoRoot(path);
      },
      insideWorkTree,
    },
  });
  const response = await routes.request("/api/shaping/test", {
    method: "POST", headers, body: JSON.stringify({ id: "snapshot", repository, expect: revision }),
  });
  assert.equal(response.status, 200);
  assert.equal(replaced, true, "the replacement landed mid-request");
  const run = await response.json() as { summary: { shapers: Array<{ outcome: string }> }; entries: Array<{ body: string }> };
  assert.equal(run.summary.shapers[0]!.outcome, "ok", "the definition that was checked ran, not the replacement");
  assert.ok(run.entries.every((entry) => entry.body !== "fallback entry"));
  // And the store now holds the replacement, which a fresh dry run with the old revision refuses.
  const again = await dryRun({ id: "snapshot", repository, expect: revision });
  assert.equal(again.status, 409);
});

test("both shaping writes refuse a request a page on another site could send", async () => {
  assert.equal((await put({ kind: "upsert", shaper: fixture("guarded", "gather", "ok") })).status, 200);
  const before = getAppConfig(APP_CONFIG_ENTRIES.shaping);
  const forged: Array<Record<string, string>> = [
    // A simple request: text/plain needs no preflight, and the body is still JSON.
    { "content-type": "text/plain" },
    // A declared JSON body from a page on another origin.
    { "content-type": "application/json", origin: "https://attacker.example" },
    { "content-type": "application/json", origin: "null" },
  ];
  for (const extra of forged) {
    const write = await app.request("/api/shaping", {
      method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify({ kind: "enable", id: "guarded", enabled: true }),
    });
    assert.equal(write.status, 403, JSON.stringify(extra));
    const run = await app.request("/api/shaping/test", {
      method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ id: "guarded", repository }),
    });
    assert.equal(run.status, 403, JSON.stringify(extra));
  }
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), before, "nothing was stored");
  // The dashboard's own origin is allowed.
  const own = await app.request("/api/shaping", {
    method: "PUT", headers: { ...headers, origin: "http://127.0.0.1:7317" }, body: JSON.stringify({ kind: "enable", id: "guarded", enabled: true }),
  });
  assert.equal(own.status, 200);
});

test("a forged shaping write is refused as forbidden whatever its size, before the body limit", async () => {
  // Past both routes' body limits: the dry run's, the larger, is about 6 MiB.
  const huge = JSON.stringify({ kind: "settings", caller: { user: "x".repeat(7 * 1024 * 1024) } });
  for (const [path, method] of [["/api/shaping", "PUT"], ["/api/shaping/test", "POST"]] as const) {
    const forged = await app.request(path, { method, headers: { ...headers, "content-type": "text/plain" }, body: huge });
    assert.equal(forged.status, 403, path);
    const foreign = await app.request(path, { method, headers: { ...headers, origin: "https://attacker.example" }, body: huge });
    assert.equal(foreign.status, 403, path);
    // From the dashboard, the same body still meets the limit.
    const own = await app.request(path, { method, headers, body: huge });
    assert.equal(own.status, 413, path);
  }
});

test("a dashboard from before daemon-held revisions is told to reload, never to retry", async () => {
  assert.equal((await put({ kind: "upsert", shaper: fixture("legacy", "gather", "ok") })).status, 200);
  const { canonicalJson } = await import("../src/shared/shaping.ts");
  // What such a tab sends: its own unkeyed FNV-1a 64 over the entry the view shows, computed here
  // exactly as that dashboard computed it.
  const shown = ((await (await get()).json()) as { config: { shapers: unknown[] } }).config.shapers[0];
  let hash = 0xcbf29ce484222325n;
  for (const char of canonicalJson(shown)) {
    for (let at = 0; at < char.length; at++) {
      hash ^= BigInt(char.charCodeAt(at));
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
  }
  const earlier = hash.toString(16).padStart(16, "0");
  const before = getAppConfig(APP_CONFIG_ENTRIES.shaping);
  for (const answer of [
    await put({ kind: "enable", id: "legacy", enabled: true, expect: earlier }),
    await put({ kind: "remove", id: "legacy", expect: earlier }),
    await dryRun({ id: "legacy", repository, expect: earlier }),
  ]) {
    assert.equal(answer.status, 409);
    const body = (await answer.json()) as { error: string; reason: string };
    assert.equal(body.error, "stale_dashboard");
    assert.match(body.reason, /Reload the page/);
  }
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), before, "nothing was stored");
  // Any revision this daemon never issued gets the same guidance, whatever it is a hash of.
  const other = await put({ kind: "enable", id: "legacy", enabled: true, expect: "0123456789abcdef" });
  assert.equal(((await other.json()) as { error: string }).error, "stale_dashboard");
});

test("a revision this daemon issued is an ordinary conflict once stale, and one it never issued is told to reload", async () => {
  assert.equal((await put({ kind: "upsert", shaper: fixture("issued", "gather", "ok") })).status, 200);
  const { canonicalJson } = await import("../src/shared/shaping.ts");
  const read = async () => ((await (await get()).json()) as { config: { shapers: unknown[]; revisions: Record<string, string> } }).config;
  const before = await read();
  // What a pre-upgrade tab computed for the definition it showed: an unkeyed FNV-1a 64 over it.
  let hash = 0xcbf29ce484222325n;
  const text = canonicalJson(before.shapers[0]);
  for (let at = 0; at < text.length; at++) {
    hash ^= BigInt(text.charCodeAt(at));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const earlierTab = hash.toString(16).padStart(16, "0");
  // Another window replaces the definition, so both revisions now name one that is gone.
  assert.equal((await put({ kind: "upsert", shaper: fixture("issued", "gather", "degraded") })).status, 200);
  const stale = await put({ kind: "enable", id: "issued", enabled: true, expect: before.revisions.issued });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { error: string }).error, "shaper_changed", "this daemon's own revision: review and retry");
  for (const answer of [
    await put({ kind: "enable", id: "issued", enabled: true, expect: earlierTab }),
    await put({ kind: "remove", id: "issued", expect: earlierTab }),
    await dryRun({ id: "issued", repository, expect: earlierTab }),
  ]) {
    assert.equal(answer.status, 409);
    const body = (await answer.json()) as { error: string; reason: string };
    assert.equal(body.error, "stale_dashboard", "a hash of the replaced definition, which this daemon never issued");
    assert.match(body.reason, /Reload the page/);
  }
});

test("an earlier dashboard's revision of a replaceable entry, hashed without the newer field, is told to reload", async () => {
  // A literal credential the store empties, so the entry is unsupported and replaceable.
  const leaked = { ...fixture("leaked", "gather", "ok"), transport: { type: "command", command: process.execPath, args: [FIXTURE, "ok", "ghp_" + "a".repeat(36)] } };
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...SHAPING_CONFIG_DEFAULTS, shapers: [leaked] });
  shaping.reloadShaping();
  const { canonicalJson } = await import("../src/shared/shaping.ts");
  const shown = ((await (await get()).json()) as { config: { shapers: Array<Record<string, unknown>> } }).config.shapers[0]!;
  assert.equal(shown.replaceable, true, "the view now marks it");
  // A tab loaded before that field existed hashed the entry without it.
  const { replaceable: _later, ...before } = shown;
  const fnv = (text: string) => {
    let hash = 0xcbf29ce484222325n;
    for (let at = 0; at < text.length; at++) {
      hash ^= BigInt(text.charCodeAt(at));
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, "0");
  };
  for (const expect of [fnv(canonicalJson(before)), fnv(canonicalJson(shown))]) {
    const answer = await put({ kind: "remove", id: "leaked", expect });
    assert.equal(answer.status, 409);
    assert.equal(((await answer.json()) as { error: string }).error, "stale_dashboard");
  }
});

test("a definition stored again after a replacement never gets its earlier revision back", async () => {
  const read = async () => ((await (await get()).json()) as { config: { revisions: Record<string, string> } }).config.revisions;
  const original = fixture("aba", "gather", "ok");
  assert.equal((await put({ kind: "upsert", shaper: original })).status, 200);
  const first = (await read()).aba!;
  // Replaced, then the original imported again: the same content as when `first` was issued.
  assert.equal((await put({ kind: "upsert", shaper: fixture("aba", "gather", "degraded") })).status, 200);
  assert.equal((await put({ kind: "upsert", shaper: original })).status, 200);
  const again = (await read()).aba!;
  assert.notEqual(again, first, "a new generation, so a write held since the first can never pass");
  const held = await put({ kind: "enable", id: "aba", enabled: true, expect: first });
  assert.equal(held.status, 409);
  assert.equal(((await held.json()) as { error: string }).error, "shaper_changed");
  assert.equal((getAppConfig(APP_CONFIG_ENTRIES.shaping) as typeof SHAPING_CONFIG_DEFAULTS).overrides.aba, false, "it stays off");
  // An identical import with nothing in between starts a new generation too.
  assert.equal((await put({ kind: "upsert", shaper: original })).status, 200);
  assert.notEqual((await read()).aba, again);
  // So does a change by another writer, such as a settings restore, back to the same content.
  const current = (await read()).aba!;
  const stored = getAppConfig(APP_CONFIG_ENTRIES.shaping) as typeof SHAPING_CONFIG_DEFAULTS;
  setAppConfig(APP_CONFIG_ENTRIES.shaping, { ...stored, shapers: [] });
  shaping.reloadShaping();
  setAppConfig(APP_CONFIG_ENTRIES.shaping, stored);
  shaping.reloadShaping();
  assert.notEqual((await read()).aba, current);
  // An enable changes no stored definition, so it keeps the revision.
  const before = (await read()).aba!;
  assert.equal((await put({ kind: "enable", id: "aba", enabled: true, expect: before })).status, 200);
  assert.equal((await read()).aba, before);
});

test("an identical reimport publishes the revision that now names the shaper, and the next action uses it", async () => {
  const read = async () => ((await (await get()).json()) as { config: { revisions: Record<string, string> } }).config.revisions;
  const shaper = fixture("same-again", "gather", "ok");
  assert.equal((await put({ kind: "upsert", shaper })).status, 200);
  const before = (await read())["same-again"]!;
  const { daemonShapingView } = await import("../src/server/shaping/revisions.ts");
  const published: string[] = [];
  const stop = shaping.onShapingConfigChanged((config) => { published.push(daemonShapingView(config).revisions["same-again"]!); });
  try {
    // The same definition, already stored off: nothing stored changes, but its generation does.
    const reply = await put({ kind: "upsert", shaper });
    assert.equal(reply.status, 200);
    const replied = ((await reply.json()) as { config: { revisions: Record<string, string> } }).config.revisions["same-again"]!;
    assert.notEqual(replied, before);
    assert.deepEqual(published, [replied], "every open window is sent the new revision");
  } finally {
    stop();
  }
  // An open tab's next action, with the revision the stream gave it, goes through.
  const current = (await read())["same-again"]!;
  assert.equal((await put({ kind: "enable", id: "same-again", enabled: true, expect: current })).status, 200);
});

test("revision state is kept only for stored ids, and a removed id stored again gets a fresh revision", async () => {
  const { trackedShapingGenerations } = await import("../src/server/shaping/revisions.ts");
  const read = async () => ((await (await get()).json()) as { config: { revisions: Record<string, string> } }).config.revisions;
  assert.equal((await put({ kind: "upsert", shaper: fixture("comes-back", "gather", "ok") })).status, 200);
  const first = (await read())["comes-back"]!;
  // Many distinct ids added and removed: the daemon's state stays the size of what is stored.
  for (let n = 0; n < 40; n++) {
    assert.equal((await put({ kind: "upsert", shaper: fixture(`churn-${n}`, "gather", "ok") })).status, 200);
    assert.equal((await put({ kind: "remove", id: `churn-${n}` })).status, 200);
  }
  const stored = (getAppConfig(APP_CONFIG_ENTRIES.shaping) as typeof SHAPING_CONFIG_DEFAULTS).shapers.length;
  assert.ok(trackedShapingGenerations() <= stored, `${trackedShapingGenerations()} tracked for ${stored} stored`);
  // Removed and stored again, with the same content: never its earlier revision.
  assert.equal((await put({ kind: "remove", id: "comes-back" })).status, 200);
  assert.equal((await put({ kind: "upsert", shaper: fixture("comes-back", "gather", "ok") })).status, 200);
  const again = (await read())["comes-back"]!;
  assert.notEqual(again, first);
  const held = await put({ kind: "enable", id: "comes-back", enabled: true, expect: first });
  assert.equal(((await held.json()) as { error: string }).error, "shaper_changed");
});

test("each published config carries the revisions of its own commit, though a listener writes again", async () => {
  const { daemonShapingView } = await import("../src/server/shaping/revisions.ts");
  const shaper = fixture("queued", "gather", "ok");
  assert.equal((await put({ kind: "upsert", shaper })).status, 200);
  let reimported = false;
  const seen: string[] = [];
  // The first listener imports the same definition again while the first commit is delivered,
  // which advances the id's generation before the second listener runs.
  const stopFirst = shaping.onShapingConfigChanged(() => {
    if (reimported) return;
    reimported = true;
    assert.equal(shaping.applyShapingIntent({ kind: "upsert", shaper: shaper as never }).ok, true);
  });
  const stopSecond = shaping.onShapingConfigChanged((config) => { seen.push(daemonShapingView(config).revisions.queued!); });
  try {
    // An enable keeps the revision, so the first commit's revision is the one it was sent with.
    const committed = ((await (await get()).json()) as { config: { revisions: Record<string, string> } }).config.revisions.queued!;
    const reply = await put({ kind: "enable", id: "queued", enabled: true, expect: committed });
    assert.equal(reply.status, 200);
    const now = ((await (await get()).json()) as { config: { revisions: Record<string, string> } }).config.revisions.queued!;
    // The second listener sees the first commit with that commit's revision, then the reimport's.
    assert.equal(seen.length, 2, JSON.stringify(seen));
    assert.equal(seen[0], committed, "the first config keeps its own revision");
    assert.notEqual(now, committed, "the reimport started a new generation");
    assert.equal(seen[1], now, "and its config carries the new revision");
  } finally {
    stopFirst();
    stopSecond();
  }
});

test("a placement is bound to the revision shown, and a kind this daemon does not know is refused whole", async () => {
  assert.equal((await put({ kind: "upsert", shaper: fixture("place-a", "gather", "ok") })).status, 200);
  assert.equal((await put({ kind: "upsert", shaper: fixture("place-b", "gather", "ok") })).status, 200);
  const read = async () => ((await (await get()).json()) as { config: { revisions: Record<string, string>; order: string[] } }).config;
  const shown = (await read()).revisions["place-b"]!;
  // Without its revision a placement is not even read.
  assert.equal((await put({ kind: "place", id: "place-b", after: null })).status, 400);
  // Once the definition is replaced, the placement is refused and nothing moves.
  assert.equal((await put({ kind: "upsert", shaper: fixture("place-b", "gather", "degraded") })).status, 200);
  const before = getAppConfig(APP_CONFIG_ENTRIES.shaping);
  const stale = await put({ kind: "place", id: "place-b", after: null, expect: shown });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { error: string }).error, "shaper_changed");
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), before);
  // Bound to the current definition, it places it.
  const current = (await read()).revisions["place-b"]!;
  assert.equal((await put({ kind: "place", id: "place-b", after: null, expect: current })).status, 200);
  assert.deepEqual((await read()).order.filter((id) => id.startsWith("place-")).slice(0, 1), ["place-b"]);
  // What an older daemon does with this kind, this one does with any it does not know: it is
  // refused before anything is applied.
  const unknown = await put({ kind: "a-kind-from-a-later-build", id: "place-a" });
  assert.equal(unknown.status, 400);
  assert.deepEqual((await read()).order.filter((id) => id.startsWith("place-")).slice(0, 1), ["place-b"]);
});

test("a write from a window is refused once a later one of its on the same control was applied", async () => {
  const { SHAPING_WRITE_ORDER_HEADER, shapingWriteOrder } = await import("../src/shared/shaping.ts");
  const ordered = (intent: unknown, sequence: number, controls: string[], window = "http-order-window") => app.request("/api/shaping", {
    method: "PUT", headers: { ...headers, [SHAPING_WRITE_ORDER_HEADER]: shapingWriteOrder(window, sequence, controls) }, body: JSON.stringify(intent),
  });
  // The newer save lands first: its earlier one waited, say for discovery, after its window gave up on it.
  assert.equal((await ordered({ kind: "settings", caller: { user: "newer" } }, 2, ["settings"])).status, 200);
  const older = await ordered({ kind: "settings", caller: { user: "older" } }, 1, ["settings"]);
  assert.equal(older.status, 409);
  assert.equal(((await older.json()) as { error: string }).error, "superseded");
  assert.equal((getAppConfig(APP_CONFIG_ENTRIES.shaping) as typeof SHAPING_CONFIG_DEFAULTS).caller.user, "newer", "the newer edit stands");
  // Another window's writes, and writes with no order at all, are not held to this one.
  assert.equal((await ordered({ kind: "settings", caller: { user: "other-window" } }, 1, ["settings"], "another-window")).status, 200);
  assert.equal((await put({ kind: "settings", caller: { user: "unordered" } })).status, 200);
  // An import holds its shaper's row too: an older import never undoes a newer switch on that row.
  const shaper = fixture("ordered-row", "gather", "ok");
  assert.equal((await ordered({ kind: "upsert", shaper }, 3, ["import", "row:ordered-row"])).status, 200);
  assert.equal((await ordered({ kind: "enable", id: "ordered-row", enabled: true }, 5, ["row:ordered-row"])).status, 200);
  const staleImport = await ordered({ kind: "upsert", shaper }, 4, ["import", "row:ordered-row"]);
  assert.equal(((await staleImport.json()) as { error: string }).error, "superseded");
  assert.equal((getAppConfig(APP_CONFIG_ENTRIES.shaping) as typeof SHAPING_CONFIG_DEFAULTS).overrides["ordered-row"], true, "the switch stands");
});

test("a write made against an earlier daemon process is refused, so a restart cannot reorder writes", async () => {
  const { SHAPING_WRITE_ORDER_HEADER, shapingWriteOrder } = await import("../src/shared/shaping.ts");
  const view = ((await (await get()).json()) as { config: { instance?: string } }).config;
  assert.match(view.instance ?? "", /^[0-9a-f-]{36}$/, "the view names this daemon process");
  const write = (instance: string, user: string) => app.request("/api/shaping", {
    method: "PUT", headers: { ...headers, [SHAPING_WRITE_ORDER_HEADER]: shapingWriteOrder("restart-window", 1, ["settings"], instance) },
    body: JSON.stringify({ kind: "settings", caller: { user } }),
  });
  const before = getAppConfig(APP_CONFIG_ENTRIES.shaping);
  const earlier = await write("an-earlier-daemon-process", "from-before-the-restart");
  assert.equal(earlier.status, 409);
  const body = (await earlier.json()) as { error: string; reason: string };
  assert.equal(body.error, "daemon_restarted");
  assert.match(body.reason, /before the daemon restarted/);
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.shaping), before, "nothing was stored");
  assert.equal((await write(view.instance!, "against-this-process")).status, 200);
});
