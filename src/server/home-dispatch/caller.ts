import type { Context } from "hono";
import { openDb } from "../db.ts";
import { resolveRepoRoot } from "../repos.ts";
import { requireHomeSession, type HomeDispatchCaller, type TaskOrigin } from "./sessions.ts";
import type { HomeDispatchDeps } from "./stub.ts";

// Owner: P4. Who is calling a `/dispatch/*` read or answer route (spec 7.2): the mod, as a
// registered home session, or `mctl`. The home-session rules themselves live in `sessions.ts` and
// are only called from here; this file never re-implements one.

/** The header the mod and `mctl` send to say which of them is calling (`mod` or `cli`). */
export const SURFACE_HEADER = "x-harness-surface";

export interface ResolvedCaller {
  caller: HomeDispatchCaller;
  /** The home session's id, or null for `mctl`. */
  sessionId: string | null;
  /** `repo=*` from the command line: every repository's items. */
  allRepos: boolean;
}

export type CallerOutcome =
  | { ok: true; resolved: ResolvedCaller }
  | { ok: false; status: 400 | 403; error: string };

/** Whether the request names itself as `mctl`. Anything else is treated as the mod, the stricter surface. */
export function isCliRequest(c: Context): boolean {
  return c.req.header(SURFACE_HEADER)?.trim().toLowerCase() === "cli";
}

/**
 * Resolves the caller of a route. A `cli` caller scopes itself with `repo` (a path, or `*` for
 * every repository) or `cwd`, and has no session. Any other caller must name a registered home
 * session that is not a worker, and is scoped to that session's repository: `repo=*` and a
 * `repo` that names another repository are refused, with the reason.
 */
export async function resolveCaller(
  deps: Pick<HomeDispatchDeps, "registry">,
  c: Context,
  input: { sessionId?: string | undefined; repo?: string | undefined; cwd?: string | undefined },
): Promise<CallerOutcome> {
  if (isCliRequest(c)) {
    if (input.repo === "*") {
      return { ok: true, resolved: { caller: { surface: "cli", repoRoot: null }, sessionId: null, allRepos: true } };
    }
    const path = input.repo ?? input.cwd;
    if (!path) return { ok: false, status: 400, error: "name the repository with repo (a path, or * for every repository)" };
    const repoRoot = await resolveRepoRoot(path);
    return { ok: true, resolved: { caller: { surface: "cli", repoRoot }, sessionId: null, allRepos: false } };
  }
  if (!input.sessionId) return { ok: false, status: 400, error: "session is required" };
  const gate = requireHomeSession(deps, input.sessionId);
  if (!gate.ok) return { ok: false, status: gate.refusal.status, error: gate.refusal.reason };
  if (input.repo === "*") {
    return { ok: false, status: 403, error: "repo=* is available from the command line only" };
  }
  const repoRoot = gate.session.repoRoot;
  if (input.repo) {
    const asked = await resolveRepoRoot(input.repo);
    if (asked !== repoRoot) {
      return { ok: false, status: 403, error: "a home session reads only the repository it is registered in" };
    }
  }
  return {
    ok: true,
    resolved: { caller: { surface: "home-session", sessionId: input.sessionId, repoRoot }, sessionId: input.sessionId, allRepos: false },
  };
}

interface OriginRow {
  id: string;
  origin_surface: string | null;
  origin_repo: string | null;
  origin_session_id: string | null;
}

/** Where every home-dispatched task came from (`tasks.origin_*`). A dashboard task has no entry. */
export function taskOrigins(): Map<string, TaskOrigin> {
  const rows = openDb()
    .prepare(`SELECT id, origin_surface, origin_repo, origin_session_id FROM tasks WHERE origin_surface IS NOT NULL`)
    .all() as unknown as OriginRow[];
  return new Map(rows.map((r) => [r.id, originOf(r)]));
}

function originOf(r: OriginRow): TaskOrigin {
  return {
    originSurface: r.origin_surface === "home-session" || r.origin_surface === "mctl" ? r.origin_surface : null,
    originRepo: r.origin_repo,
    originSessionId: r.origin_session_id,
  };
}

/** The origin of one task, with `originSurface: null` for a dashboard task. */
export function taskOriginOf(taskId: string): TaskOrigin {
  const r = openDb()
    .prepare(`SELECT id, origin_surface, origin_repo, origin_session_id FROM tasks WHERE id = ?`)
    .get(taskId) as OriginRow | undefined;
  return r ? originOf(r) : { originSurface: null, originRepo: null, originSessionId: null };
}
