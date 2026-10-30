import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import {
  RESIDENT_MCP_RESERVED_NAME,
  credentialArgumentProblem,
  credentialFormArgs,
  plaintextCredentialProblem,
  residentMcpGlobalNameProblem,
  residentMcpSecretField,
  type ResidentMcpCatalog,
  type ResidentMcpGlobalServer,
  type ResidentMcpHarnessCatalog,
} from "@shared/resident-mcp.ts";
import { RESIDENT_AGENTS, type ResidentAgent } from "@shared/residents.ts";
import type { ResidentMcpOptions } from "../harness/types.ts";
import { operatorCodexHome } from "../harness/codex/resident-home.ts";
import { ResidentMcpServerError, type ResidentMcpSnapshotTransport } from "./mcp-store.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";

// The global MCP catalog: each harness's own user-scope servers, read on demand.
//
// Two projections of one read, and they never mix:
//
// - `ResidentMcpGlobalServer` is what the browser sees - allowlisted metadata, never a value.
// - `GlobalMcpDefinition` is what a launch copies into a run's daemon-private snapshot: the
//   whole definition, every environment and header value treated as a secret. It never leaves
//   the daemon except to that one server's own process, through the scoped launcher.
//
// Mission Control's own entry is hidden. Nothing here writes harness configuration.

/** A global server as a launch copies it. Daemon-only. */
export interface GlobalMcpDefinition {
  summary: ResidentMcpGlobalServer;
  /** Null when `summary.unavailable` says why it cannot be represented. */
  transport: ResidentMcpSnapshotTransport | null;
  /** Every environment, header and query value, by secrets-table field. */
  secrets: ReadonlyMap<string, string>;
  options: ResidentMcpOptions;
}

export interface GlobalMcpRead {
  agent: ResidentAgent;
  servers: GlobalMcpDefinition[];
  problem: string | null;
  readAt: number;
}

/** How a harness's global servers are read; injectable so a test never reads real configuration. */
export type GlobalMcpReader = (agent: ResidentAgent) => Promise<GlobalMcpRead>;

const PLAIN = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : null;
}

function stringMap(value: unknown): Record<string, string> | null {
  if (!PLAIN(value)) return null;
  return Object.values(value).every((item) => typeof item === "string") ? value as Record<string, string> : null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** What a global server shows when its definition cannot be read at all. */
function unreadable(name: string, transport: ResidentMcpGlobalServer["transport"], reason: string): GlobalMcpDefinition {
  return {
    summary: { name, transport, commandBasename: null, urlOrigin: null, envNames: [], headerNames: [], enabled: true, unavailable: reason },
    transport: null,
    secrets: new Map(),
    options: {},
  };
}

/**
 * Split an HTTP URL into its query-less form and secret query values, turning userinfo into the
 * Basic authorization it means in HTTP. Every value lands in `secrets`.
 */
function splitUrl(raw: string, headers: Record<string, string>, secrets: Map<string, string>): { url: string; secretQuery: string[] } | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "its URL is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `its URL uses ${url.protocol.replace(/:$/, "")}`;
  if (url.username || url.password) {
    if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
      return "its URL carries a user name or password and it also sets an Authorization header";
    }
    const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    url.username = "";
    url.password = "";
  }
  const secretQuery: string[] = [];
  for (const [name, value] of url.searchParams) {
    if (secretQuery.includes(name)) return `its URL repeats the query parameter ${name}`;
    secretQuery.push(name);
    secrets.set(residentMcpSecretField("query", name), value);
  }
  url.search = "";
  url.hash = "";
  return { url: url.toString(), secretQuery };
}

function summaryOf(
  name: string,
  transport: ResidentMcpSnapshotTransport,
  enabled: boolean,
  unavailable: string | null,
): ResidentMcpGlobalServer {
  return transport.type === "stdio"
    ? {
        name,
        transport: "stdio",
        commandBasename: basename(transport.command) || null,
        urlOrigin: null,
        envNames: [...transport.secretEnv],
        headerNames: [],
        enabled,
        unavailable,
      }
    : {
        name,
        transport: transport.type,
        commandBasename: null,
        urlOrigin: originOf(transport.url),
        envNames: [],
        headerNames: [...transport.secretHeaders],
        enabled,
        unavailable,
      };
}

