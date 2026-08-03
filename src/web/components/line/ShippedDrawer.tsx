import { useEffect, useMemo, useState } from "react";
import type { InspectorInspection } from "@shared/types.ts";
import { fetchInspectorPrs } from "../../lib/api.ts";
import { relativeTime } from "../../lib/format.ts";
import {
  PR_STANDINGS,
  PR_STANDING_LABELS,
  prLabel,
  prStanding,
  standingTallies,
  type PrStanding,
} from "../../lib/pr-standing.ts";
import { PrLink, SessionRef, sessionHandle } from "../settings-console.tsx";
import { StandingIcon } from "../pr-standing-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { LineDrawer, LineDrawerEmpty } from "./LineDrawer.tsx";

/**
 * SHIPPED - the pull requests the count above it is actually made of.
 *
 * For one release this stage NAVIGATED, to the workflow runs filtered to completed, because
 * no surface in the app rendered the adoption ledger at all. That target was wrong in both
 * directions - a session ships code without ever starting a workflow run, and a completed run
 * guarantees no code shipped - and the number on the strip was right the whole time: it is a
 * `COUNT` over `inspector_prs.adopted_at` in the last seven days. This is that count's own
 * rows, and clicking a number should land on what it counted.
 *
 * Four decisions shape the file.
 *
 *  1. **The strip's window, not a window of its own.** `fetchInspectorPrs(now - 7d)` is the
 *     rolling seven days the daemon's `prsThisWeek` fold uses (`prsOpenedSince`), to the
 *     millisecond and off the same column. The header therefore prints the strip's number
 *     because it counted the same rows, rather than because two folds were kept in step by
 *     hand. (The Ship log page one click deeper deliberately reads WHOLE LOCAL DAYS instead,
 *     and says so where it can be read - a feed whose headings name days cannot be built out
 *     of a rolling window. That is the only way the two are allowed to differ.)
 *  2. **The windowed read, never the bare one.** The parameterless `/api/inspector/prs` is 50
 *     rows ordered by REVIEW recency, which truncates a busy week and reshuffles a settled
 *     one - a drawer that then disagrees with the count on the button that opened it.
 *  3. **Three load states, not two.** `fetchJson` resolves null on every failure, so a drawer
 *     holding null as "no rows" would report an unreachable daemon as a quiet week. This is a
 *     panel about what shipped; "nothing did" is a claim, and it is only made from a read
 *     that actually landed. Same hazard, and the same three states, as the Intake drawer -
 *     which is the only other drawer that fetches.
 *  4. **It reads and escalates; it never acts.** Every row's move belongs to GitHub (the pull
 *     request) or to the Ship log (the cross-repo account, the ranges, the repository rail),
 *     and both are one click away. The drawer's job is the glance.
 */

/**
 * The window, matched to the daemon's own.
 *
 * `SEVEN_DAY_MS` in `registry.ts` is what `prsThisWeek` subtracts from `now`; this is the
 * browser's half of that one number. Written as a literal here rather than imported because
 * the daemon's copy lives behind `node:` imports the browser cannot take, and pushing a
 * constant into `@shared/` for a fold nobody else reads would be a wire contract invented to
 * carry a multiplication.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** All / Merged / Open / Gone. `null` is All, which is a filter's off state rather than a value. */
type ShipFilter = PrStanding | null;

/**
 * What each chip selects, in a sentence.
 *
 * The labels are one word each and one of them - `gone` - is this app's own coinage rather
 * than GitHub's, so the hover is where "closed without merging" is actually said. It is also
 * where the merge rule is stated: `merged` counts what GitHub last reported, whoever pressed
 * the button, which is a different question from the Shipping panel's "did YOLO mode land
 * this unattended".
 */
const STANDING_HINTS: Record<PrStanding, string> = {
  merged: "Show only the pull requests that merged, whoever pressed the button",
  open: "Show only the pull requests still open",
  gone: "Show only the pull requests that closed without merging",
};

