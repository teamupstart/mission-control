import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.ts";
import { AGENT_TYPES, THINKING_LEVELS } from "@shared/types.ts";
import { TASK_PRIORITIES, normalizeLabels } from "@shared/task.ts";
import {
  SCHEDULE_DECISION_KINDS,
  SCHEDULE_EXECUTION_MODES,
  SCHEDULE_MISSED_POLICIES,
  SCHEDULE_OCCURRENCE_STATUSES,
  SCHEDULE_OVERLAP_BLOCKING_TASK_STATUSES,
  SCHEDULE_OVERLAP_POLICIES,
  SCHEDULE_STALE_CLAIM_MS,
  SCHEDULE_TERMINAL_STATUSES,
  SCHEDULE_TRIGGER_KINDS,
  clampHistoryLimit,
  deriveScheduleHealth,
  readPersistedEnum,
} from "@shared/schedules.ts";
import type {
  MissionSchedule,
  ScheduleDecisionKind,
  ScheduleDefinition,
  ScheduleHistoryCursor,
  ScheduleHistoryPage,
  ScheduleOccurrence,
  ScheduleOccurrenceStatus,
  ScheduleOccurrenceSummary,
  ScheduleRevision,
  ScheduleTemplate,
  ScheduleTriggerKind,
  ScheduleUnreadable,
} from "@shared/schedules.ts";

/**
 * Durable storage for Recurring Missions.
 *
 * Every function here runs on the connection `openDb()` already owns - the daemon has one
 * SQLite handle and this opens no second one, because two handles on one file is how the
 * exactly-once claim below stops being exactly once.
 *
 * Deliberately mechanism only. Nothing here decides policy, computes a cadence, or emits
 * a Registry event: an SSE emission cannot be rolled back, so a transaction that can
 * still fail must never be the thing that announced itself. Phase 2 owns the decisions
 * and notifies after these calls return.
 */

// ---- rows ----

interface ScheduleRow {
  id: string;
  name: string;
  enabled: number;
  archived_at: number | null;
  expression: string;
  timezone: string;
  overlap_policy: string;
  missed_policy: string;
  execution_mode: string;
  runner_id: string | null;
  revision: number;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A schedule joined to its active revision - the template lives on the revision row. */
interface ScheduleJoinRow extends ScheduleRow {
  template_json: string;
}

interface RevisionRow {
  schedule_id: string;
  revision: number;
  template_json: string;
  expression: string;
  timezone: string;
  overlap_policy: string;
  missed_policy: string;
  execution_mode: string;
  runner_id: string | null;
  created_at: number;
}

interface OccurrenceRow {
  id: string;
  schedule_id: string;
  schedule_revision: number;
  scheduled_for: number;
  trigger_kind: string;
  decision_kind: string;
  claimed_at: number;
  finished_at: number | null;
  status: string;
  task_id: string | null;
  covered_by_id: string | null;
  blocking_task_id: string | null;
  delay_ms: number;
  error: string | null;
  created_at: number;
}

// ---- defensive reads ----

/**
 * Read a persisted template blob back into a `ScheduleTemplate`, or null.
 *
 * Defensive to the point of paranoia on purpose: this is JSON in a TEXT column, so it can
 * hold anything an older build, a newer build, or a half-finished write left there. One
 * unparseable row must cost that ONE schedule its runnability - it loads, shows as
 * attention, and can be edited - rather than throwing out of the list query and taking
 * every other schedule off the catalog with it.
 */
function parseTemplate(raw: string): ScheduleTemplate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const t = parsed as Record<string, unknown>;
  if (typeof t.title !== "string" || t.title === "") return null;
  if (typeof t.intent !== "string") return null;
  if (typeof t.repoRoot !== "string" || t.repoRoot === "") return null;
  const kind = t.kind === "ship" || t.kind === "scout" ? t.kind : null;
  if (kind === null) return null;
  const agent = readPersistedEnum(AGENT_TYPES, typeof t.agent === "string" ? t.agent : null);
  if (agent === null) return null;
  // ABSENT and UNREADABLE are different answers, and collapsing them is a real data loss.
  // Null is a legitimate stored value for both of these - "nobody set a priority" - so a
  // template that has one at all can only have got it from a build that knew a value this
  // one does not. Mapping that to null would silently downgrade a schedule written as
  // `blocker` (or some priority added later) into untriaged work, on every run, for ever.
  // Absent stays null; present-but-unknown fails the template closed, exactly as an
  // unknown execution mode does.
  const priority = readOptionalEnum(TASK_PRIORITIES, t.priority);
  if (priority === UNREADABLE) return null;
  const effort = readOptionalEnum(THINKING_LEVELS, t.effort);
  if (effort === UNREADABLE) return null;