// ---- Claude Code: user-scope `mcpServers` in `.claude.json` ----

/** Where Claude Code keeps its user-scope configuration: `$CLAUDE_CONFIG_DIR` or the home. */
export function claudeUserConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
}

const CLAUDE_STDIO_FIELDS = new Set(["type", "command", "args", "env", "timeout", "alwaysLoad"]);
const CLAUDE_HTTP_FIELDS = new Set(["type", "url", "headers", "timeout", "alwaysLoad"]);
const EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type Expansion = { value: string } | { missing: string } | { inherited: string };

/**
 * Claude Code expands `${VAR}` and `${VAR:-default}` from its own environment, which is the
 * daemon's - and the resident's agent inherits that same environment, so a value read from it is
 * already readable by every shell the agent runs. Such a server is never private to its own
 * process, so a reference to a variable that is set makes it unavailable (`inherited`). A
 * reference to an unset variable with a default is the literal default, which nothing else holds.
 */
function expand(value: string, env: NodeJS.ProcessEnv): Expansion {
  let missing: string | null = null;
  let inherited: string | null = null;
  const out = value.replace(EXPANSION, (_match, name: string, fallback: string | undefined) => {
    if (env[name] !== undefined) {
      inherited ??= name;
      return "";
    }
    if (fallback !== undefined) return fallback;
    missing ??= name;
    return "";
  });
  if (inherited) return { inherited };
  return missing ? { missing } : { value: out };
}

/** Why an expansion cannot be snapshotted, naming the variable and never its value. */
function expansionProblem(result: Exclude<Expansion, { value: string }>): string {
  return "inherited" in result
    ? `it reads ${result.inherited} from the environment, which the resident's agent inherits too; define it as a custom server with a secret instead`
    : `it references the unset environment variable ${result.missing}`;
}

function claudeOptions(entry: Record<string, unknown>): ResidentMcpOptions | string {
  const claude: NonNullable<ResidentMcpOptions["claude"]> = {};
  if (entry.timeout !== undefined) {
    if (typeof entry.timeout !== "number" || !Number.isFinite(entry.timeout) || entry.timeout <= 0) return "its timeout is not a positive number";
    claude.timeoutMs = entry.timeout;
  }
  if (entry.alwaysLoad !== undefined) {
    if (typeof entry.alwaysLoad !== "boolean") return "its alwaysLoad is not true or false";
    claude.alwaysLoad = entry.alwaysLoad;
  }
  return Object.keys(claude).length > 0 ? { claude } : {};
}

