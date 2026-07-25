import { AGENT_TYPES, THINKING_LEVELS, PERMISSION_MODES } from "@shared/types.ts";
import type { AgentType, PermissionMode, ThinkingLevel } from "@shared/types.ts";
// The same helper the schedule store narrows its five persisted enums with, and for the
// same doctrine: a stored value this build has never heard of reads as `null`, never as the
// nearest thing we do know.
import { readPersistedEnum } from "@shared/schedules.ts";
import { openDb } from "../db.ts";

/**
 * Durable rows for embedded (SDK-runtime) sessions.
 *
 * Mechanism only - no policy, no Registry emit, no launching. The split is the one
 * `schedules/store.ts` documents: an SSE emission cannot be rolled back, so the thing that
 * can still fail must not be the thing that announced itself. `SdkSupervisor` sequences
 * these calls and announces afterwards.
 *
 * Runs on the connection `openDb()` already owns. It opens no second handle: the daemon is
 * the only writer of this database and one file with two handles is how that stops being
 * true.
 */

/**
 * What has become of an embedded session.
 *
 * APPEND-ONLY. These strings are persisted in `sdk_sessions.status`, so renaming one does
 * not migrate the rows written under the old spelling - it makes them unreadable, and an
 * unreadable status is a session the restore sweep cannot reason about (see
 * `readSdkStatus`).
 *
 *  - `starting`: launched, no `bound` event yet.
 *  - `running`: bound and driving. The only status a restart has to do something about.
 *  - `exited`: the driver ended, for any reason it reported.
 *  - `failed`: we could not keep it - a launch that threw, or a resume nothing could honour.
 */
export const SDK_SESSION_STATUSES = ["starting", "running", "exited", "failed"] as const;
export type SdkSessionStatus = (typeof SDK_SESSION_STATUSES)[number];

/** The statuses a restart has to deal with: a session that believed it was alive. */
const LIVE_STATUSES: readonly SdkSessionStatus[] = ["starting", "running"];

/**
 * One persisted embedded session.
 *
 * Every field that could carry a value written by a NEWER build is `T | null`, so a caller
 * cannot reach a policy without saying what it does when there isn't one - the shape the
 * schedule store argues for at length. A row whose `status` is unreadable still LOADS
 * (a session nobody can see is one nobody can clean up) and reports `status: null`.
 */
export interface SdkSessionRow {
  id: string;
  agent: AgentType | null;
  agentSessionId: string | null;
  cwd: string;
  taskId: string | null;
  model: string | null;
  effort: ThinkingLevel | null;
  permissionMode: PermissionMode | null;
  status: SdkSessionStatus | null;
  /** The raw status as stored, so a refusal can say what it could not read. */
  statusRaw: string;
  createdAt: number;
  updatedAt: number;
}

/** What the supervisor writes when it launches (or relaunches) a session. */
export interface SdkSessionWrite {
  id: string;
  agent: AgentType;
  agentSessionId: string | null;
  cwd: string;
  taskId: string | null;
  model: string | null;
  effort: ThinkingLevel | null;
  permissionMode: PermissionMode | null;
  status: SdkSessionStatus;
}

interface Row {
  id: string;
  agent: string;
  agent_session_id: string | null;
  cwd: string;
  task_id: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

function mapRow(r: Row): SdkSessionRow {
  return {
    id: r.id,
    agent: readPersistedEnum(AGENT_TYPES, r.agent),
    agentSessionId: r.agent_session_id,
    cwd: r.cwd,
    taskId: r.task_id,
    model: r.model,
    effort: readPersistedEnum(THINKING_LEVELS, r.effort),
    permissionMode: readPersistedEnum(PERMISSION_MODES, r.permission_mode),
    status: readPersistedEnum(SDK_SESSION_STATUSES, r.status),
    statusRaw: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Whether this row believed it was alive.
 *
 * An UNREADABLE status is not live, deliberately: it was written by a build that knows
 * something this one does not, and the conservative act is to leave it alone rather than
 * fail a session a newer daemon may be able to resume. The restore sweep reports what it
 * skipped instead of silently coercing it.
 */
export function sdkSessionIsLive(row: SdkSessionRow): boolean {
  return row.status !== null && LIVE_STATUSES.includes(row.status);
}

/** Every persisted embedded session, oldest first. Read once, on restore. */
export function listSdkSessions(): SdkSessionRow[] {
  return openDb()
    .prepare(
      `SELECT id, agent, agent_session_id, cwd, task_id, model, effort, permission_mode,
              status, created_at, updated_at
         FROM sdk_sessions ORDER BY created_at ASC`,
    )
    .all()
    .map((r) => mapRow(r as unknown as Row));
}

export function getSdkSession(id: string): SdkSessionRow | null {
  const row = openDb()
    .prepare(
      `SELECT id, agent, agent_session_id, cwd, task_id, model, effort, permission_mode,
              status, created_at, updated_at
         FROM sdk_sessions WHERE id = ?`,
    )
    .get(id) as unknown as Row | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Write (or rewrite) a session's row.
 *
 * Upsert on the id rather than insert, because the id outlives the process: a resume after a
 * restart is the SAME session continuing, so it must land on the same row - two rows for one
 * conversation would give a second restart two things to resume.
 */
export function upsertSdkSession(write: SdkSessionWrite, now = Date.now()): void {
  openDb()
    .prepare(
      `INSERT INTO sdk_sessions (id, agent, agent_session_id, cwd, task_id, model, effort,
                                 permission_mode, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent = excluded.agent,
         agent_session_id = excluded.agent_session_id,
         cwd = excluded.cwd,
         task_id = excluded.task_id,
         model = excluded.model,
         effort = excluded.effort,
         permission_mode = excluded.permission_mode,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .run(
      write.id,
      write.agent,
      write.agentSessionId,
      write.cwd,
      write.taskId,
      write.model,
      write.effort,
      write.permissionMode,
      write.status,
      now,
      now,
    );
}

/** Record the harness-native session id, which is what a later resume is cut from. */
export function recordSdkSessionBinding(
  id: string,
  agentSessionId: string,
  now = Date.now(),
): void {
  openDb()
    .prepare(
      `UPDATE sdk_sessions SET agent_session_id = ?, status = ?, updated_at = ? WHERE id = ?`,
    )
    .run(agentSessionId, "running" satisfies SdkSessionStatus, now, id);
}

export function setSdkSessionStatus(
  id: string,
  status: SdkSessionStatus,
  now = Date.now(),
): void {
  openDb()
    .prepare(`UPDATE sdk_sessions SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, now, id);
}
