import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Persona } from "../src/shared/workflow.ts";

// Resident MCP servers below the drivers: custom servers and their write-only secrets, the
// global catalog's projection, the effective set a launch resolves, the run snapshot, and the
// single-use tickets the scoped launcher redeems. Every global catalog here is a fixture, so
// no test reads the operator's harness configuration.

ensureNativeStateLockAddon();

const home = mkdtempSync(join(tmpdir(), "mission-residents-mcp-"));
process.env.HARNESS_HOME = home;

const { openDb, getAppConfig } = await import("../src/server/db.ts");
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const mcpStore = await import("../src/server/residents/mcp-store.ts");
const catalog = await import("../src/server/residents/mcp-catalog.ts");
const launch = await import("../src/server/residents/mcp-launch.ts");
const { Registry } = await import("../src/server/registry.ts");
const { RESIDENT_LAUNCH_TASK_CREATE, TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { ResidentManager } = await import("../src/server/residents/manager.ts");
const { upsertSdkSession } = await import("../src/server/sdk/store.ts");
const { scrubWriteOnlySecrets } = await import("../src/server/database-backups/service.ts");
const { ResidentProfileRevisionSchema } = await import("../src/shared/residents.ts");
const {
  CreateResidentMcpServerSchema,
  credentialFormArgument,
} = await import("../src/shared/resident-mcp.ts");

type CreateInput = import("../src/shared/resident-mcp.ts").CreateResidentMcpServer;
type GlobalRead = import("../src/server/residents/mcp-catalog.ts").GlobalMcpRead;
type Resolved = import("../src/server/residents/mcp-store.ts").ResidentMcpResolvedServer;
type GlobalNames = import("../src/server/residents/mcp-store.ts").GlobalMcpNames;
type GlobalReader = import("../src/server/residents/mcp-catalog.ts").GlobalMcpReader;

const NO_GLOBALS: GlobalNames = new Map();

beforeEach(() => {
  openDb().exec(`
    DELETE FROM app_config; DELETE FROM resident_mcp_secrets; DELETE FROM resident_run_mcp_servers;
    DELETE FROM resident_run_mcp_secrets; DELETE FROM resident_runs; DELETE FROM resident_profile_revisions;
    DELETE FROM resident_profiles; DELETE FROM sdk_sessions; DELETE FROM tasks;`);
});

const managers: Array<InstanceType<typeof ResidentManager>> = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
});

function create(input: unknown, globals: GlobalNames = NO_GLOBALS, id = crypto.randomUUID()) {
  return mcpStore.createResidentMcpServer(CreateResidentMcpServerSchema.parse(input) as CreateInput, { id, at: 1, globals });
}

const SECRET = "sk-live-sentinel-0001";

// ---- custom servers and write-only secrets ----

test("a secret is accepted on write and never returned: reads say only that it is set", () => {
  const view = create({
    name: "linear",
    harnesses: ["claude", "codex"],
    transport: { type: "stdio", command: "npx", args: ["-y", "linear-mcp"], env: [
      { name: "LINEAR_TOKEN", secret: true, value: SECRET },
      { name: "LOG_LEVEL", secret: false, value: "info" },
    ] },
  });
  assert.deepEqual(view.transport.type === "stdio" && view.transport.env, [
    { name: "LINEAR_TOKEN", secret: true, set: true },
    { name: "LOG_LEVEL", secret: false, value: "info" },
  ]);
  assert.ok(!JSON.stringify(mcpStore.residentMcpServerViews()).includes(SECRET), "no route payload carries it");
  assert.ok(!JSON.stringify(getAppConfig(APP_CONFIG_ENTRIES.residentMcpServers)).includes(SECRET), "the backed-up definition does not either");
  assert.equal(mcpStore.customSecretValues(view.id).get("env:LINEAR_TOKEN"), SECRET);

  // An edit that omits the value keeps it; renaming the variable does not carry it over.
  const kept = mcpStore.updateResidentMcpServer(view.id, {
    ...(CreateResidentMcpServerSchema.parse({ name: "linear", harnesses: ["claude"], transport: { type: "stdio", command: "npx", env: [{ name: "LINEAR_TOKEN", secret: true }] } }) as CreateInput),
    expectedRevision: 1,
  }, { at: 2, globals: NO_GLOBALS });
  assert.equal(kept.revision, 2);
  assert.equal(mcpStore.customSecretValues(view.id).get("env:LINEAR_TOKEN"), SECRET);
  const renamed = mcpStore.updateResidentMcpServer(view.id, {
    ...(CreateResidentMcpServerSchema.parse({ name: "linear", harnesses: ["claude"], transport: { type: "stdio", command: "npx", env: [{ name: "OTHER_TOKEN", secret: true }] } }) as CreateInput),
    expectedRevision: 2,
  }, { at: 3, globals: NO_GLOBALS });
  assert.deepEqual(renamed.transport.type === "stdio" && renamed.transport.env, [{ name: "OTHER_TOKEN", secret: true, set: false }]);
  assert.equal(mcpStore.customSecretValues(view.id).size, 0);
  assert.throws(
    () => mcpStore.updateResidentMcpServer(view.id, { ...(CreateResidentMcpServerSchema.parse({ name: "linear", harnesses: ["claude"], transport: { type: "stdio", command: "npx" } }) as CreateInput), expectedRevision: 1 }, { at: 4, globals: NO_GLOBALS }),
    /changed since you opened it/,
  );
  mcpStore.deleteResidentMcpServer(view.id, 3);
  assert.equal(mcpStore.residentMcpServerViews().length, 0);
});

