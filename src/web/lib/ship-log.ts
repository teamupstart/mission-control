// Every fold the Ship log page draws itself from, as pure functions of the ledger rows and
// a `now`.
//
// Separate from the component for the reason the run model is separate from the run reader:
// "which day did this land on" and "how much of this week merged" are arithmetic, they have
// edge cases a rendering test cannot reach cheaply (a midnight boundary, an empty week, a
// week whose predecessor is empty), and every one of them is a number an operator will take
// at face value. `now` is a parameter rather than a `Date.now()` call for the same reason it
// is on the drawers: a fold that reads the clock cannot be tested at a date.
//
// Separate from `pr-standing.ts` because that file answers "where does this pull request
// stand", which the drawer in the next phase asks too. This one is the PAGE's arithmetic.

import type { InspectorInspection } from "@shared/types.ts";
import { prStanding, standingTallies, type PrStanding } from "./pr-standing.ts";

/**
 * The ranges the page offers, and the window it actually reads.
 *
 * `WINDOW_DAYS` is what one fetch covers, and it is deliberately wider than the widest
 * range: the 30-day view's "vs the previous 30 days" needs 60, and the trend needs twelve
 * weeks. One read of 84 days answers all three, so switching range is a fold rather than a
 * fetch - instant, and unable to fail or flicker halfway through a comparison.
 */
export const SHIP_LOG_WINDOW_DAYS = 84;
export const SHIP_LOG_TREND_WEEKS = 12;

export interface ShipLogRange {
  id: "today" | "week" | "month";
  /** The chip's text. */
  label: string;
  days: number;
  /** How the KPI names its own total, e.g. "Shipped this week". */
  kpiLabel: string;
  /** What the delta is measured against, in the words under the number. */
  priorLabel: string;
  /** The chip's hover description. Says the boundary, which the label cannot. */
  hint: string;
}

export const SHIP_LOG_RANGES: readonly ShipLogRange[] = [
  {
    id: "today",
    label: "Today",
    days: 1,
    kpiLabel: "Shipped today",
    priorLabel: "vs yesterday",
    hint: "Show only pull requests adopted since local midnight",
  },
  {
    id: "week",
    label: "7 days",
    days: 7,
    kpiLabel: "Shipped this week",
    priorLabel: "vs last week",
    // NOT "the window the Line's Shipped count uses". The Line's is a rolling `now - 7d`
    // computed in the daemon; this is seven whole local days. They differ by the part of
    // today already gone, so a chip claiming they are the same would be wrong every
    // afternoon - and wrong in the one place an operator would check it.
    hint: "Show the last seven whole days, ending today",
  },
  {
    id: "month",
    label: "30 days",
    days: 30,
    kpiLabel: "Shipped in 30 days",
    priorLabel: "vs the 30 before",
    hint: "Show the last thirty calendar days, ending today",
  },
];

export const DAY_MS = 86_400_000;

/**
 * Local midnight at or before `at`.
 *
 * LOCAL, and computed through `Date` rather than by flooring to a multiple of `DAY_MS`,
 * because the arithmetic answer is wrong twice a year and in most of the world every day:
 * a day is not 86,400,000 ms across a DST change and midnight is not at a UTC multiple
 * outside UTC. "Today" on this page means the operator's today.
 */
export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The local midnight `days` calendar days from the one at or before `at`.
 *
 * Every day boundary on this page is walked with this rather than by adding `DAY_MS`, and
 * that is the whole reason it exists: `setDate` moves a DATE, so the clock lands on
 * midnight again across a transition, while `+ 86_400_000` lands an hour either side of it.
 * Getting that wrong is not a rounding error - it makes the 7-day range start at 23:00 on
 * its eighth day (so the feed renders eight headings under a chip that says seven), and in
 * the other direction it drops a row out of the range and into the delta it is compared
 * against, which moves two numbers in opposite directions at once.
 */
