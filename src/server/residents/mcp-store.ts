import type { DatabaseSync } from "node:sqlite";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  RESIDENT_MCP_LIMITS,
  ResidentMcpServersDocumentSchema,
  credentialArgumentProblem,
  credentialFormArgs,
  residentMcpCustomServerView,
  residentMcpEnvNameProblem,
  residentMcpHeaderNameProblem,
  residentMcpSecretField,
  type CreateResidentMcpServer,
  type ResidentMcpCustomServer,
  type ResidentMcpCustomServerView,
  type ResidentMcpFieldInput,
  type ResidentMcpStoredField,
  type ResidentMcpStoredTransport,
} from "@shared/resident-mcp.ts";
import type { ResidentAgent } from "@shared/residents.ts";
import type { ResidentMcpOptions } from "../harness/types.ts";
import { getAppConfig, openDb, setAppConfig } from "../db.ts";

// The resident MCP store: custom server definitions in `app_config`, their write-only secret
// values in `resident_mcp_secrets`, and each run's daemon-private snapshot in
// `resident_run_mcp_servers` and `resident_run_mcp_secrets`. The daemon is the only writer.
//
// Nothing in this module returns a secret value to a route. `residentMcpServerViews` is what
// every route answers with; `customSecretValues` and `runMcpSecretValues` exist for a launch's
// snapshot and the scoped launcher's redemption, both inside the daemon.

/** A refused custom-server write, with the HTTP status the route answers with. */
export class ResidentMcpServerError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

function inTransaction<T>(d: DatabaseSync, fn: () => T): T {
  const owns = !d.isTransaction;
  if (owns) d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    if (owns) d.exec("COMMIT");
    return out;
  } catch (error) {
    if (owns && d.isTransaction) d.exec("ROLLBACK");
    throw error;
  }
}

/** The stored custom servers, or an empty list with the reason when the document is unreadable. */
export function readResidentMcpServers(): { servers: ResidentMcpCustomServer[]; problem: string | null } {
  const stored = getAppConfig(APP_CONFIG_ENTRIES.residentMcpServers);
  if (stored === undefined) return { servers: [], problem: null };
  const parsed = ResidentMcpServersDocumentSchema.safeParse(stored);
  return parsed.success
    ? { servers: parsed.data.servers, problem: null }
    : { servers: [], problem: "Stored custom MCP servers are invalid and are ignored until they are saved again." };
}

export function listResidentMcpServers(): ResidentMcpCustomServer[] {
  return readResidentMcpServers().servers;
}

/** Which secret fields of one server hold a value. */
function setFields(serverId: string): Set<string> {
  const rows = openDb()
    .prepare("SELECT field FROM resident_mcp_secrets WHERE server_id = ?")
    .all(serverId) as Array<{ field: string }>;
  return new Set(rows.map((row) => row.field));
}

/** Every custom server as a route may return it: secret fields say only whether they are set. */
export function residentMcpServerViews(): ResidentMcpCustomServerView[] {
  return listResidentMcpServers().map((server) => {
    const set = setFields(server.id);
    return residentMcpCustomServerView(server, (field) => set.has(field));
  });
}

/** One server's secret values. Daemon-only: read by a launch's snapshot and nothing else. */
export function customSecretValues(serverId: string): Map<string, string> {
  const rows = openDb()
    .prepare("SELECT field, value FROM resident_mcp_secrets WHERE server_id = ?")
    .all(serverId) as Array<{ field: string; value: string }>;
  return new Map(rows.map((row) => [row.field, row.value]));
}

/** Global server names per harness, lower-cased, for the save-time collision check. */
export type GlobalMcpNames = ReadonlyMap<ResidentAgent, ReadonlySet<string>>;

interface Normalized {
  transport: ResidentMcpStoredTransport;
  /** Secret values to set, by field. */
  set: Map<string, string>;
  /** Every secret field the server keeps; anything else stored for it is deleted. */
  keep: Set<string>;
}

function normalizeFields(
  kind: "env" | "header",
  rows: readonly ResidentMcpFieldInput[],
  existing: ReadonlySet<string>,
  out: Normalized,
): ResidentMcpStoredField[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const problem = kind === "env" ? residentMcpEnvNameProblem(row.name) : residentMcpHeaderNameProblem(row.name);
    if (problem) throw new ResidentMcpServerError(problem, 400);
    const identity = kind === "env" ? row.name : row.name.toLowerCase();
    if (seen.has(identity)) throw new ResidentMcpServerError(`${row.name} is listed twice`, 400);
    seen.add(identity);
    if (!row.secret) return { name: row.name, secret: false, value: row.value! };
    const field = residentMcpSecretField(kind, row.name);
    if (row.value !== undefined) out.set.set(field, row.value);
    if (row.value !== undefined || existing.has(field)) out.keep.add(field);
    return { name: row.name, secret: true };
  });
}

