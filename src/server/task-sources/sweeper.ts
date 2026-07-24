import type { SweepReport, TaskSourceInstance, TaskSourceStatus } from "@shared/task-source.ts";
import { countTaskSourceSeen } from "../db.ts";
import { envVar } from "../config.ts";
import { unref } from "../util/timers.ts";
import type { TaskManager } from "../tasks.ts";
import { getTaskSourcesConfig } from "./config.ts";
import { ingestSweep } from "./ingest.ts";
import { preflightSource, sweepSource } from "./index.ts";

// Drives the configured task sources on their own schedules, and hands what they return
// to ingest.
//
// It runs IN THE DAEMON rather than in the Foreman worker, for the reason the Inspector
// does: ingest writes to the DB, and the daemon is the only writer. The port bind is the
// mutex - two daemons cannot both hold :7317 - so there is exactly one sweeper.
//
// It does not need the gate the skills reload loop needs (`settledIdle` + a pane read +
// `withPaneLock`; see "The daemon is no longer strictly reactive" in the README) because
// it never types. It writes backlog rows and nothing else: no worktree is cut, no
// keystroke is sent, and the worst a broken source can do is file junk into a list a
// human then reads and deletes. The moment a source can type, that whole argument has to
// be redone.

/** How often the loop wakes to ask which sources are due. Not the sweep interval. */
const TICK_MS = Math.max(5_000, Number(envVar("TASK_SOURCE_TICK_MS") ?? 30_000));

/** Hard cap on one sweep, so a hung source cannot wedge its own schedule forever. */
const SWEEP_TIMEOUT_MS = Math.max(5_000, Number(envVar("TASK_SOURCE_TIMEOUT_MS") ?? 60_000));

/**
 * What each source's last sweep did, in memory.
 *
 * Not persisted, on purpose: a restart simply sweeps everything once more, and ingest
 * de-duplicates that pass down to nothing. Persisting it would buy a marginally prettier
 * panel and a schema to migrate.
 */
interface Entry {
  lastSweepAt: number | null;
  lastError: string | null;
  lastFiled: number;
  /** Last configured state observed by this process; status is process-local too. */
  enabled: boolean | null;
  /** Invalidates a sweep result that started before the source was paused. */
  healthGeneration: number;
  /** In flight, so the tick and a "Sweep now" click cannot double-file. */
  sweeping: boolean;
}
const entries = new Map<string, Entry>();

function entryFor(id: string): Entry {
  let e = entries.get(id);
  if (!e) {
    e = {
      lastSweepAt: null,
      lastError: null,
      lastFiled: 0,
      enabled: null,
      healthGeneration: 0,
      sweeping: false,
    };
    entries.set(id, e);
  }
  return e;
}

/** A paused source has no current health until it is swept in that state. */
function observeEnabled(inst: TaskSourceInstance): Entry {
  const e = entryFor(inst.id);
  if (e.enabled === true && !inst.enabled) {
    e.healthGeneration += 1;
    e.lastSweepAt = null;
    e.lastError = null;
    e.lastFiled = 0;
  }
  e.enabled = inst.enabled;
  return e;
}

/** Invalidate immediately at the config write, before a quick re-enable can hide it. */
export function noteTaskSourceConfigChange(
  before: TaskSourceInstance[],
  next: TaskSourceInstance[],
): void {
  const wasEnabled = new Map(before.map((s) => [s.id, s.enabled]));
  for (const src of next) {
    if (wasEnabled.get(src.id) === true && !src.enabled) observeEnabled(src);
  }
}

/** Status for every configured source, for the settings panel. */
export function taskSourceStatuses(sources: TaskSourceInstance[]): TaskSourceStatus[] {
  return sources.map((s) => {
    const e = observeEnabled(s);
    return {
      sourceId: s.id,
      lastSweepAt: e.lastSweepAt,
      lastError: e.lastError,
      lastFiled: e.lastFiled,
      seenCount: countTaskSourceSeen(s.id),
      sweeping: e.sweeping,
    };
  });
}

/** The context one sweep is lent: no registry, no DB, and a signal it can be cut off by. */
function contextFor(inst: TaskSourceInstance, signal: AbortSignal): {
  sourceId: string;
  repoRoot: string;
  signal: AbortSignal;
} {
  return { sourceId: inst.id, repoRoot: inst.repoRoot, signal };
}

