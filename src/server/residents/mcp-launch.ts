import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { BASE_URL } from "@shared/harness-runtime.mjs";
import {
  residentMcpSecretField,
  type ResidentMcpCredentialFile,
  type ResidentMcpCustomServer,
  type ResidentMcpLauncherDefinition,
} from "@shared/resident-mcp.ts";
import type { ResidentProfileRevision } from "@shared/residents.ts";
import { STATE_DIR, residentMcpLauncherPath } from "../config.ts";
import type { ResidentMcpEntry, ResidentMcpLaunch } from "../harness/types.ts";
import { resolveMissionMcpRuntime } from "../mission-mcp.ts";
import type { GlobalMcpDefinition, GlobalMcpRead } from "./mcp-catalog.ts";
import {
  removeRunMcpSnapshot,
  residentRunIsOpen,
  runMcpSecretValues,
  runMcpSnapshot,
  type ResidentMcpResolvedServer,
  type StoredMcpSnapshotServer,
} from "./mcp-store.ts";

// A resident run's MCP servers, from launch to the server process.
//
// 1. `resolveResidentMcpSet` resolves the run's effective set ONCE, at launch, keyed by
//    (source, name), refusing collisions and unrepresentable servers before any secret is
//    bound. The caller writes it as the run's snapshot.
// 2. `residentMcpLaunchForRun` turns the snapshot into `SdkLaunchOptions.residentMcp`, read at
//    every launch and resume. Native MCP configuration is never read again.
// 3. Per process start, `forStart()` writes one owner-only credential file per launcher entry,
//    holding a single-use ticket bound to that run, that server and that start.
// 4. The scoped launcher reads its file, removes it, and redeems the ticket here
//    (`redeemResidentMcpTicket`) for that one server's definition and secrets.

/** How long a ticket may wait for its launcher: a start reads its configuration within seconds. */
export const RESIDENT_MCP_TICKET_TTL_MS = 30_000;

const RUN_ID = /^[a-zA-Z0-9-]+$/;

/** The run's private MCP directory: its credential files and, for Codex, its overlay home. */
export function residentMcpRunDir(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error("invalid resident run id");
  return join(residentMcpRoot(), runId);
}

function residentMcpRoot(): string {
  return join(realpathSync(STATE_DIR), "residents", "mcp");
}

// ---- 1. the effective set ----

export interface ResidentMcpResolveDeps {
  /** The harness's global servers as they are now: a launch copies what it reads. */
  globals(agent: ResidentProfileRevision["execution"]["agent"]): Promise<GlobalMcpRead>;
  custom(): ResidentMcpCustomServer[];
  customSecrets(serverId: string): ReadonlyMap<string, string>;
}

export type ResidentMcpResolution =
  | { ok: true; servers: ResidentMcpResolvedServer[] | null }
  | { ok: false; error: string };

function resolvedGlobal(definition: GlobalMcpDefinition): ResidentMcpResolvedServer {
  return {
    source: "global",
    name: definition.summary.name,
    transport: definition.transport!,
    launcher: true,
    options: definition.options,
    secrets: definition.secrets,
  };
}

function resolvedCustom(server: ResidentMcpCustomServer, secrets: ReadonlyMap<string, string>): ResidentMcpResolvedServer | string {
  const bound = new Map<string, string>();
  const need = (field: string, label: string): string | null => {
    const value = secrets.get(field);
    if (value === undefined) return `the custom MCP server ${server.name} has no value for its secret ${label}`;
    bound.set(field, value);
    return null;
  };
  if (server.transport.type === "stdio") {
    const env: Record<string, string> = {};
    const secretEnv: string[] = [];
    for (const row of server.transport.env) {
      if (!row.secret) env[row.name] = row.value;
      else {
        const missing = need(residentMcpSecretField("env", row.name), row.name);
        if (missing) return missing;
        secretEnv.push(row.name);
      }
    }
    return {
      source: "custom",
      name: server.name,
      transport: { type: "stdio", command: server.transport.command, args: [...server.transport.args], env, secretEnv, cwd: null },
      launcher: secretEnv.length > 0,
      options: {},
      secrets: bound,
    };
  }
  const headers: Record<string, string> = {};
  const secretHeaders: string[] = [];
  for (const row of server.transport.headers) {
    if (!row.secret) headers[row.name] = row.value;
    else {
      const missing = need(residentMcpSecretField("header", row.name), row.name);
      if (missing) return missing;
      secretHeaders.push(row.name);
    }
  }
  for (const name of server.transport.query) {
    const missing = need(residentMcpSecretField("query", name), `query parameter ${name}`);
    if (missing) return missing;
  }
  return {
    source: "custom",
    name: server.name,
    transport: { type: "http", url: server.transport.url, headers, secretHeaders, secretQuery: [...server.transport.query] },
    launcher: secretHeaders.length > 0 || server.transport.query.length > 0,
    options: {},
    secrets: bound,
  };
}

