import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { SESSION_SETTINGS_FLAG_ID } from "../src/shared/feature-flag-registry.ts";
import type { SettingsErrorCode, SettingsRequest, SettingsResult } from "../src/shared/settings-mcp.ts";
import { settingsFailure } from "../src/shared/settings-mcp.ts";
import { SKINS } from "../src/shared/skins.ts";
import type { PiApi, PiContext, PiTool } from "../src/pi/api.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-mcp-settings-"));
process.env.MISSION_HOME = home;
let handleRequest: (request: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
const server = serve({ hostname: "127.0.0.1", port: 0, fetch: request => handleRequest(request) });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
process.env.MISSION_PORT = String(address.port);
after(() => rmSync(home, { force: true, recursive: true }));
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { sessionScoutCredentialDirectory, sessionScoutCredentialPath } = await import("../src/shared/harness-runtime.mjs");
after(() => {
  rmSync(sessionScoutCredentialDirectory(), { force: true, recursive: true });
  server.close();
});
const { managedMissionExtension } = await import("../src/pi/extension.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { getAppConfig, openDb, setAppConfig } = await import("../src/server/db.ts");
const { DatabaseBackupService } = await import("../src/server/database-backups/service.ts");
const { getDatabaseBackupsConfig } = await import("../src/server/database-backups/config.ts");
const { getWorktreesConfig, setWorktreesConfig, resolveWorktreePolicy } = await import("../src/server/worktrees/config.ts");
const { applyFeatureFlagIntent, featureEnabled, getFeatureFlagsConfig, onFeatureFlagsChanged, reloadFeatureFlags } = await import("../src/server/feature-flags/index.ts");
const { maintainScoutSessionCredentials } = await import("../src/server/scouts/session-credentials.ts");
const { sessionScoutCredentialLocator } = await import("../src/server/scouts/submission-auth.ts");
const { onUiSkinChanged, getUiConfig } = await import("../src/server/ui-config.ts");
const {
  SETTINGS_CONFIG_BACKUP_ENTRIES, captureSettingsConfig, restoreSettingsConfigInTransaction, stageSettingsConfigRestore,
} = await import("../src/server/settings-backups/config-registry.ts");
const { bindTypedSettings, field, choices } = await import("../src/server/typed-settings.ts");
const { scalarIntent } = await import("../src/server/session-settings-specialized.ts");
const { registerSessionSettingsRoutes } = await import("../src/server/session-settings.ts");
const { getShapingConfig } = await import("../src/server/shaping/index.ts");
const { getVoiceConfig } = await import("../src/server/voice/config.ts");
const { getTaskSourcesConfig } = await import("../src/server/task-sources/config.ts");
const { dispatchSetting } = await import("../src/server/settings-dispatcher.ts");
const { MISSION_MCP_TOOLS } = await import("../src/server/mission-mcp.ts");
type SettingDescriptor = import("../src/server/settings-dispatcher.ts").SettingDescriptor;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

const find = { operation: "find", query: "theme" } as const;
const get = { operation: "get", key: "ui.skin" } as const;
const set = { operation: "set", key: "ui.skin", value: "daylight" } as const;

test("registered SDK and terminal callers use one real stdio tool and lose live access immediately", async (t) => {
  const registry = new Registry();
  t.after(maintainScoutSessionCredentials(registry));
  let changes = 0;
  t.after(onUiSkinChanged(() => changes++));
  const clicks = new Map<string, boolean>();
  const databaseBackups = new DatabaseBackupService(openDb(), { root: join(home, "database-backups") });
  const app = buildApp({
    registry, tasks: new TaskManager(registry), reviews: {} as ReviewManager, queues: {} as QueueManager,
    databaseBackups,
    worktreeOperations: { setConfig: setWorktreesConfig } as import("../src/server/worktrees/operations.ts").WorktreeOperationsService,
    authorizeSessionSettings: async ({ requestId, enabled }) => {
      const armed = clicks.get(requestId);
      clicks.delete(requestId);
      return armed === enabled;
    },
  });
  const accessChanges: boolean[] = [];
  t.after(registry.subscribe(event => {
    if (event.type === "session_settings_access_changed") {
      accessChanges.push(getAppConfig(APP_CONFIG_ENTRIES.sessionSettingsAccess) === true);
    }
  }));
  handleRequest = app.fetch;
  const sdk = registry.registerSdkSession({
    id: "sdk:settings", agent: "claude", name: "Theme", cwd: home, agentSessionId: "claude-settings",
  });
  const terminal = {
    syntheticId: "proc:settings", agent: "codex", pid: process.pid, tty: "ttys650", name: "Theme", nameSource: "process",
    cwd: home, gitBranch: null, gitRoot: null, repoRoot: null, startedAt: 1,
    terminals: [mkMuxHandle({ session: "settings", windowName: "settings", windowIndex: 0, paneId: "%650" })],
  } as const;
  registry.applyDiscovery([{ ...terminal, terminals: [...terminal.terminals] }]);
  registry.applyHook({
    agent: "codex", event: "UserPromptSubmit", sessionId: "codex-settings",
    cwd: home, transcriptPath: null, prompt: "What theme is in use?", env: { tmuxPane: "%650" },
  });
  const pi = registry.registerSdkSession({
    id: "sdk:settings-pi", agent: "pi", name: "Theme", cwd: home, agentSessionId: "pi-settings",
  });
  const credential = (id: string) => readFileSync(
    sessionScoutCredentialPath(`session:${sessionScoutCredentialLocator(id)}`), "utf8",
  ).trim();
  const headers = { host: "127.0.0.1", "content-type": "application/json" };
  const mcp = (body: unknown, auth: Record<string, string> = {}) =>
    app.request("/mcp/settings", { method: "POST", headers: { ...headers, ...auth }, body: JSON.stringify(body) });
  const setAccess = (enabled: boolean, requestId?: string, auth: Record<string, string> = {}) => app.request("/api/session-settings-access", {
    method: "PUT", headers: { ...headers, ...auth }, body: JSON.stringify({ enabled, requestId }),
  });
  function operatorClick(enabled: boolean) {
    const requestId = randomUUID();
    clicks.set(requestId, enabled);
    return requestId;
  }
  const token = ensureToken();
  const valid = { "x-harness-token": token, "x-mission-scout-credential": credential(sdk.id) };

  assert.equal((await mcp(get)).status, 401);
  assert.equal((await mcp(get, { "x-harness-token": token, "x-mission-scout-credential": "forged" })).status, 403);
  assert.equal((await mcp({ ...get, sessionId: sdk.id }, { "x-harness-token": token })).status, 403);
  const inactive = await mcp(get, valid);
  assert.equal(inactive.status, 403, "the preview starts off on a fresh profile");
  assert.deepEqual(await inactive.json(), settingsFailure("access_disabled"));
  setAppConfig(APP_CONFIG_ENTRIES.ui, { layout: "console" } as never);
  setAppConfig(APP_CONFIG_ENTRIES.featureFlags, { enableAll: true, overrides: {} });
  reloadFeatureFlags();
  assert.equal(featureEnabled(SESSION_SETTINGS_FLAG_ID), true, "the saved master switch enables the new preview");
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.sessionSettingsAccess), undefined, "the old profile has no Trust choice");
  for (const request of [find, get, set]) {
    const denied = await mcp(request, valid);
    assert.equal(denied.status, 403, "the preview master switch cannot grant access on upgrade");
    assert.deepEqual(await denied.json(), settingsFailure("access_disabled"));
  }
  assert.deepEqual(await (await app.request("/api/session-settings-access", { headers })).json(), { enabled: false });
  applyFeatureFlagIntent({ kind: "flag", id: SESSION_SETTINGS_FLAG_ID, enabled: true });
  assert.equal((await mcp(get, valid)).status, 403, "the individual preview switch also requires desktop consent");
  assert.equal((await setAccess(true, operatorClick(true))).status, 200);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.sessionSettingsAccess), true);
  assert.deepEqual(accessChanges, [true]);
  assert.equal((await mcp({ ...get, sessionId: "sdk:other" }, valid)).status, 400);
  assert.equal((await mcp(get, valid)).status, 200, "the authorized Trust choice opens access");

  const tsx = fileURLToPath(import.meta.resolve("tsx"));
  const source = fileURLToPath(new URL("../src/mcp/server.ts", import.meta.url));
  const childEnv = {
    ...process.env, MISSION_HOME: home, MISSION_PORT: String(address.port), MISSION_API_TOKEN: token,
    TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
  } as Record<string, string>;
  const open = async (id: string, embedded: boolean) => {
    const client = new Client({ name: "session-settings-test", version: "1" });
    t.after(() => client.close());
    const env = { ...childEnv };
    delete env.MISSION_SCOUT_SESSION_LOCATOR;
    delete env.MISSION_SESSION_ID;
    if (embedded) {
      env.MISSION_SCOUT_SESSION_LOCATOR = sessionScoutCredentialLocator(id);
      env.MISSION_SESSION_ID = id;
    }
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", tsx, source], cwd: home, env, stderr: "pipe",
    }));
    return client;
  };
  const claude = await open(sdk.id, true);
  const codex = await open(terminal.syntheticId, false);
  const oldBridge = process.env.MISSION_MCP_SERVER;
  process.env.MISSION_MCP_SERVER = source;
  t.after(() => {
    if (oldBridge === undefined) delete process.env.MISSION_MCP_SERVER;
    else process.env.MISSION_MCP_SERVER = oldBridge;
  });
  const handlers = new Map<string, Parameters<PiApi["on"]>[1]>();
  const piTools = new Map<string, PiTool>();
  managedMissionExtension({ sessionId: pi.id, locator: sessionScoutCredentialLocator(pi.id) }, {
    ...childEnv, NODE_OPTIONS: `--import ${tsx}`,
  })({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: tool => piTools.set(tool.name, tool),
  });
  const piContext: PiContext = {
    cwd: home, sessionManager: { getSessionId: () => "pi-settings", getSessionFile: () => undefined },
    getContextUsage: () => undefined,
  };
  await handlers.get("session_start")!({ type: "session_start" }, piContext);
  t.after(async () => { await handlers.get("session_shutdown")!({ type: "session_shutdown" }, piContext); });
  const piTool = piTools.get("mission_settings");
  assert.ok(piTool);

  const definitions = (await claude.listTools()).tools;
  assert.deepEqual(definitions.map(tool => tool.name).sort(), [...MISSION_MCP_TOOLS].sort());
  const definition = definitions.find(tool => tool.name === "mission_settings")!;
  assert.deepEqual(definition.inputSchema, piTool.parameters);
  assert.deepEqual(Object.keys(definition.inputSchema.properties ?? {}).sort(),
    ["choiceCursor", "cursor", "expectedVersion", "key", "operation", "query", "value"]);
  assert.doesNotMatch(JSON.stringify(definition), /ui\.skin|Daylight/);

  async function call(client: Client, args: Record<string, unknown>, error?: SettingsErrorCode, hint?: string): Promise<SettingsResult> {
    const response = await client.callTool({ name: "mission_settings", arguments: args });
    assert.equal(Boolean(response.isError), Boolean(error), JSON.stringify(response.content));
    const [part] = response.content as Array<{ text: string }>;
    const body = JSON.parse(part!.text);
    if (error) assert.deepEqual(body, settingsFailure(error, hint));
    return body;
  }
  await t.test("new typed fields and specialized intents use the fixed stdio definition", async () => {
    const schema = z.object({ synthetic: z.enum(["off", "on"]).optional() }).strict();
    let config = { synthetic: "off" as "on" | "off" };
    const fields = bindTypedSettings({
      schema, read: () => config,
      apply: patch => config = { synthetic: patch.synthetic ?? config.synthetic },
    }, [field("fixture", "synthetic", "layout", { label: "Synthetic preference", choices: choices(["off", "on"]) })]);
    const fixture = new Hono();
    let extra: SettingDescriptor[] = [];
    registerSessionSettingsRoutes(fixture, registry, undefined, () => [...fields, ...extra]);
    try {
      handleRequest = request => new URL(request.url).pathname === "/mcp/settings" ? fixture.fetch(request) : app.fetch(request);
      const small = (await claude.listTools()).tools;
      const names = small.map(tool => tool.name);
      // Sorted pre-feature tools as shipped at c683881ac, before Phase 1 added the sole tool.
      const existing = names.filter(name => name !== "mission_settings").sort();
      assert.equal(createHash("sha256").update(existing.join("\n")).digest("hex"),
        "a7b576876d68f5b0844dc22a7055e878be53e6bb47e2cb96b4f8fcea9ebee2b0");
      assert.equal(names.length, existing.length + 1);
      assert.deepEqual(await call(claude, { operation: "find", query: "synthetic preference" }), {
        ok: true, operation: "find", matches: [{ key: "fixture.synthetic", access: "read-write", label: "Synthetic preference" }],
      });
      assert.equal((await call(claude, { operation: "get", key: "fixture.synthetic" }) as { value: string }).value, "off");
      await call(claude, { operation: "set", key: "fixture.synthetic", value: "on" });
      assert.equal(config.synthetic, "on");
      let enabled = false;
      const intentKey = "fixture.intent";
      const intent = scalarIntent(intentKey, "layout", z.boolean(), {
        label: "Synthetic specialized intent",
        read: () => enabled,
        apply: value => { enabled = value; return enabled; },
      });
      extra = [intent];
      assert.deepEqual(await call(claude, { operation: "find", query: "synthetic specialized intent" }), {
        ok: true, operation: "find", matches: [{ key: intentKey, access: "read-write", label: "Synthetic specialized intent" }],
      });
      assert.deepEqual(await call(claude, { ...get, key: intentKey }), {
        ok: true, operation: "get", key: intentKey, value: false, type: "boolean",
      });
      await call(claude, { ...set, key: intentKey, value: true });
      assert.equal(enabled, true);
      extra = Array.from({ length: 256 }, (_, n) => ({
        key: `fixture.extra${n}`, label: `Synthetic preference ${n}`, keywords: [],
        access: "read-only", read: () => n,
      }));
      assert.equal(JSON.stringify((await claude.listTools()).tools), JSON.stringify(small));
      const first = await call(claude, { operation: "find", query: "synthetic preference" });
      assert.ok(first.ok && first.operation === "find" && first.nextCursor);
      assert.equal(first.matches.length, 8);
      const next = await call(claude, { operation: "find", query: "synthetic preference", cursor: first.nextCursor });
      assert.ok(next.ok && next.operation === "find");
      assert.equal(next.matches[0]?.key, "fixture.extra7");
    } finally {
      handleRequest = app.fetch;
    }
  });

  await t.test("an individual flag choice matching Enable all survives turning Enable all off", async () => {
    const id = "idle-rail-section-counts";
    const key = `featureFlags.${id}`;
    const before = getFeatureFlagsConfig();
    const read = { ok: true, operation: "get", key, value: true, type: "boolean" };
    try {
      assert.equal(before.enableAll, true);
      assert.equal(Object.hasOwn(before.overrides, id), false);
      assert.deepEqual(await call(claude, { ...get, key }), read);
      assert.deepEqual(await call(claude, { ...set, key, value: true }), {
        ok: true, operation: "set", key, value: true,
      });
      const dashboard = await app.request("/api/feature-flags", {
        method: "PUT", headers, body: JSON.stringify({ kind: "master", enabled: false }),
      });
      assert.equal(dashboard.status, 200);
      assert.equal(getFeatureFlagsConfig().enableAll, false);
      assert.deepEqual(await call(claude, { ...get, key }), read);
      assert.equal(getFeatureFlagsConfig().overrides[id], true);
    } finally {
      setAppConfig(APP_CONFIG_ENTRIES.featureFlags, before);
      reloadFeatureFlags();
    }
  });

  await t.test("individual flags share live intent and retry behavior while bulk and consent flags stay protected", async () => {
    const key = "featureFlags.idle-rail-section-counts";
    const config = getFeatureFlagsConfig();
    let publishes = 0;
    const stop = onFeatureFlagsChanged(() => publishes++);
    try {
      assert.deepEqual(await call(codex, { ...set, key, value: false }), {
        ok: true, operation: "set", key, value: false,
      });
      await call(claude, { ...set, key, value: false });
      assert.equal(publishes, 1);
      assert.deepEqual(getFeatureFlagsConfig(), {
        ...config, overrides: { ...config.overrides, "idle-rail-section-counts": false },
      });
      for (const key of ["featureFlags.enableAll", "featureFlags.overrides", "featureFlags.voice", "featureFlags.inbox",
        "featureFlags.persona-repository-access", "featureFlags.shaper-sign-in", `featureFlags.${SESSION_SETTINGS_FLAG_ID}`]) {
        await call(claude, { ...set, key, value: true }, "protected", "Manage this setting in Settings > Feature flags.");
      }
      assert.equal(publishes, 1);
      const dashboard = await app.request("/api/feature-flags", {
        method: "PUT", headers, body: JSON.stringify({ kind: "flag", id: "idle-rail-section-counts", enabled: true }),
      });
      assert.equal(dashboard.status, 200);
      assert.deepEqual(await call(claude, { ...get, key }), { ok: true, operation: "get", key, value: true, type: "boolean" });
      const piRead = await piTool.execute("flag", { ...get, key });
      assert.deepEqual(JSON.parse(piRead.content[0]!.text), {
        ok: true, operation: "get", key, value: true, type: "boolean",
      });
    } finally {
      stop();
    }
  });

  await t.test("gated shaping and voice edits validate and keep neighboring preferences and authority", async () => {
    const shapingKey = "shaping.limits.timeoutMs";
    const voiceKey = "voice.cancelWindow.seconds";
    const read = getShapingConfig().limits;
    applyFeatureFlagIntent({ kind: "flag", id: "task-shaping", enabled: false });
    await call(claude, { ...get, key: shapingKey }, "unknown_key");
    applyFeatureFlagIntent({ kind: "flag", id: "task-shaping", enabled: true });
    await call(claude, { ...set, key: shapingKey, value: "fixture-secret-invalid-timeout" }, "invalid_value");
    assert.deepEqual(getShapingConfig().limits, read);
    await call(claude, { ...set, key: shapingKey, value: read.timeoutMs + 1 });
    assert.deepEqual(getShapingConfig().limits, { ...read, timeoutMs: read.timeoutMs + 1 });
    await call(claude, { ...set, key: "shaping.caller", value: { name: "fixture-secret" } }, "protected",
      "Manage this setting in Settings > Task shaping.");
    const before = getVoiceConfig();
    await call(claude, { ...set, key: voiceKey, value: before.cancelWindow.seconds + 1 });
    assert.deepEqual(getVoiceConfig(), { ...before, cancelWindow: { ...before.cancelWindow, seconds: before.cancelWindow.seconds + 1 } });
    for (const key of ["voice.decisionProvider", "voice.decisionKey", "voice.hotkey", "voice.listeningMode",
      "voice.muted", "voice.heard", "voice.showTranscript"]) {
      await call(claude, { ...get, key }, "protected", "Manage this setting in Settings > Voice.");
    }
    await call(claude, { ...set, key: "voice.inputDevice", value: "fixture-unavailable-device" }, "invalid_value");
    await call(claude, { ...set, key: "voice.transcriptStyle", value: "capsule" });
    assert.equal(getVoiceConfig().transcriptStyle, "capsule");
    assert.equal(getVoiceConfig().showTranscript, before.showTranscript);
    await call(claude, { ...set, key: "ui.voice", value: { confirmation: "toast" } }, "unknown_key");
    await call(claude, { ...set, key: "ui.voice.confirmation", value: "toast" });
    await call(claude, { ...set, key: "ui.voice.indicators.edge", value: true });
    assert.equal(getUiConfig().voice.confirmation, "toast");
    assert.ok(getUiConfig().voice.indicators.includes("edge"));
    await call(claude, { ...get, key: "pipelines.launchRuntime" }, "unknown_key");
  });

  await t.test("repository index replacements share dashboard invalidation and reject stale or private invalid input", async () => {
    const key = "repoIndex.directories";
    const read = await call(claude, { ...get, key });
    assert.ok(read.ok && read.operation === "get" && read.version);
    const identities: string[] = [];
    const stop = registry.subscribe(event => {
      if (event.type === "repo_index_changed") identities.push(event.identity);
    });
    try {
      const saved = await app.request("/api/repo-index", {
        method: "PUT", headers, body: JSON.stringify({ directories: [] }),
      });
      assert.equal(saved.status, 200);
      await call(claude, { ...set, key, expectedVersion: read.version, value: [{ path: home }] }, "stale_version");
      const current = await call(claude, { ...get, key });
      assert.ok(current.ok && current.operation === "get" && current.version);
      assert.deepEqual(current.value, []);
      await call(claude, { ...set, key, expectedVersion: current.version,
        value: [{ path: "private-relative-directory" }] }, "invalid_value");
      assert.equal(identities.length, 1);
      const next = [{ path: home }];
      assert.deepEqual(await call(claude, { ...set, key, expectedVersion: current.version, value: next }), {
        ok: true, operation: "set", key, value: next,
      });
      assert.equal(identities.length, 2);
      assert.notEqual(identities[0], identities[1]);
    } finally {
      stop();
    }
  });

  await t.test("workflow history can be kept longer while destructive edits and report muting retain operator authority", async () => {
    const key = "workflows.retention.maxCompletedRuns";
    const current = await call(claude, { ...get, key });
    assert.ok(current.ok && current.operation === "get" && typeof current.value === "number");
    await call(claude, { ...set, key, value: current.value - 1 }, "invalid_value");
    assert.deepEqual(await call(claude, { ...get, key }), current);
    const value = current.value + 1;
    assert.deepEqual(await call(claude, { ...set, key, value }), { ok: true, operation: "set", key, value });
    for (const [key, destination] of [
      ["workflows.liveEnabled", "Workflows"], ["workflows.checksEnabled", "Workflows"],
      ["reports.muted", "Reports"], ["settings.restore", "Restore"], ["telemetry.user", "Telemetry"],
    ]) {
      await call(claude, { ...get, key }, "protected", `Manage this setting in Settings > ${destination}.`);
      await call(claude, { ...set, key, value: { credential: "private" } }, "protected",
        `Manage this setting in Settings > ${destination}.`);
    }
  });

  await t.test("task-source leaf edits preserve provider authority and reject stale list replacements", async () => {
    const entry = APP_CONFIG_ENTRIES.taskSources;
    setAppConfig(entry, { sources: [{
      id: "fixture-source", kind: "github-issues", repoRoot: home, config: { repo: "operator/private-repo", assignedToMe: true },
      writeback: { annotate: true },
    }] } as never);
    const prefix = `taskSources.${createHash("sha256").update("fixture-source").digest("base64url")}`;
    const key = `${prefix}.config.labelsAny`;
    const original = getTaskSourcesConfig();
    await call(claude, { ...set, key: `${prefix}.config.unassignedOnly`, value: true }, "invalid_value");
    assert.deepEqual(getTaskSourcesConfig(), original);
    await call(claude, { ...get, key: `${prefix}.authority` }, "protected", "Manage this setting in Settings > Task sources.");
    await call(claude, { ...get, key: `${prefix}.config.repo` }, "unknown_key");
    const read = await call(claude, { ...get, key });
    assert.ok(read.ok && read.operation === "get" && read.version);
    const stale = { ...set, key, expectedVersion: read.version, value: ["bug"] };
    await call(codex, { ...set, key: `${prefix}.maxPerSweep`, value: 12 });
    await call(claude, stale, "stale_version");
    const latest = await call(claude, { ...get, key });
    assert.ok(latest.ok && latest.operation === "get" && latest.version);
    assert.deepEqual(await call(claude, { ...stale, expectedVersion: latest.version }), {
      ok: true, operation: "set", key, value: ["bug"],
    });
    const saved = getTaskSourcesConfig().sources[0]!;
    assert.deepEqual(saved, { ...original.sources[0], maxPerSweep: 12,
      config: { ...(original.sources[0]!.config as object), labelsAny: ["bug"] } });
  });

  await t.test("Harnesses validation and notification are shared by MCP and dashboard edits", async () => {
    let notifications = 0;
    const stop = registry.subscribe(event => {
      if (event.type === "harnesses_config_changed") notifications++;
    });
    const put = (body: unknown) => app.request("/api/harnesses/config", {
      method: "PUT", headers, body: JSON.stringify(body),
    });
    try {
      setAppConfig(APP_CONFIG_ENTRIES.harnesses, {
        defaultModel: { claude: "future-model-id", codex: null },
        sessionRuntime: { claude: "future-runtime" }, futureField: { futureOption: true },
      } as never);
      const key = "harnesses.kindDefaults.ship.model";
      await call(claude, { operation: "set", key, value: "claude-opus-4-8" }, "invalid_value");
      assert.equal(notifications, 0);
      const [mcpEdit, dashboardEdit] = await Promise.all([
        call(claude, { operation: "set", key: "harnesses.defaultEffort.claude", value: "high" }),
        put({ defaultModel: { codex: "gpt-5.5" } }),
      ]);
      assert.ok(mcpEdit.ok);
      assert.equal(dashboardEdit.status, 200);
      assert.equal(notifications, 2);
      await call(claude, { operation: "set", key: "harnesses.defaultEffort.claude", value: "high" });
      assert.equal(notifications, 2);
      const stored = getAppConfig(APP_CONFIG_ENTRIES.harnesses);
      assert.equal(stored?.defaultModel?.claude, "future-model-id");
      assert.equal(stored?.defaultModel?.codex, "gpt-5.5");
      assert.equal(stored?.sessionRuntime?.claude, "future-runtime");
      assert.deepEqual((stored as Record<string, unknown>).futureField, { futureOption: true });
      await call(claude, { operation: "set", key: "harnesses.defaultModel", value: { claude: null } }, "unknown_key");
      await call(claude, { operation: "set", key: "harnesses.kindDefaults.__proto__.model", value: "x" }, "unknown_key");
    } finally {
      stop();
    }
  });

  await t.test("mission_settings refuses a backup limit that would delete a copy", async () => {
    const before = { ...getDatabaseBackupsConfig(), scheduledCount: 2 };
    setAppConfig(APP_CONFIG_ENTRIES.backups, before);
    const first = await databaseBackups.captureScheduled();
    const second = await databaseBackups.captureScheduled();
    const kept = readdirSync(databaseBackups.root).sort();
    assert.deepEqual(kept, [first.filename, second.filename].sort());
    const copies = [first.path, second.path].map(path => readFileSync(path));

    const planned = databaseBackups.plannedRemovals({ ...before, scheduledCount: 1 });
    assert.equal(planned.length, 1, "the proposed edit would delete an existing copy");
    assert.ok(kept.includes(planned[0]!));

    await call(claude, { operation: "set", key: "backups.scheduledCount", value: 1 }, "invalid_value");
    assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.backups), before);
    assert.deepEqual(readdirSync(databaseBackups.root).sort(), kept);
    assert.deepEqual([first.path, second.path].map(path => readFileSync(path)), copies);
  });

  await t.test("the Foreman automatic wrap-up exclusions stay under operator control", async () => {
    const config = { wrapup: "pr", skipScoutWrapup: true, skipReviewArtifactWrapup: true } as const;
    setAppConfig(APP_CONFIG_ENTRIES.foreman, config);
    for (const key of ["foreman.skipScoutWrapup", "foreman.skipReviewArtifactWrapup"]) {
      await call(claude, { ...set, key, value: false }, "protected", "Manage this setting in Settings > Foreman.");
    }
    assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.foreman), config);
  });

  await t.test("free-form report guidance stays under operator control", async () => {
    const config = { guidance: "Operator guidance for future sessions." };
    setAppConfig(APP_CONFIG_ENTRIES.reports, config);
    await call(claude, { ...get, key: "reports.guidance" }, "protected", "Manage this setting in Settings > Reports.");
    await call(claude, { ...set, key: "reports.guidance", value: "Session-supplied text." },
      "protected", "Manage this setting in Settings > Reports.");
    assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.reports), config);
  });

  await t.test("an explicit repository override persists even when it equals the inherited value", async () => {
    const repo = join(home, "repository", ".git");
    setWorktreesConfig({ enabled: true, repositories: { [repo]: { maxSlots: 2 } } });
    const key = `worktrees.repositories.${createHash("sha256").update(repo).digest("base64url")}.enabled`;
    assert.deepEqual(await call(claude, { ...get, key }), { ok: true, operation: "get", key, value: true, type: "boolean" });
    assert.deepEqual(await call(claude, { ...set, key, value: true }), { ok: true, operation: "set", key, value: true });
    assert.deepEqual(getWorktreesConfig().repositories[repo], { maxSlots: 2, enabled: true });
    setWorktreesConfig({ enabled: false });
    assert.equal(resolveWorktreePolicy(repo).enabled, true);
    assert.deepEqual(await call(claude, { ...get, key }), { ok: true, operation: "get", key, value: true, type: "boolean" });
  });

  await t.test("hidden-item booleans agree with both persisted visibility lists", async () => {
    for (const [owner, id] of [["hiddenDisplayItems", "model"], ["hiddenTopbarItems", "sessions"]] as const) {
      const key = `ui.${owner}.${id}`;
      for (const hidden of [true, false]) {
        assert.deepEqual(await call(claude, { ...set, key, value: hidden }), { ok: true, operation: "set", key, value: hidden });
        assert.equal(getUiConfig()[owner].includes(id), hidden);
        assert.deepEqual(await call(claude, { ...get, key }), { ok: true, operation: "get", key, value: hidden, type: "boolean" });
      }
    }
  });

  await t.test("keyboard writes reject noncanonical chords before storing them", async () => {
    const key = "ui.keybindings.fleet";
    for (const value of ["meta+k", "Ctrl+M", "ctrl+M", "alt+ctrl+m", "shift+?", "ctrl+Nonsense"]) {
      await call(claude, { ...set, key, value }, "invalid_value");
    }
    assert.equal(getUiConfig().keybindings.fleet, undefined);
    assert.deepEqual(await call(claude, { ...set, key, value: "ctrl+m" }), { ok: true, operation: "set", key, value: "ctrl+m" });
    assert.equal(getUiConfig().keybindings.fleet, "ctrl+m");
  });

  await t.test("shipping discovery lists every valid merge method", async () => {
    const key = "shipping.method";
    assert.deepEqual(await call(claude, { ...get, key }), {
      ok: true, operation: "get", key, value: "squash", type: "string", constraints: { choicesOnly: true },
      choices: ["squash", "merge", "rebase"].map(value => ({ value, label: value })),
    });
    assert.deepEqual(await call(claude, { ...set, key, value: "merge" }), { ok: true, operation: "set", key, value: "merge" });
  });

  await t.test("a structured Skills edit requires a fresh version after a dashboard save", async () => {
    const key = "skills.grillFirstKinds";
    const request = { operation: "get", key };
    const before = await call(claude, request);
    assert.ok(before.ok && before.operation === "get" && before.version);
    const edit = { operation: "set", key, value: ["ship"] };
    await call(claude, edit, "version_required");
    const saved = await app.request("/api/skills/config", {
      method: "PUT", headers, body: JSON.stringify({ alwaysDraftPr: true, grillFirstKinds: ["plan"] }),
    });
    assert.equal(saved.status, 200);
    await call(claude, { ...edit, expectedVersion: before.version }, "stale_version");
    const current = await call(claude, request);
    assert.ok(current.ok && current.operation === "get" && current.version);
    assert.deepEqual(current.value, ["plan"]);
    await call(claude, { ...edit, value: ["not-a-kind"], expectedVersion: current.version }, "invalid_value");
    await call(claude, { ...edit, value: { constructor: "secret" }, expectedVersion: current.version }, "invalid_value");
    const done = await call(claude, { ...edit, expectedVersion: current.version });
    assert.ok(done.ok && done.operation === "set");
    assert.deepEqual(done.value, ["ship"]);
    assert.equal(getAppConfig(APP_CONFIG_ENTRIES.skills)?.alwaysDraftPr, true);
    await call(claude, { ...edit, expectedVersion: current.version }, "stale_version");
  });

  await t.test("a settings restore invalidates a previously read Skills version", async () => {
    const entry = APP_CONFIG_ENTRIES.skills;
    setAppConfig(entry, { ...getAppConfig(entry), grillFirstKinds: ["plan"] });
    const snapshot = new Map(captureSettingsConfig().map(item => [item.domain, item.payload]));
    setAppConfig(entry, { ...getAppConfig(entry), grillFirstKinds: ["ship"] });
    const key = "skills.grillFirstKinds";
    const before = await call(claude, { ...get, key });
    assert.ok(before.ok && before.operation === "get" && before.version);
    assert.deepEqual(before.value, ["ship"]);

    const db = openDb();
    db.exec("BEGIN");
    try {
      restoreSettingsConfigInTransaction(db, stageSettingsConfigRestore(snapshot));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    await call(claude, { ...set, key, value: ["ship"], expectedVersion: before.version }, "stale_version");
    const restored = await call(claude, { ...get, key });
    assert.ok(restored.ok && restored.operation === "get");
    assert.deepEqual(restored.value, ["plan"]);
  });

  assert.deepEqual(await call(claude, find), {
    ok: true, operation: "find", matches: [{ key: "ui.skin", label: "Skin", access: "read-write" }],
  });
  assert.deepEqual(await call(codex, get), {
    ok: true, operation: "get", key: "ui.skin", value: "default", type: "string",
    constraints: { choicesOnly: true }, choices: SKINS.map(({ id, label }) => ({ value: id, label })),
  });
  assert.deepEqual(await call(claude, set), { ok: true, operation: "set", key: "ui.skin", value: "daylight" });
  assert.deepEqual(await call(claude, set), { ok: true, operation: "set", key: "ui.skin", value: "daylight" });
  assert.equal(changes, 1, "the same scalar selection does not announce another change");
  assert.equal(getUiConfig().layout, "console");
  assert.equal(JSON.parse(readFileSync(join(home, "window-background.json"), "utf8")).color, "#f5f7fa");
  const piResult = await piTool.execute("theme", get);
  assert.match(JSON.stringify(piResult.content), /daylight/);

  await call(claude, { ...get, key: "ui.hiddenDisplayItems" }, "unknown_key");
  await call(claude, { ...set, value: "invalid-private-value" }, "invalid_value");
  await call(claude, { ...set, key: "sessionSettings.access", value: true }, "protected",
    "Manage this setting in Settings > Trust.");
  await call(claude, { ...set, key: `featureFlags.${SESSION_SETTINGS_FLAG_ID}`, value: true }, "protected",
    "Manage this setting in Settings > Feature flags.");
  await call(claude, { ...get, value: false }, "invalid_request");
  await call(claude, { ...set, value: "x".repeat(20_000) }, "value_too_large");

  const stale = credential(terminal.syntheticId);
  registry.applyDiscovery([]);
  await call(codex, get, "unauthorized");
  assert.equal((await mcp(get, { ...valid, "x-mission-scout-credential": stale })).status, 403);

  applyFeatureFlagIntent({ kind: "flag", id: SESSION_SETTINGS_FLAG_ID, enabled: false });
  await call(claude, get, "access_disabled");
  applyFeatureFlagIntent({ kind: "flag", id: SESSION_SETTINGS_FLAG_ID, enabled: true });
  const revoke = operatorClick(false);
  assert.equal((await setAccess(false, revoke)).status, 200);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.sessionSettingsAccess), false);
  assert.deepEqual(accessChanges, [true, false]);
  for (const response of [
    await setAccess(true),
    await setAccess(true, randomUUID(), { origin: `http://127.0.0.1:${address.port}`, "x-mission-operation-actor": "human" }),
    await setAccess(true, operatorClick(true), valid),
    await setAccess(true, revoke),
  ]) assert.equal(response.status, 403);
  assert.equal(getAppConfig(APP_CONFIG_ENTRIES.sessionSettingsAccess), false);
  assert.deepEqual(accessChanges, [true, false], "refusals publish no access update");
  assert.ok(!SETTINGS_CONFIG_BACKUP_ENTRIES.some(entry => entry.key === APP_CONFIG_ENTRIES.sessionSettingsAccess.key));
  for (const request of [find, get, { ...set, value: "paper" }]) await call(claude, request, "access_disabled");
  await assert.rejects(piTool.execute("revoked", get), /access_disabled/);
  assert.equal(getUiConfig().skin, "daylight");
  applyFeatureFlagIntent({ kind: "flag", id: SESSION_SETTINGS_FLAG_ID, enabled: false });
  applyFeatureFlagIntent({ kind: "flag", id: SESSION_SETTINGS_FLAG_ID, enabled: true });
  await call(claude, get, "access_disabled");
  assert.equal((await setAccess(true, operatorClick(true))).status, 200);
  assert.equal((await setAccess(true, operatorClick(true))).status, 200);
  assert.deepEqual(accessChanges, [true, false, true], "a repeated save does not emit a duplicate update");
  assert.equal((await call(claude, get)).ok, true);

  // Simulate access being withdrawn after the request passed the gate and began reading its body.
  const pending = app.request("/mcp/settings", {
    method: "POST",
    headers: { ...headers, ...valid },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        setAppConfig(APP_CONFIG_ENTRIES.sessionSettingsAccess, false);
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...set, value: "paper" })));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  const refused = await pending;
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), settingsFailure("access_disabled"));
  assert.equal(getUiConfig().skin, "daylight");
});

