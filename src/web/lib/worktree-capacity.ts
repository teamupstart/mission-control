import type { WorktreeRepositoryView } from "@shared/worktrees.ts";

/**
 * Capacity-bar geometry for one native worktree pool.
 *
 * The track's full width IS the pool's configured maximum, so the unfilled remainder reads
 * directly as room to grow. That only works if the arithmetic can never exceed the track,
 * which is the whole reason this lives in one exported function rather than inline in the
 * component: over capacity is a SATURATED track plus a spill marker, not a fourth segment.
 *
 * Appending overflow as its own segment is the tempting mistake: `leased + available +
 * quarantined` already sums to `total`, so an appended `total - maxSlots` segment would
 * double-count the very slots it means to mark.
 *
 * THE DENOMINATOR IS THE CONFIGURED MAXIMUM, UNCONDITIONALLY. That is the whole promise:
 * 100% of the track is `maxSlots`, so one slot is always the same fraction of the bar for a
 * given maximum, and lowering `Default maximum` widens every segment on every bar drawn
 * against it. An earlier revision used `max(maxSlots, total)` so that an over-capacity pool
 * still summed to 100%; that quietly made the scale depend on current OCCUPANCY - an 18-slot
 * pool capped at 16 put its ceiling at 88.9% and a 32-slot pool capped at 16 put the same
 * ceiling at 50% - and lowering the maximum then only slid a marker instead of reflowing the
 * bar. The track is the ceiling, not the contents.
 *
 * Over capacity is therefore what it looks like in the world: the ceiling is full and there
 * is spill. Composition segments are laid out at `count / maxSlots` and the cumulative
 * boundary is clamped to 100%, so the slots that fit are drawn to true scale and the ones
 * past the ceiling are not drawn - because they do not fit, which IS the message. The excess
 * is carried by the hatched cap at the track's end, by `N over the maximum` in the legend,
 * and by the composed image label. Colour is never the only cue.
 *
 * The tradeoff, recorded deliberately: when a pool is over capacity the clamp can push a
 * small trailing segment out of the track (17 leased against a maximum of 16 consumes the
 * whole ceiling, so a single quarantined slot has no width left). The legend still states
 * every lifecycle count including that one, which is why the legend is built from its own
 * list rather than from the drawn segments.
 *
 * Widths are derived from cumulative rounded boundaries rather than rounded independently,
 * so the segments sum to 100.0 exactly at one decimal place instead of drifting by a
 * rounding unit or two.
 *
 * WHAT IS DRAWN AND WHAT IS SAID ARE TWO DIFFERENT LISTS, and conflating them is the
 * accessibility bug this file used to carry. `segments` is what the track paints, so a
 * zero-count state is absent from it - a 0%-wide box is not a thing anyone can see. But
 * "0 available" is exactly the fact an operator came here for, so `legend` always names all
 * four lifecycle counts, zeroes included, and the composed `role="img"` label is built from
 * `legend` rather than from `segments`. Colour, and the absence of colour, carry nothing on
 * their own. Overflow stays conditional, because "0 over the maximum" is a state with no
 * decision attached to it - the maximum row already says where the ceiling is.
 */

export type CapacitySegmentKey = "leased" | "available" | "quarantined" | "room";

export interface CapacitySegment {
  key: CapacitySegmentKey;
  count: number;
  /** Track width in percent, already rounded to one decimal. */
  percent: number;
  /** The same count restated as the words that appear in the legend beneath the bar. */
  label: string;
}

export interface CapacityOverflow {
  count: number;
  /**
   * How far past the ceiling the pool is, as a percentage of the maximum - 12.5 for 18
   * slots against a maximum of 16. Reported for the reader, not used as a track width:
   * the track has no room left to give, which is the point.
   */
  percentOfMaximum: number;
  label: string;
}

export interface CapacityGeometry {
  total: number;
  maxSlots: number;
  /** The configured maximum, floored at 1 so a zero-capacity pool cannot emit `NaN%`. */
  denominator: number;
  /**
   * What the track paints: leased, available, quarantined, then room to grow, with
   * zero-count entries dropped because they have no width, and trailing entries dropped
   * when an over-capacity pool has already consumed the whole ceiling. Never use this for
   * text - `legend` is the complete list.
   */
  segments: CapacitySegment[];
  /**
   * What the pane says: all four lifecycle counts in the same order, always, zeroes
   * included. This is the legend beneath the bar and the source of `label`.
   */
  legend: CapacitySegment[];
  overflow: CapacityOverflow | null;
  /** The bar's composed `role="img"` label. Colour never carries any of this alone. */
  label: string;
  /** The compact count beside the pool name. */
  summary: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** One decimal place, which is finer than any pixel a 900px measure can render. */
function tenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function capacityGeometry(
  counts: WorktreeRepositoryView["counts"],
  configuredMaxSlots: number,
): CapacityGeometry {
  const leased = Math.max(0, Math.trunc(counts.leased));
  const available = Math.max(0, Math.trunc(counts.available));
  const quarantined = Math.max(0, Math.trunc(counts.quarantined));
  // The composition is defined by the three lifecycle counts, so a `total` that disagrees
  // with them cannot bend the track: it would be the one number that is not drawn.
  const total = leased + available + quarantined;
  const maxSlots = Number.isFinite(configuredMaxSlots)
    ? Math.max(0, Math.trunc(configuredMaxSlots))
    : 0;
  const room = Math.max(0, maxSlots - total);
  const over = Math.max(0, total - maxSlots);
  // The ceiling, never the contents. See the header: this is the load-bearing line.
  const denominator = Math.max(maxSlots, 1);

  const parts: Array<{ key: CapacitySegmentKey; count: number; label: string }> = [
    { key: "leased", count: leased, label: `${leased} leased` },
    { key: "available", count: available, label: `${available} available` },
    { key: "quarantined", count: quarantined, label: `${quarantined} quarantined` },
    { key: "room", count: room, label: `${room} more may be created` },
  ];

  // One pass builds both lists, so a width and its words can never disagree: `legend` takes
  // every part, `segments` takes only the ones with a width to paint.
  const legend: CapacitySegment[] = [];
  const segments: CapacitySegment[] = [];
  let cumulative = 0;
  let boundary = 0;
  for (const part of parts) {
    if (part.count === 0) {
      legend.push({ ...part, percent: 0 });
      continue;
    }
    cumulative += part.count;
    // Clamped, so an over-capacity pool fills its ceiling exactly rather than laying out a
    // track wider than the box that holds it.
    const next = Math.min(100, tenth((cumulative / denominator) * 100));
    const percent = tenth(next - boundary);
    const segment: CapacitySegment = { ...part, percent };
    boundary = next;
    legend.push(segment);
    if (percent > 0) segments.push(segment);
  }

  const overflow: CapacityOverflow | null = over > 0
    ? {
        count: over,
        percentOfMaximum: tenth((over / denominator) * 100),
        label: `${over} over the maximum`,
      }
    : null;

  // Composed from `legend`, not `segments`, so a pool with nothing quarantined still says
  // so out loud instead of leaving the reader to infer it from a colour that is not there.
  const spoken = legend.map((entry) => entry.label);
  if (overflow) spoken.push(overflow.label);
  spoken.push(`maximum ${maxSlots}`);

  return {
    total,
    maxSlots,
    denominator,
    segments,
    legend,
    overflow,
    label: spoken.join(", "),
    summary: `${total} of ${plural(maxSlots, "slot")}`,
  };
}
