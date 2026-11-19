import { realpathSync } from "node:fs";
import { sep } from "node:path";
import {
  HomeSessionRegistrationSchema,
  type HomeSessionRegistration,
  type HomeSessionRegistrationResult,
  type HomeTerminal,
} from "@shared/home-dispatch.ts";
import { TERMINAL_TASK_STATUSES } from "@shared/task-status.ts";
import { openDb } from "../db.ts";
import { mainRepoRoot } from "../util/git.ts";
import type { HomeDispatchResult } from "./stub.ts";

/**
 * Home sessions (spec 7.2): one row per session the person works in, written only by the daemon.
 *
 * Nothing here reads the feature flag. The routes sit behind `requireFeature` and the hook route
 * calls in only while the flag is on, so a flag-off daemon never reaches a write.
 */

/**
 * Harnesses whose sessions may be home sessions in v1 (spec 2.5). Claude only; Codex has no
 * machine-wide hooks and Pi has no MCP. WP5b replaces this with the `homeDispatch` harness
 * capability, so it stays the single place that names the set until then.
 */
export const HOME_DISPATCH_V1_HARNESSES: readonly string[] = ["claude"];

/** A `home_dispatch_sessions` row, with the JSON and 0/1 columns decoded. */
export interface HomeSessionRow {
  sessionId: string;
  harness: string;
  cwd: string;
  repoRoot: string | null;
  claudePid: number | null;
  hookVersion: string | null;
  startSource: string | null;
  entrypoint: string | null;
  terminal: HomeTerminal | null;
  launcherOfferedAt: number | null;
  launcherDisabled: boolean;
  startedAt: number | null;
  lastTurnAt: number | null;
  lastStopAt: number | null;
}

interface RawSessionRow {
  session_id: string;
  harness: string;
  cwd: string;
  repo_root: string | null;
  claude_pid: number | null;
  hook_version: string | null;
  start_source: string | null;
  entrypoint: string | null;
  terminal: string | null;
  launcher_offered_at: number | null;
  launcher_disabled: number;
  started_at: number | null;
  last_turn_at: number | null;
  last_stop_at: number | null;
}

function decodeTerminal(raw: string | null): HomeTerminal | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HomeTerminal;
  } catch {
    return null;
  }
}

function decode(row: RawSessionRow): HomeSessionRow {
  return {
    sessionId: row.session_id,
    harness: row.harness,
    cwd: row.cwd,
    repoRoot: row.repo_root,
    claudePid: row.claude_pid,
    hookVersion: row.hook_version,
    startSource: row.start_source,
    entrypoint: row.entrypoint,
    terminal: decodeTerminal(row.terminal),
    launcherOfferedAt: row.launcher_offered_at,
    launcherDisabled: row.launcher_disabled === 1,
    startedAt: row.started_at,
    lastTurnAt: row.last_turn_at,
    lastStopAt: row.last_stop_at,
  };
}

export function getHomeSession(sessionId: string): HomeSessionRow | null {
  const row = openDb().prepare("SELECT * FROM home_dispatch_sessions WHERE session_id = ?").get(sessionId) as
    | RawSessionRow
    | undefined;
  return row ? decode(row) : null;
}

/**
 * The row a request is really from (spec 7.2, L2). The MCP server's environment is fixed when it
 * starts, so after `/clear` it still names the old session id. When the named row has a
 * `claude_pid` and a newer HOOK registration exists for the same pid, the newer row is the caller.
 * Only a row a hook registered (it has `started_at`) can be the newer one.
 */
