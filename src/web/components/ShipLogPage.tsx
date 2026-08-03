import { useEffect, useMemo, useState } from "react";
import type { FleetCost, InspectorInspection } from "@shared/types.ts";
import { costPerPrToday, fmtUsd } from "@shared/cost.ts";
import { ExecutionPage } from "../workflows/ExecutionPage.tsx";
import { PrLink, SessionRef, sessionHandle } from "./settings-console.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { fetchInspectorPrs } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import { PR_STANDING_LABELS, prLabel, prStanding, type PrStanding } from "../lib/pr-standing.ts";
import {
  SHIP_LOG_RANGES,
  dayHeading,
  groupByDay,
  repoTallies,
  rowsInRange,
  shipLogFetchSince,
  shipLogSummary,
  sparklinePoints,
  weeklyTrend,
  type ShipLogRange,
} from "../lib/ship-log.ts";

// The Ship log: the Inspector's adoption ledger, read as the record of what the fleet
// landed across every repository it touches.
//
// The ledger has held one row per pull request since adoption shipped, and until now no
// surface rendered those rows - the Line's Shipped stage counted them and sent the click to
// the completed workflow runs, which is a different set of things (sessions ship without a
// run, and a finished run ships nothing). This page is where the count's own rows live.
//
// Three decisions shape the whole file.
//
//  1. **One read, every range a fold.** The page fetches once on mount over a window wider
//     than any range it offers (`SHIP_LOG_WINDOW_DAYS`), because the widest thing on screen
//     - the twelve-week trend - needs that much anyway, and the 30-day view's "vs the 30
//     before" needs sixty days on its own. Switching Today / 7 days / 30 days is then
//     arithmetic over rows already in hand: instant, and incapable of failing halfway
//     through a comparison or flashing a loading state over numbers that were correct.
//  2. **Windowed, never the bare read.** `fetchInspectorPrs(since)` is the adoption-window
//     reading. The parameterless default is 50 rows ordered by REVIEW recency, which would
//     both truncate a busy week and reorder it under any re-review - a page that then
//     disagrees with the Shipped count it was opened from, about rows from one table.
//  3. **Three load states, not two.** `fetchJson` resolves null on every failure, so a page
//     that held null as "no rows" would report a daemon it cannot reach as a quiet week
//     with nothing in it. This is a page about absence being meaningful; silence is the one
//     answer it must never give.

/**
 * The sparkline's box, in the SVG's own units.
 *
 * The plot is drawn shorter than the box so a run of zero weeks sits a little ABOVE the
 * bottom edge. Flush with it, a quiet quarter reads as a rule someone drew under the tile
 * rather than as the flat line it is.
 */
const SPARK_W = 68;
const SPARK_H = 28;
const SPARK_PLOT_H = 22;

/**
 * The merge-state marks, drawn rather than spelled with an emoji.
 *
 * Each one always rides with its word (see `FeedRow`): the three states differ by colour in
 * the mockup and colour alone is not a reading anyone is required to have. The paths are
 * the three shapes GitHub itself uses, which is what an operator's eye is already trained
 * on from the pull request page these rows link to.
 */
function StandingIcon({ standing }: { standing: PrStanding }): React.JSX.Element {
  return (
    <svg
      className={`shiplog-ic is-${standing}`}
      viewBox="0 0 16 16"
      width="15"
      height="15"
      aria-hidden
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="4" cy="3.5" r="1.9" />
        {standing === "merged" ? (
          <>
            <circle cx="4" cy="12.5" r="1.9" />
            <circle cx="12" cy="8" r="1.9" />
            <path d="M4 5.5v5M4 5.8c0 2.2 2.6 2.2 6 2.2" />
          </>
        ) : standing === "open" ? (
          <>
            <circle cx="4" cy="12.5" r="1.9" />
            <circle cx="12" cy="12.5" r="1.9" />
            <path d="M4 5.5v5M6 3.5h3.5A2.5 2.5 0 0 1 12 6v4.5" />
          </>
        ) : (
          <>
            <circle cx="4" cy="12.5" r="1.9" />
            <circle cx="12" cy="12.5" r="1.9" />
            <path d="M4 5.5v5M10.2 3.2l3 3M13.2 3.2l-3 3" />
          </>
        )}
      </g>
    </svg>
  );
}