  return {
    title: t.title,
    intent: t.intent,
    repoRoot: t.repoRoot,
    kind,
    agent,
    priority,
    effort,
    // These two carry no enum: any string is a legitimate model id or label, so there is
    // no such thing as a value from the future to fail on.
    labels: Array.isArray(t.labels)
      ? normalizeLabels(t.labels.filter((v): v is string => typeof v === "string"))
      : [],
    model: typeof t.model === "string" ? t.model : null,
  };
}

/** Distinguishes "the template did not set this" from "it set something we can't read". */
const UNREADABLE = Symbol("unreadable");

function readOptionalEnum<T extends string>(
  values: readonly T[],
  raw: unknown,
): T | null | typeof UNREADABLE {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "string" ? readPersistedEnum(values, raw) : null;
  return value ?? UNREADABLE;
}

/**
 * Read the four values that a newer build could have written and this one may not know.
 *
 * The `unreadable` it returns is what fails a row CLOSED: `scheduleIsRunnable` refuses it,
 * so nothing downstream can reach a policy field without having handled the null. This is
 * the "must not silently coerce it to local execution" rule made structural - the mapper
 * has no branch that could pick a default, because the type has nowhere to put one.
 */
function readPolicies(row: {
  overlap_policy: string;
  missed_policy: string;
  execution_mode: string;
  template_json: string;
}): {
  overlapPolicy: MissionSchedule["overlapPolicy"];
  missedPolicy: MissionSchedule["missedPolicy"];
  executionMode: MissionSchedule["executionMode"];
  template: ScheduleTemplate | null;
  unreadable: ScheduleUnreadable | null;
} {
  const overlapPolicy = readPersistedEnum(SCHEDULE_OVERLAP_POLICIES, row.overlap_policy);
  const missedPolicy = readPersistedEnum(SCHEDULE_MISSED_POLICIES, row.missed_policy);
  const executionMode = readPersistedEnum(SCHEDULE_EXECUTION_MODES, row.execution_mode);
  const template = parseTemplate(row.template_json);

  const bad: Array<[string, string]> = [];
  if (overlapPolicy === null) bad.push(["overlap_policy", row.overlap_policy]);
  if (missedPolicy === null) bad.push(["missed_policy", row.missed_policy]);
  if (executionMode === null) bad.push(["execution_mode", row.execution_mode]);
  if (template === null) bad.push(["template", "unreadable"]);

  const unreadable: ScheduleUnreadable | null =
    bad.length === 0
      ? null
      : {
          reason:
            "This schedule was written by a newer build of Mission Control: " +
            bad.map(([field, value]) => `${field} is "${value}"`).join(", ") +
            ". It will not run until it is edited here.",
          fields: bad.map(([field]) => field),
        };
  return { overlapPolicy, missedPolicy, executionMode, template, unreadable };
}

function rowToOccurrence(r: OccurrenceRow): ScheduleOccurrence {
  return {
    id: r.id,
    scheduleId: r.schedule_id,
    scheduleRevision: r.schedule_revision,
    scheduledFor: r.scheduled_for,
    triggerKind: readPersistedEnum(SCHEDULE_TRIGGER_KINDS, r.trigger_kind),
    decisionKind: readPersistedEnum(SCHEDULE_DECISION_KINDS, r.decision_kind),
    claimedAt: r.claimed_at,
    finishedAt: r.finished_at,
    status: readPersistedEnum(SCHEDULE_OCCURRENCE_STATUSES, r.status),
    taskId: r.task_id,
    coveredById: r.covered_by_id,
    blockingTaskId: r.blocking_task_id,
    delayMs: r.delay_ms,
    error: r.error,
    createdAt: r.created_at,
  };
}

