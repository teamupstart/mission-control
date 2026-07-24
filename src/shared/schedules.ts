import type { AgentType, TaskKind, TaskPriority, TaskStatus, ThinkingLevel } from "./types.ts";

/**
 * Recurring Missions: the durable vocabulary, shared by the daemon and the browser.
 *
 * No `node:` imports reach this file and none may: the dashboard renders every type in
 * here, so a single `node:` import in the module graph takes the web bundle down. Cron
 * and time-zone CALCULATION therefore stays server-side, in
 * `src/server/schedules/recurrence.ts`; what lives here is the shape of the answer and
 * the handful of decisions both sides must make identically.
 *
 * The six arrays below are PERSISTED - every value appears in an operator's
 * SQLite file - so they are append-only, for the reason `TASK_SOURCE_KINDS` is: renaming
 * one does not migrate the rows written under the old spelling, it orphans them.
 */

// ---- persisted enums (append-only) ----

/**
 * How a due instant is expected to reach a task.
 *
 * Only `local-catchup` is offered by V1 mutations; the other two exist in the schema so
 * that adding them later does not rewrite schedule history. A row that already carries
 * one this build cannot run is not coerced - see `MissionSchedule.executionMode`.
 */
export const SCHEDULE_EXECUTION_MODES = ["local-catchup", "os-wake", "remote-runner"] as const;
export type ScheduleExecutionMode = (typeof SCHEDULE_EXECUTION_MODES)[number];

/** What to do when this schedule's previous work is still in flight. */
export const SCHEDULE_OVERLAP_POLICIES = ["skip-active", "allow"] as const;
export type ScheduleOverlapPolicy = (typeof SCHEDULE_OVERLAP_POLICIES)[number];

/** What to do with instants that came due while Mission Control was not running. */
export const SCHEDULE_MISSED_POLICIES = ["coalesce-latest", "create-all", "skip"] as const;
export type ScheduleMissedPolicy = (typeof SCHEDULE_MISSED_POLICIES)[number];

/** Whether the cron cursor produced this occurrence, or an operator pressed Run now. */
export const SCHEDULE_TRIGGER_KINDS = ["scheduled", "manual"] as const;
export type ScheduleTriggerKind = (typeof SCHEDULE_TRIGGER_KINDS)[number];

/**
 * The intent RESERVED with a claim, before any task exists.
 *
 * Immutable, and that is the whole point: a daemon that dies between claiming an
 * occurrence and finishing it must be able to complete the decision that was in force at
 * claim time, not recompute one from a schedule the operator has since edited.
 */
export const SCHEDULE_DECISION_KINDS = [
  "create_task",
  "coalesced",
  "skipped_overlap",
  "skipped_policy",
] as const;
export type ScheduleDecisionKind = (typeof SCHEDULE_DECISION_KINDS)[number];

/**
 * Where an occurrence ended up. `claimed` is the ONLY non-terminal value: it is the
 * reservation itself, and its presence after a restart is what recovery looks for.
 */
export const SCHEDULE_OCCURRENCE_STATUSES = [
  "claimed",
  "created",
  "coalesced",
  "skipped_overlap",
  "skipped_policy",
  "failed",
  "cancelled",
] as const;
export type ScheduleOccurrenceStatus = (typeof SCHEDULE_OCCURRENCE_STATUSES)[number];

/**
 * Every status except the reservation, derived rather than written out again.
 *
 * "Which runs have finished?" is asked in SQL and answered in TypeScript, and a hand-kept
 * second list is where a status appended later gets left out of one of them - silently,
 * because a missing terminal status reads as "this schedule has never run".
 */
export const SCHEDULE_TERMINAL_STATUSES: readonly ScheduleOccurrenceStatus[] =
  SCHEDULE_OCCURRENCE_STATUSES.filter((status) => status !== "claimed");

// ---- derived health (not persisted) ----

/** Catalog health. Derived on the server from durable state, never hand-set. */
export const SCHEDULE_HEALTHS = ["healthy", "paused", "attention"] as const;
export type ScheduleHealth = (typeof SCHEDULE_HEALTHS)[number];

/**
 * Why a schedule wants attention. Derived, so unlike the persisted enums this list is
 * free to change - nothing on disk spells these.
 */
