import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  compactFleetCost,
  FleetStrip,
  fleetStripHasContent,
} from "../src/web/components/FleetStrip.tsx";
import { FIVE_HOUR_MS, SEVEN_DAY_MS, projectRunway } from "../src/shared/cost.ts";
import { fmtRunway } from "../src/web/lib/format.ts";
import type { FleetCost, RateLimitWindow } from "../src/shared/types.ts";

/**
 * The fleet strip is the one surface in the app that makes a CLAIM ABOUT THE FUTURE, and
 * every figure on it is either a fact we were handed or a division of two of them. Both
 * halves are easy to get quietly wrong:
 *
 * - The runway is a projection. A wrong one is worse than none: someone reads "2h left",
 *   plans a long task around it, and the window closes in twenty minutes. So the math is
 *   pinned here against hand-computed windows, and every case where there is nothing to
 *   project from has to come back null rather than optimistic.
 * - Cost-per-PR is a division whose denominator is legitimately zero most mornings, and
 *   `$Infinity` in the topbar is the kind of thing that ships.
 *
 * And the degradation rules are the feature, not politeness: a strip that renders `$0.00`
 * for a fleet that has no telemetry at all is claiming the fleet was free.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** A window that resets `msFromNow` from NOW, with `used` percent already spent. */
function win(used: number, msFromNow: number): RateLimitWindow {
  return { usedPercentage: used, resetsAt: (NOW + msFromNow) / 1000 };
}

function fleet(over: Partial<FleetCost> = {}): FleetCost {
  return {
    estimatedCostToday: 14.82,
    estimatedBurnPerHour: 6.1,
    tokensToday: 21_400_000,
    prsToday: 6,
    rateLimits: null,
    // The default is a fleet whose loops have not spent today, so every existing case here
    // keeps asserting about session figures alone. The automation line has its own cases.
    automation: { estimatedCostToday: 0, tokensToday: 0, roles: [] },
    updatedAt: NOW,
    ...over,
  };
}

function render(f: FleetCost, view: "usd" | "plan" = "usd"): string {
  return renderToStaticMarkup(createElement(FleetStrip, { fleet: f, view }));
}

// ---- the projection ----

test("a window spent at exactly its own pace lasts precisely until it resets", () => {
  // Half the window gone, half of it spent: the rate lands on the reset, not before it.
  const r = projectRunway(win(50, 2.5 * HOUR), FIVE_HOUR_MS, NOW);
  assert.ok(r);
  assert.equal(r.clears, true);
  assert.equal(Math.round(r.ms / 60_000), 150);
});

test("a window spent faster than it refills reports the wall, not the reset", () => {
  // 80% gone with 2.5h still on the clock: 20% left at 32%/h is another ~37 minutes.
  const r = projectRunway(win(80, 2.5 * HOUR), FIVE_HOUR_MS, NOW);
  assert.ok(r);
  assert.equal(r.clears, false);
  assert.equal(Math.round(r.ms / 60_000), 38);
  // The projection can never exceed the window it is projecting inside.
  assert.ok(r.ms < 2.5 * HOUR);
});

test("a window nobody has touched projects nothing rather than an infinite runway", () => {
  assert.equal(projectRunway(win(0, 4 * HOUR), FIVE_HOUR_MS, NOW), null);
});

test("an already-exhausted window reads as spent, not as a fresh projection", () => {
  const r = projectRunway(win(100, 1 * HOUR), FIVE_HOUR_MS, NOW);
  assert.deepEqual(r, { ms: 0, clears: false });
  assert.equal(fmtRunway(0), "spent");
});

test("a reading whose window has already rolled over is not projected from", () => {
  // A stale gauge: `resetsAt` in the past means the percentage describes a window that
  // no longer exists, and extrapolating it would age-forward a dead number.
  assert.equal(projectRunway(win(70, -HOUR), FIVE_HOUR_MS, NOW), null);
  // Same for a reading from before the window could have opened (clock skew).
  assert.equal(projectRunway(win(70, FIVE_HOUR_MS + HOUR), FIVE_HOUR_MS, NOW), null);
});

test("the seven-day window is projected against seven days, not five hours", () => {
  const w = win(50, 3.5 * 24 * HOUR);
  assert.equal(projectRunway(w, SEVEN_DAY_MS, NOW)?.clears, true);
  // Handed the wrong window length the same reading reads as already blown - which is
  // why the length is a parameter and not a constant inside the projection.
  assert.equal(projectRunway(w, FIVE_HOUR_MS, NOW), null);
});

test("runways are formatted as approximations, and a sub-minute one still reads as time", () => {
  assert.equal(fmtRunway(41 * 60_000), "~41 min");
  assert.equal(fmtRunway(130 * 60_000), "~2h 10m");
  assert.equal(fmtRunway(120 * 60_000), "~2h");
  assert.equal(fmtRunway(20_000), "<1 min");
});