export function addLocalDays(at: number, days: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * The instant a range begins.
 *
 * Anchored to local midnight and counted back in whole CALENDAR days, so "7 days" is seven
 * of the operator's days ending today rather than a rolling 168 hours. A rolling window
 * would put part of a day under a heading that names the whole of it, and the feed's
 * headings are its only ordering.
 *
 * This is deliberately NOT the window the Line's Shipped count uses - that one is a rolling
 * `now - 7d` in the daemon. The two therefore differ by the part of today already elapsed,
 * and the page says so where it can be read (the KPI's own description) rather than
 * claiming a parity it does not have. The `adoptedSince` read is what stops them differing
 * for the reason that would actually matter: truncation and re-ordering.
 */
export function rangeStart(now: number, days: number): number {
  return addLocalDays(now, -(days - 1));
}

/**
 * The rows adopted within `days` calendar days ending today, newest first.
 *
 * Open at the top end, deliberately. Bounding it at `now` would mean the page's callers had
 * to pass a ticking clock - which is what the folds are memoized to avoid - and the only
 * rows it could ever exclude are ones stamped in the future by a clock that disagrees with
 * this one. A pull request the ledger says was adopted in twenty minutes is still a pull
 * request that was adopted; dropping it would be a row that exists in the Line's count and
 * nowhere on the page the count links to.
 */
export function rowsInRange(
  rows: readonly InspectorInspection[],
  now: number,
  days: number,
): InspectorInspection[] {
  const from = rangeStart(now, days);
  return rows
    .filter((row) => row.adoptedAt >= from)
    .sort((a, b) => b.adoptedAt - a.adoptedAt);
}

/** The rows in the range immediately BEFORE this one - the delta's denominator. */
export function rowsInPriorRange(
  rows: readonly InspectorInspection[],
  now: number,
  days: number,
): InspectorInspection[] {
  const from = rangeStart(now, days);
  const priorFrom = addLocalDays(from, -days);
  return rows.filter((row) => row.adoptedAt >= priorFrom && row.adoptedAt < from);
}

export interface RepoTally {
  /** `owner/repo`, which is what makes this page cross-repo rather than a list. */
  repo: string;
  total: number;
  merged: number;
  open: number;
  gone: number;
}

/**
 * One entry per repository the range touched, busiest first.
 *
 * Ties break by name so the rail does not reshuffle under a poll that changed nothing about
 * the order - a list whose rows swap places while you are reading it is a list you stop
 * trusting to be the same list.
 */
export function repoTallies(rows: readonly InspectorInspection[]): RepoTally[] {
  const byRepo = new Map<string, InspectorInspection[]>();
  for (const row of rows) {
    const repo = `${row.owner}/${row.repo}`;
    const bucket = byRepo.get(repo);
    if (bucket) bucket.push(row);
    else byRepo.set(repo, [row]);
  }
  return [...byRepo.entries()]
    .map(([repo, group]) => ({ repo, total: group.length, ...standingTallies(group) }))
    .sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo, "en-US"));
}

export interface ShipLogDay {
  /** Local midnight of the day these rows landed on. */
  day: number;
  rows: InspectorInspection[];
  merged: number;
}

/**
 * The feed: rows grouped by the local day they were adopted, newest day first and newest
 * row first within each day.
 *
 * Empty days are omitted rather than rendered as a heading over nothing. A quiet Sunday is
 * not a fact this page is trying to report, and thirty headings for eleven pull requests
 * would bury the ones that exist.
 */
export function groupByDay(rows: readonly InspectorInspection[]): ShipLogDay[] {
  const byDay = new Map<number, InspectorInspection[]>();
  for (const row of rows) {
    const day = startOfLocalDay(row.adoptedAt);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(row);
    else byDay.set(day, [row]);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([day, group]) => {
      const ordered = [...group].sort((a, b) => b.adoptedAt - a.adoptedAt);
      return {
        day,
        rows: ordered,
        merged: ordered.filter((row) => prStanding(row) === "merged").length,
      };
    });
}

/**
 * A day heading: "Today", "Yesterday", or the date.
 *
 * The two relative words earn their place because they are what the operator is actually
 * asking about; past that, a weekday alone ("Friday") is ambiguous inside a 30-day range
 * and a bare date is not, so the third form carries both.
 */
