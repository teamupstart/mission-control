import type { DatabaseSync } from "node:sqlite";
import { byBacklogRank } from "../shared/task.ts";

/**
 * Allocation for `tasks.backlog_rank` - the operator's backlog order.
 *
 * Sparse integers rather than dense positions, so the common move writes ONE row and
 * publishes ONE `task_upsert`. The alternative - renumber everything on every move - is
 * trivially correct and was rejected on write amplification: one drag on a 300-item
 * backlog would be 300 rows and 300 events to every connected dashboard. Both are correct;
 * this is the one that stays correct at size. The full rewrite is still here, as
 * `normalizeBacklogRanks`, and it is what a collision falls back to.
 *
 * Three primitives because the route offers three positions: the BOTTOM (`appendRank`),
 * the TOP (`prependRank`) and BETWEEN two neighbours (`rankBetween`). They are symmetric
 * on purpose - the rank space runs in both directions and needs a bound at each end. An
 * allocator that only grows upward cannot serve `{ position: "top" }`.
 *
 * Every helper here takes the `DatabaseSync` rather than opening one, so a caller can run
 * a placement and its repair inside one transaction. The Foreman worker never reaches this
 * file: it never opens SQLite, and gets the new order over the wire for free.
 */

/** The gap between two neighbouring ranks. Big enough that midpoints rarely run out. */
export const RANK_STEP = 1024;

/**
 * The hard limits, and they are `Number.MAX_SAFE_INTEGER` (2^53-1) and its negative - NOT
 * SQLite's signed 64-bit range.
 *
 * `Task.backlogRank` crosses the wire as a JSON number, so integer precision is lost at
 * 2^53 while SQLite is still storing exact integers - about a thousandfold earlier. A guard
 * placed at the int64 boundary would be guarding a limit that cannot be reached without
 * having already silently corrupted the ranks it was meant to protect.
 *
 * There is deliberately no reserved band inside them. A band would mean a rank outside it
 * needed repairing, and a repair that cannot fit becomes a reason to renumber - which is
 * the one thing the sparse scheme must not do outside a collision. Instead the STEP shrinks
 * as the space does: `stepToward` takes what room is left rather than insisting on
 * `RANK_STEP`, so a rank planted at the very top by something outside this allocator costs
 * the next append a smaller gap and costs the operator's other ranks nothing at all.
 *
 * Running out is not a live concern in either direction. At `RANK_STEP = 1024` it takes
 * ~8.8e12 appends to walk from zero to the limit - about 24 million years at a thousand
 * moves a day - and each end relaxes whenever the task sitting there leaves the backlog.
 * What is reachable is a rank arriving from OUTSIDE the allocator: a restored backup, a
 * hand-edited row, or a future writer that sets the column. That is what shrinking absorbs.
 */
const CEILING = Number.MAX_SAFE_INTEGER;
const FLOOR = Number.MIN_SAFE_INTEGER;

/**
 * The gap to leave when placing `divisions` new ranks between `from` and a hard limit, or
 * null when there is no integer to give them.
 *
 * `RANK_STEP` whenever the room allows it, which is the overwhelmingly normal case and the
 * whole point of sparse integers. Beyond that it halves what is left rather than giving up:
 * one more append is always worth more than a renumber of somebody else's column, and the
 * `+ 1` divisor is what keeps a little room for the append after this one instead of
 * spending the last integer on this one.
 */
function stepToward(from: number, limit: number, divisions: number): number | null {
  const room = Math.abs(limit - from);
  // The ordinary answer, and the early return that keeps it honest: `room` is computed by a
  // subtraction that can span zero, so for a rank near one limit and a target at the other
  // it lands outside the safe range and is no longer exact. It is only ever inexact when it
  // is astronomically larger than the gap being asked for, so comparing it against the room
  // actually needed is sound where dividing it would not be.
  const wanted = RANK_STEP * (divisions + 1);
  if (room >= wanted) return RANK_STEP;
  // Squeezed. `room` is now small enough to be exact, so it can be shared out. The `+ 1`
  // divisor leaves a little for the allocation after this one rather than spending the last
  // integer here; if that rounds to nothing, take the whole remaining room instead.
  if (room < divisions) return null;
  const shared = Math.floor(room / (divisions + 1));
  const step = shared > 0 ? shared : Math.floor(room / divisions);
  return step > 0 ? step : null;
}