/**
 * Resolve a launch's effective MCP set from the revision it pins, once.
 *
 * - With inherit on, every global server the harness enables at launch; a selected global server
 *   that is also inherited appears once.
 * - Each selected global server, and each selected custom server that applies to the harness.
 * - A custom server named like any global server of the harness refuses the launch, even when
 *   the global server appeared after the profile was saved. Nothing is renamed.
 * - A server residents cannot represent refuses the launch with its reason.
 *
 * Every check runs before a secret is bound, so each secret belongs to its (source, name).
 * Null when the harness has no measured control, which keeps its native MCP behaviour.
 */
export async function resolveResidentMcpSet(
  settings: ResidentProfileRevision,
  deps: ResidentMcpResolveDeps,
): Promise<ResidentMcpResolution> {
  const agent = settings.execution.agent;
  const label = AGENT_IDENTITY[agent].label;
  if (capabilitiesFor(agent).mcpSelection === null) {
    return settings.mcp.selected.length > 0 || !settings.mcp.inheritDefaults
      ? { ok: false, error: `${label} cannot pin a resident's MCP servers, so this profile's MCP selection cannot launch` }
      : { ok: true, servers: null };
  }
  const { inheritDefaults, selected } = settings.mcp;
  let globals: GlobalMcpRead | null = null;
  if (inheritDefaults || selected.length > 0) {
    globals = await deps.globals(agent);
    if (globals.problem) return { ok: false, error: `could not read ${label}'s global MCP servers: ${globals.problem}` };
  }
  const globalByName = new Map((globals?.servers ?? []).map((server) => [server.summary.name, server]));
  const chosen = new Map<string, ResidentMcpResolvedServer>();
  const takeGlobal = (definition: GlobalMcpDefinition, how: string): string | null => {
    if (definition.summary.unavailable || !definition.transport) {
      return `${label}'s global MCP server ${definition.summary.name} is ${how} but residents cannot use it: ${definition.summary.unavailable ?? "its definition could not be read"}`;
    }
    chosen.set(`global:${definition.summary.name}`, resolvedGlobal(definition));
    return null;
  };
  if (inheritDefaults) {
    for (const definition of globals!.servers) {
      if (!definition.summary.enabled) continue;
      const problem = takeGlobal(definition, "inherited");
      if (problem) return { ok: false, error: problem };
    }
  }
  const custom = selected.some((ref) => ref.source === "custom") ? deps.custom() : [];
  for (const ref of selected) {
    if (ref.source === "global") {
      if (ref.agent !== agent) {
        return { ok: false, error: `the selected MCP server ${ref.name} belongs to ${AGENT_IDENTITY[ref.agent].label}, not ${label}` };
      }
      // Inherited and selected is one server.
      if (chosen.has(`global:${ref.name}`)) continue;
      const definition = globalByName.get(ref.name);
      if (!definition) return { ok: false, error: `${label} no longer has a global MCP server named ${ref.name}` };
      const problem = takeGlobal(definition, "selected");
      if (problem) return { ok: false, error: problem };
      continue;
    }
    const server = custom.find((candidate) => candidate.id === ref.id);
    if (!server) return { ok: false, error: "a selected custom MCP server no longer exists" };
    if (!server.harnesses.includes(agent)) {
      return { ok: false, error: `the custom MCP server ${server.name} does not apply to ${label}` };
    }
    if ([...globalByName.keys()].some((name) => name.toLowerCase() === server.name.toLowerCase())) {
      return {
        ok: false,
        error: `the custom MCP server ${server.name} has the same name as ${label}'s global server; rename one of them`,
      };
    }
    const resolved = resolvedCustom(server, deps.customSecrets(server.id));
    if (typeof resolved === "string") return { ok: false, error: resolved };
    chosen.set(`custom:${server.name}`, resolved);
  }
  const names = new Set<string>();
  for (const server of chosen.values()) {
    const key = server.name.toLowerCase();
    if (names.has(key)) return { ok: false, error: `two MCP servers are named ${server.name}; rename one of them` };
    names.add(key);
  }
  return { ok: true, servers: [...chosen.values()] };
}