/** Parse one Claude Code server entry into a snapshot definition, or the reason it cannot be. */
export function parseClaudeServer(name: string, entry: unknown, env: NodeJS.ProcessEnv = process.env): GlobalMcpDefinition {
  const badName = residentMcpGlobalNameProblem(name);
  if (badName) return unreadable(name, "stdio", badName);
  if (!PLAIN(entry)) return unreadable(name, "stdio", "its configuration is not an object");
  const type = entry.type ?? "stdio";
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    return unreadable(name, "stdio", `its transport ${String(type)} cannot be started by a resident`);
  }
  const allowed = type === "stdio" ? CLAUDE_STDIO_FIELDS : CLAUDE_HTTP_FIELDS;
  const unknownField = Object.keys(entry).find((key) => !allowed.has(key));
  const secrets = new Map<string, string>();
  const expanded = (value: string): string | Exclude<Expansion, { value: string }> => {
    const result = expand(value, env);
    return "value" in result ? result.value : result;
  };
  let transport: ResidentMcpSnapshotTransport;
  let problem: string | null = unknownField ? `it uses ${unknownField}, which residents cannot carry` : null;
  if (type === "stdio") {
    if (typeof entry.command !== "string" || !entry.command) return unreadable(name, "stdio", "it has no command");
    const args = entry.args === undefined ? [] : strings(entry.args);
    const envTable = entry.env === undefined ? {} : stringMap(entry.env);
    if (!args) return unreadable(name, "stdio", "its args are not a list of strings");
    if (!envTable) return unreadable(name, "stdio", "its env is not a table of strings");
    const resolved: string[] = [];
    let command = entry.command;
    for (const [index, raw] of [entry.command, ...args].entries()) {
      const value = expanded(raw);
      if (typeof value !== "string") {
        problem ??= expansionProblem(value);
        continue;
      }
      if (index === 0) command = value;
      else resolved.push(value);
    }
    for (const [key, raw] of Object.entries(envTable)) {
      const value = expanded(raw);
      if (typeof value !== "string") problem ??= expansionProblem(value);
      else secrets.set(residentMcpSecretField("env", key), value);
    }
    const found = credentialFormArgs(resolved);
    if (found) problem ??= credentialArgumentProblem(found);
    transport = { type: "stdio", command, args: resolved, env: {}, secretEnv: Object.keys(envTable), cwd: null };
  } else {
    if (typeof entry.url !== "string" || !entry.url) return unreadable(name, type, "it has no URL");
    const headerTable = entry.headers === undefined ? {} : stringMap(entry.headers);
    if (!headerTable) return unreadable(name, type, "its headers are not a table of strings");
    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(headerTable)) {
      const value = expanded(raw);
      if (typeof value !== "string") problem ??= expansionProblem(value);
      else headers[key] = value;
    }
    const url = expanded(entry.url);
    if (typeof url !== "string") return unreadable(name, type, expansionProblem(url));
    const split = splitUrl(url, headers, secrets);
    if (typeof split === "string") return unreadable(name, type, split);
    for (const [key, value] of Object.entries(headers)) secrets.set(residentMcpSecretField("header", key), value);
    if (Object.keys(headers).length > 0 || split.secretQuery.length > 0) problem ??= plaintextCredentialProblem(new URL(split.url));
    transport = { type, url: split.url, headers: {}, secretHeaders: Object.keys(headers), secretQuery: split.secretQuery };
  }
  const options = claudeOptions(entry);
  if (typeof options === "string") problem ??= options;
  return {
    summary: summaryOf(name, transport, true, problem),
    transport: problem ? null : transport,
    secrets: problem ? new Map() : secrets,
    options: typeof options === "string" ? {} : options,
  };
}

/** Claude Code's user-scope servers. A missing file means none. */
export function readClaudeGlobalMcp(path = claudeUserConfigPath(), env: NodeJS.ProcessEnv = process.env, now = Date.now()): GlobalMcpRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { agent: "claude", servers: [], problem: null, readAt: now };
    return { agent: "claude", servers: [], problem: `could not read ${path}`, readAt: now };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { agent: "claude", servers: [], problem: `${path} is not valid JSON`, readAt: now };
  }
  const table = PLAIN(parsed) ? parsed.mcpServers : undefined;
  if (table === undefined) return { agent: "claude", servers: [], problem: null, readAt: now };
  if (!PLAIN(table)) return { agent: "claude", servers: [], problem: `mcpServers in ${path} is not an object`, readAt: now };
  const servers = Object.entries(table)
    .filter(([name]) => name !== RESIDENT_MCP_RESERVED_NAME)
    .map(([name, entry]) => parseClaudeServer(name, entry, env));
  return { agent: "claude", servers, problem: null, readAt: now };
}

// ---- Codex: the user configuration layer, as Codex itself reads it ----

const CODEX_COMMON_FIELDS = new Set([
  "enabled", "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec", "enabled_tools", "disabled_tools",
]);
const CODEX_STDIO_FIELDS = new Set([...CODEX_COMMON_FIELDS, "command", "args", "env", "cwd"]);
const CODEX_HTTP_FIELDS = new Set([...CODEX_COMMON_FIELDS, "url", "http_headers"]);

function seconds(value: unknown): number | null | string {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "is not a positive number";
  return value;
}

