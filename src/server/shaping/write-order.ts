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
 * for shaper discovery, after the tab that sent it has stopped waiting for its answer and sent
 * a newer one, or has reloaded. Each write carries its tab's id, its sequence and the controls it
 * affects (`SHAPING_WRITE_ORDER_HEADER`), and is refused, as it is about to apply, when a later
 * write from the same tab has already been applied to any of those controls. A tab keeps its id
 * across any number of reloads, so a delayed write never overwrites a newer edit made in the same
 * tab after its answer was lost.
 *
 * A duplicated tab copies that id, so a tab and its duplicates are ordered together: a delayed older
 * write from any of them is refused once a newer one from any of them applied. The newer edit
 * stands either way, and the refusal says the newer change may have come from a duplicate.
 */
export interface ShapingWriteOrder {
  window: string;
  sequence: number;
  controls: string[];
  /** The daemon instance whose view the tab last read, when it named one. */
  instance: string | null;
}

/**
 * The daemon keeps each record of an applied write for `SHAPING_WRITE_WINDOW_MS` after it last
 * applied, measured on the process's monotonic clock, and at most `SHAPING_WRITE_RECORDS_KEPT` of
 * them, dropping the oldest first. Whichever way a record goes, it raises a floor to the sequence it
 * held, and any write at or below that floor is refused as expired: a write a dropped record would
 * have refused is always at or below it, so dropping one early, under a burst, only refuses more.
 * That comparison is of sequences only, so no wall clock change can make such a write eligible
 * again. A write is also refused once its sequence is older than the window by the wall clock, so
 * it expires even on a daemon where nothing else was written: that check can only refuse.
 */
export { SHAPING_WRITE_WINDOW_MS };

/** The most write records the daemon keeps, whatever ids callers send. */
export const SHAPING_WRITE_RECORDS_KEPT = 4096;

/**
 * How far ahead of both the daemon's clock and the floor a sequence may be. A dashboard numbers its
 * writes by the same clock, raised past the floor when refused, so its sequences sit well inside
 * this; one further ahead can only come from a broken or hostile client, and is refused rather than
 * allowed to push the floor past where every other tab can follow.
 */
export const SHAPING_SEQUENCE_LEAD_MS = 60_000;

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** The newest sequence applied per window and control, and when on the monotonic clock, oldest first. */
const applied = new Map<string, { sequence: number; at: number }>();
/** The highest sequence any dropped record held. */
let floor = 0;

const slot = (window: string, control: string): string => `${window}\n${control}`;

/** The order a request declares, or null for one that declares none or an unreadable one: the route refuses the latter. */
export function readShapingWriteOrder(header: string | undefined): ShapingWriteOrder | null {
  if (!header) return null;
  const [window, sequence, controls, instance, ...rest] = header.trim().split(" ");
  if (rest.length > 0 || !window || !sequence || !controls) return null;
  if (instance !== undefined && !ID.test(instance)) return null;
  if (!ID.test(window)) return null;
  const number = Number(sequence);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const list = controls.split(",");
  if (list.length > 8 || list.some((control) => !/^[A-Za-z0-9:._-]{1,96}$/.test(control))) return null;
  return { window, sequence: number, controls: list, instance: instance ?? null };
}

/**
 * Whether a write from the same tab, sent after this one or numbered the same, has already been
 * applied to one of its controls. A request is never sent twice under one sequence, so an equal one
 * is another page's, a duplicated tab's, whose clock gave both the same number: which of the two
 * was meant last cannot be told, and the one already applied stands.
 */
export function shapingWriteSuperseded(order: ShapingWriteOrder): boolean {
  return order.controls.some((control) => (applied.get(slot(order.window, control))?.sequence ?? 0) >= order.sequence);
}

/**
 * Whether the write is at or below the floor of dropped records, where a record of a newer write
 * that must refuse it may be gone, or was sent longer ago than `SHAPING_WRITE_WINDOW_MS` by the wall
 * clock, however quiet the daemon has been since.
 */
export function shapingWriteExpired(order: ShapingWriteOrder, now = Date.now()): boolean {
  return order.sequence <= floor || order.sequence / 1000 < now - SHAPING_WRITE_WINDOW_MS;
}

/** Whether the write's sequence is further ahead of the daemon's clock and the floor than any tab's can be. */
export function shapingWriteTooFarAhead(order: ShapingWriteOrder, now = Date.now()): boolean {
  return order.sequence > Math.max(now * 1000, floor) + SHAPING_SEQUENCE_LEAD_MS * 1000;
}

/** The floor of dropped records, which a refused page raises its next sequences above. */
export function shapingWriteFloor(): number {
  return floor;
}

/** Record that this write was applied, for the writes from the same tab sent before it. */
export function noteShapingWriteApplied(order: ShapingWriteOrder, now = performance.now()): void {
  for (const control of order.controls) {
    const key = slot(order.window, control);
    const sequence = Math.max(applied.get(key)?.sequence ?? 0, order.sequence);
    applied.delete(key);
    applied.set(key, { sequence, at: now });
  }
  dropShapingWriteRecords(now);
}

/**
 * Drop the records older than the window, and the oldest beyond `SHAPING_WRITE_RECORDS_KEPT`,
 * raising the floor to each dropped record's sequence. Run on every ordered request, refused ones
 * included, so records never outlive the window for want of another successful write.
 */
export function dropShapingWriteRecords(now = performance.now()): void {
  // Oldest first, so the records to drop are the leading ones.
  for (const [key, record] of applied) {
    if (now - record.at <= SHAPING_WRITE_WINDOW_MS && applied.size <= SHAPING_WRITE_RECORDS_KEPT) break;
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

/** The refusal for a write numbered further ahead than any dashboard tab numbers one. */
export const SEQUENCE_TOO_FAR_AHEAD_REFUSAL = {
  error: "unreadable_order",
  reason: "This change's write order is too far ahead of the daemon's clock, so it was not applied. Reload the page and make it again.",
} as const;

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
