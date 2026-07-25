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
  /**
   * Away time this buffer accounts for: 0 while the window is still open, its own
   * duration once closed, and the SUM of both once two windows are merged.
   *
   * Tracked apart from `since` because a merged buffer covers two breaks with time
   * AT THE DESK between them. `until - since` would bill that desk time as away and
   * tell you that you were gone for 70 minutes when you were gone for 20 - the same
   * overstatement `dropped` exists to avoid, pointed the other way.
   */
  awayMs: number;
  events: AwayEvent[];
  /**
   * Events dropped because the buffer hit its cap. Surfaced rather than silently
   * truncated: a digest that quietly omits things reads as "that's all that
   * happened", which is worse than saying it lost count.
   */
  dropped: number;
}

/**
 * What you read when you come back: the rendered form of a closed away window.
 *
 * Lives here rather than beside the builder because it crosses the wire - the
 * dashboard's return panel renders exactly this.
 */
export interface AwayDigest {
  /** The window this covers - its start, and when it was read. */
  since: number;
  until: number;
  /**
   * How long you were ACTUALLY away, which is `until - since` for a single window
   * and less than it for a merged one (see AwayBuffer.awayMs). This is what the card
   * and the model are told, so neither can claim a break you didn't take.
   */
  awayMs: number;
  /** Deterministic one-liner, e.g. "1 stuck · 3 finished". Always present. */
  rollup: string;
  /** Per-event lines, most urgent first. Always present. */
  lines: string[];
  /** Model-written summary, or null when the model was unavailable or declined. */
  narrative: string | null;
  /** True when nothing happened - callers should say nothing at all. */
  empty: boolean;
}

/**
 * Cap on distinct events held. Coalescing already bounds this by
 * (kinds x subjects), so hitting the cap means a genuinely enormous session count -
 * but a cap that only triggers in the pathological case is still cheaper than an
 * unbounded buffer surviving an overnight away.
 */
export const AWAY_BUFFER_CAP = 200;

export function emptyBuffer(since: number): AwayBuffer {
  return { since, awayMs: 0, events: [], dropped: 0 };
}

/**
 * Bank an open window's duration as away time, at the moment it closes.
 *
 * Done on close rather than measured at read time because the digest is read after
 * you are back at the desk - sometimes long after, if no dashboard was open - and
 * the walk back to your chair is not time you were away.
 */
export function closeBuffer(buf: AwayBuffer, at: number): AwayBuffer {
  return { ...buf, awayMs: buf.awayMs + Math.max(0, at - buf.since) };
}

/**
 * How an entry absorbs a fresh sighting of the same event.
 *
 * The newest wording always wins - "silent for 40m" supersedes "silent for 10m" -
 * but `at` decides whether this sighting was a new OCCURRENCE (a timestamp) or the
 * same one described again (null). Only an occurrence moves `lastAt` and the repeat
 * count; a re-reading must not claim a session went stuck forty times when it was
 * one continuous stall.
 */
function absorb(existing: AwayEvent, a: Alert, at: number | null): AwayEvent {
  return {
    ...existing,
    title: a.title,
    body: a.body,
    lastAt: at ?? existing.lastAt,
    count: at === null ? existing.count : existing.count + 1,
  };
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
      byKey.set(a.id, absorb(existing, a, now));
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

  return { ...buf, events: [...byKey.values()], dropped };
}

/**
 * Re-read the wording of events ALREADY buffered, without recording an occurrence.
 *
 * Exists for stalls, which are edge-triggered per (session, kind) so that a wedged
 * session notifies once rather than every poll. That is right for delivery and wrong
 * for the digest: the single alert freezes the wording at the moment the threshold
 * tripped, so a session that went quiet at 09:12 and is still quiet when you sit
 * back down at 10:00 would be reported as "silent for 10m". Re-reading the live
 * stall each tick makes the line true at the moment you read it.
 *
 * Never inserts, so a stall that has since CLEARED - and is therefore absent from
 * the live set - is neither resurrected nor pinned; it keeps the last wording it had
 * while real, which is what actually happened while you were gone.
 */
export function refreshAlerts(buf: AwayBuffer, alerts: Alert[]): AwayBuffer {
  if (alerts.length === 0) return buf;
  const byId = new Map(alerts.map((a) => [a.id, a]));
  return {
    ...buf,
    events: buf.events.map((e) => {
      const a = byId.get(e.key);
      return a ? absorb(e, a, null) : e;
    }),
  };
}

/**
 * Fold one closed window into another, coalescing across both.
 *
 * Needed because a window can close while the last one's digest is still unread (no
 * dashboard was open to claim it). Merging keeps the read-once contract honest -
 * dropping either buffer would silently lose a window nothing can recover.
 */
export function mergeBuffers(older: AwayBuffer, newer: AwayBuffer): AwayBuffer {
  const byKey = new Map(older.events.map((e) => [e.key, e]));
  let dropped = older.dropped + newer.dropped;

  for (const e of newer.events) {
    const prior = byKey.get(e.key);
    if (prior) {
      // The newer wording wins for the same reason it does in foldAlerts, but the
      // span stretches across both windows.
      byKey.set(e.key, {
        ...e,
        firstAt: Math.min(prior.firstAt, e.firstAt),
        lastAt: Math.max(prior.lastAt, e.lastAt),
        count: prior.count + e.count,
      });
      continue;
    }
    if (byKey.size >= AWAY_BUFFER_CAP) {
      dropped++;
      continue;
    }
    byKey.set(e.key, e);
  }

  return {
    since: Math.min(older.since, newer.since),
    // Summed, never spanned: the gap between the two breaks was time at the desk.
    awayMs: older.awayMs + newer.awayMs,
    events: [...byKey.values()],
    dropped,
  };
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
  { kind: "workflow", one: "workflow update", many: "workflow updates" },
  { kind: "ensemble", one: "ensemble update", many: "ensemble updates" },
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
 *
 * What doesn't fit is COUNTED rather than dropped, for the same reason `dropped` is
 * surfaced (see AwayBuffer): twelve lines with nothing said about the other
 * eighteen reads as "that's all that happened". The count takes the last slot
 * rather than an extra one, so `limit` stays a hard cap on lines rendered.
 */
export function digestLines(buf: AwayBuffer, limit = 12): string[] {
  const lines = eventLines(buf, buf.events.length > limit ? limit - 1 : limit);
  const overflow = buf.events.length - lines.length;
  if (overflow > 0) lines.push(`+${overflow} more`);
  return lines;
}

/**
 * The same lines WITHOUT the overflow marker - one string per real event.
 *
 * Separate from digestLines because the digest prompt fences these as data and tells
 * the model that every line is something that happened. A synthetic "+6 more" inside
 * that fence is an invitation to narrate the truncation as an event, so callers that
 * are describing events rather than rendering a list take this and say what is
 * missing in their own words.
 */
export function eventLines(buf: AwayBuffer, limit: number): string[] {
  const rank = (e: AwayEvent): number => KIND_ORDER.findIndex((k) => k.kind === e.kind);
  return [...buf.events]
    .sort((a, b) => rank(a) - rank(b) || b.lastAt - a.lastAt)
    .slice(0, Math.max(0, limit))
    .map((e) => {
      const times = e.count > 1 ? ` (x${e.count})` : "";
      return `${e.title}${e.body ? ` - ${e.body}` : ""}${times}`;
    });
}
