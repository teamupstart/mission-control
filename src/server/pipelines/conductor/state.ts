import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  isPipelineHaltClass,
  isPipelineStepState,
  type PipelineHaltClass,
  type PipelineStepState,
  type PipelineTier,
  type PipelineTrack,
} from "@shared/pipeline.ts";

// Readers for ai-conductor's own on-disk state. Every function here is TOTAL: a missing,
// truncated, or malformed input degrades to nulls and empty collections, and nothing in
// this file throws out of the module.
//
// That is not defensive habit. These files are written by another program, concurrently,
// with atomic renames - so a reader that arrives mid-write meets a path that has just
// vanished, and one that arrives after a version bump meets a shape it has never seen. The
// engine's own reader is allowed to treat a corrupt `conduct-state.json` as a hard error
// because it is about to act on it. This one is only going to DRAW it, and the correct
// response to "cannot read" is a run that says so, never a daemon that stops projecting.
//
// Layout, verified against ai-conductor `8b51392d`:
//
//   <repoRoot>/.worktrees/<slug>/          one feature's worktree, slug = the plan stem
//   <repoRoot>/.worktrees/<slug>/.pipeline/conduct-state.json
//   <repoRoot>/.worktrees/<slug>/.pipeline/gates/<step>.json
//   <repoRoot>/.worktrees/<slug>/.pipeline/HALT , HALT.class , DONE
//   <repoRoot>/.worktrees/<slug>/.pipeline/events.jsonl
//   <repoRoot>/.daemon/                    per REPOSITORY, not per worktree
//
// That last line is a correction to the source plan, which filed `.daemon/` under "per
// worktree". It is resolved against the MAIN checkout root by the engine itself (through
// `git rev-parse --git-common-dir`), so a worktree and its repository share one park and
// grant namespace - which is why `parked/` and `processed/` are read once per repository
// here and indexed by slug, rather than once per run.

/** Longest state file this reader will take. Anything larger is not a state file. */
const MAX_STATE_BYTES = 2 * 1024 * 1024;

/** How many gate verdicts one run may contribute, so a runaway directory cannot wedge a pass. */
const MAX_GATES = 200;

/** How many worktrees one repository may contribute to a single pass. */
export const MAX_RUNS_PER_REPO = 200;