function ShippedRow({
  row,
  now,
}: {
  row: InspectorInspection;
  now: number;
}): React.JSX.Element {
  const standing = prStanding(row);
  const label = prLabel(row);
  const repo = `${row.owner}/${row.repo}`;
  // Whatever the title line did NOT already say, and each half drops on its own test. The
  // label is `title ?? headRefName ?? #number`, so at the middle rung the branch IS the
  // title line and at the last one so is the number - printing either twice in two type
  // sizes is one defect at two depths. Same rule as the Ship log's feed, deliberately: the
  // two lists are read one click apart.
  const branch = row.headRefName !== null && row.headRefName !== label ? row.headRefName : null;
  const number = label === `#${row.number}` ? null : `#${row.number}`;
  return (
    <li className="line-ship-row">
      {/* The mark and the WORD, always both. Three hues are the fast read; the word is the
          one everybody gets, and it is also the only field on this row that the chips above
          filter on - a row whose state was a colour could not be checked against the chip
          that selected it. */}
      <span className={`line-ship-mark is-${standing}`}>
        <StandingIcon standing={standing} size={14} />
        <span className="line-ship-word">{PR_STANDING_LABELS[standing]}</span>
      </span>
      <span className="line-ship-who">
        <PrLink
          repo={repo}
          number={row.number}
          url={row.url}
          label={label}
          tooltip={`Open ${repo}#${row.number} on GitHub`}
        />
        <span className="line-ship-sub">
          {[repo + (number ?? ""), branch].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="line-ship-meta">
        {row.sessionId !== null && (
          <SessionRef
            handle={sessionHandle(row.sessionId)}
            tooltip={`Opened by session ${row.sessionId}`}
          />
        )}
        <span className="line-ship-when">{relativeTime(row.adoptedAt, now)}</span>
      </span>
    </li>
  );
}

export function ShippedDrawer({
  /** Injected so every relative time is a pure function of props, as on the other drawers. */
  now,
  onClose,
  onOpenShipLog,
}: {
  now: number;
  onClose: () => void;
  onOpenShipLog: () => void;
}): React.JSX.Element {
  const [ledger, setLedger] = useState<InspectorInspection[] | "loading" | "failed">("loading");
  const [filter, setFilter] = useState<ShipFilter>(null);

  // Once, on mount, and the mount is the point: this component is rendered only while the
  // drawer is open, so a fleet that never clicks Shipped never makes this request and an open
  // one makes exactly one. `now` is deliberately not a dependency - it ticks, and a window
  // recomputed per tick would refetch the ledger every second.
  useEffect(() => {
    let alive = true;
    void fetchInspectorPrs(Date.now() - WEEK_MS)
      .then((rows) => {
        if (alive) setLedger(rows ?? "failed");
      })
      // `fetchJson` cannot currently reject. Handled anyway, for the reason the Intake drawer
      // handles it: the day it grows a throw, this drawer must not sit on a permanent
      // "reading…" that an operator reads as a week in which nothing shipped.
      .catch(() => {
        if (alive) setLedger("failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  const rows = Array.isArray(ledger) ? ledger : null;
  const failed = ledger === "failed";
  // Newest adoption first. The route already orders it that way; sorting here as well is what
  // makes the ordering a property of the DRAWER rather than of a query someone else owns.
  const ordered = useMemo(
    () => (rows ? [...rows].sort((a, b) => b.adoptedAt - a.adoptedAt) : []),
    [rows],
  );
  const tallies = useMemo(() => standingTallies(ordered), [ordered]);
  const shown = filter === null ? ordered : ordered.filter((row) => prStanding(row) === filter);

  const count = rows
    ? `${ordered.length} this week`
    : failed
      // Never "0 this week". A zero an operator cannot tell from a real zero is the one
      // answer a panel about what shipped must not give while it does not know.
      ? "ledger unavailable"
      : "reading the ledger…";

  return (
    <LineDrawer
      stage="shipped"
      count={count}
      // No `attention`, on purpose, even when the read fails. The stage's standing promise is
      // that Shipped is never amber - shipping is not an obligation - and amber in this app
      // means "a person has to do something", which is not true of a ledger read that will
      // retry itself on the next open. The header says the unknown in words instead.
      onClose={onClose}
      actions={(
        <>
          {/* Only from a read that landed: chips are counts, and four counts derived from
              nothing would be four zeroes claiming a quiet week. */}
          {rows && (
            <div className="line-ship-chips" role="group" aria-label="Merge state">
              <ShipChip
                label="All"
                count={ordered.length}
                active={filter === null}
                hint="Show every pull request adopted this week"
                onPress={() => setFilter(null)}
              />
              {PR_STANDINGS.map((standing) => (
                <ShipChip
                  key={standing}
                  label={PR_STANDING_LABELS[standing]}
                  standing={standing}
                  count={tallies[standing]}
                  active={filter === standing}
                  hint={filter === standing
                    ? `Showing only these. Press again for every pull request this week.`
                    : STANDING_HINTS[standing]}
                  onPress={() => setFilter(filter === standing ? null : standing)}
                />
              ))}
            </div>
          )}
          <Tooltip label="Open the Ship log - every repo, the week's KPIs, and the ledger by day">
            <button type="button" className="btn btn-ghost" onClick={onOpenShipLog}>
              Ship log <span aria-hidden>→</span>
            </button>
          </Tooltip>
        </>
      )}
    >
      {failed ? (
        // A statement, not an absence. An unreachable ledger and a quiet week look identical
        // from here and only one of them is news about the fleet.
        <LineDrawerEmpty>
          The adoption ledger could not be read, so this drawer cannot say what shipped. It is
          not a report that nothing did.
        </LineDrawerEmpty>
      ) : rows === null ? (
        <LineDrawerEmpty>Reading the adoption ledger…</LineDrawerEmpty>
      ) : ordered.length === 0 ? (
        <LineDrawerEmpty>
          No pull request was adopted in the last seven days. A row lands here when Mission
          Control can prove one of its agents opened one.
        </LineDrawerEmpty>
      ) : filter !== null && shown.length === 0 ? (
        // Reachable: a week of nothing but merges, with the Gone chip pressed. The week is
        // not empty and the drawer must not say it is - which is what the sentence above
        // would have claimed if this arm folded into it.
        <LineDrawerEmpty>
          Nothing this week is {PR_STANDING_LABELS[filter]}. The other{" "}
          {ordered.length === 1 ? "one is" : `${ordered.length} are`} behind the All chip.
        </LineDrawerEmpty>
      ) : (
        <ul className="line-drawer-rows">
          {shown.map((row) => (
            <ShippedRow key={row.key} row={row} now={now} />
          ))}
        </ul>
      )}
    </LineDrawer>
  );
}

/**
 * One filter chip: a name, its count, and whether it is the one selected.
 *
 * `aria-pressed` rather than a radio group or a tablist, and the same shape the Ship log's
 * range chips take. It is a toggle whose off state is "all of them" - pressing the pressed
 * chip is the way back out - and it stays a toggle when it is read aloud.
 */
function ShipChip({
  label,
  standing,
  count,
  active,
  hint,
  onPress,
}: {
  label: string;
  /** Tones the chip to the pile it selects. Absent on All, which selects every pile. */
  standing?: PrStanding;
  count: number;
  active: boolean;
  hint: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Tooltip label={hint}>
      <button
        type="button"
        className={`line-ship-chip${standing ? ` is-${standing}` : ""}${active ? " is-active" : ""}`}
        aria-pressed={active}
        onClick={onPress}
      >
        {label} <span className="line-ship-chip-n">{count}</span>
      </button>
    </Tooltip>
  );
}
