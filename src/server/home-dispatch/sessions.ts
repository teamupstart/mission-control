import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Handler } from "hono";
import { HOST, PORT } from "../config.ts";
import { inTransaction, openDb } from "../db.ts";
import { parseBody } from "../http-body.ts";
import { resolveRepoRoot } from "../repos.ts";
import { SERVICE_VERSION } from "../version.ts";
import {
  HOME_DISPATCH_MIN_MOD_API,
  HomeSessionRegistrationSchema,
  type HomeSessionRegistration,
  type HomeSessionRegistrationAnswer,
} from "@shared/home-dispatch.ts";
import { isTerminalTask } from "@shared/task-status.ts";
import { registrationCounts } from "./inbox.ts";
import { launcherPromptSetting, shouldOfferLauncher } from "./launcher.ts";
import type { HomeDispatchDeps, HomeDispatchHandler } from "./stub.ts";

// Owner: P3. `POST /dispatch/sessions` registers a home session (spec 7.2), and this file holds
// the home-session rules every other `/dispatch/*` route calls (P4, P5, P7, P8, P9): none may
// re-implement them. The intent detector is `dispatchIntentFor` in `@shared/home-dispatch.ts`,
// where the mod can import it; it is re-exported here so the server has one import site.
export { dispatchIntentFor } from "@shared/home-dispatch.ts";

/** Who is calling a `/dispatch/*` route (7.2). */
export type HomeDispatchCaller =
  | { surface: "home-session"; sessionId: string; repoRoot: string | null }
  | { surface: "cli"; repoRoot: string | null };

/** What a task records about where it came from (spec 2.4): `tasks.origin_surface` and `origin_repo`. */
export interface TaskOrigin {
  originSurface: "home-session" | "mctl" | null;
  originRepo: string | null;
  /** `tasks.origin_session_id`. A home session always reads the tasks it started, whatever repository it is registered in now. */
  originSessionId?: string | null;
}

/** A refusal is always a 403 with its reason, never a 404 that hides it (7.2). */
export interface HomeSessionRefusal {
  status: 403;
  reason: string;
}

export interface HomeSessionRow {
  sessionId: string;
  harness: string;
  cwd: string;
  repoRoot: string | null;
  clientVersion: string | null;
  startSource: string | null;
  entrypoint: string | null;
  launcherOfferedAt: number | null;
  launcherDisabled: boolean;
  startedAt: number;
}

/** The real path of `p`, or null when `realpathSync` cannot fully resolve it for any reason. */
function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** True when the resolved path `child` is `parent` or lies inside it, never by name prefix. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  // A parent-directory component is `..` alone or `..` followed by a separator; a name that
  // merely begins with two dots (`..notes`) is a child.
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function deny(reason: string): HomeSessionRefusal {
  return { status: 403, reason };
}

function workerDeny(reason: string): HomeSessionRefusal {
  return deny(`not available inside a Mission Control worker: ${reason}`);
}

/**
 * Why this session id may not register, or null when it may (7.2). A worker is a session the
 * registry knows as Mission-managed: an SDK session, or one bound to a task, whether it is
 * named by its Mission id (what `MISSION_SESSION_ID` carries) or its harness session id. A
 * session whose `cwd` lies inside the worktree of a task that is not done, failed or cancelled
 * is refused too. A terminal session the daemon only discovered, with no task, may register.
 * The daemon's rule is the authority (L29); the mod's own check only saves a request.
 */
export function workerRefusal(
  deps: Pick<HomeDispatchDeps, "registry">,
  sessionId: string,
  cwd: string | undefined,
  options: { onUnresolvableCwd?: "refuse" | "skip" } = {},
): HomeSessionRefusal | null {
  const { registry } = deps;
  const known =
    registry.getSession(sessionId) ??
    registry.snapshot().sessions.find((s) => s.agentSessionId === sessionId);
  const tasks = registry.listTasks();
  if (known) {
    if (known.runtime === "sdk") return workerDeny("this session is a Mission Control worker");
    // A finished task no longer makes its terminal session a worker, as with the worktree rule
    // below: worker status tracks the task's current state, not its history. An SDK session is
    // refused above whatever its task did.
    if (tasks.some((t) => t.sessionId === known.id && !isTerminalTask(t.status))) {
      return workerDeny("this session is bound to a Mission Control task");
    }
  }
  if (cwd) {
    // One fail-closed rule at registration: a cwd that `realpathSync` cannot fully resolve (it
    // is missing, a dangling or looping link, or unreadable) cannot be shown to lie outside a
    // worker's worktree, so it is refused rather than compared by its unresolved spelling. A
    // later call for an already registered session passes `skip`: its cwd was verified when it
    // registered, and a directory that has since vanished must not lock the session out.
    const real = realPath(cwd);
    if (real === null) {
      if (options.onUnresolvableCwd === "skip") return null;
      return workerDeny("this session's working directory cannot be resolved, so it cannot be verified");
    }
    for (const task of tasks) {
      if (isTerminalTask(task.status)) continue;
      const trees = [task.worktreePath, ...task.extraRepos.map((r) => r.worktreePath)];
      for (const tree of trees) {
        const realTree = tree ? realPath(tree) : null;
        if (realTree !== null && isInside(real, realTree)) {
          return workerDeny("this session is inside the worktree of a Mission Control task");
        }
      }
    }
  }
  return null;
}