export const SCHEDULE_HEALTH_REASONS = [
  /** The stored row cannot be executed as written. `MissionSchedule.unreadable` says why. */
  "config-unreadable",
  /** Enabled, but no next instant is scheduled - the cursor could not be computed. */
  "no-next-run",
  /** `nextRunAt` is further in the past than the loop's grace window explains. */
  "overdue",
  /** The most recent terminal occurrence failed. */
  "last-run-failed",
  /** A reservation has been sitting unfinished long enough to mean a crash, not a tick. */
  "stale-claim",
] as const;
export type ScheduleHealthReason = (typeof SCHEDULE_HEALTH_REASONS)[number];

// ---- bounds ----

/**
 * Five fields, and only five. `cron-parser` itself accepts three, four, five and six -
 * measured, not assumed - so six-field seconds syntax would parse and silently schedule
 * a mission every second under an expression the operator read as a minute. The count is
 * checked before the parser ever sees the string.
 */
export const SCHEDULE_CRON_FIELD_COUNT = 5;

/**
 * The closest two successive runs may be. One minute is the smallest unit the grammar can
 * express and one hour is the smallest we will run: the guardrail is against a mistyped
 * field filing 1,440 agent tasks in a day, which costs real money before anybody notices.
 */
export const SCHEDULE_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How far the minimum-interval check enumerates before it is entitled to say yes.
 *
 * The plan asks for the first two instants, and a fixed count of any size is a guess: it
 * answers "no short gap in the first N" and reports it as "no short gap". This spans a
 * whole day instead, which makes the check COMPLETE for a five-field expression, and the
 * completeness argument is a property of the grammar rather than of the sample:
 *
 * the times-of-day a five-field cron selects are exactly `minutes x hours`, and that set
 * is identical on every selected day - day-of-month and day-of-week choose WHICH days
 * fire, never at what times. So two runs less than an hour apart are always two runs
 * inside one day, and traversing any single selected day end to end sees every gap the
 * expression can ever produce.
 *
 * 26 hours rather than 24 because a fall-back day is 25 hours long, and the anchor lands
 * mid-day: the extra hour is what guarantees a complete traversal rather than a wrap that
 * misses the pair straddling where the enumeration started.
 *
 * This replaced a five-instant sample, and it is worth being exact about what changed: a
 * differential search over 8,100 expression/zone/anchor combinations found NO case the
 * sample got wrong, which the argument above explains - a short pair recurs every selected
 * hour, so it shows up in the first gap or two from any anchor. Nothing was leaking. What
 * changed is where the guarantee comes from. "No short gap in the first five" is a narrower
 * claim than "no short gap", and a reviewer had no way to tell whether the five was
 * load-bearing or arbitrary. Now the bound is derived from the grammar and the sample size
 * is not a number anyone has to trust.
 */
export const SCHEDULE_MIN_INTERVAL_SPAN_MS = 26 * 60 * 60 * 1000;

/**
 * Hard ceiling on that enumeration, so a pathological expression cannot spin.
 *
 * `minutes x hours` tops out at 1,440, so this bound is never the thing that ends a
 * legitimate probe - and an expression dense enough to approach it has already been
 * rejected several instants in, because the check stops the moment it finds one gap under
 * the minimum.
 */
export const SCHEDULE_MIN_INTERVAL_MAX_PROBE = 1500;

export const SCHEDULE_PREVIEW_DEFAULT_COUNT = 10;
export const SCHEDULE_PREVIEW_MAX_COUNT = 50;

/** Hard ceiling on one `between` enumeration, applied before anything is allocated. */
export const SCHEDULE_BETWEEN_MAX = 500;

/**
 * The most tasks one catch-up may file for a single schedule under `create-all`.
 *
 * It caps TASKS, never accounting: instants past the cap are still written to the ledger,
 * as `coalesced` pointing at the oldest run that did happen, so history explains the whole
 * window rather than starting where the cap let go. The number is what separates "I was
 * away for a fortnight and want the runs" from "a laptop that has been shut since spring
 * files 500 agent tasks in one tick", which costs real money before anyone sees the board.
 *
 * Not persisted - it is applied at decision time, and the durable record of a capped
 * catch-up is the coalesced rows themselves.
 */
export const SCHEDULE_CATCHUP_CREATE_CAP = 50;

export const SCHEDULE_HISTORY_DEFAULT_LIMIT = 25;
export const SCHEDULE_HISTORY_MAX_LIMIT = 100;

