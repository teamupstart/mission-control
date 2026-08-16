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
  type WorktreeInventory,
  type WorktreeOwnerView,
  type WorktreeRepositoryView,
  type WorktreeRiskKey,
} from "@shared/worktrees.ts";
import { run } from "../util/exec.ts";
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
  WorktreeManager,
  type NativePoolStatus,
  type NativeSlotStatus,
} from "./manager.ts";

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
  get(id: string): { id: string; title: string } | null;
  reclaim(id: string): Promise<{ ok: boolean; error?: string }>;
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
}

interface Observation {
  inventory: WorktreeInventory;
  native: NativePoolStatus[];
  legacy: LegacyInventoryItem[];
}

interface HeldPreview {
  preview: WorktreeActionPreview;
  fingerprint: string;
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
  return digest({
    ...preview,
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

async function defaultDiskBytes(path: string): Promise<number | null> {
  try {
    const result = await run("du", ["-sk", path], { timeoutMs: 10_000, maxBuffer: 16 * 1024 });
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
  return [...new Map(risks.map((entry) => [entry.key, entry])).values()];
}

export class WorktreeOperationsService {
  private readonly deps: WorktreeOperationsDeps;
  private readonly tokens = new Map<string, HeldPreview>();
  private legacyVisibleRevision: string | null = null;

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
    return (await this.observe()).inventory;
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
      const slotDisk = await Promise.all(
        pool.slots
          .slice(0, WORKTREE_INVENTORY_LIMITS.slotsPerRepository)
          .map((entry) => this.deps.diskBytes(entry.slot.path)),
      );
      const slots = pool.slots
        .slice(0, WORKTREE_INVENTORY_LIMITS.slotsPerRepository)
        .map((entry, index) => {
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
            diskBytes: slotDisk[index] ?? null,
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
        diskBytes: slots.every((slot) => slot.diskBytes !== null)
          ? slots.reduce((sum, slot) => sum + (slot.diskBytes ?? 0), 0)
          : null,
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
    return { inventory, native, legacy };
  }

  async preview(request: WorktreeActionRequest): Promise<WorktreeActionPreview> {
    this.pruneTokens();
    const observed = await this.observe();
    const built = await this.buildPreview(request, observed);
    const token = this.deps.randomId();
    const preview = { ...built, token, expiresAt: this.deps.now() + TOKEN_TTL_MS };
    const fingerprint = previewFingerprint(built);
    this.tokens.set(token, { preview, fingerprint });
    while (this.tokens.size > WORKTREE_INVENTORY_LIMITS.previewTokens) {
      this.tokens.delete(this.tokens.keys().next().value!);
    }
    return preview;
  }

  private async buildPreview(
    request: WorktreeActionRequest,
    observed: Observation,
  ): Promise<Omit<WorktreeActionPreview, "token" | "expiresAt">> {
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
      const preview = await this.deps.legacy.previewReturn(ref);
      const owner = item.owners[0] ?? null;
      affected.push({
        provider: "treehouse",
        id: digest({ ref, path: item.path }).slice(0, 24),
        path: item.path,
        owner: owner ? { kind: owner.kind, key: owner.id, label: `${owner.kind === "task" ? "Task" : "Check"} ${owner.id}` } : null,
        version: null,
        diskBytes: await this.deps.diskBytes(item.path),
      });
      if (!preview.allowed) blockers.push(preview.reason);
      if (item.classification !== "ownedExact") {
        risks.push(risk("legacy-unverifiable", "Legacy identity is not exact", false));
      }
      consequences.push("Returns only the exact persisted Treehouse lease through its domain owner.");
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
        .filter((candidate) => candidate.safe);
      for (const candidate of candidates) {
        const view = observed.inventory.repositories
          .find((repo) => repo.id === request.poolId)?.slots.find((slot) => slot.id === candidate.slotId);
        affected.push({
          provider: "mission",
          id: candidate.slotId,
          path: candidate.path,
          owner: null,
          version: candidate.slotVersion,
          diskBytes: view?.diskBytes ?? null,
        });
      }
      if (candidates.length === 0) blockers.push("No clean, merged, process-free, unreferenced slots are safe to prune.");
      if (pool.slots.length > pool.policy.maxSlots) {
        risks.push(risk("over-capacity", "Pool is above its configured capacity", false));
      }
      consequences.push("Removes only the fixed safe candidate set shown here; leased or uncertain slots are preserved.");
      return this.finish(request, observed.inventory.revision, affected, risks, blockers, consequences);
    }

    const targets = request.action === "destroy" && request.target.kind === "pool"
      ? pool.slots
      : [pool.slots.find((entry) => entry.slot.id === slotId)!];
    if (targets.length === 0) blockers.push("The fixed pool target contains no slots to destroy.");
    for (const slot of targets) {
      const view = observed.inventory.repositories
        .find((repo) => repo.id === pool.pool.id)!.slots.find((entry) => entry.id === slot.slot.id)!;
      const owner = ownerView(slot, this.deps.tasks);
      affected.push({ provider: "mission", id: slot.slot.id, path: slot.slot.path, owner, version: slot.slot.version, diskBytes: view.diskBytes });
      if (slot.dirty === true) risks.push(risk("dirty", "Dirty or untracked work will be discarded", true));
      else if (slot.dirty === null) blockers.push(`Git cleanliness is unknown for slot ${slot.slot.ordinal}.`);
      if (slot.mergedIntoDefault === false) risks.push(risk("unlanded", "HEAD is not merged into the observed default branch", true));
      else if (slot.mergedIntoDefault === null) blockers.push(`Default-branch relationship is unknown for slot ${slot.slot.ordinal}.`);
      if (slot.occupancy.status === "unknown") {
        risks.push(risk("unknown-occupancy", "Process occupancy is unknown", false));
        blockers.push(slot.occupancy.reason);
      } else if (slot.occupancy.occupants.length > 0 && owner?.kind !== "task") {
        risks.push(risk("occupied", `${slot.occupancy.occupants.length} process(es) occupy a target path`, false));
        blockers.push("Known processes must exit before this action can run.");
      }
      if (!pool.identityValid || !pool.markerValid || !slot.nativePath || slot.registered !== true || slot.repositoryMatches !== true) {
        blockers.push("Exact native pool, marker, Git registration, and repository ownership are not all proven.");
      }
      if (slot.slot.state === "quarantined") risks.push(risk("quarantined", "A target slot is quarantined", false));
      if (request.action === "return" && slot.slot.state !== "leased") {
        blockers.push(`Slot ${slot.slot.ordinal} is ${slot.slot.state}, not leased.`);
      }
      if (request.action === "destroy" && !["leased", "available", "quarantined"].includes(slot.slot.state)) {
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
      if (request.action === "return" && !owner) blockers.push("This slot has no active owner to return.");
    }
    if (request.action === "destroy") {
      consequences.push(request.target.kind === "pool"
        ? "Removes only the fixed manager-owned slot set shown here after final revalidation."
        : "Removes this exact manager-owned Git worktree and its slot row after final revalidation.");
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

  async execute(
    token: string,
    acknowledgements: readonly WorktreeRiskKey[],
  ): Promise<WorktreeActionExecuteResult> {
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
    const observed = await this.observe();
    const rebuilt = await this.buildPreview(held.preview.request, observed);
    const currentFingerprint = previewFingerprint(rebuilt);
    if (currentFingerprint !== held.fingerprint) {
      throw new WorktreeOperationError(409, "worktree state changed after preview; refresh before executing", "changed");
    }
    await this.manager.runChangeBatch(() => this.dispatch(held.preview, acknowledgementSet));
    if (held.preview.request.action === "legacyReturn") this.legacyVisibleRevision = null;
    return { ok: true, action: held.preview.request.action, message: this.successMessage(held.preview.request.action) };
  }

  private async dispatch(preview: WorktreeActionPreview, acknowledgements: Set<WorktreeRiskKey>): Promise<void> {
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
      }
      return;
    }
    if (request.action === "legacyReturn") {
      if (request.owner.kind === "task") await this.reclaimTask(request.owner.id);
      else await this.recoverCheck(request.owner.id);
      return;
    }
    const recoveredOwners = new Set<string>();
    for (const target of preview.affected) {
      const owner = target.owner;
      const ownerIdentity = owner ? `${owner.kind}:${owner.key}` : null;
      if (!owner || (ownerIdentity && recoveredOwners.has(ownerIdentity))) continue;
      if (owner.kind === "task") {
        const task = taskIdentity(owner.key);
        if (!task) throw new WorktreeOperationError(409, "task owner changed after preview", "changed");
        await this.reclaimTask(task.id);
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
      for (const target of preview.affected) {
        const result = await this.manager.removeSlot({
          slotId: target.id,
          allowDirty: acknowledgements.has("dirty"),
          allowUnmerged: acknowledgements.has("unlanded"),
        });
        this.assertRemoved(result);
      }
    }
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
