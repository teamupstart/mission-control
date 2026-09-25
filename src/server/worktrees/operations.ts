import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
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
  type WorktreeInventory,
  type WorktreeOperationView,
  type WorktreeOwnerView,
  type WorktreeRepositoryView,
  type WorktreeRiskKey,
} from "@shared/worktrees.ts";
import { run } from "../util/exec.ts";
import { worktreeRepositoryIdentity } from "../util/git.ts";
import type {
  CheckGroupRecovery,
  CheckLeaseManager,
} from "../workflows/check-lease.ts";
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
  type NativePoolStatus,
  type NativeSlotStatus,
} from "./manager.ts";
import {
  inspectWorktreeOccupancy,
  type WorktreeOccupancy,
} from "./occupancy.ts";

const TOKEN_TTL_MS = 2 * 60_000;

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
  /** Accepted cleanups that may be queued or running at once; further submissions are refused. */
  maxPendingOperations: number;
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
): WorktreeOwnerView | null {
  const kind = status.slot.activeOwnerKind;
  const key = status.slot.activeOwnerKey;
  if ((kind !== "task" && kind !== "check" && kind !== "manual") || !key) return null;
  if (kind === "task") {
    const parsed = taskIdentity(key);
    const row = parsed ? task.get(parsed.id) : null;
    return { kind, key, label: row?.title ?? `Task ${parsed?.id ?? key}` };
  }
  return {
    kind,
    key,
    label: kind === "check" ? `Check ${key}` : `Manual lease ${key.slice(0, 8)}`,
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

export class WorktreeOperationsService {
  private readonly deps: WorktreeOperationsDeps;
  private readonly tokens = new Map<string, HeldPreview>();
  private legacyVisibleRevision: string | null = null;
  private observing: Promise<Observation> | null = null;
  private nextObservation: Promise<Observation> | null = null;
  private readonly operations = new Map<string, HeldOperation>();
  private queue: Promise<void> = Promise.resolve();

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
      maxPendingOperations: WORKTREE_INVENTORY_LIMITS.operations,
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
    const repositories: WorktreeRepositoryView[] = [];
    for (const pool of native.slice(0, WORKTREE_INVENTORY_LIMITS.repositories)) {
      const slots = pool.slots
        .slice(0, WORKTREE_INVENTORY_LIMITS.slotsPerRepository)
        .map((entry) => {
          const owner = ownerView(entry, this.deps.tasks);
          const processes = entry.occupancy.status === "known"
            ? { state: "known" as const, count: entry.occupancy.occupants.length, reason: null }
            : { state: "unknown" as const, count: null, reason: compact(entry.occupancy.reason) };
          const exact = pool.identityValid && pool.markerValid && entry.nativePath &&
            entry.registered === true && entry.repositoryMatches === true;
          const actions: Array<"return" | "destroy"> = [];
          if (entry.slot.state === "leased") actions.push("return", "destroy");
          else if ((entry.slot.state === "available" || entry.slot.state === "quarantined") && exact) {
            actions.push("destroy");
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
        },
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve("expired");
      }, this.deps.diskMeasureBudgetMs);
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
      clearTimeout(timer);
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
    const pending = [...this.operations.values()].filter((entry) => entry.view.state !== "failed");
    if (pending.length >= this.deps.maxPendingOperations) {
      // Refused before the token is claimed, so the same preview can be executed again once
      // earlier cleanups finish. Accepted work is never dropped to make room.
      throw new WorktreeOperationError(
        503,
        `${pending.length} cleanups are already queued; execute again when some have finished`,
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
    };
    const entry: HeldOperation = { view, held, acknowledgements: acknowledgementSet };
    this.operations.set(view.id, entry);
    this.trimOperations();
    // A throwing publisher must not wedge every later operation behind a rejected link.
    this.queue = this.queue.then(() => this.runQueued(entry)).catch(() => {});
    this.deps.notifyChanged();
    return { ok: true, operation: { ...view } };
  }

  /** Settles when every operation accepted so far has finished, whatever its outcome. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Forget a failed operation the operator has read. Queued and running work cannot be dismissed. */
  dismiss(id: string): boolean {
    const entry = this.operations.get(id);
    if (!entry || entry.view.state !== "failed") return false;
    this.operations.delete(id);
    this.deps.notifyChanged();
    return true;
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
    }
  }

  /** Every path a queued or running operation covers, optionally without one operation's own. */
  private pendingPaths(excludeOperation: string | null): Set<string> {
    return new Set([...this.operations.values()]
      .filter((entry) => entry.view.state !== "failed" && entry.view.id !== excludeOperation)
      .flatMap((entry) => entry.view.targets.map((target) => target.path)));
  }

  private operationViews(): WorktreeOperationView[] {
    return [...this.operations.values()].map(({ view }) => ({
      ...view,
      targets: view.targets.map((target) => ({ ...target })),
      removals: view.removals.map((target) => ({ ...target })),
      completed: view.completed.map((target) => ({ ...target })),
    }));
  }

  /**
   * Bounded: pending work is capped at submission, so only failures accumulate here, and the
   * oldest go first. Pending work is never forgotten.
   */
  private trimOperations(): void {
    for (const [id, entry] of this.operations) {
      if (this.operations.size <= WORKTREE_INVENTORY_LIMITS.operations) return;
      if (entry.view.state === "failed") this.operations.delete(id);
    }
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
    }
  }
}
