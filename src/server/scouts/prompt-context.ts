import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readPersistedEnum } from "@shared/schedules.ts";
import { openDb } from "../db.ts";
import { clipUtf8Bytes, utf8Bytes } from "../util/utf8.ts";

/**
 * Durable prompt context for one scout work episode.
 *
 * Mechanism only - no Registry, no emit, no policy about which deliveries count. The
 * seams decide that and call in here; this module owns two tables and the bounds on
 * them. It runs on the connection `openDb()` already owns and opens no second handle,
 * because the daemon is the only writer of this database and one file with two handles is
 * how that stops being true.
 *
 * It exists because two facts a scout archive needs are not durable anywhere else:
 *
 *   1. WHERE the conversation started. A capture that read a final transcript window
 *      would get `TranscriptMessages.window`'s head-and-tail view, which elides the middle
 *      of a long session by design - so the follow-ups an operator sent in the middle of a
 *      long scout would silently not be archived.
 *   2. WHO typed each user-role turn. `src/server/injections.ts` remembers that in memory,
 *      so a daemon restarted between a Foreman instruction and the capture that reads the
 *      transcript would archive that instruction as if a human wrote it.
 *
 * Both are local capture coordination with the same lifetime as `archive_capture_jobs`,
 * and on the same `(task, episode)` key. Once Phase 2 freezes a trail onto a capture job
 * the job is the durable answer and these rows may be cleaned; nothing here is a read
 * model and nothing renders it.
 */

/**
 * Who delivered a user-role turn.
 *
 * Append-only: these strings are written into `scout_prompt_turns.origin` on operators'
 * machines and read back by exact value. `human` leads because it is the only one whose
 * text is archived; the other three are `TurnOrigin` from the live attribution map, and
 * they are recorded so that a restart cannot turn one of them into a human prompt.
 */
export const SCOUT_PROMPT_ORIGINS = ["human", "foreman", "workflow", "harness"] as const;
export type ScoutPromptOrigin = (typeof SCOUT_PROMPT_ORIGINS)[number];

/**
 * What this daemon will hold for one scout episode, shared with the collector that reads it.
 *
 * These are WRITE-time bounds on local SQLite, deliberately stated here rather than derived
 * from the portable archive bounds: a manifest limit is a promise about a file that leaves
 * the machine, and this is a promise that a pathological session cannot grow the database
 * without limit. They line up with the portable entry bounds so that nothing is stored that
 * could never be published, and the collector reads them from here so the two cannot drift.
 *
 * `entries` and `rows` are separate because the two row kinds cost different things. A human
 * row carries its exact text and is the expensive one, so it is capped at what a manifest
 * can carry anyway. A non-human row is an origin and a hash, and its cap is far looser -
 * dropping one does not lose an archived prompt, it loses the proof that a turn in the
 * transcript was NOT a human's, which is the more damaging thing to run out of.
 */
export const SCOUT_PROMPT_LIMITS = {
  /** Human turns retained per episode. Matches the portable per-manifest entry bound. */
  entries: 256,
  /** UTF-8 bytes of one retained human turn. Matches the portable per-entry bound. */
  entryBytes: 256 * 1024,
  /** Rows of any origin retained per episode - the hard ceiling on one episode's state. */
  rows: 2_048,
} as const;