/** One backlog row, in the shape `byBacklogRank` orders. */
interface RankRow {
  id: string;
  createdAt: number;
  backlogRank: number | null;
}

/**
 * Every `status='backlog'` row's rank, validated the same way the wire validates it.
 *
 * VALIDATED, NOT CAST, and this is where it matters most. `rowToTask` mapping an unsafe
 * value to null protects what the daemon SERVES; it does nothing for this file, which is
 * the write path and asks the column directly. The column is a bare `INTEGER` affinity, so
 * a REAL, a fraction or a text blob written by anything else all read back as something
 * `typeof === "number"` would wave through and then poison the arithmetic below. Anything
 * that is not a safe integer reads as unranked, which sorts last - exactly where an
 * unplaced row belongs, and the same answer the read path gives.
 */
function backlogRankRows(d: DatabaseSync): RankRow[] {
  const rows = d
    .prepare(`SELECT id, backlog_rank, created_at FROM tasks WHERE status = 'backlog'`)
    .all() as unknown as Array<{ id: string; backlog_rank: unknown; created_at: number }>;
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    backlogRank: Number.isSafeInteger(r.backlog_rank) ? (r.backlog_rank as number) : null,
  }));
}

/**
 * Rewrite EVERY backlog row's rank to `(i + 1) * RANK_STEP` in `byBacklogRank` order.
 * Returns the new rank of every row it touched, so the caller can publish a `task_upsert`
 * for each - a reorder that changed rows nobody was told about would leave every open
 * dashboard drawing a stale column.
 *
 * THE COLLISION FALLBACK, and nothing else reaches for it. It has exactly two callers, and
 * both run it for the same reason, discovered at the moment of allocation rather than
 * guessed at by a pre-check over the column: there is no integer left where one is needed.
 * A targeted heal that could not fit a row inside the band, or a `before`/`after` whose gap
 * has nothing in it. `appendRank` and `prependRank` do not appear on that list - the heal
 * hands them a band they cannot fall off. It is the expensive half of the bargain sparse
 * integers make, and it stays rare by being reached for only when the cheap half has
 * actually failed.
 */
