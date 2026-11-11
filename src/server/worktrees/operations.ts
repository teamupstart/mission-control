import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { basename, dirname, join } from "node:path";
import type { WorktreesConfig, WorktreesConfigPatch } from "@shared/protocol.ts";
import {
  WORKTREE_INVENTORY_LIMITS,
  type LegacyWorktreeClassification,
  type WorktreeActionAffected,
  type WorktreeActionExecuteResult,
  type WorktreeActionPreview,
  type WorktreeActionRequest,
  type WorktreeActionRisk,
  type WorktreeActionSubmitResult,
  type WorktreeClaimVariableView,
  type WorktreeInventory,
  type WorktreeOperationView,
  type WorktreeOwnerView,
  type WorktreeRepositoryView,
  type WorktreeRiskKey,
  type WorktreeSlotDependenciesView,
  type WorktreeWarmLogView,
  type WorktreeWarmOperationView,
  type WorktreeWarmTargetView,
  isWorktreeOwnerKind,
  worktreeOperationPending,
} from "@shared/worktrees.ts";
import { WORKFLOW_EXECUTION_LIMITS } from "@shared/workflow.ts";
import { WORKTREE_WARM_LOGS_DIR } from "../config.ts";
import { run } from "../util/exec.ts";
import { unref } from "../util/timers.ts";
import { TailRing } from "../workflows/check-spawn.ts";
import { worktreeRepositoryIdentity } from "../util/git.ts";
import type {
  CheckGroupRecovery,
  CheckLeaseManager,
} from "../workflows/check-lease.ts";
import {
  claimVariableNames,
  claimVariablePresence,
  decodeClaimFailure,
  renderClaimArgv,
  type RunningClaim,
} from "./claim.ts";
import { getWorktreesConfig, setWorktreesConfig } from "./config.ts";
import {
  LegacyTreehouseService,
  type LegacyInventoryItem,
  type LegacyOwnerRef,
} from "./legacy-treehouse.ts";
import {
  NativeWorktreeGit,
  type WorktreeGit,
} from "./git.ts";
import {
  WorktreeManager,
  observedIdleRefusal,
  type NativePoolStatus,
  type NativeSlotStatus,
  type WarmSlotResult,
} from "./manager.ts";
import { depsCutOff, type WorktreeSlotRow } from "./store.ts";
import {
  inspectWorktreeOccupancy,
  type WorktreeOccupancy,
} from "./occupancy.ts";

const TOKEN_TTL_MS = 2 * 60_000;

/** The most often a running Warm's output tail bumps the worktrees revision. */
const WARM_TAIL_INTERVAL_MS = 1_000;
/** An operation id as it may name a log file. */
const WARM_LOG_ID = /^[A-Za-z0-9_-]{1,128}$/;
const WARM_LOG_NAME = /^([A-Za-z0-9_-]{1,128})\.log$/;

export class WorktreeOperationError extends Error {
  constructor(
    readonly status: 404 | 409 | 422 | 503,
    message: string,
    readonly code: "not-found" | "changed" | "blocked" | "unavailable",
  ) {
    super(message);
  }
}

export interface WorktreeTaskOwner {
  get(id: string): WorktreeTaskView | null;
  reclaim(id: string): Promise<{ ok: boolean; error?: string }>;
}

export interface WorktreeTaskResource {
  position: number;
  repoRoot: string;
  path: string;
  provider: "mission" | "treehouse" | "git" | null;
  leaseId: string | null;
  branch: string | null;
}

export interface WorktreeTaskView {
  id: string;
  title: string;
  resources: WorktreeTaskResource[];
}

export interface WorktreeOperationsDeps {
  legacy: LegacyTreehouseService;
  tasks: WorktreeTaskOwner;
  checks: CheckLeaseManager;
  checkRecovery: CheckGroupRecovery;
  notifyChanged: () => void;
  now: () => number;
  randomId: () => string;
  diskBytes: (path: string) => Promise<number | null>;
  git: Pick<WorktreeGit, "inspect" | "observedDefaultSha" | "mergedInto">;
  occupancy: (paths: readonly string[]) => Promise<Map<string, WorktreeOccupancy>>;
  /** Wall-clock budget for measuring every path one preview shows, together. */
  diskMeasureBudgetMs: number;
  /** Schedule that budget's deadline. Injectable so tests do not measure host contention. */
  scheduleDiskMeasureDeadline: (delayMs: number, expire: () => void) => () => void;
  /**
   * Whether each claim variable name would reach a step, and from where: the daemon's
   * environment, else the login-shell snapshot. Never a value.
   */
  claimVariablePresence: (names: readonly string[]) => Promise<WorktreeClaimVariableView[]>;
  /**
   * Operations listed at once - queued, running, and failed reports nobody has dismissed.
   * Further submissions are refused; nothing listed is ever dropped to make room.
   */
  maxOperations: number;
  /** Where each Warm writes its full log. */
  warmLogsDirectory: string;
  /** The most often a running Warm's output may bump the worktrees revision. */
  warmTailIntervalMs: number;
}

interface Observation {
  inventory: WorktreeInventory;
  native: NativePoolStatus[];
  legacy: LegacyInventoryItem[];
  /** Paths an accepted, unfinished cleanup already covers. Set per build, never shared. */
  pending: ReadonlySet<string>;
}

interface HeldPreview {
  preview: WorktreeActionPreview;
  fingerprint: string;
}

interface HeldOperation {
  view: WorktreeOperationView;
  held: HeldPreview;
  acknowledgements: Set<WorktreeRiskKey>;
  /** Only for a Warm. */
  warm: WarmRun | null;
}

/** A Warm operation's live state. Its log and tail are what the operation view shows. */
interface WarmRun {
  controller: AbortController;
  /** The same bound and ring as a check's tail. */
  ring: TailRing;
  targets: WorktreeWarmTargetView[];
  log: WarmLogFile;
  cancelRequested: boolean;
  /** The pending tail bump, if one is scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
}

/** The most a Warm log keeps of what was recorded before it opened. */
const MAX_EARLY_LOG_BYTES = 64 * 1024;

/**
 * One Warm's full log, opened the first time a Warm holds a slot, so a Warm that skipped every
 * target writes nothing. Appended in order; a write that fails is reported once and the Warm
 * carries on, because the log is a record of the Warm, never a part of it.
 *
 * The log is complete, so it is never cut, and a disk slower than the step is never absorbed
 * in memory either: once the stream's buffer is full, `write` returns a promise that settles on
 * `drain`, and the claim pauses the step's pipes until it does.
 */
export class WarmLogFile {
  private stream: WriteStream | null = null;
  private broken = false;
  /**
   * What the Warm recorded before it first held a slot, such as an earlier target skipped
   * because it was leased meanwhile. Written right after the header when the log opens, so the
   * log still says what happened to every slot; dropped with the operation if it never opens.
   * Only the Warm's own one-line results arrive before a slot is held, so the bound is generous.
   */
  private early: string[] = [];
  private earlyBytes = 0;

  constructor(readonly id: string, readonly path: string, private readonly header: () => string) {}

  get opened(): boolean {
    return this.stream !== null;
  }

  open(): void {
    if (this.stream || this.broken) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const stream = createWriteStream(this.path, { flags: "a", mode: 0o600 });
    stream.on("error", (error) => {
      if (this.broken) return;
      this.broken = true;
      console.warn(`[worktrees] Warm log ${this.path} could not be written: ${error.message}`);
    });
    this.stream = stream;
    this.stream.write(this.header() + this.early.join(""));
    this.early = [];
    this.earlyBytes = 0;
  }

  write(text: string): void | Promise<void> {
    const stream = this.stream;
    if (this.broken || !text) return undefined;
    if (!stream) {
      const bytes = Buffer.byteLength(text, "utf8");
      if (this.earlyBytes + bytes <= MAX_EARLY_LOG_BYTES) {
        this.early.push(text);
        this.earlyBytes += bytes;
      }
      return undefined;
    }
    if (stream.write(text)) return undefined;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        stream.off("drain", done);
        stream.off("error", done);
        stream.off("close", done);
        resolve();
      };
      stream.once("drain", done);
      // A broken or closed log never holds the step: the record stops, the Warm does not.
      stream.once("error", done);
      stream.once("close", done);
    });
  }

  close(): Promise<void> {
    const stream = this.stream;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      stream.end(() => resolve());
      stream.once("error", () => resolve());
    });
  }
}

interface NativeTarget {
  pool: NativePoolStatus;
  slot: NativeSlotStatus;
}