/**
 * Sweep one source now and file what it returns.
 *
 * Shared by the loop and by the panel's "Sweep now", so a manual sweep is the identical
 * operation - including the in-flight guard, without which the two could file the same
 * item twice from two concurrent reads of the seen set.
 */
export async function sweepOnce(
  inst: TaskSourceInstance,
  tasks: TaskManager,
): Promise<SweepReport> {
  const entry = observeEnabled(inst);
  if (entry.sweeping) {
    return {
      sourceId: inst.id,
      filed: 0,
      alreadySeen: 0,
      overCap: 0,
      refused: [],
      error: "a sweep of this source is already running",
    };
  }
  entry.sweeping = true;
  const healthGeneration = entry.healthGeneration;
  const controller = new AbortController();
  const timer = unref(setTimeout(() => controller.abort(), SWEEP_TIMEOUT_MS));
  try {
    const result = await sweepSource(inst, contextFor(inst, controller.signal));
    const report = await ingestSweep(inst, result, tasks);
    if (entry.healthGeneration === healthGeneration) {
      entry.lastSweepAt = Date.now();
      entry.lastFiled = report.filed;
      // A per-candidate refusal is worth surfacing too: with `error` null and rows refused,
      // the panel would otherwise report a clean sweep that filed nothing.
      entry.lastError =
        report.error ?? (report.refused.length > 0 ? report.refused.join("; ") : null);
    }
    return report;
  } catch (err) {
    if (entry.healthGeneration === healthGeneration) {
      entry.lastError = err instanceof Error ? err.message : String(err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    entry.sweeping = false;
  }
}

/** Ask a source whether it could run at all, without filing anything. */
export async function preflightOnce(inst: TaskSourceInstance): Promise<string | null> {
  const controller = new AbortController();
  const timer = unref(setTimeout(() => controller.abort(), SWEEP_TIMEOUT_MS));
  try {
    return await preflightSource(inst, contextFor(inst, controller.signal));
  } finally {
    clearTimeout(timer);
  }
}

/** Whether this source is due, given when it last swept. A never-swept source is due. */
function due(inst: TaskSourceInstance, now: number): boolean {
  const last = entryFor(inst.id).lastSweepAt;
  return last === null || now - last >= inst.intervalMs;
}

/**
 * Drive the configured sources on an interval.
 *
 * The canonical loop shape (`discovery/poller.ts`): a self-rescheduling `setTimeout`
 * rather than `setInterval`, so ticks cannot overlap; `unref()` so a pending tick never
 * holds the process open; try/catch INSIDE the tick so one bad sweep cannot kill the
 * loop; and a returned stop closure the daemon's `shutdown()` calls.
 *
 * Sources are swept one at a time rather than in parallel. Each spends a subprocess and
 * a network round trip on somebody else's API, and nothing here is latency-sensitive -
 * the whole feature is measured in fifteen-minute intervals.
 */
export function startTaskSourceSweeper(
  tasks: TaskManager,
  /**
   * Called after each sweep the loop runs, so the caller can push the settings status the
   * dots read (a sweep records or clears `lastError`, which is the red dot's fact). Passed
   * in rather than reached for because this module never touches the registry or the DB -
   * it files backlog rows and stops there.
   */
  onSwept?: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const now = Date.now();
      // Re-read every tick rather than at construction, so enabling a source or changing
      // its interval takes effect without a restart - the same discipline the dispatcher
      // holds for `harnesses.ts`.
      for (const inst of getTaskSourcesConfig().sources) {
        if (stopped) break;
        observeEnabled(inst);
        if (!inst.enabled || !due(inst, now)) continue;
        try {
          await sweepOnce(inst, tasks);
        } catch (err) {
          console.error(`[task-source] ${inst.id} sweep failed:`, err);
        } finally {
          // Fires whether the sweep filed, failed, or refused: each outcome sets this
          // source's `lastError` to a value or null, so the failing count may have moved.
          onSwept?.();
        }
      }
    } catch (err) {
      console.error("[task-source] sweep tick failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, TICK_MS));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
