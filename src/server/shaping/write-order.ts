import { randomUUID } from "node:crypto";
import { SHAPING_WRITE_ORDER_HEADER, SHAPING_WRITE_WINDOW_MS } from "@shared/shaping.ts";

/**
 * This daemon process, random per process and published in every config view. The ordering below
 * lives in memory, so a restart forgets it: a write made against the process before, delayed until
 * after the restart, could otherwise be applied after a newer one. Such a write names the earlier
 * instance, and is refused.
 */
export const DAEMON_SHAPING_INSTANCE = randomUUID();

/**
 * Write ordering for one dashboard tab's shaping writes. A write can wait inside the daemon,
 * for shaper discovery, after the page that sent it has stopped waiting for its answer and sent
 * a newer one, or after its tab has reloaded. Each write carries its page's id, its sequence and
 * the controls it affects (`SHAPING_WRITE_ORDER_HEADER`), and is refused, as it is about to apply,
 * when a later write from the same page has already been applied to any of those controls. Each
 * page load takes a new id and names the ids its tab wrote under before, its lineage, and a write
 * applied is recorded against those too. So a delayed write never overwrites a newer edit made in
 * the same tab after its answer was lost, a reload of the tab included.
 *
 * A duplicated tab inherits that lineage, so its writes are recorded against the original tab's
 * id as well: an earlier write of the original's, delayed past a later one of the duplicate's on
 * the same control, is refused too. That is the safe side: the newer edit stands either way. The
 * duplicate's own writes are only ever checked against its own id, never refused for the original's.
 */
export interface ShapingWriteOrder {
  window: string;
  sequence: number;
  controls: string[];
  /** The daemon instance whose view the page last read, when it named one. */
  instance: string | null;
  /** The ids the same tab wrote under before this page loaded. */
  lineage: string[];
}

/**
 * The daemon keeps each record of an applied write for `SHAPING_WRITE_WINDOW_MS` after it last
 * applied, measured on the process's monotonic clock, and never bounds the records by count, which
 * enough traffic from other pages could exhaust. A record it drops raises a floor to the sequence it
 * held, and any write at or below that floor is refused as expired: a write a dropped record would
 * have refused is always at or below it. The decision compares sequences only, so no change to the
 * wall clock, forward or back, can make a write eligible again once its record is gone.
 */
export { SHAPING_WRITE_WINDOW_MS };

const ID = /^[A-Za-z0-9-]{1,64}$/;
/** The most earlier ids one write may name. */
const LINEAGE_ACCEPTED = 16;

/** The newest sequence applied per window and control, and when on the monotonic clock, oldest first. */
const applied = new Map<string, { sequence: number; at: number }>();
/** The highest sequence any dropped record held. */
let floor = 0;

const slot = (window: string, control: string): string => `${window}\n${control}`;

/** The order a request declares, or null for one that declares none or an unreadable one: the route refuses the latter. */
export function readShapingWriteOrder(header: string | undefined): ShapingWriteOrder | null {
  if (!header) return null;
  const [window, sequence, controls, instance, lineage, ...rest] = header.trim().split(" ");
  if (rest.length > 0 || !window || !sequence || !controls) return null;
  if (instance !== undefined && !ID.test(instance)) return null;
  if (!ID.test(window)) return null;
  const earlier = lineage === undefined ? [] : lineage.split(",");
  if (earlier.length > LINEAGE_ACCEPTED || earlier.some((id) => !ID.test(id))) return null;
  const number = Number(sequence);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const list = controls.split(",");
  if (list.length > 8 || list.some((control) => !/^[A-Za-z0-9:._-]{1,96}$/.test(control))) return null;
  return { window, sequence: number, controls: list, instance: instance ?? null, lineage: earlier };
}

/** Whether a write from the same window, sent after this one, has already been applied to one of its controls. */
export function shapingWriteSuperseded(order: ShapingWriteOrder): boolean {
  return order.controls.some((control) => (applied.get(slot(order.window, control))?.sequence ?? 0) > order.sequence);
}

/**
 * Whether the write is at or below the floor of dropped records: a record of a newer write that must
 * refuse it may be gone, so it is refused itself.
 */
export function shapingWriteExpired(order: ShapingWriteOrder): boolean {
  return order.sequence <= floor;
}

/** The floor of dropped records, which a refused page raises its next sequences above. */
export function shapingWriteFloor(): number {
  return floor;
}

/**
 * Record that this write was applied, for the writes from the same page, and from the earlier
 * pages of its tab, sent before it.
 */
export function noteShapingWriteApplied(order: ShapingWriteOrder, now = performance.now()): void {
  for (const window of [order.window, ...order.lineage]) {
    for (const control of order.controls) {
      const key = slot(window, control);
      const sequence = Math.max(applied.get(key)?.sequence ?? 0, order.sequence);
      applied.delete(key);
      applied.set(key, { sequence, at: now });
    }
  }
  // Oldest first, so the records to drop are the leading ones.
  for (const [key, record] of applied) {
    if (now - record.at <= SHAPING_WRITE_WINDOW_MS) break;
    floor = Math.max(floor, record.sequence);
    applied.delete(key);
  }
}

/** How many window and control records the daemon holds. For tests. */
export function heldShapingWriteRecords(): number {
  return applied.size;
}

/**
 * Whether the write was made against an earlier daemon process than this one. An ordered write
 * that names no instance was made against a daemon older than instances, whose views carry none:
 * one delayed across the upgrade to this one would otherwise apply after a newer write, so it
 * counts as earlier too. A write with no order at all, from another client, is not ordered.
 */
export function shapingWriteFromEarlierInstance(order: ShapingWriteOrder): boolean {
  return order.instance !== DAEMON_SHAPING_INSTANCE;
}

/** The refusal for a write made against a daemon process that has since restarted. */
export const EARLIER_INSTANCE_REFUSAL = {
  error: "daemon_restarted",
  reason: "This change was made before the daemon restarted or was upgraded, so it was not applied: a newer change may have been made since. Check what is shown now, and make it again if it is missing.",
} as const;

/** The refusal for a write at or below the floor of dropped records, with that floor. */
export function expiredWriteRefusal(): { error: "expired"; reason: string; floor: number } {
  return {
    error: "expired",
    reason: "This change waited too long to be applied, so it was not: a newer change may have been made since it was sent. Check what is shown now, and make it again if it is missing.",
    floor,
  };
}

/** The refusal for a write whose order header was sent but cannot be read. */
export const UNREADABLE_ORDER_REFUSAL = {
  error: "unreadable_order",
  reason: "This change's write order could not be read, so it was not applied. Reload the page and make it again.",
} as const;

/** The refusal for a write a newer one from the same window already overtook. */
export const SUPERSEDED_WRITE_REFUSAL = {
  error: "superseded",
  reason: "A newer change made in this tab, or in one duplicated from it, was applied first, so this earlier one was not.",
} as const;

export { SHAPING_WRITE_ORDER_HEADER };
