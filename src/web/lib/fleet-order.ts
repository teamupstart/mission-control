import type { Session } from "@shared/types.ts";
import { stateDisplay } from "./format.ts";
import { groupByTone, TONE_ORDER, type ToneGroup } from "./tone.ts";

/**
 * Where one ensemble's sibling members sit inside ONE tone group.
 *
 * A span, not a list of ids, because the whole point is that the members are CONTIGUOUS in
 * the group's rendered order: a view slices `sessions` at `[startIndex, startIndex + length)`
 * and draws a frame around exactly what the arrow keys will walk.
 */
export interface EnsembleClusterSpan {
  runId: string;
  /** Index into the tone group's `sessions`, not into the flat fleet. */
  startIndex: number;
  length: number;
}

/** A tone group plus where its ensemble clusters are. */
export interface FleetToneGroup extends ToneGroup {
  clusters: EnsembleClusterSpan[];
}

export interface FleetOrder {
  /** The flat display order, every tone group concatenated in `TONE_GROUPS` order. */
  sessions: Session[];
  /** Every tone group, empty ones included - `groupByTone`'s contract, unchanged. */
  groups: FleetToneGroup[];
}

/**
 * One tone group's rendered order, as alternating loose sessions and framed clusters.
 *
 * Derived rather than stored so a view cannot draw a frame around a different set of rows than
 * the span says: this is the single expansion of `(sessions, clusters)` into what the board and
 * the two rails render.
 */
export type FleetBlock =
  | { kind: "session"; session: Session }
  | { kind: "cluster"; runId: string; sessions: Session[] };

/**
 * The ONE fleet ordering: tone first, then siblings of an ensemble run adjacent.
 *
 * Two facts have to stay one fact here. The grid, the console rail and the board all render
 * this order, and the arrow keys walk index arrays derived from the SAME call - `moveSelection`
 * indexes a flat list (grid, console) and a per-column list (board), so an ordering computed
 * twice by two rules is Up/Down landing somewhere other than where the eye is. That is why this
 * is a pure function over `(sessions, gateAlerts)` and not a rendering decision inside a view.
 *
 * The baseline is exactly what App sorted by before clusters existed - tone, then name, then pid
 * - so a fleet with no ensemble in it comes out byte-identical to the old order. Clustering then
 * moves siblings up to their earliest-placed member, which is the only reordering this does.
 *
 * A CLUSTER NEVER CROSSES A TONE BOUNDARY. A blocked member sits in the attention region with
 * its cluster header repeated there, rather than dragging its working siblings into "needs you":
 * the board treats a column's meaning as load-bearing (`groupByTone`), and a column that fills
 * with agents nobody has to do anything about is a column that stops being read. The header's
 * own rollup line is what ties the halves back together.
 *
 * Idempotent, and deliberately so: `App` orders the visible fleet once, and `BoardView` /
 * `ConsoleView` call this again on the list they were handed rather than being passed a
 * pre-split structure. Re-running it on its own output returns the same order, so the two
 * cannot disagree even though each computes it.
 */
export function orderSessions(
  sessions: readonly Session[],
  gateAlerts: ReadonlySet<string>,
): FleetOrder {
  const baseline = [...sessions].sort((a, b) => {
    const ta = TONE_ORDER[stateDisplay(a, gateAlerts.has(a.id)).tone];
    const tb = TONE_ORDER[stateDisplay(b, gateAlerts.has(b.id)).tone];
    return ta - tb || a.name.localeCompare(b.name) || a.pid - b.pid;
  });

  const groups = groupByTone(baseline, gateAlerts).map(clusterGroup);
  return { sessions: groups.flatMap((g) => g.sessions), groups };
}

/** The run this session is a member of, or null. */
function runIdOf(session: Session): string | null {
  return session.task?.ensemble?.runId ?? null;
}

/**
 * Pull one tone group's ensemble siblings together, anchored where the first of them sat.
 *
 * Anchoring at the FIRST member's baseline position (rather than, say, appending clusters at
 * the end) is what keeps the move small: within a tone group the baseline is already the
 * operator's alphabetical reading order, so a cluster lands where its highest-priority member
 * was and everything else keeps its relative place.
 *
 * Members are ordered by their compiled ordinal inside the frame - "candidate 1, 2, 3" is the
 * run's own vocabulary and the only order the header's counts can be read against - falling
 * back to the baseline tiebreak when two members claim the same ordinal.
 */
function clusterGroup(group: ToneGroup): FleetToneGroup {
  const buckets = new Map<string, Session[]>();
  const slots: (Session | Session[])[] = [];
  for (const session of group.sessions) {
    const runId = runIdOf(session);
    if (runId === null) {
      slots.push(session);
      continue;
    }
    const existing = buckets.get(runId);
    if (existing) {
      existing.push(session);
      continue;
    }
    const bucket = [session];
    buckets.set(runId, bucket);
    slots.push(bucket);
  }

  const sessions: Session[] = [];
  const clusters: EnsembleClusterSpan[] = [];
  for (const slot of slots) {
    if (!Array.isArray(slot)) {
      sessions.push(slot);
      continue;
    }
    slot.sort(
      (a, b) =>
        (a.task?.ensemble?.ordinal ?? 0) - (b.task?.ensemble?.ordinal ?? 0) ||
        a.name.localeCompare(b.name) ||
        a.pid - b.pid,
    );
    clusters.push({ runId: runIdOf(slot[0]!)!, startIndex: sessions.length, length: slot.length });
    sessions.push(...slot);
  }
  return { ...group, sessions, clusters };
}

/**
 * What to call a cluster before its run's SSE summary has arrived.
 *
 * Taken from the member link, which is the only thing guaranteed to be there the instant a
 * cluster exists: the link rides on the session's own task summary, while the run summary is a
 * separate collection that can land a tick later. A header that waited for it would flicker a
 * frame in and out around tiles that never moved.
 */
export function clusterFallbackLabel(session: Session): string {
  return session.task?.ensemble?.strategyLabel ?? "Ensemble";
}

/**
 * A tone group expanded into what a view draws, loose rows and framed clusters in order.
 *
 * A single-member cluster still gets a frame: the member may be the only one of its run in
 * THIS column (the tone-boundary rule above), and the header is precisely what says so.
 */
export function fleetBlocks(group: FleetToneGroup): FleetBlock[] {
  const spanAt = new Map(group.clusters.map((c) => [c.startIndex, c]));
  const blocks: FleetBlock[] = [];
  for (let i = 0; i < group.sessions.length; ) {
    const span = spanAt.get(i);
    if (span) {
      blocks.push({
        kind: "cluster",
        runId: span.runId,
        sessions: group.sessions.slice(i, i + span.length),
      });
      i += span.length;
      continue;
    }
    blocks.push({ kind: "session", session: group.sessions[i]! });
    i += 1;
  }
  return blocks;
}
