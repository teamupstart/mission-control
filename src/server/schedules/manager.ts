import { randomUUID } from "node:crypto";
import {
  SCHEDULE_BETWEEN_MAX,
  SCHEDULE_CATCHUP_CREATE_CAP,
  revisionIsRunnable,
  scheduleIsRunnable,
} from "@shared/schedules.ts";
import type {
  MissionSchedule,
  ScheduleCompletionPolicy,
  ScheduleDecisionKind,
  RunnableScheduleRevision,
  ScheduleDefinition,
  ScheduleHistoryCursor,
  ScheduleHistoryPage,
  ScheduleMissedPolicy,
  ScheduleOccurrence,
  ScheduleOverlapPolicy,
  SchedulePreviewCollision,
  SchedulePreviewInput,
  SchedulePreviewResult,
  ScheduleTemplate,
  ScheduleValidationError,
} from "@shared/schedules.ts";
import type { TaskRepoRoot } from "../repos.ts";
import { resolveTaskRepoRoot } from "../repos.ts";
import type { CreateTaskInput, InternalCreateOptions } from "../tasks.ts";
import { TaskIdCollisionError } from "../tasks.ts";
import { getTask as getDurableTask } from "../db.ts";
import type { Task } from "@shared/types.ts";
import { recurrence as defaultRecurrence } from "./recurrence.ts";
import type { RecurrenceEvaluator } from "./recurrence.ts";
import {
  decideOverlap,
  missedDecisionsFor,
  planMissedPage,
  planMissedWindow,
  terminalStatusFor,
} from "./policy.ts";
import * as store from "./store.ts";

/**
 * The scheduling ENGINE: the one thing that turns a crossed instant into a backlog task.
 *
 * Three modules, three jobs, and the boundaries are the design. `recurrence.ts` says when
 * a cadence is due, `policy.ts` says what should happen to the instants it produced, and
 * `store.ts` owns the transaction that makes a decision exactly-once. This module is what
 * is left: sequencing those three, coping with the ledger refusing a decision, and
 * recovering the two crash windows around task creation.
 *
 * What it deliberately cannot do is start an agent. Nothing here calls `dispatch`,
 * `assign`, the Dispatcher, the terminal registry or any pane control, and the refusal is
 * enforced one level down - `TaskManager.create` throws on an internal create that is not
 * `backlog`. A recurring mission files an ordinary backlog task and stops; Foreman remains
 * the only autonomous path from there to a running agent, with its capacity, dependency,
 * allowlist and pane-safety gates intact. That is what keeps "this schedule fires hourly"
 * from meaning "this schedule can launch agents hourly with nobody's consent".
 *
 * Every seam below exists because the interesting behaviour is otherwise untestable: a
 * clock you cannot move cannot be jumped backwards, and a repo resolver that touches the
 * disk cannot be made to fail on demand. The defaults are the production wiring.
 */

// ---- the live-state adapter Phase 3 will supply ----

/**
 * Where a durable schedule change is announced, once it is durable.
 *
 * A no-op here, and that is the whole point of declaring it now: Phase 3 hands in a
 * Registry-backed implementation and no policy in this file changes. Every call site is
 * AFTER the write it describes has returned - an SSE emission cannot be rolled back, so a
 * notification sent from inside a transaction that can still fail is a dashboard showing
 * a schedule the database does not have.
 */
export interface ScheduleNotifier {
  upsert(schedule: MissionSchedule): void;
  remove(id: string): void;
}

const NOOP_NOTIFIER: ScheduleNotifier = { upsert() {}, remove() {} };

// ---- what the manager needs from the rest of the daemon ----

/**
 * The task manager, narrowed to the one call a scheduler may make.
 *
 * Narrow on purpose: handed the whole `TaskManager`, this module could dispatch, and the
 * only thing stopping it would be that nobody wrote the line. The interface is the
 * enforcement, and `TaskManager` satisfies it structurally.
 */
export interface ScheduleTaskCreator {
  create(input: CreateTaskInput, internal: InternalCreateOptions): Task;
}

/** One structured operational line. Bounded fields only - never the task's intent. */
export type ScheduleLog = (
  event: string,
  fields: Record<string, unknown>,
) => void;

const defaultLog: ScheduleLog = (event, fields) => {
  const rendered = Object.entries(fields)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.log(`[schedules] ${event}${rendered ? ` ${rendered}` : ""}`);
};

export interface ScheduleManagerDeps {
  tasks: ScheduleTaskCreator;
  now?: () => number;
  uuid?: () => string;
  recurrence?: RecurrenceEvaluator;
  resolveRepoRoot?: (path: string) => Promise<TaskRepoRoot>;
  notifier?: ScheduleNotifier;
  log?: ScheduleLog;
}

// ---- results ----

/** The editable half of a schedule, minus the two fields V1 does not let a caller choose. */
export interface ScheduleDefinitionInput {
  name: string;
  expression: string;
  timezone: string;
  overlapPolicy: ScheduleOverlapPolicy;
  missedPolicy: ScheduleMissedPolicy;
  completionPolicy: ScheduleCompletionPolicy;
  template: ScheduleTemplate;
}

export interface CreateScheduleInput extends ScheduleDefinitionInput {
  /** Defaults to enabled. A schedule saved paused holds no cursor at all. */
  enabled?: boolean;
}

export type UpdateScheduleInput = ScheduleDefinitionInput;

/**
 * A preview of an unsaved definition: the whole editable definition, plus the knobs a
 * preview alone needs.
 *
 * It carries the FULL definition, not just the cadence, because preview and save must
 * refuse the same things: a preview that validated only the expression would greenlight a
 * `repoRoot` that is not a repository, then save would reject it - the UI showing a schedule
 * as previewable that it cannot store. `previewDefinition` runs the same `prepareDefinition`
 * gate save does, so the two answers cannot diverge.
 */