test("find and choice continuations bind to their operation, query, key and ordered catalog", () => {
  let choices = Array.from({ length: 20 }, (_, i) => ({ label: `Choice ${i}`, value: i }));
  const catalog: SettingDescriptor[] = Array.from({ length: 9 }, (_, i) => ({
    key: `fixture.setting${i}`, label: `Theme ${i}`, keywords: [], access: "read-only", read: () => 0,
    choices: () => choices,
  }));
  let enabled = true;
  const call = (request: SettingsRequest) => dispatchSetting(request, catalog, () => enabled ? null : settingsFailure("access_disabled"));
  const first = call(find);
  assert.ok(first.ok && first.operation === "find" && first.nextCursor);
  assert.equal(first.matches.length, 8);
  assert.deepEqual(call({ ...find, cursor: first.nextCursor }), {
    ok: true, operation: "find", matches: [{ key: "fixture.setting8", label: "Theme 8", access: "read-only" }],
  });
  assert.deepEqual(call({ ...find, query: "them", cursor: first.nextCursor }), settingsFailure("invalid_cursor"));

  const request = { operation: "get", key: "fixture.setting0" } as const;
  assert.deepEqual(call({ ...request, choiceCursor: first.nextCursor }), settingsFailure("invalid_cursor"));
  const firstChoices = call(request);
  assert.ok(firstChoices.ok && firstChoices.operation === "get" && firstChoices.choices && firstChoices.nextChoiceCursor);
  assert.equal(firstChoices.value, 0);
  assert.equal(firstChoices.choices.length, 8);
  assert.deepEqual(call({ ...find, cursor: firstChoices.nextChoiceCursor }), settingsFailure("invalid_cursor"));
  assert.deepEqual(call({ ...request, key: "fixture.setting1", choiceCursor: firstChoices.nextChoiceCursor }), settingsFailure("invalid_cursor"));
  const second = call({ ...request, choiceCursor: firstChoices.nextChoiceCursor });
  assert.ok(second.ok && second.operation === "get" && second.choices && second.nextChoiceCursor);
  assert.equal(second.choices.length, 8);
  const last = call({ ...request, choiceCursor: second.nextChoiceCursor });
  assert.ok(last.ok && last.operation === "get" && last.choices);
  assert.ok(!("nextChoiceCursor" in last));
  assert.deepEqual([...firstChoices.choices, ...second.choices, ...last.choices], choices);

  enabled = false;
  assert.deepEqual(call({ ...request, choiceCursor: second.nextChoiceCursor }), settingsFailure("access_disabled"));
  enabled = true;
  choices = [...choices].reverse();
  assert.deepEqual(call({ ...request, choiceCursor: firstChoices.nextChoiceCursor }), settingsFailure("invalid_cursor"));
  catalog.reverse();
  assert.deepEqual(call({ ...find, cursor: first.nextCursor }), settingsFailure("invalid_cursor"));
});