/** One KPI tile. `figure` is the number; everything else is what makes it readable. */
function Kpi({
  label,
  figure,
  unit,
  note,
  noteGlyph = null,
  tone = "flat",
  tip,
  children,
}: {
  label: string;
  figure: string;
  unit?: string;
  note: string;
  /** A mark in front of the note that repeats what the note already says. Never read out. */
  noteGlyph?: string | null;
  tone?: "up" | "down" | "flat";
  tip: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip label={tip}>
      <div className="shiplog-kpi">
        <div className="shiplog-kpi-label">{label}</div>
        <div className="shiplog-kpi-figure">
          {figure}
          {unit && <span className="shiplog-kpi-unit"> {unit}</span>}
        </div>
        <div className={`shiplog-kpi-note is-${tone}`}>
          {noteGlyph && <span aria-hidden>{noteGlyph} </span>}
          {note}
        </div>
        {children}
      </div>
    </Tooltip>
  );
}

/**
 * One repository, its count and the mix of what happened to those pull requests.
 *
 * A button, because the bar IS the filter - the rail's whole claim is that the segment you
 * are looking at and the rows below are the same set. `aria-pressed` rather than a checkbox
 * or a tab: it is a toggle whose off state is "every repository", and it stays a toggle
 * when read aloud.
 */