function compact(value: string | null, max = WORKTREE_INVENTORY_LIMITS.textBytes): string | null {
  if (value === null) return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function previewFingerprint(
  preview: Omit<WorktreeActionPreview, "token" | "expiresAt">,
): string {
  // Inventory freshness spans every pool. Execution is bound to the rebuilt target set
  // and its safety facts, so unrelated process churn or reconciliation cannot stale it.
  const { inventoryRevision: _inventoryRevision, ...scoped } = preview;
  return digest({
    ...scoped,
    affected: preview.affected.map(({ diskBytes: _diskBytes, ...target }) => target),
  });
}

function taskIdentity(key: string): { id: string; position: number } | null {
  const split = key.lastIndexOf(":");
  if (split <= 0) return null;
  const position = Number(key.slice(split + 1));
  if (!Number.isSafeInteger(position) || position < 0) return null;
  return { id: key.slice(0, split), position };
}

function ownerView(
  status: NativeSlotStatus,
  task: WorktreeTaskOwner,
  isWarmOperation: (key: string) => boolean = () => false,
): WorktreeOwnerView | null {
  const kind = status.slot.activeOwnerKind;
  const key = status.slot.activeOwnerKey;
  if (!isWorktreeOwnerKind(kind) || !key) return null;
  if (kind === "task") {
    const parsed = taskIdentity(key);
    const row = parsed ? task.get(parsed.id) : null;
    return { kind, key, label: row?.title ?? `Task ${parsed?.id ?? key}` };
  }
  return {
    kind,
    key,
    label: kind === "check"
      ? `Check ${key}`
      : kind === "warm"
        ? isWarmOperation(key) ? "Warming this slot ahead of time" : "Seeding another slot's dependencies"
        : `Manual lease ${key.slice(0, 8)}`,
  };
}

/**
 * A warm slot carries its dependency install, so a full `du` is routinely seconds per path -
 * measured at seven on a 1.3 GiB checkout - and it used to sit in front of every preview
 * dialog. The size is context for the operator, not a safety fact (the fingerprint ignores
 * it), so it gets a short budget and reads "size unknown" when the walk cannot finish.
 */
const DISK_MEASURE_BUDGET_MS = 1_500;
/**
 * A bulk selection can name up to `bulkSlots` paths. Walking all of them at once is its own
 * disk storm, so a preview runs at most this many walks at a time and starts none after its
 * budget is spent: the rest read "size unknown" and the dialog opens on time.
 */
const DISK_MEASURE_CONCURRENCY = 4;

async function defaultDiskBytes(path: string): Promise<number | null> {
  try {
    const result = await run("du", ["-sk", path], { timeoutMs: DISK_MEASURE_BUDGET_MS, maxBuffer: 16 * 1024 });
    if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return null;
    const kib = Number(result.stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kib) && kib >= 0 ? kib * 1024 : null;
  } catch {
    return null;
  }
}

function risk(
  key: WorktreeRiskKey,
  label: string,
  acknowledgeable: boolean,
): WorktreeActionRisk {
  return { key, label, acknowledgeable };
}

function uniqRisks(risks: WorktreeActionRisk[]): WorktreeActionRisk[] {
  const unique = new Map<WorktreeRiskKey, WorktreeActionRisk>();
  for (const entry of risks) {
    const current = unique.get(entry.key);
    unique.set(entry.key, current
      ? { ...current, acknowledgeable: current.acknowledgeable && entry.acknowledgeable }
      : entry);
  }
  return [...unique.values()];
}

/**
 * A slot's dependency state for Settings, from the durable row, the claim running in it right
 * now (if any) and the pool claim's fingerprint at the last fetched default branch. Pure: the
 * inventory never fetches and never runs a claim to answer this.
 *
 * Null when the pool has no claim configured, because then there is nothing to be current or
 * stale against.
 */
export function slotDependencies(input: {
  hasClaim: boolean;
  slot: Pick<WorktreeSlotRow, "depsState" | "depsFingerprint" | "depsFingerprintSha" | "depsClaimedAt" | "depsLastError">;
  running: RunningClaim | null;
  defaultSha: string | null;
  defaultFingerprint: string | null;
}): WorktreeSlotDependenciesView | null {
  if (!input.hasClaim) return null;
  const { slot, running } = input;
  const base = { fingerprintSha: slot.depsFingerprintSha, claimedAt: slot.depsClaimedAt };
  if (running) {
    return {
      ...base,
      state: "installing",
      claimId: running.id,
      startedAt: running.startedAt,
      step: running.step
        ? {
            step: running.step.step,
            stepCount: running.step.stepCount,
            command: renderClaimArgv(running.step.argv),
            startedAt: running.step.startedAt,
          }
        : null,
    };
  }
  // A write-ahead with no claim running, `interrupted`, or a state a later build wrote: the
  // slot's last claim or seed was cut off, and nothing about it can be trusted as current.
  // Startup records a write-ahead as interrupted; the next claim starts cold either way.
  if (depsCutOff(slot.depsState)) return { ...base, state: "interrupted" };
  switch (slot.depsState) {
    case null:
      return { ...base, state: "never" };
    case "current": {
      // Judged only when both sides have a fingerprint and the default commit is known. A claim
      // with no fingerprint paths runs on every lease, so it is never stale; an unknown default
      // is not evidence of staleness.
      if (slot.depsFingerprint === null || input.defaultFingerprint === null || input.defaultSha === null) {
        return { ...base, state: "current", defaultSha: null };
      }
      return slot.depsFingerprint === input.defaultFingerprint
        ? { ...base, state: "current", defaultSha: input.defaultSha }
        : { ...base, state: "stale", defaultSha: input.defaultSha };
    }
    default:
      // Decoded and bounded where the record is written; values were redacted before it was.
      return { ...base, state: "failed", failure: decodeClaimFailure(slot.depsLastError ?? "") };
  }
}

export class WorktreeOperationsService {
  private readonly deps: WorktreeOperationsDeps;
  private readonly tokens = new Map<string, HeldPreview>();
  private legacyVisibleRevision: string | null = null;
  private observing: Promise<Observation> | null = null;
  private nextObservation: Promise<Observation> | null = null;
  private readonly operations = new Map<string, HeldOperation>();
  private queue: Promise<void> = Promise.resolve();
  /**
   * Warms run one after another on their own queue. A Warm can run for as long as its claim's
   * limit, and a cleanup queued behind it would wait all that time for nothing: the two never
   * share a target, because each one's targets are pending to the other. One after another, a
   * pool's later slots can seed from the ones warmed before them.
   */
  private warmQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly manager: WorktreeManager,
    deps: Partial<WorktreeOperationsDeps> &
      Pick<WorktreeOperationsDeps, "tasks" | "checks" | "checkRecovery" | "notifyChanged">,
  ) {
    this.deps = {
      legacy: new LegacyTreehouseService(),
      now: Date.now,
      randomId: randomUUID,
      diskBytes: defaultDiskBytes,
      git: new NativeWorktreeGit(),
      occupancy: inspectWorktreeOccupancy,
      diskMeasureBudgetMs: DISK_MEASURE_BUDGET_MS,
      scheduleDiskMeasureDeadline: (delayMs, expire) => {
        const timer = setTimeout(expire, delayMs);
        return () => clearTimeout(timer);
      },
      maxOperations: WORKTREE_INVENTORY_LIMITS.operations,
      claimVariablePresence,
      warmLogsDirectory: WORKTREE_WARM_LOGS_DIR,
      warmTailIntervalMs: WARM_TAIL_INTERVAL_MS,
      ...deps,
    };
  }

  config(): WorktreesConfig {
    return getWorktreesConfig();
  }

  setConfig(patch: WorktreesConfigPatch): WorktreesConfig {
    const config = setWorktreesConfig(patch);
    this.tokens.clear();
    this.deps.notifyChanged();
    return config;
  }

  async inventory(): Promise<WorktreeInventory> {
    const { inventory } = await this.sharedObservation();
    return { ...inventory, operations: this.operationViews() };
  }

  /**
   * Inventory reads share observations. Every open window refreshes on the same
   * invalidation, and each full observation is Git and process work across every pool;
   * running one per caller is how the pane slowed itself down.
   *
   * A caller never joins an observation that was already running when it asked - that one
   * may predate the change it is refreshing for. It waits for the next one instead, and every
   * caller arriving meanwhile shares that same next one: at most one running and one queued.
   * Previews and execute's safety rebuild bypass this and always observe fresh.
   */
  private sharedObservation(): Promise<Observation> {
    if (!this.observing) return this.startObservation();
    this.nextObservation ??= this.observing.then(() => {}, () => {}).then(() => {
      this.nextObservation = null;
      return this.startObservation();
    });
    return this.nextObservation;
  }

  private startObservation(): Promise<Observation> {
    const running: Promise<Observation> = this.observe().finally(() => {
      if (this.observing === running) this.observing = null;
    });
    this.observing = running;
    return running;
  }

  private async observe(): Promise<Observation> {
    let native: NativePoolStatus[];
    try {
      native = await this.manager.status();
    } catch (error) {
      throw new WorktreeOperationError(503, `native worktree inventory unavailable: ${compact(String(error))}`, "unavailable");
    }
    let legacyCapability: Awaited<ReturnType<LegacyTreehouseService["capabilities"]>>;
    let legacy: LegacyInventoryItem[];
    try {
      [legacyCapability, legacy] = await Promise.all([
        this.deps.legacy.capabilities(),
        this.deps.legacy.inventory(),
      ]);
    } catch (error) {
      throw new WorktreeOperationError(503, `legacy worktree inventory unavailable: ${compact(String(error))}`, "unavailable");
    }
    const shown = native.slice(0, WORKTREE_INVENTORY_LIMITS.repositories);
    // One presence read for every pool together, so a login-shell probe is asked at most once.
    const claimNames = [...new Set(shown.flatMap((pool) => claimVariableNames(pool.policy.claim)))].sort();
    let presence = new Map<string, WorktreeClaimVariableView>();
    if (claimNames.length > 0) {
      try {
        presence = new Map((await this.deps.claimVariablePresence(claimNames)).map((entry) => [entry.name, entry]));
      } catch {
        presence = new Map();
      }
    }
    const running = new Map(this.manager.claims.list().map((claim) => [claim.slotId, claim]));
    const repositories: WorktreeRepositoryView[] = [];
    for (const pool of shown) {
      const slots = pool.slots
        .slice(0, WORKTREE_INVENTORY_LIMITS.slotsPerRepository)
        .map((entry) => {
          const owner = ownerView(entry, this.deps.tasks, (key) => this.operations.has(key));
          const processes = entry.occupancy.status === "known"
            ? { state: "known" as const, count: entry.occupancy.occupants.length, reason: null }
            : { state: "unknown" as const, count: null, reason: compact(entry.occupancy.reason) };
          const exact = pool.identityValid && pool.markerValid && entry.nativePath &&
            entry.registered === true && entry.repositoryMatches === true;
          const actions: Array<"return" | "destroy" | "warm"> = [];
          // A `warm` lease belongs to the seed copying from it, which returns it the moment the
          // copy ends. Nothing an operator could do to it here would be safer than that.
          if (entry.slot.state === "leased") {
            if (entry.slot.activeOwnerKind !== "warm") actions.push("return", "destroy");
          }
          else if ((entry.slot.state === "available" || entry.slot.state === "quarantined") && exact) {
            actions.push("destroy");
          }
          // Warm prepares an idle slot ahead of time: one acquisition's own rule calls idle, in a
          // pool whose claim it would run. The preview applies the same rule.
          if (pool.policy.enabled && pool.policy.claim && pool.identityValid && pool.markerValid && !observedIdleRefusal(entry)) {
            actions.push("warm");
          }
          return {
            id: entry.slot.id,
            poolId: pool.pool.id,
            provider: "mission" as const,
            ordinal: entry.slot.ordinal,
            state: entry.slot.state,
            version: entry.slot.version,
            path: entry.slot.path,
            owner,
            leaseAgeMs: entry.slot.leasedAt === null ? null : Math.max(0, this.deps.now() - entry.slot.leasedAt),
            head: entry.observedHead,
            defaultRelation: entry.mergedIntoDefault === null
              ? "unknown" as const
              : entry.mergedIntoDefault
                ? "merged" as const
                : "unmerged" as const,
            dirty: entry.dirty,
            processes,
            // Recursive size walks are intentionally absent from inventory. Large warm
            // dependency caches made one settings read launch a `du` over every slot,
            // saturating disk and holding the page for seconds. A destructive preview
            // measures only the fixed paths it is about to show.
            diskBytes: null,
            quarantineReason: compact(entry.slot.quarantineReason),
            diagnostic: compact(entry.slot.lastError),
            actions,
            dependencies: slotDependencies({
              hasClaim: Boolean(pool.policy.claim),
              slot: entry.slot,
              running: running.get(entry.slot.id) ?? null,
              defaultSha: pool.observedDefaultSha,
              defaultFingerprint: pool.defaultFingerprint,
            }),
            warmLog: this.warmLogView(entry.slot.depsLogPath),
          };
        });
      const counts = {
        total: pool.slots.length,
        leased: pool.slots.filter((entry) => entry.slot.state === "leased").length,
        available: pool.slots.filter((entry) => entry.slot.state === "available").length,
        quarantined: pool.slots.filter((entry) => entry.slot.state === "quarantined").length,
        overCapacity: Math.max(0, pool.slots.length - pool.policy.maxSlots),
      };
      repositories.push({
        id: pool.pool.id,
        name: basename(pool.pool.mainCheckoutRoot),
        root: pool.pool.mainCheckoutRoot,
        commonDirectory: pool.pool.gitCommonDirectory,
        poolPath: pool.pool.poolPath,
        policy: {
          enabled: pool.policy.enabled,
          maxSlots: pool.policy.maxSlots,
          setupArgv: pool.policy.setupArgv ? [...pool.policy.setupArgv] : null,
          claim: pool.policy.claim ?? null,
        },
        claimVariables: claimVariableNames(pool.policy.claim).map((name) =>
          presence.get(name) ?? { name, present: false, source: null }),
        counts,
        diskBytes: null,
        lastReconciledAt: pool.pool.lastReconciledAt,
        reconciliationError: compact(pool.pool.reconciliationError),
        status: !pool.identityValid || !pool.markerValid
          ? "unavailable"
          : counts.quarantined > 0 || counts.overCapacity > 0
            ? "attention"
            : "ready",
        slots,
      });
    }
    const legacyItems = legacy.slice(0, WORKTREE_INVENTORY_LIMITS.legacyItems).map((item) => {
      const owner = item.owners[0] ?? null;
      return {
        id: digest({ path: item.path, leaseId: item.leaseId, owner }).slice(0, 24),
        classification: item.classification,
        repoRoot: item.repoRoot,
        path: item.path,
        owner,
        leaseId: item.leaseId,
        holder: item.holder,
        acquiredAt: item.acquiredAt,
        processes: item.occupancy.status === "known"
          ? { state: "known" as const, count: item.occupancy.occupants.length, reason: null }
          : { state: "unknown" as const, count: null, reason: compact(item.occupancy.reason) },
        dirty: item.dirty,
        canReturn: item.canConditionalReturn && owner !== null,
        diagnostic: compact(item.diagnostic),
      };
    });
    const totals: Record<LegacyWorktreeClassification, number> = {
      ownedExact: 0,
      identityUnverifiable: 0,
      foreign: 0,
      unreadable: 0,
    };
    for (const item of legacy) totals[item.classification] += 1;
    const config = this.config();
    const revisionFacts = {
      config,
      repositories: repositories.map((repo) => ({
        ...repo,
        diskBytes: null,
        slots: repo.slots.map((slot) => ({ ...slot, diskBytes: null, leaseAgeMs: null })),
      })),
      legacy: { capability: legacyCapability, totals, items: legacyItems },
    };
    const inventory: WorktreeInventory = {
      config,
      repositories,
      operations: [],
      observedAt: this.deps.now(),
      revision: digest(revisionFacts),
      legacy: {
        capability: {
          kind: legacyCapability.kind,
          version: "version" in legacyCapability ? legacyCapability.version : null,
          diagnostic: legacyCapability.kind === "conditional-json" ? null : compact(legacyCapability.diagnostic),
        },
        totals,
        items: legacyItems,
      },
    };
    const legacyVisibleRevision = digest(inventory.legacy);
    if (this.legacyVisibleRevision !== null && this.legacyVisibleRevision !== legacyVisibleRevision) {
      this.deps.notifyChanged();
    }
    this.legacyVisibleRevision = legacyVisibleRevision;
    return { inventory, native, legacy, pending: new Set() };
  }

  async preview(request: WorktreeActionRequest): Promise<WorktreeActionPreview> {
    this.pruneTokens();
    const observed = await this.observe();
    const built = await this.buildPreview(request, observed);
    // Sizes are measured only here, for the fixed paths this dialog shows, within one bounded
    // budget. Execute's safety rebuild never walks the disk: the fingerprint excludes size.
    const sizes = await this.measureSizes(built.affected.map((target) => target.path));
    built.affected = built.affected.map((target, index) => ({ ...target, diskBytes: sizes[index] ?? null }));
    const token = this.deps.randomId();
    const preview = { ...built, token, expiresAt: this.deps.now() + TOKEN_TTL_MS };
    const fingerprint = previewFingerprint(built);
    this.tokens.set(token, { preview, fingerprint });
    while (this.tokens.size > WORKTREE_INVENTORY_LIMITS.previewTokens) {
      this.tokens.delete(this.tokens.keys().next().value!);
    }
    return preview;
  }

  /**
   * At most `DISK_MEASURE_CONCURRENCY` walks in flight, and one wall-clock budget for the
   * whole set. When it expires the preview stops waiting and starts nothing new; each walk
   * still in flight is bounded by its own `du` timeout. Anything unmeasured is null.
   */
  private async measureSizes(paths: readonly string[]): Promise<Array<number | null>> {
    const sizes: Array<number | null> = paths.map(() => null);
    if (paths.length === 0) return sizes;
    let expired = false;
    let cancelDeadline = (): void => {};
    const deadline = new Promise<"expired">((resolve) => {
      cancelDeadline = this.deps.scheduleDiskMeasureDeadline(this.deps.diskMeasureBudgetMs, () => {
        expired = true;
        resolve("expired");
      });
    });
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!expired && next < paths.length) {
        const index = next;
        next += 1;
        const measured = await Promise.race([
          this.deps.diskBytes(paths[index]!).catch(() => null),
          deadline,
        ]);
        if (measured === "expired") return;
        sizes[index] = measured;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(DISK_MEASURE_CONCURRENCY, paths.length) }, worker));
    } finally {
      cancelDeadline();
    }
    return sizes;
  }

  private taskOwner(task: WorktreeTaskView, position: number): WorktreeOwnerView {
    return { kind: "task", key: `${task.id}:${position}`, label: task.title };
  }

  private nativeTargets(observed: Observation): NativeTarget[] {
    return observed.native.flatMap((pool) => pool.slots.map((slot) => ({ pool, slot })));
  }

  /**
   * TaskManager reclaims the primary and every attached repository as one domain operation.
   * Mirror that exact scope in the preview so no secondary resource can ride behind the
   * selected path without appearing in the token fingerprint and risk set.
   */
  private async expandTaskResources(
    task: WorktreeTaskView,
    observed: Observation,
    affected: WorktreeActionAffected[],
    risks: WorktreeActionRisk[],
    blockers: string[],
    consequences: string[],
  ): Promise<NativeTarget[]> {
    const native: NativeTarget[] = [];
    const allNative = this.nativeTargets(observed);
    const gitResources = task.resources.filter((resource) =>
      resource.provider === "git" || resource.provider === null);
    let gitOccupancy = new Map<string, WorktreeOccupancy>();
    if (gitResources.length > 0) {
      try {
        gitOccupancy = await this.deps.occupancy(gitResources.map((resource) => resource.path));
      } catch (error) {
        const reason = `task worktree occupancy inspection failed: ${compact(String(error))}`;
        gitOccupancy = new Map(gitResources.map((resource) => [
          resource.path,
          { status: "unknown" as const, reason },
        ]));
      }
    }

    for (const resource of task.resources) {
      const owner = this.taskOwner(task, resource.position);
      if (resource.provider === "mission") {
        const matches = allNative.filter(({ slot }) =>
          slot.slot.path === resource.path &&
          slot.slot.activeOwnerKind === "task" &&
          slot.slot.activeOwnerKey === owner.key &&
          slot.slot.activeLeaseId === resource.leaseId);
        if (matches.length === 1) {
          native.push(matches[0]!);
        } else {
          affected.push({
            provider: "mission",
            id: digest({ task: task.id, position: resource.position, path: resource.path }).slice(0, 24),
            path: resource.path,
            owner,
            version: null,
            safetyRevision: digest(resource),
            diskBytes: null,
          });
          blockers.push(
            matches.length === 0
              ? `Task ${task.id} repository ${resource.position} no longer maps to its exact native lease.`
              : `Task ${task.id} repository ${resource.position} maps to more than one native lease.`,
          );
        }
        continue;
      }

      if (resource.provider === "treehouse") {
        const matches = observed.legacy.filter((item) =>
          item.path === resource.path && item.leaseId === resource.leaseId &&
          item.owners.some((candidate) => candidate.kind === "task" &&
            candidate.id === task.id && candidate.position === resource.position));
        const item = matches.length === 1 ? matches[0]! : null;
        affected.push({
          provider: "treehouse",
          id: digest({ task: task.id, position: resource.position, path: resource.path }).slice(0, 24),
          path: resource.path,
          owner,
          version: null,
          safetyRevision: digest({ resource, item }),
          diskBytes: null,
        });
        if (!item) {
          blockers.push(
            matches.length === 0
              ? `Task ${task.id} repository ${resource.position} no longer maps to its exact legacy lease.`
              : `Task ${task.id} repository ${resource.position} maps to more than one legacy lease.`,
          );
          continue;
        }
        if (item.classification !== "ownedExact") {
          risks.push(risk("legacy-unverifiable", "Legacy identity is not exact", false));
          blockers.push(item.diagnostic ?? "Legacy identity is not exact.");
        }
        if (item.occupancy.status === "unknown") {
          risks.push(risk("unknown-occupancy", "Process occupancy is unknown", false));
          blockers.push(item.occupancy.reason);
        } else if (item.occupancy.occupants.length > 0) {
          risks.push(risk("occupied", `${item.occupancy.occupants.length} process(es) occupy a legacy task path`, false));
          blockers.push("Legacy task worktrees must be process-free before cleanup.");
        }
        if (item.dirty === true) {
          risks.push(risk("dirty", "A legacy task worktree is dirty", false));
          blockers.push("Legacy task worktrees must be clean before cleanup.");
        } else if (item.dirty === null) {
          blockers.push("Legacy task worktree cleanliness is unknown.");
        }
        continue;
      }

      const occupancy = gitOccupancy.get(resource.path) ?? {
        status: "unknown" as const,
        reason: "task worktree occupancy was not inspected",
      };
      const inspected = await this.deps.git.inspect(resource.path).catch(() => null);
      const identity = worktreeRepositoryIdentity(resource.repoRoot);
      let mergedIntoDefault: boolean | null = null;
      if (!identity || !inspected?.ok || inspected.value.path !== resource.path ||
        inspected.value.commonDirectory !== identity.gitCommonDirectory) {
        blockers.push(`Disposable Git worktree identity is not exact for task repository ${resource.position}.`);
      } else {
        if (inspected.value.dirty) {
          risks.push(risk("dirty", "Dirty or untracked task work will be discarded", true));
        }
        const defaultSha = await this.deps.git.observedDefaultSha(identity);
        if (!defaultSha.ok) {
          blockers.push(`Default-branch relationship is unknown for task repository ${resource.position}.`);
        } else {
          const merged = await this.deps.git.mergedInto(resource.path, defaultSha.value);
          if (!merged.ok) {
            blockers.push(`Default-branch relationship is unknown for task repository ${resource.position}.`);
          } else if (!merged.value) {
            mergedIntoDefault = false;
            risks.push(risk("unlanded", "Task work is not merged into the observed default branch", true));
          } else {
            mergedIntoDefault = true;
          }
        }
      }
      affected.push({
        provider: "git",
        id: digest({ task: task.id, position: resource.position, path: resource.path }).slice(0, 24),
        path: resource.path,
        owner,
        version: null,
        safetyRevision: digest({ resource, inspected, mergedIntoDefault, occupancy }),
        diskBytes: null,
      });
      if (occupancy.status === "unknown") {
        risks.push(risk("unknown-occupancy", "Process occupancy is unknown", false));
        blockers.push(occupancy.reason);
      } else if (occupancy.occupants.length > 0) {
        // TaskManager stops the task's owned agent before provider cleanup. Recording and
        // rendering the count binds it into the preview that execute rebuilds immediately
        // before entering that domain cleanup.
        risks.push(risk("occupied", `${occupancy.occupants.length} process(es) occupy a task-owned path`, false));
        consequences.push(
          `${occupancy.occupants.length} process(es) currently occupy ${resource.path}; TaskManager stops its owned agent before cleanup.`,
        );
      }
    }
    return native;
  }

  private async appendNativeTarget(
    target: NativeTarget,
    action: "return" | "destroy",
    observed: Observation,
    affected: WorktreeActionAffected[],
    risks: WorktreeActionRisk[],
    blockers: string[],
    consequences: string[],
  ): Promise<void> {
    const { pool, slot } = target;
    const owner = ownerView(slot, this.deps.tasks);
    affected.push({
      provider: "mission",
      id: slot.slot.id,
      path: slot.slot.path,
      owner,
      version: slot.slot.version,
      safetyRevision: digest({
        state: slot.slot.state,
        leaseId: slot.slot.activeLeaseId,
        ownerKind: slot.slot.activeOwnerKind,
        ownerKey: slot.slot.activeOwnerKey,
        path: slot.slot.path,
        head: slot.observedHead,
        dirty: slot.dirty,
        mergedIntoDefault: slot.mergedIntoDefault,
        occupancy: slot.occupancy,
      }),
      diskBytes: null,
    });
    if (slot.dirty === true) risks.push(risk("dirty", "Dirty or untracked work will be discarded", true));
    else if (slot.dirty === null) blockers.push(`Git cleanliness is unknown for slot ${slot.slot.ordinal}.`);
    if (slot.mergedIntoDefault === false) {
      risks.push(risk("unlanded", "HEAD is not merged into the observed default branch", true));
    } else if (slot.mergedIntoDefault === null) {
      blockers.push(`Default-branch relationship is unknown for slot ${slot.slot.ordinal}.`);
    }
    if (slot.occupancy.status === "unknown") {
      risks.push(risk("unknown-occupancy", "Process occupancy is unknown", false));
      blockers.push(slot.occupancy.reason);
    } else if (slot.occupancy.occupants.length > 0) {
      risks.push(risk("occupied", `${slot.occupancy.occupants.length} process(es) occupy a target path`, false));
      if (owner?.kind !== "task") {
        blockers.push("Known processes must exit before this action can run.");
      } else {
        consequences.push(
          `${slot.occupancy.occupants.length} process(es) currently occupy ${slot.slot.path}; TaskManager stops its owned agent before final provider checks.`,
        );
      }
    }
    if (!pool.identityValid || !pool.markerValid || !slot.nativePath ||
      slot.registered !== true || slot.repositoryMatches !== true) {
      blockers.push("Exact native pool, marker, Git registration, and repository ownership are not all proven.");
    }
    if (observed.pending.has(slot.slot.path)) {
      blockers.push(`Slot ${slot.slot.ordinal} already has a cleanup queued; wait for it to finish or leave it out of this action.`);
    }
    if (slot.slot.state === "quarantined") risks.push(risk("quarantined", "A target slot is quarantined", false));
    if (action === "return" && slot.slot.state !== "leased") {
      blockers.push(`Slot ${slot.slot.ordinal} is ${slot.slot.state}, not leased.`);
    }
    if (action === "destroy" && !["leased", "available", "quarantined"].includes(slot.slot.state)) {
      blockers.push(`Slot ${slot.slot.ordinal} is in the ${slot.slot.state} transition and cannot be destroyed.`);
    }

    if (owner) {
      risks.push(risk("leased", "A target slot has an active lease", false));
      risks.push(risk("domain-owned", `${owner.label} owns a target lease`, false));
      if (owner.kind === "task") {
        const task = taskIdentity(owner.key);
        if (!task || !this.deps.tasks.get(task.id)) blockers.push("The task owner can no longer be resolved exactly.");
        consequences.push("Stops the task agent, captures required archives and snapshots, and clears every task repository through TaskManager.");
      } else if (owner.kind === "check") {
        const check = await this.deps.checks.previewOperatorRecovery(owner.key, this.deps.checkRecovery);
        if (!check.allowed) blockers.push(check.reason ?? "Check cleanup is not currently safe.");
        consequences.push("Uses check process-group recovery and the recorded provider before releasing the lease.");
      } else if (owner.kind === "warm") {
        blockers.push(`A dependency seed holds slot ${slot.slot.ordinal} and returns it when its copy ends.`);
      } else {
        consequences.push("Returns the exact durable manual lease before any slot removal.");
      }
    } else if (slot.ownerReferenced !== false) {
      blockers.push("Domain ownership is referenced or unknown.");
    }
    if (action === "return" && !owner) blockers.push("This slot has no active owner to return.");
  }

  /**
   * `excludeOperation` is the queued operation whose own recheck this is: its targets are
   * pending precisely because it is the one running, and must not block itself.
   */
  private async buildPreview(
    request: WorktreeActionRequest,
    observation: Observation,
    excludeOperation: string | null = null,
  ): Promise<Omit<WorktreeActionPreview, "token" | "expiresAt">> {
    const observed: Observation = { ...observation, pending: this.pendingPaths(excludeOperation) };
    const affected: WorktreeActionAffected[] = [];
    const risks: WorktreeActionRisk[] = [];
    const blockers: string[] = [];
    const consequences: string[] = [];

    if (request.action === "legacyReturn") {
      const ref: LegacyOwnerRef = request.owner;
      const item = observed.legacy.find((candidate) => candidate.owners.some((owner) =>
        owner.kind === ref.kind && owner.id === ref.id &&
        (owner.kind !== "task" || owner.position === (ref.position ?? 0)))) ?? null;
      if (!item) throw new WorktreeOperationError(404, "legacy owner was not found", "not-found");
      if (request.owner.kind === "task") {
        const task = this.deps.tasks.get(request.owner.id);
        if (!task) {
          blockers.push("The task owner can no longer be resolved exactly.");
        } else {
          const position = request.owner.position ?? 0;
          const selected = task.resources.find((resource) => resource.position === position);
          if (!selected || selected.provider !== "treehouse" || selected.path !== item.path ||
            selected.leaseId !== item.leaseId) {
            blockers.push("The selected legacy lease no longer matches the task's durable resource.");
          }
          const native = await this.expandTaskResources(task, observed, affected, risks, blockers, consequences);
          for (const target of native) {
            await this.appendNativeTarget(target, "return", observed, affected, risks, blockers, consequences);
          }
          risks.push(risk("domain-owned", `${task.title} owns every affected task resource`, false));
          consequences.push("Stops the task agent, captures required archives and snapshots, and clears every task repository through TaskManager.");
        }
      } else {
        const preview = await this.deps.legacy.previewReturn(ref);
        const owner = item.owners[0] ?? null;
        affected.push({
          provider: "treehouse",
          id: digest({ ref, path: item.path }).slice(0, 24),
          path: item.path,
          owner: owner ? { kind: owner.kind, key: owner.id, label: `Check ${owner.id}` } : null,
          version: null,
          safetyRevision: digest(item),
          diskBytes: null,
        });
        if (!preview.allowed) blockers.push(preview.reason);
        if (item.classification !== "ownedExact") {
          risks.push(risk("legacy-unverifiable", "Legacy identity is not exact", false));
        }
        consequences.push("Returns only the exact persisted Treehouse lease through its check owner.");
      }
      return this.finish(request, observed.inventory.revision, affected, risks, blockers, consequences);
    }

    if (request.action === "warm") {
      return this.buildWarmPreview(request, observed, affected, risks, blockers, consequences);
    }

    const poolId = request.action === "prune" || request.action === "reconcile"
      ? request.poolId
      : request.action === "destroy" && request.target.kind === "pool"
        ? request.target.poolId
        : null;
    const slotId = request.action === "return"
      ? request.slotId
      : request.action === "destroy" && request.target.kind === "slot"
        ? request.target.slotId
        : null;
    if (request.action === "destroy" && request.target.kind === "slots") {
      // A bulk selection may span pools. It is still one fixed set: every id is resolved now,
      // shown in the preview, and bound into the token, so nothing joins it after the fact.
      const selected = new Set(request.target.slotIds);
      const found = this.nativeTargets(observed).filter(({ slot }) => selected.has(slot.slot.id));
      const missing = selected.size - found.length;
      if (missing > 0) {
        blockers.push(`${missing} selected ${missing === 1 ? "slot no longer exists" : "slots no longer exist"}; clear the selection and choose again.`);
      }
      // Even a selection that lost every slot answers with a blocked preview, not a 404: the
      // operator is looking at that selection and needs to be told it has to change.
      if (found.length === 0) return this.finish(request, observed.inventory.revision, affected, risks, blockers, consequences);
      return this.buildSlotTargets(request, observed, found, affected, risks, blockers, consequences);
    }

    const pool = poolId
      ? observed.native.find((entry) => entry.pool.id === poolId)
      : observed.native.find((entry) => entry.slots.some((slot) => slot.slot.id === slotId));
    if (!pool) throw new WorktreeOperationError(404, "native worktree target was not found", "not-found");

    if (request.action === "reconcile") {
      consequences.push("Re-observes durable rows, Git registration, ownership, and processes. Uncertainty remains quarantined.");
      return this.finish(request, observed.inventory.revision, affected, risks, blockers, consequences);
    }

    if (request.action === "prune") {
      const candidates = (await this.manager.planMaintenance())
        .filter((candidate) => candidate.poolId === request.poolId)
        .filter((candidate) => request.mode === "safe" || candidate.rightSize)
        .filter((candidate) => candidate.safe)
        // Already on its way out through an accepted cleanup; pruning it again would only
        // race that removal.
        .filter((candidate) => !observed.pending.has(candidate.path));
      for (const candidate of candidates) {
        affected.push({
          provider: "mission",
          id: candidate.slotId,
          path: candidate.path,
          owner: null,
          version: candidate.slotVersion,
          safetyRevision: digest({
            ...candidate,
            // Safe candidates are necessarily clean and empty, but their HEAD can still
            // move between two merged commits without changing eligibility or version.
            head: pool.slots.find((entry) => entry.slot.id === candidate.slotId)?.observedHead ?? null,
          }),
          diskBytes: null,
        });
      }
      if (candidates.length === 0) blockers.push("No clean, merged, process-free, unreferenced slots are safe to prune.");
      if (pool.slots.length > pool.policy.maxSlots) {
        risks.push(risk("over-capacity", "Pool is above its configured capacity", false));
      }
      consequences.push("Removes only the fixed safe candidate set shown here; leased or uncertain slots are preserved.");
      return this.finish(request, observed.inventory.revision, affected, risks, blockers, consequences);
    }

    const initialTargets: NativeTarget[] = (request.action === "destroy" && request.target.kind === "pool"
      ? pool.slots
      : [pool.slots.find((entry) => entry.slot.id === slotId)!])
      .filter(Boolean)
      .map((slot) => ({ pool, slot }));
    if (initialTargets.length === 0) blockers.push("The fixed pool target contains no slots to destroy.");
    return this.buildSlotTargets(request, observed, initialTargets, affected, risks, blockers, consequences);
  }

  /**
   * Warm one available slot, or every available slot of a pool. Only an idle slot is a target:
   * available, exactly owned, process-free, clean, and not already covered by another queued
   * operation. A slot Warm names directly that is anything else blocks the preview; a pool Warm
   * leaves such slots out and says how many. Nothing here is destructive, so nothing needs an
   * acknowledgement, and execute binds no fingerprint: whatever changed meanwhile is decided
   * per slot when its turn comes, and a slot that is no longer idle then is skipped.
   */
  private buildWarmPreview(
    request: Extract<WorktreeActionRequest, { action: "warm" }>,
    observed: Observation,
    affected: WorktreeActionAffected[],
    risks: WorktreeActionRisk[],
    blockers: string[],
    consequences: string[],
  ): Omit<WorktreeActionPreview, "token" | "expiresAt"> {
    const target = request.target;
    const pool = target.kind === "pool"
      ? observed.native.find((entry) => entry.pool.id === target.poolId)
      : observed.native.find((entry) => entry.slots.some((slot) => slot.slot.id === target.slotId));
    if (!pool) throw new WorktreeOperationError(404, "native worktree target was not found", "not-found");
    if (!pool.policy.claim) blockers.push("This pool has no dependency claim configured, so there is nothing to warm.");
    if (!pool.policy.enabled) blockers.push("Native worktrees are disabled for this repository.");
    if (!pool.identityValid || !pool.markerValid) {
      blockers.push("The pool's repository identity or marker cannot be proven.");
    }
    const candidates = target.kind === "pool"
      ? pool.slots
      : pool.slots.filter((slot) => slot.slot.id === target.slotId);
    const leftOut: string[] = [];
    for (const slot of candidates) {
      // Acquisition's own idle rule, read from this observation. The slot is held to the same
      // rule again, freshly, when its turn comes.
      const refusal = observedIdleRefusal(slot);
      const why = refusal?.kind === "notAvailable"
        ? `Slot ${slot.slot.ordinal} is ${slot.slot.state}. Warm never touches a slot that is leased, quarantined or changing.`
        : refusal
          ? `Slot ${slot.slot.ordinal} is not idle: ${refusal.reason}.`
          : observed.pending.has(slot.slot.path)
            ? `Slot ${slot.slot.ordinal} already has an operation queued.`
            : null;
      if (why) {
        if (target.kind === "slot") blockers.push(why);
        else leftOut.push(why);
        continue;
      }
      affected.push({
        provider: "mission",
        id: slot.slot.id,
        path: slot.slot.path,
        owner: null,
        version: slot.slot.version,
        safetyRevision: digest({ state: slot.slot.state, version: slot.slot.version, head: slot.observedHead }),
        diskBytes: null,
      });
    }
    if (target.kind === "pool" && affected.length === 0) blockers.push("No slot in this pool is idle to warm.");
    consequences.push(
      "Holds each slot under a warm lease, fetches origin, resets the slot to origin's default branch, then seeds it from an idle sibling or runs the pool's claim under its usual rules, and returns it as available.",
    );
    if (target.kind === "pool") {
      consequences.push("Slots are warmed one at a time, so a later slot can seed from one warmed before it. A slot leased before its turn comes is skipped and listed as skipped.");
      if (leftOut.length > 0) {
        consequences.push(`${leftOut.length} ${leftOut.length === 1 ? "slot is" : "slots are"} left alone: ${leftOut.join(" ")}`);
      }
    }
    consequences.push("Cancel stops the running step's process group and returns the slot to the pool.");
    return this.finish(request, observed.inventory.revision, affected, risks, blockers, consequences);
  }

  /** Return or destroy a fixed set of native slots, widened to every resource their tasks own. */
  private async buildSlotTargets(
    request: Extract<WorktreeActionRequest, { action: "return" | "destroy" }>,
    observed: Observation,
    initialTargets: NativeTarget[],
    affected: WorktreeActionAffected[],
    risks: WorktreeActionRisk[],
    blockers: string[],
    consequences: string[],
  ): Promise<Omit<WorktreeActionPreview, "token" | "expiresAt">> {
    const targets = new Map(initialTargets.map((target) => [target.slot.slot.id, target]));
    const taskIds = new Set<string>();
    for (const target of initialTargets) {
      if (target.slot.slot.activeOwnerKind !== "task" || !target.slot.slot.activeOwnerKey) continue;
      const identity = taskIdentity(target.slot.slot.activeOwnerKey);
      if (identity) taskIds.add(identity.id);
    }
    for (const taskId of taskIds) {
      const task = this.deps.tasks.get(taskId);
      if (!task) {
        blockers.push(`Task ${taskId} can no longer be resolved exactly.`);
        continue;
      }
      const expanded = await this.expandTaskResources(task, observed, affected, risks, blockers, consequences);
      for (const target of expanded) targets.set(target.slot.slot.id, target);
      for (const target of initialTargets.filter((candidate) =>
        candidate.slot.slot.activeOwnerKey?.startsWith(`${taskId}:`))) {
        const identity = taskIdentity(target.slot.slot.activeOwnerKey!);
        const resource = identity
          ? task.resources.find((candidate) => candidate.position === identity.position)
          : null;
        if (!resource || resource.provider !== "mission" ||
          resource.path !== target.slot.slot.path || resource.leaseId !== target.slot.slot.activeLeaseId) {
          blockers.push(`The selected native lease no longer matches task ${taskId}'s durable resource set.`);
        }
      }
    }
    for (const target of targets.values()) {
      await this.appendNativeTarget(
        target,
        request.action,
        observed,
        affected,
        risks,
        blockers,
        consequences,
      );
    }
    if (request.action === "destroy") {
      consequences.push(request.target.kind === "slot"
        ? "Removes this exact manager-owned Git worktree and its slot row after final revalidation."
        : "Removes only the fixed manager-owned slot set shown here after final revalidation.");
    } else {
      consequences.push("Resets the slot to the fetched remote default and retains it as warm capacity.");
    }
    return this.finish(request, observed.inventory.revision, affected, risks, blockers, consequences);
  }

  private finish(
    request: WorktreeActionRequest,
    inventoryRevision: string,
    affected: WorktreeActionAffected[],
    risks: WorktreeActionRisk[],
    blockers: string[],
    consequences: string[],
  ): Omit<WorktreeActionPreview, "token" | "expiresAt"> {
    const unique = uniqRisks(risks);
    return {
      request,
      inventoryRevision,
      affected,
      risks: unique,
      requiredAcknowledgements: unique.filter((entry) => entry.acknowledgeable).map((entry) => entry.key),
      allowed: blockers.length === 0,
      blockers: [...new Set(blockers.map((entry) => compact(entry) ?? "operation is blocked"))],
      consequences: [...new Set(consequences)],
    };
  }

  /** Execute and wait for the outcome. The route uses `submit`; this is the same work, inline. */
  async execute(
    token: string,
    acknowledgements: readonly WorktreeRiskKey[],
  ): Promise<WorktreeActionExecuteResult> {
    if (this.tokens.get(token)?.preview.request.action === "warm") {
      // A Warm is an operation with a view of its own; inline, it is that operation awaited.
      this.submit(token, acknowledgements);
      await this.warmQueue;
      return { ok: true, action: "warm", message: this.successMessage("warm") };
    }
    const { held, acknowledgementSet } = this.claim(token, acknowledgements);
    return this.perform(held, acknowledgementSet);
  }

  /**
   * Accept an Execute and answer at once. Everything cheap and final - the token exists, it
   * is allowed, the acknowledgements are exactly the ones it asked for - is checked before
   * this returns. The fresh safety rebuild and the mutation it guards run afterwards on one
   * ordered queue, so an operator can keep selecting and destroying while earlier removals
   * finish, and two cleanups never race each other through Git.
   */
  submit(
    token: string,
    acknowledgements: readonly WorktreeRiskKey[],
  ): WorktreeActionSubmitResult {
    this.pruneTokens();
    if (this.operations.size >= this.deps.maxOperations) {
      // Refused before the token is claimed, so the same preview can be executed again once
      // there is room. Nothing listed is dropped to make it: accepted work runs to the end,
      // and a failure report - possibly the only record of a partial removal - leaves only
      // through Dismiss or an accepted retry.
      // A finished Warm is a report too: it stays listed, with its results and log, until it
      // is dismissed.
      const listed = [...this.operations.values()];
      const failed = listed.filter((entry) => entry.view.state === "failed").length;
      const finished = listed.filter((entry) => entry.view.state === "finished").length;
      const queued = this.operations.size - failed - finished;
      throw new WorktreeOperationError(
        503,
        finished > 0
          ? `${this.operations.size} operations are listed (${failed} failed, ${finished} finished Warms, ${queued} queued); dismiss a report or wait for queued operations to finish, then execute again`
          : failed > 0
            ? `${this.operations.size} cleanups are listed (${failed} failed, ${queued} queued); dismiss a failed report or wait for queued cleanups to finish, then execute again`
            : `${queued} cleanups are already queued; execute again when some have finished`,
        "unavailable",
      );
    }
    const pendingPaths = this.pendingPaths(null);
    const candidate = this.tokens.get(token);
    const overlap = candidate?.preview.affected.find((target) => pendingPaths.has(target.path));
    if (overlap) {
      this.tokens.delete(token);
      throw new WorktreeOperationError(409, `${overlap.path} already has a cleanup queued; wait for it to finish`, "changed");
    }
    const { held, acknowledgementSet } = this.claim(token, acknowledgements);
    const view: WorktreeOperationView = {
      id: this.deps.randomId(),
      request: held.preview.request,
      state: "queued",
      targets: held.preview.affected.map(({ provider, id, path }) => ({ provider, id, path })),
      error: null,
      changed: false,
      removals: this.removalTargets(held.preview).map(({ id, path }) => ({ id, path })),
      completed: [],
      queuedAt: this.deps.now(),
      finishedAt: null,
      warm: null,
    };
    const warm = held.preview.request.action === "warm" ? this.warmRun(view, held.preview) : null;
    const entry: HeldOperation = { view, held, acknowledgements: acknowledgementSet, warm };
    this.operations.set(view.id, entry);
    // A throwing publisher must not wedge every later operation behind a rejected link.
    if (warm) this.warmQueue = this.warmQueue.then(() => this.runWarm(entry)).catch(() => {});
    else this.queue = this.queue.then(() => this.runQueued(entry)).catch(() => {});
    this.deps.notifyChanged();
    return { ok: true, operation: this.viewOf(entry) };
  }

  /** Settles when every operation accepted so far has finished, whatever its outcome. */
  idle(): Promise<void> {
    return Promise.all([this.queue, this.warmQueue]).then(() => {});
  }

  /**
   * Forget a failed operation, or a finished Warm, the operator has read. Queued and running
   * work cannot be dismissed. A Warm's log stays while a slot row still names it.
   */
  dismiss(id: string): boolean {
    const entry = this.operations.get(id);
    if (!entry || worktreeOperationPending(entry.view)) return false;
    this.operations.delete(id);
    this.deps.notifyChanged();
    if (entry.warm) void this.sweepWarmLogs();
    return true;
  }

  /**
   * Cancel a queued or running Warm. A queued one finishes at once with every target cancelled.
   * A running one has its claim stopped, which kills the running step's process group; the
   * slot it holds is returned to the pool, with `deps_state` following the Stop rule, and the
   * targets after it are not reached. False for anything else.
   */
  cancel(id: string): boolean {
    const entry = this.operations.get(id);
    const warm = entry?.warm;
    if (!entry || !warm || !worktreeOperationPending(entry.view)) return false;
    if (!warm.cancelRequested) {
      warm.cancelRequested = true;
      warm.controller.abort("cancelled");
      if (entry.view.state === "queued") {
        for (const target of warm.targets) {
          target.outcome = "cancelled";
          target.detail = "cancelled before the Warm started";
        }
        entry.view.state = "finished";
        entry.view.finishedAt = this.deps.now();
      }
    }
    this.deps.notifyChanged();
    return true;
  }

  private warmRun(view: WorktreeOperationView, preview: WorktreeActionPreview): WarmRun {
    const slots = new Map(this.manager.store.slots().map((slot) => [slot.id, slot]));
    const request = preview.request;
    return {
      controller: new AbortController(),
      ring: new TailRing(WORKFLOW_EXECUTION_LIMITS.checkOutput),
      targets: preview.affected.map((target) => ({
        slotId: target.id,
        ordinal: slots.get(target.id)?.ordinal ?? 0,
        path: target.path,
        outcome: "pending",
        detail: null,
      })),
      log: new WarmLogFile(view.id, this.warmLogPath(view.id), () =>
        `Warm ${view.id}, accepted ${new Date(view.queuedAt).toISOString()}\n` +
        `${request.action === "warm" && request.target.kind === "pool" ? "Warm idle slots" : "Warm"}: ` +
        `${preview.affected.map((target) => target.path).join(", ")}\n`),
      cancelRequested: false,
      timer: null,
    };
  }

  /**
   * Run one Warm's targets in order. Each is decided when its turn comes: a slot that is no
   * longer idle then is skipped, untouched. The operation stays listed as `finished` so its
   * results and log can be read, until it is dismissed.
   */
  private async runWarm(entry: HeldOperation): Promise<void> {
    const warm = entry.warm!;
    if (entry.view.state !== "queued") return;
    entry.view.state = "running";
    this.deps.notifyChanged();
    try {
      for (const target of warm.targets) {
        if (warm.controller.signal.aborted) {
          target.outcome = "cancelled";
          target.detail = "cancelled before its turn";
          this.warmOutput(entry, `Slot ${target.ordinal}: cancelled. ${target.detail}\n`);
          continue;
        }
        target.outcome = "running";
        this.deps.notifyChanged();
        let result: WarmSlotResult;
        try {
          result = await this.manager.warmSlot({
            slotId: target.slotId,
            operationId: entry.view.id,
            signal: warm.controller.signal,
            output: (text) => this.warmOutput(entry, text),
            log: { path: warm.log.path, open: () => warm.log.open() },
          });
        } catch (error) {
          console.error("[worktrees] Warm failed:", error);
          result = { outcome: "failed", reason: compact(error instanceof Error ? error.message : String(error)) ?? "Warm failed" };
        }
        switch (result.outcome) {
          case "warmed":
            target.outcome = "warmed";
            target.detail = result.stepsSkipped ? "Its dependencies already matched; no step ran." : null;
            break;
          case "claimFailed":
            target.outcome = "claimFailed";
            target.detail = `Step ${result.warning.step} of ${result.warning.stepCount} ${result.warning.reason}.`;
            break;
          default:
            target.outcome = result.outcome;
            target.detail = compact(result.reason);
        }
        this.warmOutput(entry, `Slot ${target.ordinal}: ${target.outcome}${target.detail ? `. ${target.detail}` : ""}\n`);
      }
      entry.view.state = "finished";
    } catch (error) {
      entry.view.state = "failed";
      entry.view.error = compact(error instanceof Error ? error.message : String(error)) ?? "Warm failed";
      console.error("[worktrees] Warm operation failed:", error);
    } finally {
      entry.view.finishedAt = this.deps.now();
      if (warm.timer) clearTimeout(warm.timer);
      warm.timer = null;
      await warm.log.close();
      this.deps.notifyChanged();
      // A Warm replaces each slot's previous log, which no row names any more.
      await this.sweepWarmLogs();
    }
  }

  /**
   * A Warm's output, already redacted: into its tail and its log. The dashboard learns of it
   * through the content-free worktrees bump, at most once per `warmTailIntervalMs`.
   */
  private warmOutput(entry: HeldOperation, text: string): void | Promise<void> {
    const warm = entry.warm;
    if (!warm || !text) return undefined;
    warm.ring.push(Buffer.from(text, "utf8"));
    const backpressure = warm.log.write(text);
    if (!warm.timer) {
      warm.timer = unref(setTimeout(() => {
        warm.timer = null;
        this.deps.notifyChanged();
      }, this.deps.warmTailIntervalMs));
    }
    return backpressure;
  }

  private warmLogPath(id: string): string {
    return join(this.deps.warmLogsDirectory, `${id}.log`);
  }

  /** A slot row's log path as the slot card links it, or null for a path this service did not name. */
  private warmLogView(path: string | null): WorktreeWarmLogView | null {
    if (!path || dirname(path) !== this.deps.warmLogsDirectory) return null;
    const match = WARM_LOG_NAME.exec(basename(path));
    return match ? { id: match[1]!, path } : null;
  }

  /**
   * Remove every Warm log that no listed operation and no slot row names. Startup runs it once
   * no operation can exist, so only the logs slot rows name survive a restart; each finished
   * Warm and each dismissal runs it again for the logs they left behind.
   */
  async sweepWarmLogs(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.deps.warmLogsDirectory);
    } catch {
      return;
    }
    let referenced: Set<string>;
    try {
      referenced = this.manager.store.depsLogPaths();
    } catch (error) {
      console.warn(`[worktrees] Warm logs were kept: slot rows could not be read: ${compact(String(error))}`);
      return;
    }
    for (const name of names) {
      const match = WARM_LOG_NAME.exec(name);
      if (!match || this.operations.has(match[1]!)) continue;
      const path = this.warmLogPath(match[1]!);
      if (referenced.has(path)) continue;
      try {
        if (!(await lstat(path)).isFile()) continue;
        await rm(path, { force: true });
      } catch (error) {
        console.warn(`[worktrees] Warm log ${path} could not be removed: ${compact(String(error))}`);
      }
    }
  }

  /**
   * A Warm log, for the operation view's and the slot card's link. Only a log a listed
   * operation or a slot row names is served; null for anything else.
   *
   * A log is complete and unbounded, so it is never read into memory: the caller gets a stream
   * of exactly the `size` bytes the file held when it was opened. A running Warm keeps
   * appending, and a fixed length keeps the response's length true.
   */
  async warmLog(id: string): Promise<{ id: string; path: string; size: number; stream: Readable } | null> {
    if (!WARM_LOG_ID.test(id)) return null;
    const path = this.warmLogPath(id);
    if (!this.operations.has(id) && !this.manager.store.depsLogPaths().has(path)) return null;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r");
    } catch {
      return null;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return null;
      }
      if (stat.size === 0) {
        await handle.close();
        return { id, path, size: 0, stream: Readable.from([]) };
      }
      // Closes the handle when it ends, errors, or is destroyed by a client that went away.
      return { id, path, size: stat.size, stream: handle.createReadStream({ start: 0, end: stat.size - 1 }) };
    } catch {
      await handle.close().catch(() => {});
      return null;
    }
  }

  private viewOf(entry: HeldOperation): WorktreeOperationView {
    const { view, warm } = entry;
    let warmView: WorktreeWarmOperationView | null = null;
    if (warm) {
      const tail = warm.ring.read();
      warmView = {
        targets: warm.targets.map((target) => ({ ...target })),
        tail: tail.text,
        truncatedBytes: tail.truncatedBytes,
        log: warm.log.opened ? { id: warm.log.id, path: warm.log.path } : null,
        cancelRequested: warm.cancelRequested,
      };
    }
    return {
      ...view,
      targets: view.targets.map((target) => ({ ...target })),
      removals: view.removals.map((target) => ({ ...target })),
      completed: view.completed.map((target) => ({ ...target })),
      warm: warmView,
    };
  }

  private async runQueued(entry: HeldOperation): Promise<void> {
    entry.view.state = "running";
    try {
      await this.perform(entry.held, entry.acknowledgements, entry.view.id, (target) => {
        entry.view.completed.push({ id: target.id, path: target.path });
      });
      // Success needs no record: the slots are gone or returned, which the inventory shows.
      this.operations.delete(entry.view.id);
    } catch (error) {
      entry.view.state = "failed";
      entry.view.finishedAt = this.deps.now();
      entry.view.changed = error instanceof WorktreeOperationError && error.code === "changed";
      entry.view.error = compact(error instanceof Error ? error.message : String(error)) ?? "operation failed";
      if (!(error instanceof WorktreeOperationError)) {
        console.error("[worktrees] background operation failed:", error);
      }
    } finally {
      this.deps.notifyChanged();
      // A destroy or prune can remove the last slot row that names a Warm log, after its Warm
      // was already dismissed. Whatever the outcome, partial removals included, the log goes now.
      await this.sweepWarmLogs();
    }
  }

  /** Every path a queued or running operation covers, optionally without one operation's own. */
  private pendingPaths(excludeOperation: string | null): Set<string> {
    return new Set([...this.operations.values()]
      .filter((entry) => worktreeOperationPending(entry.view) && entry.view.id !== excludeOperation)
      .flatMap((entry) => entry.view.targets.map((target) => target.path)));
  }

  private operationViews(): WorktreeOperationView[] {
    return [...this.operations.values()].map((entry) => this.viewOf(entry));
  }


  private claim(
    token: string,
    acknowledgements: readonly WorktreeRiskKey[],
  ): { held: HeldPreview; acknowledgementSet: Set<WorktreeRiskKey> } {
    this.pruneTokens();
    const held = this.tokens.get(token);
    this.tokens.delete(token);
    if (!held) throw new WorktreeOperationError(409, "preview expired or is no longer valid; refresh it", "changed");
    if (!held.preview.allowed) throw new WorktreeOperationError(422, held.preview.blockers[0] ?? "operation is blocked", "blocked");
    const acknowledgementSet = new Set(acknowledgements);
    if (acknowledgementSet.size !== acknowledgements.length) {
      throw new WorktreeOperationError(422, "acknowledgement keys must be unique", "blocked");
    }
    const missing = held.preview.requiredAcknowledgements.filter((key) => !acknowledgements.includes(key));
    if (missing.length > 0) {
      throw new WorktreeOperationError(422, `missing acknowledgement: ${missing.join(", ")}`, "blocked");
    }
    const unexpected = acknowledgements.filter((key) => !held.preview.requiredAcknowledgements.includes(key));
    if (unexpected.length > 0) {
      throw new WorktreeOperationError(422, `unexpected acknowledgement: ${unexpected.join(", ")}`, "blocked");
    }
    return { held, acknowledgementSet };
  }

  private async perform(
    held: HeldPreview,
    acknowledgementSet: Set<WorktreeRiskKey>,
    operationId: string | null = null,
    removed: (target: WorktreeActionAffected) => void = () => {},
  ): Promise<WorktreeActionExecuteResult> {
    const observed = await this.observe();
    const rebuilt = await this.buildPreview(held.preview.request, observed, operationId);
    const currentFingerprint = previewFingerprint(rebuilt);
    if (currentFingerprint !== held.fingerprint) {
      throw new WorktreeOperationError(409, "worktree state changed after preview; refresh before executing", "changed");
    }
    // publishOnSuccess covers legacy-only actions where no native manager method calls
    // publish(). Supplying the service publisher also coalesces native mutations through the
    // same content-free invalidation path instead of emitting once from each dependency.
    await this.manager.runChangeBatch(
      () => this.dispatch(held.preview, acknowledgementSet, removed),
      true,
      this.deps.notifyChanged,
    );
    if (held.preview.request.action === "legacyReturn") this.legacyVisibleRevision = null;
    return { ok: true, action: held.preview.request.action, message: this.successMessage(held.preview.request.action) };
  }

  /** `removed` hears each slot the moment its removal is confirmed, so a later failure is partial, not silent. */
  private async dispatch(
    preview: WorktreeActionPreview,
    acknowledgements: Set<WorktreeRiskKey>,
    removed: (target: WorktreeActionAffected) => void,
  ): Promise<void> {
    const request = preview.request;
    if (request.action === "reconcile") {
      if (!(await this.manager.reconcilePoolById(request.poolId))) {
        throw new WorktreeOperationError(409, "native pool disappeared before reconciliation", "changed");
      }
      return;
    }
    if (request.action === "prune") {
      for (const target of preview.affected) {
        const result = await this.manager.removeSlot({
          slotId: target.id,
          expectedVersion: target.version ?? undefined,
          allowDirty: false,
          allowUnmerged: false,
        });
        this.assertRemoved(result);
        removed(target);
      }
      return;
    }
    if (request.action === "legacyReturn") {
      // TaskManager owns agent quiescence, archive capture, durable task fields, and the
      // provider-aware teardown. Its daemon instance receives this same legacy service, so
      // reclaim reaches the exact conditional adapter once and clears task ownership only
      // after Treehouse confirms the path disappeared. Calling executeReturn here as well
      // would run after the durable owner was cleared and would turn success into a false
      // conflict. Check recovery owns the equivalent ordering for check leases.
      if (request.owner.kind === "task") await this.reclaimTask(request.owner.id);
      else await this.recoverCheck(request.owner.id);
      return;
    }
    const recoveredOwners = new Set<string>();
    for (const target of preview.affected) {
      const owner = target.owner;
      const parsedTask = owner?.kind === "task" ? taskIdentity(owner.key) : null;
      const ownerIdentity = owner
        ? owner.kind === "task"
          ? parsedTask ? `task:${parsedTask.id}` : null
          : `${owner.kind}:${owner.key}`
        : null;
      if (!owner || (ownerIdentity && recoveredOwners.has(ownerIdentity))) continue;
      if (owner.kind === "task") {
        if (!parsedTask) throw new WorktreeOperationError(409, "task owner changed after preview", "changed");
        await this.reclaimTask(parsedTask.id);
      } else if (owner.kind === "check") {
        await this.recoverCheck(owner.key);
      } else if (owner.kind === "warm") {
        throw new WorktreeOperationError(409, "a dependency seed holds this slot and returns it when its copy ends", "changed");
      } else {
        const found = this.manager.lookupLease({ path: target.path, owner: { kind: "manual", key: owner.key } });
        if (found.state !== "active") throw new WorktreeOperationError(409, "manual lease changed after preview", "changed");
        const released = await this.manager.release(found.lease, {
          ownerAuthorized: true,
          requireClean: !acknowledgements.has("dirty"),
        });
        if (released.outcome !== "released" && released.outcome !== "alreadyReleased") {
          throw new WorktreeOperationError(released.outcome === "outcomeUnknown" ? 503 : 409, released.reason, released.outcome === "outcomeUnknown" ? "unavailable" : "changed");
        }
      }
      if (ownerIdentity) recoveredOwners.add(ownerIdentity);
    }
    if (request.action === "destroy") {
      for (const target of this.removalTargets(preview)) {
        const result = await this.manager.removeSlot({
          slotId: target.id,
          allowDirty: acknowledgements.has("dirty"),
          allowUnmerged: acknowledgements.has("unlanded"),
        });
        this.assertRemoved(result);
        removed(target);
      }
    }
  }

  /**
   * The exact slots an accepted preview will remove, fixed when it is accepted. Owners of
   * other affected paths are recovered, not removed. A retry after a partial failure is built
   * from this set, so nothing that joined a pool afterwards can ride along.
   */
  private removalTargets(preview: WorktreeActionPreview): WorktreeActionAffected[] {
    const request = preview.request;
    if (request.action === "prune") return preview.affected;
    if (request.action !== "destroy") return [];
    return preview.affected.filter((target) => {
      if (target.provider !== "mission") return false;
      if (request.target.kind === "slot") return target.id === request.target.slotId;
      if (request.target.kind === "slots") return request.target.slotIds.includes(target.id);
      return this.manager.store.slot(target.id)?.poolId === request.target.poolId;
    });
  }

  private async reclaimTask(id: string): Promise<void> {
    const result = await this.deps.tasks.reclaim(id);
    if (!result.ok) throw new WorktreeOperationError(409, result.error ?? "task cleanup was refused", "changed");
  }

  private async recoverCheck(id: string): Promise<void> {
    const result = await this.deps.checks.recoverForOperator(id, this.deps.checkRecovery);
    if (result.outcome === "returned" || result.outcome === "lost") return;
    throw new WorktreeOperationError(409, result.reason, "changed");
  }

  private assertRemoved(result: Awaited<ReturnType<WorktreeManager["removeSlot"]>>): void {
    if (result.outcome === "removed" || result.outcome === "alreadyRemoved") return;
    throw new WorktreeOperationError(
      result.outcome === "outcomeUnknown" ? 503 : result.outcome === "refused" ? 422 : 409,
      result.reason,
      result.outcome === "outcomeUnknown" ? "unavailable" : result.outcome === "refused" ? "blocked" : "changed",
    );
  }

  async slotPath(slotId: string): Promise<string | null> {
    const pool = (await this.manager.status()).find((entry) =>
      entry.slots.some((slot) => slot.slot.id === slotId));
    if (!pool || !pool.identityValid || !pool.markerValid) return null;
    const slot = pool.slots.find((entry) => entry.slot.id === slotId);
    return slot?.nativePath && slot.registered === true && slot.repositoryMatches === true
      ? slot.slot.path
      : null;
  }

  private pruneTokens(): void {
    const now = this.deps.now();
    for (const [token, held] of this.tokens) {
      if (held.preview.expiresAt <= now) this.tokens.delete(token);
    }
  }

  private successMessage(action: WorktreeActionRequest["action"]): string {
    switch (action) {
      case "return": return "Worktree returned to warm capacity.";
      case "prune": return "Safe candidate set pruned.";
      case "reconcile": return "Pool re-observed; uncertainty remains quarantined.";
      case "destroy": return "Fixed worktree target destroyed.";
      case "legacyReturn": return "Exact legacy lease returned through its domain owner.";
      case "warm": return "Warm finished.";
    }
  }
}