test("a URL query is stored as secret parameters, so no stored or shown URL carries a value", () => {
  const view = create({
    name: "search",
    harnesses: ["codex"],
    transport: { type: "http", url: `https://mcp.example.com/mcp?key=${SECRET}`, headers: [{ name: "Authorization", secret: true, value: `Bearer ${SECRET}` }] },
  });
  assert.equal(view.transport.type === "http" && view.transport.url, "https://mcp.example.com/mcp");
  assert.deepEqual(view.transport.type === "http" && view.transport.query, [{ name: "key", set: true }]);
  assert.ok(!JSON.stringify(getAppConfig(APP_CONFIG_ENTRIES.residentMcpServers)).includes(SECRET));
  assert.ok(!JSON.stringify(mcpStore.residentMcpServerViews()).includes(SECRET));
  assert.equal(mcpStore.customSecretValues(view.id).get("query:key"), SECRET);
});

test("credentials outside secret fields are refused at save, naming the argument", () => {
  for (const arg of ["--api-key=abc", "--token", "GITHUB_TOKEN=abc", "https://user:pass@example.com", "https://example.com/?k=v", "Bearer abc"]) {
    assert.ok(credentialFormArgument(arg), arg);
    assert.throws(
      () => create({ name: `s${Math.random().toString(36).slice(2, 8)}`, harnesses: ["claude"], transport: { type: "stdio", command: "srv", args: ["--ok", arg] } }),
      /argument 2 .*secret environment variable/,
      arg,
    );
  }
  // The refusal names the position and form, and never echoes any part of a value.
  for (const [arg, named] of [
    ["Bearer sk-short", null],
    ["Authorization: Basic dXNlcjpwYXNz", null],
    ["https://user:hunter2@example.com/mcp", null],
    ["https://example.com/mcp?key=hunter2", null],
    ["--api-key=hunter2", "--api-key"],
    ["GITHUB_TOKEN=hunter2", "GITHUB_TOKEN"],
    ["--token", "--token"],
    ["--token hunter2", "--token"],
    ["--api-key\thunter2", "--api-key"],
  ] as const) {
    let message = "";
    try {
      create({ name: `e${Math.random().toString(36).slice(2, 8)}`, harnesses: ["claude"], transport: { type: "stdio", command: "srv", args: [arg] } });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, named ? new RegExp(`^argument 1 \\(${named}\\) looks like`) : /^argument 1 looks like/, arg);
    for (const secret of ["sk-short", "dXNlcjpwYXNz", "hunter2", "user:"]) assert.ok(!message.includes(secret), `${arg}: ${message}`);
  }
  for (const arg of ["--port", "8080", "--verbose", "https://example.com/mcp", "--keyboard-layout=us"]) {
    assert.equal(credentialFormArgument(arg), null, arg);
  }
  assert.throws(
    () => create({ name: "basic", harnesses: ["claude"], transport: { type: "http", url: "https://user:pw@example.com/mcp" } }),
    /user name or password/,
  );
});

test("a custom name is unique, never mission-control, and never a global server's on an applicable harness", () => {
  assert.equal(CreateResidentMcpServerSchema.safeParse({ name: "mission-control", harnesses: ["claude"], transport: { type: "stdio", command: "x" } }).success, false);
  create({ name: "github", harnesses: ["claude"], transport: { type: "stdio", command: "x" } });
  assert.throws(() => create({ name: "GitHub", harnesses: ["codex"], transport: { type: "stdio", command: "x" } }), /already named/);
  const globals = new Map([["codex", new Set(["linear"])]]) as GlobalNames;
  assert.throws(() => create({ name: "linear", harnesses: ["claude", "codex"], transport: { type: "stdio", command: "x" } }, globals), /Codex already has a global MCP server named linear/);
  // Claude has no global "linear", so a Claude-only custom server may use the name.
  assert.equal(create({ name: "linear", harnesses: ["claude"], transport: { type: "stdio", command: "x" } }, globals).name, "linear");
});

// ---- the global catalog ----