/**
 * How late `nextRunAt` may be before the catalog calls it overdue.
 *
 * The scheduler's health tick is bounded at one minute, so a due instant is normally
 * claimed within that. Five minutes is five missed ticks: past the point where this is a
 * scheduling hiccup and into "something is wrong", while still leaving room for a machine
 * that has just woken up and has a catch-up pass to run.
 */
export const SCHEDULE_OVERDUE_GRACE_MS = 5 * 60 * 1000;

/**
 * How long a `claimed` occurrence may sit before recovery treats it as a crash.
 *
 * A live claim is finished within one tick - the claim and the task creation that follows
 * it are milliseconds apart. Anything still reserved after this either lost its process or
 * hit an error that never wrote a terminal row, and both want the same repair.
 */
export const SCHEDULE_STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Task statuses that count as this schedule's work being still in flight.
 *
 * Shared because two readers must agree exactly: the SQL behind
 * `findActiveTaskForSchedule` and the scheduler's `skip-active` decision. The
 * terminal three (`done`, `cancelled`, `failed`) deliberately do not block - a schedule
 * whose last run failed still runs tomorrow.
 */
export const SCHEDULE_OVERLAP_BLOCKING_TASK_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "dispatching",
  "running",
];

// ---- the template ----

/** Everything a due instant needs in order to file an ordinary backlog task. */
export interface ScheduleTemplate {
  /**
   * Required, unlike an ordinary task's. A recurring mission files the same work over and
   * over, and letting the title be derived would spend an LLM titling call on every
   * single run to produce the same string.
   */
  title: string;
  intent: string;
  repoRoot: string;
  kind: TaskKind;
  agent: AgentType;
  priority: TaskPriority | null;
  labels: string[];
  model: string | null;
  effort: ThinkingLevel | null;
}

/** The editable half of a schedule: cadence, guardrails, and what to file. */
export interface ScheduleDefinition {
  name: string;
  expression: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  missedPolicy: ScheduleMissedPolicy;
  executionMode: ScheduleExecutionMode;
  runnerId: string | null;
  template: ScheduleTemplate;
}

// ---- unreadable rows ----

/**
 * What a stored row said that this build does not understand.
 *
 * A schedule written by a NEWER build - `executionMode: "remote-runner"`, a policy value
 * appended after this binary shipped, a template blob that will not parse - still loads,
 * because a row nobody can see is a row nobody can fix. What it must never do is run:
 * reading an unknown execution mode as local catch-up is the one failure that silently
 * creates work the operator asked a different machine to do.
 *
 * Enforcement is in the types, not in a convention. Every field that could carry an
 * unreadable value is `T | null` on `MissionSchedule` and `ScheduleRevision`, so a caller
 * cannot reach the value without saying what it does when there isn't one -
 * `scheduleIsRunnable` is the single narrowing gate that answers that once.
 */
export interface ScheduleUnreadable {
  /** One operator-readable sentence naming the column and the value we could not read. */
  reason: string;
  /** Column names, for a UI that wants to mark the offending fields. */
  fields: string[];
}

// ---- the schedule ----

export interface MissionSchedule {
  id: string;
  name: string;
  enabled: boolean;
  /** Set when archived. Archiving disables and hides; it deletes nothing. */
  archivedAt: number | null;
  expression: string;
  timezone: string;
  /** null when the stored value is not one this build knows - see `unreadable`. */
  overlapPolicy: ScheduleOverlapPolicy | null;
  /** null when the stored value is not one this build knows - see `unreadable`. */
  missedPolicy: ScheduleMissedPolicy | null;
  /** null when the stored value is not one this build knows - see `unreadable`. */
  executionMode: ScheduleExecutionMode | null;
  /** Which always-on host owns this schedule. Always null in V1. */
  runnerId: string | null;
  /** Points at the active immutable revision; the template lives on that row. */
  revision: number;
  /** null when the stored template JSON could not be read - see `unreadable`. */
  template: ScheduleTemplate | null;
  /**
   * The next instant this schedule is due, in UTC epoch milliseconds.
   *
   * Nullable for exactly three reasons: the schedule is paused, it is archived, or its
   * cadence could not be evaluated. It is NOT nullable for "we have not got round to it".
   */
  nextRunAt: number | null;
  lastOccurrence: ScheduleOccurrenceSummary | null;
  unreadable: ScheduleUnreadable | null;
  /** Derived by `deriveScheduleHealth` on the server. The browser reads, never recomputes. */
  health: ScheduleHealth;
  healthReasons: ScheduleHealthReason[];
  createdAt: number;
  updatedAt: number;
}

