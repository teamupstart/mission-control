import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
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
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { getAppConfig, setAppConfig } = await import("../src/server/db.ts");
const { applyFeatureFlagIntent, featureEnabled, reloadFeatureFlags } = await import("../src/server/feature-flags/index.ts");
const { maintainScoutSessionCredentials } = await import("../src/server/scouts/session-credentials.ts");
const { sessionScoutCredentialLocator } = await import("../src/server/scouts/submission-auth.ts");
const { onUiSkinChanged, getUiConfig } = await import("../src/server/ui-config.ts");
const { SETTINGS_CONFIG_BACKUP_ENTRIES } = await import("../src/server/settings-backups/config-registry.ts");
const { dispatchSetting } = await import("../src/server/settings-dispatcher.ts");
const { MISSION_MCP_TOOLS } = await import("../src/server/mission-mcp.ts");
type SettingDescriptor = import("../src/server/settings-dispatcher.ts").SettingDescriptor;
type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type TaskManager = import("../src/server/tasks.ts").TaskManager;
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
  const app = buildApp({
    registry, tasks: {} as TaskManager, reviews: {} as ReviewManager, queues: {} as QueueManager,
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

  await call(claude, { ...get, key: "ui.layout" }, "unknown_key");
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