export interface SchedulePreviewDefinitionInput extends ScheduleDefinitionInput {
  /** Anchor; instants are strictly after it. Defaults to now. */
  after?: number;
  count?: number;
  sleepStartedAt?: number;
  resumedAt?: number;
  /** The schedule being edited, so a cadence never collides with its own saved self. */
  excludeScheduleId?: string;
}

/**
 * A refusal carries the field it belongs to, so Phase 3's route can answer 400 and the
 * form can put the sentence under the input that caused it.
 */
export type ScheduleSaveResult =
  | { ok: true; schedule: MissionSchedule }
  | { ok: false; error: ScheduleValidationError };

export type ScheduleRunNowResult =
  | { ok: true; occurrence: ScheduleOccurrence; schedule: MissionSchedule }
  | { ok: false; error: string };

/** What one pass over the due catalog did. Counters only; nothing here is persisted. */
export interface ScheduleTickSummary {
  schedules: number;
  due: number;
  created: number;
  coalesced: number;
  skippedPolicy: number;
  skippedOverlap: number;
  failed: number;
  /** Instants whose claim was won by somebody else, or refused by a changed schedule. */
  lost: number;
  /** Catch-ups where `create-all` hit `SCHEDULE_CATCHUP_CREATE_CAP`. */
  capped: number;
  /** Largest `claimedAt - scheduledFor` seen this pass - how late the machine was. */
  maxDelayMs: number;
  recovery: ScheduleRecoverySummary;
}

export interface ScheduleRecoverySummary {
  /** Reservations found unfinished, i.e. the size of the crash this is repairing. */
  claims: number;
  /** Crashed BEFORE the task existed: recovery created it on the preallocated id. */
  recoveredBeforeTask: number;
  /** Crashed AFTER the task was persisted: recovery only had to close the ledger row. */
  recoveredAfterTask: number;
  /** Terminal decisions that never got their closing write. */
  finishedTerminal: number;
  alreadySettled: number;
  cancelled: number;
  failed: number;
  /** Rows this build cannot read, left exactly as found. */
  unreadable: number;
}

function emptyRecovery(): ScheduleRecoverySummary {
  return {
    claims: 0,
    recoveredBeforeTask: 0,
    recoveredAfterTask: 0,
    finishedTerminal: 0,
    alreadySettled: 0,
    cancelled: 0,
    failed: 0,
    unreadable: 0,
  };
}

function emptyTick(): ScheduleTickSummary {
  return {
    schedules: 0,
    due: 0,
    created: 0,
    coalesced: 0,
    skippedPolicy: 0,
    skippedOverlap: 0,
    failed: 0,
    lost: 0,
    capped: 0,
    maxDelayMs: 0,
    recovery: emptyRecovery(),
  };
}

// ---- the manager ----

/**
 * The server-only surface Phase 3's routes depend on.
 *
 * Every method returns a durable result the route can map straight to HTTP; none reopens
 * recurrence, policy, or SQL. Declared so `buildApp` can take a narrowed dependency and a
 * test can pass a fake without constructing a real manager - `ScheduleManager` satisfies it
 * structurally through `implements`.
 */
export interface ScheduleService {
  list(): MissionSchedule[];
  get(id: string): MissionSchedule | null;
  history(id: string, cursor: ScheduleHistoryCursor): ScheduleHistoryPage | null;
  /**
   * Preview an unsaved definition with the SAME validation save applies, repo root included,
   * so the browser cannot preview a schedule the save route would refuse. Async because that
   * validation resolves the repository.
   */
  previewDefinition(input: SchedulePreviewDefinitionInput): Promise<SchedulePreviewResult>;
  create(input: CreateScheduleInput): Promise<ScheduleSaveResult>;
  update(id: string, input: UpdateScheduleInput): Promise<ScheduleSaveResult>;
  setEnabled(id: string, enabled: boolean): Promise<ScheduleSaveResult>;
  runNow(id: string): Promise<ScheduleRunNowResult>;
  archive(id: string): Promise<MissionSchedule | null>;
}

export class ScheduleManager implements ScheduleService {
  private readonly tasks: ScheduleTaskCreator;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly recurrence: RecurrenceEvaluator;
  private readonly resolveRepoRoot: (path: string) => Promise<TaskRepoRoot>;
  private notifier: ScheduleNotifier;
  private readonly log: ScheduleLog;
  private readonly operationTails = new Map<string, Promise<void>>();

  constructor(deps: ScheduleManagerDeps) {
    this.tasks = deps.tasks;
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? randomUUID;
    this.recurrence = deps.recurrence ?? defaultRecurrence;
    this.resolveRepoRoot = deps.resolveRepoRoot ?? resolveTaskRepoRoot;
    this.notifier = deps.notifier ?? NOOP_NOTIFIER;
    this.log = deps.log ?? defaultLog;
  }

  /** Phase 3 swaps the no-op for a Registry-backed notifier without touching policy. */
  setNotifier(notifier: ScheduleNotifier): void {
    this.notifier = notifier;
  }

  // ---- reads ----

  list(): MissionSchedule[] {
    return store.listSchedules(this.now());
  }

  get(id: string): MissionSchedule | null {
    return store.getSchedule(id, this.now());
  }

  history(
    id: string,
    cursor: ScheduleHistoryCursor,
  ): ScheduleHistoryPage | null {
    return store.historyPage(id, cursor, this.now());
  }

