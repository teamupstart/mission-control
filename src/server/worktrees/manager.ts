import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorktreeProvider } from "@shared/types.ts";
import { WORKTREE_POOLS_DIR, envVar } from "../config.ts";
import { openDb } from "../db.ts";
import { run } from "../util/exec.ts";
import { unref } from "../util/timers.ts";
import {
  worktreeRepositoryIdentity,
  type WorktreeRepositoryIdentity,
} from "../util/git.ts";
import { resolveWorktreePolicy, type WorktreePolicy } from "./config.ts";
import {
  NativeWorktreeGit,
  type GitResult,
  type WorktreeGit,
  type WorktreeRegistration,
} from "./git.ts";
import { ensureWorktreePoolMarker, readWorktreePoolMarker } from "./marker.ts";
import {
  inspectWorktreeOccupancy,
  pathContains,
  type WorktreeOccupancy,
} from "./occupancy.ts";
import {
  WORKTREE_SLOT_STATES,
  WorktreeStore,
  type WorktreePoolRow,
  type WorktreeSlotRow,
} from "./store.ts";

const SHA = /^[0-9a-f]{40}$/;
const MAX_OWNER_BYTES = 512;
const MAX_ERROR_BYTES = 2048;
const DEFAULT_SWEEP_MS = 300_000;
const MIN_SWEEP_MS = 30_000;
const MAX_SWEEP_MS = 604_800_000;

export type WorktreeOwnerKind = "task" | "check" | "manual";
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
  | { outcome: "acquired"; lease: NativeWorktreeLease }
  | { outcome: "notAcquired"; reason: string }
  | { outcome: "outcomeUnknown"; reason: string };

export type WorktreeReleaseResult =
  | { outcome: "released" }
  | { outcome: "alreadyReleased" }
  | { outcome: "refused"; reason: string }
  | { outcome: "outcomeUnknown"; reason: string };

export interface NativeSlotStatus {
  slot: WorktreeSlotRow;
  nativePath: boolean;
  registered: boolean | null;
  repositoryMatches: boolean | null;
  observedHead: string | null;
  dirty: boolean | null;
  occupancy: WorktreeOccupancy;
  ownerReferenced: boolean | null;
}

export interface NativePoolStatus {
  pool: WorktreePoolRow;
  policy: WorktreePolicy;
  identityValid: boolean;
  markerValid: boolean;
  slots: NativeSlotStatus[];
}

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
  runSetup: (argv: readonly string[], cwd: string) => Promise<SetupResult>;
  publishChanged: () => void;
  now: () => number;
  randomId: () => string;
  poolsDirectory: string;
}

const DEFAULT_DEPS: WorktreeManagerDeps = {
  git: new NativeWorktreeGit(),
  occupancy: inspectWorktreeOccupancy,
  resolvePolicy: resolveWorktreePolicy,
  // Phase 1 has no native consumers. Phase 2 replaces this with task/check/manual domain rows.
  ownerReferenced: async () => false,
  runSetup: async (argv, cwd) => {
    const result = await run(argv[0]!, argv.slice(1), {
      cwd,
      timeoutMs: 120_000,
      maxBuffer: 64 * 1024,
    });
    return result.code === 0 && !result.outcomeUnknown && !result.overflowed
      ? { ok: true, reason: null, outcomeUnknown: false }
      : {
          ok: false,
          reason: result.stderr.trim() ||
            (result.outcomeUnknown ? "setup outcome could not be proven" : `setup exited ${result.code}`),
          outcomeUnknown: result.outcomeUnknown,
        };
  },
  publishChanged: () => {},
  now: Date.now,
  randomId: randomUUID,
  poolsDirectory: WORKTREE_POOLS_DIR,
};

function bounded(value: string): string {
  return Buffer.from(value, "utf8").subarray(0, MAX_ERROR_BYTES).toString("utf8");
}