// ---- 2 and 3. per-start entries and their tickets ----

interface Grant {
  runId: string;
  source: StoredMcpSnapshotServer["source"];
  server: string;
  startId: string;
  expiresAt: number;
  path: string;
}

/** Live tickets, by their hash. In memory on purpose: a daemon restart voids every ticket. */
const grants = new Map<string, Grant>();

function ticketKey(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function forget(key: string): void {
  const grant = grants.get(key);
  if (!grant) return;
  grants.delete(key);
  rmSync(grant.path, { force: true });
}

/**
 * Write one launcher entry's credential file: owner-only, created exclusively, holding a
 * single-use ticket bound to this run, this server and this start, and its expiry. Removed by
 * the launcher when read, and by the daemon once the ticket expires unredeemed.
 */
function issueCredential(runId: string, server: StoredMcpSnapshotServer, startId: string, now = Date.now()): string {
  const dir = join(residentMcpRunDir(runId), "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ticket = randomBytes(32).toString("base64url");
  const path = join(dir, `${randomBytes(12).toString("hex")}.json`);
  const expiresAt = now + RESIDENT_MCP_TICKET_TTL_MS;
  const file: ResidentMcpCredentialFile = { ticket, expiresAt, redeemUrl: `${BASE_URL}/api/residents/mcp/redeem` };
  writeFileSync(path, JSON.stringify(file), { mode: 0o600, flag: "wx" });
  const key = ticketKey(ticket);
  grants.set(key, { runId, source: server.source, server: server.name, startId, expiresAt, path });
  setTimeout(() => forget(key), RESIDENT_MCP_TICKET_TTL_MS + 1_000).unref();
  return path;
}

/** Stands in for a credential in a preview: a path no file is ever written to. */
const UNISSUED_CREDENTIAL = "unissued";

/** One entry; `startId` null renders a preview whose launcher entries carry no credential. */
function entryFor(runId: string, server: StoredMcpSnapshotServer, startId: string | null): ResidentMcpEntry {
  const { name, options, transport } = server;
  // A redacted definition renders as a launcher entry, whose redemption refuses it.
  if (!server.launcher && transport.type !== "redacted") {
    if (transport.type === "stdio") {
      return { name, options, shape: "stdio", command: transport.command, args: [...transport.args], env: { ...transport.env } };
    }
    return { name, options, shape: "http", url: transport.url, headers: { ...transport.headers } };
  }
  const runtime = resolveMissionMcpRuntime();
  return {
    name,
    options,
    shape: "launcher",
    command: runtime.command,
    args: [
      residentMcpLauncherPath(),
      "--run", runId,
      "--server", name,
      "--credential", startId === null ? UNISSUED_CREDENTIAL : issueCredential(runId, server, startId),
    ],
    // Only what the runtime itself needs (Electron's node mode); never the daemon's environment.
    env: Object.fromEntries(Object.entries(runtime.env).filter((pair): pair is [string, string] => pair[1] !== undefined)),
  };
}

/**
 * The run's `SdkLaunchOptions.residentMcp`, from its snapshot alone, or null for a run without
 * one (launched before snapshots existed, or on a harness with no measured control).
 */
export function residentMcpLaunchForRun(runId: string): ResidentMcpLaunch | null {
  if (!runId) return null;
  const snapshot = runMcpSnapshot(runId);
  if (!snapshot) return null;
  return {
    names: snapshot.map((server) => server.name),
    privateDir: residentMcpRunDir(runId),
    forStart: () => {
      const startId = randomUUID();
      return snapshot.map((server) => entryFor(runId, server, startId));
    },
    preview: () => snapshot.map((server) => entryFor(runId, server, null)),
  };
}

// ---- 4. redemption ----

export type ResidentMcpRedemption =
  | { ok: true; definition: ResidentMcpLauncherDefinition }
  | { ok: false; status: 403 | 409; error: string };

/**
 * Trade a ticket for its one server's definition and secrets. Spent on first presentation,
 * whatever the outcome, so a ticket is never usable twice. A missing, spent or expired ticket, or
 * one presented for another run or server, gets nothing, and the launcher starts nothing.
 */
export function redeemResidentMcpTicket(
  input: { ticket: string; runId: string; server: string },
  now = Date.now(),
): ResidentMcpRedemption {
  const key = ticketKey(input.ticket);
  const grant = grants.get(key);
  if (!grant) return { ok: false, status: 403, error: "this launch ticket is unknown or already spent" };
  forget(key);
  if (grant.expiresAt <= now) return { ok: false, status: 403, error: "this launch ticket has expired" };
  if (grant.runId !== input.runId || grant.server !== input.server) {
    return { ok: false, status: 403, error: "this launch ticket belongs to another server" };
  }
  if (!residentRunIsOpen(grant.runId)) return { ok: false, status: 409, error: "this resident run has ended" };
  const server = runMcpSnapshot(grant.runId)?.find((row) => row.source === grant.source && row.name === grant.server);
  if (!server) return { ok: false, status: 409, error: "this server is not in the run's snapshot" };
  const secrets = runMcpSecretValues(grant.runId, grant.source, grant.server);
  const secret = (kind: "env" | "header" | "query", name: string): string | null =>
    secrets.get(residentMcpSecretField(kind, name)) ?? null;
  const lost = (name: string): ResidentMcpRedemption => ({
    ok: false,
    status: 409,
    error: `the snapshot no longer holds the secret ${name}; launch the resident again`,
  });
  const { transport } = server;
  if (transport.type === "redacted") {
    return {
      ok: false,
      status: 409,
      error: "this server's definition was not kept when the database was restored from a backup; launch the resident again",
    };
  }
  if (transport.type === "stdio") {
    const env = { ...transport.env };
    for (const name of transport.secretEnv) {
      const value = secret("env", name);
      if (value === null) return lost(name);
      env[name] = value;
    }
    return { ok: true, definition: { transport: "stdio", command: transport.command, args: [...transport.args], env, cwd: transport.cwd } };
  }
  const headers = { ...transport.headers };
  for (const name of transport.secretHeaders) {
    const value = secret("header", name);
    if (value === null) return lost(name);
    headers[name] = value;
  }
  const url = new URL(transport.url);
  for (const name of transport.secretQuery) {
    const value = secret("query", name);
    if (value === null) return lost(name);
    url.searchParams.append(name, value);
  }
  return { ok: true, definition: { transport: transport.type, url: url.toString(), headers } };
}

// ---- cleanup ----

/**
 * Remove every credential file this process holds no ticket for. Tickets live in memory, so a
 * file a previous process wrote is unredeemable. Called at startup; a ticket this daemon has
 * already issued - a restored resident starting first - is kept, whatever the order.
 */
export function sweepResidentMcpCredentials(): void {
  const root = residentMcpRoot();
  if (!existsSync(root)) return;
  const live = new Set([...grants.values()].map((grant) => grant.path));
  for (const runId of readdirSync(root)) {
    if (!RUN_ID.test(runId)) continue;
    const dir = join(root, runId, "credentials");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!live.has(path)) rmSync(path, { recursive: true, force: true });
    }
  }
}

/** Drop a finished run's snapshot, tickets, credential files and overlay. */
export function removeResidentMcpRunState(runId: string): void {
  for (const [key, grant] of grants) if (grant.runId === runId) forget(key);
  removeRunMcpSnapshot(runId);
  rmSync(residentMcpRunDir(runId), { recursive: true, force: true });
}

/**
 * The runs whose MCP state may be removed: finished, and no longer running anything. Includes
 * directories left by a run that ended during a crash.
 */
export function residentMcpStateToRemove(snapshotRuns: readonly string[]): string[] {
  const candidates = new Set(snapshotRuns);
  const root = residentMcpRoot();
  if (existsSync(root)) {
    for (const runId of readdirSync(root)) if (RUN_ID.test(runId)) candidates.add(runId);
  }
  return [...candidates].filter((runId) => !residentRunIsOpen(runId));
}