/**
 * Validate a write and split it into the stored, secret-free definition and the secret values.
 *
 * Refuses, naming the problem: a credential-form argument; a URL with userinfo, a fragment or a
 * scheme other than http and https; a duplicate or malformed field name. A URL's query becomes
 * secret query fields, so the stored URL never carries a value.
 */
function normalizeTransport(input: CreateResidentMcpServer["transport"], existing: ReadonlySet<string>): Normalized {
  const out: Normalized = {
    transport: input.type === "stdio"
      ? { type: "stdio", command: "", args: [], env: [] }
      : { type: "http", url: "", query: [], headers: [] },
    set: new Map(),
    keep: new Set(),
  };
  if (input.type === "stdio") {
    const found = credentialFormArgs(input.args);
    if (found) throw new ResidentMcpServerError(credentialArgumentProblem(found), 400);
    out.transport = {
      type: "stdio",
      command: input.command,
      args: [...input.args],
      env: normalizeFields("env", input.env, existing, out),
    };
    return out;
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new ResidentMcpServerError("the server URL is not a valid URL", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ResidentMcpServerError("the server URL must use http or https", 400);
  }
  if (url.username || url.password) {
    throw new ResidentMcpServerError(
      "the server URL carries a user name or password; send the credential as a secret header instead",
      400,
    );
  }
  if (url.hash) throw new ResidentMcpServerError("the server URL cannot carry a #fragment", 400);
  const query: Array<{ name: string; value?: string }> = [...url.searchParams].map(([name, value]) => ({ name, value }));
  for (const row of input.query) {
    const at = query.findIndex((candidate) => candidate.name === row.name);
    if (at >= 0 && query[at]!.value !== undefined && row.value !== undefined) {
      throw new ResidentMcpServerError(`query parameter ${row.name} is given twice`, 400);
    }
    if (at >= 0) query[at] = { name: row.name, value: query[at]!.value ?? row.value };
    else query.push(row);
  }
  if (query.length > RESIDENT_MCP_LIMITS.fields) {
    throw new ResidentMcpServerError(`a server has at most ${RESIDENT_MCP_LIMITS.fields} query parameters`, 400);
  }
  for (const row of query) {
    const field = residentMcpSecretField("query", row.name);
    if (row.value !== undefined) out.set.set(field, row.value);
    if (row.value !== undefined || existing.has(field)) out.keep.add(field);
  }
  url.search = "";
  out.transport = {
    type: "http",
    url: url.toString(),
    query: query.map((row) => row.name),
    headers: normalizeFields("header", input.headers, existing, out),
  };
  return out;
}

function collision(
  name: string,
  harnesses: readonly ResidentAgent[],
  servers: readonly ResidentMcpCustomServer[],
  globals: GlobalMcpNames,
  except: string | null,
): string | null {
  const lower = name.toLowerCase();
  if (servers.some((server) => server.id !== except && server.name.toLowerCase() === lower)) {
    return `a custom MCP server is already named ${name}`;
  }
  for (const agent of harnesses) {
    if (globals.get(agent)?.has(lower)) {
      return `${agent === "claude" ? "Claude Code" : "Codex"} already has a global MCP server named ${name}; choose another name`;
    }
  }
  return null;
}

function writeDocument(d: DatabaseSync, servers: ResidentMcpCustomServer[]): void {
  setAppConfig(APP_CONFIG_ENTRIES.residentMcpServers, { servers });
  // Secrets of a server the document no longer holds - deleted here or by a settings restore -
  // have nothing left to belong to.
  const ids = servers.map((server) => server.id);
  d.prepare(
    `DELETE FROM resident_mcp_secrets WHERE server_id NOT IN (${ids.map(() => "?").join(",") || "''"})`,
  ).run(...ids);
}

function applySecrets(d: DatabaseSync, serverId: string, normalized: Normalized, at: number): void {
  const stored = setFields(serverId);
  for (const field of stored) {
    if (!normalized.keep.has(field)) {
      d.prepare("DELETE FROM resident_mcp_secrets WHERE server_id = ? AND field = ?").run(serverId, field);
    }
  }
  for (const [field, value] of normalized.set) {
    d.prepare(
      `INSERT INTO resident_mcp_secrets (server_id, field, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(server_id, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(serverId, field, value, at);
  }
}

function view(server: ResidentMcpCustomServer): ResidentMcpCustomServerView {
  const set = setFields(server.id);
  return residentMcpCustomServerView(server, (field) => set.has(field));
}

export function createResidentMcpServer(
  input: CreateResidentMcpServer,
  context: { id: string; at: number; globals: GlobalMcpNames },
): ResidentMcpCustomServerView {
  const d = openDb();
  return inTransaction(d, () => {
    const current = readResidentMcpServers();
    if (current.problem) throw new ResidentMcpServerError(current.problem, 409);
    if (current.servers.length >= RESIDENT_MCP_LIMITS.servers) {
      throw new ResidentMcpServerError(`this machine already has ${RESIDENT_MCP_LIMITS.servers} custom MCP servers`, 409);
    }
    const clash = collision(input.name, input.harnesses, current.servers, context.globals, null);
    if (clash) throw new ResidentMcpServerError(clash, 409);
    const normalized = normalizeTransport(input.transport, new Set());
    const server: ResidentMcpCustomServer = {
      id: context.id,
      name: input.name,
      harnesses: [...input.harnesses],
      transport: normalized.transport,
      revision: 1,
      createdAt: context.at,
      updatedAt: context.at,
    };
    writeDocument(d, [...current.servers, server]);
    applySecrets(d, server.id, normalized, context.at);
    return view(server);
  });
}

export function updateResidentMcpServer(
  id: string,
  input: CreateResidentMcpServer & { expectedRevision: number },
  context: { at: number; globals: GlobalMcpNames },
): ResidentMcpCustomServerView {
  const d = openDb();
  return inTransaction(d, () => {
    const current = readResidentMcpServers();
    if (current.problem) throw new ResidentMcpServerError(current.problem, 409);
    const index = current.servers.findIndex((server) => server.id === id);
    const before = current.servers[index];
    if (!before) throw new ResidentMcpServerError("no such custom MCP server", 404);
    if (before.revision !== input.expectedRevision) {
      throw new ResidentMcpServerError(
        `this MCP server changed since you opened it (now revision ${before.revision})`,
        409,
      );
    }
    const clash = collision(input.name, input.harnesses, current.servers, context.globals, id);
    if (clash) throw new ResidentMcpServerError(clash, 409);
    // A secret is kept across an edit only while its field keeps the same kind and name, so a
    // renamed variable never inherits the old variable's value.
    const normalized = normalizeTransport(input.transport, setFields(id));
    const server: ResidentMcpCustomServer = {
      ...before,
      name: input.name,
      harnesses: [...input.harnesses],
      transport: normalized.transport,
      revision: before.revision + 1,
      updatedAt: context.at,
    };
    const servers = [...current.servers];
    servers[index] = server;
    writeDocument(d, servers);
    applySecrets(d, id, normalized, context.at);
    return view(server);
  });
}

export function deleteResidentMcpServer(id: string, expectedRevision: number): void {
  const d = openDb();
  inTransaction(d, () => {
    const current = readResidentMcpServers();
    if (current.problem) throw new ResidentMcpServerError(current.problem, 409);
    const before = current.servers.find((server) => server.id === id);
    if (!before) throw new ResidentMcpServerError("no such custom MCP server", 404);
    if (before.revision !== expectedRevision) {
      throw new ResidentMcpServerError(
        `this MCP server changed since you opened it (now revision ${before.revision})`,
        409,
      );
    }
    writeDocument(d, current.servers.filter((server) => server.id !== id));
  });
}

// ---- run snapshots ----

/**
 * One server's transport in a run snapshot, without any secret value: those are in
 * `resident_run_mcp_secrets`, keyed by this server's (source, name) and the field. Every
 * environment and header value of a global server is a secret, because native configuration
 * does not say which are credentials.
 */
export type ResidentMcpSnapshotTransport =
  | {
      type: "stdio";
      command: string;
      args: string[];
      /** Non-secret values, rendered into the harness's configuration. */
      env: Record<string, string>;
      /** Names whose values are secrets. */
      secretEnv: string[];
      cwd: string | null;
    }
  | {
      type: "http" | "sse";
      /** Without its query; the values are secrets the launcher's bridge adds. */
      url: string;
      headers: Record<string, string>;
      secretHeaders: string[];
      secretQuery: string[];
    };

/** One server of a run's effective set, as the snapshot holds it. */
export interface ResidentMcpSnapshotServer {
  source: "global" | "custom";
  name: string;
  transport: ResidentMcpSnapshotTransport;
  /**
   * Whether this server starts through Mission's scoped launcher: every global server, and every
   * custom server with a secret, so none of its private parts reach the agent's configuration.
   */
  launcher: boolean;
  options: ResidentMcpOptions;
}

/**
 * A snapshot server as read back. A full-database recovery point redacts every global server's
 * transport (`DatabaseBackupService`), because its whole definition is private; a run restored
 * from one still knows the server's name and refuses to start it rather than start it without
 * its definition.
 */
export interface StoredMcpSnapshotServer extends Omit<ResidentMcpSnapshotServer, "transport"> {
  transport: ResidentMcpSnapshotTransport | { type: "redacted" };
}

/** A server about to be snapshotted: its definition and the secret values bound to it. */
export interface ResidentMcpResolvedServer extends ResidentMcpSnapshotServer {
  secrets: ReadonlyMap<string, string>;
}

/** Write a run's snapshot once, in one transaction, and mark when it was taken. */
export function writeRunMcpSnapshot(runId: string, servers: readonly ResidentMcpResolvedServer[], at: number): void {
  const d = openDb();
  inTransaction(d, () => {
    d.prepare("DELETE FROM resident_run_mcp_servers WHERE run_id = ?").run(runId);
    d.prepare("DELETE FROM resident_run_mcp_secrets WHERE run_id = ?").run(runId);
    for (const [position, server] of servers.entries()) {
      const { secrets, ...definition } = server;
      d.prepare(
        `INSERT INTO resident_run_mcp_servers (run_id, source, name, position, definition_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(runId, server.source, server.name, position, JSON.stringify(definition));
      for (const [field, value] of secrets) {
        d.prepare(
          `INSERT INTO resident_run_mcp_secrets (run_id, source, server, field, value) VALUES (?, ?, ?, ?, ?)`,
        ).run(runId, server.source, server.name, field, value);
      }
    }
    d.prepare("UPDATE resident_runs SET mcp_snapshot_at = ? WHERE id = ?").run(at, runId);
  });
}

/**
 * A run's snapshot, or null for a run launched before snapshots existed (it keeps the native
 * MCP behaviour it launched with). An empty array is a real snapshot: Mission's server only.
 */
export function runMcpSnapshot(runId: string): StoredMcpSnapshotServer[] | null {
  const d = openDb();
  const run = d.prepare("SELECT mcp_snapshot_at FROM resident_runs WHERE id = ?").get(runId) as
    | { mcp_snapshot_at: number | null }
    | undefined;
  if (!run || run.mcp_snapshot_at === null) return null;
  const rows = d
    .prepare("SELECT definition_json FROM resident_run_mcp_servers WHERE run_id = ? ORDER BY position")
    .all(runId) as Array<{ definition_json: string }>;
  return rows.map((row) => JSON.parse(row.definition_json) as StoredMcpSnapshotServer);
}

/** One snapshot server's secret values. Daemon-only: read by the launcher's redemption. */
export function runMcpSecretValues(runId: string, source: string, server: string): Map<string, string> {
  const rows = openDb()
    .prepare("SELECT field, value FROM resident_run_mcp_secrets WHERE run_id = ? AND source = ? AND server = ?")
    .all(runId, source, server) as Array<{ field: string; value: string }>;
  return new Map(rows.map((row) => [row.field, row.value]));
}

/** Drop a run's snapshot rows. The marker stays, so the run never falls back to native MCP. */
export function removeRunMcpSnapshot(runId: string): void {
  const d = openDb();
  inTransaction(d, () => {
    d.prepare("DELETE FROM resident_run_mcp_servers WHERE run_id = ?").run(runId);
    d.prepare("DELETE FROM resident_run_mcp_secrets WHERE run_id = ?").run(runId);
  });
}

/** Runs that have finished (ended or failed) and may still hold snapshot rows. */
export function finishedRunsWithMcpState(): string[] {
  const rows = openDb()
    .prepare(
      `SELECT id FROM resident_runs
       WHERE (ended_at IS NOT NULL OR launch_state = 'failed')
         AND id IN (SELECT run_id FROM resident_run_mcp_servers UNION SELECT run_id FROM resident_run_mcp_secrets)`,
    )
    .all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Whether a run is still open (neither ended nor failed). Unknown runs are not open. */
export function residentRunIsOpen(runId: string): boolean {
  const row = openDb()
    .prepare("SELECT ended_at, launch_state FROM resident_runs WHERE id = ?")
    .get(runId) as { ended_at: number | null; launch_state: string } | undefined;
  return !!row && row.ended_at === null && row.launch_state !== "failed";
}