function validOwner(owner: WorktreeOwner): boolean {
  return (
    ["task", "check", "manual"].includes(owner.kind) &&
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
 */
export class WorktreeManager {
  readonly store: WorktreeStore;
  private readonly deps: WorktreeManagerDeps;
  private readonly queues = new Map<string, Promise<void>>();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maintenance: Promise<void> | null = null;
  private reclaimDomainLeases: () => Promise<void> = async () => {};

  constructor(db: DatabaseSync = openDb(), deps: Partial<WorktreeManagerDeps> = {}) {
    this.store = new WorktreeStore(db);
    this.deps = { ...DEFAULT_DEPS, ...deps };
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

  private publish(): void {
    try {
      this.deps.publishChanged();
    } catch (error) {
      console.warn("[worktrees] change publication failed:", error);
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
      if (await this.deps.ownerReferenced(reference)) {
        return "domain owner still references this lease";
      }
    } catch (error) {
      return `domain ownership is unknown: ${bounded(String(error))}`;
    }
    const occupancy = (await this.occupancy([path])).get(path);
    if (!occupancy || occupancy.status === "unknown") {
      return occupancy?.status === "unknown" ? occupancy.reason : "slot occupancy is unknown";
    }
    return occupancy.occupants.length > 0
      ? "one or more processes still occupy the worktree"
      : null;
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

  async acquire(input: {
    repositoryPath: string;
    baseSha: string;
    owner: WorktreeOwner;
  }): Promise<WorktreeAcquireResult> {
    if (!SHA.test(input.baseSha)) {
      return { outcome: "notAcquired", reason: "baseSha must be a full 40-character commit id" };
    }
    if (!validOwner(input.owner)) {
      return { outcome: "notAcquired", reason: "owner kind/key is invalid or exceeds its bound" };
    }
    const identity = this.identity(input.repositoryPath);
    if (!identity) {
      return { outcome: "notAcquired", reason: "repository is bare or its ownership cannot be proven" };
    }
    let policy: WorktreePolicy;
    try {
      policy = this.deps.resolvePolicy(identity.gitCommonDirectory);
    } catch (error) {
      return { outcome: "notAcquired", reason: `native worktree policy is invalid: ${bounded(String(error))}` };
    }
    if (!policy.enabled) return { outcome: "notAcquired", reason: "native worktrees are disabled for this repository" };

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

    const available = this.store.slots(pool.id).filter((slot) => slot.state === "available");
    let registrations: Awaited<ReturnType<WorktreeGit["list"]>> | null = null;
    try {
      registrations = available.length > 0 ? await this.deps.git.list(identity) : null;
    } catch (error) {
      const reason = `Git registrations could not be read: ${bounded(String(error))}`;
      for (const slot of available) this.quarantine(slot, "Git registrations could not be read", reason);
      return { outcome: "notAcquired", reason };
    }
    const occupancy = available.length > 0
      ? await this.occupancy(available.map((slot) => slot.path))
      : new Map<string, WorktreeOccupancy>();
    const eligible: WorktreeSlotRow[] = [];

    if (registrations?.ok === true) {
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
            if (await this.deps.ownerReferenced(priorReference)) {
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
        eligible.push(slot);
      }
    } else if (registrations && !registrations.ok) {
      for (const slot of available) this.quarantine(slot, "Git registrations could not be read", registrations.reason);
      return {
        outcome: "notAcquired",
        reason: `Git registrations could not be read: ${registrations.reason}`,
      };
    }

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
    this.publish();

    return this.withSlot(reservation.id, async () => {
      try {
        if (!created) {
          const freshOccupancy = (await this.occupancy([reservation.path])).get(reservation.path);
          if (!freshOccupancy || freshOccupancy.status === "unknown") {
            const reason = freshOccupancy?.status === "unknown"
              ? freshOccupancy.reason
              : "slot occupancy was not observed";
            this.quarantine(reservation, "slot occupancy became unknown before reset", reason);
            return { outcome: "outcomeUnknown", reason };
          }
          if (freshOccupancy.occupants.length > 0) {
            const reason = "a process entered the available slot before reset";
            this.quarantine(reservation, reason);
            return { outcome: "outcomeUnknown", reason };
          }
        }

        const mutation = created
          ? await this.deps.git.add(identity, reservation.path, input.baseSha)
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
          const setup = await this.deps.runSetup(policy.setupArgv, reservation.path);
          if (!setup.ok || setup.outcomeUnknown) {
            const reason = setup.reason ??
              (setup.outcomeUnknown ? "setup outcome could not be proven" : "setup failed");
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

        const inspection = await this.deps.git.inspect(reservation.path);
        if (
          !inspection.ok ||
          inspection.value.path !== reservation.path ||
          inspection.value.commonDirectory !== identity.gitCommonDirectory ||
          inspection.value.head !== input.baseSha ||
          inspection.value.dirty
        ) {
          const reason = inspection.ok
            ? "materialized slot failed path, repository, exact HEAD, or cleanliness verification"
            : inspection.reason;
          this.quarantine(reservation, "materialized slot verification failed", reason);
          return { outcome: "outcomeUnknown", reason };
        }

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
        };
      } catch (error) {
        const reason = bounded(String(error));
        this.quarantine(reservation, "native worktree materialization outcome is unknown", reason);
        return { outcome: "outcomeUnknown", reason };
      }
    });
  }

  async release(lease: NativeWorktreeLease): Promise<WorktreeReleaseResult> {
    if (lease.provider !== "mission") return { outcome: "refused", reason: "lease provider is not mission" };
    const pool = this.store.poolForSlot(lease.slotId);
    if (!pool) return { outcome: "refused", reason: "native slot no longer exists" };
    return this.withSlot(lease.slotId, async () => {
      const slot = this.store.slot(lease.slotId);
      if (!slot) return { outcome: "refused", reason: "native slot no longer exists" };
      if (
        slot.lastReleasedLeaseId === lease.leaseId &&
        slot.lastReleasedOwnerKind === lease.owner.kind &&
        slot.lastReleasedOwnerKey === lease.owner.key
      ) {
        return { outcome: "alreadyReleased" };
      }
      if (
        slot.state !== "leased" ||
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
      const initialBlocker = await this.releaseBlocker(reference, slot.path);
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
      const freshBlocker = await this.releaseBlocker(reference, slot.path);
      if (freshBlocker) return { outcome: "refused", reason: freshBlocker };
      let returning: WorktreeSlotRow | null;
      try {
        returning = this.store.markReturning(slot.id, slot.version, target.value, this.deps.now());
      } catch (error) {
        return { outcome: "outcomeUnknown", reason: bounded(String(error)) };
      }
      if (!returning) return { outcome: "outcomeUnknown", reason: "return intent could not be persisted" };
      this.publish();
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
        inspected.value.commonDirectory !== pool.gitCommonDirectory
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
    });
  }

  async reconcile(): Promise<void> {
    for (const pool of this.store.pools()) {
      await this.reconcilePool(pool);
    }
  }

  private async reconcilePool(pool: WorktreePoolRow): Promise<void> {
    const now = this.deps.now();
    const identity = this.identity(pool.mainCheckoutRoot);
    const slots = this.store.slots(pool.id);
    const failPool = async (reason: string) => {
      for (const original of slots) {
        const releaseSlot = await this.acquireSlotLock(original.id);
        try {
          const slot = this.store.slot(original.id);
          if (slot?.version === original.version && slot.state !== "quarantined") {
            this.quarantine(slot, reason);
          }
        } finally {
          releaseSlot();
        }
      }
      this.store.recordReconciliation(pool.id, now, bounded(reason));
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
      const releaseSlot = await this.acquireSlotLock(original.id);
      try {
        const current = this.store.slot(original.id);
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
            if (prior && (await this.deps.ownerReferenced(prior))) {
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
        try {
          if (!(await this.deps.ownerReferenced(active))) {
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
    this.store.recordReconciliation(pool.id, now, errors.length > 0 ? bounded(errors.join("; ")) : null);
  }

  async status(): Promise<NativePoolStatus[]> {
    const pools = this.store.pools();
    const allSlots = this.store.slots();
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
      if (identityValid && identity) {
        try {
          listed = await this.deps.git.list(identity);
        } catch {
          listed = null;
        }
      }
      const slots: NativeSlotStatus[] = [];
      for (const slot of allSlots.filter((candidate) => candidate.poolId === pool.id)) {
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
            referenced = await this.deps.ownerReferenced(reference);
          } catch {
            referenced = null;
          }
        }
        const nativePath = Boolean(identity && exactSlotPath(pool, identity, slot));
        const registration = listed?.ok === true
          ? registrationFor(listed.value, slot.path)
          : null;
        slots.push({
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
        });
      }
      output.push({
        pool,
        policy: this.deps.resolvePolicy(pool.gitCommonDirectory),
        identityValid,
        markerValid,
        slots,
      });
    }
    return output;
  }

  /** Preview-only safe prune and right-size candidates. No filesystem mutation occurs. */
  async planMaintenance(): Promise<NativeMaintenanceCandidate[]> {
    const status = await this.status();
    const candidates: NativeMaintenanceCandidate[] = [];
    for (const poolStatus of status) {
      const identity = this.identity(poolStatus.pool.mainCheckoutRoot);
      let target: Awaited<ReturnType<WorktreeGit["observedDefaultSha"]>> | null = null;
      if (identity && poolStatus.identityValid && poolStatus.markerValid) {
        try {
          target = await this.deps.git.observedDefaultSha(identity);
        } catch (error) {
          target = { ok: false, reason: bounded(String(error)), outcomeUnknown: true };
        }
      }
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
        else if (!target?.ok) reason = target?.reason ?? "pool repository identity is unknown";
        else {
          try {
            const merged = await this.deps.git.mergedInto(entry.slot.path, target.value);
            if (!merged.ok) reason = merged.reason;
            else if (!merged.value) reason = "slot HEAD is not merged into the observed remote default";
          } catch (error) {
            reason = bounded(String(error));
          }
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
    try {
      if (this.store.poolCount() === 0) return;
    } catch (error) {
      console.error("[worktrees] maintenance could not read native pools:", error);
      return;
    }
    try {
      await this.reconcile();
    } catch (error) {
      console.error("[worktrees] maintenance reconciliation failed:", error);
    }
    try {
      await this.reclaimDomainLeases();
    } catch (error) {
      console.error("[worktrees] domain lease reclamation failed:", error);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.maintenance;
  }
}
