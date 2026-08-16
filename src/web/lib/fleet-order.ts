import type { Session } from "@shared/types.ts";
import { pipelineRunKey } from "@shared/pipeline.ts";
import { stateDisplay } from "./format.ts";
import { NO_HELD_SESSIONS } from "./held.ts";
import { groupByTone, TONE_ORDER, type ToneGroup } from "./tone.ts";

/**
 * What kind of run a cluster's members share.
 *
 * Two things group sessions on this fleet, and they are genuinely different obligations: an
 * ENSEMBLE is Mission Control's own comparison of several candidates, and a PIPELINE is an
 * external engine walking one feature through a gated sequence. A view has to draw a
 * different header for each - the ensemble's is about a comparison in flight, the pipeline's
 * about a feature's position - so the discriminant travels with the span rather than being
 * re-derived from a member, which is how the frame and its header could come to disagree.
 */
export type FleetClusterKind = "ensemble" | "pipeline";

/**
 * Where one run's sessions sit inside ONE tone group.
 *
 * A span, not a list of ids, because the whole point is that the members are CONTIGUOUS in
 * the group's rendered order: a view slices `sessions` at `[startIndex, startIndex + length)`
 * and draws a frame around exactly what the arrow keys will walk.
 */
export interface FleetClusterSpan {
  kind: FleetClusterKind;
  /**
   * The run this frame belongs to: an ensemble run id, or a `pipelineRunKey`. Opaque here -
   * it is a bucket key and a React key, and only the view that draws the header resolves it.
   */
  runId: string;
  /** Index into the tone group's `sessions`, not into the flat fleet. */
  startIndex: number;
  length: number;
}