// ---- what the strip will and will not claim ----

test("no telemetry at all draws no strip - not a fleet that cost nothing", () => {
  const empty = fleet({ estimatedCostToday: 0, estimatedBurnPerHour: 0, tokensToday: 0, prsToday: 0 });
  assert.equal(fleetStripHasContent(empty), false);
  assert.equal(fleetStripHasContent(null), false);
  assert.equal(render(empty), "");
});

test("the loops' own spend draws the strip even when no session has cost anything", () => {
  // The case that matters most for this figure: nobody is working, and the Inspector has
  // been reviewing a PR all night. Before it was attributed, the one number that had moved
  // was the one nothing could show.
  const f = fleet({
    estimatedCostToday: 0,
    estimatedBurnPerHour: 0,
    tokensToday: 0,
    prsToday: 0,
    automation: {
      estimatedCostToday: 2.4,
      tokensToday: 1_200_000,
      roles: [{ role: "inspector:review", costUsd: 2.4, tokens: 1_200_000, runs: 6 }],
    },
  });
  const html = render(f);
  assert.equal(fleetStripHasContent(f), true);
  assert.ok(html.includes("automation today"));
  assert.ok(html.includes("$2.40"));
  // Named by role in the tooltip, so "which loop" is answerable without leaving the strip.
  assert.ok(html.includes("Inspector review"));
  assert.ok(html.includes("6 runs"));
});

test("automation spend is never folded into the fleet's own figures", () => {
  // The product decision, asserted: two lines, each independently true. A reader adding
  // them gets the total; a reader looking at "estimated cost today" gets only the work
  // they asked for.
  const html = render(fleet({
    estimatedCostToday: 10,
    automation: {
      estimatedCostToday: 4,
      tokensToday: 900,
      roles: [{ role: "foreman:review", costUsd: 4, tokens: 900, runs: 2 }],
    },
  }));
  assert.ok(html.includes("$10.00"), "the fleet figure is the session figure alone");
  assert.ok(html.includes("$4.00"), "and the overhead is stated beside it");
  assert.ok(!html.includes("$14.00"));
});

test("a fleet whose only spend is the app's own draws no zeroed session figures", () => {
  // The regression the runtime capture caught: once automation could hold the strip open
  // by itself, the rate stat printed a confident "$0.00/hr" next to it for a fleet that had
  // simply done nothing. Zero spent is not a rate worth stating.
  const html = render(fleet({
    estimatedCostToday: 0,
    estimatedBurnPerHour: 0,
    tokensToday: 0,
    prsToday: 0,
    automation: {
      estimatedCostToday: 9.7,
      tokensToday: 2_089_000,
      roles: [{ role: "inspector:review", costUsd: 5.56, tokens: 1_125_000, runs: 1 }],
    },
  }));
  assert.ok(html.includes("automation today"));
  assert.ok(!html.includes("estimated rate"));
  assert.ok(!html.includes("$0.00"));
});

test("a loop that has not run today adds nothing to the strip", () => {
  // Silence rather than a confident zero, the same rule the rest of the strip follows.
  const html = render(fleet({ automation: { estimatedCostToday: 0, tokensToday: 0, roles: [] } }));
  assert.ok(!html.includes("automation today"));
});

test("an unpriced automation model reads as partial rather than as cheap", () => {
  const html = render(fleet({
    automation: {
      estimatedCostToday: null,
      tokensToday: 5_000,
      roles: [{ role: "foreman:triage", costUsd: null, tokens: 5_000, runs: 1 }],
    },
  }));
  assert.ok(html.includes("automation today"));
  assert.ok(html.includes("partial"));
  assert.ok(html.includes("unpriced"));
});

test("rate limits alone are enough to draw the strip, with no dollar figures on it", () => {
  const f = fleet({ estimatedCostToday: 0, prsToday: 0, rateLimits: { fiveHour: win(40, 3 * HOUR), sevenDay: null, updatedAt: NOW } });
  const html = render(f);
  assert.equal(fleetStripHasContent(f), true);
  assert.ok(html.includes("5-hr limit runway"));
  assert.ok(!html.includes("spend today"));
});

test("Codex-only usage renders the same unified estimate and cost per PR", () => {
  const f = fleet({
    estimatedCostToday: 3.25,
    estimatedBurnPerHour: 0.75,
    prsToday: 2,
  });
  const html = render(f);
  assert.equal(fleetStripHasContent(f), true);
  assert.ok(html.includes("estimated cost today"));
  assert.ok(html.includes("$3.25"));
  assert.ok(html.includes("tokens today"));
  assert.ok(html.includes("cost / PR"));
  assert.ok(html.includes("$1.63"));
  assert.ok(!html.includes("≈"));
});