interface HomeSessionDbRow {
  session_id: string;
  harness: string;
  cwd: string;
  repo_root: string | null;
  client_version: string | null;
  start_source: string | null;
  entrypoint: string | null;
  launcher_offered_at: number | null;
  launcher_disabled: number;
  started_at: number;
}

/** The registered home session with this id, or null. */
export function getHomeSession(sessionId: string): HomeSessionRow | null {
  const r = openDb()
    .prepare(`SELECT * FROM home_dispatch_sessions WHERE session_id = ?`)
    .get(sessionId) as HomeSessionDbRow | undefined;
  if (!r) return null;
  return {
    sessionId: r.session_id,
    harness: r.harness,
    cwd: r.cwd,
    repoRoot: r.repo_root,
    clientVersion: r.client_version,
    startSource: r.start_source,
    entrypoint: r.entrypoint,
    launcherOfferedAt: r.launcher_offered_at,
    launcherDisabled: r.launcher_disabled !== 0,
    startedAt: r.started_at,
  };
}

/**
 * The one answer to "may this session act as a home session?". It is a registered session
 * and never a worker, so a session that registered and later became bound to a task is
 * refused too. Every route that takes a `sessionId` calls this first.
 */
export function requireHomeSession(
  deps: Pick<HomeDispatchDeps, "registry">,
  sessionId: string,
): { ok: true; session: HomeSessionRow } | { ok: false; refusal: HomeSessionRefusal } {
  const session = getHomeSession(sessionId);
  if (!session) return { ok: false, refusal: deny("this session is not registered as a home session") };
  const worker = workerRefusal(deps, sessionId, session.cwd, { onUnresolvableCwd: "skip" });
  return worker ? { ok: false, refusal: worker } : { ok: true, session };
}

function sameRepo(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const ra = realPath(a);
  return ra !== null && ra === realPath(b);
}

/** `residentVisible` is P9's answer to 7.24 for a resident run's task. */
export interface TaskRuleOptions {
  residentVisible?: boolean;
}

/**
 * Whether a caller may read a task (7.2). A home session has three independent paths: a task it
 * started itself (`origin_session_id` is its id), even if it has since registered from another
 * repository; a task whose `origin_repo` is its own repository; or the task of a resident run it
 * can see (`residentVisible`). A repository-less session cannot match on repository, so it has
 * only the first and third paths. The `cli` reads
 * any home-dispatched task (origin `home-session` or `mctl`) of the repository it names.
 */
export function canReadTask(
  caller: HomeDispatchCaller,
  task: TaskOrigin,
  options: TaskRuleOptions = {},
): HomeSessionRefusal | null {
  if (caller.surface === "cli") {
    if (task.originSurface === null) return deny("a dashboard task is not readable from the command line");
    return sameRepo(caller.repoRoot, task.originRepo) ? null : deny("the task belongs to a different repository");
  }
  if (options.residentVisible) return null;
  if (task.originSurface === null) return deny("a dashboard task is not readable from a home session");
  // A session always reads the tasks it started, wherever it is registered now: a later
  // registration from another repository updates `repo_root` but not who started the task.
  if (task.originSessionId != null && task.originSessionId === caller.sessionId) return null;
  if (caller.repoRoot === null && task.originRepo === null) {
    // A session outside any repository has no repository to match on, and two such sessions are
    // not the same context, so it reads only the tasks it started itself (allowed above).
    return deny("the task was started from another session outside a repository");
  }
  return sameRepo(caller.repoRoot, task.originRepo)
    ? null
    : deny("the task belongs to a different repository than this session");
}