function occurrenceSummary(o: ScheduleOccurrence): ScheduleOccurrenceSummary {
  return {
    id: o.id,
    scheduledFor: o.scheduledFor,
    claimedAt: o.claimedAt,
    finishedAt: o.finishedAt,
    status: o.status,
    triggerKind: o.triggerKind,
    taskId: o.taskId,
    delayMs: o.delayMs,
    error: o.error,
  };
}

function rowToRevision(r: RevisionRow): ScheduleRevision {
  const policies = readPolicies(r);
  return {
    scheduleId: r.schedule_id,
    revision: r.revision,
    expression: r.expression,
    timezone: r.timezone,
    overlapPolicy: policies.overlapPolicy,
    missedPolicy: policies.missedPolicy,
    executionMode: policies.executionMode,
    runnerId: r.runner_id,
    template: policies.template,
    unreadable: policies.unreadable,
    createdAt: r.created_at,
  };
}

/** Health inputs gathered per schedule, so `listSchedules` never reads them one by one. */
interface HealthContext {
  lastOccurrence: Map<string, ScheduleOccurrenceSummary>;
  oldestClaimAt: Map<string, number>;
}

function rowToSchedule(r: ScheduleJoinRow, ctx: HealthContext, now: number): MissionSchedule {
  const policies = readPolicies(r);
  const lastOccurrence = ctx.lastOccurrence.get(r.id) ?? null;
  const oldestClaimAt = ctx.oldestClaimAt.get(r.id) ?? null;
  const enabled = r.enabled !== 0;
  const archivedAt = r.archived_at;
  const { health, reasons } = deriveScheduleHealth({
    enabled,
    archivedAt,
    nextRunAt: r.next_run_at,
    unreadable: policies.unreadable,
    lastOccurrence,
    oldestClaimAt,
    now,
  });
  return {
    id: r.id,
    name: r.name,
    enabled,
    archivedAt,
    expression: r.expression,
    timezone: r.timezone,
    overlapPolicy: policies.overlapPolicy,
    missedPolicy: policies.missedPolicy,
    executionMode: policies.executionMode,
    runnerId: r.runner_id,
    revision: r.revision,
    template: policies.template,
    nextRunAt: r.next_run_at,
    lastOccurrence,
    unreadable: policies.unreadable,
    health,
    healthReasons: reasons,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---- health context ----

const SCHEDULE_JOIN_SELECT = `
  SELECT s.*, r.template_json AS template_json
    FROM mission_schedules s
    JOIN mission_schedule_revisions r
      ON r.schedule_id = s.id AND r.revision = s.revision`;

/**
 * The newest TERMINAL occurrence per schedule, plus the oldest outstanding reservation.
 *
 * Two set-wide queries rather than two per schedule. It matters more than it looks: this
 * runs on every catalog read and every SSE snapshot, on the same synchronous handle that
 * serves hook ingest, so a per-schedule read here would be a stall the whole daemon feels.
 *
 * Terminal, not merely newest: health asks whether the last thing that FINISHED went
 * well, and a reservation still in flight has not answered that question yet. The stale
 * reservation is a separate signal with its own reason, which is why it is its own map.
 */
function healthContext(d: DatabaseSync, scheduleIds: string[]): HealthContext {
  const lastOccurrence = new Map<string, ScheduleOccurrenceSummary>();
  const oldestClaimAt = new Map<string, number>();
  if (scheduleIds.length === 0) return { lastOccurrence, oldestClaimAt };
  const placeholders = scheduleIds.map(() => "?").join(",");
  // Built from the shared list rather than written out, so a status appended later cannot
  // be terminal in TypeScript and not in this query. The values are a closed enum of
  // identifiers, so quoting them into SQL is safe by construction.
  const terminal = SCHEDULE_TERMINAL_STATUSES.map((s) => `'${s}'`).join(",");

  const latest = d
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY schedule_id ORDER BY scheduled_for DESC
         ) AS rn
           FROM mission_schedule_occurrences
          WHERE schedule_id IN (${placeholders}) AND status IN (${terminal})
       ) WHERE rn = 1`,
    )
    .all(...scheduleIds) as unknown as OccurrenceRow[];
  for (const row of latest) {
    lastOccurrence.set(row.schedule_id, occurrenceSummary(rowToOccurrence(row)));
  }

  const claims = d
    .prepare(
      `SELECT schedule_id, MIN(claimed_at) AS oldest
         FROM mission_schedule_occurrences
        WHERE schedule_id IN (${placeholders}) AND status = 'claimed'
        GROUP BY schedule_id`,
    )
    .all(...scheduleIds) as unknown as Array<{ schedule_id: string; oldest: number }>;
  for (const row of claims) oldestClaimAt.set(row.schedule_id, row.oldest);

  return { lastOccurrence, oldestClaimAt };
}

function hydrate(d: DatabaseSync, rows: ScheduleJoinRow[], now: number): MissionSchedule[] {
  const ctx = healthContext(
    d,
    rows.map((r) => r.id),
  );
  return rows.map((r) => rowToSchedule(r, ctx, now));
}

// ---- reads ----

/** One schedule, archived or not. Null when there is no such row. */
export function getSchedule(id: string, now = Date.now()): MissionSchedule | null {
  const d = openDb();
  const row = d.prepare(`${SCHEDULE_JOIN_SELECT} WHERE s.id = ?`).get(id) as unknown as
    | ScheduleJoinRow
    | undefined;
  if (!row) return null;
  return hydrate(d, [row], now)[0] ?? null;
}

/** The default catalog: everything that has not been archived, newest first. */
export function listSchedules(now = Date.now()): MissionSchedule[] {
  const d = openDb();
  const rows = d
    .prepare(`${SCHEDULE_JOIN_SELECT} WHERE s.archived_at IS NULL ORDER BY s.created_at DESC`)
    .all() as unknown as ScheduleJoinRow[];
  return hydrate(d, rows, now);
}

/**
 * Enabled, unarchived schedules whose cursor has come due.
 *
 * `next_run_at IS NOT NULL` is not redundant with the comparison: a paused or
 * uncomputable schedule stores NULL, and SQL comparisons against NULL are never true, but
 * spelling it out keeps the predicate readable as the sentence it is.
 */
export function dueSchedules(now: number): MissionSchedule[] {
  const d = openDb();
  const rows = d
    .prepare(
      `${SCHEDULE_JOIN_SELECT}
        WHERE s.enabled = 1
          AND s.archived_at IS NULL
          AND s.next_run_at IS NOT NULL
          AND s.next_run_at <= ?
        ORDER BY s.next_run_at ASC`,
    )
    .all(now) as unknown as ScheduleJoinRow[];
  return hydrate(d, rows, now);
}

/** The immutable revision a schedule currently points at. */
export function activeRevision(scheduleId: string): ScheduleRevision | null {
  const row = openDb()
    .prepare(
      `SELECT r.* FROM mission_schedule_revisions r
         JOIN mission_schedules s ON s.id = r.schedule_id AND s.revision = r.revision
        WHERE r.schedule_id = ?`,
    )
    .get(scheduleId) as unknown as RevisionRow | undefined;
  return row ? rowToRevision(row) : null;
}

/** Any revision by number, for finishing a claim taken under a since-superseded one. */
export function revisionAt(scheduleId: string, revision: number): ScheduleRevision | null {
  const row = openDb()
    .prepare(`SELECT * FROM mission_schedule_revisions WHERE schedule_id = ? AND revision = ?`)
    .get(scheduleId, revision) as unknown as RevisionRow | undefined;
  return row ? rowToRevision(row) : null;
}

export function getOccurrence(id: string): ScheduleOccurrence | null {
  const row = openDb()
    .prepare(`SELECT * FROM mission_schedule_occurrences WHERE id = ?`)
    .get(id) as unknown as OccurrenceRow | undefined;
  return row ? rowToOccurrence(row) : null;
}

/** The run that filed a given task, for the deep link off a generated task card. */
export function occurrenceForTask(taskId: string): ScheduleOccurrence | null {
  const row = openDb()
    .prepare(`SELECT * FROM mission_schedule_occurrences WHERE task_id = ?`)
    .get(taskId) as unknown as OccurrenceRow | undefined;
  return row ? rowToOccurrence(row) : null;
}

/**
 * Reservations old enough that the process holding them is gone.
 *
 * The recovery sweep's input, and deliberately not scoped to a schedule: a crash loses
 * every claim that was in flight, across the whole catalog, and a per-schedule sweep
 * would only find them again when that schedule next came due.
 */
export function listStaleClaims(
  now: number,
  staleAfterMs = SCHEDULE_STALE_CLAIM_MS,
): ScheduleOccurrence[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM mission_schedule_occurrences
        WHERE status = 'claimed' AND claimed_at <= ?
        ORDER BY claimed_at ASC
        LIMIT 500`,
    )
    .all(now - staleAfterMs) as unknown as OccurrenceRow[];
  return rows.map(rowToOccurrence);
}