function codexOptions(entry: Record<string, unknown>): ResidentMcpOptions | string {
  const codex: NonNullable<ResidentMcpOptions["codex"]> = {};
  const startup = seconds(entry.startup_timeout_sec);
  const startupMs = seconds(entry.startup_timeout_ms);
  const tool = seconds(entry.tool_timeout_sec);
  if (typeof startup === "string") return `its startup_timeout_sec ${startup}`;
  if (typeof startupMs === "string") return `its startup_timeout_ms ${startupMs}`;
  if (typeof tool === "string") return `its tool_timeout_sec ${tool}`;
  if (startup !== null) codex.startupTimeoutSec = startup;
  else if (startupMs !== null) codex.startupTimeoutSec = startupMs / 1000;
  if (tool !== null) codex.toolTimeoutSec = tool;
  for (const [field, key] of [["enabled_tools", "enabledTools"], ["disabled_tools", "disabledTools"]] as const) {
    if (entry[field] === undefined) continue;
    const list = strings(entry[field]);
    if (!list) return `its ${field} is not a list of strings`;
    codex[key] = list;
  }
  return Object.keys(codex).length > 0 ? { codex } : {};
}

/**
 * Parse one entry of Codex's user `mcp_servers` table, as `config/read` returns the raw layer.
 * `authStatus` is `codex mcp list --json`'s answer, the one place Codex says it holds an OAuth
 * login for the server, which the launcher's bridge cannot perform.
 */
export function parseCodexServer(name: string, entry: unknown, authStatus: string | null | undefined): GlobalMcpDefinition {
  const badName = residentMcpGlobalNameProblem(name);
  if (badName) return unreadable(name, "stdio", badName);
  if (!PLAIN(entry)) return unreadable(name, "stdio", "its configuration is not a table");
  const http = entry.url !== undefined;
  const allowed = http ? CODEX_HTTP_FIELDS : CODEX_STDIO_FIELDS;
  const unknownField = Object.keys(entry).find((key) => !allowed.has(key));
  let problem: string | null = unknownField ? `it uses ${unknownField}, which residents cannot carry` : null;
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") return unreadable(name, http ? "http" : "stdio", "its enabled is not true or false");
  const enabled = entry.enabled !== false;
  const secrets = new Map<string, string>();
  let transport: ResidentMcpSnapshotTransport;
  if (http) {
    if (typeof entry.url !== "string" || !entry.url) return unreadable(name, "http", "its url is not a string");
    const headerTable = entry.http_headers === undefined ? {} : stringMap(entry.http_headers);
    if (!headerTable) return unreadable(name, "http", "its http_headers are not a table of strings");
    const headers = { ...headerTable };
    const split = splitUrl(entry.url, headers, secrets);
    if (typeof split === "string") return unreadable(name, "http", split);
    for (const [key, value] of Object.entries(headers)) secrets.set(residentMcpSecretField("header", key), value);
    if (Object.keys(headers).length > 0 || split.secretQuery.length > 0) problem ??= plaintextCredentialProblem(new URL(split.url));
    if (authStatus === undefined) problem ??= "Codex could not say how it authenticates to this server";
    else if (authStatus === "o_auth") problem ??= "it uses an OAuth login held by Codex";
    transport = { type: "http", url: split.url, headers: {}, secretHeaders: Object.keys(headers), secretQuery: split.secretQuery };
  } else {
    if (typeof entry.command !== "string" || !entry.command) return unreadable(name, "stdio", "it has no command");
    const args = entry.args === undefined ? [] : strings(entry.args);
    const envTable = entry.env === undefined ? {} : stringMap(entry.env);
    if (!args) return unreadable(name, "stdio", "its args are not a list of strings");
    if (!envTable) return unreadable(name, "stdio", "its env is not a table of strings");
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") return unreadable(name, "stdio", "its cwd is not a string");
    for (const [key, value] of Object.entries(envTable)) secrets.set(residentMcpSecretField("env", key), value);
    const found = credentialFormArgs(args);
    if (found) problem ??= credentialArgumentProblem(found);
    transport = {
      type: "stdio",
      command: entry.command,
      args: [...args],
      env: {},
      secretEnv: Object.keys(envTable),
      cwd: typeof entry.cwd === "string" ? entry.cwd : null,
    };
  }
  const options = codexOptions(entry);
  if (typeof options === "string") problem ??= options;
  if (!enabled) problem ??= "Codex's own configuration disables it";
  return {
    summary: summaryOf(name, transport, enabled, problem),
    transport: problem ? null : transport,
    secrets: problem ? new Map() : secrets,
    options: typeof options === "string" ? {} : options,
  };
}