export function normalizeBacklogRanks(d: DatabaseSync): Map<string, number> {
  const ordered = backlogRankRows(d).sort(byBacklogRank);
  const assigned = new Map<string, number>();
  const update = d.prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`);
  ordered.forEach((row, i) => {
    const rank = (i + 1) * RANK_STEP;
    // Rows that already hold the rank they are about to be given are skipped, so the
    // caller has nothing extra to publish for them.
    if (row.backlogRank === rank) return;
    update.run(rank, row.id);
    assigned.set(row.id, rank);
  });
  return assigned;
}

/** What an allocation produced: the rank to write, and any rows a repair moved on the way. */
export interface RankPlacement {
  rank: number;
  /** Ranks a repair rewrote. Empty when the backlog needed nothing, which is the norm. */
  normalized: Map<string, number>;
}

/**
 * Give every UNRANKED backlog row a rank, at the bottom, touching nothing else - or null
 * when there is no integer left to give one.
 *
 * A missing rank is a REPAIR, NOT A COLLISION, and that difference is the whole reason this
 * exists rather than deferring to `normalizeBacklogRanks`. An unranked row does not mean
 * the sparse space ran out; it means one row never got a place in it - an older build
 * writing the column it does not know about, a restored backup, a hand-edited row, a future
 * writer that sets it. The ranks around it are still perfectly spaced and still the
 * operator's, so rewriting them would move cards nobody asked to move and publish an event
 * per card to say so. ONLY THE ROWS WITH NO PLACE ARE WRITTEN.
 *
 * The bottom, because that is where `byBacklogRank` already sorts an unranked row
 * (`Infinity`, so last) - the heal writes down what the column was already showing rather
 * than changing it. It is also why healing cannot be skipped before an append: leave the
 * row unranked and `appendRank` hands the next arrival a FINITE rank, finite sorts above
 * infinite, and the new task lands ABOVE it, second to last. One unranked row would
 * silently demote itself below everything filed after it, which is the opposite of the
 * rule. The migration-time backfill cannot close this on its own - it hangs off
 * `addColumn`'s did-it-add return and runs exactly once, so a row that loses its rank after
 * it stays lost forever.
 *
 * The step SHRINKS rather than the repair widening. A rank sitting just under the ceiling -
 * planted there by something outside this allocator - leaves less than `RANK_STEP` above
 * it, and the answer is a smaller gap for these rows, not a renumber of everyone else's.
 * Null only when there is genuinely no integer left, which is a collision and is the
 * caller's to report rather than to paper over.
 */
function healUnranked(d: DatabaseSync): Map<string, number> | null {
  const rows = backlogRankRows(d);
  const unranked = rows.filter((r) => r.backlogRank === null).sort(byBacklogRank);
  const assigned = new Map<string, number>();
  if (unranked.length === 0) return assigned;

  const ranked = rows.map((r) => r.backlogRank).filter((r): r is number => r !== null);
  const from = ranked.length > 0 ? Math.max(...ranked) : 0;
  const step = stepToward(from, CEILING, unranked.length);
  if (step === null) return null;

  const update = d.prepare(`UPDATE tasks SET backlog_rank = ? WHERE id = ?`);
  unranked.forEach((row, i) => {
    const rank = from + step * (i + 1);
    update.run(rank, row.id);
    assigned.set(row.id, rank);
  });
  return assigned;
}

/**
 * Place every unranked backlog row, writing as little as possible - or null when even that
 * cannot be done.
 *
 * A HEAL and never a renumber, and it does not fall back to one. `normalizeBacklogRanks` is
 * not reachable from here at all: a repair that could not fit is reported to the caller as
 * a failure to place, and the caller decides what to say about it. Rewriting the operator's
 * column to make room for one row is not that decision to make.
 *
 * In the ordinary case - every row already ranked - it is a `SELECT` and nothing else.
 */
export function repairBacklogRanks(d: DatabaseSync): Map<string, number> | null {
  return healUnranked(d);
}

/**
 * The BOTTOM of the backlog: one step past the current maximum - or NULL when there is no
 * integer left above it.
 *
 * The one call that makes "work that files itself arrives at the bottom" true - a task
 * source sweep, a recurring mission, a retro follow-up, an MCP `create_task`. They all
 * funnel through `TaskManager.create`, so this is one edit and not one per source.
 *
 * NO RENUMBER LIVES HERE AND NONE IS REACHABLE FROM HERE. Two things replace it. The step
 * shrinks when the room does, so a rank planted near the ceiling by something outside this
 * allocator costs the next arrival a narrower gap and costs every other rank nothing. And
 * when the room is genuinely gone, this says so - `null`, an explicit failure to place -
 * rather than rewriting a column the operator arranged in order to make space for one row.
 *
 * `TaskManager` answers that null by filing the task with no rank at all, which sorts it
 * last, which IS the bottom. Nothing is lost and nothing is wrong: `byBacklogRank` breaks
 * the tie by age, so several such arrivals stay in arrival order, and the next heal that
 * finds room places them properly.
 */
export function appendRank(d: DatabaseSync): RankPlacement | null {
  const normalized = repairBacklogRanks(d);
  if (normalized === null) return null;
  const max = maxRank(d);
  // An empty column starts at `RANK_STEP` and not at zero, so the very first move can
  // prepend above it without going negative.
  if (max === null) return { rank: RANK_STEP, normalized };
  const step = stepToward(max, CEILING, 1);
  return step === null ? null : { rank: max + step, normalized };
}

/** The TOP of the backlog: one step below the current minimum. The mirror of `appendRank`. */
export function prependRank(d: DatabaseSync): RankPlacement | null {
  const normalized = repairBacklogRanks(d);
  if (normalized === null) return null;
  const min = minRank(d);
  if (min === null) return { rank: RANK_STEP, normalized };
  const step = stepToward(min, FLOOR, 1);
  return step === null ? null : { rank: min - step, normalized };
}

/**
 * The highest and lowest rank in the backlog, or null for an empty one - which is why both
 * ends of an empty column start at `RANK_STEP` rather than at zero: the first task filed
 * has to leave room to prepend above it without going negative on the very first move.
 */
function maxRank(d: DatabaseSync): number | null {
  const row = d
    .prepare(`SELECT MAX(backlog_rank) AS m FROM tasks WHERE status = 'backlog'`)
    .get() as unknown as { m: unknown } | undefined;
  return row && Number.isSafeInteger(row.m) ? (row.m as number) : null;
}

function minRank(d: DatabaseSync): number | null {
  const row = d
    .prepare(`SELECT MIN(backlog_rank) AS m FROM tasks WHERE status = 'backlog'`)
    .get() as unknown as { m: unknown } | undefined;
  return row && Number.isSafeInteger(row.m) ? (row.m as number) : null;
}

/**
 * A rank strictly between two neighbours, or null when there is none - which is the
 * caller's signal to normalize the whole backlog and retry once.
 *
 * `before + (after - before) / 2` rather than `(before + after) / 2`: the second overflows
 * the safe range for two ranks near opposite ends, and a sum that is not exactly
 * representable produces a "midpoint" that may not lie between them at all. The result is
 * re-checked against both bounds and against `Number.isSafeInteger` regardless, so a
 * subtraction that itself lost precision on an extreme span fails closed into a
 * normalize rather than into a bad write.
 */
export function rankBetween(before: number, after: number): number | null {
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)) return null;
  const mid = before + Math.floor((after - before) / 2);
  if (!Number.isSafeInteger(mid)) return null;
  return mid > before && mid < after ? mid : null;
}

/** Where a reorder puts the moved card. `before`/`after` are relative to an anchor. */
export type RankPosition = "top" | "bottom" | "before" | "after";

/** One validated backlog rank read out of SQL, or null when the row has none. */
function rankOf(d: DatabaseSync, id: string): number | null {
  const row = d
    .prepare(`SELECT backlog_rank AS r FROM tasks WHERE id = ? AND status = 'backlog'`)
    .get(id) as unknown as { r: unknown } | undefined;
  return row && Number.isSafeInteger(row.r) ? (row.r as number) : null;
}

/**
 * The rank of the anchor's neighbour on the side the card is being inserted, ignoring the
 * card being moved - null when the anchor is already at that end of the backlog.
 *
 * Ignoring the mover is what makes `Move up` work at all: the card directly above the
 * anchor is usually the mover itself, and measuring the gap against its own current rank
 * would compute the place it is already in.
 */
function neighbourRank(
  d: DatabaseSync,
  movingId: string,
  anchorRank: number,
  side: "before" | "after",
): number | null {
  const row = d
    .prepare(
      side === "before"
        ? `SELECT MAX(backlog_rank) AS r FROM tasks
             WHERE status = 'backlog' AND id <> ? AND backlog_rank < ?`
        : `SELECT MIN(backlog_rank) AS r FROM tasks
             WHERE status = 'backlog' AND id <> ? AND backlog_rank > ?`,
    )
    .get(movingId, anchorRank) as unknown as { r: unknown } | undefined;
  return row && Number.isSafeInteger(row.r) ? (row.r as number) : null;
}

/** Whether more than one backlog row sits on this exact rank. */
function rankIsShared(d: DatabaseSync, rank: number): boolean {
  const row = d
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'backlog' AND backlog_rank = ?`)
    .get(rank) as unknown as { n: number };
  return row.n > 1;
}