/** Every outstanding reservation regardless of age - the startup sweep's wider net. */
export function listOpenClaims(): ScheduleOccurrence[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM mission_schedule_occurrences
        WHERE status = 'claimed' ORDER BY claimed_at ASC LIMIT 500`,
    )
    .all() as unknown as OccurrenceRow[];
  return rows.map(rowToOccurrence);
}

/**
 * A task this schedule already has in flight, if any - the `skip-active` check.
 *
 * The status list comes from `SCHEDULE_OVERLAP_BLOCKING_TASK_STATUSES` rather than being
 * written out here, so this query and the decision Phase 2 makes from it cannot drift
 * into disagreeing about whether, say, a `dispatching` task counts. The values are a
 * closed enum of identifiers, so quoting them into SQL is safe by construction - the same
 * argument `inFlightIndexSql` makes in db.ts.
 */
export function findActiveTaskForSchedule(scheduleId: string): { id: string; title: string } | null {
  const states = SCHEDULE_OVERLAP_BLOCKING_TASK_STATUSES.map((s) => `'${s}'`).join(",");
  const row = openDb()
    .prepare(
      `SELECT id, title FROM tasks
        WHERE schedule_id = ? AND status IN (${states})
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get(scheduleId) as { id: string; title: string } | undefined;
  return row ?? null;
}