export function dayHeading(day: number, now: number, locale?: string): string {
  const today = startOfLocalDay(now);
  if (day === today) return "Today";
  // `addLocalDays`, not `today - DAY_MS`: on the day after a transition, yesterday's
  // midnight is 23 or 25 hours back and a fixed-ms comparison matches no group at all, so
  // "Yesterday" silently becomes a date for a whole day, twice a year, in most of the world.
  if (day === addLocalDays(today, -1)) return "Yesterday";
  return new Date(day).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Weekly counts over the trend window, oldest first, ending with the week in progress.
 *
 * Weeks are counted back from today rather than from Sunday, so the last point is always
 * "the last seven days" and the sparkline's final segment means the same thing as the KPI
 * beside it.
 */
export function weeklyTrend(
  rows: readonly InspectorInspection[],
  now: number,
  weeks = SHIP_LOG_TREND_WEEKS,
): number[] {
  const end = addLocalDays(now, 1);
  const counts: number[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const to = addLocalDays(end, -i * 7);
    const from = addLocalDays(to, -7);
    counts.push(rows.filter((row) => {
      // The LAST bucket is open at the top, exactly as `rowsInRange` is, so a row stamped
      // ahead of this clock is in both or in neither. Half-open here and open there, the
      // sparkline's final point and the number printed beside it would disagree about the
      // same row - which is the one comparison a trend line next to a total invites.
      if (row.adoptedAt < from) return false;
      return i === 0 || row.adoptedAt < to;
    }).length);
  }
  return counts;
}

export interface ShipLogSummary {
  total: number;
  prior: number;
  /** `total - prior`. Signed, and meaningless on its own - see `priorKnown`. */
  delta: number;
  /**
   * Whether the previous range is inside the window we actually read.
   *
   * False means "we did not look that far back", which must not be drawn as a rise from
   * zero. The one range this can be false for is a window narrower than twice the range;
   * it is a guard against a later change to `SHIP_LOG_WINDOW_DAYS`, not a live state.
   */
  priorKnown: boolean;
  standing: Record<PrStanding, number>;
  /** Merged as a percentage of the range's rows, rounded. Null when there are no rows. */
  mergeRate: number | null;
  repos: number;
  reposToday: number;
}

export function shipLogSummary(
  all: readonly InspectorInspection[],
  now: number,
  days: number,
  windowDays = SHIP_LOG_WINDOW_DAYS,
): ShipLogSummary {
  const rows = rowsInRange(all, now, days);
  const prior = rowsInPriorRange(all, now, days);
  const standing = standingTallies(rows);
  const today = startOfLocalDay(now);
  return {
    total: rows.length,
    prior: prior.length,
    delta: rows.length - prior.length,
    priorKnown: days * 2 <= windowDays,
    standing,
    mergeRate: rows.length === 0 ? null : Math.round((standing.merged / rows.length) * 100),
    repos: new Set(rows.map((row) => `${row.owner}/${row.repo}`)).size,
    reposToday: new Set(
      rows.filter((row) => row.adoptedAt >= today).map((row) => `${row.owner}/${row.repo}`),
    ).size,
  };
}

/**
 * The sparkline's path, plus the last leg of it and where that leg ends.
 *
 * Here rather than in the component because it is arithmetic with a division by zero in it:
 * a fleet whose busiest week is zero has no scale, and a flat line along the bottom is the
 * honest drawing of that rather than a `NaN` that renders as nothing at all.
 *
 * `tail` is the final segment on its own so the drawing can tone it differently from the
 * history behind it. That is the one thing a twelve-point squiggle has to say and cannot
 * say by shape alone - which end is now.
 */
export function sparklinePoints(
  counts: readonly number[],
  width: number,
  height: number,
): { points: string; tail: string; last: { x: number; y: number } | null } {
  if (counts.length === 0) return { points: "", tail: "", last: null };
  const peak = Math.max(...counts, 1);
  const step = counts.length === 1 ? 0 : width / (counts.length - 1);
  const xy = counts.map((count, i) => ({
    x: Number((i * step).toFixed(2)),
    y: Number((height - (count / peak) * height).toFixed(2)),
  }));
  const at = (p: { x: number; y: number }): string => `${p.x},${p.y}`;
  return {
    points: xy.map(at).join(" "),
    tail: xy.length > 1 ? xy.slice(-2).map(at).join(" ") : "",
    last: xy.at(-1) ?? null,
  };
}