  /**
   * Preview an unsaved definition with the exact validation save applies.
   *
   * This is the door Phase 3's route uses, and the reason it exists beside the cadence-only
   * `preview` below: preview and save must refuse the same definition. `prepareDefinition`
   * is the one gate both go through - it validates the name, title, intent, cadence AND
   * resolves the repository through the same resolver `create` uses - so a `repoRoot` that
   * is not a repository fails here just as it would on save, rather than previewing clean
   * and then being rejected. It writes nothing: the repo resolve is a read, and the cadence
   * work below touches no row. On success the cadence is previewed from the CANONICAL
   * expression `prepareDefinition` produced, so the instants match what save would store.
   */
  async previewDefinition(
    input: SchedulePreviewDefinitionInput,
  ): Promise<SchedulePreviewResult> {
    const prepared = await this.prepareDefinition(input, this.now());
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const def = prepared.definition;
    return this.preview({
      expression: def.expression,
      timezone: def.timezone,
      after: input.after,
      count: input.count,
      sleepStartedAt: input.sleepStartedAt,
      resumedAt: input.resumedAt,
      missedPolicy: def.missedPolicy,
      excludeScheduleId: input.excludeScheduleId,
    });
  }

  /**
   * What this cadence would do, writing nothing at all.
   *
   * Three answers in one call, and each comes from the component that owns it: the future
   * instants from `recurrence`, the standby outcome from the same `planMissedInstants` the
   * scheduler decides with, and the collisions from the catalog. Nothing is recomputed
   * here, which is what makes the preview a promise rather than an illustration.
   *
   * Cadence-only and synchronous - the Phase 2 contract. `previewDefinition` above wraps it
   * with the full save-time validation Phase 3's route needs.
   */
  preview(input: SchedulePreviewInput): SchedulePreviewResult {
    const result = this.recurrence.preview(input, this.now());
    if (!result.ok) return result;

    const standby =
      result.standby && input.missedPolicy && !result.standby.truncated
        ? {
            ...result.standby,
            plan: missedDecisionsFor(result.standby.missed, input.missedPolicy),
          }
        : result.standby;

    return {
      ...result,
      standby,
      collisions: this.collisionsFor(
        result.instants.map((i) => i.at),
        input.excludeScheduleId,
      ),
    };
  }

  /**
   * Which live schedules also fire at one of these instants.
   *
   * Bounded by construction: a preview contains at most fifty instants, and each schedule
   * is tested only at those instants rather than across every run in the intervening span.
   * A schedule whose stored cadence this build cannot read contributes nothing rather than
   * being guessed at - it is not going to run either.
   */
  private collisionsFor(
    instants: number[],
    excludeId?: string,
  ): SchedulePreviewCollision[] {
    if (instants.length === 0) return [];
    const collisions: SchedulePreviewCollision[] = [];
    for (const schedule of store.listSchedules(this.now())) {
      if (!schedule.enabled || schedule.id === excludeId) continue;
      if (!scheduleIsRunnable(schedule)) continue;
      const at = instants.filter(
        (instant) =>
          this.recurrence.between(
            schedule.expression,
            schedule.timezone,
            instant - 60_000,
            instant,
            1,
          )[0] === instant,
      );
      if (at.length > 0)
        collisions.push({ scheduleId: schedule.id, name: schedule.name, at });
    }
    return collisions;
  }

  // ---- definition mutations ----

  async create(input: CreateScheduleInput): Promise<ScheduleSaveResult> {
    const prepared = await this.prepareDefinition(input, this.now());
    if (!prepared.ok) return prepared;

    // Repository validation is asynchronous. Anchor the new cursor when the definition
    // is ready to commit, so a due instant crossed during validation (or system standby)
    // does not become debt for a schedule that did not exist yet.
    const committedAt = this.now();
    const enabled = input.enabled ?? true;
    // A paused schedule holds NO cursor. Storing one and ignoring it would leave a
    // resumed schedule owing every instant it slept through - see `setEnabled`.
    const nextRunAt = enabled
      ? this.firstRunAfter(prepared.definition, committedAt)
      : null;
    const schedule = store.createSchedule({
      id: this.uuid(),
      definition: prepared.definition,
      enabled,
      nextRunAt,
      at: committedAt,
    });
    this.notifySchedule(schedule);
    this.log("created", { schedule: schedule.id, enabled, nextRunAt });
    return { ok: true, schedule };
  }