/** A tone group plus where its run clusters are. */
export interface FleetToneGroup extends ToneGroup {
  clusters: FleetClusterSpan[];
  /**
   * Index into `sessions` where the sessions held by an open workflow run begin, or null when
   * this group has none.
   *
   * A BOUNDARY rather than a set, for the same reason `clusters` is a span: the held members are
   * contiguous and last, so a view slices at one index and draws its section rule there, and the
   * arrow keys walk the identical sequence. `heldFrom === 0` is a real value - it means every
   * session in the group is held - and is why this is `number | null` rather than a falsy count.
   *
   * Only the `idle` group ever sets it. See `orderSessions`.
   */
  heldFrom: number | null;
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
  | {
      kind: "cluster";
      /** Which header the view draws over this frame. See `FleetClusterKind`. */
      cluster: FleetClusterKind;
      runId: string;
      /**
       * The React key for this frame, computed HERE because `runId` alone is not one: a run
       * with one free member and one held member clusters once per side of the boundary (see
       * `clusterGroup`), and two frames keyed by the same run collide - React matches one
       * fiber and remounts or misassigns the other's header and disclosure state. The first
       * member's id disambiguates, and is as stable as the span itself.
       */
      key: string;
      sessions: Session[];
    };

/**
 * The ONE fleet ordering: tone first, then the sessions of one run adjacent.
 *
 * "One run" is an ensemble run or an external engine's pipeline - see `clusterOf`. A fleet
 * with neither comes out byte-identical to the old order, which is the same guarantee this
 * gave before pipelines existed and is what keeps an unobserved fleet unchanged.
 *
 * Two facts have to stay one fact here. The grid, the console rail and the board all render
 * this order, and the arrow keys walk index arrays derived from the SAME call - `moveSelection`
 * indexes a flat list (grid, console) and a per-column list (board), so an ordering computed
 * twice by two rules is Up/Down landing somewhere other than where the eye is. That is why this
 * is a pure function over `sessions` and not a rendering decision inside a view.
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
 * HELD SESSIONS SORT LAST WITHIN `idle`, AND ONLY WITHIN `idle`. A session an open workflow run
 * owns (`heldSessionIds`) is idle in the only sense the runtime can see, and free in no sense at
 * all: the run sends its next round on its own, and until it does there is nothing an operator
 * can hand that agent. Sorting them below the genuinely free ones makes the agents you can
 * actually dispatch to contiguous and first, which is the order the column is read in.
 *
 * It is confined to `idle` because in every other tone, being held is not the most important
 * thing true about the session. A held session that has stopped to ask a question is in
 * "needs you" and demoting it there would bury the one row on the board that wants a human.
 *
 * Idempotent, and deliberately so: `App` orders the visible fleet once, and `BoardView` /
 * `ConsoleView` call this again on the list they were handed rather than being passed a
 * pre-split structure. Re-running it on its own output returns the same order, so the two
 * cannot disagree even though each computes it. That extends to `held`: it is an argument
 * rather than something read off the session precisely so both sides pass the same set.
 *
 * `held` defaults to empty, which reproduces the pre-workflow ordering exactly - so a caller
 * that has no run map (and every test that predates one) is unaffected.
 */
export function orderSessions(
  sessions: readonly Session[],
  held: ReadonlySet<string> = NO_HELD_SESSIONS,
): FleetOrder {
  const baseline = [...sessions].sort((a, b) => {
    const ta = TONE_ORDER[stateDisplay(a).tone];
    const tb = TONE_ORDER[stateDisplay(b).tone];
    return ta - tb || a.name.localeCompare(b.name) || a.pid - b.pid;
  });

  const groups = groupByTone(baseline).map((group) => clusterGroup(group, held));
  return { sessions: groups.flatMap((g) => g.sessions), groups };
}

/**
 * The run this session's card sits under, or null when it sits loose.
 *
 * An ensemble membership OUTRANKS a pipeline correlation, and the case is real rather than
 * theoretical: a member dispatched into a repository an engine also drives would satisfy
 * both, and the ensemble is the stronger claim - it is an explicit binding Mission Control
 * made, while the correlation is a path coincidence the engine's worktree layout produced.
 * A session can only be in one frame, so the order here IS the precedence.
 */
function clusterOf(session: Session): { kind: FleetClusterKind; runId: string } | null {
  const ensemble = session.task?.ensemble?.runId ?? null;
  if (ensemble !== null) return { kind: "ensemble", runId: ensemble };
  const pipeline = session.pipeline;
  return pipeline
    ? {
        kind: "pipeline",
        runId: pipelineRunKey(pipeline.provider, pipeline.repoRoot, pipeline.slug),
      }
    : null;
}

/**
 * Pull one tone group's run siblings together, anchored where the first of them sat.
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
function clusterGroup(group: ToneGroup, held: ReadonlySet<string>): FleetToneGroup {
  // The free/held split happens BEFORE clustering, and each side is then clustered on its own.
  // Clustering the group as a whole and splitting after would not work: the buckets are keyed by
  // run id across everything handed to them, so a run with one free member and one held member
  // would collect both into a single span anchored at the free member - a cluster straddling the
  // boundary, which is exactly the shape `fleetBlocks` and the section rule cannot express.
  //
  // The consequence is the same one the tone-boundary rule already has: such a run is drawn as
  // two frames, one per side, and its header's own rollup is what ties the halves together.
  const partitions = group.tone === "idle" && group.sessions.some((s) => held.has(s.id))
    ? [
        group.sessions.filter((s) => !held.has(s.id)),
        group.sessions.filter((s) => held.has(s.id)),
      ]
    : [group.sessions];

  const sessions: Session[] = [];
  const clusters: FleetClusterSpan[] = [];
  let heldFrom: number | null = null;
  for (const [index, partition] of partitions.entries()) {
    if (index === 1) heldFrom = sessions.length;
    const run = clusterPartition(partition);
    for (const cluster of run.clusters) {
      clusters.push({ ...cluster, startIndex: cluster.startIndex + sessions.length });
    }
    sessions.push(...run.sessions);
  }
  return { ...group, sessions, clusters, heldFrom };
}

/** One contiguous run of sessions, with the siblings of one run pulled together. */
function clusterPartition(
  input: readonly Session[],
): { sessions: Session[]; clusters: FleetClusterSpan[] } {
  // Keyed by kind AND id, so an ensemble run id could never collide with a pipeline run key.
  // They cannot today - one is a uuid, the other a unit-separated triple - but a bucket map
  // that relies on two vocabularies staying disjoint is one nobody would think to check.
  const buckets = new Map<string, Session[]>();
  const slots: (Session | Session[])[] = [];
  for (const session of input) {
    const cluster = clusterOf(session);
    if (cluster === null) {
      slots.push(session);
      continue;
    }
    const key = `${cluster.kind}:${cluster.runId}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.push(session);
      continue;
    }
    const bucket = [session];
    buckets.set(key, bucket);
    slots.push(bucket);
  }

  const sessions: Session[] = [];
  const clusters: FleetClusterSpan[] = [];
  for (const slot of slots) {
    if (!Array.isArray(slot)) {
      sessions.push(slot);
      continue;
    }
    // Ordinal first, which is the ensemble's own vocabulary and the only order its header's
    // counts read against. A pipeline's members have none - the engine runs one step at a
    // time, so a frame with two of them is two agents in one worktree - and fall through to
    // the baseline tiebreak, which is what the group was already sorted by.
    slot.sort(
      (a, b) =>
        (a.task?.ensemble?.ordinal ?? 0) - (b.task?.ensemble?.ordinal ?? 0) ||
        a.name.localeCompare(b.name) ||
        a.pid - b.pid,
    );
    const cluster = clusterOf(slot[0]!)!;
    clusters.push({ ...cluster, startIndex: sessions.length, length: slot.length });
    sessions.push(...slot);
  }
  return { sessions, clusters };
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
      const members = group.sessions.slice(i, i + span.length);
      blocks.push({
        kind: "cluster",
        cluster: span.kind,
        runId: span.runId,
        key: `cluster-${span.kind}-${span.runId}-${members[0]!.id}`,
        sessions: members,
      });
      i += span.length;
      continue;
    }
    blocks.push({ kind: "session", session: group.sessions[i]! });
    i += 1;
  }
  return blocks;
}

/** A rendered row of a tone group: a section rule, a loose session, or a framed cluster. */
export type FleetRow =
  | { kind: "section"; section: "free" | "held"; count: number }
  | FleetBlock;

/**
 * `fleetBlocks` with the free/held section rules laid in at the boundary.
 *
 * The single expansion of `(sessions, clusters, heldFrom)` into rows, so the board column and
 * the console rail cannot draw the rule in different places - they sit either side of the
 * board's drill-in morph, where a disagreement would read as the fleet regrouping when only the
 * layout moved.
 *
 * Counts SESSIONS while walking blocks, because `heldFrom` indexes `sessions` and a cluster
 * occupies several of them. The walk can only ever land exactly ON the boundary rather than
 * stepping past it, and that is a property of `orderSessions` partitioning BEFORE it clusters:
 * a cluster straddling the boundary would swallow the rule entirely. Pinned by test.
 *
 * A group with no held sessions returns its blocks unchanged and gains no rules - a "free"
 * heading over a column where nothing is held would be labelling the absence of a distinction.
 */
export function fleetRows(group: FleetToneGroup): FleetRow[] {
  const blocks = fleetBlocks(group);
  const heldFrom = group.heldFrom;
  if (heldFrom === null) return blocks;

  const rows: FleetRow[] = [];
  let index = 0;
  for (const block of blocks) {
    if (index === 0 && heldFrom > 0) {
      rows.push({ kind: "section", section: "free", count: heldFrom });
    }
    if (index === heldFrom) {
      rows.push({ kind: "section", section: "held", count: group.sessions.length - heldFrom });
    }
    rows.push(block);
    index += block.kind === "session" ? 1 : block.sessions.length;
  }
  return rows;
}