/**
 * What a relative placement came back with, and WHY when it came back with nothing.
 *
 * Two different failures used to share one `null`, and they call for opposite answers. A
 * COLLISION is the operator pointing between two cards with no integer between them - the
 * one thing the sparse scheme renumbers for. EXHAUSTED is the far side of the anchor having
 * no room left at all, which is a boundary condition: renumbering the column would not
 * create room past the end of the number line, so it would rewrite the operator's order and
 * still fail. That one is reported instead.
 */
type RelativeRank =
  | { outcome: "ok"; rank: number }
  | { outcome: "collision" }
  | { outcome: "exhausted" };

/** A rank placing `movingId` beside `anchorId`, or why one could not be found. */
function relativeRank(
  d: DatabaseSync,
  movingId: string,
  anchorId: string,
  side: "before" | "after",
): RelativeRank {
  const anchor = rankOf(d, anchorId);
  // An unranked anchor has no position to sit beside. `repairBacklogRanks` has already run
  // by the time this is called, so reaching here means the heal could not give it one -
  // which it only ever fails to do when there is no integer left to give. Exhausted, not a
  // collision: there is nothing for a renumber to make room out of.
  if (anchor === null) return { outcome: "exhausted" };
  // A rank two cards share is a gap of zero, and the collision this scheme renormalizes
  // on. It has to be caught HERE rather than swept up by a blanket pre-check, because
  // duplicates elsewhere in the column do not block this placement and must not cost a
  // rewrite. `neighbourRank` skips past the twin, so without this the card would land
  // after BOTH - which is the wrong side of the anchor whenever the twin sorts first.
  if (rankIsShared(d, anchor)) return { outcome: "collision" };
  const neighbour = neighbourRank(d, movingId, anchor, side);
  if (neighbour === null) {
    // The anchor is the first or last card, so this is a prepend or an append expressed
    // relative to it - and it takes the same shrinking step they do, for the same reason:
    // a rank planted near a limit by something outside this allocator should cost this move
    // a narrower gap, not cost every other row its place.
    const step = stepToward(anchor, side === "before" ? FLOOR : CEILING, 1);
    // No integer past the anchor at all. A renumber cannot manufacture one - it would move
    // every card and land here again - so this is reported rather than paid for.
    if (step === null) return { outcome: "exhausted" };
    return { outcome: "ok", rank: side === "before" ? anchor - step : anchor + step };
  }
  const between =
    side === "before" ? rankBetween(neighbour, anchor) : rankBetween(anchor, neighbour);
  // The genuine article: two adjacent ranks with the operator pointing between them. A
  // renumber respaces the column and the retry lands.
  return between === null ? { outcome: "collision" } : { outcome: "ok", rank: between };
}