  /**
   * Apply an edit as a new immutable revision.
   *
   * The cursor is recomputed from the EDIT time, not carried over: an operator who moves a
   * mission from 09:00 to 17:00 has said what should happen next, and inheriting a cursor
   * pointing at 09:00 would fire the old cadence once more under the new revision.
   *
   * A claim already won under the old revision is untouched by this and completes as
   * itself - `claimOccurrence` guards on the exact revision, so an in-flight tick that
   * reaches the ledger after this returns is refused and re-decides under the new one.
   */
  async update(
    id: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleSaveResult> {
    const at = this.now();
    const current = store.getSchedule(id, at);
    if (!current) return refuse("name", `no schedule ${id}`);
    if (current.archivedAt !== null)
      return refuse("name", "this schedule is archived");

    const prepared = await this.prepareDefinition(input, at);
    if (!prepared.ok) return prepared;

    const committedAt = this.now();
    const fresh = store.getSchedule(id, committedAt);
    if (!fresh) return refuse("name", `no schedule ${id}`);
    if (fresh.archivedAt !== null)
      return refuse("name", "this schedule is archived");

    const nextRunAt = fresh.enabled
      ? this.firstRunAfter(prepared.definition, committedAt)
      : null;
    const schedule = store.updateSchedule(
      id,
      prepared.definition,
      nextRunAt,
      committedAt,
    );
    if (!schedule) return refuse("name", `no schedule ${id}`);
    this.notifySchedule(schedule);
    this.log("updated", {
      schedule: id,
      revision: schedule.revision,
      nextRunAt,
    });
    return { ok: true, schedule };
  }

  /**
   * Pause or resume.
   *
   * Resuming starts from the resume instant, so a pause accrues no debt: a mission parked
   * for a month does not wake up owing thirty runs. That is a policy choice and the
   * opposite one is defensible, but it must be made HERE and once - the alternative is a
   * pause that quietly means "queue everything" and a catch-up nobody asked for.
   */
  async setEnabled(id: string, enabled: boolean): Promise<ScheduleSaveResult> {
    const at = this.now();
    const current = store.getSchedule(id, at);
    if (!current) return refuse("name", `no schedule ${id}`);
    if (current.archivedAt !== null)
      return refuse("name", "this schedule is archived");
    if (enabled && !scheduleIsRunnable(current)) {
      return refuse(
        "expression",
        current.unreadable?.reason ??
          "this schedule was written by a newer build and cannot be run here",
      );
    }

    const nextRunAt = enabled
      ? this.recurrence.nextAfter(current.expression, current.timezone, at)
      : null;
    const schedule = store.setScheduleEnabled(id, enabled, nextRunAt, at);
    if (!schedule) return refuse("name", `no schedule ${id}`);
    this.notifySchedule(schedule);
    this.log(enabled ? "resumed" : "paused", { schedule: id, nextRunAt });
    return { ok: true, schedule };
  }

  /** Retire a schedule: the clock stops, every row stands, history stays reachable. */
  async archive(id: string): Promise<MissionSchedule | null> {
    const at = this.now();
    const schedule = store.archiveSchedule(id, at);
    if (!schedule) return null;
    this.notifySchedule(schedule);
    this.log("archived", { schedule: id });
    return schedule;
  }

  /**
   * Validate an edit and canonicalize both halves of it.
   *
   * `executionMode` and `runnerId` are not taken from the caller at all. V1 runs work on
   * THIS machine when it is running, and a form that offered `remote-runner` would be
   * offering a promise nothing in this build keeps - the schema carries the other two
   * values so that history written by a later build still loads, not so that this one can
   * write them.
   */
  private async prepareDefinition(
    input: ScheduleDefinitionInput,
    at: number,
  ): Promise<
    | { ok: true; definition: ScheduleDefinition }
    | { ok: false; error: ScheduleValidationError }
  > {
    const name = input.name.trim();
    if (!name) return refuse("name", "Give this mission a name.");

    const title = input.template.title.trim();
    if (!title) {
      // Not cosmetic. An untitled task takes the model-titling path, which would spend an
      // LLM call on every run to derive the same string from the same intent.
      return refuse(
        "title",
        "A recurring mission needs a title - every run files it.",
      );
    }
    const intent = input.template.intent.trim();
    if (!intent) return refuse("intent", "Say what each run should do.");

    const cadence = this.recurrence.validate(
      input.expression,
      input.timezone,
      at,
    );
    if (!cadence.ok) return { ok: false, error: cadence.error };

    // The same gate the dispatch form and every task source passes through, so a schedule
    // cannot store a root that would be unschedulable the moment it fired.
    const repo = await this.resolveRepoRoot(input.template.repoRoot);
    if (!repo.ok) return refuse("repoRoot", repo.error);

    return {
      ok: true,
      definition: {
        name,
        expression: cadence.expression,
        timezone: cadence.timezone,
        overlapPolicy: input.overlapPolicy,
        missedPolicy: input.missedPolicy,
        completionPolicy: input.completionPolicy,
        executionMode: "local-catchup",
        runnerId: null,
        template: { ...input.template, title, intent, repoRoot: repo.repoRoot },
      },
    };
  }

  private firstRunAfter(
    definition: ScheduleDefinition,
    at: number,
  ): number | null {
    return this.recurrence.nextAfter(
      definition.expression,
      definition.timezone,
      at,
    );
  }

  // ---- run now ----

  /**
   * File this mission's work immediately, without touching its cadence.
   *
   * Works while paused, which is the point of a manual trigger: "run it now" is a thing
   * you say about a mission you have deliberately stopped as often as one you have not.
   * It goes through the SAME claim as a scheduled instant - so it appears in history, is
   * subject to overlap policy, and is recovered after a crash like any other - and differs
   * in exactly two ways: `trigger_kind = manual`, and `advanceCursor: false`.
   *
   * The instant it mints is deliberately off the cron grid. `(schedule_id, scheduled_for)`
   * is UNIQUE and shared with scheduled runs, so a manual instant landing on a grid minute
   * would occupy a key the cursor is going to want. The ledger survives that collision on
   * its own, but avoiding it keeps a manual run from ever standing in for a scheduled one.
   */
  async runNow(id: string): Promise<ScheduleRunNowResult> {
    return this.withScheduleLock(id, () => this.runNowLocked(id));
  }

  private async runNowLocked(id: string): Promise<ScheduleRunNowResult> {
    const at = this.now();
    const schedule = store.getSchedule(id, at);
    if (!schedule) return { ok: false, error: `no schedule ${id}` };
    if (schedule.archivedAt !== null)
      return { ok: false, error: "this schedule is archived" };

    const revision = store.activeRevision(id);
    if (!revision || !revisionIsRunnable(revision)) {
      return {
        ok: false,
        error:
          revision?.unreadable?.reason ??
          "this schedule's settings were written by a newer build and cannot be run here",
      };
    }

    const blocking = store.findActiveTaskForSchedule(id);
    const decision = decideOverlap(
      revision.overlapPolicy,
      blocking?.id ?? null,
    );

    const claim = this.claimManual(id, revision, decision, at);
    if (!claim)
      return { ok: false, error: "could not reserve a run for this schedule" };

    const settled = await this.settle(claim.occurrence, revision, decision, at);
    const after = store.getSchedule(id, this.now());
    if (after) this.notifySchedule(after);
    this.log("run-now", {
      schedule: id,
      occurrence: settled.id,
      status: settled.status,
      task: settled.taskId,
    });
    return after
      ? { ok: true, occurrence: settled, schedule: after }
      : { ok: false, error: `no schedule ${id}` };
  }

  /**
   * Reserve a manual instant, stepping off any key that is already taken.
   *
   * Repeated clicks in the same millisecond are the ordinary case here, not a race to be
   * apologised for: the ledger answers `already_exists`, and one millisecond later is a
   * free key. Bounded, so a schedule that somehow holds a solid block of them refuses
   * rather than spins.
   */
  private claimManual(
    id: string,
    revision: RunnableScheduleRevision,
    decision: {
      decisionKind: "create_task" | "skipped_overlap";
      blockingTaskId: string | null;
    },
    at: number,
  ): { occurrence: ScheduleOccurrence } | null {
    let scheduledFor = at;
    for (let attempt = 0; attempt < 100; attempt++) {
      // A collision can step onto the next minute boundary, so enforce this for every
      // candidate rather than only the clock value the first attempt started from.
      if (scheduledFor % 60_000 === 0) scheduledFor += 1;
      const result = store.claimOccurrence({
        occurrenceId: this.uuid(),
        scheduleId: id,
        scheduleRevision: revision.revision,
        scheduledFor,
        triggerKind: "manual",
        decisionKind: decision.decisionKind,
        taskId: decision.decisionKind === "create_task" ? this.uuid() : null,
        coveredById: null,
        blockingTaskId: decision.blockingTaskId,
        claimedAt: at,
        delayMs: 0,
        // The cadence is not this run's business. Expressed as a flag rather than by
        // writing the old cursor back - see `ScheduleClaimInput.advanceCursor`.
        advanceCursor: false,
        nextRunAt: null,
      });
      if (result.outcome === "claimed")
        return { occurrence: result.occurrence };
      if (result.outcome === "schedule_changed") return null;
      scheduledFor += 1;
    }
    return null;
  }

  // ---- the tick ----

  /**
   * One pass: repair what a crash left behind, then account for every instant now due.
   *
   * Recovery goes FIRST and that ordering is not incidental. A claimed occurrence holds a
   * reserved task id and a decision taken under a revision that may since have changed;
   * processing new due work first would file today's run while yesterday's sits
   * half-finished, and under `skip-active` the recovered task would then be blocked by the
   * one that overtook it - inverting the order the ledger says the work happened in.
   */
  async tick(now = this.now()): Promise<ScheduleTickSummary> {
    const summary = emptyTick();
    summary.recovery = await this.recover(now);

    for (const schedule of store.dueSchedules(now)) {
      summary.schedules++;
      try {
        await this.withScheduleLock(schedule.id, () =>
          this.tickSchedule(schedule, now, summary),
        );
      } catch (err) {
        // Contained per schedule: one mission with an unreadable template must not stop
        // the rest of the catalog from running.
        summary.failed++;
        this.log("tick-error", { schedule: schedule.id, error: describe(err) });
      }
    }

    if (summary.due > 0) {
      this.log("tick", {
        schedules: summary.schedules,
        due: summary.due,
        created: summary.created,
        coalesced: summary.coalesced,
        skippedPolicy: summary.skippedPolicy,
        skippedOverlap: summary.skippedOverlap,
        failed: summary.failed,
        lost: summary.lost,
        capped: summary.capped,
        maxDelayMs: summary.maxDelayMs,
      });
    }
    return summary;
  }

  private async tickSchedule(
    schedule: MissionSchedule,
    now: number,
    summary: ScheduleTickSummary,
  ): Promise<void> {
    const cursor = schedule.nextRunAt;
    if (cursor === null) return;
    if (!scheduleIsRunnable(schedule)) {
      // Health already says `config-unreadable`; the cursor stays exactly where it is,
      // because the one thing worse than not running is running the wrong thing.
      this.log("unreadable", {
        schedule: schedule.id,
        reason: schedule.unreadable?.reason,
      });
      return;
    }
    const revision = store.activeRevision(schedule.id);
    if (!revision || !revisionIsRunnable(revision)) {
      this.log("unreadable-revision", {
        schedule: schedule.id,
        revision: schedule.revision,
      });
      return;
    }

    const firstPage = this.recurrence.between(
      revision.expression,
      revision.timezone,
      cursor - 1,
      now,
      SCHEDULE_BETWEEN_MAX,
    );
    if (firstPage.length === 0) {
      this.repairStuckCursor(schedule, revision, cursor, now);
      return;
    }

    const newest = this.newestDueInstants(
      revision,
      cursor,
      now,
      revision.missedPolicy === "skip"
        ? 0
        : revision.missedPolicy === "coalesce-latest"
          ? 1
          : SCHEDULE_CATCHUP_CREATE_CAP + 1,
    );
    const window = planMissedWindow(
      newest,
      revision.missedPolicy,
      SCHEDULE_CATCHUP_CREATE_CAP,
    );
    if (window.hitCap) {
      summary.capped++;
      this.log("catchup-capped", {
        schedule: schedule.id,
        cap: SCHEDULE_CATCHUP_CREATE_CAP,
      });
    }

    /**
     * Reserve the covering occurrence before any row points at it.
     *
     * The cursor deliberately stays put: occurrence accounting still advances oldest
     * first below. If the process dies now, recovery can finish this durable reservation,
     * and every coalesced row already names an occurrence that survives the restart.
     */
    let cover: ScheduleOccurrence | null = null;
    const firstCreatingAt = window.firstCreatingAt;
    if (firstCreatingAt !== null && firstPage[0]! < firstCreatingAt) {
      const blocking = store.findActiveTaskForSchedule(schedule.id)?.id ?? null;
      const overlap = decideOverlap(revision.overlapPolicy, blocking);
      const decisionKind = overlap.decisionKind;
      const coverClaim = store.claimOccurrence({
        occurrenceId: this.uuid(),
        scheduleId: schedule.id,
        scheduleRevision: revision.revision,
        scheduledFor: firstCreatingAt,
        triggerKind: "scheduled",
        decisionKind,
        taskId: decisionKind === "create_task" ? this.uuid() : null,
        coveredById: null,
        blockingTaskId: overlap.blockingTaskId,
        claimedAt: now,
        delayMs: Math.max(0, now - firstCreatingAt),
        advanceCursor: false,
        nextRunAt: this.recurrence.nextAfter(
          revision.expression,
          revision.timezone,
          firstCreatingAt,
        ),
      });
      if (coverClaim.outcome === "schedule_changed") {
        summary.lost++;
        return;
      }
      cover = coverClaim.occurrence;
    }

    // Tasks this pass has already filed. Read before the DB for the `skip-active` check
    // because it is the authority on what THIS tick did, whatever a query may or may not
    // see of a write made moments ago.
    let createdThisTick: string | null = null;
    let durableStateChanged = cover !== null;
    let after = cursor - 1;
    let page = firstPage;

    while (page.length > 0) {
      const plan = planMissedPage(page, window);
      for (const entry of plan) {
        summary.due++;
        const delayMs = Math.max(0, now - entry.at);
        if (delayMs > summary.maxDelayMs) summary.maxDelayMs = delayMs;

        const covering =
          cover !== null && entry.at === cover.scheduledFor ? cover : null;
        const isCover = covering !== null;
        const overlap =
          entry.decisionKind === "create_task" && !isCover
            ? decideOverlap(
                revision.overlapPolicy,
                createdThisTick ??
                  store.findActiveTaskForSchedule(schedule.id)?.id ??
                  null,
              )
            : null;
        const decisionKind = isCover
          ? covering.decisionKind
          : overlap
            ? overlap.decisionKind
            : entry.decisionKind;
        if (decisionKind === null) {
          summary.failed++;
          continue;
        }

        const claim = store.claimOccurrence({
          occurrenceId: isCover ? covering.id : this.uuid(),
          scheduleId: schedule.id,
          scheduleRevision: revision.revision,
          scheduledFor: entry.at,
          triggerKind: "scheduled",
          decisionKind,
          taskId:
            isCover && covering.taskId !== null
              ? covering.taskId
              : decisionKind === "create_task"
                ? this.uuid()
                : null,
          coveredById:
            entry.coveredByAt !== null &&
            cover?.scheduledFor === entry.coveredByAt
              ? cover.id
              : null,
          blockingTaskId:
            isCover ? covering.blockingTaskId : (overlap?.blockingTaskId ?? null),
          claimedAt: now,
          delayMs,
          // The cursor moves with each oldest-first claim. Pages bound allocation, but
          // one catch-up-wide policy boundary survives across every page.
          advanceCursor: true,
          nextRunAt: this.recurrence.nextAfter(
            revision.expression,
            revision.timezone,
            entry.at,
          ),
        });

        if (claim.outcome === "schedule_changed") {
          // Archived, paused, or edited under us. Stop: every later instant in this plan
          // was decided under a revision that is no longer in force.
          summary.lost++;
          this.log("schedule-changed", { schedule: schedule.id, at: entry.at });
          if (durableStateChanged) {
            const latest = store.getSchedule(schedule.id, this.now());
            if (latest) this.notifySchedule(latest);
          }
          return;
        }
        durableStateChanged = true;
        if (claim.outcome === "already_exists" && !isCover) {
          summary.lost++;
          continue;
        }

        const occurrence = claim.occurrence;
        if (occurrence.status !== "claimed") {
          summary.lost++;
          continue;
        }
        const settled = await this.settle(
          occurrence,
          revision,
          { decisionKind: occurrence.decisionKind ?? decisionKind },
          now,
        );
        count(summary, settled.status);
        if (settled.status === "created" && settled.taskId)
          createdThisTick = settled.taskId;
      }

      const last = page[page.length - 1]!;
      if (last <= after || page.length < SCHEDULE_BETWEEN_MAX) break;
      after = last;
      page = this.recurrence.between(
        revision.expression,
        revision.timezone,
        after,
        now,
        SCHEDULE_BETWEEN_MAX,
      );
    }

    const latestSchedule = store.getSchedule(schedule.id, this.now());
    if (latestSchedule) this.notifySchedule(latestSchedule);
  }

  /**
   * Read only the newest policy boundary, whatever the catch-up's total length.
   *
   * This intentionally uses the same forward evaluator as accounting: cron-parser's
   * reverse iterator chooses different instants around DST folds and gaps. A ring of at
   * most 51 instants keeps allocation bounded while pages walk to the end.
   */
  private newestDueInstants(
    revision: RunnableScheduleRevision,
    cursor: number,
    now: number,
    limit: number,
  ): number[] {
    const newest: number[] = [];
    if (limit <= 0) return newest;
    let after = cursor - 1;
    while (true) {
      const page = this.recurrence.between(
        revision.expression,
        revision.timezone,
        after,
        now,
        SCHEDULE_BETWEEN_MAX,
      );
      if (page.length === 0) break;
      for (const at of page) {
        newest.push(at);
        if (newest.length > limit) newest.shift();
      }
      const last = page[page.length - 1]!;
      if (last <= after || page.length < SCHEDULE_BETWEEN_MAX) break;
      after = last;
    }
    return newest.reverse();
  }

  /**
   * A due cursor that enumerates nothing: move it, or admit there is no next run.
   *
   * See `repairScheduleCursor` for how this happens at all. Doing nothing is the failure
   * mode worth avoiding - a schedule permanently due, filing nothing, with `overdue` on
   * the card and no explanation of why the run never comes.
   */
  private repairStuckCursor(
    schedule: MissionSchedule,
    revision: RunnableScheduleRevision,
    cursor: number,
    now: number,
  ): void {
    const next = this.recurrence.nextAfter(
      revision.expression,
      revision.timezone,
      now,
    );
    if (next === cursor) return;
    const moved = store.repairScheduleCursor(schedule.id, cursor, next, now);
    if (!moved) return;
    this.log("cursor-repaired", {
      schedule: schedule.id,
      from: cursor,
      to: next,
    });
    const after = store.getSchedule(schedule.id, now);
    if (after) this.notifySchedule(after);
  }

  /**
   * Close a won claim: do the work it reserved, then write its terminal row.
   *
   * The one place a task is created, shared by the tick, Run now and recovery, so all
   * three get the same repository revalidation, the same failure text and the same
   * ordering. That ordering is the second half of exactly-once: the task row is durable
   * BEFORE the occurrence says `created`, so a crash in between leaves a claimed
   * occurrence whose preallocated id already names a real task - which recovery reads as
   * "nothing to do but close this", not as "file it again".
   */
  private async settle(
    occurrence: ScheduleOccurrence,
    revision: RunnableScheduleRevision,
    decision: { decisionKind: ScheduleDecisionKind },
    at: number,
  ): Promise<ScheduleOccurrence> {
    if (decision.decisionKind !== "create_task") {
      const status = terminalStatusFor(decision.decisionKind);
      return (
        store.finishOccurrence({ id: occurrence.id, status, finishedAt: at }) ??
        occurrence
      );
    }

    const taskId = occurrence.taskId;
    if (!taskId) {
      return this.fail(occurrence, "the reservation carried no task id", at);
    }

    // Revalidated at FIRE time, not trusted from save time: a repository can be moved,
    // renamed or deleted between the two, and a task rooted in a directory that is nobody's
    // repo is unschedulable the moment it lands. A failed occurrence says so on the card;
    // a doomed task says nothing until somebody tries to dispatch it.
    const repo = await this.resolveRepoRoot(revision.template.repoRoot);
    if (!repo.ok) return this.fail(occurrence, repo.error, at);

    const schedule = store.getSchedule(occurrence.scheduleId, this.now());
    if (!schedule || schedule.archivedAt !== null) {
      return (
        store.finishOccurrence({
          id: occurrence.id,
          status: "cancelled",
          finishedAt: this.now(),
        }) ?? occurrence
      );
    }

    try {
      const task = this.tasks.create(
        {
          repoRoot: repo.repoRoot,
          intent: revision.template.intent,
          title: revision.template.title,
          kind: revision.template.kind,
          // Omitted rather than passed as null when the template inherits: `create` reads an
          // ABSENT agent as "resolve from the kind", and `tasks.agent` is NOT NULL, so there
          // is no null to hand it. A run therefore takes whatever the kind's row says at the
          // moment it fires, not what it said when the mission was written.
          ...(revision.template.agent !== null ? { agent: revision.template.agent } : {}),
          priority: revision.template.priority,
          labels: revision.template.labels,
          ...(revision.template.model !== null
            ? { model: revision.template.model }
            : {}),
          ...(revision.template.effort !== null
            ? { effort: revision.template.effort }
            : {}),
          // A schedule files work; it never launches it. See the class comment.
          backlog: true,
        },
        {
          id: taskId,
          schedule: {
            scheduleId: occurrence.scheduleId,
            scheduleOccurrenceId: occurrence.id,
            scheduledFor: occurrence.scheduledFor,
          },
        },
      );
      return (
        store.finishOccurrence({
          id: occurrence.id,
          status: "created",
          finishedAt: this.now(),
          taskId: task.id,
        }) ?? occurrence
      );
    } catch (err) {
      return this.fail(occurrence, describe(err), at);
    }
  }

  private fail(
    occurrence: ScheduleOccurrence,
    error: string,
    at: number,
  ): ScheduleOccurrence {
    this.log("occurrence-failed", {
      schedule: occurrence.scheduleId,
      occurrence: occurrence.id,
      error,
    });
    return (
      store.finishOccurrence({
        id: occurrence.id,
        status: "failed",
        finishedAt: at,
        error,
      }) ?? occurrence
    );
  }

  // ---- recovery ----

  /**
   * Finish what a dead process reserved.
   *
   * The crash window this closes is the gap between `claimOccurrence` returning and
   * `finishOccurrence` being called, and it has two halves that look identical on disk -
   * a `claimed` row - and need opposite treatment. Which half you are in is answered by
   * ONE question: does a task with the preallocated id exist? The claim wrote that id
   * durably before the task was attempted, so the answer is always available and never a
   * guess.
   *
   * Everything acted on here comes off the occurrence row: the decision, the revision, the
   * instant, the reserved id. The schedule's CURRENT settings are deliberately not
   * consulted - an operator who edited the cadence overnight has not thereby changed what
   * last night's run was supposed to be, and recomputing policy from today's revision
   * would silently rewrite history to match.
   *
   * `scope` is "open" only at startup, where every reservation on disk belongs to a
   * process that is gone - the port bind means there is exactly one daemon. During
   * ordinary ticks it is "stale", so a reservation another call is holding right now (a
   * Run now mid-flight) is left alone.
   */
  async recover(
    now = this.now(),
    scope: "open" | "stale" = "stale",
  ): Promise<ScheduleRecoverySummary> {
    const summary = emptyRecovery();
    const affectedScheduleIds = new Set<string>();
    const claims =
      scope === "open" ? store.listOpenClaims() : store.listStaleClaims(now);
    for (const occurrence of claims) {
      summary.claims++;
      try {
        const wrote = await this.withScheduleLock(occurrence.scheduleId, async () => {
          const current = store.getOccurrence(occurrence.id);
          if (!current || current.status !== "claimed") {
            summary.alreadySettled++;
            return false;
          }
          return this.recoverOne(current, now, summary);
        });
        if (wrote) affectedScheduleIds.add(occurrence.scheduleId);
      } catch (err) {
        summary.failed++;
        this.log("recovery-error", {
          occurrence: occurrence.id,
          error: describe(err),
        });
      }
    }
    for (const scheduleId of affectedScheduleIds) {
      const schedule = store.getSchedule(scheduleId, now);
      if (schedule) this.notifySchedule(schedule);
    }
    if (summary.claims > 0) {
      this.log("recovered", {
        claims: summary.claims,
        beforeTask: summary.recoveredBeforeTask,
        afterTask: summary.recoveredAfterTask,
        terminal: summary.finishedTerminal,
        alreadySettled: summary.alreadySettled,
        cancelled: summary.cancelled,
        failed: summary.failed,
        unreadable: summary.unreadable,
      });
    }
    return summary;
  }

  private async recoverOne(
    occurrence: ScheduleOccurrence,
    now: number,
    summary: ScheduleRecoverySummary,
  ): Promise<boolean> {
    if (occurrence.decisionKind === null) {
      // A decision this build has never heard of. There is no safe repair: finishing it
      // would invent an outcome, and acting on it would act on a policy we cannot read.
      // Left claimed, which is what `stale-claim` health is for.
      summary.unreadable++;
      return false;
    }

    if (occurrence.decisionKind !== "create_task") {
      const done = store.finishOccurrence({
        id: occurrence.id,
        status: terminalStatusFor(occurrence.decisionKind),
        finishedAt: now,
      });
      if (done) summary.finishedTerminal++;
      return done !== null;
    }

    const taskId = occurrence.taskId;
    if (!taskId) {
      summary.failed++;
      return (
        this.fail(occurrence, "the reservation carried no task id", now).status === "failed"
      );
    }

    const existing = getDurableTask(taskId);
    if (existing) {
      if (
        existing.scheduleId !== occurrence.scheduleId ||
        existing.scheduleOccurrenceId !== occurrence.id ||
        existing.scheduledFor !== occurrence.scheduledFor
      ) {
        // The reserved id belongs to somebody else's task. Not a retry - corruption - and
        // the task is left exactly as it is.
        summary.failed++;
        this.fail(
          occurrence,
          `task ${taskId} exists but was filed by something else`,
          now,
        );
        return true;
      }
      // The crash landed after the task was persisted. Nothing to create; close the row.
      store.finishOccurrence({
        id: occurrence.id,
        status: "created",
        finishedAt: now,
        taskId: existing.id,
      });
      summary.recoveredAfterTask++;
      return true;
    }

    const schedule = store.getSchedule(occurrence.scheduleId, now);
    const archived = schedule === null || schedule.archivedAt !== null;
    if (archived) {
      // Archived before the work existed, so it never will. `cancelled` says that, where
      // `failed` would claim something went wrong.
      store.finishOccurrence({
        id: occurrence.id,
        status: "cancelled",
        finishedAt: now,
      });
      summary.cancelled++;
      return true;
    }

    // The revision AS CLAIMED, never the schedule's current one.
    const revision = store.revisionAt(
      occurrence.scheduleId,
      occurrence.scheduleRevision,
    );
    if (!revision || !revisionIsRunnable(revision)) {
      summary.failed++;
      this.fail(
        occurrence,
        "the settings this run was claimed under cannot be read",
        now,
      );
      return true;
    }

    const settled = await this.settle(
      occurrence,
      revision,
      { decisionKind: "create_task" },
      now,
    );
    if (settled.status === "created") summary.recoveredBeforeTask++;
    else if (settled.status === "cancelled") summary.cancelled++;
    else summary.failed++;
    return true;
  }

  private notifySchedule(schedule: MissionSchedule): void {
    if (schedule.archivedAt === null) this.notifier.upsert(schedule);
    else this.notifier.remove(schedule.id);
  }

  /**
   * Serialize the decision, claim, and task persistence for one schedule.
   *
   * The daemon is the only database writer, but Run now and the scheduler loop are still
   * concurrent promises in that process. Without this critical section both can observe
   * no active task under skip-active, reserve work, and file it after an awaited repo check.
   */
  private async withScheduleLock<T>(
    scheduleId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operationTails.get(scheduleId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.operationTails.set(scheduleId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(scheduleId) === tail)
        this.operationTails.delete(scheduleId);
    }
  }
}

// ---- helpers ----

function refuse(
  field: ScheduleValidationError["field"],
  message: string,
): { ok: false; error: ScheduleValidationError } {
  return { ok: false, error: { field, message } };
}

function count(
  summary: ScheduleTickSummary,
  status: ScheduleOccurrence["status"],
): void {
  switch (status) {
    case "created":
      summary.created++;
      break;
    case "coalesced":
      summary.coalesced++;
      break;
    case "skipped_policy":
      summary.skippedPolicy++;
      break;
    case "skipped_overlap":
      summary.skippedOverlap++;
      break;
    case "failed":
      summary.failed++;
      break;
    default:
      break;
  }
}

/**
 * One operator-readable sentence out of a thrown anything.
 *
 * A task-id collision gets said in full: it is the one failure here that means the
 * database disagrees with itself, and a generic "create failed" would leave whoever reads
 * the occurrence with nothing to go on.
 */
function describe(err: unknown): string {
  if (err instanceof TaskIdCollisionError)
    return `task id collision: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
