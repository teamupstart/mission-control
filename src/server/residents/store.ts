import type { DatabaseSync } from "node:sqlite";
import { normalizePersonaName } from "@shared/workflow.ts";
import {
  RESIDENT_LAUNCH_STATES,
  RESIDENT_LIMITS,
  ResidentPersonaSnapshotSchema,
  ResidentProfileRevisionSchema,
  canonicalResidentJson,
  type ResidentLaunchInput,
  type ResidentLaunchState,
  type ResidentPersonaSnapshot,
  type ResidentProfile,
  type ResidentProfileRevision,
  type ResidentRun,
} from "@shared/residents.ts";
import { openDb } from "../db.ts";

/**
 * Durable storage for resident profiles and runs.
 *
 * Mechanism only, on the daemon's one connection. Nothing here emits a Registry event: an SSE
 * frame cannot be rolled back, so `ResidentManager` announces a change after these calls
 * return. Every multi-statement write is one `BEGIN IMMEDIATE` transaction, joined rather than
 * nested when a caller (a settings restore) already holds one.
 */

interface ProfileRow {
  id: string;
  name: string;
  normalized_name: string;
  revision: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  settings_json: string;
}

interface RunRow {
  id: string;
  profile_id: string;
  profile_revision: number;
  task_id: string;
  launch_request_id: string;
  launch_input: string;
  launch_state: string;
  launch_error: string | null;
  persona_snapshot: string;
  run_instructions: string;
  created_at: number;
  ended_at: number | null;
  settings_json: string | null;
}

/** The same normalization Personas use, so two spellings of one name are one identity. */
export function normalizeResidentName(name: string): string {
  return normalizePersonaName(name);
}

/** A live profile already uses this name. */
export class ResidentNameConflictError extends Error {}

/** The machine already holds the maximum number of live profiles. */
export class ResidentProfileLimitError extends Error {}

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