/**
 * The user layer's raw `mcp_servers` table from a `config/read` answer, or why it cannot be read.
 *
 * An answer without its layers, or without the user layer while the user configuration file
 * exists, is a failed read rather than "no servers": treating it as empty would let an inherit-on
 * launch silently drop every global server and snapshot that omission. Only a user
 * configuration that does not exist means there are none.
 */
export function codexUserMcpTable(result: unknown, userConfigExists: boolean): Record<string, unknown> | string {
  if (!PLAIN(result)) return "Codex answered config/read with something that is not an object";
  if (!Array.isArray(result.layers)) return "Codex did not report its configuration layers";
  const user = result.layers.find((layer) => PLAIN(layer) && PLAIN(layer.name) && layer.name.type === "user");
  if (!PLAIN(user)) return userConfigExists ? "Codex did not report its user configuration layer" : {};
  const config = user.config;
  if (!PLAIN(config) || config.mcp_servers === undefined) return {};
  return PLAIN(config.mcp_servers) ? config.mcp_servers : "mcp_servers in Codex's configuration is not a table";
}

/** `codex mcp list --json`'s auth status per server name, or null when the list cannot be read. */
export function codexAuthStatuses(stdout: string): Map<string, string | null> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    return new Map(parsed.flatMap((row) => PLAIN(row) && typeof row.name === "string"
      ? [[row.name, typeof row.auth_status === "string" ? row.auth_status : null] as const]
      : []));
  } catch {
    return null;
  }
}

/**
 * Read Codex's user-scope servers the way Codex reads them: its app-server's `config/read`, in a
 * neutral working directory so no project layer joins, plus `codex mcp list --json` for the
 * OAuth state. Neither starts an MCP server.
 */
