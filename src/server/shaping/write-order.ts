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
 * `SHAPING_WRITE_WINDOW_MS` is how long a write stays able to apply after it was sent, and so how
 * long the daemon keeps each record of a write it applied. A sequence is the time the page sent
 * the write, in microseconds (`nextShapingWriteSequence`), on the same clock as the daemon's, since
 * only a loopback client may write. A write sent longer ago than that is refused outright, and a
 * record is dropped only once it is older than that: by then every write sent before the one it
 * records is past the window too, so a record is never forgotten while a write it must refuse
 * could still apply. Never bounded by count, which enough traffic from other pages could exhaust.
 */
export { SHAPING_WRITE_WINDOW_MS };

const ID = /^[A-Za-z0-9-]{1,64}$/;
/** The most earlier ids one write may name. */
const LINEAGE_ACCEPTED = 16;

/** The newest sequence applied per window and control, and when, oldest first. */
const applied = new Map<string, { sequence: number; at: number }>();

const slot = (window: string, control: string): string => `${window}\n${control}`;

/** The order a request declares, or null for one that declares none or an unreadable one. */
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
 * Whether the write was sent longer ago than `SHAPING_WRITE_WINDOW_MS`, by its sequence: the record
 * of a newer write that must refuse it may already be gone, so it is refused itself.
 */
export function shapingWriteExpired(order: ShapingWriteOrder, now = Date.now()): boolean {
  return order.sequence / 1000 < now - SHAPING_WRITE_WINDOW_MS;
}

/**
 * Record that this write was applied, for the writes from the same page, and from the earlier
 * pages of its tab, sent before it.
 */
export function noteShapingWriteApplied(order: ShapingWriteOrder, now = Date.now()): void {
  for (const window of [order.window, ...order.lineage]) {
    for (const control of order.controls) {
      const key = slot(window, control);
      const sequence = Math.max(applied.get(key)?.sequence ?? 0, order.sequence);
      applied.delete(key);
      applied.set(key, { sequence, at: now });
    }
  }
  // Oldest first, so the expired records are the leading ones.
  for (const [key, record] of applied) {
    if (now - record.at <= SHAPING_WRITE_WINDOW_MS) break;
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

/** The refusal for a write sent longer ago than `SHAPING_WRITE_WINDOW_MS`. */
export const EXPIRED_WRITE_REFUSAL = {
  error: "expired",
  reason: "This change was sent more than 10 minutes ago, so it was not applied: a newer change may have been made since. Check what is shown now, and make it again if it is missing.",
} as const;

/** The refusal for a write a newer one from the same window already overtook. */
export const SUPERSEDED_WRITE_REFUSAL = {
  error: "superseded",
  reason: "A newer change made in this tab, or in one duplicated from it, was applied first, so this earlier one was not.",
} as const;

export { SHAPING_WRITE_ORDER_HEADER };
