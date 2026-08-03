import { useEffect, useRef, useState } from "react";
import type { FleetCost, RateLimitWindow } from "@shared/types.ts";
import { FIVE_HOUR_MS, SEVEN_DAY_MS, costPerPrToday, projectRunway } from "@shared/cost.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { spendRoleLabel } from "@shared/llm-spend.ts";
import { Tooltip } from "./Tooltip.tsx";
import {
  compactTokens,
  contextTone,
  fmtRunway,
  fmtUsd,
  untilReset,
  type ContextTone,
} from "../lib/format.ts";

/**
 * The fleet's economics, as one chip in the topbar and one popover behind it.
 *
 * This replaces a permanent second topbar row. The figures it carries are consulted
 * occasionally rather than every glance, and a row that is always on screen spends the
 * one piece of chrome every surface below it pays for: `--topbar-h` is measured off the
 * header, so the strip's height came out of every full-height layout in the app, all day,
 * for a number most minutes did not change.
 *
 * So cost becomes a glance plus a drill-down. The chip states today's estimate and its
 * rate, which is the whole of what a glance can act on; everything else the strip showed
 * lives one click away, at a size that can afford labels instead of tooltips.
 *
 * Nothing about the figures themselves changed. `FleetCost` arrives on `cost_fleet`
 * exactly as before, and every degradation rule the strip enforced is enforced here, for
 * the same reason: a surface that prints `$0.00` for a fleet with no telemetry is claiming
 * the fleet was free, and one that divides by zero PRs ships `$Infinity` to the topbar.
 */

/** The chip's own state, once the fleet cost is folded down to what fits on it. */
export interface SpendChipFigures {
  /** What the chip leads with. Never empty while the chip renders at all. */
  lead: string;
  /** The rate beside it, or null when the last hour has nothing to report. */
  rate: string | null;
  /**
   * The quota reading that turned the chip amber or red, e.g. `96%`, or null when nothing
   * has. It REPLACES the rate rather than joining it, and that is the point: without it a
   * red chip is a red dollar figure, which reads as "this is expensive" when it means "a
   * window is about to close". The colour needs the thing it is about on screen beside it.
   */
  alert: string | null;
  /**
   * What the chip colours itself. Returned WITH the figures rather than asked for
   * separately, so the colour and the `alert` beside it come from one read of the clock and
   * one pass over the windows - two reads could, at a boundary, paint a red chip whose
   * segment says the window it is about is fine.
   */
  tone: ContextTone;
  /** The chip's accessible name, which has to carry what the colour and the terse figures do not. */
  label: string;
}

/**
 * Whether there is any spend to show - asked by the topbar before it draws the chip.
 *
 * One predicate rather than a condition per surface: the chip and the popover disagreeing
 * is exactly the bug where a control opens onto nothing. Unchanged from the strip's rule
 * (this is `fleetStripHasContent`, renamed for the surface that now asks it).
 */
export function fleetCostHasContent(fleet: FleetCost | null): boolean {
  if (!fleet) return false;
  const limits = fleet.rateLimits;
  return fleet.estimatedCostToday === null || fleet.estimatedBurnPerHour === null ||
    fleet.estimatedCostToday > 0 || fleet.estimatedBurnPerHour > 0 || fleet.tokensToday > 0 ||
    // A fleet with no live sessions can still have spent: the loops run on their own
    // schedule, and an Inspector reviewing a PR overnight is exactly the case where the
    // chip must not be missing. Without this clause the one figure that had moved would
    // be the one nobody could see.
    automationHasContent(fleet) ||
    !!limits?.fiveHour || !!limits?.sevenDay || !!fleet.rateLimitSources?.some((s) => s.windows.length);
}

/** Whether the loops have anything to report today. One predicate, three readers. */
function automationHasContent(fleet: FleetCost): boolean {
  const auto = fleet.automation;
  return !!auto && (auto.tokensToday > 0 || auto.roles.length > 0);
}

/**
 * What the chip prints, and what it is called.
 *
 * Each segment degrades on its own, the way the strip's stats did. The lead falls back
 * through the figures in order of how much they say: today's estimate, then `partial`
 * when a row was unpriced (never a subtotal presented as the total), then the token count
 * for a fleet whose usage carries no prices at all, and finally the word `Spend` - which
 * is the case where the only content is a rate-limit window and the chip exists purely as
 * the way in to it.
 *
 * An unpriced HOUR prints no rate rather than a second `partial`: two of them on a chip
 * this size is noise, and the popover states which window is incomplete in words.
 */