function RepoRow({
  tally,
  active,
  onToggle,
}: {
  tally: { repo: string; total: number; merged: number; open: number; gone: number };
  active: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const parts: readonly PrStanding[] = ["merged", "open", "gone"];
  return (
    <Tooltip
      label={
        active
          ? `Showing only ${tally.repo}. Press again for every repository.`
          : `Show only the ${tally.total} pull request${tally.total === 1 ? "" : "s"} from ${tally.repo}`
      }
    >
      <button
        type="button"
        className={`shiplog-repo${active ? " is-active" : ""}`}
        aria-pressed={active}
        onClick={onToggle}
      >
        <span className="shiplog-repo-top">
          <span className="shiplog-repo-name">{tally.repo}</span>
          <span className="shiplog-repo-count">{tally.total}</span>
        </span>
        {/* `aria-hidden`, and that is not a shortcut: the accessible name below carries the
            same three numbers as words, so a mix bar announced segment by segment would say
            everything twice and neither time in a sentence. */}
        <span className="shiplog-mix" aria-hidden>
          {parts.map((part) => tally[part] > 0 && (
            <i key={part} className={`is-${part}`} style={{ flex: tally[part] }} />
          ))}
        </span>
        <span className="sr-only">
          {`${tally.merged} merged, ${tally.open} open, ${tally.gone} gone`}
        </span>
      </button>
    </Tooltip>
  );
}

/** One pull request in the feed. */
function FeedRow({ row, now }: { row: InspectorInspection; now: number }): React.JSX.Element {
  const standing = prStanding(row);
  const label = prLabel(row);
  // The subline is whatever the label did NOT already say.
  //
  // Both halves of it can collide with the label, one per rung of the fallback: an untitled
  // row is named by its branch, and a row with neither is named by its own number. Printing
  // either twice in two type sizes is the same defect at two depths, so each is dropped on
  // the same test rather than only the one that was noticed first.
  const branch = row.headRefName !== null && row.headRefName !== label ? row.headRefName : null;
  const number = label === `#${row.number}` ? null : `#${row.number}`;
  return (
    <li className="shiplog-row">
      <StandingIcon standing={standing} />
      <span className={`shiplog-standing is-${standing}`}>{PR_STANDING_LABELS[standing]}</span>
      <span className="shiplog-repo-tag">{row.repo}</span>
      <span className="shiplog-title-col">
        <PrLink
          repo={`${row.owner}/${row.repo}`}
          number={row.number}
          url={row.url}
          label={label}
          tooltip={`Open ${row.owner}/${row.repo}#${row.number} on GitHub`}
        />
        {(number || branch) && (
          <span className="shiplog-sub">
            {[number, branch].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      <span className="shiplog-row-meta">
        {row.sessionId !== null && (
          <SessionRef
            handle={sessionHandle(row.sessionId)}
            tooltip={`Opened by session ${row.sessionId}`}
          />
        )}
        <span className="shiplog-when">{relativeTime(row.adoptedAt, now)}</span>
      </span>
    </li>
  );
}

export function ShipLogPage({
  /** App's live fleet-cost state, for the one KPI this page does not fold itself. */
  fleetCost,
  /** Injected so every relative time on the page is a pure function of props, as elsewhere. */
  now,
}: {
  fleetCost: FleetCost | null;
  now: number;
}): React.JSX.Element {
  const [rangeId, setRangeId] = useState<ShipLogRange["id"]>("week");
  const [repo, setRepo] = useState<string | null>(null);
  const [ledger, setLedger] = useState<InspectorInspection[] | "loading" | "failed">("loading");

  // Once, on mount, and the mount is the whole point: this component is constructed by App
  // on every render and rendered only when `#/shipped` is the route, so a fleet that never
  // opens the Ship log never makes this request. `now` is deliberately NOT a dependency -
  // it ticks, and a window recomputed per tick would refetch the ledger every second.
  useEffect(() => {
    let alive = true;
    // Through the same calendar walk the folds use. A fixed-ms window would drift against
    // the local-midnight boundaries reading it, and across a fall-back transition it can
    // land inside the oldest bucket - see `shipLogFetchSince`.
    const since = shipLogFetchSince(Date.now());
    void fetchInspectorPrs(since)
      .then((rows) => {
        if (alive) setLedger(rows ?? "failed");
      })
      // `fetchJson` cannot currently reject. Handled anyway, for the same reason the Intake
      // drawer handles it: the day it grows a throw, this page must not sit on a permanent
      // "loading" that an operator reads as a fleet that has shipped nothing.
      .catch(() => {
        if (alive) setLedger("failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  const rows = Array.isArray(ledger) ? ledger : null;
  const failed = ledger === "failed";
  const range = SHIP_LOG_RANGES.find((r) => r.id === rangeId) ?? SHIP_LOG_RANGES[1]!;

  // Every fold below is memoized on the ledger and the range rather than on `now`, which
  // ticks: re-tallying eleven hundred rows once a second to move one "2h ago" would be the
  // page's whole cost, and the day boundary these folds turn on moves once a day.
  const day = useMemo(() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, [now]);
  const inRange = useMemo(
    () => (rows ? rowsInRange(rows, day, range.days) : []),
    [rows, day, range.days],
  );
  const summary = useMemo(
    () => (rows ? shipLogSummary(rows, day, range.days) : null),
    [rows, day, range.days],
  );
  const repos = useMemo(() => repoTallies(inRange), [inRange]);
  const trend = useMemo(() => (rows ? weeklyTrend(rows, day) : []), [rows, day]);
  const spark = useMemo(() => sparklinePoints(trend, SPARK_W, SPARK_PLOT_H), [trend]);

  // The rail's filter, applied to the feed alone. The KPI row and the rail itself keep
  // reading the whole range on purpose: narrowing the tile that says "6 repos" to the one
  // repository you just selected would delete the context the selection was made from.
  //
  // Filtered INSIDE the memo rather than beside it: a `.filter()` on the way in is a new
  // array identity on every render, which would make the grouping below a memo that never
  // hits - re-folding the whole range on every SSE tick, for a filter nobody touched.
  const days = useMemo(
    () => groupByDay(repo === null ? inRange : inRange.filter((r) => `${r.owner}/${r.repo}` === repo)),
    [inRange, repo],
  );
  const perPr = costPerPrToday(fleetCost);

  const chips = (
    <div className="shiplog-ranges" role="group" aria-label="Range">
      {SHIP_LOG_RANGES.map((option) => (
        <Tooltip key={option.id} label={option.hint}>
          <button
            type="button"
            className={`shiplog-chip${option.id === rangeId ? " is-active" : ""}`}
            aria-pressed={option.id === rangeId}
            onClick={() => setRangeId(option.id)}
          >
            {option.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );

  return (
    <ExecutionPage
      title="Ship log"
      blurb="What the fleet landed, across every repo."
      actions={chips}
    >
      {failed ? (
        <div className="workflow-empty">
          <p>The adoption ledger could not be read.</p>
          {/* Never "nothing shipped". An unreachable daemon and an empty week look
              identical from here, and only one of them is news about the fleet. */}
          <p className="shiplog-empty-sub">
            Mission Control could not reach its own ledger, so this page cannot say what
            shipped. It is not a report that nothing did.
          </p>
        </div>
      ) : summary === null ? (
        <div className="workflow-empty">
          <p>Reading the ledger…</p>
        </div>
      ) : (
        <>
          <div className="shiplog-kpis">
            <Kpi
              label={range.kpiLabel}
              figure={String(summary.total)}
              // The arrow is DECORATION over a signed number that already says the
              // direction, so it is hidden rather than read out - unhidden, a screen reader
              // announces the triangle's character name in front of every delta.
              noteGlyph={
                !summary.priorKnown || summary.delta === 0 ? null : summary.delta > 0 ? "▲" : "▼"
              }
              note={
                !summary.priorKnown
                  ? "no earlier comparison in range"
                  : summary.delta === 0
                    ? `level ${range.priorLabel}`
                    : `${summary.delta > 0 ? "+" : ""}${summary.delta} ${range.priorLabel}`
              }
              tone={summary.delta === 0 || !summary.priorKnown ? "flat" : summary.delta > 0 ? "up" : "down"}
              tip={
                `${summary.total} pull request${summary.total === 1 ? "" : "s"} adopted in this range, against ${summary.prior} in the range before it.\n` +
                "Adopted means Mission Control can prove one of its agents opened it. The range is whole local days ending today, so it is not the Line's rolling seven days to the minute.\n" +
                "The line is the last twelve weeks whichever range is selected, so a short range still has its context behind it."
              }
            >
              {trend.some((count) => count > 0) && (
                <svg
                  className="shiplog-spark"
                  width={SPARK_W}
                  height={SPARK_H}
                  viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                  aria-hidden
                  focusable="false"
                >
                  {/* Twelve weeks in the quiet colour, the last one in the loud one. The
                      shape alone cannot say which end is now, and that is the only thing a
                      twelve-point line beside a single number is for. */}
                  <polyline
                    className="shiplog-spark-history"
                    points={spark.points}
                    fill="none"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <polyline
                    className="shiplog-spark-tail"
                    points={spark.tail}
                    fill="none"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                  {spark.last && <circle cx={spark.last.x} cy={spark.last.y} r="2.4" />}
                </svg>
              )}
            </Kpi>
            <Kpi
              label="Merged"
              figure={String(summary.standing.merged)}
              unit={`of ${summary.total}`}
              note={
                summary.mergeRate === null
                  ? "nothing adopted in this range"
                  : `${summary.mergeRate}% of adopted PRs landed`
              }
              tip={
                `${summary.standing.merged} merged, ${summary.standing.open} still open, ${summary.standing.gone} closed without merging.\n` +
                "Merged counts what GitHub last reported as merged, whoever pressed the button."
              }
            />
            <Kpi
              label="Per PR today"
              figure={perPr === null ? "-" : `≈${fmtUsd(perPr)}`}
              note={
                perPr === null
                  ? "not measured today"
                  : `over ${fleetCost?.prsToday ?? 0} today, fleet-wide`
              }
              tip={
                perPr === null
                  ? "Today's estimated fleet spend divided by the pull requests adopted today. Not shown when cost telemetry is off, when part of today's usage is unpriced, or before anything has shipped today."
                  : `Today's estimated API-equivalent fleet spend over the ${fleetCost?.prsToday ?? 0} pull request${fleetCost?.prsToday === 1 ? "" : "s"} adopted today. A fleet-wide average of one day, not this range, and not attributable to any one row.`
              }
            />
            <Kpi
              label="Repos"
              figure={String(summary.repos)}
              note={`${summary.reposToday} active today`}
              tip="Distinct repositories with an adopted pull request in this range. This is the number the page exists to make visible."
            />
          </div>

          <div className="shiplog-body">
            <div className="shiplog-rail">
              <h3 className="shiplog-rail-head">Repositories</h3>
              <p className="shiplog-legend" aria-hidden>
                <span><i className="is-merged" />merged</span>
                <span><i className="is-open" />open</span>
                <span><i className="is-gone" />gone</span>
              </p>
              {repos.length === 0 && (
                <p className="shiplog-rail-empty">No repository shipped in this range.</p>
              )}
              {repos.map((tally) => (
                <RepoRow
                  key={tally.repo}
                  tally={tally}
                  active={repo === tally.repo}
                  onToggle={() => setRepo(repo === tally.repo ? null : tally.repo)}
                />
              ))}
              {/* Outside the "the rail has rows" arm, and that is the point: narrowing to
                  one repository and then widening the range to one it did not ship in
                  empties the rail, and nesting this inside it took away the only control
                  that mentions the filter still deciding what you are looking at. */}
              {repo !== null && (
                <Tooltip label="Drop the repository filter and show the whole range again">
                  <button
                    type="button"
                    className="shiplog-clear"
                    onClick={() => setRepo(null)}
                  >
                    Show every repository
                  </button>
                </Tooltip>
              )}
            </div>

            <div className="shiplog-feed">
              {days.length === 0 ? (
                <p className="shiplog-feed-empty">
                  {repo === null
                    ? "No pull request was adopted in this range."
                    : `No pull request was adopted in ${repo} in this range.`}
                </p>
              ) : (
                // A plain `div`, not a labelled `section`. A month's feed is thirty days,
                // and thirty `region` landmarks each named the same as the heading inside
                // it is thirty entries of noise in the rotor - the headings are already
                // the navigable structure of this list.
                days.map((entry) => (
                  <div key={entry.day}>
                    <h3 className="shiplog-day">
                      {dayHeading(entry.day, day)}
                      <span className="shiplog-day-right">
                        {entry.merged} of {entry.rows.length} merged
                      </span>
                    </h3>
                    <ul className="shiplog-rows">
                      {entry.rows.map((row) => (
                        <FeedRow key={row.key} row={row} now={now} />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </ExecutionPage>
  );
}