/**
 * One page of run history, newest first, with the schedule it belongs to.
 *
 * Paged on `scheduled_for` rather than an offset because `(schedule_id, scheduled_for)`
 * is UNIQUE: the key is total, so the order is deterministic and a page cannot repeat or
 * skip a row when new occurrences land between requests, which an OFFSET would.
 *
 * The schedule is looked up WITHOUT the archived filter deliberately. History is the one
 * surface that outlives the catalog entry, and a page that could not name its own
 * schedule would be unreadable exactly when somebody is asking what a retired mission did.
 */
export function historyPage(
  scheduleId: string,
  cursor: ScheduleHistoryCursor,
  now = Date.now(),
): ScheduleHistoryPage | null {
  const schedule = getSchedule(scheduleId, now);
  if (!schedule) return null;
  const d = openDb();
  const limit = clampHistoryLimit(cursor.limit);
  const rows = (
    cursor.before === null
      ? d
          .prepare(
            `SELECT * FROM mission_schedule_occurrences
              WHERE schedule_id = ?
              ORDER BY scheduled_for DESC LIMIT ?`,
          )
          .all(scheduleId, limit + 1)
      : d
          .prepare(
            `SELECT * FROM mission_schedule_occurrences
              WHERE schedule_id = ? AND scheduled_for < ?
              ORDER BY scheduled_for DESC LIMIT ?`,
          )
          .all(scheduleId, cursor.before, limit + 1)
  ) as unknown as OccurrenceRow[];
  // One row past the page is fetched and dropped, so "is there more?" is answered by
  // having looked rather than by guessing from a full page.
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map(rowToOccurrence);
  const last = page[page.length - 1];
  return {
    schedule,
    occurrences: page,
    nextCursor: hasMore && last ? last.scheduledFor : null,
  };
}

