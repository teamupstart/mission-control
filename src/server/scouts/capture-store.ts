import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  SCOUT_SUBMISSION_LIMITS,
  SCOUT_TEXT_LIMITS,
  type ScoutCaptureStatus,
  type ScoutSubmissionInput,
  type ScoutSupportingLocator,
} from "@shared/scouts.ts";
import { openDb } from "../db.ts";
import type { ScoutRepoSlot } from "./repos.ts";

/**
 * The local capture-job ledger: which scouts this daemon is archiving, and how far each got.
 *
 * The counterpart to `store.ts`, and the opposite kind of table. That one is a projection of
 * the library and can be deleted whole; this one is bookkeeping about work in flight, and
 * deleting it loses the ability to RESUME a capture - never the ability to read a published
 * archive, which is the line the whole design rests on. Nothing a reader of a finished bundle
 * needs is in here.
 *
 * Its one hard job is idempotency. A capture is identified by an operation key that is stable
 * for one task work episode, so an MCP retry, a lost HTTP response, a duplicate completion
 * click, and a daemon restart all converge on the SAME row and therefore on the same archive
 * identity - rather than publishing the same evidence twice under two keys, which nothing
 * downstream could ever de-duplicate because the two bundles would be genuinely different
 * archives.
 */

/**
 * How far one capture got. APPEND-ONLY, and read defensively: a status this build does not
 * recognise is treated as unfinished, because the alternative - reading an unknown value as
 * "done" - would let a newer build's row convince this one that an archive exists.
 */
export const SCOUT_CAPTURE_JOB_STATUSES = ["reserved", "submitted", "published", "failed"] as const;
export type ScoutCaptureJobStatus = (typeof SCOUT_CAPTURE_JOB_STATUSES)[number];

/** The identity and source locators one capture works from. All server-derived. */
export interface ScoutCaptureJob {
  operationKey: string;
  taskId: string;
  sessionId: string | null;
  episodeId: string | null;
  status: ScoutCaptureJobStatus;
  producerId: string;
  archiveId: string;
  /** What the scout submitted, or null when nothing has been submitted yet. */
  submission: ScoutSubmissionInput | null;
  title: string;
  question: string | null;
  origin: ScoutCaptureOrigin;
  repos: ScoutRepoSlot[];
  relativePath: string | null;
  captureStatus: ScoutCaptureStatus | null;
  error: string | null;
  attempts: number;
  lastAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Where the scout ran, frozen when the job was reserved. */
export interface ScoutCaptureOrigin {
  agent: string | null;
  model: string | null;
  source: string | null;
}

/** Everything the daemon knows about a scout at the moment it reserves its capture. */
export interface ScoutCaptureReservation {
  taskId: string;
  sessionId: string | null;
  episodeId: string | null;
  /**
   * This machine's producer namespace, frozen onto the job.
   *
   * Recorded rather than re-read at publication time because the identity file can be lost
   * between the two - losing it opens a NEW namespace, and a capture that reserved under the
   * old one must still publish where it reserved. Existing bundles are unaffected either way;
   * this is only about a job that is already in flight.
   */
  producerId: string;
  title: string;
  question: string | null;
  origin: ScoutCaptureOrigin;
  repos: ScoutRepoSlot[];
}

/**
 * The operation key for one task work episode.
 *
 * Task plus episode rather than task alone, because a task can be re-dispatched or reassigned
 * after a failure: that is genuinely new work by a new agent in a new checkout, and it must be
 * allowed to produce its own archive rather than replaying the first attempt's. A task with no
 * episode (an assignment whose binding has not landed, a job reserved from an exit that raced
 * the binding) falls back to a single per-task key, which is the conservative direction - it
 * de-duplicates rather than multiplying archives.
 */
export function scoutOperationKey(taskId: string, episodeId: string | null): string {
  return `${taskId}:${episodeId ?? "-"}`;
}

interface JobRowShape {
  operation_key: string;
  task_id: string;
  session_id: string | null;
  episode_id: string | null;
  status: string;
  producer_id: string | null;
  archive_id: string | null;
  report_path: string | null;
  summary: string | null;
  tags_json: string | null;
  supporting_json: string | null;
  title: string | null;
  question: string | null;
  origin_json: string | null;
  repos_json: string | null;
  relative_path: string | null;
  capture_status: string | null;
  error: string | null;
  attempts: number;
  last_attempt_at: number | null;
  created_at: number;
  updated_at: number;
}

export class ScoutCaptureStore {
  constructor(
    private readonly db: DatabaseSync = openDb(),
    private readonly now: () => number = Date.now,
  ) {}