export function spendChipFigures(fleet: FleetCost): SpendChipFigures {
  const estimated = fleet.estimatedCostToday;
  const burn = fleet.estimatedBurnPerHour;
  const lead = estimated === null
    ? "partial"
    : estimated > 0
      ? `≈${fmtUsd(estimated)}`
      : fleet.tokensToday > 0
        ? `${compactTokens(fleet.tokensToday)} tok`
        : "Spend";
  const rate = burn !== null && burn > 0 ? `${fmtUsd(burn)}/hr` : null;
  const said = estimated === null
    ? "today's estimate is partial"
    : estimated > 0
      ? `about ${fmtUsd(estimated)} estimated today`
      : fleet.tokensToday > 0
        ? `${compactTokens(fleet.tokensToday)} tokens today`
        : "no spend recorded today";
  const worst = worstWindow(fleet);
  const alert = worst && worst.tone !== "ok"
    ? `${Math.round(Math.min(100, Math.max(0, worst.window.usedPercentage)))}%`
    : null;
  const label = [
    `Spend - ${said}`,
    !alert && rate && `${fmtUsd(burn)} per hour`,
    // The tone is a colour, and a colour alone cannot be the only notice that a quota is
    // about to close. The one thing the retired strip had permanently on screen was the
    // runway, so the chip says it out loud rather than only glowing.
    alert && worst && `${worst.label} ${alert} used, ${
      worst.tone === "high" ? "nearly exhausted" : "running low"
    }`,
  ].filter(Boolean).join(", ");
  return { lead, rate, alert, tone: worst?.tone ?? "ok", label };
}

/**
 * The chip's tone, taken from the worst rate-limit window rather than from the dollars.
 *
 * `costTone`'s thresholds are per SESSION and say so (`@shared/cost.ts`: "one session is
 * worth noticing"); a fleet's daily total passes $20 most afternoons, so wiring them to
 * this chip would pin it red by lunchtime and teach the operator that the colour means
 * nothing. The runway is the figure that is actually an alarm - a rate limit arriving
 * mid-task is the surprise the strip existed to prevent - and it is also the one thing
 * that used to be permanently on screen and now is not. So it is what escalates.
 *
 * Same rule per window as the meters inside the popover, from the same helper, so the
 * chip cannot be calm while a bar under it is red.
 *
 * The chip itself does NOT call this - it reads the `tone` that came back with its figures,
 * for the reason on that field. This is the tone on its own, for callers that want only it.
 */
export function spendChipTone(fleet: FleetCost): ContextTone {
  return worstWindow(fleet)?.tone ?? "ok";
}

/**
 * The window in the worst state, with its tone - what the chip colours itself from and
 * names in its own label.
 *
 * The window rather than just the tone, because the chip has to be able to SAY which
 * reading turned it red. A colour whose subject is off screen is a colour that gets read as
 * being about the figure next to it, which here is money.
 */
function worstWindow(
  fleet: FleetCost,
): { label: string; window: RateLimitWindow; tone: ContextTone } | null {
  const ranked = { ok: 0, warn: 1, high: 2 } as const;
  let worst: { label: string; window: RateLimitWindow; tone: ContextTone } | null = null;
  for (const { label, window, windowMs } of rateLimitWindows(fleet)) {
    const tone = runwayTone(window, windowMs);
    if (!worst || ranked[tone] > ranked[worst.tone]) worst = { label, window, tone };
  }
  return worst;
}

/** One meter's tone. A window the current pace does not exhaust is calm at any percentage. */
function runwayTone(window: RateLimitWindow, windowMs: number): ContextTone {
  const runway = projectRunway(window, windowMs, Date.now());
  // `contextTone` rather than a private set of rate-limit thresholds: the amber/red
  // escalation is already defined for the card's context meter, and a second copy of
  // 70/90 would drift the first time one of them was tuned.
  return runway?.clears ? "ok" : contextTone(Math.min(100, Math.max(0, window.usedPercentage)));
}

/**
 * Every quota window we have been told about, flattened into one list with the duration
 * each has to be projected against. Both the chip's tone and the popover's meters read
 * this, so a provider that appears in one appears in the other.
 */