test("Claude's catalog projects allowlisted metadata only, and marks what residents cannot carry", () => {
  const dir = mkdtempSync(join(home, "claude-"));
  const path = join(dir, ".claude.json");
  writeFileSync(path, JSON.stringify({ mcpServers: {
    "mission-control": { command: "node", args: ["mission.mjs"] },
    github: { command: "/usr/local/bin/github-mcp", args: ["--stdio"], env: { GITHUB_TOKEN: SECRET } },
    remote: { type: "http", url: `https://user:pw@mcp.example.com/mcp?key=${SECRET}`, headers: { "X-Api-Key": SECRET }, timeout: 5000 },
    expanded: { command: "srv", env: { MODE: "${MISSING:-default}" } },
    unset: { command: "srv", env: { TOKEN: "${NO_SUCH_VAR}" } },
    helper: { type: "http", url: "https://mcp.example.com", headersHelper: "./h.sh" },
    leaky: { command: "srv", args: [`--token=${SECRET}`] },
  } }));
  const read = catalog.readClaudeGlobalMcp(path, { PROBE_TOKEN: SECRET });
  const names = read.servers.map((server) => server.summary.name);
  assert.deepEqual(names, ["github", "remote", "expanded", "unset", "helper", "leaky"], "mission-control is hidden");
  const summaries = read.servers.map((server) => server.summary);
  assert.ok(!JSON.stringify(summaries).includes(SECRET), "no value reaches the projection");
  assert.ok(!JSON.stringify(summaries).includes("--stdio"), "nor an argument");
  assert.deepEqual(summaries[0], { name: "github", transport: "stdio", commandBasename: "github-mcp", urlOrigin: null, envNames: ["GITHUB_TOKEN"], headerNames: [], enabled: true, unavailable: null });
  assert.equal(summaries[1]!.urlOrigin, "https://mcp.example.com");
  assert.deepEqual(summaries[1]!.headerNames.sort(), ["Authorization", "X-Api-Key"], "userinfo becomes Basic authorization, a secret");
  const remote = read.servers[1]!;
  assert.ok(remote.transport?.type !== "stdio" && remote.transport?.url === "https://mcp.example.com/mcp");
  assert.equal(remote.secrets.get("query:key"), SECRET);
  assert.deepEqual(remote.options, { claude: { timeoutMs: 5000 } });
  assert.equal(read.servers[2]!.summary.unavailable, null);
  assert.equal(read.servers[2]!.secrets.get("env:MODE"), "default", "an unset variable's default is a literal");
  assert.match(summaries[3]!.unavailable!, /unset environment variable NO_SUCH_VAR/);
  assert.match(summaries[4]!.unavailable!, /headersHelper/);
  assert.match(summaries[5]!.unavailable!, /argument 1/);
  assert.equal(read.servers[5]!.secrets.size, 0, "an unavailable server binds nothing");
});

test("a Claude global value read from the environment the agent inherits is never snapshotted, in any field", async () => {
  // A disposable sentinel standing in for a real token set in the daemon's environment. The
  // resident's agent inherits that same environment, so a server fed from it cannot be private.
  const sentinel = `env-backed-sentinel-${crypto.randomUUID()}`;
  const env = { DISPOSABLE_MCP_TOKEN: sentinel, DISPOSABLE_MCP_HOST: "mcp.example.com" };
  const read = catalog.readClaudeGlobalMcp((() => {
    const dir = mkdtempSync(join(home, "claude-env-"));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {
      "env-in-env": { command: "srv", env: { TOKEN: "${DISPOSABLE_MCP_TOKEN}" } },
      "env-in-arg": { command: "srv", args: ["--config", "/etc/${DISPOSABLE_MCP_TOKEN}.json"] },
      "env-in-command": { command: "/opt/${DISPOSABLE_MCP_TOKEN}/srv" },
      "env-in-header": { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DISPOSABLE_MCP_TOKEN}" } },
      "env-in-url": { type: "http", url: "https://${DISPOSABLE_MCP_HOST}/mcp" },
      "env-with-default": { type: "http", url: "https://${DISPOSABLE_MCP_HOST:-fallback.example.com}/mcp" },
    } }));
    return join(dir, ".claude.json");
  })(), env);
  for (const server of read.servers) {
    const variable = server.summary.name === "env-in-url" || server.summary.name === "env-with-default" ? "DISPOSABLE_MCP_HOST" : "DISPOSABLE_MCP_TOKEN";
    assert.equal(
      server.summary.unavailable,
      `it reads ${variable} from the environment, which the resident's agent inherits too; define it as a custom server with a secret instead`,
      server.summary.name,
    );
    assert.equal(server.transport, null, `${server.summary.name}: nothing to snapshot`);
    assert.equal(server.secrets.size, 0, `${server.summary.name}: no value bound`);
  }
  const rendered = JSON.stringify(read.servers.map((server) => ({ summary: server.summary, secrets: [...server.secrets] })));
  assert.ok(!rendered.includes(sentinel), "the value reaches no projection, reason or snapshot");
  // Inherited, the launch is refused by name; selected, the same.
  const inherited = await resolve(profile(), read);
  assert.ok(!inherited.ok && /reads DISPOSABLE_MCP_TOKEN from the environment/.test(inherited.error), JSON.stringify(inherited));
  assert.ok(!inherited.ok && !inherited.error.includes(sentinel));
  const selected = await resolve(profile({ inheritDefaults: false, selected: [{ source: "global", agent: "claude", name: "env-in-header" }] }), read);
  assert.ok(!selected.ok && !selected.error.includes(sentinel) && /reads DISPOSABLE_MCP_TOKEN/.test(selected.error));
});