/** One scout episode's frozen boundary. */
export interface ScoutPromptContext {
  taskId: string;
  episodeId: string;
  sessionId: string | null;
  /** `session.name` as the card showed it when the task prompt was delivered. */
  sessionName: string;
  transcriptPath: string | null;
  /** Byte offset the task prompt was delivered at; 0 when it travelled in the launch. */
  transcriptOffset: number | null;
  /** Whether any bound above was reached, so a collector can say the trail is partial. */
  truncated: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One delivered user-role turn. `text` is present only for a human row. */
export interface ScoutPromptTurn {
  id: string;
  taskId: string;
  episodeId: string;
  seq: number;
  /** Null when this build cannot read the stored value - excluded rather than assumed human. */
  origin: ScoutPromptOrigin | null;
  text: string | null;
  fingerprint: string;
  deliveredAt: number;
}

export interface ScoutPromptContextWrite {
  taskId: string;
  episodeId: string;
  sessionId: string | null;
  sessionName: string;
  transcriptPath: string | null;
  transcriptOffset: number | null;
}

export interface ScoutPromptTurnWrite {
  id: string;
  taskId: string;
  episodeId: string;
  origin: ScoutPromptOrigin;
  text: string;
}

interface ContextRow {
  task_id: string;
  episode_id: string;
  session_id: string | null;
  session_name: string;
  transcript_path: string | null;
  transcript_offset: number | null;
  truncated: number;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: string;
  task_id: string;
  episode_id: string;
  seq: number;
  origin: string;
  text: string | null;
  fingerprint: string;
  delivered_at: number;
}

function mapContext(r: ContextRow): ScoutPromptContext {
  return {
    taskId: r.task_id,
    episodeId: r.episode_id,
    sessionId: r.session_id,
    sessionName: r.session_name,
    transcriptPath: r.transcript_path,
    transcriptOffset: r.transcript_offset,
    truncated: r.truncated === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapTurn(r: TurnRow): ScoutPromptTurn {
  return {
    id: r.id,
    taskId: r.task_id,
    episodeId: r.episode_id,
    seq: r.seq,
    origin: readPersistedEnum(SCOUT_PROMPT_ORIGINS, r.origin),
    text: r.text,
    fingerprint: r.fingerprint,
    deliveredAt: r.delivered_at,
  };
}

/**
 * The same normalization `src/server/injections.ts` fingerprints with.
 *
 * Deliberately identical, and it has to stay identical: the collector matches a durable
 * row against a transcript turn the live attribution map may also know about, and two
 * hashes of the same delivery that disagreed would make one of them useless. A turn's
 * recorded text has been through `conversationText` and a trim by the time it is read
 * back, which is what the trim is for.
 */
export function scoutPromptFingerprint(text: string): string {
  return createHash("sha1").update(text.trim()).digest("base64");
}

function inTransaction<T>(d: DatabaseSync, fn: () => T): T {
  const owns = !d.isTransaction;
  if (owns) d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    if (owns) d.exec("COMMIT");
    return out;
  } catch (err) {
    if (owns && d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Freeze one episode's boundary, or refresh the locators of one already frozen.
 *
 * Upsert rather than insert because a task can reach delivery twice on the same episode -
 * a dispatch that failed after provisioning and was retried - and the second delivery is
 * the one the agent actually saw. `created_at` and `truncated` survive that, because
 * neither is a property of the delivery.
 */
export function openScoutPromptContext(
  write: ScoutPromptContextWrite,
  now = Date.now(),
): ScoutPromptContext | null {
  const name = write.sessionName.trim();
  // A context with no name could only ever hand capture an empty title, which would fall
  // through to the long task title this whole feature exists to stop showing. Refuse to
  // record a boundary we cannot title rather than record a misleading one.
  if (!name || !write.taskId || !write.episodeId) return null;
  const d = openDb();
  d.prepare(
    `INSERT INTO scout_prompt_contexts
       (task_id, episode_id, session_id, session_name, transcript_path, transcript_offset,
        truncated, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(task_id, episode_id) DO UPDATE SET
       session_id = excluded.session_id,
       session_name = excluded.session_name,
       transcript_path = excluded.transcript_path,
       transcript_offset = excluded.transcript_offset,
       updated_at = excluded.updated_at`,
  ).run(
    write.taskId,
    write.episodeId,
    write.sessionId,
    name,
    write.transcriptPath,
    write.transcriptOffset,
    now,
    now,
  );
  return scoutPromptContext(write.taskId, write.episodeId);
}

/**
 * Re-freeze the stored name for every episode a session owns.
 *
 * Keyed on the session rather than the task because that is what the rename path holds,
 * and because the point is agreement with the card: a normal capture reads the live
 * `session.name`, and an exit-recovery capture reads this. If they disagreed, the same
 * scout would archive under two different titles depending on how it ended.
 */
export function refreshScoutPromptContextName(
  sessionId: string,
  sessionName: string,
  now = Date.now(),
): number {
  const name = sessionName.trim();
  if (!name) return 0;
  return openDb()
    .prepare(`UPDATE scout_prompt_contexts SET session_name = ?, updated_at = ? WHERE session_id = ?`)
    .run(name, now, sessionId).changes as number;
}

export function scoutPromptContext(taskId: string, episodeId: string): ScoutPromptContext | null {
  const row = openDb()
    .prepare(`SELECT * FROM scout_prompt_contexts WHERE task_id = ? AND episode_id = ?`)
    .get(taskId, episodeId) as unknown as ContextRow | undefined;
  return row ? mapContext(row) : null;
}

/**
 * One episode's delivered turns, oldest first.
 *
 * Bounded by construction rather than by this read: the write path is what caps an
 * episode, so there is no limit argument to get wrong at a call site.
 */
export function scoutPromptTurns(taskId: string, episodeId: string): ScoutPromptTurn[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM scout_prompt_turns WHERE task_id = ? AND episode_id = ? ORDER BY seq ASC`,
    )
    .all(taskId, episodeId) as unknown as TurnRow[];
  return rows.map(mapTurn);
}

/**
 * Record one delivery that positively reached the runtime.
 *
 * Idempotent on `id`, which is the whole reason the caller supplies one: a pending turn
 * that went out, could not be confirmed, and was retried by an operator carries the same
 * `PendingTurn.id` both times and is one prompt, not two.
 *
 * Returns the stored row, or null when there is no context for this episode. That null is
 * the ordinary case rather than an error - it is every delivery into a session that is not
 * running a scout, and refusing it here is what keeps the tables scout-scoped without any
 * caller having to ask.
 */
export function appendScoutPromptTurn(
  write: ScoutPromptTurnWrite,
  now = Date.now(),
): ScoutPromptTurn | null {
  const text = write.text.trim();
  if (!text) return null;
  const d = openDb();
  return inTransaction(d, () => {
    const context = d
      .prepare(`SELECT task_id FROM scout_prompt_contexts WHERE task_id = ? AND episode_id = ?`)
      .get(write.taskId, write.episodeId) as unknown as { task_id?: string } | undefined;
    if (!context?.task_id) return null;

    const existing = d
      .prepare(`SELECT * FROM scout_prompt_turns WHERE id = ?`)
      .get(write.id) as unknown as TurnRow | undefined;
    if (existing) return mapTurn(existing);

    // Only a human row keeps its text. A non-human row exists to EXCLUDE a transcript turn,
    // and the fingerprint is all that takes - so an automated instruction's payload is never
    // written to disk at all, rather than written and filtered later.
    const human = write.origin === "human";
    let truncated = false;
    let stored: string | null = null;
    if (human) {
      stored = clipUtf8Bytes(text, SCOUT_PROMPT_LIMITS.entryBytes);
      truncated = utf8Bytes(text) > SCOUT_PROMPT_LIMITS.entryBytes;
    }

    // Evict rather than refuse, and evict the OLDEST. A refused write loses the turn that
    // just happened, which for a non-human row means that turn reads as a human's ever
    // after - the one mistake this table exists to prevent. Dropping the oldest human text
    // loses history the manifest bounds would have dropped anyway, since a truncated trail
    // keeps the newest follow-ups.
    if (human) {
      truncated = evictOldest(d, write.taskId, write.episodeId, "human", SCOUT_PROMPT_LIMITS.entries) || truncated;
    }
    truncated = evictOldest(d, write.taskId, write.episodeId, null, SCOUT_PROMPT_LIMITS.rows) || truncated;

    const next = d
      .prepare(
        `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM scout_prompt_turns
          WHERE task_id = ? AND episode_id = ?`,
      )
      .get(write.taskId, write.episodeId) as unknown as { seq: number };
    d.prepare(
      `INSERT INTO scout_prompt_turns
         (id, task_id, episode_id, seq, origin, text, fingerprint, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      write.id,
      write.taskId,
      write.episodeId,
      next.seq,
      write.origin,
      stored,
      scoutPromptFingerprint(text),
      now,
    );
    if (truncated) markScoutPromptContextTruncated(d, write.taskId, write.episodeId, now);
    const row = d.prepare(`SELECT * FROM scout_prompt_turns WHERE id = ?`).get(write.id) as
      | unknown as TurnRow
      | undefined;
    return row ? mapTurn(row) : null;
  });
}

/**
 * Drop the oldest rows until one more fits under `limit`, reporting whether any went.
 *
 * `origin` null means "rows of every origin", which is the hard per-episode ceiling; a
 * named origin is the per-kind cap.
 */
function evictOldest(
  d: DatabaseSync,
  taskId: string,
  episodeId: string,
  origin: ScoutPromptOrigin | null,
  limit: number,
): boolean {
  const where = origin ? `AND origin = ?` : ``;
  const params = origin ? [taskId, episodeId, origin] : [taskId, episodeId];
  const count = d
    .prepare(
      `SELECT COUNT(*) AS n FROM scout_prompt_turns WHERE task_id = ? AND episode_id = ? ${where}`,
    )
    .get(...params) as unknown as { n: number };
  if (count.n < limit) return false;
  d.prepare(
    `DELETE FROM scout_prompt_turns WHERE id IN (
       SELECT id FROM scout_prompt_turns
        WHERE task_id = ? AND episode_id = ? ${where}
        ORDER BY seq ASC LIMIT ?
     )`,
  ).run(...params, count.n - limit + 1);
  return true;
}

function markScoutPromptContextTruncated(
  d: DatabaseSync,
  taskId: string,
  episodeId: string,
  now: number,
): void {
  d.prepare(
    `UPDATE scout_prompt_contexts SET truncated = 1, updated_at = ?
      WHERE task_id = ? AND episode_id = ?`,
  ).run(now, taskId, episodeId);
}

/**
 * Forget one episode's context and trail.
 *
 * The explicit cleanup the capture manager calls once a job has frozen the trail, and the
 * only way these rows go. There is deliberately no timer and no age sweep: the rows have
 * to survive a daemon restart and a session eviction, and "old" is exactly what a scout
 * waiting on a slow reviewer looks like.
 */
export function clearScoutPromptContext(taskId: string, episodeId: string): void {
  const d = openDb();
  inTransaction(d, () => {
    d.prepare(`DELETE FROM scout_prompt_turns WHERE task_id = ? AND episode_id = ?`).run(
      taskId,
      episodeId,
    );
    d.prepare(`DELETE FROM scout_prompt_contexts WHERE task_id = ? AND episode_id = ?`).run(
      taskId,
      episodeId,
    );
  });
}

/** Every context a task owns, newest first - a task may be re-dispatched onto a new episode. */
export function scoutPromptContextsForTask(taskId: string): ScoutPromptContext[] {
  const rows = openDb()
    .prepare(`SELECT * FROM scout_prompt_contexts WHERE task_id = ? ORDER BY created_at DESC`)
    .all(taskId) as unknown as ContextRow[];
  return rows.map(mapContext);
}

/** A generated delivery id, for a seam with no stable id of its own. */
export function scoutPromptTurnId(): string {
  return randomUUID();
}

/** Drop every row. For tests that need a clean journal between cases. */
export function clearScoutPromptContexts(db: DatabaseSync): void {
  db.exec("DELETE FROM scout_prompt_turns; DELETE FROM scout_prompt_contexts;");
}