function rateLimitWindows(
  fleet: FleetCost,
): { key: string; label: string; window: RateLimitWindow; windowMs: number }[] {
  const out: { key: string; label: string; window: RateLimitWindow; windowMs: number }[] = [];
  const limits = fleet.rateLimits;
  if (limits?.fiveHour) {
    out.push({ key: "claude:5h", label: "Claude · 5-hr window", window: limits.fiveHour, windowMs: FIVE_HOUR_MS });
  }
  if (limits?.sevenDay) {
    out.push({ key: "claude:7d", label: "Claude · 7-day window", window: limits.sevenDay, windowMs: SEVEN_DAY_MS });
  }
  for (const source of fleet.rateLimitSources ?? []) {
    for (const window of source.windows) {
      out.push({
        key: `${source.source}:${window.id ?? window.label}`,
        label: `${AGENT_IDENTITY[source.source].label} · ${window.label ?? "unknown"} window`,
        window,
        windowMs: (window.durationMinutes ?? 0) * 60_000,
      });
    }
  }
  return out;
}

/**
 * The topbar control: the chip, and the popover mechanics behind it.
 *
 * The popover dismisses itself on a click outside and on Escape, and the Escape STOPS
 * here rather than bubbling to App's global handler (which would collapse the expanded
 * card and drop the fleet selection behind it in the same press). Same contract as the
 * Foreman and Alerts popovers, and pinned by `topbar-popover-dismiss.test.ts` for all
 * three.
 */