/**
 * The rank that puts `movingId` where the operator asked, or null when the backlog has no
 * integer left to put it on.
 *
 * THE ONE PLACE A RENUMBER IS REACHABLE, down the `before`/`after` path, and only for ONE
 * of the two ways a relative placement can fail. The operator pointing between two cards
 * whose ranks are adjacent or equal is a COLLISION: there is no integer between them, and
 * respacing the column creates one. That is the trade sparse integers exist to make - one
 * row and one event for every ordinary move, the full rewrite paid on the rare move with no
 * gap left.
 *
 * The other way is EXHAUSTION - no room past the anchor, or an end that cannot be extended -
 * and it is answered with null. A renumber would be worse than useless there: it would
 * rewrite every rank the operator arranged and then run out at the same place, because the
 * number line does not get longer for being repacked. `top` and `bottom` can only ever fail
 * that way, which is why neither can reach a renumber at all.
 *
 * The retry cannot collide again: `normalizeBacklogRanks` leaves every neighbouring pair
 * exactly `RANK_STEP` apart, so a midpoint always exists. That is the whole bargain of
 * sparse integers - one row and one event for the common move, and the full rewrite paid
 * only on the rare move that has nowhere left to go.
 *
 * Both the placement and any repair it triggered are the caller's to persist inside ONE
 * transaction, so two dashboards reordering at once each produce a real ordering of the
 * real backlog and never a half-applied one.
 */
export function placeBacklogRank(
  d: DatabaseSync,
  movingId: string,
  position: RankPosition,
  anchorId: string | null,
): RankPlacement | null {
  if (position === "top") return prependRank(d);
  if (position === "bottom") return appendRank(d);
  if (!anchorId) throw new Error(`a "${position}" placement needs an anchor`);
  // A repair that cannot fit is a failure to place, reported rather than normalized around.
  const normalized = repairBacklogRanks(d);
  if (normalized === null) return null;
  const first = relativeRank(d, movingId, anchorId, position);
  if (first.outcome === "ok") return { rank: first.rank, normalized };
  // The number line has run out past the anchor. Renumbering would rewrite every rank the
  // operator arranged and then fail at exactly the same place, so this is reported.
  if (first.outcome === "exhausted") return null;

  // A true between-ranks collision, and the only thing in this file that renumbers.
  for (const [id, rank] of normalizeBacklogRanks(d)) normalized.set(id, rank);
  const second = relativeRank(d, movingId, anchorId, position);
  // Unreachable after a normalize, and thrown rather than papered over: a placement that
  // silently did nothing would leave the card where it was and report success, which is
  // the one failure mode a reorder must never have.
  if (second.outcome !== "ok") throw new Error("could not place the task in the backlog order");
  return { rank: second.rank, normalized };
}
