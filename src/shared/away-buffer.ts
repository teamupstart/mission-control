// The away buffer: what happened while you were gone, folded into something short
// enough to read on your way back to the desk. Pure and unit-tested; the daemon's
// away poller owns an instance and the digest renders it.
//
// Coalescing, not appending, is the whole design. Six sessions finishing produces
// six notifications under the old behaviour; here it produces six entries, and a
// session that finishes, restarts and finishes again produces ONE entry with a
// count of 2. That is the difference between a log and a digest.

import type { Alert, AlertKind } from "./alerts.ts";

/**
 * One thing that happened, possibly more than once.
 *
 * Keyed on the alert's own `id`, which the engine already guarantees is stable per
 * (kind, subject) - the same property that lets a repeat notification replace its
 * predecessor via the Notification tag. Reusing it means the buffer cannot drift
 * from the alert engine's idea of what counts as "the same event".
 */
export interface AwayEvent {
  key: string;
  kind: AlertKind;
  sessionId: string | null;
  title: string;
  body: string;
  /** When this first happened while away, and when it last did. */
  firstAt: number;
  lastAt: number;
  /** How many times it happened. 1 unless it recurred. */
  count: number;
}

export interface AwayBuffer {
  /** When away mode was entered - the window this buffer covers. */
  since: number;
  events: AwayEvent[];
  /**
   * Events dropped because the buffer hit its cap. Surfaced rather than silently
   * truncated: a digest that quietly omits things reads as "that's all that
   * happened", which is worse than saying it lost count.
   */
  dropped: number;
}

/**
 * Cap on distinct events held. Coalescing already bounds this by
 * (kinds x subjects), so hitting the cap means a genuinely enormous session count -
 * but a cap that only triggers in the pathological case is still cheaper than an
 * unbounded buffer surviving an overnight away.
 */
export const AWAY_BUFFER_CAP = 200;

export function emptyBuffer(since: number): AwayBuffer {
  return { since, events: [], dropped: 0 };
}

/**
 * Fold new alerts into the buffer, coalescing repeats.
 *
 * Takes ALL alerts, not just the bufferable ones. An attention alert that broke
 * through and interrupted you still belongs in the digest - you may have missed the
 * notification, and "3 things needed you while you were out" is exactly what the
 * summary is for. Filtering to what gets *delivered* is the notifier's job, and
 * conflating the two would make the digest an unreliable record of the window.
 */
export function foldAlerts(buf: AwayBuffer, alerts: Alert[], now: number): AwayBuffer {
  if (alerts.length === 0) return buf;
  const byKey = new Map(buf.events.map((e) => [e.key, e]));
  let dropped = buf.dropped;

  for (const a of alerts) {
    const existing = byKey.get(a.id);
    if (existing) {
      // Replace the wording as well as bumping the count: the newest occurrence is
      // the truest ("silent for 40m" supersedes "silent for 10m").
      byKey.set(a.id, {
        ...existing,
        title: a.title,
        body: a.body,
        lastAt: now,
        count: existing.count + 1,
      });
      continue;
    }
    if (byKey.size >= AWAY_BUFFER_CAP) {
      dropped++;
      continue;
    }
    byKey.set(a.id, {
      key: a.id,
      kind: a.kind,
      sessionId: a.sessionId,
      title: a.title,
      body: a.body,
      firstAt: now,
      lastAt: now,
      count: 1,
    });
  }

  return { since: buf.since, events: [...byKey.values()], dropped };
}

/** Counts by kind, for the rollup line. */
export function tally(buf: AwayBuffer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of buf.events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/** How the digest names each kind, in the order a human wants to hear them. */
const KIND_ORDER: { kind: AlertKind; one: string; many: string }[] = [
  { kind: "stuck", one: "stuck", many: "stuck" },
  { kind: "needs-input", one: "needs you", many: "need you" },
  { kind: "review", one: "to review", many: "to review" },
  { kind: "gate", one: "gate parked", many: "gates parked" },
  { kind: "foreman", one: "Foreman ask", many: "Foreman asks" },
  { kind: "task-failed", one: "failed", many: "failed" },
  { kind: "task-done", one: "task done", many: "tasks done" },
  { kind: "idle", one: "finished", many: "finished" },
];

/**
 * The deterministic digest: "3 finished · 1 stuck · 2 need you".
 *
 * This is the fallback the model-written narrative degrades to, so it must never
 * fail, never be empty when the buffer isn't, and never need a network call.
 */
export function rollupLine(buf: AwayBuffer): string {
  const counts = tally(buf);
  const parts: string[] = [];
  for (const { kind, one, many } of KIND_ORDER) {
    const n = counts[kind];
    if (!n) continue;
    parts.push(`${n} ${n === 1 ? one : many}`);
  }
  if (buf.dropped > 0) parts.push(`+${buf.dropped} more`);
  return parts.join(" · ");
}

/** Whether there is anything worth telling you about - a quiet return says nothing. */
export function hasAnything(buf: AwayBuffer): boolean {
  return buf.events.length > 0;
}

/**
 * The per-event lines beneath the rollup, most recent first, capped.
 *
 * Attention-level things first regardless of recency: a digest that leads with six
 * finished sessions and buries the one that needs you has failed at its job.
 */
export function digestLines(buf: AwayBuffer, limit = 12): string[] {
  const rank = (e: AwayEvent): number => KIND_ORDER.findIndex((k) => k.kind === e.kind);
  return [...buf.events]
    .sort((a, b) => rank(a) - rank(b) || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map((e) => {
      const times = e.count > 1 ? ` (x${e.count})` : "";
      return `${e.title}${e.body ? ` - ${e.body}` : ""}${times}`;
    });
}