/**
 * A schedule whose every stored value this build understands.
 *
 * The type Phase 2 works in. Reaching it costs one call to `scheduleIsRunnable`, and that
 * call is the fail-closed gate: there is no other way to get non-null policies out of a
 * `MissionSchedule`.
 */
export interface RunnableSchedule extends MissionSchedule {
  overlapPolicy: ScheduleOverlapPolicy;
  missedPolicy: ScheduleMissedPolicy;
  executionMode: ScheduleExecutionMode;
  template: ScheduleTemplate;
  unreadable: null;
}

export function scheduleIsRunnable(s: MissionSchedule): s is RunnableSchedule {
  return (
    s.unreadable === null &&
    s.overlapPolicy !== null &&
    s.missedPolicy !== null &&
    s.executionMode !== null &&
    s.template !== null
  );
}

// ---- immutable revisions ----

/**
 * The cadence, policies and template exactly as they stood when a claim was made.
 *
 * Copied off the schedule rather than joined to it because history has to explain a
 * decision that was taken under settings the operator may since have changed. A rename
 * does not rewrite what already ran.
 */
export interface ScheduleRevision {
  scheduleId: string;
  revision: number;
  expression: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy | null;
  missedPolicy: ScheduleMissedPolicy | null;
  executionMode: ScheduleExecutionMode | null;
  runnerId: string | null;
  template: ScheduleTemplate | null;
  unreadable: ScheduleUnreadable | null;
  createdAt: number;
}

/** A revision this build can execute. See `scheduleIsRunnable` for the same argument. */
export interface RunnableScheduleRevision extends ScheduleRevision {
  overlapPolicy: ScheduleOverlapPolicy;
  missedPolicy: ScheduleMissedPolicy;
  executionMode: ScheduleExecutionMode;
  template: ScheduleTemplate;
  unreadable: null;
}

export function revisionIsRunnable(r: ScheduleRevision): r is RunnableScheduleRevision {
  return (
    r.unreadable === null &&
    r.overlapPolicy !== null &&
    r.missedPolicy !== null &&
    r.executionMode !== null &&
    r.template !== null
  );
}

// ---- occurrences ----

/** The compact form carried on a catalog row: what happened last, and how late. */
export interface ScheduleOccurrenceSummary {
  id: string;
  /** The instant this occurrence is FOR, not when it ran. Unique per schedule. */
  scheduledFor: number;
  claimedAt: number;
  finishedAt: number | null;
  /** null when the stored value is not one this build knows. */
  status: ScheduleOccurrenceStatus | null;
  /** null when the stored value is not one this build knows. */
  triggerKind: ScheduleTriggerKind | null;
  taskId: string | null;
  /** `claimedAt - scheduledFor`: how late the machine was, in the catalog's own words. */
  delayMs: number;
  error: string | null;
}

export interface ScheduleOccurrence extends ScheduleOccurrenceSummary {
  scheduleId: string;
  /** The revision in force at claim time - never the schedule's current one. */
  scheduleRevision: number;
  /** null when the stored value is not one this build knows; recovery refuses to guess. */
  decisionKind: ScheduleDecisionKind | null;
  /** The later occurrence that represented this missed instant, for `coalesced`. */
  coveredById: string | null;
  /** The still-active task that caused a `skipped_overlap`. */
  blockingTaskId: string | null;
  createdAt: number;
}

// ---- history ----

export interface ScheduleHistoryCursor {
  /** Return occurrences strictly older than this instant. Null starts at the newest. */
  before: number | null;
  limit: number;
}

export interface ScheduleHistoryPage {
  /**
   * The schedule the page belongs to, INCLUDING an archived one. History outlives the
   * catalog entry, so a page that could not name its schedule would be unreadable exactly
   * when it is most wanted.
   */
  schedule: MissionSchedule;
  /** Newest first. */
  occurrences: ScheduleOccurrence[];
  /** Pass back as `before` for the next page. Null when this page is the last. */
  nextCursor: number | null;
}

