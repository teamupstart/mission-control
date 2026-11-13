import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorktreeClaim, WorktreeClaimSeed } from "@shared/protocol.ts";
import type { WorktreeProvider } from "@shared/types.ts";
import { isWorktreeOwnerKind, type WorktreeOwnerKind } from "@shared/worktrees.ts";
import { cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";
import { WORKTREE_POOLS_DIR, envVar } from "../config.ts";
import { openDb } from "../db.ts";
import { run, unansweredOutcome } from "../util/exec.ts";
import { unref } from "../util/timers.ts";
import {
  worktreeRepositoryIdentity,
  type WorktreeRepositoryIdentity,
} from "../util/git.ts";
import {
  ClaimRegistry,
  claimEnvironment,
  claimFingerprint,
  claimVariableNames,
  describeClaimFailure,
  encodeClaimFailure,
  readTreeBlobs,
  redactClaimValues,
  runClaimStep,
  runClaimSteps,
  type ClaimEnvironment,
  type ClaimStepRequest,
  type ClaimStepResult,
  type RunningClaim,
  type TreeBlob,
  type WorktreeClaimWarning,
} from "./claim.ts";
import { MANUAL_PICKUP_WINDOW_MS, ManualAcquireRequests } from "./manual-requests.ts";
import {
  copyOnWriteClone,
  placeSeed,
  removeLeftoverStaging,
  seedStagingRoot,
  stageSeed,
  wipeSeedPaths,
  type CloneTree,
} from "./seed.ts";
import { resolveWorktreePolicy, type WorktreePolicy } from "./config.ts";
import {
  NativeWorktreeGit,
  type GitResult,
  type WorktreeGit,
  type WorktreeRegistration,
} from "./git.ts";
import { ensureWorktreePoolMarker, readWorktreePoolMarker } from "./marker.ts";
import { bothAttempts, OBSERVATION_RETRY_DELAY_MS, pauseFor } from "./observation-retry.ts";
import { taskOwner } from "./owners.ts";
import {
  inspectWorktreeOccupancy,
  pathContains,
  type WorktreeOccupancy,
} from "./occupancy.ts";
import {
  WORKTREE_SLOT_STATES,
  WorktreeStore,
  depsCutOff,
  isDepsWriteAhead,
  type WorktreePoolRow,
  type WorktreeSlotRow,
} from "./store.ts";

const SHA = /^[0-9a-f]{40}$/;
const MAX_OWNER_BYTES = 512;
const MAX_ERROR_BYTES = 2048;
const DEFAULT_SWEEP_MS = 300_000;
const MIN_SWEEP_MS = 30_000;
const MAX_SWEEP_MS = 604_800_000;
const STOPPING_REASON = "the daemon is stopping, so no dependency claim can start";
const STOPPED_REASON = "the daemon stopped during this slot's dependency claim, so nothing was granted";

// `warm` is maintenance, never a task: a seed source held while it is copied (and, with Warm,
// a slot being prepared ahead of time). Its key is the operation's own id, and the owner is
// referenced exactly while that operation runs in this daemon.
export type { WorktreeOwnerKind };
export interface WorktreeOwner {
  kind: WorktreeOwnerKind;
  key: string;
}

export interface NativeWorktreeLease {
  slotId: string;
  poolId: string;
  path: string;
  provider: Extract<WorktreeProvider, "mission">;
  leaseId: string;
  owner: WorktreeOwner;
  baseSha: string;
  slotVersion: number;
}

export interface WorktreeOwnerReference {
  slotId: string;
  leaseId: string;
  owner: WorktreeOwner;
}

export type WorktreeAcquireResult =
  | {
      outcome: "acquired";
      lease: NativeWorktreeLease;
      /**
       * Present only when the pool's dependency claim ran and failed. The lease is granted
       * anyway: a failed claim hands the slot over with this warning, never quarantines it.
       */
      claimWarning?: WorktreeClaimWarning;
      /**
       * The fingerprint paths of the claim that failed, beside `claimWarning` only. A check
       * decides who owns its failure by these, and reading them from the claim that actually
       * ran keeps a settings edit made meanwhile from changing the answer.
       */
      claimFingerprintPaths?: string[];
    }
  | { outcome: "notAcquired"; reason: string }
  | { outcome: "outcomeUnknown"; reason: string };

export type WorktreeReleaseResult =
  | { outcome: "released" }
  | { outcome: "alreadyReleased" }
  | { outcome: "refused"; reason: string }
  | { outcome: "outcomeUnknown"; reason: string };

export type NativeLeaseLookup =
  | { state: "active" | "released"; lease: NativeWorktreeLease }
  | { state: "missing" }
  | { state: "mismatch"; reason: string };

export interface NativeSlotStatus {
  slot: WorktreeSlotRow;
  nativePath: boolean;
  registered: boolean | null;
  repositoryMatches: boolean | null;
  observedHead: string | null;
  dirty: boolean | null;
  occupancy: WorktreeOccupancy;
  ownerReferenced: boolean | null;
  mergedIntoDefault: boolean | null;
}

export interface NativePoolStatus {
  pool: WorktreePoolRow;
  policy: WorktreePolicy;
  identityValid: boolean;
  markerValid: boolean;
  observedDefaultSha: string | null;
  /**
   * The pool claim's fingerprint at `observedDefaultSha`, which is the last FETCHED default
   * ref: reading it never fetches. Null when the pool has no claim, its claim lists no
   * fingerprint paths, no default ref is known, or the tree could not be read. A slot whose
   * recorded fingerprint differs from this one is stale against the default branch.
   */
  defaultFingerprint: string | null;
  slots: NativeSlotStatus[];
}

export type WorktreeRemoveResult =
  | { outcome: "removed" }
  | { outcome: "alreadyRemoved" }
  | { outcome: "refused"; reason: string }
  | { outcome: "conflict"; reason: string }
  | { outcome: "outcomeUnknown"; reason: string };

export interface NativeMaintenanceCandidate {
  poolId: string;
  slotId: string;
  slotVersion: number;
  path: string;
  rightSize: boolean;
  safe: boolean;
  reason: string | null;
}

interface SetupResult {
  ok: boolean;
  reason: string | null;
  outcomeUnknown: boolean;
}

export interface WorktreeManagerDeps {
  git: WorktreeGit;
  occupancy: (paths: readonly string[]) => Promise<Map<string, WorktreeOccupancy>>;
  resolvePolicy: (commonDirectory: string) => WorktreePolicy;
  ownerReferenced: (reference: WorktreeOwnerReference) => Promise<boolean>;
  /**
   * `env` is the scrubbed check base with the pool's claim variables on top. The manager
   * builds it and releases its disposable home afterwards.
   */
  runSetup: (argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<SetupResult>;
  /** The scrubbed check base plus these names' values. */
  claimEnvironment: (names: readonly string[]) => Promise<ClaimEnvironment>;
  runClaimStep: (request: ClaimStepRequest) => Promise<ClaimStepResult>;
  /** The blobs recorded at a commit, read from objects, for the claim fingerprint. */
  treeBlobs: (cwd: string, sha: string) => Promise<GitResult<TreeBlob[]>>;
  publishChanged: () => void;
  now: () => number;
  randomId: () => string;
  poolsDirectory: string;
  /** The wait before an owner lookup that threw is tried once more. */
  pause: (ms: number) => Promise<void>;
  /** How long a manual grant acquired in the background waits for its poller. */
  manualPickupWindowMs: number;
  /** Copy-on-write clone of one seed path. Never a byte copy. */
  cloneTree: CloneTree;
  /** Told after each seed rename into a target, before the next. A test injects a crash here. */
  afterSeedRename?: (path: string) => Promise<void> | void;
  /** How a seed renames into its target. The real `rename` unless a test injects EXDEV. */
  seedRename?: (from: string, to: string) => Promise<void>;
}

const DEFAULT_DEPS: WorktreeManagerDeps = {
  git: new NativeWorktreeGit(),
  occupancy: inspectWorktreeOccupancy,
  resolvePolicy: resolveWorktreePolicy,
  // Focused callers may have no domain tables. Production injects the durable task/check
  // resolver so reconciliation never treats this permissive test seam as authority.
  ownerReferenced: async () => false,
  runSetup: async (argv, cwd, env) => {
    const result = await run(argv[0]!, argv.slice(1), {
      cwd,
      env,
      timeoutMs: 120_000,
      maxBuffer: 64 * 1024,
    });
    const unanswered = unansweredOutcome(result);
    return result.code === 0 && !result.outcomeUnknown && !result.overflowed
      ? { ok: true, reason: null, outcomeUnknown: false }
      : {
          ok: false,
          reason: (unanswered ? `setup ${unanswered}` : result.stderr.trim()) ||
            (result.outcomeUnknown ? "setup outcome could not be proven" : `setup exited ${result.code}`),
          outcomeUnknown: result.outcomeUnknown,
        };
  },
  claimEnvironment,
  runClaimStep,
  treeBlobs: readTreeBlobs,
  publishChanged: () => {},
  now: Date.now,
  randomId: randomUUID,
  poolsDirectory: WORKTREE_POOLS_DIR,
  pause: pauseFor,
  manualPickupWindowMs: MANUAL_PICKUP_WINDOW_MS,
  cloneTree: copyOnWriteClone(),
};

/** What a seed attempt did. */
type SeedRun =
  /** No idle sibling could be held, so nothing was copied and the target is untouched. */
  | { kind: "none" }
  /** A source was held, but the seed could not be prepared. The target is untouched. */
  | { kind: "abandoned"; reason: string }
  /**
   * Every staged path is in place. `fingerprint` is the source's, which the target inherits,
   * or null when the seed was incomplete or the source recorded none: then the steps run.
   */
  | { kind: "placed"; fingerprint: string | null }
  /** Stopped, timed out, or not placed whole: the target's seed paths cannot be trusted. */
  | { kind: "interrupted"; reason: string }
  | { kind: "unrecorded" };

/** The warning reason for an interrupted seed's wipe that a Stop or the claim's deadline ended. */
const WIPE_ENDED = {
  stopped: "did not run, because removing the interrupted seed paths was stopped",
  timedOut: "did not run, because removing the interrupted seed paths reached the claim's time limit",
} as const;

/** The warning reason for a seed a Stop or the claim's deadline ended. */
const SEED_ENDED = {
  stopped: "did not run, because the dependency seed was stopped",
  timedOut: "did not run, because the dependency seed reached the claim's time limit",
} as const;

/**
 * A claim that failed before its first step ran, worded as that step not running, so the slot
 * row, the task card and the agent's note read it the way they read any other failed claim.
 */
function notRunWarning(claim: WorktreeClaim, reason: string): WorktreeClaimWarning {
  return {
    step: 1,
    stepCount: claim.steps.length,
    argv: [...claim.steps[0]!.argv],
    reason,
    tail: "",
    truncatedBytes: 0,
  };
}

type ClaimRun =
  | { kind: "skipped" }
  | { kind: "succeeded" }
  | { kind: "failed"; warning: WorktreeClaimWarning }
  /** The daemon is stopping: nothing is recorded past the write-ahead and nothing is granted. */
  | { kind: "shutdown" }
  /** The write-ahead or its settlement could not be recorded. */
  | { kind: "unrecorded"; reason: string };

/** What `claimDisposableTree` did. */
export type DisposableClaimResult =
  /** The repository has no claim. The tree is used as it is. */
  | { kind: "none" }
  | { kind: "succeeded" }
  /** A step failed, timed out or was stopped. The tree is proven, but its dependencies are not. */
  | { kind: "failed"; warning: WorktreeClaimWarning; fingerprintPaths: string[] }
  /** The tree cannot be used: the daemon is stopping, or the final proof failed. */
  | { kind: "unproven"; reason: string };

/** The physical Git common directory of a repository, from Git itself, or why it could not be read. */
async function gitCommonDirectory(
  repositoryPath: string,
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  const result = await run(
    "git",
    ["-C", repositoryPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeoutMs: 15_000 },
  );
  const reported = result.stdout.trim();
  if (result.code !== 0 || result.outcomeUnknown || !reported) {
    return {
      ok: false,
      reason: `git rev-parse --git-common-dir failed: ${bounded(result.stderr.trim() || `exit ${result.code}`)}`,
    };
  }
  try {
    return { ok: true, value: await realpath(reported) };
  } catch (error) {
    return { ok: false, reason: `the common directory ${reported} could not be resolved: ${bounded(String(error))}` };
  }
}

/**
 * Null when a disposable check tree is at exactly `sha`, detached, and clean with untracked
 * files counted, as a slot must be before its grant. Otherwise why not.
 */
async function proveDisposableTree(path: string, sha: string): Promise<string | null> {
  const [head, status, branch] = await Promise.all([
    run("git", ["-C", path, "rev-parse", "HEAD"], { timeoutMs: 15_000 }),
    run("git", ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"], { timeoutMs: 15_000 }),
    run("git", ["-C", path, "symbolic-ref", "--quiet", "HEAD"], { timeoutMs: 15_000 }),
  ]);
  if (head.code !== 0 || head.outcomeUnknown || status.code !== 0 || status.outcomeUnknown || branch.outcomeUnknown) {
    return "the check worktree's state could not be read";
  }
  if (head.stdout.trim() !== sha) return "the check worktree is no longer at its exact commit";
  if (status.stdout.trim() !== "") return "the check worktree failed its cleanliness verification";
  if (branch.code === 0) return "the check worktree has a branch attached";
  return null;
}

/**
 * Make a claim's controller follow its caller's signal, and return the unsubscribe. A signal
 * that is already aborted aborts the claim at once, so a stop requested before the claim
 * registered still lands: its first step sees it and never starts.
 */
function followSignal(signal: AbortSignal | undefined, control: AbortController): () => void {
  if (!signal) return () => {};
  const abort = (): void => control.abort("stopped");
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

/**
 * Tell a caller its claim is about to run. A hook that throws must not fail a claim, or leave a
 * slot reserved behind it, so its error is logged and dropped.
 */
function notifyClaimStart(onClaimStart: (() => void) | undefined): void {
  try {
    onClaimStart?.();
  } catch (error) {
    console.warn(`[worktrees] claim start hook failed: ${bounded(String(error))}`);
  }
}

const SLOT_OBSERVATION_CONCURRENCY = 8;

/** Maps with at most `limit` callbacks in flight, keeping the input order in the output. */
async function mapBounded<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = Array.from({ length: items.length });
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await map(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function bounded(value: string): string {
  return Buffer.from(value, "utf8").subarray(0, MAX_ERROR_BYTES).toString("utf8");
}

function validOwner(owner: WorktreeOwner): boolean {
  return (
    isWorktreeOwnerKind(owner.kind) &&
    owner.key.length > 0 &&
    Buffer.byteLength(owner.key, "utf8") <= MAX_OWNER_BYTES
  );
}

function registrationFor(
  registrations: readonly WorktreeRegistration[],
  path: string,
): WorktreeRegistration | null {
  return registrations.find((registration) => registration.path === path) ?? null;
}

function referenceFrom(
  slotId: string,
  leaseId: string | null,
  ownerKind: string | null,
  ownerKey: string | null,
): WorktreeOwnerReference | null | "invalid" {
  const fields = [leaseId, ownerKind, ownerKey];
  if (fields.every((field) => field === null)) return null;
  if (fields.some((field) => field === null)) return "invalid";
  const owner = { kind: ownerKind! as WorktreeOwnerKind, key: ownerKey! };
  if (!leaseId || !validOwner(owner)) return "invalid";
  return {
    slotId,
    leaseId,
    owner,
  };
}

function lastReference(slot: WorktreeSlotRow): WorktreeOwnerReference | null | "invalid" {
  return referenceFrom(
    slot.id,
    slot.lastReleasedLeaseId,
    slot.lastReleasedOwnerKind,
    slot.lastReleasedOwnerKey,
  );
}

function activeReference(slot: WorktreeSlotRow): WorktreeOwnerReference | null | "invalid" {
  return referenceFrom(
    slot.id,
    slot.activeLeaseId,
    slot.activeOwnerKind,
    slot.activeOwnerKey,
  );
}

function exactSlotPath(
  pool: WorktreePoolRow,
  identity: WorktreeRepositoryIdentity,
  slot: WorktreeSlotRow,
): boolean {
  return (
    identity.gitCommonDirectory === pool.gitCommonDirectory &&
    identity.poolPath === pool.poolPath &&
    pathContains(pool.poolPath, slot.path) &&
    slot.path === join(pool.poolPath, String(slot.ordinal), identity.repositoryName)
  );
}

/** Native worktree sweep interval, or null when MISSION_WORKTREE_SWEEP_MS disables it. */
export function worktreeSweepIntervalMs(raw = envVar("WORKTREE_SWEEP_MS")): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SWEEP_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_SWEEP_MS;
  if (value <= 0) return null;
  return Math.min(Math.max(value, MIN_SWEEP_MS), MAX_SWEEP_MS);
}

/**
 * The daemon's single allocator authority for native pooled worktrees. Database state changes
 * are short and synchronous. Pool reservation locks cover only candidate CAS/allocation, while
 * per-slot locks and durable intent states isolate Git/process work to the exact slot.
 * New Git registrations serialize per repository because their metadata directory is shared.
 */
export class WorktreeManager {
  readonly store: WorktreeStore;
  private readonly deps: WorktreeManagerDeps;
  private readonly queues = new Map<string, Promise<void>>();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maintenance: Promise<void> | null = null;
  private reclaimDomainLeases: () => Promise<void> = async () => {};
  /** Grants protected until their task/check row durably records the random lease ID. */
  private readonly pendingDomainLeases = new Set<string>();
  /** Dependency claims running right now. Maintenance skips their slots; shutdown stops them. */
  readonly claims = new ClaimRegistry();
  /**
   * The last default-branch fingerprint per pool, keyed by the sha and claim it was taken
   * for. A default ref moves only on a fetch, so every observation in between reuses one
   * `ls-tree` instead of reading the whole tree again.
   */
  private readonly defaultFingerprints = new Map<string, { key: string; fingerprint: string | null }>();
  private readonly changeBatch = new AsyncLocalStorage<{ pending: boolean }>();
  /**
   * The `warm` owners whose operation is running in this daemon right now. In memory by
   * design: no Warm or seed survives a restart, so startup reconciliation, which runs before
   * anything can add to this, finds every `warm` owner definitely unreferenced.
   */
  private readonly liveWarmOwners = new Set<string>();
  /** Staging directories a seed in flight owns. Reconciliation removes every other one. */
  private readonly liveSeedStaging = new Set<string>();

  /**
   * Manual acquires running in the background because their pool has a claim. `make session`
   * polls them through the manual request route.
   */
  readonly manualRequests: ManualAcquireRequests;

  constructor(db: DatabaseSync = openDb(), deps: Partial<WorktreeManagerDeps> = {}) {
    this.store = new WorktreeStore(db);
    this.deps = { ...DEFAULT_DEPS, ...deps };
    this.manualRequests = new ManualAcquireRequests(this, {
      now: () => this.deps.now(),
      pickupWindowMs: this.deps.manualPickupWindowMs,
    });
  }

  /**
   * The dependency claim a lease of this repository would run, or null when its pool has none,
   * is disabled, or its policy cannot be read. The manual route asks before it acquires: a pool
   * with a claim is acquired in the background, and one without is answered synchronously.
   */
  poolClaim(repositoryPath: string): WorktreeClaim | null {
    const identity = this.identity(repositoryPath);
    if (!identity) return null;
    try {
      const policy = this.deps.resolvePolicy(identity.gitCommonDirectory);
      return policy.enabled ? policy.claim ?? null : null;
    } catch {
      return null;
    }
  }

  private async acquireLock(key: string): Promise<() => void> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const tail = prior.catch(() => {}).then(() => hold);
    this.queues.set(key, tail);
    await prior.catch(() => {});
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseHold();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    };
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock(key);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private withPoolReservation<T>(commonDirectory: string, operation: () => Promise<T>): Promise<T> {
    return this.withLock(`pool:${commonDirectory}`, operation);
  }

  private withSlot<T>(slotId: string, operation: () => Promise<T>): Promise<T> {
    return this.withLock(`slot:${slotId}`, operation);
  }

  private acquireSlotLock(slotId: string): Promise<() => void> {
    return this.acquireLock(`slot:${slotId}`);
  }

  private deliverPublish(publishChanged: () => void = this.deps.publishChanged): void {
    try {
      publishChanged();
    } catch (error) {
      console.warn("[worktrees] change publication failed:", error);
    }
  }

  private publish(): void {
    const batch = this.changeBatch.getStore();
    if (batch) {
      batch.pending = true;
      return;
    }
    this.deliverPublish();
  }

  /** Coalesces every visible mutation in one operator action into one invalidation. */
  async runChangeBatch<T>(
    operation: () => Promise<T>,
    publishOnSuccess = true,
    publishChanged?: () => void,
  ): Promise<T> {
    if (this.changeBatch.getStore()) return operation();
    const batch = { pending: false };
    try {
      const result = await this.changeBatch.run(batch, operation);
      if (publishOnSuccess) batch.pending = true;
      return result;
    } finally {
      if (batch.pending) this.deliverPublish(publishChanged);
    }
  }

  private identity(repositoryPath: string): WorktreeRepositoryIdentity | null {
    return worktreeRepositoryIdentity(repositoryPath, this.deps.poolsDirectory);
  }

  private quarantine(slot: WorktreeSlotRow, reason: string, error: string | null = null): void {
    try {
      const quarantined = this.store.quarantine(
        slot.id,
        bounded(reason),
        error ? bounded(error) : null,
        this.deps.now(),
        slot.version,
      );
      if (quarantined) this.publish();
    } catch (quarantineError) {
      console.error(`[worktrees] could not quarantine slot ${slot.id}:`, quarantineError);
    }
  }

  private async occupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
    try {
      return await this.deps.occupancy(paths);
    } catch (error) {
      const reason = `slot occupancy query failed: ${bounded(String(error))}`;
      return new Map(paths.map((path) => [path, { status: "unknown" as const, reason }]));
    }
  }

  private async releaseBlocker(
    reference: WorktreeOwnerReference,
    path: string,
  ): Promise<string | null> {
    try {
      if (await this.ownerReferenced(reference)) {
        return "domain owner still references this lease";
      }
    } catch (error) {
      return `domain ownership is unknown: ${bounded(String(error))}`;
    }
    return this.occupancyBlocker(path);
  }

  /**
   * A point check before a mutation. Only the process read itself takes the observation
   * lock, so it cannot overlap an inventory observation's Git reads inside this slot; the
   * mutation around it runs unlocked, so a slow removal never holds up a preview.
   */
  private async occupancyBlocker(path: string): Promise<string | null> {
    const occupancy = (await this.withObservation(() => this.occupancy([path]))).get(path);
    if (!occupancy || occupancy.status === "unknown") {
      return occupancy?.status === "unknown" ? occupancy.reason : "slot occupancy is unknown";
    }
    return occupancy.occupants.length > 0
      ? "one or more processes still occupy the worktree"
      : null;
  }

  /** A domain lookup that throws is tried once more (`observation-retry.ts`) before it is unknown. */
  private async ownerReferenced(reference: WorktreeOwnerReference): Promise<boolean> {
    if (this.pendingDomainLeases.has(reference.leaseId)) return true;
    // A `warm` owner has no domain row: its operation's life in this daemon is its reference.
    if (reference.owner.kind === "warm") return this.liveWarmOwners.has(reference.owner.key);
    try {
      return await this.deps.ownerReferenced(reference);
    } catch (first) {
      await this.deps.pause(OBSERVATION_RETRY_DELAY_MS);
      try {
        return await this.deps.ownerReferenced(reference);
      } catch (second) {
        const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
        throw new Error(bothAttempts(text(first), text(second)));
      }
    }
  }

  /** Whether this `warm` owner's operation is running in this daemon right now. */
  warmOwnerLive(key: string): boolean {
    return this.liveWarmOwners.has(key);
  }

  /** Complete the in-memory handoff after a task/check row durably records this lease. */
  settleDomainLease(leaseId: string): void {
    this.pendingDomainLeases.delete(leaseId);
  }

  private async validateResetTarget(
    pool: WorktreePoolRow,
    identity: WorktreeRepositoryIdentity,
    slot: WorktreeSlotRow,
  ): Promise<GitResult<void>> {
    try {
      const [stat, physical] = await Promise.all([lstat(slot.path), realpath(slot.path)]);
      if (!stat.isDirectory() || stat.isSymbolicLink() || physical !== resolve(slot.path)) {
        return {
          ok: false,
          reason: "slot path is not an exact physical directory",
          outcomeUnknown: false,
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `slot path could not be physically verified: ${bounded(String(error))}`,
        outcomeUnknown: false,
      };
    }

    let listed: Awaited<ReturnType<WorktreeGit["list"]>>;
    try {
      listed = await this.deps.git.list(identity);
    } catch (error) {
      return {
        ok: false,
        reason: `Git worktree registrations could not be read: ${bounded(String(error))}`,
        outcomeUnknown: true,
      };
    }
    if (!listed.ok) return listed;
    const registration = registrationFor(listed.value, slot.path);
    if (!registration || registration.bare || registration.locked || registration.prunable) {
      return {
        ok: false,
        reason: "slot has no safe Git worktree registration",
        outcomeUnknown: false,
      };
    }

    let inspected: Awaited<ReturnType<WorktreeGit["inspect"]>>;
    try {
      inspected = await this.deps.git.inspect(slot.path);
    } catch (error) {
      return {
        ok: false,
        reason: `slot Git state could not be inspected: ${bounded(String(error))}`,
        outcomeUnknown: true,
      };
    }
    if (!inspected.ok) return inspected;
    if (
      inspected.value.path !== slot.path ||
      inspected.value.commonDirectory !== pool.gitCommonDirectory
    ) {
      return {
        ok: false,
        reason: "slot is not the registered worktree owned by its native pool",
        outcomeUnknown: false,
      };
    }
    return { ok: true, value: undefined };
  }

  /**
   * Which of these available slots are idle: the one definition acquisition and seed-source
   * selection share. Anything a slot cannot prove (its path, its identities, its last owner's
   * absence, its occupancy, its registration, its Git state, its cleanliness) is quarantined
   * here, as acquisition always has. A slot whose last owner still references it stays
   * available but is not idle. `head` is the commit each idle slot was observed at.
   */
  private async screenIdleSlots(
    pool: WorktreePoolRow,
    identity: WorktreeRepositoryIdentity,
    available: readonly WorktreeSlotRow[],
  ): Promise<{ ok: true; idle: Array<{ slot: WorktreeSlotRow; head: string }> } | { ok: false; reason: string }> {
    if (available.length === 0) return { ok: true, idle: [] };
    let registrations: Awaited<ReturnType<WorktreeGit["list"]>>;
    try {
      registrations = await this.deps.git.list(identity);
    } catch (error) {
      const reason = `Git registrations could not be read: ${bounded(String(error))}`;
      for (const slot of available) this.quarantine(slot, "Git registrations could not be read", reason);
      return { ok: false, reason };
    }
    if (!registrations.ok) {
      for (const slot of available) this.quarantine(slot, "Git registrations could not be read", registrations.reason);
      return { ok: false, reason: `Git registrations could not be read: ${registrations.reason}` };
    }
    const occupancy = await this.occupancy(available.map((slot) => slot.path));
    const idle: Array<{ slot: WorktreeSlotRow; head: string }> = [];
    for (const slot of available) {
      if (!exactSlotPath(pool, identity, slot)) {
        this.quarantine(slot, "slot path is not the exact path owned by its native pool");
        continue;
      }
      const active = activeReference(slot);
      if (active !== null) {
        this.quarantine(
          slot,
          active === "invalid"
            ? "available slot has incomplete active lease identity"
            : "available slot still carries active lease identity",
        );
        continue;
      }
      const priorReference = lastReference(slot);
      if (priorReference === "invalid") {
        this.quarantine(slot, "last-released lease identity is incomplete");
        continue;
      }
      if (priorReference) {
        try {
          if (await this.ownerReferenced(priorReference)) {
            // This is the recoverable release/domain-row crash window. Keep the slot
            // available but ineligible until the exact owner clears its durable row.
            continue;
          }
        } catch (error) {
          this.quarantine(slot, "last-released domain ownership could not be read", String(error));
          continue;
        }
      }
      const observedOccupancy = occupancy.get(slot.path);
      if (!observedOccupancy || observedOccupancy.status === "unknown") {
        this.quarantine(
          slot,
          "slot occupancy is unknown",
          observedOccupancy?.status === "unknown" ? observedOccupancy.reason : null,
        );
        continue;
      }
      if (observedOccupancy.occupants.length > 0) {
        this.quarantine(slot, "an available slot has process occupancy");
        continue;
      }
      const registration = registrationFor(registrations.value, slot.path);
      if (!registration || registration.bare || registration.locked || registration.prunable) {
        this.quarantine(slot, "slot has no safe Git worktree registration");
        continue;
      }
      let inspection: Awaited<ReturnType<WorktreeGit["inspect"]>>;
      try {
        inspection = await this.deps.git.inspect(slot.path);
      } catch (error) {
        this.quarantine(slot, "slot Git state could not be inspected", String(error));
        continue;
      }
      if (!inspection.ok) {
        this.quarantine(slot, "slot Git state could not be inspected", inspection.reason);
        continue;
      }
      if (
        inspection.value.path !== slot.path ||
        inspection.value.commonDirectory !== identity.gitCommonDirectory
      ) {
        this.quarantine(slot, "slot belongs to a different Git common directory");
        continue;
      }
      if (inspection.value.dirty) {
        this.quarantine(slot, "available slot has dirty or untracked work");
        continue;
      }
      idle.push({ slot, head: inspection.value.head });
    }
    return { ok: true, idle };
  }

  /**
   * Null when no process entered a reserved, formerly available slot. Otherwise the slot is
   * quarantined and the reason returned. `before` names what the reservation was about to do.
   */
  private async enteredSinceReservation(reservation: WorktreeSlotRow, before: string): Promise<string | null> {
    const fresh = (await this.occupancy([reservation.path])).get(reservation.path);
    if (!fresh || fresh.status === "unknown") {
      const reason = fresh?.status === "unknown" ? fresh.reason : "slot occupancy was not observed";
      this.quarantine(reservation, `slot occupancy became unknown before ${before}`, reason);
      return reason;
    }
    if (fresh.occupants.length > 0) {
      const reason = `a process entered the available slot before ${before}`;
      this.quarantine(reservation, reason);
      return reason;
    }
    return null;
  }

  async acquire(input: {
    repositoryPath: string;
    baseSha: string;
    owner: WorktreeOwner;
    /** Protect the grant until its task/check row is durably written. */
    awaitingDomainRecord?: boolean;
    /**
     * Run the pool's dependency claim inside this lease. Task dispatch, check attempts and the
     * background manual acquire ask for it. The synchronous manual acquire, for a pool with no
     * claim, does not.
     */
    runClaim?: boolean;
    /**
     * Told once, synchronously, when the claim's steps are about to run: after the fingerprint
     * check decided they must, before the write-ahead. Never told for a claim that is skipped.
     * A check attempt gives up its check-concurrency slot here, since an install is not a build.
     */
    onClaimStart?: () => void;
    /**
     * The caller's own stop for this lease's claim. The claim follows it from the moment it
     * registers: aborted already, the claim stops before its first step; aborted later, the
     * running step is stopped. Either way it settles as a failed claim and the lease is granted
     * with the warning, as for a Stop. A check attempt passes its run's cancel here.
     */
    signal?: AbortSignal;
    /**
     * Asked once, as the claim registers: true stops it as `signal` would. A task dispatch
     * passes whether its task is cancelled, since a cancel that finished before the claim
     * registered had no claim for `stopTaskClaims` to find.
     */
    abandoned?: () => boolean;
  }): Promise<WorktreeAcquireResult> {
    if (!SHA.test(input.baseSha)) {
      return { outcome: "notAcquired", reason: "baseSha must be a full 40-character commit id" };
    }
    if (!validOwner(input.owner)) {
      return { outcome: "notAcquired", reason: "owner kind/key is invalid or exceeds its bound" };
    }
    const identity = this.identity(input.repositoryPath);
    if (!identity) {
      return { outcome: "notAcquired", reason: "repository ownership cannot be proven" };
    }
    let policy: WorktreePolicy;
    try {
      policy = this.deps.resolvePolicy(identity.gitCommonDirectory);
    } catch (error) {
      return { outcome: "notAcquired", reason: `native worktree policy is invalid: ${bounded(String(error))}` };
    }
    if (!policy.enabled) return { outcome: "notAcquired", reason: "native worktrees are disabled for this repository" };
    const claim = input.runClaim ? policy.claim ?? null : null;
    if (claim && this.claims.stopping) {
      // Not `notAcquired`: a task refused that way falls back to a disposable worktree, and
      // the daemon is going away, not declining this repository.
      return { outcome: "outcomeUnknown", reason: STOPPING_REASON };
    }

    const now = this.deps.now();
    let pool: WorktreePoolRow;
    try {
      pool = this.store.ensurePool({
        id: this.deps.randomId(),
        gitCommonDirectory: identity.gitCommonDirectory,
        mainCheckoutRoot: identity.mainCheckoutRoot,
        poolPath: identity.poolPath,
        now,
      });
      await ensureWorktreePoolMarker(pool.poolPath, pool.id);
    } catch (error) {
      return { outcome: "notAcquired", reason: bounded(String(error)) };
    }

    const screened = await this.screenIdleSlots(
      pool,
      identity,
      this.store.slots(pool.id).filter((slot) => slot.state === "available"),
    );
    if (!screened.ok) return { outcome: "notAcquired", reason: screened.reason };
    const eligible = screened.idle.map((entry) => entry.slot);

    const leaseId = this.deps.randomId();
    let allocation: { reservation: WorktreeSlotRow | null; created: boolean };
    try {
      allocation = await this.withPoolReservation(identity.gitCommonDirectory, async () => {
        let reservation: WorktreeSlotRow | null = null;
        for (const candidate of eligible) {
          reservation = this.store.reserveAvailable({
            slotId: candidate.id,
            version: candidate.version,
            leaseId,
            ownerKind: input.owner.kind,
            ownerKey: input.owner.key,
            requestedHeadSha: input.baseSha,
            now: this.deps.now(),
          });
          if (reservation) return { reservation, created: false };
        }
        const slotId = this.deps.randomId();
        reservation = this.store.reserveNew({
          poolId: pool.id,
          maxSlots: policy.maxSlots,
          id: slotId,
          pathForOrdinal: (ordinal) => join(pool.poolPath, String(ordinal), identity.repositoryName),
          leaseId,
          ownerKind: input.owner.kind,
          ownerKey: input.owner.key,
          requestedHeadSha: input.baseSha,
          now: this.deps.now(),
        });
        return { reservation, created: reservation !== null };
      });
    } catch (error) {
      return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
    }
    const { reservation, created } = allocation;
    if (!reservation) {
      return { outcome: "notAcquired", reason: `native pool capacity ${policy.maxSlots} is exhausted` };
    }
    // Registered BEFORE the slot lock is taken, in the same synchronous run as the
    // reservation's return: maintenance asks the registry before it queues on a slot lock, so
    // it can never queue behind a claim it did not see.
    const claimControl = claim ? this.claims.register(reservation.id, input.owner, this.deps.now()) : null;
    if (claim && !claimControl) {
      // Shutdown began between the check above and the reservation. Startup quarantines the
      // provisioning reservation; nothing was granted and nothing ran.
      return { outcome: "outcomeUnknown", reason: STOPPING_REASON };
    }
    const unfollow = claimControl ? followSignal(input.signal, claimControl) : () => {};
    if (claimControl && input.abandoned?.()) claimControl.abort("stopped");
    return this.withSlot(reservation.id, async () => {
      try {
        if (!created) {
          const entered = await this.enteredSinceReservation(reservation, "reset");
          if (entered) return { outcome: "outcomeUnknown", reason: entered };
        }

        const mutation = created
          // Git can enumerate another add's registration before its commondir is written.
          // Serialize only creation, separately from the short pool reservation lock.
          ? await this.withLock(`git-add:${identity.gitCommonDirectory}`, () =>
              this.deps.git.add(identity, reservation.path, input.baseSha))
          : await this.deps.git.reset(reservation.path, input.baseSha);
        if (!mutation.ok) {
          this.quarantine(
            reservation,
            created ? "worktree creation failed" : "worktree reset failed",
            mutation.reason,
          );
          return { outcome: "outcomeUnknown", reason: mutation.reason };
        }

        if (created && policy.setupArgv) {
          // The same base as a claim step, with the union of every name the pool's claim
          // lists. A setup command that relied on an unlisted credential from the daemon's
          // environment no longer receives it.
          const setupEnvironment = await this.deps.claimEnvironment(claimVariableNames(policy.claim));
          const received = setupEnvironment.received
            .map((name) => ({ name, value: String(setupEnvironment.env[name] ?? "") }));
          let setup: SetupResult;
          try {
            setup = await this.deps.runSetup(policy.setupArgv, reservation.path, setupEnvironment.env);
          } finally {
            cleanupAgentSubprocessEnv(setupEnvironment.env);
          }
          if (!setup.ok || setup.outcomeUnknown) {
            // Setup receives every claim variable, so its failure text is redacted like a step's
            // before it is stored as the quarantine reason and shown by the inventory.
            const reason = setup.reason !== null
              ? redactClaimValues(setup.reason, received)
              : setup.outcomeUnknown ? "setup outcome could not be proven" : "setup failed";
            this.quarantine(
              reservation,
              setup.outcomeUnknown
                ? "operator-authored setup command outcome is unknown"
                : "operator-authored setup command failed",
              reason,
            );
            return { outcome: "outcomeUnknown", reason };
          }
        }

        let claimWarning: WorktreeClaimWarning | undefined;
        if (claim && claimControl) {
          const claimed = await this.claimDependencies(
            reservation,
            claim,
            input.baseSha,
            claimControl,
            input.onClaimStart,
            { pool, identity, enabled: policy.enabled },
          );
          if (claimed.kind === "shutdown") {
            // Left exactly as the write-ahead left it. Startup finds the slot provisioning with
            // `deps_state = claiming`, quarantines it and marks it interrupted: the same cost a
            // restart during setup has.
            return { outcome: "outcomeUnknown", reason: STOPPED_REASON };
          }
          if (claimed.kind === "unrecorded") {
            this.quarantine(reservation, "dependency claim state could not be recorded", claimed.reason);
            return { outcome: "outcomeUnknown", reason: claimed.reason };
          }
          if (claimed.kind === "failed") claimWarning = claimed.warning;
        }

        // A claim step that modified a tracked file, or attached a branch, fails this proof and
        // quarantines the slot like any other unproven materialization.
        const inspection = await this.deps.git.inspect(reservation.path);
        if (
          !inspection.ok ||
          inspection.value.path !== reservation.path ||
          inspection.value.commonDirectory !== identity.gitCommonDirectory ||
          inspection.value.head !== input.baseSha ||
          inspection.value.dirty ||
          // Independent of `add`/`reset` having reported success. Creation detaches and the
          // pool reset now detaches, but this is the durable proof taken immediately before
          // the grant, so a slot can only be leased attached if BOTH the mutation and this
          // observation are wrong at once. A warm slot left branch-attached by an older
          // build is repaired by that reset and then proved here, on its next use.
          !inspection.value.detached
        ) {
          const reason = inspection.ok
            ? "materialized slot failed path, repository, exact HEAD, cleanliness, or detached-HEAD verification"
            : inspection.reason;
          this.quarantine(reservation, "materialized slot verification failed", reason);
          return { outcome: "outcomeUnknown", reason };
        }
        // Shutdown grants no claimed lease, including one whose claim finished just before it.
        if (claim && this.claims.stopping) return { outcome: "outcomeUnknown", reason: STOPPED_REASON };

        const leased = this.store.finalizeLease(
          reservation.id,
          reservation.version,
          input.baseSha,
          this.deps.now(),
        );
        if (!leased) {
          this.quarantine(reservation, "lease commit lost its slot compare-and-swap");
          return { outcome: "outcomeUnknown", reason: "lease commit could not be proven" };
        }
        this.publish();
        if (input.awaitingDomainRecord) this.pendingDomainLeases.add(leaseId);
        return {
          outcome: "acquired",
          lease: {
            slotId: leased.id,
            poolId: pool.id,
            path: leased.path,
            provider: "mission",
            leaseId,
            owner: input.owner,
            baseSha: input.baseSha,
            slotVersion: leased.version,
          },
          ...(claimWarning && claim
            ? { claimWarning, claimFingerprintPaths: [...claim.fingerprintPaths] }
            : {}),
        };
      } catch (error) {
        const reason = bounded(String(error));
        this.quarantine(reservation, "native worktree materialization outcome is unknown", reason);
        return { outcome: "outcomeUnknown", reason };
      } finally {
        unfollow();
        if (claimControl) this.claims.unregister(reservation.id, claimControl);
      }
    });
  }

  /**
   * The claim, under the reservation's slot lock. A slot whose recorded fingerprint matches
   * this commit's skips the steps. Otherwise one durable write records the intent and clears
   * the fingerprint before anything touches the tree, so a crash anywhere after it leaves
   * nothing for a later lease to trust. Success records `current` with the new fingerprint;
   * failure records `failed` and comes back as a warning, never as a quarantine.
   *
   * Between the write-ahead and the steps sit the interrupted wipe and the seed. A slot whose
   * last claim or seed was cut off first loses its seed paths, once Git confirms they are
   * ignored. A slot with no trusted fingerprint, or a stale one that an idle sibling matches
   * exactly, is then seeded copy-on-write from that sibling, and inherits its fingerprint.
   */
  private async claimDependencies(
    reservation: WorktreeSlotRow,
    claim: WorktreeClaim,
    sha: string,
    control: AbortController,
    onClaimStart: (() => void) | undefined,
    where: { pool: WorktreePoolRow; identity: WorktreeRepositoryIdentity; enabled: boolean },
  ): Promise<ClaimRun> {
    const fingerprint = await this.commitFingerprint(reservation.path, claim, sha);
    const recorded = this.store.slot(reservation.id);
    if (
      fingerprint !== null &&
      recorded?.depsState === "current" &&
      recorded.depsFingerprint === fingerprint
    ) {
      return { kind: "skipped" };
    }
    notifyClaimStart(onClaimStart);
    // The whole claim, the seed included, spends one deadline.
    const deadline = this.deps.now() + claim.timeoutMinutes * 60_000;
    if (!this.store.beginClaim(reservation.id, reservation.version, this.deps.now())) {
      return { kind: "unrecorded", reason: "the dependency claim intent could not be recorded" };
    }
    this.publish();
    const settleFailed = (warning: WorktreeClaimWarning, state: "failed" | "interrupted" = "failed"): ClaimRun => {
      const settled = this.store.finishClaim(
        reservation.id,
        reservation.version,
        { state, error: encodeClaimFailure(warning) },
        this.deps.now(),
      );
      if (!settled) return { kind: "unrecorded", reason: "the dependency claim outcome could not be recorded" };
      this.publish();
      const summary = describeClaimFailure(warning).split("\n", 1)[0];
      console.warn(`[worktrees] dependency claim failed in ${reservation.path}: ${summary}`);
      return { kind: "failed", warning };
    };

    // Anything but a settled state means a claim or a seed was cut off, so its seed paths may
    // be half renamed. A state a later build wrote is treated the same way.
    const interrupted = depsCutOff(recorded?.depsState ?? null);
    if (interrupted && claim.seed) {
      // The wipe spends the claim's deadline and honours its Stop like every seed phase, so a
      // large tree cannot hide a Stop or eat the steps' time unseen.
      const wiped = await wipeSeedPaths(reservation.path, claim.seed, {
        signal: control.signal,
        deadline,
        now: this.deps.now,
      });
      if (!wiped.ok) {
        // Left `claiming` while the daemon stops: startup records it as interrupted.
        if ("ended" in wiped && this.claims.stopping) return { kind: "shutdown" };
        // Still interrupted, not failed: the seed paths may be half renamed, or half removed by
        // this very wipe, and only `interrupted` makes the next claim remove them again before
        // anything else. The lease is granted with the warning, as for any failed claim.
        return settleFailed(
          notRunWarning(
            claim,
            "ended" in wiped
              ? WIPE_ENDED[wiped.ended]
              : `did not run, because the interrupted seed paths could not be removed: ${wiped.reason}`,
          ),
          "interrupted",
        );
      }
    }

    // Cold: new, never claimed, failed or cut off. A slot whose last claim succeeded is not
    // cold even with no fingerprint (its claim lists no fingerprint paths), or it would be
    // re-seeded over its own fresh install on every lease. Stale: it succeeded, but at a
    // fingerprint this commit does not have, including none at all because fingerprint paths
    // were configured since. A stale slot seeds only from an exact match.
    const cold = interrupted || recorded?.depsState !== "current";
    const stale = !cold && fingerprint !== null && recorded?.depsFingerprint !== fingerprint;
    if (claim.seed && where.enabled && (cold || stale)) {
      const seeded = await this.seedSlotBeforeSteps({
        reservation,
        claim,
        seed: claim.seed,
        sha,
        fingerprint,
        exactOnly: !cold,
        // Recovering a cut-off seed never skips the steps on an inherited fingerprint. The
        // write-ahead does not record which seed paths the cut-off seed touched, and the
        // operator may have narrowed `seed.paths` since: the wipe above removed only the paths
        // configured now, so a path the old seed half-renamed can survive it. The steps are
        // what repair that tree, so they always run.
        inherit: !interrupted,
        control,
        deadline,
        pool: where.pool,
        identity: where.identity,
      });
      if (seeded) return seeded;
    }

    const outcome = await runClaimSteps({
      claim,
      cwd: reservation.path,
      signal: control.signal,
      environment: this.deps.claimEnvironment,
      runStep: this.deps.runClaimStep,
      now: this.deps.now,
      deadline,
      // Settings shows the running step and how long it has run. The registry holds it, and a
      // bump per step is what tells the dashboard to read it again.
      onStep: (step) => {
        this.claims.progress(reservation.id, control, step);
        this.publish();
      },
    });
    if (!outcome.ok && this.claims.stopping) return { kind: "shutdown" };
    if (!outcome.ok) return settleFailed(outcome.warning);
    const settled = this.store.finishClaim(
      reservation.id,
      reservation.version,
      { state: "current", fingerprint, sha },
      this.deps.now(),
    );
    if (!settled) return { kind: "unrecorded", reason: "the dependency claim outcome could not be recorded" };
    this.publish();
    return { kind: "succeeded" };
  }

  /**
   * A slot claim's seed, taken under the claim's write-ahead. The settled run when the seed
   * decided the claim: stopped or timed out (`interrupted`), placed from a source that matches
   * this commit (`current`, steps skipped), or unrecordable. Null when the steps run next, with
   * the claim's own write-ahead back in place if a seed took it.
   */
  private async seedSlotBeforeSteps(input: {
    reservation: WorktreeSlotRow;
    claim: WorktreeClaim;
    seed: WorktreeClaimSeed;
    sha: string;
    fingerprint: string | null;
    /** A stale slot seeds only from a sibling that matches its commit exactly. */
    exactOnly: boolean;
    /** Whether a seed from an exact match may skip the steps on the inherited fingerprint. */
    inherit: boolean;
    control: AbortController;
    deadline: number;
    pool: WorktreePoolRow;
    identity: WorktreeRepositoryIdentity;
  }): Promise<ClaimRun | null> {
    const { reservation, claim, seed, sha, fingerprint, exactOnly, inherit, control, deadline } = input;
    const seeded = await this.seedTree({
      pool: input.pool,
      identity: input.identity,
      targetPath: reservation.path,
      targetSlotId: reservation.id,
      seed,
      fingerprint,
      // Anything less than an exact match would swap a whole tree into a stale slot where a
      // small incremental install would do.
      exactOnly,
      ownerKey: this.claims.get(reservation.id)?.id ?? this.deps.randomId(),
      signal: control.signal,
      deadline,
      begin: () => {
        if (!this.store.beginSeed(reservation.id, reservation.version, this.deps.now())) return false;
        this.publish();
        return true;
      },
    });
    if (seeded.kind === "unrecorded") {
      return { kind: "unrecorded", reason: "the dependency seed intent could not be recorded" };
    }
    if (seeded.kind === "interrupted") {
      // Left `seeding` while the daemon stops: startup records it as interrupted.
      if (this.claims.stopping) return { kind: "shutdown" };
      const warning = notRunWarning(claim, seeded.reason);
      const settled = this.store.finishSeed(
        reservation.id,
        reservation.version,
        { state: "interrupted", error: encodeClaimFailure(warning) },
        this.deps.now(),
      );
      if (!settled) return { kind: "unrecorded", reason: "the dependency seed outcome could not be recorded" };
      this.publish();
      console.warn(`[worktrees] dependency seed interrupted in ${reservation.path}: ${seeded.reason}`);
      return { kind: "failed", warning };
    }
    if (inherit && seeded.kind === "placed" && fingerprint !== null && seeded.fingerprint === fingerprint) {
      // The source's dependencies are this commit's: the ordinary skip rule, applied to the
      // fingerprint the target inherited.
      const settled = this.store.finishSeed(
        reservation.id,
        reservation.version,
        { state: "current", fingerprint, sha },
        this.deps.now(),
      );
      if (!settled) return { kind: "unrecorded", reason: "the dependency seed outcome could not be recorded" };
      this.publish();
      return { kind: "succeeded" };
    }
    if (seeded.kind === "abandoned") {
      console.warn(`[worktrees] dependency seed abandoned for ${reservation.path}: ${seeded.reason}`);
    }
    // The steps run, under the claim's own write-ahead again when a seed took its place.
    if (seeded.kind !== "none" && !this.store.beginClaim(reservation.id, reservation.version, this.deps.now())) {
      return { kind: "unrecorded", reason: "the dependency claim intent could not be recorded" };
    }
    return null;
  }

  /**
   * The claim's fingerprint at `sha`, read from objects. Null when the claim lists no
   * fingerprint paths or the tree cannot be read: then the steps run, and nothing a later lease
   * could skip on is recorded.
   */
  private async commitFingerprint(cwd: string, claim: WorktreeClaim, sha: string): Promise<string | null> {
    if (claim.fingerprintPaths.length === 0) return null;
    let blobs: GitResult<TreeBlob[]>;
    try {
      blobs = await this.deps.treeBlobs(cwd, sha);
    } catch (error) {
      blobs = { ok: false, reason: bounded(String(error)), outcomeUnknown: true };
    }
    if (blobs.ok) return claimFingerprint(claim, blobs.value);
    console.warn(`[worktrees] claim fingerprint unavailable for ${cwd}: ${blobs.reason}`);
    return null;
  }

  /**
   * The idle siblings a seed may copy from, best first: a fingerprint that matches the target
   * commit's exactly, then the most recently claimed successfully. Idle is exactly what
   * acquisition means by it, screened by the same code, so a sibling acquisition would refuse
   * is never a source. The main checkout is never a slot, so it is never a source.
   */
  private async seedSources(input: {
    pool: WorktreePoolRow;
    identity: WorktreeRepositoryIdentity;
    targetSlotId: string | null;
    fingerprint: string | null;
    exactOnly: boolean;
  }): Promise<Array<{ slot: WorktreeSlotRow; head: string }>> {
    const { fingerprint } = input;
    // Any sibling whose last claim succeeded is a fallback source, including one whose claim
    // lists no fingerprint paths and so recorded none. Only an exact match needs a fingerprint.
    const claimed = this.store.slots(input.pool.id).filter((slot) =>
      slot.id !== input.targetSlotId &&
      slot.state === "available" &&
      slot.depsState === "current" &&
      (!input.exactOnly || (fingerprint !== null && slot.depsFingerprint === fingerprint)));
    const screened = await this.screenIdleSlots(input.pool, input.identity, claimed);
    if (!screened.ok) return [];
    const rank = (slot: WorktreeSlotRow): number => (fingerprint !== null && slot.depsFingerprint === fingerprint ? 0 : 1);
    return screened.idle.sort((a, b) =>
      rank(a.slot) - rank(b.slot) ||
      (b.slot.depsClaimedAt ?? 0) - (a.slot.depsClaimedAt ?? 0) ||
      a.slot.ordinal - b.slot.ordinal);
  }

  /**
   * Lease one idle sibling to a `warm` owner, through the ordinary reservation and
   * `finalizeLease`, so nothing can lease, reset or quarantine it while it is copied. Null when
   * it is no longer idle. After its reservation it gets the same occupancy recheck an acquired
   * slot gets before its reset, with the same quarantine.
   */
  private async leaseSeedSource(
    pool: WorktreePoolRow,
    candidate: { slot: WorktreeSlotRow; head: string },
    ownerKey: string,
  ): Promise<NativeWorktreeLease | null> {
    const owner: WorktreeOwner = { kind: "warm", key: ownerKey };
    const leaseId = this.deps.randomId();
    let reservation: WorktreeSlotRow | null;
    try {
      reservation = await this.withPoolReservation(pool.gitCommonDirectory, async () =>
        this.store.reserveAvailable({
          slotId: candidate.slot.id,
          version: candidate.slot.version,
          leaseId,
          ownerKind: owner.kind,
          ownerKey: owner.key,
          requestedHeadSha: candidate.head,
          now: this.deps.now(),
        }));
    } catch (error) {
      console.warn(`[worktrees] seed source ${candidate.slot.path} could not be reserved: ${bounded(String(error))}`);
      return null;
    }
    if (!reservation) return null;
    const reserved = reservation;
    return this.withSlot(reserved.id, async () => {
      try {
        if (await this.enteredSinceReservation(reserved, "it was seeded from")) return null;
        const leased = this.store.finalizeLease(reserved.id, reserved.version, candidate.head, this.deps.now());
        if (!leased) {
          this.quarantine(reserved, "seed source lease lost its slot compare-and-swap");
          return null;
        }
        this.publish();
        return {
          slotId: leased.id,
          poolId: pool.id,
          path: leased.path,
          provider: "mission",
          leaseId,
          owner,
          baseSha: candidate.head,
          slotVersion: leased.version,
        };
      } catch (error) {
        this.quarantine(reserved, "seed source lease outcome is unknown", bounded(String(error)));
        return null;
      }
    });
  }

  /**
   * Seed `targetPath` from an idle sibling. The source is held under a `warm` lease for the
   * copy, and returned through the ordinary release path once the clone is staged, before
   * anything is renamed into the target. `begin` is the target's write-ahead, taken once a
   * source is held and before any clone starts.
   */
  private async seedTree(input: {
    pool: WorktreePoolRow;
    identity: WorktreeRepositoryIdentity;
    targetPath: string;
    targetSlotId: string | null;
    seed: WorktreeClaimSeed;
    fingerprint: string | null;
    exactOnly: boolean;
    ownerKey: string;
    signal: AbortSignal;
    deadline: number;
    begin: () => boolean;
  }): Promise<SeedRun> {
    this.liveWarmOwners.add(input.ownerKey);
    const stagingId = this.deps.randomId();
    const stagingDirectory = join(seedStagingRoot(input.pool.poolPath), stagingId);
    this.liveSeedStaging.add(stagingId);
    try {
      let source: NativeWorktreeLease | null = null;
      let sourceFingerprint: string | null = null;
      for (const candidate of await this.seedSources(input)) {
        if (input.signal.aborted) break;
        source = await this.leaseSeedSource(input.pool, candidate, input.ownerKey);
        if (source) {
          sourceFingerprint = candidate.slot.depsFingerprint;
          break;
        }
      }
      if (!source) return { kind: "none" };
      let staged: Awaited<ReturnType<typeof stageSeed>>;
      try {
        if (!input.begin()) return { kind: "unrecorded" };
        staged = await stageSeed({
          sourceRoot: source.path,
          targetRoot: input.targetPath,
          seed: input.seed,
          stagingDirectory,
          clone: this.deps.cloneTree,
          signal: input.signal,
          deadline: input.deadline,
          now: this.deps.now,
        });
      } finally {
        await this.returnSeedSource(source);
      }
      if (staged.kind === "abandoned") return { kind: "abandoned", reason: staged.reason };
      if (staged.kind !== "staged") return { kind: "interrupted", reason: SEED_ENDED[staged.kind] };
      // Placement watches the Stop and the deadline itself, before each rename and after the
      // last, so neither lands unseen once anything in the target may have changed.
      const placed = await placeSeed({
        targetRoot: input.targetPath,
        staged: staged.staged,
        stagingDirectory,
        signal: input.signal,
        deadline: input.deadline,
        now: this.deps.now,
        ...(this.deps.afterSeedRename ? { afterRename: this.deps.afterSeedRename } : {}),
        ...(this.deps.seedRename ? { rename: this.deps.seedRename } : {}),
      });
      // A seed an exclusion left a whole path out of did not place the source's tree, so it
      // inherits nothing and the steps run on top of what it did place.
      if (placed.ok) return { kind: "placed", fingerprint: staged.complete ? sourceFingerprint : null };
      // A rename that failed before anything in the target changed placed nothing: no seed.
      // The cold check fallback's tree can sit on another volume than the pool's staging, and
      // its first rename then fails with EXDEV; that must run the steps, not fail the claim.
      if ("reason" in placed && !placed.touched) {
        return { kind: "abandoned", reason: `the seed could not be placed: ${placed.reason}` };
      }
      return {
        kind: "interrupted",
        reason: "ended" in placed
          ? SEED_ENDED[placed.ended]
          : `did not run, because the dependency seed failed: ${placed.reason}`,
      };
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      this.liveSeedStaging.delete(stagingId);
      this.liveWarmOwners.delete(input.ownerKey);
    }
  }

  /**
   * Hand a seed source back through the ordinary owner-authorized release. A release that
   * cannot finish leaves the slot leased to a `warm` owner that stops being referenced as soon
   * as its seed ends, so the next reconciliation returns it, or quarantines it if in doubt.
   * Nothing is returned while the daemon stops: startup does that.
   */
  private async returnSeedSource(source: NativeWorktreeLease): Promise<void> {
    if (this.claims.stopping) return;
    try {
      const released = await this.release(source, { ownerAuthorized: true, requireClean: true });
      if (released.outcome !== "released" && released.outcome !== "alreadyReleased") {
        console.warn(`[worktrees] seed source ${source.path} was not returned: ${released.reason}`);
      }
    } catch (error) {
      console.warn(`[worktrees] seed source ${source.path} was not returned: ${bounded(String(error))}`);
    }
  }

  /**
   * A claim's write-ahead with no claim running behind it: the daemon that wrote it is gone.
   * The write already cleared the fingerprint, so nothing can skip on it; this records that the
   * claim was interrupted, and the slot's next claim starts cold. Called under the slot lock on
   * every reconciliation path, the pool-wide failure included, before any quarantine decision.
   */
  private markInterruptedClaim(slot: WorktreeSlotRow, now: number): void {
    if (!isDepsWriteAhead(slot.depsState) || this.claims.has(slot.id)) return;
    if (this.store.markClaimInterrupted(slot.id, now)) this.publish();
  }

  /** Shutdown: stop every running claim and start none. Called before anything else stops. */
  stopClaims(): void {
    this.claims.stopAll();
  }

  /**
   * Stop one running claim, found through the claim registry by its slot and its own id. The
   * step's process group is killed and the claim fails, so its acquire hands the slot over
   * with a warning, as for any failed claim: `deps_state` becomes `failed` and the next claim
   * reruns the steps in place. Null when that claim is no longer running.
   */
  stopClaim(slotId: string, claimId: string): RunningClaim | null {
    const stopped = this.claims.stop(slotId, claimId);
    if (stopped) {
      console.warn(
        `[worktrees] dependency claim stopped in slot ${slotId} (${stopped.owner.kind} ${stopped.owner.key})`,
      );
    }
    return stopped;
  }

  /**
   * Stop every claim a task's dispatch is waiting on, across all of its repositories. Task
   * cancel calls this once the task is cancelled, so the dispatch stops waiting the claim out
   * and tears down as it does for any cancel it notices.
   */
  stopTaskClaims(taskId: string): RunningClaim[] {
    const stopped = this.claims.stopOwned(
      (owner) => owner.kind === "task" && taskOwner(owner.key)?.taskId === taskId,
    );
    for (const claim of stopped) {
      console.warn(`[worktrees] dependency claim stopped in slot ${claim.slotId}: task ${taskId} was cancelled`);
    }
    return stopped;
  }

  /**
   * The claim a task's dispatch is waiting on right now, with the repository position it
   * belongs to, or null. A dispatch provisions its repositories one at a time, so at most one
   * of a task's claims runs at once.
   */
  runningTaskClaim(taskId: string): { claim: RunningClaim; position: number } | null {
    for (const claim of this.claims.list()) {
      if (claim.owner.kind !== "task") continue;
      const owner = taskOwner(claim.owner.key);
      if (owner?.taskId === taskId) return { claim, position: owner.position };
    }
    return null;
  }

  /** The claim running for exactly this owner right now, or null. */
  runningClaimFor(owner: WorktreeOwner): RunningClaim | null {
    return this.claims.list().find((claim) =>
      claim.owner.kind === owner.kind && claim.owner.key === owner.key) ?? null;
  }

  /** Told whenever any claim starts, moves to its next step, or ends. Returns the unsubscribe. */
  onClaimChange(listener: (claim: RunningClaim) => void): () => void {
    return this.claims.subscribe(listener);
  }

  /**
   * The pool's claim, run against a tree the pool does not own: the cold, disposable worktree
   * a check falls back to when the pool refuses it. The same steps, environment, deadline, Stop
   * and shutdown rules as a slot's claim. What it lacks is a slot row, so nothing is recorded
   * about it and nothing durable is written ahead: the tree was created for this one attempt
   * and is removed with it. It is therefore always cold, and seeds from an idle slot of the
   * repository's pool under the same rule as a slot, skipping its steps when that slot's
   * fingerprint is this commit's.
   *
   * Runs whenever the repository's policy carries a claim, whether or not native pooling is
   * enabled for it, since the claim describes the repository's dependencies rather than the
   * pool. It fails closed: a repository whose common directory or policy cannot be read is
   * `unproven`, never `none`, because only a policy that was read and has no claim says the
   * Command may run without one. The common directory comes from the pool's own identity when
   * that resolves, and from Git otherwise, so a repository the pool refuses because its
   * metadata is relocated still finds the claim configured for it.
   */
  async claimDisposableTree(input: {
    repositoryPath: string;
    path: string;
    baseSha: string;
    owner: WorktreeOwner;
    onClaimStart?: () => void;
    /** As for `acquire`: the claim follows it from the moment it registers. */
    signal?: AbortSignal;
  }): Promise<DisposableClaimResult> {
    const pooled = this.identity(input.repositoryPath)?.gitCommonDirectory;
    const commonDirectory = pooled
      ? { ok: true as const, value: pooled }
      : await gitCommonDirectory(input.repositoryPath);
    if (!commonDirectory.ok) {
      return {
        kind: "unproven",
        reason: `the repository's dependency claim could not be looked up: ${commonDirectory.reason}`,
      };
    }
    let claim: WorktreeClaim | null;
    try {
      claim = this.deps.resolvePolicy(commonDirectory.value).claim ?? null;
    } catch (error) {
      return {
        kind: "unproven",
        reason: `the repository's dependency claim could not be looked up: ${bounded(String(error))}`,
      };
    }
    if (!claim) return { kind: "none" };
    // Keyed by the tree's path, which no slot id can equal. Maintenance and the slot view look
    // only at slot ids, while shutdown and a run cancel find this claim like any other.
    const key = `disposable:${input.path}`;
    const control = this.claims.register(key, input.owner, this.deps.now());
    if (!control) return { kind: "unproven", reason: STOPPING_REASON };
    const unfollow = followSignal(input.signal, control);
    try {
      notifyClaimStart(input.onClaimStart);
      const deadline = this.deps.now() + claim.timeoutMinutes * 60_000;
      // Cold by definition: the tree has no slot row, so nothing about it is trusted. It seeds
      // under the same rule as a slot, from an idle slot of the repository's own pool.
      const seeded = await this.seedDisposableTree(input, claim, key, control.signal, deadline);
      if (seeded.kind === "interrupted") {
        if (this.claims.stopping) return { kind: "unproven", reason: STOPPED_REASON };
        console.warn(`[worktrees] dependency seed interrupted in ${input.path}: ${seeded.reason}`);
        return { kind: "failed", warning: notRunWarning(claim, seeded.reason), fingerprintPaths: [...claim.fingerprintPaths] };
      }
      if (seeded.kind === "abandoned") {
        console.warn(`[worktrees] dependency seed abandoned for ${input.path}: ${seeded.reason}`);
      }
      const outcome = seeded.kind === "current"
        ? { ok: true as const }
        : await runClaimSteps({
            claim,
            cwd: input.path,
            signal: control.signal,
            environment: this.deps.claimEnvironment,
            runStep: this.deps.runClaimStep,
            now: this.deps.now,
            deadline,
            onStep: (step) => this.claims.progress(key, control, step),
          });
      if (!outcome.ok && this.claims.stopping) return { kind: "unproven", reason: STOPPED_REASON };
      if (!outcome.ok) {
        // A failed claim is reported as one, with its tail, even when the step also left the
        // tree dirty: the Command does not run either way, and the tree is removed with the
        // attempt, so the proof below has nothing left to protect.
        const summary = describeClaimFailure(outcome.warning).split("\n", 1)[0];
        console.warn(`[worktrees] dependency claim failed in ${input.path}: ${summary}`);
        return { kind: "failed", warning: outcome.warning, fingerprintPaths: [...claim.fingerprintPaths] };
      }
      // The same proof a slot takes before its grant, asked of Git directly because this tree
      // is not the pool's: a step that rewrote a tracked file, left an untracked file Git does
      // not ignore, moved HEAD or attached a branch has left a tree the Command must not run in.
      const proof = await proveDisposableTree(input.path, input.baseSha);
      if (proof) return { kind: "unproven", reason: `${proof} after its dependency claim` };
      return { kind: "succeeded" };
    } finally {
      unfollow();
      this.claims.unregister(key, control);
    }
  }

  /**
   * The cold check fallback's seed. Its tree has no slot row, so there is no write-ahead to
   * take: the tree was made for this one attempt and is removed with it. A seed whose source's
   * fingerprint is this commit's is `current`, and the steps are skipped as they would be for a
   * slot.
   */
  private async seedDisposableTree(
    input: { repositoryPath: string; path: string; baseSha: string },
    claim: WorktreeClaim,
    registryKey: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ kind: "none" | "current" | "steps" } | { kind: "abandoned" | "interrupted"; reason: string }> {
    if (!claim.seed) return { kind: "none" };
    const identity = this.identity(input.repositoryPath);
    if (!identity) return { kind: "none" };
    const pool = this.store.poolByCommonDirectory(identity.gitCommonDirectory);
    if (!pool) return { kind: "none" };
    let enabled = false;
    try {
      enabled = this.deps.resolvePolicy(identity.gitCommonDirectory).enabled;
    } catch {
      enabled = false;
    }
    if (!enabled) return { kind: "none" };
    const fingerprint = await this.commitFingerprint(input.path, claim, input.baseSha);
    const seeded = await this.seedTree({
      pool,
      identity,
      targetPath: input.path,
      targetSlotId: null,
      seed: claim.seed,
      fingerprint,
      exactOnly: false,
      ownerKey: this.claims.get(registryKey)?.id ?? this.deps.randomId(),
      signal,
      deadline,
      begin: () => true,
    });
    switch (seeded.kind) {
      case "none":
      case "unrecorded":
        return { kind: "none" };
      case "abandoned":
      case "interrupted":
        return { kind: seeded.kind, reason: seeded.reason };
      case "placed":
        return fingerprint !== null && seeded.fingerprint === fingerprint ? { kind: "current" } : { kind: "steps" };
    }
  }

  /**
   * Resolve durable consumer identity back to the allocator's full compare-and-swap lease.
   * Task and check rows intentionally persist only the random lease ID; slot/version remain
   * allocator facts and are re-read immediately before release.
   */
  lookupLease(input: {
    leaseId?: string;
    path?: string;
    owner?: WorktreeOwner;
  }): NativeLeaseLookup {
    const slot = input.leaseId
      ? this.store.slotByLeaseId(input.leaseId)
      : input.path
        ? this.store.slotByPath(resolve(input.path))
        : null;
    if (!slot) return { state: "missing" };
    if (input.path && slot.path !== resolve(input.path)) {
      return { state: "mismatch", reason: "lease path no longer matches the native slot" };
    }
    const active = activeReference(slot);
    const released = lastReference(slot);
    if (active === "invalid" || released === "invalid") {
      return { state: "mismatch", reason: "native lease identity is incomplete" };
    }
    const wanted = input.leaseId ?? active?.leaseId;
    const match = active?.leaseId === wanted ? active : released?.leaseId === wanted ? released : null;
    if (!match) return { state: "mismatch", reason: "lease ID is not active or last released" };
    if (
      input.owner &&
      (match.owner.kind !== input.owner.kind || match.owner.key !== input.owner.key)
    ) {
      return { state: "mismatch", reason: "native lease owner no longer matches" };
    }
    const pool = this.store.poolForSlot(slot.id);
    if (!pool) return { state: "mismatch", reason: "native lease pool no longer exists" };
    const baseSha = slot.requestedHeadSha ?? slot.currentHeadSha;
    if (!baseSha || !SHA.test(baseSha)) {
      return { state: "mismatch", reason: "native lease exact commit is unavailable" };
    }
    return {
      state: match === active ? "active" : "released",
      lease: {
        slotId: slot.id,
        poolId: pool.id,
        path: slot.path,
        provider: "mission",
        leaseId: match.leaseId,
        owner: match.owner,
        baseSha,
        slotVersion: slot.version,
      },
    };
  }

  async release(
    lease: NativeWorktreeLease,
    options: {
      ownerAuthorized?: boolean;
      requireClean?: boolean;
      /** Task policy rechecked under the slot lock, after all provider awaits. */
      beforeReset?: () => Promise<string | null>;
    } = {},
  ): Promise<WorktreeReleaseResult> {
    if (lease.provider !== "mission") return { outcome: "refused", reason: "lease provider is not mission" };
    if (!this.store.poolForSlot(lease.slotId)) return { outcome: "refused", reason: "native slot no longer exists" };
    return this.withSlot(lease.slotId, () => this.releaseLocked(lease, options));
  }

  /** `release`, for a caller that already holds this slot's lock. */
  private async releaseLocked(
    lease: NativeWorktreeLease,
    options: Parameters<WorktreeManager["release"]>[1] = {},
  ): Promise<WorktreeReleaseResult> {
    const pool = this.store.poolForSlot(lease.slotId);
    if (!pool) return { outcome: "refused", reason: "native slot no longer exists" };
    const slot = this.store.slot(lease.slotId);
    if (!slot) return { outcome: "refused", reason: "native slot no longer exists" };
    if (
      slot.lastReleasedLeaseId === lease.leaseId &&
      slot.lastReleasedOwnerKind === lease.owner.kind &&
      slot.lastReleasedOwnerKey === lease.owner.key
    ) {
      return { outcome: "alreadyReleased" };
    }
    // Quarantine blocks reuse, not exact owner-authorized disposal. Destroy first asks
    // the domain owner to release its lease, and every path, marker, registration,
    // process, and Git check below is repeated before the reset intent is persisted.
    // Refusing solely because a prior observation was uncertain made an exact
    // quarantined lease impossible to destroy through the only UI that offers it.
    if (
      (slot.state !== "leased" && slot.state !== "quarantined") ||
      slot.activeLeaseId !== lease.leaseId ||
      slot.activeOwnerKind !== lease.owner.kind ||
      slot.activeOwnerKey !== lease.owner.key ||
      slot.version !== lease.slotVersion
    ) {
      return { outcome: "refused", reason: "slot, lease ID, owner, or observed version no longer matches" };
    }
    const reference = activeReference(slot);
    if (!reference || reference === "invalid") {
      return { outcome: "refused", reason: "active lease identity is incomplete or invalid" };
    }
    const initialBlocker = options.ownerAuthorized
      ? await this.occupancyBlocker(slot.path)
      : await this.releaseBlocker(reference, slot.path);
    if (initialBlocker) return { outcome: "refused", reason: initialBlocker };

    const identity = this.identity(pool.mainCheckoutRoot);
    if (!identity || !exactSlotPath(pool, identity, slot)) {
      return { outcome: "refused", reason: "pool repository identity can no longer be proven" };
    }
    const marker = await readWorktreePoolMarker(pool.poolPath);
    if (marker?.poolId !== pool.id) {
      return { outcome: "refused", reason: "native pool marker is missing or does not match" };
    }
    let target: Awaited<ReturnType<WorktreeGit["fetchDefaultSha"]>>;
    try {
      target = await this.deps.git.fetchDefaultSha(identity);
    } catch (error) {
      return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
    }
    if (!target.ok) {
      return target.outcomeUnknown
        ? { outcome: "outcomeUnknown", reason: target.reason }
        : { outcome: "refused", reason: target.reason };
    }
    const resetTarget = await this.validateResetTarget(pool, identity, slot);
    if (!resetTarget.ok) {
      return resetTarget.outcomeUnknown
        ? { outcome: "outcomeUnknown", reason: resetTarget.reason }
        : { outcome: "refused", reason: resetTarget.reason };
    }
    // Fetch and target validation may take long enough for a process or domain reference
    // to appear. Re-read both immediately before persisting the destructive reset intent.
    const freshBlocker = options.ownerAuthorized
      ? await this.occupancyBlocker(slot.path)
      : await this.releaseBlocker(reference, slot.path);
    if (freshBlocker) return { outcome: "refused", reason: freshBlocker };
    if (options.requireClean) {
      let clean: Awaited<ReturnType<WorktreeGit["inspect"]>>;
      try {
        clean = await this.deps.git.inspect(slot.path);
      } catch (error) {
        return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
      }
      if (!clean.ok) {
        return clean.outcomeUnknown
          ? { outcome: "outcomeUnknown", reason: clean.reason }
          : { outcome: "refused", reason: clean.reason };
      }
      if (clean.value.dirty) {
        return { outcome: "refused", reason: "manual worktree is dirty" };
      }
    }
    const policyBlocker = await options.beforeReset?.();
    if (policyBlocker) return { outcome: "refused", reason: policyBlocker };
    let returning: WorktreeSlotRow | null;
    try {
      returning = this.store.markReturning(slot.id, slot.version, target.value, this.deps.now());
    } catch (error) {
      return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
    }
    if (!returning) return { outcome: "outcomeUnknown", reason: "return intent could not be persisted" };
    let reset: Awaited<ReturnType<WorktreeGit["reset"]>>;
    try {
      reset = await this.deps.git.reset(slot.path, target.value);
    } catch (error) {
      const reason = bounded(String(error));
      this.quarantine(returning, "return reset failed", reason);
      return { outcome: "outcomeUnknown", reason };
    }
    if (!reset.ok) {
      this.quarantine(returning, "return reset failed", reset.reason);
      return { outcome: "outcomeUnknown", reason: reset.reason };
    }
    let inspected: Awaited<ReturnType<WorktreeGit["inspect"]>>;
    try {
      inspected = await this.deps.git.inspect(slot.path);
    } catch (error) {
      const reason = bounded(String(error));
      this.quarantine(returning, "return verification failed", reason);
      return { outcome: "outcomeUnknown", reason };
    }
    if (
      !inspected.ok ||
      inspected.value.path !== slot.path ||
      inspected.value.head !== target.value ||
      inspected.value.dirty ||
      inspected.value.commonDirectory !== pool.gitCommonDirectory ||
      // A slot goes back into the warm pool holding no branch, so the next acquisition
      // starts from the same shape a brand-new slot does. Proved here as well as at
      // acquisition because the two transitions are days apart in wall-clock time and
      // either one alone would let an attached slot sit in the pool looking available.
      !inspected.value.detached
    ) {
      const reason = inspected.ok ? "returned slot failed exact verification" : inspected.reason;
      this.quarantine(returning, "return verification failed", reason);
      return { outcome: "outcomeUnknown", reason };
    }
    let available: WorktreeSlotRow | null;
    try {
      available = this.store.completeRelease(
        returning.id,
        returning.version,
        target.value,
        this.deps.now(),
      );
    } catch (error) {
      return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
    }
    if (!available) return { outcome: "outcomeUnknown", reason: "completed return could not be recorded" };
    this.publish();
    return { outcome: "released" };
  }

  async reconcile(): Promise<void> {
    await this.runChangeBatch(async () => {
      for (const pool of this.store.pools()) {
        await this.reconcilePool(pool);
      }
    }, false);
  }

  /**
   * Remove seed staging no live seed owns. It needs none of the pool's Git or marker proofs,
   * because it touches no checkout: only `<pool>/.seed-staging`, and only when the pool's
   * durable directory lies inside this daemon's pools directory and the staging root is a real
   * directory there, never a symlink out of it.
   */
  private async removeLeftoverSeedStaging(pool: WorktreePoolRow): Promise<void> {
    const root = seedStagingRoot(pool.poolPath);
    try {
      // The pool's durable path is physical (its identity resolves the pools directory's parent),
      // so it is compared with the pools directory spelled the same way.
      const poolsDirectory = join(await realpath(dirname(this.deps.poolsDirectory)), basename(this.deps.poolsDirectory));
      if (!pathContains(poolsDirectory, pool.poolPath) || resolve(pool.poolPath) === poolsDirectory) return;
      const stat = await lstat(root).catch(() => null);
      if (!stat?.isDirectory() || (await realpath(root)) !== resolve(root)) return;
      await removeLeftoverStaging(pool.poolPath, this.liveSeedStaging);
    } catch (error) {
      console.warn(`[worktrees] leftover seed staging in ${pool.poolPath} could not be removed: ${bounded(String(error))}`);
    }
  }

  async reconcilePoolById(poolId: string): Promise<boolean> {
    const pool = this.store.pool(poolId);
    if (!pool) return false;
    await this.reconcilePool(pool);
    return true;
  }

  private async reconcilePool(pool: WorktreePoolRow): Promise<void> {
    // First, before any check that can fail the whole pool: staging is what a crash left, and a
    // pool whose identity or marker cannot be proven is exactly the one nobody will clean up.
    await this.removeLeftoverSeedStaging(pool);
    const now = this.deps.now();
    const identity = this.identity(pool.mainCheckoutRoot);
    const slots = this.store.slots(pool.id);
    // A slot whose claim holds its lock is skipped, never waited on: a claim may run for hours,
    // and maintenance reschedules only once a pass finishes. The next pass retries it.
    const skipped: string[] = [];
    const skipClaiming = (slot: WorktreeSlotRow): boolean => {
      if (!this.claims.has(slot.id)) return false;
      skipped.push(`slot ${slot.ordinal}: skipped while its dependency claim runs`);
      return true;
    };
    const failPool = async (reason: string) => {
      for (const original of slots) {
        if (skipClaiming(original)) continue;
        const releaseSlot = await this.acquireSlotLock(original.id);
        try {
          const slot = this.store.slot(original.id);
          if (slot) this.markInterruptedClaim(slot, now);
          if (slot?.version === original.version && slot.state !== "quarantined") {
            this.quarantine(slot, reason);
          }
        } finally {
          releaseSlot();
        }
      }
      this.store.recordReconciliation(pool.id, now, bounded([reason, ...skipped].join("; ")));
    };
    if (
      !identity ||
      identity.gitCommonDirectory !== pool.gitCommonDirectory ||
      identity.poolPath !== pool.poolPath
    ) {
      await failPool("pool repository identity no longer matches its durable row");
      return;
    }
    const marker = await readWorktreePoolMarker(pool.poolPath);
    if (marker?.poolId !== pool.id) {
      await failPool("pool marker is missing, unreadable, or belongs to another pool");
      return;
    }
    let listed: Awaited<ReturnType<WorktreeGit["list"]>>;
    try {
      listed = await this.deps.git.list(identity);
    } catch (error) {
      await failPool(`Git worktree registrations are unknown: ${bounded(String(error))}`);
      return;
    }
    if (!listed.ok) {
      await failPool(`Git worktree registrations are unknown: ${listed.reason}`);
      return;
    }
    const occupancy = await this.occupancy(
      slots.filter((slot) => existsSync(slot.path)).map((slot) => slot.path),
    );
    const errors: string[] = [];
    for (const original of slots) {
      if (skipClaiming(original)) continue;
      const releaseSlot = await this.acquireSlotLock(original.id);
      try {
        const current = this.store.slot(original.id);
        if (current) this.markInterruptedClaim(current, now);
        if (!current || current.version !== original.version) continue;
        const slot = current;
        const reject = (reason: string, detail: string | null = null) => {
          if (slot.state !== "quarantined") this.quarantine(slot, reason, detail);
          errors.push(`slot ${slot.ordinal}: ${reason}`);
        };
        if (!WORKTREE_SLOT_STATES.includes(slot.state as (typeof WORKTREE_SLOT_STATES)[number])) {
          reject(`unknown append-only slot state ${JSON.stringify(slot.state)}`);
          continue;
        }
        if (!exactSlotPath(pool, identity, slot)) {
          reject("slot path is not the exact path owned by its native pool");
          continue;
        }
        const registration = registrationFor(listed.value, slot.path);
        if (slot.state === "pruning" && !existsSync(slot.path) && !registration) {
          if (!this.store.removePruned(slot.id, slot.version)) errors.push(`slot ${slot.ordinal}: prune completion raced`);
          else this.publish();
          continue;
        }
        if (!existsSync(slot.path) || !registration) {
          reject("slot path or Git registration is missing");
          continue;
        }
        if (registration.bare || registration.locked || registration.prunable) {
          reject("slot Git registration is bare, locked, or prunable");
          continue;
        }
        let inspection: Awaited<ReturnType<WorktreeGit["inspect"]>>;
        try {
          inspection = await this.deps.git.inspect(slot.path);
        } catch (error) {
          reject("slot Git state is unknown", String(error));
          continue;
        }
        if (!inspection.ok) {
          reject("slot Git state is unknown", inspection.reason);
          continue;
        }
        if (
          inspection.value.path !== slot.path ||
          inspection.value.commonDirectory !== pool.gitCommonDirectory
        ) {
          reject("slot belongs to a different Git common directory");
          continue;
        }
        const observedOccupancy = occupancy.get(slot.path) ?? {
          status: "unknown" as const,
          reason: "slot occupancy was not observed",
        };
        if (observedOccupancy.status === "unknown") {
          reject("slot process occupancy is unknown", observedOccupancy.reason);
          continue;
        }

        if (slot.state === "quarantined") {
          this.store.updateObserved(slot.id, inspection.value.head, slot.lastError, now);
          continue;
        }
        if (slot.state === "provisioning") {
          reject("startup found an interrupted provisioning intent");
          continue;
        }
        if (slot.state === "pruning") {
          reject("startup found an interrupted prune with filesystem state still present");
          continue;
        }
        if (slot.state === "returning") {
          const returningReference = activeReference(slot);
          if (!returningReference || returningReference === "invalid") {
            reject("interrupted return has incomplete active lease identity");
            continue;
          }
          if (observedOccupancy.occupants.length > 0 || inspection.value.dirty) {
            reject("interrupted return is occupied or dirty");
            continue;
          }
          if (!slot.requestedHeadSha || inspection.value.head !== slot.requestedHeadSha) {
            reject("interrupted return did not reach its requested exact HEAD");
            continue;
          }
          const completed = this.store.completeRelease(slot.id, slot.version, inspection.value.head, now);
          if (!completed) errors.push(`slot ${slot.ordinal}: proven return completion raced`);
          else this.publish();
          continue;
        }
        if (slot.state === "available") {
          const active = activeReference(slot);
          if (active !== null) {
            reject(
              active === "invalid"
                ? "available slot has incomplete active lease identity"
                : "available slot still carries active lease identity",
            );
            continue;
          }
          if (observedOccupancy.occupants.length > 0 || inspection.value.dirty) {
            reject("available slot is occupied or dirty");
            continue;
          }
          if (slot.currentHeadSha && slot.currentHeadSha !== inspection.value.head) {
            reject("available slot HEAD moved outside an allocator transition");
            continue;
          }
          const prior = lastReference(slot);
          if (prior === "invalid") {
            reject("last-released lease identity is incomplete");
            continue;
          }
          try {
            if (prior && (await this.ownerReferenced(prior))) {
              // Release completed before the domain row cleared. Preserve this exact,
              // idempotently releasable state while keeping it unavailable to acquisition.
              this.store.updateObserved(slot.id, inspection.value.head, null, now);
              continue;
            }
          } catch (error) {
            reject("last-released domain ownership is unknown", String(error));
            continue;
          }
          this.store.updateObserved(slot.id, inspection.value.head, null, now);
          continue;
        }

        // A valid active lease can legitimately be dirty and occupied after restart. Exact
        // durable owner identity keeps it leased; only an unknown scan or stale reference is
        // quarantined. This preserves live work while still preventing reuse.
        const active = activeReference(slot);
        if (!active || active === "invalid") {
          reject("leased slot has incomplete active identity");
          continue;
        }
        if (active.owner.kind === "warm" && !(await this.ownerReferenced(active))) {
          // A Warm target or a seed source whose operation is gone: no Warm or seed survives a
          // restart, so this is definite. The ordinary owner-authorized return runs, with its
          // occupancy check, its reset to origin's default and its clean, detached proof. A
          // target's cut-off claim was recorded as interrupted above; a source was only read,
          // so its fingerprint stands. Anything the return cannot prove is quarantined.
          const returned = await this.releaseLocked(
            {
              slotId: slot.id,
              poolId: pool.id,
              path: slot.path,
              provider: "mission",
              leaseId: active.leaseId,
              owner: active.owner,
              baseSha: inspection.value.head,
              slotVersion: slot.version,
            },
            { ownerAuthorized: true, requireClean: true },
          );
          if (returned.outcome !== "released" && returned.outcome !== "alreadyReleased") {
            reject("an interrupted warm lease could not be returned", returned.reason);
          }
          continue;
        }
        try {
          if (!(await this.ownerReferenced(active))) {
            reject("leased slot has no matching domain owner reference");
            continue;
          }
        } catch (error) {
          reject("leased domain ownership is unknown", String(error));
          continue;
        }
        this.store.updateObserved(slot.id, inspection.value.head, null, now);
      } finally {
        releaseSlot();
      }
    }
    const record = [...errors, ...skipped];
    this.store.recordReconciliation(pool.id, now, record.length > 0 ? bounded(record.join("; ")) : null);
  }

  /**
   * Observations never overlap, and within one the process read finishes before any Git read
   * starts. Occupancy is "a process whose cwd is inside the slot", and `git -C <slot>` runs
   * with exactly that cwd: a process read taken while this daemon's own Git reads are in
   * flight - from this observation or a concurrent one - sees them as occupants. A slot then
   * looks occupied for a moment, a preview and its recheck disagree, and a cleanup is refused
   * as stale for a change that was only ever us looking.
   */
  async status(): Promise<NativePoolStatus[]> {
    return this.withObservation(() => this.observeStatus());
  }

  private withObservation<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock("observation", operation);
  }

  private async observeStatus(): Promise<NativePoolStatus[]> {
    const pools = this.store.pools();
    const allSlots = this.store.slots();
    // `occupancy()` turns any failure into unknown occupancy for every slot, which blocks
    // cleanup rather than permitting it, and it is awaited here before anything else starts.
    const occupancy = await this.occupancy(
      allSlots.filter((slot) => existsSync(slot.path)).map((slot) => slot.path),
    );
    const output: NativePoolStatus[] = [];
    for (const pool of pools) {
      const identity = this.identity(pool.mainCheckoutRoot);
      const identityValid = Boolean(
        identity &&
        identity.gitCommonDirectory === pool.gitCommonDirectory &&
        identity.poolPath === pool.poolPath,
      );
      const marker = await readWorktreePoolMarker(pool.poolPath);
      const markerValid = marker?.poolId === pool.id;
      let listed: Awaited<ReturnType<WorktreeGit["list"]>> | null = null;
      let observedDefaultSha: string | null = null;
      if (identityValid && identity) {
        const [registrations, observed] = await Promise.all([
          (async () => this.deps.git.list(identity))().catch(() => null),
          (async () => this.deps.git.observedDefaultSha(identity))().catch(() => null),
        ]);
        listed = registrations;
        if (observed?.ok) observedDefaultSha = observed.value;
      }
      // Each slot's reads are independent Git processes, so a pool of sixteen slots is
      // observed concurrently rather than as sixteen serial waits. Order is preserved.
      const slots = await mapBounded(allSlots.filter((candidate) => candidate.poolId === pool.id), SLOT_OBSERVATION_CONCURRENCY, async (slot): Promise<NativeSlotStatus> => {
        let inspection: Awaited<ReturnType<WorktreeGit["inspect"]>> | null = null;
        if (existsSync(slot.path)) {
          try {
            inspection = await this.deps.git.inspect(slot.path);
          } catch {
            inspection = null;
          }
        }
        const active = activeReference(slot);
        const priorReference = lastReference(slot);
        const invalidReference = active === "invalid" || priorReference === "invalid";
        const reference = invalidReference ? null : active ?? priorReference;
        let referenced: boolean | null = invalidReference ? null : false;
        if (reference) {
          try {
            referenced = await this.ownerReferenced(reference);
          } catch {
            referenced = null;
          }
        }
        const nativePath = Boolean(identity && exactSlotPath(pool, identity, slot));
        const registration = listed?.ok === true
          ? registrationFor(listed.value, slot.path)
          : null;
        let mergedIntoDefault: boolean | null = null;
        if (inspection?.ok === true && observedDefaultSha) {
          try {
            const merged = await this.deps.git.mergedInto(slot.path, observedDefaultSha);
            if (merged.ok) mergedIntoDefault = merged.value;
          } catch {}
        }
        return {
          slot,
          nativePath,
          registered: listed?.ok === true
            ? Boolean(registration && !registration.bare && !registration.locked && !registration.prunable)
            : null,
          repositoryMatches: inspection?.ok === true
            ? nativePath &&
              inspection.value.path === slot.path &&
              inspection.value.commonDirectory === pool.gitCommonDirectory
            : null,
          observedHead: inspection?.ok === true ? inspection.value.head : null,
          dirty: inspection?.ok === true ? inspection.value.dirty : null,
          occupancy: occupancy.get(slot.path) ?? { status: "unknown", reason: "path is missing" },
          ownerReferenced: referenced,
          mergedIntoDefault,
        };
      });
      const policy = this.deps.resolvePolicy(pool.gitCommonDirectory);
      output.push({
        pool,
        policy,
        identityValid,
        markerValid,
        observedDefaultSha,
        defaultFingerprint: identityValid && identity
          ? await this.defaultFingerprint(pool.id, identity.mainCheckoutRoot, policy.claim ?? null, observedDefaultSha)
          : null,
        slots,
      });
    }
    return output;
  }

  /**
   * The claim's fingerprint at the cached default-branch commit, read from objects in the
   * main checkout. An unreadable tree is not cached, so the next observation tries again.
   */
  private async defaultFingerprint(
    poolId: string,
    mainCheckoutRoot: string,
    claim: WorktreeClaim | null,
    defaultSha: string | null,
  ): Promise<string | null> {
    if (!claim || claim.fingerprintPaths.length === 0 || !defaultSha) {
      this.defaultFingerprints.delete(poolId);
      return null;
    }
    const key = JSON.stringify([defaultSha, claim]);
    const cached = this.defaultFingerprints.get(poolId);
    if (cached?.key === key) return cached.fingerprint;
    let blobs: GitResult<TreeBlob[]>;
    try {
      blobs = await this.deps.treeBlobs(mainCheckoutRoot, defaultSha);
    } catch {
      return null;
    }
    if (!blobs.ok) return null;
    const fingerprint = claimFingerprint(claim, blobs.value);
    this.defaultFingerprints.set(poolId, { key, fingerprint });
    return fingerprint;
  }

  /**
   * Remove one exact manager-owned slot after rechecking every destructive boundary.
   * Dirty or unmerged work may be explicitly acknowledged; unknown identity, ownership,
   * registration, or process state is never overrideable.
   */
  async removeSlot(input: {
    slotId: string;
    expectedVersion?: number;
    allowDirty: boolean;
    allowUnmerged: boolean;
  }): Promise<WorktreeRemoveResult> {
    // Its occupancy checks take the observation lock for the process read alone (see
    // `occupancyBlocker`). The Git removal itself is not under it: a slow `git worktree
    // remove` must never make an unrelated preview wait. Lock order is slot, then
    // observation; nothing holding the observation lock takes a slot lock.
    return this.withSlot(input.slotId, async () => {
      const slot = this.store.slot(input.slotId);
      if (!slot) return { outcome: "alreadyRemoved" };
      if (input.expectedVersion !== undefined && slot.version !== input.expectedVersion) {
        return { outcome: "conflict", reason: "slot version changed after preview" };
      }
      if (slot.state !== "available" && slot.state !== "quarantined") {
        return { outcome: "refused", reason: `slot is ${slot.state}, not removable` };
      }
      const active = activeReference(slot);
      if (active !== null) {
        return { outcome: "refused", reason: "slot still carries active lease identity" };
      }
      const prior = lastReference(slot);
      if (prior === "invalid") {
        return { outcome: "refused", reason: "last-released lease identity is incomplete" };
      }
      if (prior) {
        try {
          if (await this.ownerReferenced(prior)) {
            return { outcome: "refused", reason: "domain owner still references this lease" };
          }
        } catch (error) {
          return { outcome: "outcomeUnknown", reason: `domain ownership is unknown: ${bounded(String(error))}` };
        }
      }
      const blocker = await this.occupancyBlocker(slot.path);
      if (blocker) return { outcome: "refused", reason: blocker };
      const pool = this.store.poolForSlot(slot.id);
      if (!pool) return { outcome: "refused", reason: "native slot pool no longer exists" };
      const identity = this.identity(pool.mainCheckoutRoot);
      if (!identity || !exactSlotPath(pool, identity, slot)) {
        return { outcome: "refused", reason: "pool repository identity can no longer be proven" };
      }
      const marker = await readWorktreePoolMarker(pool.poolPath);
      if (marker?.poolId !== pool.id) {
        return { outcome: "refused", reason: "native pool marker is missing or does not match" };
      }
      let observed: [
        Awaited<ReturnType<WorktreeGit["list"]>>,
        Awaited<ReturnType<WorktreeGit["inspect"]>>,
        Awaited<ReturnType<WorktreeGit["observedDefaultSha"]>>,
      ];
      try {
        observed = await Promise.all([
          this.deps.git.list(identity),
          this.deps.git.inspect(slot.path),
          this.deps.git.observedDefaultSha(identity),
        ]);
      } catch (error) {
        return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
      }
      const [listed, inspection, target] = observed;
      if (!listed.ok) return { outcome: listed.outcomeUnknown ? "outcomeUnknown" : "refused", reason: listed.reason };
      const registration = registrationFor(listed.value, slot.path);
      if (!registration || registration.bare || registration.locked || registration.prunable) {
        return { outcome: "refused", reason: "slot has no safe Git worktree registration" };
      }
      if (!inspection.ok) {
        return { outcome: inspection.outcomeUnknown ? "outcomeUnknown" : "refused", reason: inspection.reason };
      }
      if (inspection.value.path !== slot.path || inspection.value.commonDirectory !== pool.gitCommonDirectory) {
        return { outcome: "refused", reason: "slot repository ownership is not proven" };
      }
      if (inspection.value.dirty && !input.allowDirty) {
        return { outcome: "refused", reason: "slot is dirty" };
      }
      if (!target.ok) {
        return { outcome: target.outcomeUnknown ? "outcomeUnknown" : "refused", reason: target.reason };
      }
      let merged: Awaited<ReturnType<WorktreeGit["mergedInto"]>>;
      try {
        merged = await this.deps.git.mergedInto(slot.path, target.value);
      } catch (error) {
        return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
      }
      if (!merged.ok) {
        return { outcome: merged.outcomeUnknown ? "outcomeUnknown" : "refused", reason: merged.reason };
      }
      if (!merged.value && !input.allowUnmerged) {
        return { outcome: "refused", reason: "slot HEAD is not merged into the observed remote default" };
      }
      const finalBlocker = await this.occupancyBlocker(slot.path);
      if (finalBlocker) return { outcome: "refused", reason: finalBlocker };
      const pruning = this.store.markPruning(slot.id, slot.version, this.deps.now());
      if (!pruning) return { outcome: "conflict", reason: "prune intent lost its slot compare-and-swap" };
      this.publish();
      let removed: Awaited<ReturnType<WorktreeGit["remove"]>>;
      try {
        removed = await this.deps.git.remove(identity, slot.path, inspection.value.dirty);
      } catch (error) {
        return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
      }
      if (!removed.ok) {
        return { outcome: "outcomeUnknown", reason: removed.reason };
      }
      let after: Awaited<ReturnType<WorktreeGit["list"]>>;
      try {
        after = await this.deps.git.list(identity);
      } catch (error) {
        return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
      }
      if (!after.ok) {
        return { outcome: "outcomeUnknown", reason: after.reason };
      }
      if (existsSync(slot.path) || registrationFor(after.value, slot.path)) {
        this.quarantine(pruning, "worktree removal could not be verified");
        return { outcome: "outcomeUnknown", reason: "worktree removal could not be verified" };
      }
      if (!this.store.removePruned(pruning.id, pruning.version)) {
        return { outcome: "outcomeUnknown", reason: "removed worktree row could not be settled" };
      }
      this.publish();
      return { outcome: "removed" };
    });
  }

  /** Preview-only safe prune and right-size candidates. No filesystem mutation occurs. */
  async planMaintenance(): Promise<NativeMaintenanceCandidate[]> {
    const status = await this.status();
    const candidates: NativeMaintenanceCandidate[] = [];
    for (const poolStatus of status) {
      const overCapacity = Math.max(0, poolStatus.slots.length - poolStatus.policy.maxSlots);
      const rightSizeIds = new Set(
        [...poolStatus.slots]
          .sort((a, b) => b.slot.ordinal - a.slot.ordinal)
          .slice(0, overCapacity)
          .map((entry) => entry.slot.id),
      );
      for (const entry of poolStatus.slots) {
        let reason: string | null = null;
        if (!poolStatus.identityValid) reason = "pool repository identity is not proven";
        else if (!poolStatus.markerValid) reason = "native pool marker is not proven";
        else if (!entry.nativePath) reason = "slot path is outside its exact native pool location";
        else if (entry.repositoryMatches !== true) reason = "slot repository ownership is not proven";
        else if (entry.slot.state !== "available") reason = `slot is ${entry.slot.state}`;
        else if (entry.ownerReferenced !== false) reason = "domain ownership is referenced or unknown";
        else if (entry.registered !== true) reason = "Git registration is not proven";
        else if (entry.dirty !== false) reason = "slot cleanliness is not proven";
        else if (entry.occupancy.status === "unknown") reason = entry.occupancy.reason;
        else if (entry.occupancy.occupants.length > 0) reason = "slot is occupied";
        else if (!poolStatus.observedDefaultSha) reason = "remote default branch is unknown";
        else if (entry.mergedIntoDefault !== true) {
          reason = entry.mergedIntoDefault === false
            ? "slot HEAD is not merged into the observed remote default"
            : "slot merge relationship is unknown";
        }
        candidates.push({
          poolId: poolStatus.pool.id,
          slotId: entry.slot.id,
          slotVersion: entry.slot.version,
          path: entry.slot.path,
          rightSize: rightSizeIds.has(entry.slot.id),
          safe: reason === null,
          reason,
        });
      }
    }
    return candidates;
  }

  startMaintenance(reclaimDomainLeases: () => Promise<void> = async () => {}): void {
    this.reclaimDomainLeases = reclaimDomainLeases;
    this.stopped = false;
    this.claims.resume();
    this.manualRequests.resume();
    const interval = worktreeSweepIntervalMs();
    if (interval === null || this.timer) return;
    const schedule = () => {
      if (this.stopped) return;
      this.timer = unref(setTimeout(() => {
        this.timer = null;
        this.maintenance = this.runMaintenance().finally(() => {
          this.maintenance = null;
          schedule();
        });
      }, interval));
    };
    schedule();
  }

  private async runMaintenance(): Promise<void> {
    let hasNativePools = false;
    try {
      hasNativePools = this.store.poolCount() > 0;
    } catch (error) {
      console.error("[worktrees] maintenance could not read native pools:", error);
    }
    if (hasNativePools) {
      try {
        await this.reconcile();
      } catch (error) {
        console.error("[worktrees] maintenance reconciliation failed:", error);
      }
    }
    try {
      await this.reclaimDomainLeases();
    } catch (error) {
      console.error("[worktrees] domain lease reclamation failed:", error);
    }
  }

  async stop(): Promise<void> {
    this.stopClaims();
    this.manualRequests.stop();
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.maintenance;
  }
}
