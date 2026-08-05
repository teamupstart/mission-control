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
 *  - `running`: bound and driving.
 *  - `exited`: the driver ended, for any reason it reported.
 *  - `failed`: we could not keep it - a launch that threw, or a resume nothing could honour.
 *  - `suspended`: WE ended it, because the daemon was going down. The distinction from
 *    `exited` is the whole of resume-on-restart: an embedded session's subprocess is our
 *    child, so a restart necessarily stops it, and a shutdown that recorded that as
 *    `exited` would make every clean restart indistinguishable from an agent that finished
 *    - reclaiming worktrees out from under work that was merely interrupted.
 */
export const SDK_SESSION_STATUSES = [
  "starting",
  "running",
  "exited",
  "failed",
  "suspended",
] as const;
export type SdkSessionStatus = (typeof SDK_SESSION_STATUSES)[number];

/**
 * The statuses a restart has to deal with: a session that was alive when we last looked.
 *
 * `suspended` is here for the reason it exists at all - we stopped it on the way down and
 * promised to pick it back up. `starting` and `running` are the crash cases, where nobody
 * got to write anything and the row is the last thing that was true.
 */
const LIVE_STATUSES: readonly SdkSessionStatus[] = ["starting", "running", "suspended"];

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
  /**
   * The driver accepted work that has not produced `turn_done`.
   *
   * Separate from `status`: a clean shutdown writes `suspended` while deliberately
   * preserving this bit, so startup knows whether merely reattaching the conversation is
   * enough or whether the interrupted work needs a continuation turn.
   */
  turnInProgress: boolean;
  /**
   * The name a person gave this session, or null when nobody has renamed it.
   *
   * Null is load-bearing and must not be collapsed to the derived name: it is what makes a
   * card keep following its task's title (which a dispatch refines asynchronously) until an
   * operator overrides it, and what makes that override outrank the title forever after. See
   * `restoredName`, the one reader that resolves the two.
   */
  displayName: string | null;
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
  turnInProgress: boolean;
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
  turn_in_progress: number;
  display_name: string | null;
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
    turnInProgress: r.turn_in_progress === 1,
    // Trimmed to null, not passed through: a row whose name is blank (or whitespace an older
    // build let through) has nothing to display, and the derived name is a better answer than
    // an empty heading. `setSdkSessionDisplayName` refuses to write one, so this only ever
    // catches a row this build did not author.
    displayName: r.display_name?.trim() || null,
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
              status, turn_in_progress, display_name, created_at, updated_at
         FROM sdk_sessions ORDER BY created_at ASC`,
    )
    .all()
    .map((r) => mapRow(r as unknown as Row));
}

export function getSdkSession(id: string): SdkSessionRow | null {
  const row = openDb()
    .prepare(
      `SELECT id, agent, agent_session_id, cwd, task_id, model, effort, permission_mode,
              status, turn_in_progress, display_name, created_at, updated_at
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
                                 permission_mode, status, turn_in_progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent = excluded.agent,
         agent_session_id = excluded.agent_session_id,
         cwd = excluded.cwd,
         task_id = excluded.task_id,
         model = excluded.model,
         effort = excluded.effort,
         permission_mode = excluded.permission_mode,
         status = excluded.status,
         turn_in_progress = excluded.turn_in_progress,
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
      write.turnInProgress ? 1 : 0,
      now,
      now,
    );
}

/** Record the harness-native session id, which is what a later resume is cut from. */
export function recordSdkSessionBinding(
  id: string,
  agentSessionId: string,
  modelId: string | null,
  now = Date.now(),
): void {
  openDb()
    .prepare(
      `UPDATE sdk_sessions
          SET agent_session_id = ?, model = COALESCE(?, model), status = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(agentSessionId, modelId, "running" satisfies SdkSessionStatus, now, id);
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

/**
 * Record the name a person gave this session, so a restart brings the card back under it.
 *
 * Deliberately NOT part of `upsertSdkSession`: that write is the launch/relaunch statement,
 * and an adopt on startup runs it again. Carrying the name through it would mean every
 * restore had to remember to re-supply a value it does not own, and forgetting once is a
 * rename silently reverting to the task title. A separate one-column UPDATE cannot make that
 * mistake, which is the same reason `status` and `turn_in_progress` have their own writers.
 *
 * Returns whether a row was actually updated, so a caller can tell "renamed" from "there is
 * no such embedded session" rather than reporting success for a write that hit nothing.
 */
export function setSdkSessionDisplayName(
  id: string,
  name: string,
  now = Date.now(),
): boolean {
  // The trim is the store's own, not the caller's, because this is the value that outlives
  // the process: a name that only LOOKS right because some route trimmed it on the way past
  // is one a different route can persist untrimmed.
  const display = name.trim();
  if (!display) return false;
  const r = openDb()
    .prepare(`UPDATE sdk_sessions SET display_name = ?, updated_at = ? WHERE id = ?`)
    .run(display, now, id);
  return r.changes > 0;
}

/** Record whether startup owes this conversation an automatic continuation turn. */
export function setSdkSessionTurnInProgress(
  id: string,
  turnInProgress: boolean,
  now = Date.now(),
): void {
  openDb()
    .prepare(`UPDATE sdk_sessions SET turn_in_progress = ?, updated_at = ? WHERE id = ?`)
    .run(turnInProgress ? 1 : 0, now, id);
}

export function clearSdkSessionTask(id: string, now = Date.now()): void {
  openDb()
    .prepare(`UPDATE sdk_sessions SET task_id = NULL, updated_at = ? WHERE id = ?`)
    .run(now, id);
}

/**
 * Put a task association back on a row.
 *
 * The undo of `clearSdkSessionTask`, and it exists for one caller: a terminal handoff
 * unbinds BOTH the task and this row before it stops the driver, so that an ordinary
 * transfer does not settle a task that is merely moving. When the stop then fails and the
 * driver is still alive, that unbinding has to be taken back or a live embedded session is
 * left with no task pointing at it - which is `taskLiveness` answering `null` for a task
 * whose agent is right there, and a restart reclaiming its worktree on that answer.
 */
export function restoreSdkSessionTask(id: string, taskId: string, now = Date.now()): void {
  openDb()
    .prepare(`UPDATE sdk_sessions SET task_id = ?, updated_at = ? WHERE id = ?`)
    .run(taskId, now, id);
}

export function setSdkSessionPermissionMode(
  id: string,
  permissionMode: PermissionMode,
  now = Date.now(),
): void {
  openDb()
    .prepare(`UPDATE sdk_sessions SET permission_mode = ?, updated_at = ? WHERE id = ?`)
    .run(permissionMode, now, id);
}

export function setSdkSessionEffort(
  id: string,
  effort: ThinkingLevel,
  now = Date.now(),
): void {
  openDb()
    .prepare(`UPDATE sdk_sessions SET effort = ?, updated_at = ? WHERE id = ?`)
    .run(effort, now, id);
}

/**
 * The third of the three, and the one that was missing.
 *
 * `SdkSessionHandle.setModel` has existed since the driver interface did, and `resume`
 * has always relaunched from `row.model` - but nothing wrote that column after the
 * launch, so a model change would have been the one control of the three that did not
 * survive a restart. It had no caller, which is why nothing had lost anything through it
 * yet; an interface slot whose persistence is missing is a trap for whoever adds the
 * first one, so the three are made consistent here rather than left to be remembered.
 */
export function setSdkSessionModel(id: string, model: string, now = Date.now()): void {
  openDb()
    .prepare(`UPDATE sdk_sessions SET model = ?, updated_at = ? WHERE id = ?`)
    .run(model, now, id);
}
