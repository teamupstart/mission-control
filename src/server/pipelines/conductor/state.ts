import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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

export interface EngineerRunMarkerReading {
  schemaVersion: 1;
  engineerRunId: string;
  repoRoot: string;
  planSlug: string;
  branch: string;
}

/** Corroborating identity written inside an Engineer authoring worktree. */
function engineerRunMarker(value: unknown): EngineerRunMarkerReading | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.engineerRunId !== "string" ||
    typeof record.repoRoot !== "string" ||
    typeof record.planSlug !== "string" ||
    typeof record.branch !== "string"
  ) return null;
  return {
    schemaVersion: 1,
    engineerRunId: record.engineerRunId,
    repoRoot: record.repoRoot,
    planSlug: record.planSlug,
    branch: record.branch,
  };
}

export function readEngineerRunMarker(worktree: string): EngineerRunMarkerReading | null {
  return engineerRunMarker(readJsonFile(join(worktree, ".pipeline", "engineer-run.json")));
}

/** Async sibling for request paths that must not block the daemon event loop. */
export async function readEngineerRunMarkerAsync(
  worktree: string,
): Promise<EngineerRunMarkerReading | null> {
  try {
    const file = join(worktree, ".pipeline", "engineer-run.json");
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) return null;
    return engineerRunMarker(JSON.parse(await readFile(file, "utf8")));
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

// ---- .docs/shipped/<slug>.md, the engine's own per-feature cost record --------------------

/**
 * What one feature cost, as the engine wrote it down when the feature shipped.
 *
 * Every field is the engine's. Mission Control does NOT re-derive this from the event
 * ledger, and the temptation to is worth naming: the engine's rollup counts each dispatch
 * once by matching a `provider_attempt` against the `step_completed` that followed it, and
 * a second implementation of that matching - incremental, in another program, over a file
 * being appended to - is a copy of the engine's arithmetic that would quietly disagree with
 * it. Reading the answer the engine committed is the same posture the rest of this file
 * takes toward `conduct-state.json`: the engine decides, this reads.
 *
 * The trade is that only a SHIPPED feature has one, so a run still in flight contributes
 * nothing to the spend ledger. That matches how the ledger already treats the app's own
 * headless runs - a row appears when a run finishes - and the run detail keeps showing the
 * live figure from the event tail in the meantime.
 */
export interface ShippedCostReading {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * What the engine priced this feature at, or NULL when its record does not say.
   *
   * Nullable rather than defaulted to zero, and it is the one field here where the
   * difference is a lie rather than a rounding: every other missing line is a count, where
   * absent and zero mean the same thing, and this one is a price, where they could not mean
   * less alike. A record with real token counts and no `cost_usd` - an engine release that
   * predates the line, a rollup that could price nothing, a value that did not parse - would
   * otherwise reach the ledger as an exact $0.00 for work that certainly cost something.
   */
  costUsd: number | null;
  dispatches: number;
  /**
   * Dispatches the engine could not meter at all - no usage record of any kind.
   *
   * Read because it is half of "is this cost figure complete". The other half is
   * `costUnmetered`.
   */
  unmetered: number;
  /**
   * Dispatches that reported TOKENS but no cost.
   *
   * The field that decides whether the dollar figure may be presented as a total. The
   * engine's own one-line finish summary omits it, which is why the record is read here
   * rather than the event: a cost summed over the priced dispatches of a partly-unpriced
   * feature is a subtotal presented as a total, and the ledger's rule everywhere else is to
   * refuse that rather than show it.
   */
  costUnmetered: number;
  /** When the record was last written, in epoch ms - the ledger row's `ts`. */
  writtenAt: number;
}

/** The heading the cost block opens with, in the engine's own rendering. */
const COST_HEADING = "## Cost";

/**
 * A non-negative finite number from one of the block's scalar lines, or null.
 *
 * An EMPTY value is null rather than zero, which `Number("")` is not: a key the engine wrote
 * with nothing after it is a line that failed to render, and `cost_usd:` with no figure after
 * it is the difference between "this cost nothing" and "this record does not say".
 */
function costNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * One feature's committed cost record, or null when there is not a readable one.
 *
 * The record lives in the FEATURE'S WORKTREE (`<worktree>/.docs/shipped/<slug>.md`), because
 * the engine writes and commits it on the feature branch before the pull request opens - it
 * reaches the main checkout only when that request merges, by which time the worktree is
 * usually gone and the run is no longer projected.
 *
 * Total, like every reader here. A feature that has not shipped, a record with no cost block
 * (the engine writes one without when its rollup failed), and a block whose numbers are
 * missing all answer null - which the caller reads as "no cost to record yet", never as an
 * error. `input` and `output` are required because a block missing both is not a cost
 * reading; the rest default to zero, so a record from an engine that predates one of these
 * lines still yields the figures it does carry.
 */
export function readShippedCost(worktree: string, slug: string): ShippedCostReading | null {
  const path = join(worktree, ".docs", "shipped", `${slug}.md`);
  const text = readSmallFile(path);
  if (text === null) return null;
  const at = text.indexOf(COST_HEADING);
  if (at < 0) return null;
  // Bounded at the next heading, so the `## Time` block the engine appends after this one
  // cannot contribute a line to it. Both blocks use bare `key: value`, and `state:` is not a
  // key this reads - but a block that stopped at end-of-file would start matching the moment
  // the engine appends a third section that happens to share a name.
  const body = text.slice(at + COST_HEADING.length);
  const end = body.indexOf("\n## ");
  const fields = new Map<string, string>();
  for (const line of (end < 0 ? body : body.slice(0, end)).split("\n")) {
    const split = line.indexOf(":");
    // Indented lines are the per-provider breakdown, which this does not read: the ledger
    // records what a FEATURE cost, and a provider split would be a second grouping nothing
    // on any surface asks for.
    if (split <= 0 || line.startsWith(" ")) continue;
    fields.set(line.slice(0, split).trim(), line.slice(split + 1));
  }

  const input = costNumber(fields.get("input"));
  const output = costNumber(fields.get("output"));
  if (input === null || output === null) return null;

  let writtenAt = Date.now();
  try {
    writtenAt = statSync(path).mtimeMs;
  } catch {
    // An unreadable stat on a file we have just read whole is not worth losing the reading
    // over; `now` puts the spend in today, which is when we learned of it.
  }

  // `unmetered: count: 3, duration_ms: 900` - the count is the first number on the line, and
  // the engine writes both halves of it on one line. Parsed by taking the leading integer of
  // the value rather than by splitting on the comma, so the trailing field can change.
  const countOf = (key: string): number => {
    const raw = fields.get(key);
    const match = raw?.match(/(\d+)/);
    return match ? Number(match[1]) : 0;
  };

  return {
    input,
    output,
    cacheRead: costNumber(fields.get("cache_read")) ?? 0,
    cacheWrite: costNumber(fields.get("cache_creation")) ?? 0,
    // Carried as null when the line is missing or unreadable. See the field's own note: the
    // zero every other line falls back to would be a claim about money nobody made.
    costUsd: costNumber(fields.get("cost_usd")),
    dispatches: costNumber(fields.get("dispatches")) ?? 0,
    unmetered: countOf("unmetered"),
    costUnmetered: countOf("cost_unmetered"),
    writtenAt,
  };
}

// ---- worktree enumeration ---------------------------------------------------------------

/** One feature's worktree: the engine's slug, and where it lives. */
export interface WorktreeReading {
  slug: string;
  path: string;
}

/** One repository's worktrees, and whether the cap cut any of them off. */
export interface WorktreesReading {
  worktrees: WorktreeReading[];
  truncated: boolean;
}

/**
 * Every feature worktree in one repository, or null when the directory could not be listed.
 *
 * The slug IS the directory name, which is the engine's plan stem and its canonical key
 * across the backlog, the state file and the park namespace. Sorted so a pass produces a
 * stable order, and capped so a repository with a runaway `.worktrees/` cannot make one
 * pass unbounded.
 *
 * A directory with no execution manifest is skipped. Engineer authoring worktrees may carry
 * `.pipeline/` for lifecycle markers and verification artifacts, but only
 * `conduct-state.json` establishes that the implementation daemon owns a run there.
 *
 * NULL AND EMPTY ARE DIFFERENT ANSWERS, and this is the one reader where the difference is
 * expensive. An empty list means the engine is driving nothing here, and the caller's
 * response is to retire every run it was projecting. A `null` means we could not look, and
 * the same response would delete a repository's whole projection over a transient `EACCES` -
 * the Inspector's rule that "a `gh` that errored is not an answer", applied to a directory.
 *
 * `truncated` is reported rather than inferred from the length for the same reason. A
 * caller comparing `worktrees.length` against the cap cannot tell a repository that was cut
 * off from one sitting at exactly the cap with nothing dropped - and since a truncated read
 * is an incomplete one, that caller stops retiring stale runs. A repository with exactly
 * 200 pipelines would have stopped pruning forever.
 */
export function readWorktrees(
  repoRoot: string,
  worktreesDir: string,
): WorktreesReading | null {
  const base = join(repoRoot, worktreesDir);
  // Absent is a real answer: a repository the engine has never cut a worktree in.
  if (!exists(base)) return { worktrees: [], truncated: false };
  let entries: string[];
  try {
    entries = readdirSync(base).sort();
  } catch {
    return null;
  }
  const out: WorktreeReading[] = [];
  let truncated = false;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const path = join(base, entry);
    if (!exists(join(path, ".pipeline", "conduct-state.json"))) continue;
    // Counted only against entries that ARE pipelines, and only after one has been cut.
    // Testing the cap before the `.pipeline` filter would blame the engine's own
    // spec-authoring and autoresolve worktrees for a truncation they are not part of.
    if (out.length >= MAX_RUNS_PER_REPO) {
      truncated = true;
      break;
    }
    out.push({ slug: entry, path });
  }
  return { worktrees: out, truncated };
}