/** A stored revision, or null when this build cannot read it. One bad row costs one profile. */
function parseSettings(raw: string): ResidentProfileRevision | null {
  try {
    const parsed = ResidentProfileRevisionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function rowToProfile(row: ProfileRow): ResidentProfile | null {
  const settings = parseSettings(row.settings_json);
  if (!settings) return null;
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settings,
  };
}

const PROFILE_SELECT = `
  SELECT p.id, p.name, p.normalized_name, p.revision, p.archived_at, p.created_at,
         p.updated_at, r.settings_json
    FROM resident_profiles p
    JOIN resident_profile_revisions r ON r.profile_id = p.id AND r.revision = p.revision`;

export function getResidentProfile(id: string): ResidentProfile | null {
  const row = openDb().prepare(`${PROFILE_SELECT} WHERE p.id = ?`).get(id) as ProfileRow | undefined;
  return row ? rowToProfile(row) : null;
}

/** Live profiles by name, bounded by `RESIDENT_LIMITS.liveProfiles`. */
export function listLiveResidentProfiles(): ResidentProfile[] {
  const rows = openDb()
    .prepare(`${PROFILE_SELECT} WHERE p.archived_at IS NULL ORDER BY p.normalized_name, p.id LIMIT ?`)
    .all(RESIDENT_LIMITS.liveProfiles) as unknown as ProfileRow[];
  return rows.flatMap((row) => rowToProfile(row) ?? []);
}

/** Every profile, archived included, for the settings backup capture. */
export function listAllResidentProfiles(): ResidentProfile[] {
  const rows = openDb()
    .prepare(`${PROFILE_SELECT} ORDER BY p.id`)
    .all() as unknown as ProfileRow[];
  return rows.flatMap((row) => rowToProfile(row) ?? []);
}

/**
 * The profiles a settings snapshot carries, at most `limit`: every live profile (bounded at
 * `RESIDENT_LIMITS.liveProfiles`), then the most recently archived ones up to the limit, in id
 * order. Archive never deletes rows, so carrying the whole history would eventually outgrow a
 * snapshot catalog and stop automatic backups. Leaving the oldest archived rows out changes no
 * restore: restore only archives LIVE profiles a snapshot omits, so an omitted archived profile
 * stays archived exactly as it would have if it had been carried.
 */
export function listBackupResidentProfiles(limit: number): ResidentProfile[] {
  const d = openDb();
  const live = d
    .prepare(`${PROFILE_SELECT} WHERE p.archived_at IS NULL ORDER BY p.id`)
    .all() as unknown as ProfileRow[];
  const room = Math.max(0, limit - live.length);
  const archived = room === 0 ? [] : d
    .prepare(`${PROFILE_SELECT} WHERE p.archived_at IS NOT NULL ORDER BY p.archived_at DESC, p.id LIMIT ?`)
    .all(room) as unknown as ProfileRow[];
  return [...live, ...archived]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((row) => rowToProfile(row) ?? []);
}

/**
 * Any pinned revision of a profile, or null. The daemon's one read of a live run's settings:
 * the profile's current revision is for new launches only.
 */
export function residentProfileRevision(
  profileId: string,
  revision: number,
): ResidentProfileRevision | null {
  const row = openDb()
    .prepare(`SELECT settings_json FROM resident_profile_revisions WHERE profile_id = ? AND revision = ?`)
    .get(profileId, revision) as { settings_json: string } | undefined;
  return row ? parseSettings(row.settings_json) : null;
}

function insertRevision(
  d: DatabaseSync,
  profileId: string,
  revision: number,
  settings: ResidentProfileRevision,
  at: number,
): void {
  d.prepare(
    `INSERT INTO resident_profile_revisions (profile_id, revision, settings_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(profileId, revision, canonicalResidentJson(settings), at);
}

function liveNameOwner(d: DatabaseSync, normalizedName: string): string | null {
  const row = d
    .prepare(`SELECT id FROM resident_profiles WHERE normalized_name = ? AND archived_at IS NULL`)
    .get(normalizedName) as { id: string } | undefined;
  return row?.id ?? null;
}

export function createResidentProfile(input: {
  id: string;
  settings: ResidentProfileRevision;
  at: number;
}): ResidentProfile {
  const d = openDb();
  return inTransaction(d, () => {
    const name = input.settings.identity.name;
    const normalized = normalizeResidentName(name);
    if (liveNameOwner(d, normalized)) {
      throw new ResidentNameConflictError(`a resident named ${name} already exists`);
    }
    const live = d
      .prepare(`SELECT COUNT(*) AS n FROM resident_profiles WHERE archived_at IS NULL`)
      .get() as { n: number };
    if (live.n >= RESIDENT_LIMITS.liveProfiles) {
      throw new ResidentProfileLimitError(
        `at most ${RESIDENT_LIMITS.liveProfiles} live resident profiles are allowed; archive one first`,
      );
    }
    d.prepare(
      `INSERT INTO resident_profiles (id, name, normalized_name, revision, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, NULL, ?, ?)`,
    ).run(input.id, name, normalized, input.at, input.at);
    insertRevision(d, input.id, 1, input.settings, input.at);
    const created = getResidentProfile(input.id);
    if (!created) throw new Error(`resident profile ${input.id} vanished during create`);
    return created;
  });
}

export type ResidentProfileWrite =
  | { status: "ok"; profile: ResidentProfile }
  | { status: "not_found" }
  | { status: "archived"; profile: ResidentProfile }
  | { status: "stale"; profile: ResidentProfile };

/**
 * Write revision n+1, compare-and-set on the revision the editor read. The revision number is
 * read inside the transaction so two racing saves cannot both claim n+1.
 */
export function updateResidentProfile(input: {
  id: string;
  expectedRevision: number;
  settings: ResidentProfileRevision;
  at: number;
}): ResidentProfileWrite {
  const d = openDb();
  return inTransaction(d, () => {
    const current = getResidentProfile(input.id);
    if (!current) return { status: "not_found" };
    if (current.archivedAt !== null) return { status: "archived", profile: current };
    if (current.revision !== input.expectedRevision) return { status: "stale", profile: current };
    const name = input.settings.identity.name;
    const normalized = normalizeResidentName(name);
    const owner = liveNameOwner(d, normalized);
    if (owner && owner !== input.id) {
      throw new ResidentNameConflictError(`a resident named ${name} already exists`);
    }
    const revision = current.revision + 1;
    insertRevision(d, input.id, revision, input.settings, input.at);
    d.prepare(
      `UPDATE resident_profiles SET name = ?, normalized_name = ?, revision = ?, updated_at = ?
        WHERE id = ?`,
    ).run(name, normalized, revision, input.at, input.id);
    return { status: "ok", profile: getResidentProfile(input.id)! };
  });
}

/** Archive: hide from new launches, delete nothing. Idempotent on an archived row. */
export function archiveResidentProfile(input: {
  id: string;
  expectedRevision: number;
  at: number;
}): ResidentProfileWrite {
  const d = openDb();
  return inTransaction(d, () => {
    const current = getResidentProfile(input.id);
    if (!current) return { status: "not_found" };
    if (current.archivedAt !== null) return { status: "archived", profile: current };
    if (current.revision !== input.expectedRevision) return { status: "stale", profile: current };
    d.prepare(`UPDATE resident_profiles SET archived_at = ?, updated_at = ? WHERE id = ?`)
      .run(input.at, input.at, input.id);
    return { status: "ok", profile: getResidentProfile(input.id)! };
  });
}

/** One profile as a settings snapshot carries it. */
export interface RestoredResidentProfile {
  id: string;
  name: string;
  archivedAt: number | null;
  createdAt: number;
  settings: ResidentProfileRevision;
}

/**
 * Restore the resident catalog inside the settings restore's own transaction.
 *
 * - A profile this machine has never seen is inserted at revision 1.
 * - A profile whose settings changed gets a NEW revision rather than its stored number, so a
 *   run that pinned an existing revision keeps reading exactly what it launched with.
 * - A live profile the snapshot does not name is archived; nothing is deleted.
 *
 * Every live name is released first and re-applied per row, so a snapshot that swaps two
 * names does not collide with itself on the live-name index halfway through.
 */
export function restoreResidentProfilesInTransaction(
  rows: readonly RestoredResidentProfile[],
  at: number,
): void {
  const d = openDb();
  inTransaction(d, () => {
    d.prepare(
      `UPDATE resident_profiles SET normalized_name = char(0) || 'restore:' || id
        WHERE archived_at IS NULL`,
    ).run();
    const keep = new Set(rows.map((row) => row.id));
    const live = d.prepare(`SELECT id, name, archived_at FROM resident_profiles`).all() as Array<{
      id: string;
      name: string;
      archived_at: number | null;
    }>;
    const archive = d.prepare(
      `UPDATE resident_profiles SET archived_at = ?, normalized_name = ?, updated_at = ? WHERE id = ?`,
    );
    for (const row of live) {
      if (keep.has(row.id) || row.archived_at !== null) continue;
      archive.run(at, normalizeResidentName(row.name), at, row.id);
    }
    for (const row of rows) {
      const current = getResidentProfile(row.id);
      const normalized = normalizeResidentName(row.name);
      if (!current) {
        d.prepare(
          `INSERT INTO resident_profiles (id, name, normalized_name, revision, archived_at, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
        ).run(row.id, row.name, normalized, row.archivedAt, row.createdAt, at);
        insertRevision(d, row.id, 1, row.settings, at);
        continue;
      }
      const sameSettings =
        canonicalResidentJson(current.settings) === canonicalResidentJson(row.settings);
      const unchanged = sameSettings && current.archivedAt === row.archivedAt && current.name === row.name;
      const revision = sameSettings ? current.revision : current.revision + 1;
      if (!sameSettings) insertRevision(d, row.id, revision, row.settings, at);
      d.prepare(
        `UPDATE resident_profiles
            SET name = ?, normalized_name = ?, revision = ?, archived_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(row.name, normalized, revision, row.archivedAt, unchanged ? current.updatedAt : at, row.id);
    }
    // The write boundary's own guard on the live bound, behind the restore preflight that
    // already refuses it: throwing here rolls back the whole restore transaction, every domain.
    const restoredLive = d
      .prepare(`SELECT COUNT(*) AS n FROM resident_profiles WHERE archived_at IS NULL`)
      .get() as { n: number };
    if (restoredLive.n > RESIDENT_LIMITS.liveProfiles) {
      throw new ResidentProfileLimitError(
        `restoring would leave ${restoredLive.n} live resident profiles; at most ${RESIDENT_LIMITS.liveProfiles} are allowed`,
      );
    }
  });
}

/** Run inside a transaction on the daemon's connection, joining one already open. */
export function inResidentTransaction<T>(fn: () => T): T {
  return inTransaction(openDb(), fn);
}

// ---- runs ----

const RUN_SELECT = `
  SELECT u.id, u.profile_id, u.profile_revision, u.task_id, u.launch_request_id, u.launch_input,
         u.launch_state, u.launch_error, u.persona_snapshot, u.run_instructions, u.created_at,
         u.ended_at, r.settings_json
    FROM resident_runs u
    LEFT JOIN resident_profile_revisions r
      ON r.profile_id = u.profile_id AND r.revision = u.profile_revision`;

function readLaunchState(raw: string): ResidentLaunchState | null {
  return (RESIDENT_LAUNCH_STATES as readonly string[]).includes(raw)
    ? (raw as ResidentLaunchState)
    : null;
}

function parsePersona(raw: string): ResidentPersonaSnapshot | null {
  try {
    const parsed = ResidentPersonaSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The run as this build can read it, plus its stored launch input, or null when unreadable. */
export interface StoredResidentRun {
  run: ResidentRun;
  /** The normalized input as stored. Compared only through `launchInputsMatch`. */
  launchInput: unknown;
}

function rowToRun(row: RunRow): StoredResidentRun | null {
  const launchState = readLaunchState(row.launch_state);
  const persona = parsePersona(row.persona_snapshot);
  const settings = row.settings_json ? parseSettings(row.settings_json) : null;
  if (!launchState || !persona || !settings) return null;
  let launchInput: unknown = null;
  try {
    launchInput = JSON.parse(row.launch_input);
  } catch {
    launchInput = null;
  }
  return {
    run: {
      id: row.id,
      profileId: row.profile_id,
      profileRevision: row.profile_revision,
      taskId: row.task_id,
      launchRequestId: row.launch_request_id,
      launchState,
      launchError: row.launch_error,
      persona,
      runInstructions: row.run_instructions,
      settings,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    },
    launchInput,
  };
}

/**
 * The raw identity a replay compares against, read even when the rest of the row is not
 * readable by this build. A replay must be answerable from the row alone.
 */
export interface ResidentRunIdentity {
  id: string;
  profileId: string;
  taskId: string;
  launchState: string;
  launchError: string | null;
  launchInput: unknown;
  /** The repository exactly as the original request spelled it. */
  repoSpelling: string;
}

export function residentRunIdentityByRequest(requestId: string): ResidentRunIdentity | null {
  const row = openDb()
    .prepare(
      `SELECT id, profile_id, task_id, launch_state, launch_error, launch_input, launch_repo_spelling
         FROM resident_runs WHERE launch_request_id = ?`,
    )
    .get(requestId) as
    | {
        id: string;
        profile_id: string;
        task_id: string;
        launch_state: string;
        launch_error: string | null;
        launch_input: string;
        launch_repo_spelling: string;
      }
    | undefined;
  if (!row) return null;
  let launchInput: unknown = null;
  try {
    launchInput = JSON.parse(row.launch_input);
  } catch {
    launchInput = null;
  }
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    launchState: row.launch_state,
    launchError: row.launch_error,
    launchInput,
    repoSpelling: row.launch_repo_spelling,
  };
}

export function getResidentRun(id: string): StoredResidentRun | null {
  const row = openDb().prepare(`${RUN_SELECT} WHERE u.id = ?`).get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function residentRunForTask(taskId: string): StoredResidentRun | null {
  const row = openDb()
    .prepare(`${RUN_SELECT} WHERE u.task_id = ? ORDER BY u.created_at DESC LIMIT 1`)
    .get(taskId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

/** Runs still owed a launch outcome. */
export function listPendingResidentRuns(): StoredResidentRun[] {
  const rows = openDb()
    .prepare(`${RUN_SELECT} WHERE u.launch_state = 'pending' ORDER BY u.created_at`)
    .all() as unknown as RunRow[];
  return rows.flatMap((row) => rowToRun(row) ?? []);
}

/** Runs that have not ended, whatever their launch state. */
export function listOpenResidentRuns(): StoredResidentRun[] {
  const rows = openDb()
    .prepare(`${RUN_SELECT} WHERE u.ended_at IS NULL ORDER BY u.created_at`)
    .all() as unknown as RunRow[];
  return rows.flatMap((row) => rowToRun(row) ?? []);
}

export interface ReserveResidentRunInput {
  id: string;
  profileId: string;
  profileRevision: number;
  taskId: string;
  launchRequestId: string;
  launchInput: ResidentLaunchInput;
  /** The repository exactly as the request spelled it, trimmed. */
  repoSpelling: string;
  persona: ResidentPersonaSnapshot;
  runInstructions: string;
  at: number;
}

/**
 * Reserve a run in one write, or report that another reservation already holds the request id.
 *
 * `ON CONFLICT DO NOTHING` against the unique request index: two concurrent launches with one
 * id both reach this line, exactly one inserts, and the other reads `reserved: false` instead
 * of a raw SQLite constraint error. The caller re-reads the winner and compares.
 */
export function reserveResidentRun(input: ReserveResidentRunInput): { reserved: boolean } {
  const info = openDb()
    .prepare(
      `INSERT INTO resident_runs (
         id, profile_id, profile_revision, task_id, launch_request_id, launch_input,
         launch_repo_spelling, launch_state, launch_error, persona_snapshot, run_instructions,
         created_at, ended_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL)
       ON CONFLICT(launch_request_id) DO NOTHING`,
    )
    .run(
      input.id,
      input.profileId,
      input.profileRevision,
      input.taskId,
      input.launchRequestId,
      canonicalResidentJson(input.launchInput),
      input.repoSpelling,
      canonicalResidentJson(input.persona),
      input.runInstructions,
      input.at,
    );
  return { reserved: info.changes > 0 };
}

/** Pending -> launched, once. False when the run already settled. */
export function markResidentRunLaunched(id: string, endedAt: number | null): boolean {
  const info = openDb()
    .prepare(
      `UPDATE resident_runs SET launch_state = 'launched', launch_error = NULL, ended_at = ?
        WHERE id = ? AND launch_state = 'pending'`,
    )
    .run(endedAt, id);
  return info.changes > 0;
}

/** Pending -> failed with its reason, stamping the end in the same write. */
export function markResidentRunFailed(id: string, error: string, at: number): boolean {
  const info = openDb()
    .prepare(
      `UPDATE resident_runs SET launch_state = 'failed', launch_error = ?, ended_at = ?
        WHERE id = ? AND launch_state = 'pending'`,
    )
    .run(error, at, id);
  return info.changes > 0;
}

/** Stamp a launched run's end, once. */
export function endResidentRun(id: string, at: number): boolean {
  const info = openDb()
    .prepare(
      `UPDATE resident_runs SET ended_at = ? WHERE id = ? AND ended_at IS NULL AND launch_state = 'launched'`,
    )
    .run(at, id);
  return info.changes > 0;
}

/**
 * The store's read surface later phases rely on. `ResidentStore.revision` is THE read of a
 * live run's settings: a run reads only the revision it pinned, never the profile's current
 * one, which is for new launches and for flagging "profile changed since launch".
 */
export const ResidentStore = {
  revision: residentProfileRevision,
  profile: getResidentProfile,
  run: getResidentRun,
  runForTask: residentRunForTask,
} as const;