// ---- validation ----

/**
 * Which input a refusal belongs to, so a form can put the message on the right field.
 *
 * Not persisted - a validation error is answered, rendered and thrown away - so unlike
 * the enums at the top of this file this list is free to grow. The last four arrived with
 * the scheduler: `recurrence.validate` only ever judges the cadence, but the manager also
 * refuses a nameless mission, an untitled or intentless template, and a `repoRoot` that is
 * not a repo's main checkout - and a refusal a form cannot attach to a field is one the
 * operator has to guess at.
 */
export const SCHEDULE_VALIDATION_FIELDS = [
  "expression",
  "timezone",
  "name",
  "repoRoot",
  "title",
  "intent",
] as const;
export type ScheduleValidationField = (typeof SCHEDULE_VALIDATION_FIELDS)[number];

export interface ScheduleValidationError {
  field: ScheduleValidationField;
  message: string;
}

/**
 * A validated cadence, with both halves canonicalized.
 *
 * `expression` comes back with its whitespace collapsed and `timezone` as the IANA id
 * `Intl` resolves it to, so what gets persisted is stable regardless of how it was typed:
 * `utc` stores as `UTC`, `US/Pacific` as `America/Los_Angeles`.
 */
export type ScheduleValidation =
  | { ok: true; expression: string; timezone: string }
  | { ok: false; error: ScheduleValidationError };

// ---- preview ----

export interface SchedulePreviewInstant {
  /** UTC epoch milliseconds. What gets persisted; the zone is a rendering concern. */
  at: number;
  /** Minutes east of UTC in the schedule's zone at this instant (EDT is -240). */
  offsetMinutes: number;
  /**
   * True when this instant sits on a different UTC offset than the one before it - the
   * DST transition, called out so the preview can say so rather than leaving the operator
   * to spot an hour that moved.
   */
  dstShift: boolean;
}

/**
 * What one crossed instant would become, without anything being written.
 *
 * The same `ScheduleDecisionKind` the ledger persists, produced by the same function the
 * scheduler decides with (`planMissedInstants`, `src/server/schedules/policy.ts`) - so a
 * preview that says "these three coalesce into the 09:00 run" is not a second description
 * of the policy that can drift from it, it IS the policy.
 *
 * `skipped_overlap` never appears here: whether a task is still in flight is a fact about
 * the moment of execution, not about the cadence, and a preview that guessed at it would
 * be confidently wrong exactly when the operator is deciding which policy to pick.
 */
export interface ScheduleMissedDecision {
  at: number;
  decisionKind: ScheduleDecisionKind;
  /** For `coalesced`, the instant whose run stands in for this one. */
  coveredBy: number | null;
}

/**
 * "What would have happened while the laptop was shut?", answered without writing anything.
 *
 * The two halves have different owners, and `plan` is null whenever the second one had no
 * say: `recurrence.preview` knows the cadence and can enumerate what a window crossed, but
 * it has no missed policy to judge them by. Supply `missedPolicy` on the input and the
 * scheduler fills this in.
 *
 * What the plan does NOT claim is that the work ran on time. An instant that creates work
 * here runs at `resumedAt`, late by `resumedAt - at`, and V1 promises exactly that: every
 * crossed instant is accounted for once when Mission Control runs again, never that
 * anything happened while the machine was off.
 */
export interface ScheduleStandbySimulation {
  sleepStartedAt: number;
  resumedAt: number;
  /** Instants that came due during the window, oldest first. */
  missed: number[];
  /** True when the window held more instants than `SCHEDULE_BETWEEN_MAX` could return. */
  truncated: boolean;
  /** Per-instant outcome under the requested missed policy, or null if none was given. */
  plan: ScheduleMissedDecision[] | null;
}

/** Another schedule already firing at instants this cadence also wants. Advisory only. */
export interface SchedulePreviewCollision {
  scheduleId: string;
  name: string;
  /** The previewed instants that schedule also fires at, oldest first. */
  at: number[];
}

export interface SchedulePreviewInput {
  expression: string;
  timezone: string;
  /** Anchor; instants are strictly after it. Defaults to now at the call site. */
  after?: number;
  count?: number;
  sleepStartedAt?: number;
  resumedAt?: number;
  /** Judge the standby window by this policy. Omitted leaves `standby.plan` null. */
  missedPolicy?: ScheduleMissedPolicy;
  /** The schedule being edited, so a cadence never collides with its own saved self. */
  excludeScheduleId?: string;
}