/** Whether a caller may answer a task: a home session as it reads; the `cli` only an `mctl` task. */
export function canAnswerTask(
  caller: HomeDispatchCaller,
  task: TaskOrigin,
  options: TaskRuleOptions = {},
): HomeSessionRefusal | null {
  const read = canReadTask(caller, task, options);
  if (read) return read;
  if (caller.surface === "cli" && task.originSurface !== "mctl") {
    return deny("the command line answers only tasks it started");
  }
  return null;
}

/** Whether a caller may message a task's worker: home sessions only, as they read; never the `cli`. */
export function canMessageTask(
  caller: HomeDispatchCaller,
  task: TaskOrigin,
  options: TaskRuleOptions = {},
): HomeSessionRefusal | null {
  if (caller.surface === "cli") return deny("the command line never messages a session");
  return canReadTask(caller, task, options);
}

/** `counts` for the banner, read from the inbox (7.2): running tasks, and what needs the person. */
export function sessionCounts(
  deps: Pick<HomeDispatchDeps, "registry" | "workflows">,
  repoRoot: string | null,
  sessionId: string,
): HomeSessionRegistrationAnswer["counts"] {
  return registrationCounts(deps, repoRoot, sessionId);
}

/**
 * Records a registration. The read, the launcher decision and the write run in one
 * `BEGIN IMMEDIATE` transaction, so two registrations of one session id that arrive together
 * serialize: exactly one creates the row and can be offered the launcher, and the other
 * updates it and is not.
 */
function upsertHomeSession(
  deps: Pick<HomeDispatchDeps, "registry">,
  body: HomeSessionRegistration,
  repoRoot: string | null,
  now: number,
): { refusal: HomeSessionRefusal } | { created: boolean; offered: boolean } {
  return inTransaction(() => {
    // The first check ran before the awaited repository lookup. A session bound to a task in
    // that window must not be recorded, or offered the launcher, so decide again at the write.
    const worker = workerRefusal(deps, body.sessionId, body.cwd);
    if (worker) return { refusal: worker };
    const db = openDb();
    const existing = getHomeSession(body.sessionId);
    const offered = shouldOfferLauncher({
      registration: body,
      alreadyOffered: existing?.launcherOfferedAt != null,
      promptSetting: launcherPromptSetting(),
      registeredHomeSession: true,
    });
    if (!existing) {
      db.prepare(
        `INSERT INTO home_dispatch_sessions
           (session_id, harness, cwd, repo_root, client_version, start_source, entrypoint,
            launcher_offered_at, launcher_disabled, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        body.sessionId, body.harness, body.cwd, repoRoot, body.clientVersion, body.source,
        body.entrypoint, offered ? now : null, body.launcherDisabled ? 1 : 0, now,
      );
    } else {
      // A re-registration (a retry, a poll after a daemon restart) keeps the first offer and start.
      db.prepare(
        `UPDATE home_dispatch_sessions
            SET cwd = ?, repo_root = ?, client_version = ?, launcher_disabled = ?,
                launcher_offered_at = COALESCE(launcher_offered_at, ?)
          WHERE session_id = ?`,
      ).run(body.cwd, repoRoot, body.clientVersion, body.launcherDisabled ? 1 : 0, offered ? now : null, body.sessionId);
    }
    return { created: !existing, offered };
  });
}

/** `POST /dispatch/sessions` (7.2). Sets no runtime on any session or task. */
export const registerSessionHandler: HomeDispatchHandler = (deps): Handler => async (c) => {
  const parsed = await parseBody(c, HomeSessionRegistrationSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const worker = workerRefusal(deps, body.sessionId, body.cwd);
  if (worker) return c.json({ error: worker.reason }, worker.status);
  const repoRoot = await resolveRepoRoot(body.cwd);
  const written = upsertHomeSession(deps, body, repoRoot, Date.now());
  if ("refusal" in written) return c.json({ error: written.refusal.reason }, written.refusal.status);
  const { created, offered } = written;
  const answer: HomeSessionRegistrationAnswer = {
    sessionId: body.sessionId,
    repoRoot,
    created,
    offerLauncher: offered,
    counts: sessionCounts(deps, repoRoot, body.sessionId),
    daemonVersion: SERVICE_VERSION,
    minModApi: HOME_DISPATCH_MIN_MOD_API,
    dashboardUrl: `http://${HOST}:${PORT}/`,
  };
  return c.json(answer);
};