export function resolveHomeSession(sessionId: string, claudePid: number | null = null): HomeSessionRow | null {
  const named = getHomeSession(sessionId);
  const pid = named?.claudePid ?? claudePid;
  if (pid === null) return named;
  const newer = openDb()
    .prepare(
      `SELECT * FROM home_dispatch_sessions
        WHERE claude_pid = ? AND started_at IS NOT NULL
          AND started_at > COALESCE(?, -1)
        ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(pid, named?.startedAt ?? null) as RawSessionRow | undefined;
  return newer ? decode(newer) : named;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Whether a session id or folder belongs to a Mission Control worker (spec 7.2). A worker is one
 * the registry knows as Mission-managed: its Mission id or harness session id belongs to an SDK
 * session or a session bound to a task, or its folder is inside the worktree of a task that is not
 * done, failed or cancelled (real paths on both sides). A terminal session the daemon only
 * discovered, with no task, belongs to the person.
 *
 * Read from the database rather than the in-memory registry, so the hook route needs no handle on
 * it: every task, SDK session and binding is persisted before a worker can send its first hook.
 */
export function isWorkerSession(sessionId: string, cwd: string): boolean {
  const d = openDb();
  const hit = (sql: string, ...args: string[]): boolean => d.prepare(sql).get(...args) !== undefined;
  if (hit("SELECT 1 FROM sdk_sessions WHERE id = ?1 OR agent_session_id = ?1 LIMIT 1", sessionId)) return true;
  if (hit("SELECT 1 FROM tasks WHERE session_id = ?1 LIMIT 1", sessionId)) return true;
  if (
    hit(
      `SELECT 1 FROM session_agent_bindings b JOIN tasks t ON t.session_id = b.session_id
        WHERE b.agent_session_id = ? LIMIT 1`,
      sessionId,
    )
  ) {
    return true;
  }
  const live = TERMINAL_TASK_STATUSES.map(() => "?").join(", ");
  const trees = d
    .prepare(
      `SELECT t.worktree_path AS path FROM tasks t
        WHERE t.worktree_path IS NOT NULL AND t.status NOT IN (${live})
       UNION
       SELECT r.worktree_path FROM task_repos r JOIN tasks t ON t.id = r.task_id
        WHERE r.worktree_path IS NOT NULL AND t.status NOT IN (${live})`,
    )
    .all(...TERMINAL_TASK_STATUSES, ...TERMINAL_TASK_STATUSES) as Array<{ path: string }>;
  if (trees.length === 0) return false;
  const here = realOrSelf(cwd);
  return trees.some((tree) => inside(here, realOrSelf(tree.path)));
}

export type RegisterOutcome =
  | { ok: true; row: HomeSessionRow; created: boolean }
  | { ok: false; status: 403 | 400; error: string };

/**
 * Register a home session, synchronously, so the hook route (which answers inline) and the MCP
 * route share one write path.
 *
 * - A HOOK registration carries a `source` and owns `started_at`, `start_source` and `entrypoint`.
 * - An MCP registration (`source` null) only fills a row that is missing, so it can never rewrite
 *   what the hook recorded, and a failed one is retried by the MCP server.
 * - A hook event that is not `SessionStart` (the daemon was down at start) arrives with a null
 *   source too: it registers the row, but the unknown source keeps the launcher off, the safe way.
 */
export function registerHomeSession(input: HomeSessionRegistration, now = Date.now()): RegisterOutcome {
  if (!HOME_DISPATCH_V1_HARNESSES.includes(input.harness)) {
    return { ok: false, status: 400, error: `${input.harness} sessions cannot be home sessions yet` };
  }
  if (isWorkerSession(input.sessionId, input.cwd)) {
    return { ok: false, status: 403, error: "a Mission Control worker cannot act as a home session" };
  }
  const d = openDb();
  const existing = getHomeSession(input.sessionId);
  const repoRoot = mainRepoRoot(input.cwd);
  const terminal = input.terminal ? JSON.stringify(input.terminal) : null;
  const hookOwned = input.source !== null;

  if (!existing) {
    d.prepare(
      `INSERT INTO home_dispatch_sessions
         (session_id, harness, cwd, repo_root, claude_pid, hook_version, start_source, entrypoint,
          terminal, launcher_disabled, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.harness,
      input.cwd,
      repoRoot,
      input.claudePid,
      input.hookVersion,
      input.source,
      hookOwned ? input.entrypoint : null,
      terminal,
      input.launcherDisabled ? 1 : 0,
      hookOwned ? now : null,
    );
    return { ok: true, row: getHomeSession(input.sessionId)!, created: true };
  }

  if (hookOwned) {
    d.prepare(
      `UPDATE home_dispatch_sessions
          SET harness = ?, cwd = ?, repo_root = ?, claude_pid = COALESCE(?, claude_pid),
              hook_version = COALESCE(?, hook_version), start_source = ?, entrypoint = ?,
              terminal = COALESCE(?, terminal), launcher_disabled = ?, started_at = COALESCE(started_at, ?)
        WHERE session_id = ?`,
    ).run(
      input.harness,
      input.cwd,
      repoRoot,
      input.claudePid,
      input.hookVersion,
      input.source,
      input.entrypoint,
      terminal,
      input.launcherDisabled ? 1 : 0,
      now,
      input.sessionId,
    );
  } else {
    // Fill only what is missing, so a later event never rewrites what the hook recorded.
    d.prepare(
      `UPDATE home_dispatch_sessions
          SET claude_pid = COALESCE(claude_pid, ?), hook_version = COALESCE(hook_version, ?),
              terminal = COALESCE(terminal, ?), repo_root = COALESCE(repo_root, ?)
        WHERE session_id = ?`,
    ).run(input.claudePid, input.hookVersion, terminal, repoRoot, input.sessionId);
  }
  return { ok: true, row: getHomeSession(input.sessionId)!, created: false };
}

/** `POST /mcp/dispatch/sessions` (spec 2.3): the MCP server registers a session lazily. */
export async function handleRegisterSession(
  input: HomeSessionRegistration,
): Promise<HomeDispatchResult<HomeSessionRegistrationResult>> {
  // The route already validated the body; parsing again keeps a direct caller honest.
  const parsed = HomeSessionRegistrationSchema.parse(input);
  const outcome = registerHomeSession(parsed);
  if (!outcome.ok) return { status: outcome.status, body: { error: outcome.error } };
  return {
    status: 200,
    body: { sessionId: outcome.row.sessionId, repoRoot: outcome.row.repoRoot, created: outcome.created },
  };
}