  private inTransaction<T>(fn: () => T): T {
    const owns = !this.db.isTransaction;
    if (owns) this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      if (owns) this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if (owns && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Find or create the job for one task episode, generating its archive identity once.
   *
   * Compare-and-set inside one transaction, which is what makes two concurrent submissions -
   * a completion click racing the agent's own MCP call - agree on one archive id rather than
   * generating two and publishing whichever renamed last. An existing row is returned
   * UNCHANGED except for the locators, which are refreshed while they are still derivable: a
   * job reserved from an exit knows the checkout, and a later submission in the same episode
   * must not lose it.
   */
  reserve(input: ScoutCaptureReservation): ScoutCaptureJob {
    const key = scoutOperationKey(input.taskId, input.episodeId);
    return this.inTransaction(() => {
      const existing = this.get(key);
      if (existing) {
        // Never after publication: a published bundle is immutable, and refreshing the
        // locators of a job whose archive already exists could only serve a second capture.
        if (existing.status === "published") return existing;
        const at = this.now();
        this.db
          .prepare(
            `UPDATE scout_capture_jobs
                SET session_id = ?, title = ?, question = ?, origin_json = ?, repos_json = ?, updated_at = ?
              WHERE operation_key = ?`,
          )
          .run(
            input.sessionId ?? existing.sessionId,
            clip(input.title, SCOUT_TEXT_LIMITS.title) ?? existing.title,
            clip(input.question, SCOUT_TEXT_LIMITS.question),
            JSON.stringify(input.origin),
            JSON.stringify(input.repos),
            at,
            key,
          );
        return this.get(key)!;
      }
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO scout_capture_jobs
             (operation_key, task_id, session_id, episode_id, status, producer_id, archive_id,
              title, question, origin_json, repos_json, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          key,
          input.taskId,
          input.sessionId,
          input.episodeId,
          input.producerId,
          randomUUID(),
          clip(input.title, SCOUT_TEXT_LIMITS.title) ?? "Scout",
          clip(input.question, SCOUT_TEXT_LIMITS.question),
          JSON.stringify(input.origin),
          JSON.stringify(input.repos),
          at,
          at,
        );
      return this.get(key)!;
    });
  }

  /**
   * Record an accepted submission against a job that has not published yet.
   *
   * Refused after publication rather than ignored: a scout resubmitting a corrected report
   * over a bundle that already exists is asking for something the format does not allow -
   * archives are immutable - and answering "recorded" would be a lie the operator only
   * discovers when the old report is still there. Before publication a resubmission simply
   * supersedes, which is exactly what a scout fixing an invalid report needs.
   */
  recordSubmission(operationKey: string, submission: ScoutSubmissionInput): ScoutCaptureJob | null {
    return this.inTransaction(() => {
      const job = this.get(operationKey);
      if (!job || job.status === "published") return null;
      this.db
        .prepare(
          `UPDATE scout_capture_jobs
              SET status = 'submitted', report_path = ?, summary = ?, tags_json = ?,
                  supporting_json = ?, error = NULL, updated_at = ?
            WHERE operation_key = ?`,
        )
        .run(
          submission.reportPath,
          clip(submission.summary, SCOUT_SUBMISSION_LIMITS.summary),
          JSON.stringify(submission.tags),
          JSON.stringify(submission.supporting),
          this.now(),
          operationKey,
        );
      return this.get(operationKey);
    });
  }

  /** Count one capture attempt, so a job that keeps failing is visible rather than silent. */
  noteAttempt(operationKey: string): void {
    this.db
      .prepare(
        `UPDATE scout_capture_jobs SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
          WHERE operation_key = ?`,
      )
      .run(this.now(), this.now(), operationKey);
  }

  /** The durable record that a final bundle exists. Written only after the rename verified. */
  markPublished(
    operationKey: string,
    relativePath: string,
    captureStatus: ScoutCaptureStatus,
  ): ScoutCaptureJob | null {
    this.db
      .prepare(
        `UPDATE scout_capture_jobs
            SET status = 'published', relative_path = ?, capture_status = ?, error = NULL, updated_at = ?
          WHERE operation_key = ?`,
      )
      .run(relativePath, captureStatus, this.now(), operationKey);
    return this.get(operationKey);
  }

  /** A capture that could not finish. Retryable: the sources and the identity both survive. */
  markFailed(operationKey: string, error: string): void {
    this.db
      .prepare(
        `UPDATE scout_capture_jobs SET status = 'failed', error = ?, updated_at = ?
          WHERE operation_key = ? AND status != 'published'`,
      )
      .run(clip(error, SCOUT_TEXT_LIMITS.error), this.now(), operationKey);
  }

  get(operationKey: string): ScoutCaptureJob | null {
    const row = this.db
      .prepare(`SELECT * FROM scout_capture_jobs WHERE operation_key = ?`)
      .get(operationKey) as unknown as JobRowShape | undefined;
    return row ? rowToJob(row) : null;
  }

  /**
   * Every job for one task, newest first.
   *
   * Plural because a re-dispatched task has one job per episode, and the caller usually wants
   * the CURRENT episode's - but "is any archive published for this task" is also a real
   * question (cleanup asks it), and answering it from one row would miss an earlier episode's
   * evidence.
   */
  forTask(taskId: string): ScoutCaptureJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM scout_capture_jobs WHERE task_id = ? ORDER BY created_at DESC`)
      .all(taskId) as unknown as JobRowShape[];
    return rows.map(rowToJob);
  }

  /** Jobs that still have work to do, oldest first - the restart-recovery worklist. */
  unfinished(): ScoutCaptureJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM scout_capture_jobs WHERE status != 'published' ORDER BY created_at`)
      .all() as unknown as JobRowShape[];
    return rows.map(rowToJob);
  }
}

function rowToJob(row: JobRowShape): ScoutCaptureJob {
  const origin = parseJson<ScoutCaptureOrigin>(row.origin_json) ?? {
    agent: null,
    model: null,
    source: null,
  };
  return {
    operationKey: row.operation_key,
    taskId: row.task_id,
    sessionId: row.session_id,
    episodeId: row.episode_id,
    status: readStatus(row.status),
    // Written at reservation and never rewritten. The empty-string fallbacks cannot occur for
    // a row this build wrote; they exist so a hand-edited database degrades to "unfinished"
    // rather than throwing on the recovery path.
    producerId: row.producer_id ?? "",
    archiveId: row.archive_id ?? "",
    submission: row.report_path
      ? {
          reportPath: row.report_path,
          summary: row.summary ?? "",
          tags: parseJson<string[]>(row.tags_json) ?? [],
          supporting: parseJson<ScoutSupportingLocator[]>(row.supporting_json) ?? [],
        }
      : null,
    title: row.title ?? "Scout",
    question: row.question,
    origin,
    repos: parseJson<ScoutRepoSlot[]>(row.repos_json) ?? [],
    relativePath: row.relative_path,
    captureStatus:
      row.capture_status === "complete" || row.capture_status === "partial" ? row.capture_status : null,
    error: row.error,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readStatus(raw: string): ScoutCaptureJobStatus {
  return (SCOUT_CAPTURE_JOB_STATUSES as readonly string[]).includes(raw)
    ? (raw as ScoutCaptureJobStatus)
    : "reserved";
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** Drop every capture job. For tests that need a clean ledger between cases. */
export function clearScoutCaptureJobs(db: DatabaseSync): void {
  db.exec("DELETE FROM scout_capture_jobs;");
}
