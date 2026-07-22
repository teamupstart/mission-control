import type { FleetCost, RateLimitWindow } from "@shared/types.ts";
import { FIVE_HOUR_MS, SEVEN_DAY_MS, projectRunway } from "@shared/cost.ts";
import { Tooltip } from "./Tooltip.tsx";
import { compactTokens, contextTone, fmtRunway, fmtUsd, untilReset } from "../lib/format.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";

/**
 * The topbar's fleet economics: what today cost, how fast it is going, and how long the
 * subscription's windows last at that rate.
 *
 * Four figures and a projection, chosen because each answers a question the others cannot:
 * spend is the total, burn is the derivative, tokens are the work the dollars bought (and
 * the only figure a Max subscriber's notional dollars cannot give them), and cost-per-PR
 * is the one that turns all three into a unit price for shipped work. The runway is the
 * only forward-looking thing on the strip, and it is the reason the strip exists: a rate
 * limit that arrives mid-task is a surprise, and this is what stops it being one.
 *
 * Every figure degrades on its own rather than as a block. No telemetry -> the caller
 * renders nothing at all (a `$0.00` would claim a fleet that cost nothing). No PRs opened
 * today -> no cost-per-PR, rather than a division by zero dressed as `$0.00`. No
 * `rate_limits` (an API-key user, or a session before its first API response) -> no
 * runway, rather than a bar at 0%.
 *
 * `view` picks which half LEADS, not which exists. On a Pro/Max plan the dollars are
 * notional and the percentage is the real constraint, so `plan` puts the windows first;
 * whichever group lands last is pushed to the far edge by CSS, so the strip reads as two
 * blocks either way rather than reflowing into a different shape.
 */
export function FleetStrip({
  fleet,
  view,
}: {
  fleet: FleetCost;
  view: "usd" | "plan";
}): React.JSX.Element | null {
  if (!fleetStripHasContent(fleet)) return null;
  const stats = <FleetStats fleet={fleet} />;
  const windows = <FleetWindows fleet={fleet} />;
  return (
    <div className="fleet-strip">
      {view === "plan" ? (
        <>
          {windows}
          {stats}
        </>
      ) : (
        <>
          {stats}
          {windows}
        </>
      )}
    </div>
  );
}

/**
 * Whether the strip would draw anything - asked by the topbar row that hosts it, which
 * has its own chrome (a fold toggle) and must not render a header over an empty strip.
 * One predicate rather than two `&&`s in two files: the row and the strip disagreeing is
 * exactly the bug where the toggle survives the figures it folds.
 */
export function fleetStripHasContent(fleet: FleetCost | null): boolean {
  if (!fleet) return false;
  const limits = fleet.rateLimits;
  return fleet.estimatedCostToday === null || fleet.estimatedBurnPerHour === null ||
    fleet.estimatedCostToday > 0 || fleet.estimatedBurnPerHour > 0 || fleet.tokensToday > 0 ||
    !!limits?.fiveHour || !!limits?.sevenDay || !!fleet.rateLimitSources?.some((s) => s.windows.length);
}

export function compactFleetCost(fleet: FleetCost): string | null {
  if (fleet.estimatedCostToday === null) return "partial";
  return fleet.estimatedCostToday > 0 ? `≈${fmtUsd(fleet.estimatedCostToday)}` : null;
}

/** The dollar-and-token half. Null when the ledger has nothing for today. */
function FleetStats({ fleet }: { fleet: FleetCost }): React.JSX.Element | null {
  if (
    fleet.estimatedCostToday !== null && fleet.estimatedCostToday <= 0 &&
    fleet.estimatedBurnPerHour !== null && fleet.estimatedBurnPerHour <= 0 &&
    fleet.tokensToday <= 0
  ) return null;
  const estimated = fleet.estimatedCostToday;
  return (
    <div className="fs-stats">
      {estimated !== null && estimated > 0 &&
        <FleetStat
          n={`≈${fmtUsd(estimated)}`}
          label="estimated cost today"
          cost
          tip={`${fmtUsd(estimated)} of API-equivalent usage since midnight. Claude Code calculates its rows; Mission Control calculates Codex rows from a versioned Standard API price snapshot. This is not subscription spend or an invoice.`}
        />
      }
      {estimated === null && <FleetStat
        n="partial"
        label="cost estimate"
        tip="At least one usage row has no verified model price, so Mission Control will not present the known subtotal as a complete fleet estimate. Tokens remain complete."
      />}
      {fleet.estimatedBurnPerHour !== null && <FleetStat
        n={`≈${fmtUsd(fleet.estimatedBurnPerHour)}`}
        unit="/hr"
        label="estimated rate"
        tip={`${fmtUsd(fleet.estimatedBurnPerHour)} of API-equivalent usage in the last hour; not actual subscription spend.`}
      />}
      {fleet.estimatedBurnPerHour === null && <FleetStat
        n="partial"
        label="estimated rate"
        tip="At least one usage row in the last hour has no verified model price, so Mission Control will not present the known subtotal as a complete recent rate."
      />}
      {fleet.tokensToday > 0 && <FleetStat
        n={compactTokens(fleet.tokensToday)}
        label="tokens today"
        tip={`${fleet.tokensToday.toLocaleString("en-US")} tokens since midnight - input, output and cache, every tier summed.`}
      />}
      {estimated !== null && estimated > 0 && fleet.prsToday > 0 && (
        <FleetStat
          n={`≈${fmtUsd(estimated / fleet.prsToday)}`}
          label="cost / PR"
          tip={
            `${fmtUsd(estimated)} of API-equivalent usage today over ${fleet.prsToday} pull request${fleet.prsToday === 1 ? "" : "s"} your agents opened.\n` +
            `Includes Claude and Codex estimates; counts only PRs we can prove we opened.`
          }
        />
      )}
    </div>
  );
}