/** Read a small file as text, or null for anything that is not one. */
function readSmallFile(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Read a small file as JSON, or null. Malformed and absent are the same answer here. */
function readJsonFile(path: string): unknown {
  const text = readSmallFile(path);
  if (text === null || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Directory entries, or `[]` for a directory that is absent or unreadable. */
function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Whether a path exists at all, without distinguishing why it does not. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---- conduct-state.json ------------------------------------------------------------

/** What one worktree's `conduct-state.json` says, in this build's vocabulary. */
export interface ConductStateReading {
  /**
   * Step name to status, for every step the file mentions.
   *
   * The engine stores these as FLAT TOP-LEVEL KEYS beside `last_step` and `track`, not as
   * a nested map - a shape kept for compatibility with the original bash conductor. So
   * this reader distinguishes step keys from metadata keys by EXCLUSION: any key that is
   * not one of the engine's own metadata fields, and whose value is a string this build
   * recognises as a status, is a step. That direction is deliberate. Filtering by the
   * frozen step list instead would silently drop every step a newer engine added, which
   * is exactly the degradation the unknown-step rule exists to prevent.
   */
  steps: Map<string, PipelineStepState>;
  lastStep: string | null;
  tier: PipelineTier | null;
  track: PipelineTrack | null;
  prUrl: string | null;
  /** The engine's own `feature_status: 'complete'`. */
  complete: boolean;
  worktreeBranch: string | null;
  /** True when the file was there and parsed. False for absent, empty, or malformed. */
  read: boolean;
}

/**
 * Keys the engine stores beside the per-step statuses. Everything else in the object is a
 * candidate step name.
 *
 * Copied from `ConductState` in `src/conductor/src/types/state.ts` at `8b51392d`. A key
 * added by a newer engine and missing from this list is read as a step only if its VALUE
 * is one of the six status words, which is what keeps a new string field from appearing on
 * the strip as a phantom step.
 */
const CONDUCT_STATE_METADATA_KEYS = new Set([
  "feature_desc",
  "complexity_tier",
  "track",
  "bootstrap_mode",
  "run_started_at",
  "session_started_at",
  "last_step",
  "pr_url",
  "worktree_dir",
  "worktree_branch",
  "feature_status",
  "artifact_approvals",
  "build_routed_reason",
]);

/** An empty reading - what every failure in this file degrades to. */
function emptyConductState(): ConductStateReading {
  return {
    steps: new Map(),
    lastStep: null,
    tier: null,
    track: null,
    prUrl: null,
    complete: false,
    worktreeBranch: null,
    read: false,
  };
}

export function readConductState(worktree: string): ConductStateReading {
  const parsed = readJsonFile(join(worktree, ".pipeline", "conduct-state.json"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyConductState();
  }
  const record = parsed as Record<string, unknown>;
  const steps = new Map<string, PipelineStepState>();
  for (const [key, value] of Object.entries(record)) {
    if (CONDUCT_STATE_METADATA_KEYS.has(key)) continue;
    if (typeof value !== "string" || !isPipelineStepState(value)) continue;
    steps.set(key, value);
  }
  const tier = record.complexity_tier;
  const track = record.track;
  return {
    steps,
    lastStep: typeof record.last_step === "string" ? record.last_step : null,
    tier: tier === "S" || tier === "M" || tier === "L" ? tier : null,
    track: track === "product" || track === "technical" ? track : null,
    prUrl: typeof record.pr_url === "string" && record.pr_url !== "" ? record.pr_url : null,
    complete: record.feature_status === "complete",
    worktreeBranch:
      typeof record.worktree_branch === "string" && record.worktree_branch !== ""
        ? record.worktree_branch
        : null,
    read: true,
  };
}

// ---- gates/<step>.json ---------------------------------------------------------------

/** One gate's verdict, as the engine wrote it. */
export interface GateVerdictReading {
  step: string;
  satisfied: boolean;
  reason: string | null;
  checkedAt: number | null;
  /** Which step re-opened this gate, when a downstream kickback invalidated it. */
  kickbackFrom: string | null;
  /**
   * The verdict is a SKIP rather than evidence that passed.
   *
   * The engine writes a skipped step as `satisfied: true` with a `skipped: ` reason
   * prefix, so a surface that only read `satisfied` would draw a tier-S run as having
   * passed nine gates it never ran. This is that distinction, made once, here.
   */
  skipped: boolean;
}

/** The engine's own marker for a verdict that records a skip rather than a pass. */
const SKIP_VERDICT_PREFIX = "skipped: ";

export function readGateVerdicts(worktree: string): GateVerdictReading[] {
  const dir = join(worktree, ".pipeline", "gates");
  const out: GateVerdictReading[] = [];
  for (const entry of readdirSafe(dir).sort()) {
    if (!entry.endsWith(".json")) continue;
    if (out.length >= MAX_GATES) break;
    const parsed = readJsonFile(join(dir, entry));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    // The engine's own reader rejects a verdict whose `satisfied` is not a boolean, and so
    // does this one: a file mid-write is not a verdict, and defaulting it either way would
    // be inventing an answer to the question the gate exists to answer.
    if (typeof record.satisfied !== "boolean") continue;
    const reason = typeof record.reason === "string" ? record.reason : null;
    const kickback = record.kickback;
    const kickbackFrom =
      typeof kickback === "object" &&
      kickback !== null &&
      typeof (kickback as Record<string, unknown>).from === "string"
        ? ((kickback as Record<string, unknown>).from as string)
        : null;
    out.push({
      step: entry.slice(0, -".json".length),
      satisfied: record.satisfied,
      reason,
      checkedAt: typeof record.checkedAt === "number" ? record.checkedAt : null,
      kickbackFrom,
      skipped: reason !== null && reason.startsWith(SKIP_VERDICT_PREFIX),
    });
  }
  return out;
}

// ---- HALT / HALT.class / DONE ---------------------------------------------------------

/** Why a run stopped, when it did. */
export interface HaltReading {
  class: PipelineHaltClass;
  reason: string;
}

/**
 * The halt marker, or null for a run that has not halted.
 *
 * The reason is the marker's FIRST non-empty line, which is the same line the engine's own
 * dashboard surfaces, clamped so a stack trace pasted into the file cannot become the
 * chip's text. The class comes from the sidecar and degrades to `unclassified` for a
 * missing, unreadable, or unrecognised one - which is the honest answer, and the one the
 * engine's own reader gives.
 *
 * A halt is read from FILES rather than from the event ledger deliberately: the engine
 * does not persist its `loop_halt` event, so a ledger-only reader would never see a halt
 * at all. See `tail.ts` for what the ledger is good for instead.
 */
export function readHalt(worktree: string): HaltReading | null {
  const body = readSmallFile(join(worktree, ".pipeline", "HALT"));
  if (body === null) return null;
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  const raw = readSmallFile(join(worktree, ".pipeline", "HALT.class"))?.trim() ?? "";
  return {
    class: isPipelineHaltClass(raw) ? raw : "unclassified",
    reason: first.trim().slice(0, 400),
  };
}

/** Whether the engine wrote its converged marker for this run. */
export function readDone(worktree: string): boolean {
  return exists(join(worktree, ".pipeline", "DONE"));
}

// ---- .daemon/, per repository ----------------------------------------------------------

/** What one repository's `.daemon/` directory says, read once per pass. */
export interface DaemonReading {
  /** The pid in `daemon.pid`, or null when there is no readable pidfile. */
  pid: number | null;
  /** `.daemon/PAUSED` exists. Its body is informational; existence is the fact. */
  paused: boolean;
  /** Slugs with a `.daemon/parked/<slug>` marker. */
  parked: Set<string>;
  /** Slugs with a pending `.daemon/grants/<slug>.json`. */
  granted: Set<string>;
  /** Slugs the daemon recorded as shipped, with the pull request when it noted one. */
  processed: Map<string, { prUrl: string | null }>;
}

/** An empty reading - a repository with no `.daemon/` at all, which is the common case. */
function emptyDaemonReading(): DaemonReading {
  return { pid: null, paused: false, parked: new Set(), granted: new Set(), processed: new Map() };
}

/**
 * Whether a process id is alive, without touching it.
 *
 * `kill(pid, 0)` is a permission-and-existence probe that sends no signal. An `EPERM` means
 * the process exists and belongs to somebody else, which is still alive - so only `ESRCH`
 * counts as gone.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readDaemon(repoRoot: string): DaemonReading {
  const dir = join(repoRoot, ".daemon");
  if (!exists(dir)) return emptyDaemonReading();

  const pidRecord = readJsonFile(join(dir, "daemon.pid"));
  const pidValue =
    typeof pidRecord === "object" && pidRecord !== null
      ? (pidRecord as Record<string, unknown>).pid
      : null;
  const pid = typeof pidValue === "number" && Number.isInteger(pidValue) ? pidValue : null;

  const parked = new Set<string>();
  for (const entry of readdirSafe(join(dir, "parked"))) parked.add(entry);

  const granted = new Set<string>();
  for (const entry of readdirSafe(join(dir, "grants"))) {
    if (entry.endsWith(".json")) granted.add(entry.slice(0, -".json".length));
  }

  const processed = new Map<string, { prUrl: string | null }>();
  for (const entry of readdirSafe(join(dir, "processed"))) {
    if (!entry.endsWith(".json")) continue;
    const slug = entry.slice(0, -".json".length);
    const parsed = readJsonFile(join(dir, "processed", entry));
    const prUrl =
      typeof parsed === "object" && parsed !== null
        ? ((parsed as Record<string, unknown>).prUrl as unknown)
        : null;
    processed.set(slug, { prUrl: typeof prUrl === "string" && prUrl !== "" ? prUrl : null });
  }

  return {
    // A pidfile whose process is gone is a crashed daemon, which is "stopped" and not
    // "running" - the file outlives the process it names, so its presence proves nothing.
    pid: pid !== null && pidAlive(pid) ? pid : null,
    paused: exists(join(dir, "PAUSED")),
    parked,
    granted,
    processed,
  };
}

// ---- worktree enumeration ---------------------------------------------------------------

/** One feature's worktree: the engine's slug, and where it lives. */
export interface WorktreeReading {
  slug: string;
  path: string;
}

/**
 * Every feature worktree in one repository, or null when the directory could not be listed.
 *
 * The slug IS the directory name, which is the engine's plan stem and its canonical key
 * across the backlog, the state file and the park namespace. Sorted so a pass produces a
 * stable order, and capped so a repository with a runaway `.worktrees/` cannot make one
 * pass unbounded.
 *
 * A directory with no `.pipeline/` is skipped: the engine cuts spec-authoring worktrees
 * (`engineer-<slug>`) and autoresolve worktrees (`resolve-<slug>`) in the same place, and
 * neither is a pipeline run.
 *
 * NULL AND EMPTY ARE DIFFERENT ANSWERS, and this is the one reader where the difference is
 * expensive. An empty list means the engine is driving nothing here, and the caller's
 * response is to retire every run it was projecting. A `null` means we could not look, and
 * the same response would delete a repository's whole projection over a transient `EACCES` -
 * the Inspector's rule that "a `gh` that errored is not an answer", applied to a directory.
 */
export function readWorktrees(
  repoRoot: string,
  worktreesDir: string,
): WorktreeReading[] | null {
  const base = join(repoRoot, worktreesDir);
  // Absent is a real answer: a repository the engine has never cut a worktree in.
  if (!exists(base)) return [];
  let entries: string[];
  try {
    entries = readdirSync(base).sort();
  } catch {
    return null;
  }
  const out: WorktreeReading[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (out.length >= MAX_RUNS_PER_REPO) break;
    const path = join(base, entry);
    if (!exists(join(path, ".pipeline"))) continue;
    out.push({ slug: entry, path });
  }
  return out;
}