export type SchedulePreviewResult =
  | {
      ok: true;
      /** Canonicalized, as `ScheduleValidation` describes. */
      expression: string;
      timezone: string;
      instants: SchedulePreviewInstant[];
      standby: ScheduleStandbySimulation | null;
      /**
       * Enabled schedules that fire at one of these instants too.
       *
       * Empty from `recurrence.preview`, which answers questions about ONE expression and
       * deliberately reads no catalog; the manager fills it. Advisory in the strict sense -
       * two missions at 09:00 is a thing an operator may well want, and nothing refuses it.
       */
      collisions: SchedulePreviewCollision[];
    }
  | { ok: false; error: ScheduleValidationError };

// ---- health derivation ----

/**
 * Everything health depends on, and nothing else.
 *
 * A struct rather than a `MissionSchedule` because health is computed WHILE building one -
 * taking the finished object would mean the field had to exist before it could be derived.
 */
export interface ScheduleHealthInput {
  enabled: boolean;
  archivedAt: number | null;
  nextRunAt: number | null;
  unreadable: ScheduleUnreadable | null;
  lastOccurrence: ScheduleOccurrenceSummary | null;
  /** When the oldest unfinished reservation was claimed, if there is one. */
  oldestClaimAt: number | null;
  now: number;
}

export interface ScheduleHealthResult {
  health: ScheduleHealth;
  reasons: ScheduleHealthReason[];
}

/**
 * The one definition of catalog health, so the daemon and the dashboard cannot disagree
 * about what "attention" means.
 *
 * Paused wins over attention deliberately. A schedule the operator switched off is not
 * asking them for anything, and a catalog that badges a deliberately-parked mission as
 * needing help trains people to ignore the badge. Recovery of a stale claim runs whether
 * or not the schedule is enabled, so nothing is lost by staying quiet about it here.
 */
export function deriveScheduleHealth(input: ScheduleHealthInput): ScheduleHealthResult {
  if (!input.enabled || input.archivedAt !== null) return { health: "paused", reasons: [] };

  const reasons: ScheduleHealthReason[] = [];
  if (input.unreadable) reasons.push("config-unreadable");
  if (input.nextRunAt === null) reasons.push("no-next-run");
  else if (input.now - input.nextRunAt > SCHEDULE_OVERDUE_GRACE_MS) reasons.push("overdue");
  if (input.lastOccurrence?.status === "failed") reasons.push("last-run-failed");
  if (input.oldestClaimAt !== null && input.now - input.oldestClaimAt > SCHEDULE_STALE_CLAIM_MS) {
    reasons.push("stale-claim");
  }
  return reasons.length > 0 ? { health: "attention", reasons } : { health: "healthy", reasons: [] };
}

// ---- normalization ----

/**
 * Collapse a typed cron expression to its canonical spacing.
 *
 * Both a normalizer and the field counter's input: `"0  8 * * *"` and `"0 8 * * *"` are
 * the same schedule, and a field count taken off the raw string would disagree.
 */
export function normalizeCronExpression(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** How many whitespace-separated fields a normalized expression has. */
export function cronFieldCount(expression: string): number {
  const normalized = normalizeCronExpression(expression);
  return normalized === "" ? 0 : normalized.split(" ").length;
}

/**
 * Read a persisted enum value back, or null if this build has never heard of it.
 *
 * One helper for all five persisted enums rather than five hand-written guards, because
 * the failure it prevents - a value silently read as something adjacent - is identical in
 * each and a hand-written guard is where that gets forgotten.
 */
export function readPersistedEnum<T extends string>(
  values: readonly T[],
  raw: string | null | undefined,
): T | null {
  return raw != null && (values as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** Clamp a caller-supplied preview count into the range the evaluator will honour. */
export function clampPreviewCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return SCHEDULE_PREVIEW_DEFAULT_COUNT;
  return Math.min(SCHEDULE_PREVIEW_MAX_COUNT, Math.max(1, Math.floor(count)));
}

/** Clamp a caller-supplied history page size. Invalid input reads as the default. */
export function clampHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SCHEDULE_HISTORY_DEFAULT_LIMIT;
  return Math.min(SCHEDULE_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
