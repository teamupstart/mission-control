import type { FleetCost, RateLimitWindow } from "@shared/types.ts";
import { FIVE_HOUR_MS, SEVEN_DAY_MS, projectRunway } from "@shared/cost.ts";
import { Tooltip } from "./Tooltip.tsx";
import { compactTokens, contextTone, fmtRunway, fmtUsd, untilReset } from "../lib/format.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { spendRoleLabel } from "@shared/llm-spend.ts";

/**
 * The topbar's fleet economics: today's API-equivalent estimate, its recent rate, and how
 * long each provider's quota windows last at their own consumption rate.
 *
 * Four session figures, a separate automation figure, and a projection, chosen because each
 * answers a question the others cannot: estimated session cost is the total, recent rate is
 * its derivative, tokens are the measured work, and estimated cost-per-PR turns the first
 * figure into a unit price for shipped work. Automation names the app's own overhead. The
 * runway is the only forward-looking thing on the strip, and it is the reason the strip
 * exists: a rate limit that arrives mid-task is a surprise, and this is what stops it being one.
 *
 * Every figure degrades on its own rather than as a block. No session or automation usage ->
 * the caller renders nothing at all (a `$0.00` would claim a measured zero). No PRs opened
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
    // A fleet with no live sessions can still have spent: the loops run on their own
    // schedule, and an Inspector reviewing a PR overnight is exactly the case where the
    // strip must not be empty. Without this clause the one figure that had moved would be
    // the one nobody could see.
    automationHasContent(fleet) ||
    !!limits?.fiveHour || !!limits?.sevenDay || !!fleet.rateLimitSources?.some((s) => s.windows.length);
}

/** Whether the loops have anything to report today. One predicate, three readers. */
function automationHasContent(fleet: FleetCost): boolean {
  const auto = fleet.automation;
  return !!auto && (auto.tokensToday > 0 || auto.roles.length > 0);
}

export function compactFleetCost(fleet: FleetCost): string | null {
  if (fleet.estimatedCostToday === null) return "partial";
  return fleet.estimatedCostToday > 0 ? fmtUsd(fleet.estimatedCostToday) : null;
}

/** The dollar-and-token half. Null when the ledger has nothing for today. */
function FleetStats({ fleet }: { fleet: FleetCost }): React.JSX.Element | null {
  if (
    fleet.estimatedCostToday !== null && fleet.estimatedCostToday <= 0 &&
    fleet.estimatedBurnPerHour !== null && fleet.estimatedBurnPerHour <= 0 &&
    fleet.tokensToday <= 0 &&
    !automationHasContent(fleet)
  ) return null;
  const estimated = fleet.estimatedCostToday;
  return (
    <div className="fs-stats">
      {estimated !== null && estimated > 0 &&
        <FleetStat
          n={fmtUsd(estimated)}
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
      {/* `> 0`, matching the daily estimate above rather than merely being non-null. The
          strip's rule is that it never claims a measured zero, and this was the one figure
          that could still print one: an hour with no session usage is not "$0.00/hr spent",
          it is nothing to report. It became visible once the automation line could hold the
          strip open on its own - a fleet whose only spend was the app's own overhead drew a
          confident "$0.00/hr" beside it. */}
      {fleet.estimatedBurnPerHour !== null && fleet.estimatedBurnPerHour > 0 && <FleetStat
        n={fmtUsd(fleet.estimatedBurnPerHour)}
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
          n={fmtUsd(estimated / fleet.prsToday)}
          label="cost / PR"
          tip={
            `${fmtUsd(estimated)} of API-equivalent usage today over ${fleet.prsToday} pull request${fleet.prsToday === 1 ? "" : "s"} your agents opened.\n` +
            `Includes Claude and Codex estimates; counts only PRs we can prove we opened.`
          }
        />
      )}
      <AutomationStat fleet={fleet} />
    </div>
  );
}

/**
 * What the app spent watching the fleet, kept beside the fleet's own figures rather than
 * inside them.
 *
 * A separate stat because it is a different KIND of number, not a smaller one: everything
 * to its left is work an operator asked for, and this is the standing cost of having that
 * work supervised. It moves while nobody is asking for anything, which is exactly why
 * folding it into "estimated cost today" would make that figure untrustworthy - a quiet
 * morning with a busy Inspector would read as fleet activity.
 *
 * Silent until the loops have actually spent. Before this existed the honest answer was
 * unknown rather than zero, and rendering `≈$0.00` for a fleet whose loops are switched off
 * would be the same confident-zero mistake the strip avoids everywhere else.
 *
 * The per-role breakdown lives in the tooltip rather than the strip. Six roles would crowd
 * out the figures beside them, and the headline answers the question people actually ask
 * first ("how much is the overhead?"); the roles answer the follow-up ("which loop?").
 */
function AutomationStat({ fleet }: { fleet: FleetCost }): React.JSX.Element | null {
  const auto = fleet.automation;
  if (!auto || (auto.tokensToday <= 0 && !auto.roles.length)) return null;
  const cost = auto.estimatedCostToday;
  const roles = auto.roles
    .map((r) => {
      const money = r.costUsd === null ? "unpriced" : fmtUsd(r.costUsd);
      return `${spendRoleLabel(r.role)}: ${money} · ${compactTokens(r.tokens)} tok · ${r.runs} run${r.runs === 1 ? "" : "s"}`;
    })
    .join("\n");
  return (
    <FleetStat
      n={cost === null ? "partial" : fmtUsd(cost)}
      label="automation today"
      cost={cost !== null}
      tip={
        `The Foreman's and the Inspector's own model calls since midnight - the app watching your fleet, not the fleet itself.\n` +
        `Counted separately from the figures beside it: this is overhead you did not ask for, and it spends while nothing else is happening.\n\n` +
        `${roles || "No headless runs recorded today."}`
      }
    />
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
