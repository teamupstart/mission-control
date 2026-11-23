import { basename } from "node:path";
import { WORKTREE_INVENTORY_LIMITS } from "@shared/worktrees.ts";
import type {
  IdleCacheBlockedSlot,
  IdleCachePlan,
  IdleCachePoolView,
  IdleCacheSlot,
} from "@shared/storage-health.ts";
import { maintenanceCandidates, type NativePoolStatus } from "./worktrees/manager.ts";

/** A pool directory is `<repository folder>-<16 hex>`; the folder is what an operator recognizes. */
function poolName(poolPath: string): string {
  return basename(poolPath).replace(/-[0-9a-f]{16}$/, "");
}

const sum = (values: Array<number | null>): number =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

/**
 * Choose what the idle-cache budget removes, from one observation of every pool.
 *
 * Only `available` slots are idle. Leased, quarantined and in-flight slots never count against
 * the budget and are never chosen. Within each pool the `keepWarm` most recently used idle
 * slots stay, so a repository keeps a warm checkout for its next session. The rest are taken
 * least recently used first, across pools, until the idle total fits the budget.
 *
 * Each choice must pass the Safe prune bar (`maintenanceCandidates`): unreferenced by any task
 * or check lease, clean, merged into the remote default, registered, with no process in it. One
 * that does not is listed as blocked, with the reason, and the next is tried. So is a slot the
 * last measurement did not size, because removing it proves nothing against the budget.
 *
 * An unsized slot is never counted as empty. The totals cover measured slots only and the plan
 * reports how many idle slots are unsized, so a machine nothing has measured yet reads as
 * "unknown", never as "within budget".
 */
export function planIdleCache(input: {
  status: NativePoolStatus[];
  slotBytes: (path: string) => number | null;
  sizesMeasuredAt: number | null;
  budgetBytes: number | null;
  keepWarm: number;
  now: number;
}): IdleCachePlan {
  const safety = new Map(maintenanceCandidates(input.status).map((candidate) => [candidate.slotId, candidate]));
  const pools: IdleCachePoolView[] = [];
  const eligible: Array<{ slot: IdleCacheSlot; ordinal: number }> = [];
  const untouched = { leased: 0, leasedBytes: 0, quarantined: 0, quarantinedBytes: 0, warm: 0, warmBytes: 0 };
  let idleBytes = 0;
  let unmeasuredIdle = 0;

  for (const { pool, policy, slots } of input.status) {
    const name = poolName(pool.poolPath);
    const sized = slots.map(({ slot }) => ({ slot, bytes: input.slotBytes(slot.path) }));
    const idle = sized
      .filter(({ slot }) => slot.state === "available")
      .sort((left, right) => (right.slot.lastUsedAt ?? -1) - (left.slot.lastUsedAt ?? -1) ||
        left.slot.ordinal - right.slot.ordinal);
    const leased = sized.filter(({ slot }) => slot.state === "leased");
    const quarantined = sized.filter(({ slot }) => slot.state === "quarantined");
    const warm = idle.slice(0, input.keepWarm);
    untouched.leased += leased.length;
    untouched.leasedBytes += sum(leased.map(({ bytes }) => bytes));
    untouched.quarantined += quarantined.length;
    untouched.quarantinedBytes += sum(quarantined.map(({ bytes }) => bytes));
    untouched.warm += warm.length;
    untouched.warmBytes += sum(warm.map(({ bytes }) => bytes));
    const poolIdleBytes = sum(idle.map(({ bytes }) => bytes));
    const poolUnmeasured = idle.filter(({ bytes }) => bytes === null).length;
    idleBytes += poolIdleBytes;
    unmeasuredIdle += poolUnmeasured;
    for (const { slot, bytes } of idle.slice(input.keepWarm)) {
      eligible.push({
        slot: {
          slotId: slot.id,
          poolId: pool.id,
          poolName: name,
          path: slot.path,
          bytes,
          lastUsedAt: slot.lastUsedAt,
        },
        ordinal: slot.ordinal,
      });
    }
    pools.push({
      poolId: pool.id,
      name,
      path: pool.poolPath,
      maxSlots: policy.maxSlots,
      leased: leased.length,
      idle: idle.length,
      quarantined: quarantined.length,
      other: slots.length - leased.length - idle.length - quarantined.length,
      bytes: sized.every(({ bytes }) => bytes === null) ? null : sum(sized.map(({ bytes }) => bytes)),
      idleBytes: poolIdleBytes,
      unmeasuredIdle: poolUnmeasured,
      remove: 0,
      removeBytes: 0,
      blocked: 0,
    });
  }

  const remove: IdleCacheSlot[] = [];
  const blocked: IdleCacheBlockedSlot[] = [];
  let remaining = idleBytes;
  if (input.budgetBytes !== null) {
    eligible.sort((left, right) => (left.slot.lastUsedAt ?? -1) - (right.slot.lastUsedAt ?? -1) ||
      right.ordinal - left.ordinal);
    for (const { slot } of eligible) {
      if (remaining <= input.budgetBytes || remove.length >= WORKTREE_INVENTORY_LIMITS.bulkSlots) break;
      const candidate = safety.get(slot.slotId);
      let reason: string | null = null;
      if (slot.bytes === null) reason = "not measured yet; measure again to size it";
      else if (!candidate?.safe) reason = candidate?.reason ?? "slot safety is unknown";
      if (reason !== null) {
        blocked.push({ ...slot, reason });
        continue;
      }
      remove.push(slot);
      remaining -= slot.bytes ?? 0;
    }
  }

  for (const view of pools) {
    const chosen = remove.filter((slot) => slot.poolId === view.poolId);
    view.remove = chosen.length;
    view.removeBytes = sum(chosen.map((slot) => slot.bytes));
    view.blocked = blocked.filter((slot) => slot.poolId === view.poolId).length;
  }
  pools.sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0) || left.name.localeCompare(right.name));

  const freesBytes = sum(remove.map((slot) => slot.bytes));
  return {
    observedAt: input.now,
    sizesMeasuredAt: input.sizesMeasuredAt,
    budgetBytes: input.budgetBytes,
    keepWarm: input.keepWarm,
    pools,
    idleBytes,
    unmeasuredIdle,
    remove,
    blocked,
    freesBytes,
    afterIdleBytes: Math.max(0, idleBytes - freesBytes),
    untouched,
  };
}

/**
 * The slot ids the saved idle-cache budget removes from `status` right now: what a `trimIdle`
 * preview, and the rebuild Execute runs before removing anything, is checked against.
 */
export function idleCacheSelection(input: Omit<Parameters<typeof planIdleCache>[0], "now">): ReadonlySet<string> {
  return new Set(planIdleCache({ ...input, now: Date.now() }).remove.map((slot) => slot.slotId));
}