// ---- writes ----

/** Run `fn` inside a transaction, joining one already in progress rather than nesting. */
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

function insertRevision(
  d: DatabaseSync,
  scheduleId: string,
  revision: number,
  def: ScheduleDefinition,
  at: number,
): void {
  d.prepare(
    `INSERT INTO mission_schedule_revisions (
       schedule_id, revision, template_json, expression, timezone,
       overlap_policy, missed_policy, execution_mode, runner_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scheduleId,
    revision,
    JSON.stringify(def.template),
    def.expression,
    def.timezone,
    def.overlapPolicy,
    def.missedPolicy,
    def.executionMode,
    def.runnerId,
    at,
  );
}

export interface CreateScheduleRow {
  id: string;
  definition: ScheduleDefinition;
  enabled: boolean;
  nextRunAt: number | null;
  at: number;
}

/** Insert a schedule and its revision 1 together, or neither. */
export function createSchedule(input: CreateScheduleRow): MissionSchedule {
  const d = openDb();
  return inTransaction(d, () => {
    const def = input.definition;
    d.prepare(
      `INSERT INTO mission_schedules (
         id, name, enabled, archived_at, expression, timezone,
         overlap_policy, missed_policy, execution_mode, runner_id,
         revision, next_run_at, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      input.id,
      def.name,
      input.enabled ? 1 : 0,
      def.expression,
      def.timezone,
      def.overlapPolicy,
      def.missedPolicy,
      def.executionMode,
      def.runnerId,
      input.nextRunAt,
      input.at,
      input.at,
    );
    insertRevision(d, input.id, 1, def, input.at);
    const created = getSchedule(input.id, input.at);
    if (!created) throw new Error(`schedule ${input.id} vanished during create`);
    return created;
  });
}

/**
 * Apply an edit as revision n+1 and repoint the schedule at it, atomically.
 *
 * The revision is read inside the transaction rather than passed in: a caller that
 * computed `revision + 1` from a row it read earlier would race a concurrent edit into
 * two rows claiming the same number, and the PRIMARY KEY would reject the second - after
 * the schedule row had already been updated, if the two writes were not one unit.
 */