test("a Codex answer missing its layers is a failed read, so an inherit-on launch refuses rather than dropping servers", async () => {
  const project = { name: { type: "project" }, config: { mcp_servers: { p: { command: "x" } } } };
  assert.equal(catalog.codexUserMcpTable({ config: {} }, true), "Codex did not report its configuration layers");
  assert.equal(catalog.codexUserMcpTable({ config: {} }, false), "Codex did not report its configuration layers");
  assert.equal(catalog.codexUserMcpTable({ config: {}, layers: [project] }, true), "Codex did not report its user configuration layer");
  assert.deepEqual(catalog.codexUserMcpTable({ config: {}, layers: [project] }, false), {}, "no user configuration file: no global servers");
  assert.deepEqual(catalog.codexUserMcpTable({ config: {}, layers: [{ name: { type: "user", file: "/u/config.toml" }, config: {} }] }, true), {});
  const failed: GlobalRead = { agent: "codex", servers: [], problem: "Codex did not report its configuration layers", readAt: 1 };
  const inherited = await resolve(profile({ agent: "codex" }), failed);
  assert.ok(!inherited.ok && /could not read Codex's global MCP servers: Codex did not report its configuration layers/.test(inherited.error));
});

test("Codex's catalog reads the raw user layer and refuses fields it cannot map, OAuth and env references", () => {
  const table = catalog.codexUserMcpTable({ config: {}, layers: [
    { name: { type: "project" }, config: { mcp_servers: { projectonly: { command: "x" } } } },
    { name: { type: "user", file: "/u/config.toml" }, config: { mcp_servers: {
      fs: { command: "fs-mcp", args: ["/tmp"], env: { FS_TOKEN: SECRET }, cwd: "/srv", startup_timeout_sec: 12, tool_timeout_sec: 30, enabled_tools: ["read"] },
      web: { url: "https://web.example.com/mcp", http_headers: { Authorization: `Bearer ${SECRET}` } },
      oauth: { url: "https://oauth.example.com/mcp" },
      refs: { command: "x", env_vars: ["HOME"] },
      bearer: { url: "https://b.example.com", bearer_token_env_var: "TOK" },
      off: { command: "x", enabled: false },
    } } },
  ] }, true);
  assert.ok(typeof table !== "string");
  assert.deepEqual(Object.keys(table), ["fs", "web", "oauth", "refs", "bearer", "off"], "only the user layer");
  const auth = new Map([["web", "bearer_token"], ["oauth", "o_auth"], ["bearer", "bearer_token"]]);
  const servers = Object.entries(table).map(([name, entry]) => catalog.parseCodexServer(name, entry, auth.get(name) ?? null));
  const [fs, web, oauth, refs, bearer, off] = servers;
  assert.equal(fs!.summary.unavailable, null);
  assert.deepEqual(fs!.options, { codex: { startupTimeoutSec: 12, toolTimeoutSec: 30, enabledTools: ["read"] } });
  assert.ok(fs!.transport?.type === "stdio" && fs!.transport.cwd === "/srv");
  assert.equal(web!.summary.unavailable, null);
  assert.equal(web!.secrets.get("header:Authorization"), `Bearer ${SECRET}`);
  assert.match(oauth!.summary.unavailable!, /OAuth login held by Codex/);
  assert.match(refs!.summary.unavailable!, /env_vars/);
  assert.match(bearer!.summary.unavailable!, /bearer_token_env_var/);
  assert.equal(off!.summary.enabled, false);
  assert.ok(!JSON.stringify(servers.map((server) => server.summary)).includes(SECRET));
  assert.match(catalog.parseCodexServer("web", { url: "https://x" }, undefined).summary.unavailable!, /could not say how it authenticates/);
});

// ---- the effective set ----

function globalsOf(agent: "claude" | "codex", servers: Record<string, unknown>): GlobalRead {
  const parse = agent === "claude"
    ? (name: string, entry: unknown) => catalog.parseClaudeServer(name, entry, {})
    : (name: string, entry: unknown) => catalog.parseCodexServer(name, entry, null);
  return { agent, servers: Object.entries(servers).map(([name, entry]) => parse(name, entry)), problem: null, readAt: 1 };
}

function profile(over: { agent?: "claude" | "codex"; inheritDefaults?: boolean; selected?: unknown[] } = {}) {
  return ResidentProfileRevisionSchema.parse({
    identity: { name: "MCP Bot" },
    persona: { personaId: "p" },
    execution: { agent: over.agent ?? "claude" },
    mcp: { inheritDefaults: over.inheritDefaults ?? true, selected: over.selected ?? [] },
  });
}

async function resolve(settings: ReturnType<typeof profile>, globals: GlobalRead) {
  return launch.resolveResidentMcpSet(settings, {
    globals: async () => globals,
    custom: mcpStore.listResidentMcpServers,
    customSecrets: mcpStore.customSecretValues,
  });
}

test("a global server both inherited and selected appears once; inherit off keeps only the selection", async () => {
  const globals = globalsOf("claude", { github: { command: "gh-mcp", env: { T: "1" } }, other: { command: "o" } });
  const both = await resolve(profile({ selected: [{ source: "global", agent: "claude", name: "github" }] }), globals);
  assert.ok(both.ok && both.servers);
  assert.deepEqual(both.servers.map((server) => [server.source, server.name, server.launcher]), [["global", "github", true], ["global", "other", true]]);
  const only = await resolve(profile({ inheritDefaults: false, selected: [{ source: "global", agent: "claude", name: "github" }] }), globals);
  assert.ok(only.ok && only.servers);
  assert.deepEqual(only.servers.map((server) => server.name), ["github"]);
  const none = await resolve(profile({ inheritDefaults: false }), globals);
  assert.ok(none.ok && none.servers && none.servers.length === 0, "Mission's server only");
});

test("a custom server named like a global server refuses the launch, even when the global appeared after the save", async () => {
  const view = create({ name: "linear", harnesses: ["claude"], transport: { type: "stdio", command: "l" } });
  const settings = profile({ inheritDefaults: false, selected: [{ source: "custom", id: view.id }] });
  assert.ok((await resolve(settings, globalsOf("claude", {}))).ok);
  const later = await resolve(settings, globalsOf("claude", { Linear: { command: "native-linear" } }));
  assert.ok(!later.ok && /same name as Claude Code's global server/.test(later.error), JSON.stringify(later));
});

test("an inherited server residents cannot represent refuses the launch, naming the field", async () => {
  const globals = globalsOf("claude", { fine: { command: "f" }, helper: { type: "http", url: "https://x", headersHelper: "h" } });
  const result = await resolve(profile(), globals);
  assert.ok(!result.ok && /helper is inherited but residents cannot use it: it uses headersHelper/.test(result.error), JSON.stringify(result));
  const disabled = globalsOf("codex", { off: { command: "x", enabled: false } });
  const skipped = await resolve(profile({ agent: "codex" }), disabled);
  assert.ok(skipped.ok && skipped.servers?.length === 0, "a natively disabled server is not a default");
});

test("secrets under one field name stay bound to their own (source, name)", async () => {
  const custom = create({ name: "custom-api", harnesses: ["claude"], transport: { type: "stdio", command: "c", env: [{ name: "API_TOKEN", secret: true, value: "custom-value" }] } });
  const result = await resolve(
    profile({ selected: [{ source: "custom", id: custom.id }] }),
    globalsOf("claude", { "global-api": { command: "g", env: { API_TOKEN: "global-value" } } }),
  );
  assert.ok(result.ok && result.servers);
  const byName = new Map(result.servers.map((server) => [server.name, server]));
  assert.equal(byName.get("global-api")!.secrets.get("env:API_TOKEN"), "global-value");
  assert.equal(byName.get("custom-api")!.secrets.get("env:API_TOKEN"), "custom-value");
  const unset = create({ name: "unset", harnesses: ["claude"], transport: { type: "stdio", command: "u", env: [{ name: "K", secret: true }] } });
  const refused = await resolve(profile({ selected: [{ source: "custom", id: unset.id }] }), globalsOf("claude", {}));
  assert.ok(!refused.ok && /no value for its secret K/.test(refused.error));
});

// ---- the snapshot, the entries and the tickets ----

function seedRun(runId: string, servers: Resolved[]): void {
  openDb().prepare(
    `INSERT INTO resident_runs (id, profile_id, profile_revision, task_id, launch_request_id, launch_input,
       launch_state, persona_snapshot, created_at) VALUES (?, 'p', 1, ?, ?, '{}', 'launched', '{}', 1)`,
  ).run(runId, `task-${runId}`, `req-${runId}`);
  mcpStore.writeRunMcpSnapshot(runId, servers, 1);
}

const GLOBAL_SERVER: Resolved = {
  source: "global", name: "foo.bar",
  transport: { type: "stdio", command: "/opt/private/bin/server", args: ["--root", "/srv/global-only-root"], env: {}, secretEnv: ["TOKEN"], cwd: "/srv" },
  launcher: true, options: { codex: { startupTimeoutSec: 5 } }, secrets: new Map([["env:TOKEN", SECRET]]),
};
const PLAIN_SERVER: Resolved = {
  source: "custom", name: "plain",
  transport: { type: "stdio", command: "plain-mcp", args: ["--x"], env: { MODE: "fast" }, secretEnv: [], cwd: null },
  launcher: false, options: {}, secrets: new Map(),
};
const HTTP_SERVER: Resolved = {
  source: "custom", name: "web",
  transport: { type: "http", url: "https://web.example.com/mcp", headers: { Accept: "x" }, secretHeaders: ["X-Key"], secretQuery: ["key"] },
  launcher: true, options: {}, secrets: new Map([["header:X-Key", `h-${SECRET}`], ["query:key", `q-${SECRET}`]]),
};

test("entries carry no secret: global and secret-bearing servers are launcher entries naming only identifiers", () => {
  const runId = crypto.randomUUID();
  seedRun(runId, [GLOBAL_SERVER, PLAIN_SERVER, HTTP_SERVER]);
  const resident = launch.residentMcpLaunchForRun(runId);
  assert.ok(resident);
  assert.deepEqual(resident.names, ["foo.bar", "plain", "web"]);
  const entries = resident.forStart();
  assert.deepEqual(entries[1], { name: "plain", options: {}, shape: "stdio", command: "plain-mcp", args: ["--x"], env: { MODE: "fast" } });
  for (const entry of [entries[0]!, entries[2]!]) {
    assert.equal(entry.shape, "launcher");
    if (entry.shape !== "launcher") continue;
    assert.deepEqual(entry.args.filter((_, at) => at % 2 === 1), ["--run", "--server", "--credential"], "only identifiers ride the arguments");
    assert.deepEqual(entry.args.slice(1, 5), ["--run", runId, "--server", entry.name]);
  }
  const rendered = JSON.stringify(entries);
  assert.ok(!rendered.includes(SECRET), "no secret value in any entry");
  assert.ok(!rendered.includes("/opt/private/bin/server") && !rendered.includes("global-only-root"), "a global server's definition stays daemon-private");
  // The credential file: owner-only, holding the ticket and its expiry.
  const credential = entries[0]!.shape === "launcher" ? entries[0]!.args.at(-1)! : "";
  assert.equal(statSync(credential).mode & 0o777, 0o600);
  const file = JSON.parse(readFileSync(credential, "utf8")) as { ticket: string; expiresAt: number; redeemUrl: string };
  assert.match(file.redeemUrl, /\/api\/residents\/mcp\/redeem$/);
  assert.ok(file.expiresAt - Date.now() <= launch.RESIDENT_MCP_TICKET_TTL_MS);
  // Each start mints its own tickets.
  const again = resident.forStart();
  assert.notEqual(again[0]!.shape === "launcher" && again[0]!.args.at(-1), credential);
});

test("a ticket is redeemed once, by its own server, before it expires, for that server's definition alone", () => {
  const runId = crypto.randomUUID();
  seedRun(runId, [GLOBAL_SERVER, HTTP_SERVER]);
  const entries = launch.residentMcpLaunchForRun(runId)!.forStart();
  const ticketOf = (index: number) => {
    const entry = entries[index]!;
    assert.equal(entry.shape, "launcher");
    const path = entry.shape === "launcher" ? entry.args.at(-1)! : "";
    return { path, ticket: (JSON.parse(readFileSync(path, "utf8")) as { ticket: string }).ticket };
  };
  const global = ticketOf(0);
  const http = ticketOf(1);
  assert.deepEqual(launch.redeemResidentMcpTicket({ ticket: global.ticket, runId, server: "web" }), { ok: false, status: 403, error: "this launch ticket belongs to another server" });
  assert.equal(existsSync(global.path), false, "a presented ticket is spent and its file removed");
  assert.deepEqual(launch.redeemResidentMcpTicket({ ticket: global.ticket, runId, server: "foo.bar" }), { ok: false, status: 403, error: "this launch ticket is unknown or already spent" });
  const expired = launch.redeemResidentMcpTicket({ ticket: http.ticket, runId, server: "web" }, Date.now() + launch.RESIDENT_MCP_TICKET_TTL_MS + 1);
  assert.deepEqual(expired, { ok: false, status: 403, error: "this launch ticket has expired" });
  const fresh = launch.residentMcpLaunchForRun(runId)!.forStart();
  const read = (index: number) => (JSON.parse(readFileSync(fresh[index]!.shape === "launcher" ? fresh[index]!.args.at(-1)! : "", "utf8")) as { ticket: string }).ticket;
  const stdio = launch.redeemResidentMcpTicket({ ticket: read(0), runId, server: "foo.bar" });
  assert.deepEqual(stdio, { ok: true, definition: { transport: "stdio", command: "/opt/private/bin/server", args: ["--root", "/srv/global-only-root"], env: { TOKEN: SECRET }, cwd: "/srv" } });
  const web = launch.redeemResidentMcpTicket({ ticket: read(1), runId, server: "web" });
  assert.ok(web.ok && web.definition.transport === "http");
  if (web.definition.transport === "http") {
    assert.equal(web.definition.url, `https://web.example.com/mcp?key=q-${SECRET}`);
    assert.deepEqual(web.definition.headers, { Accept: "x", "X-Key": `h-${SECRET}` });
  }
  // A run that ended starts nothing.
  const late = launch.residentMcpLaunchForRun(runId)!.forStart();
  openDb().prepare("UPDATE resident_runs SET ended_at = 2 WHERE id = ?").run(runId);
  const ended = launch.redeemResidentMcpTicket({ ticket: (JSON.parse(readFileSync(late[0]!.shape === "launcher" ? late[0]!.args.at(-1)! : "", "utf8")) as { ticket: string }).ticket, runId, server: "foo.bar" });
  assert.deepEqual(ended, { ok: false, status: 409, error: "this resident run has ended" });
});

test("a snapshot that lost a secret refuses to start that server rather than start it without", () => {
  const runId = crypto.randomUUID();
  seedRun(runId, [GLOBAL_SERVER]);
  openDb().prepare("DELETE FROM resident_run_mcp_secrets WHERE run_id = ?").run(runId);
  const entry = launch.residentMcpLaunchForRun(runId)!.forStart()[0]!;
  const ticket = (JSON.parse(readFileSync(entry.shape === "launcher" ? entry.args.at(-1)! : "", "utf8")) as { ticket: string }).ticket;
  const result = launch.redeemResidentMcpTicket({ ticket, runId, server: "foo.bar" });
  assert.ok(!result.ok && result.status === 409 && /no longer holds the secret TOKEN/.test(result.error));
});

test("editing, deleting or re-keying a custom server after launch never touches the run's snapshot", async () => {
  const view = create({ name: "api", harnesses: ["claude"], transport: { type: "stdio", command: "api-v1", env: [{ name: "K", secret: true, value: "v1" }] } });
  const resolved = await resolve(profile({ inheritDefaults: false, selected: [{ source: "custom", id: view.id }] }), globalsOf("claude", {}));
  assert.ok(resolved.ok && resolved.servers);
  const runId = crypto.randomUUID();
  seedRun(runId, resolved.servers);
  mcpStore.updateResidentMcpServer(view.id, {
    ...(CreateResidentMcpServerSchema.parse({ name: "api", harnesses: ["claude"], transport: { type: "stdio", command: "api-v2", env: [{ name: "K", secret: true, value: "v2" }] } }) as CreateInput),
    expectedRevision: 1,
  }, { at: 2, globals: NO_GLOBALS });
  mcpStore.deleteResidentMcpServer(view.id, 2);
  const entry = launch.residentMcpLaunchForRun(runId)!.forStart()[0]!;
  const ticket = (JSON.parse(readFileSync(entry.shape === "launcher" ? entry.args.at(-1)! : "", "utf8")) as { ticket: string }).ticket;
  assert.deepEqual(launch.redeemResidentMcpTicket({ ticket, runId, server: "api" }), {
    ok: true,
    definition: { transport: "stdio", command: "api-v1", args: [], env: { K: "v1" }, cwd: null },
  });
});

test("a database recovery point is scrubbed of every write-only secret", () => {
  create({ name: "scrub", harnesses: ["claude"], transport: { type: "stdio", command: "s", env: [{ name: "K", secret: true, value: SECRET }] } });
  seedRun(crypto.randomUUID(), [GLOBAL_SERVER]);
  const copy = join(home, `copy-${Date.now()}.sqlite3`);
  openDb().prepare("VACUUM INTO ?").run(copy);
  assert.ok(readFileSync(copy).includes(SECRET), "the raw copy holds it before the scrub");
  scrubWriteOnlySecrets(copy);
  assert.ok(!readFileSync(copy).includes(SECRET), "no byte of it survives, free pages included");
});

test("a recovery point redacts a global server's private definition, and a run restored from it refuses that server", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  // A credential in a form the argument guard does not recognize: only redaction protects it.
  const sentinel = `opaque-credential-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  seedRun(runId, [
    { ...GLOBAL_SERVER, name: "private-global", transport: { type: "stdio", command: "/opt/private/bin/opaque-server", args: ["--connect", sentinel], env: {}, secretEnv: [], cwd: null }, secrets: new Map() },
    PLAIN_SERVER,
  ]);
  const copy = join(home, `redact-${Date.now()}.sqlite3`);
  openDb().prepare("VACUUM INTO ?").run(copy);
  assert.ok(readFileSync(copy).includes(sentinel), "the raw copy holds it before the scrub");
  scrubWriteOnlySecrets(copy);
  const bytes = readFileSync(copy);
  assert.ok(!bytes.includes(sentinel) && !bytes.includes("opaque-server"), "neither the argument nor the command survives, free pages included");
  const restored = new DatabaseSync(copy);
  const rows = restored.prepare("SELECT source, name, definition_json FROM resident_run_mcp_servers WHERE run_id = ? ORDER BY position").all(runId) as Array<{ source: string; name: string; definition_json: string }>;
  restored.close();
  assert.deepEqual(rows.map((row) => [row.source, row.name, JSON.parse(row.definition_json).transport.type]), [["global", "private-global", "redacted"], ["custom", "plain", "stdio"]], "the rows stay, a custom server's non-secret definition is kept");
  // Restore that row into a live run: the server is not started without its definition.
  openDb().prepare("UPDATE resident_run_mcp_servers SET definition_json = ? WHERE run_id = ? AND name = ?").run(rows[0]!.definition_json, runId, "private-global");
  const entries = launch.residentMcpLaunchForRun(runId)!.forStart();
  assert.equal(entries[0]!.shape, "launcher", "a redacted server still renders only as a launcher entry");
  const ticket = (JSON.parse(readFileSync(entries[0]!.shape === "launcher" ? entries[0]!.args.at(-1)! : "", "utf8")) as { ticket: string }).ticket;
  const redeemed = launch.redeemResidentMcpTicket({ ticket, runId, server: "private-global" });
  assert.ok(!redeemed.ok && redeemed.status === 409 && /launch the resident again/.test(redeemed.error));
});

// ---- through the manager ----

const PERSONA: Persona = {
  id: "persona-mcp", name: "MCP Persona", normalizedName: "mcp persona", description: "", guidanceMarkdown: "You use tools.",
  runner: null, model: null, revision: 1, archivedAt: null, createdAt: 0, updatedAt: 0, provenance: null, builtin: false,
};

function manager(reader: GlobalReader) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  (tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } }).dispatcher = {
    async dispatch(id) {
      const task = registry.getTask(id)!;
      upsertSdkSession({
        id: `sdk-${id}`, agent: task.agent, agentSessionId: null, cwd: `/worktrees/${id}`, taskId: id,
        model: task.model, effort: task.effort, permissionMode: null, status: "starting", turnInProgress: true,
      });
      registry.upsertTask({ ...task, status: "running", sessionId: `sdk-${id}` });
    },
  };
  const residents = new ResidentManager({
    registry,
    createTask: (input, internal) => tasks.create(input, internal, RESIDENT_LAUNCH_TASK_CREATE),
    persona: (id) => (id === PERSONA.id ? PERSONA : null),
    resolveRepoRoot: async (path) => ({ ok: true as const, repoRoot: path }),
    mcpCatalog: new catalog.ResidentMcpCatalogCache(reader),
  });
  residents.start();
  managers.push(residents);
  return { registry, residents };
}

test("a launch snapshots its set once, the composer reads it back, and the run's end removes it", async () => {
  let globals: Record<string, unknown> = { github: { command: "gh", env: { T: SECRET } } };
  const { registry, residents } = manager(async (agent) => globalsOf(agent, globals));
  const created = residents.createProfile(ResidentProfileRevisionSchema.parse({ identity: { name: "Snap" }, persona: { personaId: PERSONA.id } }));
  assert.ok(created.ok);
  const outcome = await residents.launch(created.profile.id, { repoRoot: null, requestId: "mcp-snapshot" });
  if (!("result" in outcome) || outcome.result.state !== "launched") assert.fail(JSON.stringify(outcome));
  const task = registry.getTask(outcome.result.taskId)!;
  // A global server added after launch never joins the run.
  globals = { ...globals, added: { command: "new" } };
  assert.deepEqual(residents.mcpLaunchForTask(task)?.names, ["github"]);
  assert.ok(!JSON.stringify(outcome.result).includes(SECRET), "the launch answer carries no snapshot");
  const runId = outcome.result.run.id;
  launch.residentMcpLaunchForRun(runId)!.forStart();
  assert.ok(existsSync(launch.residentMcpRunDir(runId)));
  registry.upsertTask({ ...task, status: "done" });
  openDb().prepare("UPDATE sdk_sessions SET status = 'exited' WHERE task_id = ?").run(task.id);
  await residents.reconcileRunEnds();
  assert.equal(mcpStore.runMcpSnapshot(runId)?.length, 0, "rows removed; the marker keeps it off native MCP");
  assert.equal(existsSync(launch.residentMcpRunDir(runId)), false);
});

test("a launch whose set cannot be pinned fails with the reason and starts nothing", async () => {
  const { residents } = manager(async (agent) => globalsOf(agent, { helper: { type: "http", url: "https://x", headersHelper: "h" } }));
  const created = residents.createProfile(ResidentProfileRevisionSchema.parse({ identity: { name: "Refused" }, persona: { personaId: PERSONA.id } }));
  assert.ok(created.ok);
  const outcome = await residents.launch(created.profile.id, { repoRoot: null, requestId: "mcp-refused" });
  if (!("result" in outcome) || outcome.result.state !== "failed") assert.fail(JSON.stringify(outcome));
  assert.match(outcome.result.error, /helper is inherited but residents cannot use it/);
  assert.equal(mcpStore.runMcpSnapshot(outcome.result.run.id), null, "no snapshot, no secret bound");
});

test("a profile cannot save a selection another harness owns or a custom server that does not apply", () => {
  const { residents } = manager(catalog.noGlobalMcp);
  const codexOnly = create({ name: "codex-only", harnesses: ["codex"], transport: { type: "stdio", command: "c" } });
  const mismatch = residents.createProfile(ResidentProfileRevisionSchema.parse({
    identity: { name: "Mismatch" }, persona: { personaId: PERSONA.id },
    mcp: { selected: [{ source: "global", agent: "codex", name: "fs" }] },
  }));
  assert.ok(!mismatch.ok && /Codex's, but this profile runs Claude Code/.test(mismatch.error));
  const notApplicable = residents.createProfile(ResidentProfileRevisionSchema.parse({
    identity: { name: "Wrong harness" }, persona: { personaId: PERSONA.id },
    mcp: { selected: [{ source: "custom", id: codexOnly.id }] },
  }));
  assert.ok(!notApplicable.ok && /does not apply to Claude Code/.test(notApplicable.error));
});

test("a custom server's name is checked against global servers as they are now, not as cached", async () => {
  let globals: Record<string, unknown> = {};
  const { residents } = manager(async (agent) => globalsOf(agent, agent === "claude" ? globals : {}));
  await residents.mcpServerCatalog();
  globals = { linear: { command: "native-linear" } };
  await assert.rejects(
    residents.createMcpServer(CreateResidentMcpServerSchema.parse({ name: "linear", harnesses: ["claude"], transport: { type: "stdio", command: "l" } }) as CreateInput),
    /Claude Code already has a global MCP server named linear/,
  );
  const other = await residents.createMcpServer(CreateResidentMcpServerSchema.parse({ name: "other", harnesses: ["claude"], transport: { type: "stdio", command: "o" } }) as CreateInput);
  globals = { ...globals, renamed: { command: "native" } };
  await assert.rejects(
    residents.updateMcpServer(other.id, { ...(CreateResidentMcpServerSchema.parse({ name: "renamed", harnesses: ["claude"], transport: { type: "stdio", command: "o" } }) as CreateInput), expectedRevision: 1 }),
    /Claude Code already has a global MCP server named renamed/,
  );
});

test("a preview renders the same servers without minting a credential", () => {
  const runId = crypto.randomUUID();
  seedRun(runId, [GLOBAL_SERVER, PLAIN_SERVER]);
  const resident = launch.residentMcpLaunchForRun(runId)!;
  const preview = resident.preview();
  assert.deepEqual(preview.map((entry) => entry.name), ["foo.bar", "plain"]);
  assert.equal(preview[0]!.shape === "launcher" && preview[0]!.args.at(-1), "unissued");
  assert.equal(existsSync(join(launch.residentMcpRunDir(runId), "credentials")), false, "nothing written, nothing to expire");
});

test("startup removes every credential file a previous process left", () => {
  const runId = crypto.randomUUID();
  const dir = join(launch.residentMcpRunDir(runId), "credentials");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stale.json"), JSON.stringify({ ticket: "x", expiresAt: Date.now() + 60_000 }));
  manager(catalog.noGlobalMcp);
  assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0);
});

test("the startup sweep keeps a credential this daemon already issued", () => {
  const runId = crypto.randomUUID();
  seedRun(runId, [GLOBAL_SERVER]);
  const entry = launch.residentMcpLaunchForRun(runId)!.forStart()[0]!;
  const issued = entry.shape === "launcher" ? entry.args.at(-1)! : "";
  const stale = join(launch.residentMcpRunDir(runId), "credentials", "stale.json");
  writeFileSync(stale, "{}");
  launch.sweepResidentMcpCredentials();
  assert.equal(existsSync(issued), true, "a restored resident starting before the sweep keeps its ticket");
  assert.equal(existsSync(stale), false);
});