export async function readCodexGlobalMcp(now = Date.now()): Promise<GlobalMcpRead> {
  const fail = (problem: string): GlobalMcpRead => ({ agent: "codex", servers: [], problem, readAt: now });
  const [{ codexExecutable, spawnAppServer }, { AppServerClient }, { agentSubprocessEnv }] = await Promise.all([
    import("../harness/codex/sdk-deps.ts"),
    import("../harness/codex/app-server/client.ts"),
    import("../agent-subprocess-env.ts"),
  ]);
  let executable: string;
  try {
    executable = await codexExecutable();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const neutral = mkdtempSync(join(tmpdir(), "mission-mcp-catalog-"));
  try {
    const env = agentSubprocessEnv(process.env, { stateHome: neutral });
    const client = new AppServerClient(spawnAppServer(executable, [], neutral, env), {
      request: () => {},
      notification: () => {},
    });
    const pumping = client.pump().catch(() => {});
    let table: Record<string, unknown> | string;
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 15_000).unref());
      await Promise.race([
        client.request("initialize", { clientInfo: { name: "mission_control_mcp_catalog", version: "1" }, capabilities: { experimentalApi: true } }),
        timeout,
      ]);
      const answer = await Promise.race([client.request("config/read", { cwd: neutral, includeLayers: true }), timeout]);
      table = codexUserMcpTable(answer, existsSync(join(operatorCodexHome(), "config.toml")));
    } catch (error) {
      return fail(`could not read Codex's configuration: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.close().catch(() => {});
      await pumping;
    }
    if (typeof table === "string") return fail(table);
    const http = Object.values(table).some((entry) => PLAIN(entry) && entry.url !== undefined);
    const statuses = http
      ? await new Promise<Map<string, string | null> | null>((resolve) => {
          execFile(executable, ["mcp", "list", "--json"], { cwd: neutral, env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            resolve(error ? null : codexAuthStatuses(stdout));
          });
        })
      : new Map<string, string | null>();
    const servers = Object.entries(table)
      .filter(([name]) => name !== RESIDENT_MCP_RESERVED_NAME)
      .map(([name, entry]) => parseCodexServer(name, entry, statuses === null ? undefined : statuses.get(name)));
    return { agent: "codex", servers, problem: null, readAt: now };
  } finally {
    rmSync(neutral, { recursive: true, force: true });
  }
}

/** The production readers. */
export const readGlobalMcp: GlobalMcpReader = async (agent) => {
  if (agent === "claude") return readClaudeGlobalMcp();
  if (agent === "codex") return readCodexGlobalMcp();
  // A harness without a reader here has no global servers to offer; never another harness's.
  return { agent, servers: [], problem: null, readAt: Date.now() };
};

/** No global servers at all: what a manager constructed without a reader sees. */
export const noGlobalMcp: GlobalMcpReader = async (agent) => ({ agent, servers: [], problem: null, readAt: Date.now() });

/**
 * The catalog with a cache: reads on demand, keeps the last answer per harness, and re-reads on
 * refresh. A launch always reads fresh, because it copies the definitions it sees.
 */
export class ResidentMcpCatalogCache {
  private readonly cached = new Map<ResidentAgent, GlobalMcpRead>();
  private readonly reading = new Map<ResidentAgent, Promise<GlobalMcpRead>>();

  constructor(private readonly reader: GlobalMcpReader) {}

  /** Read one harness's servers; a concurrent request joins the read in flight. */
  read(agent: ResidentAgent, fresh = false): Promise<GlobalMcpRead> {
    const hit = this.cached.get(agent);
    if (hit && !fresh) return Promise.resolve(hit);
    const inFlight = this.reading.get(agent);
    if (inFlight) return inFlight;
    const read = this.reader(agent)
      .catch((error: unknown): GlobalMcpRead => ({
        agent,
        servers: [],
        problem: error instanceof Error ? error.message : String(error),
        readAt: Date.now(),
      }))
      .then((value) => {
        this.cached.set(agent, value);
        return value;
      })
      .finally(() => this.reading.delete(agent));
    this.reading.set(agent, read);
    return read;
  }

  /**
   * Global names per harness, lower-cased, for the custom-server collision check. Read fresh by
   * default: a global server added since the catalog was cached must still block the name.
   */
  async names(agents: readonly ResidentAgent[] = RESIDENT_AGENTS, fresh = true): Promise<Map<ResidentAgent, Set<string>>> {
    // Only the harnesses a custom server applies to: another harness's read cannot block it.
    const reads = await Promise.all(agents.map((agent) => this.read(agent, fresh)));
    // A read that failed knows no names, which is not the same as there being none.
    const failed = reads.find((read) => read.problem);
    if (failed) {
      throw new ResidentMcpServerError(
        `could not read ${AGENT_IDENTITY[failed.agent].label}'s global MCP servers to check this name (${failed.problem}); try again`,
        503,
      );
    }
    return new Map(reads.map((read) => [read.agent, new Set(read.servers.map((server) => server.summary.name.toLowerCase()))]));
  }

  /** The browser's catalog: metadata only. */
  async catalog(custom: ResidentMcpCatalog["custom"], fresh = false): Promise<ResidentMcpCatalog> {
    const harnesses: ResidentMcpHarnessCatalog[] = await Promise.all(RESIDENT_AGENTS.map(async (agent) => {
      const read = await this.read(agent, fresh);
      return {
        agent,
        selectable: capabilitiesFor(agent).mcpSelection !== null,
        servers: read.servers.map((server) => server.summary),
        problem: read.problem,
        readAt: read.readAt,
      };
    }));
    return { harnesses, custom };
  }
}