test("unpriced usage exposes a partial estimate instead of understating the fleet", () => {
  const html = render(fleet({ estimatedCostToday: null, estimatedBurnPerHour: null }));
  assert.ok(html.includes("partial"));
  assert.ok(html.includes("tokens today"));
  assert.ok(!html.includes("cost / PR"));
});

test("daily and recent cost windows report completeness independently", () => {
  const partialDay = render(fleet({ estimatedCostToday: null, estimatedBurnPerHour: 0.75 }));
  assert.ok(partialDay.includes("cost estimate"));
  assert.ok(partialDay.includes("estimated rate"));
  assert.ok(partialDay.includes("$0.75"));

  const partialHour = render(fleet({ estimatedCostToday: 3.25, estimatedBurnPerHour: null }));
  assert.ok(partialHour.includes("$3.25"));
  assert.ok(partialHour.includes("estimated rate"));
  assert.ok(partialHour.includes("partial"));
});

test("recent usage alone is enough to draw the independent rate window", () => {
  const f = fleet({ estimatedCostToday: 0, estimatedBurnPerHour: 0.75, tokensToday: 0, prsToday: 0 });
  assert.equal(fleetStripHasContent(f), true);
  assert.ok(render(f).includes("$0.75"));
});

test("collapsed fleet cost preserves an unpriced daily window", () => {
  assert.equal(compactFleetCost(fleet({ estimatedCostToday: null })), "partial");
  assert.equal(compactFleetCost(fleet({ estimatedCostToday: 3.25 })), "$3.25");
  assert.equal(compactFleetCost(fleet({ estimatedCostToday: 0 })), null);
});

test("Claude and Codex quota windows render independently with their own durations", () => {
  const f = fleet({
    rateLimits: { fiveHour: win(40, 3 * HOUR), sevenDay: null, updatedAt: NOW },
    rateLimitSources: [{
      source: "codex", updatedAt: NOW,
      windows: [{ ...win(9, 6 * 24 * HOUR), id: "primary", label: "1-week", durationMinutes: 10080 }],
    }],
  });
  const html = render(f);
  assert.ok(html.includes("Claude · 5-hr limit runway"));
  assert.ok(html.includes("Codex · 1-week limit runway"));
});

test("no PRs opened today means no cost-per-PR, rather than a division by zero", () => {
  const html = render(fleet({ prsToday: 0 }));
  assert.ok(!html.includes("cost / PR"));
  assert.ok(!html.includes("Infinity"));
  assert.ok(html.includes("estimated cost today"));
});

test("cost per PR divides today's unified estimate by today's proven PRs", () => {
  // $14.82 over 6 pull requests.
  assert.ok(render(fleet({ estimatedCostToday: 14.82, prsToday: 6 })).includes("$2.47"));
});

test("every figure the strip promises is on it", () => {
  const html = render(fleet({ rateLimits: { fiveHour: win(74, 40 * 60_000), sevenDay: null, updatedAt: NOW } }));
  for (const label of ["estimated cost today", "estimated rate", "tokens today", "cost / PR"]) {
    assert.ok(html.includes(label), `missing ${label}`);
  }
  assert.ok(html.includes("$14.82"));
  assert.ok(html.includes("/hr"));
  assert.ok(html.includes("21.4M"));
});

test("a window with no reading renders nothing rather than a bar at zero", () => {
  const html = render(fleet({ rateLimits: { fiveHour: null, sevenDay: null, updatedAt: NOW } }));
  assert.ok(!html.includes("runway"));
});

test("the plan view leads with the windows; the usd view leads with the dollars", () => {
  const f = fleet({ rateLimits: { fiveHour: win(60, 2 * HOUR), sevenDay: null, updatedAt: NOW } });
  const usd = render(f, "usd");
  const plan = render(f, "plan");
  assert.ok(usd.indexOf("fs-stats") < usd.indexOf("fs-windows"));
  assert.ok(plan.indexOf("fs-windows") < plan.indexOf("fs-stats"));
});

test("the runway bar's gradient is scaled to the track, not to the fill", () => {
  // --pct carries the fill's own width so the stylesheet can stretch the gradient back
  // out; without it the colour under the bar's tip would mean a different thing at every
  // width. Floored at 1 because the stylesheet divides by it.
  const f = fleet({ rateLimits: { fiveHour: win(74, 2 * HOUR), sevenDay: null, updatedAt: NOW } });
  assert.ok(render(f).includes("--pct:74"));
  const zero = fleet({ rateLimits: { fiveHour: win(0, 2 * HOUR), sevenDay: null, updatedAt: NOW } });
  assert.ok(render(zero).includes("--pct:1"));
});