export function updateSchedule(
  id: string,
  definition: ScheduleDefinition,
  nextRunAt: number | null,
  at: number,
): MissionSchedule | null {
  const d = openDb();
  return inTransaction(d, () => {
    const current = d.prepare(`SELECT revision FROM mission_schedules WHERE id = ?`).get(id) as
      | { revision: number }
      | undefined;
    if (!current) return null;
    const revision = current.revision + 1;
    insertRevision(d, id, revision, definition, at);
    d.prepare(
      `UPDATE mission_schedules
          SET name = ?, expression = ?, timezone = ?, overlap_policy = ?, missed_policy = ?,
              execution_mode = ?, runner_id = ?, revision = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      definition.name,
      definition.expression,
      definition.timezone,
      definition.overlapPolicy,
      definition.missedPolicy,
      definition.executionMode,
      definition.runnerId,
      revision,
      nextRunAt,
      at,
      id,
    );
    return getSchedule(id, at);
  });
}

/**
 * Pause or resume, and write the cursor the caller computed for the new state.
 *
 * The cursor is supplied rather than derived here because deriving it needs the
 * recurrence evaluator, and this module deliberately does no date arithmetic. Resuming
 * passes the first instant after the resume time - not the one the schedule was paused
 * on - so a pause accrues no hidden debt to catch up on.
 */
export function setScheduleEnabled(
  id: string,
  enabled: boolean,
  nextRunAt: number | null,
  at: number,
): MissionSchedule | null {
  const d = openDb();
  const info = d
    .prepare(
      `UPDATE mission_schedules SET enabled = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND archived_at IS NULL`,
    )
    .run(enabled ? 1 : 0, nextRunAt, at, id);
  if (info.changes === 0) return null;
  return getSchedule(id, at);
}

/**
 * Archive: stop the clock, leave every row standing.
 *
 * Idempotent, and it never re-stamps `archived_at` - a second Archive click must not
 * rewrite when the mission was retired. It deletes nothing: revisions and occurrences are
 * the only record of what this schedule ever did, and history stays reachable by id.
 */
export function archiveSchedule(id: string, at: number): MissionSchedule | null {
  const d = openDb();
  d.prepare(
    `UPDATE mission_schedules
        SET archived_at = ?, enabled = 0, next_run_at = NULL, updated_at = ?
      WHERE id = ? AND archived_at IS NULL`,
  ).run(at, at, id);
  return getSchedule(id, at);
}

// ---- the claim ----

export interface ScheduleClaimInput {
  /** Preallocated, so a crash between claim and task creation is recoverable. */
  occurrenceId: string;
  scheduleId: string;
  /** The exact revision the decision was taken under. Guarded, see below. */
  scheduleRevision: number;
  scheduledFor: number;
  triggerKind: ScheduleTriggerKind;
  /** Immutable. Recovery finishes THIS decision; it never recomputes one. */
  decisionKind: ScheduleDecisionKind;
  /** Preallocated task id when the decision is `create_task`, else null. */
  taskId: string | null;
  /** The later occurrence representing this instant, for a `coalesced` decision. */
  coveredById: string | null;
  /** The task in the way, for a `skipped_overlap` decision. */
  blockingTaskId: string | null;
  claimedAt: number;
  delayMs: number;
  /**
   * Whether this claim owns the cron cursor.
   *
   * True for a scheduled instant: the claim and the cursor advance are one transaction,
   * which is what makes a crash between them impossible. False for Run now, which mints
   * its own instant and must leave the cadence exactly where it was - expressed as a flag
   * rather than by writing the old value back, because "write what was already there" is
   * indistinguishable from a lost update when you are reading it six months later.
   */
  advanceCursor: boolean;
  /** The cursor to write when `advanceCursor`. Ignored otherwise. */
  nextRunAt: number | null;
}

export type ScheduleClaimResult =
  | { outcome: "claimed"; occurrence: ScheduleOccurrence }
  | { outcome: "already_exists"; occurrence: ScheduleOccurrence }
  | { outcome: "schedule_changed" };

/**
 * Reserve one instant, and advance the cursor with it.
 *
 * This transaction IS the exactly-once guarantee. Everything else about Recurring
 * Missions - catch-up, recovery, Run now - is arranged so that the only way work gets
 * created is by winning here first.
 *
 * Three outcomes, named rather than inferred from affected-row counts, so Phase 2 has one
 * place to read them and cannot get the mapping subtly different in the tick and in
 * recovery:
 *
 *  - `claimed`: this call won. The occurrence exists as `claimed` and, if it owned the
 *    cursor, the cursor moved in the same transaction.
 *  - `already_exists`: the instant was already reserved. The cursor is deliberately NOT
 *    touched, because the claim that won moved it in its own transaction; touching it
 *    here could only move it backwards.
 *  - `schedule_changed`: the schedule was archived or edited between the decision and
 *    this call, so the reservation would be recorded against a revision that is no longer
 *    in force. Nothing is written. Phase 2 re-reads and decides again under the new
 *    revision - which is exactly the plan's "later instants use the new revision".
 */
export function claimOccurrence(input: ScheduleClaimInput): ScheduleClaimResult {
  const d = openDb();
  return inTransaction(d, () => {
    const schedule = d
      .prepare(`SELECT revision, archived_at, enabled FROM mission_schedules WHERE id = ?`)
      .get(input.scheduleId) as
      | { revision: number; archived_at: number | null; enabled: number }
      | undefined;
    // A missing schedule takes the same branch as a changed one: in both cases the row
    // this decision was made about is not the row on disk, and nothing may be written.
    if (!schedule) return { outcome: "schedule_changed" as const };
    if (schedule.archived_at !== null) return { outcome: "schedule_changed" as const };
    if (schedule.revision !== input.scheduleRevision) {
      return { outcome: "schedule_changed" as const };
    }
    // Pause has to be checked HERE, and it is the one guard the revision cannot stand in
    // for: pausing does not mint a new revision, so a tick that read this schedule as due,
    // awaited, and came back after the operator hit Pause would otherwise still win its
    // claim and file work from a schedule the dashboard is showing as stopped.
    //
    // Scoped to scheduled claims, because Run now deliberately WORKS while paused - that
    // is the whole point of a manual trigger - and it mints its own instant rather than
    // acting on the cursor a pause just cleared.
    if (input.triggerKind === "scheduled" && schedule.enabled === 0) {
      return { outcome: "schedule_changed" as const };
    }

    const info = d
      .prepare(
        `INSERT INTO mission_schedule_occurrences (
           id, schedule_id, schedule_revision, scheduled_for, trigger_kind, decision_kind,
           claimed_at, finished_at, status, task_id, covered_by_id, blocking_task_id,
           delay_ms, error, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'claimed', ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(schedule_id, scheduled_for) DO NOTHING`,
      )
      .run(
        input.occurrenceId,
        input.scheduleId,
        input.scheduleRevision,
        input.scheduledFor,
        input.triggerKind,
        input.decisionKind,
        input.claimedAt,
        input.taskId,
        input.coveredById,
        input.blockingTaskId,
        input.delayMs,
        input.claimedAt,
      );

    if (info.changes === 0) {
      const existing = d
        .prepare(
          `SELECT * FROM mission_schedule_occurrences WHERE schedule_id = ? AND scheduled_for = ?`,
        )
        .get(input.scheduleId, input.scheduledFor) as unknown as OccurrenceRow | undefined;
      // The row has to be there - the conflict is what brought us here - but reading it
      // back is what lets the caller name the winner instead of assuming.
      if (!existing) return { outcome: "schedule_changed" as const };
      return { outcome: "already_exists" as const, occurrence: rowToOccurrence(existing) };
    }

    if (input.advanceCursor) {
      d.prepare(`UPDATE mission_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?`).run(
        input.nextRunAt,
        input.claimedAt,
        input.scheduleId,
      );
    }

    const claimed = d
      .prepare(`SELECT * FROM mission_schedule_occurrences WHERE id = ?`)
      .get(input.occurrenceId) as unknown as OccurrenceRow;
    return { outcome: "claimed" as const, occurrence: rowToOccurrence(claimed) };
  });
}

export interface FinishOccurrenceInput {
  id: string;
  status: Exclude<ScheduleOccurrenceStatus, "claimed">;
  finishedAt: number;
  /** Set when the created task's id differs from the preallocated one. Rarely needed. */
  taskId?: string | null;
  coveredById?: string | null;
  error?: string | null;
}

/**
 * Close a reservation with its terminal outcome.
 *
 * Guarded on `status = 'claimed'`, which makes it idempotent in the direction that
 * matters: recovery and the tick can both reach the same occurrence after a restart, and
 * the second one must not overwrite the first one's answer or move `finished_at`. The row
 * is returned either way, so the caller can see which outcome actually stands.
 */
export function finishOccurrence(input: FinishOccurrenceInput): ScheduleOccurrence | null {
  const d = openDb();
  d.prepare(
    `UPDATE mission_schedule_occurrences
        SET status = ?, finished_at = ?,
            task_id = COALESCE(?, task_id),
            covered_by_id = COALESCE(?, covered_by_id),
            error = ?
      WHERE id = ? AND status = 'claimed'`,
  ).run(
    input.status,
    input.finishedAt,
    input.taskId ?? null,
    input.coveredById ?? null,
    input.error ?? null,
    input.id,
  );
  return getOccurrence(input.id);
}