export function SpendChip({
  fleet,
  view,
  onOpenCostSettings,
}: {
  fleet: FleetCost | null;
  view: "usd" | "plan";
  onOpenCostSettings: () => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (open && e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // No telemetry at all draws no chip, rather than a `$0.00` claiming a measured zero.
  // Cost is configured in Settings, which is where an operator who wants it goes.
  if (!fleetCostHasContent(fleet) || !fleet) return null;
  const { lead, rate, alert, tone, label } = spendChipFigures(fleet);

  return (
    <div className="spend-chip-wrap" ref={ref}>
      {/* Deliberately ONE short line. The tooltip bubble is `position: fixed` at
          `z-index: 100` and the trigger sits within the flip threshold of the viewport top,
          so it opens DOWNWARD - directly over the popover this button opens, for as long as
          the pointer or focus rests here. A paragraph listing the popover's own contents
          would sit on top of them; one line clears the panel's heading and nothing else. */}
      <Tooltip label="Today's estimated fleet spend - open for the breakdown">
        <button
          type="button"
          className="spend-chip"
          data-tone={tone}
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="spend-chip-lead">{lead}</span>
          {/* One trailing segment, and which one it is says what the chip is currently
              about. Calm: the rate, which is redundant with the popover's second row and is
              the first thing the responsive ladder takes back when the bar runs out of
              room. Escalated: the quota reading instead, which is not redundant with
              anything on screen and survives every rung - it is the whole reason the chip
              is not purple. */}
          {alert
            ? <span className="spend-chip-alert">· {alert}</span>
            : rate && <span className="spend-chip-rate">· {rate}</span>}
          <span className="spend-chip-caret" aria-hidden>
            ▾
          </span>
        </button>
      </Tooltip>
      {open && (
        <SpendPanel
          fleet={fleet}
          view={view}
          onOpenCostSettings={onOpenCostSettings}
          onDismiss={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The popover: every figure the retired strip carried, at a size that can label them.
 *
 * `view` picks which half LEADS, not which exists, exactly as it did on the strip. On a
 * Pro/Max plan the dollars are notional and the percentage is the real constraint, so
 * `plan` puts the windows first.
 *
 * Presentational and fully driven by props, so every state can be rendered and asserted
 * with `renderToStaticMarkup`, with no DOM and no popover to open first.
 */
export function SpendPanel({
  fleet,
  view,
  onOpenCostSettings,
  onDismiss,
}: {
  fleet: FleetCost | null;
  view: "usd" | "plan";
  onOpenCostSettings: () => void;
  /** Close the popover. Optional so the panel can be rendered on its own in a test. */
  onDismiss?: () => void;
}): React.JSX.Element | null {
  if (!fleetCostHasContent(fleet) || !fleet) return null;
  // The footer link navigates away, so it also has to close what it is leaving: a popover
  // still hanging over the Cost panel it just opened is a menu that outlived its page.
  const onOpenSettings = (): void => {
    onDismiss?.();
    onOpenCostSettings();
  };
  const stats = <SpendStats key="stats" fleet={fleet} />;
  const windows = <SpendWindows key="windows" fleet={fleet} />;
  return (
    <div className="spend-pop" role="dialog" aria-label="Spend today">
      <h2 className="spend-pop-head">Spend · today</h2>
      {view === "plan" ? [windows, stats] : [stats, windows]}
      <div className="spend-foot">
        {/* The disclaimer the strip kept in five separate tooltips. It is one sentence
            and it applies to every figure above, so it is said once, in the open. */}
        <span>API-equivalent estimates, not an invoice</span>
        <Tooltip label="Settings · Cost - switch Claude's telemetry on or off, and choose whether this popover leads with the dollars or the plan windows">
          <button type="button" className="spend-config-link" onClick={onOpenSettings}>
            Cost settings →
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * The dollar-and-token half. Null when the ledger has nothing for today, so a fleet whose
 * only content is a quota window shows the meters alone rather than a block of dashes.
 *
 * A row per figure, each gated on its OWN rule rather than on the block's: an unpriced
 * hour, a morning with no PRs and a fleet whose only spend is the app's own overhead are
 * three different states, and each has to be able to go quiet without silencing the rest.
 */
function SpendStats({ fleet }: { fleet: FleetCost }): React.JSX.Element | null {
  if (
    fleet.estimatedCostToday !== null && fleet.estimatedCostToday <= 0 &&
    fleet.estimatedBurnPerHour !== null && fleet.estimatedBurnPerHour <= 0 &&
    fleet.tokensToday <= 0 &&
    !automationHasContent(fleet)
  ) return null;
  const estimated = fleet.estimatedCostToday;
  const perPr = costPerPrToday(fleet);
  return (
    <div className="spend-rows">
      {estimated !== null && estimated > 0 && (
        <SpendRow
          k="Fleet today"
          v={`≈${fmtUsd(estimated)}`}
          cost
          tip={`${fmtUsd(estimated)} of API-equivalent usage since midnight. Claude Code calculates its rows; Mission Control calculates Codex rows from a versioned Standard API price snapshot. This is not subscription spend or an invoice.`}
        />
      )}
      {estimated === null && (
        <SpendRow
          k="Fleet today"
          v="partial"
          tip="At least one usage row has no verified model price, so Mission Control will not present the known subtotal as a complete fleet estimate. Tokens remain complete."
        />
      )}
      {/* `> 0`, matching the daily estimate above rather than merely being non-null. The
          rule is that this surface never claims a measured zero, and this was the one
          figure that could still print one: an hour with no session usage is not
          "$0.00/hr spent", it is nothing to report. */}
      {fleet.estimatedBurnPerHour !== null && fleet.estimatedBurnPerHour > 0 && (
        <SpendRow
          k="Rate now"
          v={`${fmtUsd(fleet.estimatedBurnPerHour)}/hr`}
          tip={`${fmtUsd(fleet.estimatedBurnPerHour)} of API-equivalent usage in the last hour; not actual subscription spend.`}
        />
      )}
      {fleet.estimatedBurnPerHour === null && (
        <SpendRow
          k="Rate now"
          v="partial"
          tip="At least one usage row in the last hour has no verified model price, so Mission Control will not present the known subtotal as a complete recent rate."
        />
      )}
      {fleet.tokensToday > 0 && (
        <SpendRow
          k="Tokens today"
          v={compactTokens(fleet.tokensToday)}
          tip={`${fleet.tokensToday.toLocaleString("en-US")} tokens since midnight - input, output and cache, every tier summed.`}
        />
      )}
      {/* Divided by `costPerPrToday` rather than here, because the Ship log's KPI prints
          the same figure and the two must not disagree about when it can be printed at
          all - the refusals (unpriced usage, a day with no adoptions) are the interesting
          half of that fold. */}
      {perPr !== null && (
        <SpendRow
          k="Per shipped PR"
          v={`≈${fmtUsd(perPr)}`}
          sub={`· ${fleet.prsToday} today`}
          cost
          tip={
            `${fmtUsd(estimated)} of API-equivalent usage today over ${fleet.prsToday} pull request${fleet.prsToday === 1 ? "" : "s"} your agents opened.\n` +
            `Includes Claude and Codex estimates; counts only PRs we can prove we opened.`
          }
        />
      )}
      <AutomationRow fleet={fleet} />
    </div>
  );
}

/**
 * What the app spent watching the fleet, kept beside the fleet's own figures rather than
 * inside them.
 *
 * A separate line because it is a different KIND of number, not a smaller one: everything
 * above it is work an operator asked for, and this is the standing cost of having that
 * work supervised. It moves while nobody is asking for anything, which is exactly why
 * folding it into "Fleet today" would make that figure untrustworthy - a quiet morning
 * with a busy Inspector would read as fleet activity.
 *
 * Silent until the loops have actually spent. Rendering `≈$0.00` for a fleet whose loops
 * are switched off would be the same confident-zero mistake this surface avoids everywhere
 * else.
 *
 * The per-role split is printed rather than hidden in the tooltip it used to live in: the
 * strip had five figures competing for one row and no room for six more, and a popover has
 * room for the follow-up question ("which loop?") right under the answer to the first one.
 */
function AutomationRow({ fleet }: { fleet: FleetCost }): React.JSX.Element | null {
  const auto = fleet.automation;
  if (!auto || (auto.tokensToday <= 0 && !auto.roles.length)) return null;
  const cost = auto.estimatedCostToday;
  const roles = auto.roles
    .map((r) => `${spendRoleLabel(r.role)} ${r.costUsd === null ? "unpriced" : fmtUsd(r.costUsd)}`)
    .join(" · ");
  return (
    <>
      <SpendRow
        k="Automation"
        v={cost === null ? "partial" : `≈${fmtUsd(cost)}`}
        automation
        cost={cost !== null}
        tip={
          `The Foreman's and the Inspector's own model calls since midnight - the app watching your fleet, not the fleet itself.\n` +
          `Counted separately from the figures beside it: this is overhead you did not ask for, and it spends while nothing else is happening.\n\n` +
          auto.roles
            .map((r) => {
              const money = r.costUsd === null ? "unpriced" : fmtUsd(r.costUsd);
              return `${spendRoleLabel(r.role)}: ${money} · ${compactTokens(r.tokens)} tok · ${r.runs} run${r.runs === 1 ? "" : "s"}`;
            })
            .join("\n") || "No headless runs recorded today."
        }
      />
      {roles && <p className="spend-sub">{roles}</p>}
    </>
  );
}

/** The rate-limit half: one runway per window we have been told about. */
function SpendWindows({ fleet }: { fleet: FleetCost }): React.JSX.Element | null {
  const windows = rateLimitWindows(fleet);
  if (!windows.length) return null;
  return (
    <div className="spend-runways">
      <span className="spend-sec">Rate-limit runway</span>
      {windows.map(({ key, label, window, windowMs }) => (
        <Runway key={key} window={window} windowMs={windowMs} label={label} />
      ))}
    </div>
  );
}

/**
 * One rate-limit window: how much of it is gone, and how long the rest lasts.
 *
 * The bar is consumption (a fact the provider sent us) and the figure beside the label is
 * the projection (ours, and marked with a `~`). Keeping them in one block is the point:
 * "74% used" and "about 41 minutes left" are the same sentence, and separating them is how
 * you get someone reading a comfortable percentage an hour before it stops being one. The
 * strip could only afford one of the two on its face and pushed the other into a tooltip;
 * this states both.
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
  const headline = `${Math.round(pct)}%${runway ? ` · ${runway.clears ? "clears" : fmtRunway(runway.ms)}` : ""}`;
  const tip =
    `${Math.round(window.usedPercentage)}% used, resets ${untilReset(window.resetsAt)}.\n` +
    (!runway
      ? `Not enough of the window has been spent to project a runway.`
      : runway.clears
        ? `At this rate the window resets before you exhaust it.`
        : `At this rate it is exhausted in ${fmtRunway(runway.ms).replace("~", "about ")}.`);
  return (
    <Tooltip label={tip}>
      <div className="spend-runway" data-tone={runwayTone(window, windowMs)}>
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

/** One labelled figure, the popover's unit of layout. */
function SpendRow({
  k,
  v,
  sub,
  cost,
  automation,
  tip,
}: {
  k: string;
  v: string;
  /** A qualifier the figure is meaningless without, e.g. the PRs it was divided by. */
  sub?: string;
  cost?: boolean;
  automation?: boolean;
  tip: string;
}): React.JSX.Element {
  return (
    <Tooltip label={tip}>
      <div className={`spend-row${automation ? " is-automation" : ""}`}>
        <span className="spend-k">{k}</span>
        <span className={`spend-v${cost ? " spend-v-cost" : ""}`}>
          {v}
          {sub && <small>{sub}</small>}
        </span>
      </div>
    </Tooltip>
  );
}