test("composite replacements compare owner revisions at mutation and preserve intervening dashboard edits", () => {
  let value = { muted: false, count: 0, other: null };
  let revision = 0;
  let enabled = true;
  const schema = z.strictObject({ muted: z.boolean(), count: z.number(), other: z.null() });
  const ownerWrite = (next: z.infer<typeof schema>) => {
    revision++;
    return value = next;
  };
  const descriptor: SettingDescriptor = {
    key: "fixture.display", label: "Display", keywords: [], access: "read-write", replacement: "composite",
    read: () => ({ value, revision: String(revision) }),
    schema,
    write: next => ownerWrite(schema.parse(next)),
  };
  const call = (request: SettingsRequest) => dispatchSetting(request, [descriptor], () => enabled ? null : settingsFailure("access_disabled"));
  const current = () => {
    const current = call({ operation: "get", key: descriptor.key });
    assert.ok(current.ok && current.operation === "get" && current.version);
    return current;
  };
  const first = current();
  assert.deepEqual(first.value, { muted: false, count: 0, other: null });
  const replace = { operation: "set", key: descriptor.key, value: { ...value, muted: true } } as const;
  assert.deepEqual(call(replace), settingsFailure("version_required"));
  assert.deepEqual(value, first.value);
  const dashboardEdit = ownerWrite({ ...value, count: 12 });
  assert.deepEqual(call({ ...replace, expectedVersion: first.version }), settingsFailure("stale_version"));
  assert.deepEqual(value, dashboardEdit);
  const latest = current();
  assert.deepEqual(call({ ...replace, value: { ...dashboardEdit, muted: true }, expectedVersion: latest.version }),
    { ok: true, operation: "set", key: descriptor.key, value: { muted: true, count: 12, other: null } });

  const revoked = dispatchSetting({ ...replace, expectedVersion: current().version }, [{
    ...descriptor, schema: schema.transform(next => { enabled = false; return next; }),
  }], () => enabled ? null : settingsFailure("access_disabled"));
  assert.deepEqual(revoked, settingsFailure("access_disabled"));
  assert.equal(value.count, 12);
});

test("the dispatcher refuses duplicate keys, unbounded reads and owner errors without echoing details", () => {
  const descriptor: SettingDescriptor = {
    key: get.key, label: "Theme", keywords: [], access: "read-only", read: () => "x".repeat(20_000),
  };
  assert.deepEqual(dispatchSetting(get, [descriptor, descriptor], () => null), settingsFailure("ambiguous_key"));
  assert.deepEqual(dispatchSetting(get, [descriptor], () => null), settingsFailure("value_too_large"));
  assert.deepEqual(dispatchSetting(get, [{ ...descriptor, read: () => { throw new Error("private setting value"); } }], () => null),
    settingsFailure("unavailable"));
});