/** The rate-limit half: one runway per window we have been told about. */
function FleetWindows({ fleet }: { fleet: FleetCost }): React.JSX.Element | null {
  const limits = fleet.rateLimits;
  const sources = fleet.rateLimitSources ?? [];
  if (!limits?.fiveHour && !limits?.sevenDay && !sources.some((s) => s.windows.length)) return null;
  return (
    <div className="fs-windows">
      {limits?.fiveHour && (
        <Runway window={limits.fiveHour} windowMs={FIVE_HOUR_MS} label="Claude · 5-hr limit runway" />
      )}
      {limits?.sevenDay && (
        <Runway window={limits.sevenDay} windowMs={SEVEN_DAY_MS} label="Claude · 7-day limit runway" />
      )}
      {sources.flatMap((source) => source.windows.map((window) => (
        <Runway
          key={`${source.source}:${window.id ?? window.label}`}
          window={window}
          windowMs={(window.durationMinutes ?? 0) * 60_000}
          label={`${AGENT_IDENTITY[source.source].label} · ${window.label ?? "unknown"} limit runway`}
        />
      )))}
    </div>
  );
}

/**
 * One rate-limit window: how much of it is gone, and how long the rest lasts.
 *
 * The bar is consumption (a fact Claude sent us) and the figure beside the label is the
 * projection (ours, and marked with a `~`). Keeping them in one block is the point -
 * "74% used" and "about 41 minutes left" are the same sentence, and separating them is
 * how you get someone reading a comfortable percentage an hour before it stops being one.
 *
 * A window the current rate does not exhaust reads "clears", not a time: the honest answer
 * there is that the reset arrives first, and inventing a runway longer than the window
 * would be a number about nothing.
 */
function Runway({
  window,
  windowMs,
  label,
}: {
  window: RateLimitWindow;
  windowMs: number;
  label: string;
}): React.JSX.Element {
  const pct = Math.min(100, Math.max(0, window.usedPercentage));
  const runway = projectRunway(window, windowMs, Date.now());
  const headline = !runway ? `${Math.round(pct)}%` : runway.clears ? "clears" : fmtRunway(runway.ms);
  const tip =
    `${Math.round(window.usedPercentage)}% used, resets ${untilReset(window.resetsAt)}.\n` +
    (!runway
      ? `Not enough of the window has been spent to project a runway.`
      : runway.clears
        ? `At this rate the window resets before you exhaust it.`
        : `At this rate it is exhausted in ${fmtRunway(runway.ms).replace("~", "about ")}.`);
  return (
    <Tooltip label={tip}>
      {/* `contextTone` rather than a private set of rate-limit thresholds: the amber/red
          escalation is already defined for the card's context meter, and a second copy of
          70/90 would drift the first time one of them was tuned. */}
      <div className="fs-runway" data-tone={runway?.clears ? "ok" : contextTone(pct)}>
        <div className="runway-head">
          <span>{label}</span>
          <b>{headline}</b>
        </div>
        <div className="runway-meter" aria-hidden>
          {/* `--pct` is the fill's own width as a bare number: the stylesheet uses it to
              stretch the gradient back out to the track, so the colours stay at fixed
              positions. Floored at 1 because it is a divisor. */}
          <span
            className="runway-fill"
            style={{ width: `${pct}%`, ["--pct" as string]: Math.max(1, pct) }}
          />
        </div>
      </div>
    </Tooltip>
  );
}

/** One big figure over its label, the strip's unit of layout. */
function FleetStat({
  n,
  unit,
  label,
  cost,
  tip,
}: {
  n: string;
  unit?: string;
  label: string;
  cost?: boolean;
  tip: string;
}): React.JSX.Element {
  return (
    <Tooltip label={tip}>
      <div className="fs-stat">
        <span className={`fs-n${cost ? " fs-n-cost" : ""}`}>
          {n}
          {unit && <span className="fs-unit">{unit}</span>}
        </span>
        <span className="fs-l">{label}</span>
      </div>
    </Tooltip>
  );
}
