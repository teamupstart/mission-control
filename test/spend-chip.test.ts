import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fleetCostHasContent,
  spendChipFigures,
  spendChipTone,
  SpendPanel,
} from "../src/web/components/SpendChip.tsx";
import { FIVE_HOUR_MS, SEVEN_DAY_MS, projectRunway } from "../src/shared/cost.ts";
import { fmtRunway } from "../src/web/lib/format.ts";
import type { FleetCost, RateLimitWindow } from "../src/shared/types.ts";

/**
 * The topbar's cost surface is the one place in the app that makes a CLAIM ABOUT THE
 * FUTURE, and every figure on it is either a fact we were handed or a division of two of
 * them. Both halves are easy to get quietly wrong:
 *
 * - The runway is a projection. A wrong one is worse than none: someone reads "2h left",
 *   plans a long task around it, and the window closes in twenty minutes. So the math is
 *   pinned here against hand-computed windows, and every case where there is nothing to
 *   project from has to come back null rather than optimistic.
 * - Cost-per-PR is a division whose denominator is legitimately zero most mornings, and
 *   `$Infinity` in the topbar is the kind of thing that ships.
 *
 * And the degradation rules are the feature, not politeness: a surface that renders `$0.00`
 * for a fleet that has no telemetry at all is claiming the fleet was free.
 *
 * Moving those figures out of a permanent row and into a popover made one more thing
 * checkable here: the CHIP, which is now all most glances see. It must never be blank while
 * there is content behind it, it must say in words what its colour says in purple, and it
 * must not borrow the per-session cost thresholds that would pin it red every afternoon.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** A window that resets `msFromNow` from NOW, with `used` percent already spent. */
function win(used: number, msFromNow: number): RateLimitWindow {
  return { usedPercentage: used, resetsAt: (NOW + msFromNow) / 1000 };
}

/**
 * The same window anchored to the REAL clock, for the cases that go through a component.
 *
 * `projectRunway` takes `now` as an argument, so the pure tests below pin it to the fixed
 * `NOW`; every render calls it with `Date.now()`, and a window built against `NOW` has
 * therefore been over for years by the time one is drawn. Two helpers rather than one, so
 * which clock a case is on is visible at the call site.
 */
function liveWin(used: number, msFromNow: number): RateLimitWindow {
  return { usedPercentage: used, resetsAt: (Date.now() + msFromNow) / 1000 };
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
  return renderToStaticMarkup(
    createElement(SpendPanel, { fleet: f, view, onOpenCostSettings: () => {} }),
  );
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

// ---- what the chip will and will not claim ----

test("no telemetry at all draws no chip and no popover - not a fleet that cost nothing", () => {
  const empty = fleet({ estimatedCostToday: 0, estimatedBurnPerHour: 0, tokensToday: 0, prsToday: 0 });
  assert.equal(fleetCostHasContent(empty), false);
  assert.equal(fleetCostHasContent(null), false);
  assert.equal(render(empty), "");
});

test("the chip leads with today's estimate and states the rate beside it", () => {
  const { lead, rate } = spendChipFigures(fleet());
  assert.equal(lead, "≈$14.82");
  assert.equal(rate, "$6.10/hr");
});

test("an unpriced day reads as partial on the chip, never as a smaller total", () => {
  assert.equal(spendChipFigures(fleet({ estimatedCostToday: null })).lead, "partial");
});

test("an unpriced hour prints no rate rather than a second `partial` on one chip", () => {
  const { lead, rate } = spendChipFigures(fleet({ estimatedBurnPerHour: null }));
  assert.equal(lead, "≈$14.82");
  assert.equal(rate, null);
  // The popover is where the incomplete window is actually named.
  assert.ok(render(fleet({ estimatedBurnPerHour: null })).includes("partial"));
});

test("a fleet with tokens but no prices still puts a figure on the chip", () => {
  // Every price unverified is not the same as no usage: the measured work is still a fact.
  const { lead } = spendChipFigures(
    fleet({ estimatedCostToday: 0, estimatedBurnPerHour: 0, tokensToday: 8_400_000, prsToday: 0 }),
  );
  assert.equal(lead, "8.4M tok");
});

test("a fleet whose only content is a quota window still has a chip to open", () => {
  // The chip is the ONLY way into the runway meters now, so it cannot render blank when
  // the runway is the one thing there is to see.
  const f = fleet({
    estimatedCostToday: 0,
    estimatedBurnPerHour: 0,
    tokensToday: 0,
    prsToday: 0,
    rateLimits: { fiveHour: win(40, 3 * HOUR), sevenDay: null, updatedAt: NOW },
  });
  assert.equal(fleetCostHasContent(f), true);
  assert.equal(spendChipFigures(f).lead, "Spend");
  assert.equal(spendChipFigures(f).rate, null);
});

test("the chip's accessible name carries both figures, not just the colour", () => {
  const { label } = spendChipFigures(fleet());
  assert.ok(label.includes("$14.82"));
  assert.ok(label.includes("$6.10 per hour"));
});

// ---- the chip's tone ----

test("a fleet total does not escalate the chip, however large it gets", () => {
  // The whole reason `costTone` is not wired here: its thresholds are per SESSION ($5/$20),
  // and a fleet clears them by lunchtime. A chip that is red every afternoon is a chip
  // nobody reads.
  assert.equal(spendChipTone(fleet({ estimatedCostToday: 480 })), "ok");
});

test("a quota window running out is what turns the chip amber, then red", () => {
  const calm = fleet({ rateLimits: { fiveHour: liveWin(40, 3 * HOUR), sevenDay: null, updatedAt: NOW } });
  const warn = fleet({ rateLimits: { fiveHour: liveWin(74, 2 * HOUR), sevenDay: null, updatedAt: NOW } });
  const high = fleet({ rateLimits: { fiveHour: liveWin(96, 20 * 60_000), sevenDay: null, updatedAt: NOW } });
  assert.equal(spendChipTone(calm), "ok");
  assert.equal(spendChipTone(warn), "warn");
  assert.equal(spendChipTone(high), "high");
  // And it says so in words, because a colour cannot be the only notice - naming the window
  // it is about, so a red chip is never read as a comment on the money beside it.
  assert.ok(spendChipFigures(high).label.includes("Claude · 5-hr window 96% used"));
  assert.ok(spendChipFigures(high).label.includes("nearly exhausted"));
  assert.ok(spendChipFigures(warn).label.includes("running low"));
});

test("an escalated chip trades its rate for the reading that escalated it", () => {
  // A red `≈$14.82 · $6.10/hr` says "this is expensive". It means "a window is about to
  // close", and the only way the colour can say that is if its subject is on the chip.
  const high = fleet({ rateLimits: { fiveHour: liveWin(96, 20 * 60_000), sevenDay: null, updatedAt: NOW } });
  const { alert, rate, tone } = spendChipFigures(high);
  assert.equal(alert, "96%");
  // The tone rides along with the figures rather than being asked for separately, so the
  // colour and the segment it colours can never come from two different reads of the clock.
  assert.equal(tone, "high");
  assert.equal(tone, spendChipTone(high));
  // The rate is still computed - the popover prints it - but the chip yields the slot.
  assert.equal(rate, "$6.10/hr");
  // A calm fleet has nothing to warn about and keeps the rate on its face.
  assert.equal(spendChipFigures(fleet()).alert, null);
});

test("a window the current pace does not exhaust leaves the chip calm", () => {
  // 74% gone - amber by percentage alone - but four fifths of the window has already run,
  // so the reset arrives before the wall does. `clears` outranks the percentage, exactly as
  // it does on the meter, or the chip would cry wolf every time a window neared its end.
  const f = fleet({
    rateLimits: { fiveHour: liveWin(74, 1 * HOUR), sevenDay: null, updatedAt: NOW },
  });
  assert.equal(spendChipTone(f), "ok");
});

test("the worst window sets the tone, whichever provider it belongs to", () => {
  const f = fleet({
    rateLimits: { fiveHour: liveWin(20, 4 * HOUR), sevenDay: null, updatedAt: NOW },
    rateLimitSources: [{
      source: "codex",
      updatedAt: NOW,
      windows: [{ ...liveWin(95, 30 * 60_000), id: "primary", label: "5h", durationMinutes: 300 }],
    }],
  });
  assert.equal(spendChipTone(f), "high");
});

// ---- what the popover carries ----

test("every figure the retired strip promised is in the popover", () => {
  const html = render(fleet({ rateLimits: { fiveHour: win(74, 40 * 60_000), sevenDay: null, updatedAt: NOW } }));
  for (const label of ["Fleet today", "Rate now", "Tokens today", "Per shipped PR"]) {
    assert.ok(html.includes(label), `missing ${label}`);
  }
  assert.ok(html.includes("$14.82"));
  assert.ok(html.includes("/hr"));
  assert.ok(html.includes("21.4M"));
  assert.ok(html.includes("Rate-limit runway"));
  // And the way to the setting that configures all of it.
  assert.ok(html.includes("Cost settings"));
});

test("the popover is a labelled dialog, so a screen reader is told what opened", () => {
  const html = render(fleet());
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('aria-label="Spend today"'));
});

test("the loops' own spend opens the popover even when no session has cost anything", () => {
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
  assert.equal(fleetCostHasContent(f), true);
  assert.ok(html.includes("Automation"));
  assert.ok(html.includes("$2.40"));
  // Named by role, and now printed rather than buried in the tooltip the strip had to use.
  assert.ok(html.includes("Inspector review"));
  assert.ok(html.includes("6 runs"));
});

test("automation spend is never folded into the fleet's own figures", () => {
  // The product decision, asserted: two lines, each independently true. A reader adding
  // them gets the total; a reader looking at "Fleet today" gets only the work they asked for.
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
  // The regression the runtime capture caught: once automation could hold the surface open
  // by itself, the rate printed a confident "$0.00/hr" next to it for a fleet that had
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
  assert.ok(html.includes("Automation"));
  assert.ok(!html.includes("Rate now"));
  assert.ok(!html.includes("$0.00"));
});

test("a loop that has not run today adds nothing to the popover", () => {
  // Silence rather than a confident zero, the same rule the rest of the surface follows.
  const html = render(fleet({ automation: { estimatedCostToday: 0, tokensToday: 0, roles: [] } }));
  assert.ok(!html.includes("Automation"));
});

test("an unpriced automation model reads as partial rather than as cheap", () => {
  const html = render(fleet({
    automation: {
      estimatedCostToday: null,
      tokensToday: 5_000,
      roles: [{ role: "foreman:triage", costUsd: null, tokens: 5_000, runs: 1 }],
    },
  }));
  assert.ok(html.includes("Automation"));
  assert.ok(html.includes("partial"));
  assert.ok(html.includes("unpriced"));
});

test("rate limits alone are enough to draw the popover, with no dollar figures on it", () => {
  const f = fleet({ estimatedCostToday: 0, prsToday: 0, rateLimits: { fiveHour: win(40, 3 * HOUR), sevenDay: null, updatedAt: NOW } });
  const html = render(f);
  assert.equal(fleetCostHasContent(f), true);
  assert.ok(html.includes("Claude · 5-hr window"));
  assert.ok(!html.includes("Fleet today"));
});

test("Codex-only usage renders the same unified estimate and cost per PR", () => {
  const f = fleet({
    estimatedCostToday: 3.25,
    estimatedBurnPerHour: 0.75,
    prsToday: 2,
  });
  const html = render(f);
  assert.equal(fleetCostHasContent(f), true);
  assert.ok(html.includes("Fleet today"));
  assert.ok(html.includes("$3.25"));
  assert.ok(html.includes("Tokens today"));
  assert.ok(html.includes("Per shipped PR"));
  assert.ok(html.includes("$1.63"));
});

test("unpriced usage exposes a partial estimate instead of understating the fleet", () => {
  const html = render(fleet({ estimatedCostToday: null, estimatedBurnPerHour: null }));
  assert.ok(html.includes("partial"));
  assert.ok(html.includes("Tokens today"));
  assert.ok(!html.includes("Per shipped PR"));
});

test("daily and recent cost windows report completeness independently", () => {
  const partialDay = render(fleet({ estimatedCostToday: null, estimatedBurnPerHour: 0.75 }));
  assert.ok(partialDay.includes("Fleet today"));
  assert.ok(partialDay.includes("Rate now"));
  assert.ok(partialDay.includes("$0.75"));

  const partialHour = render(fleet({ estimatedCostToday: 3.25, estimatedBurnPerHour: null }));
  assert.ok(partialHour.includes("$3.25"));
  assert.ok(partialHour.includes("Rate now"));
  assert.ok(partialHour.includes("partial"));
});

test("recent usage alone is enough to draw the independent rate window", () => {
  const f = fleet({ estimatedCostToday: 0, estimatedBurnPerHour: 0.75, tokensToday: 0, prsToday: 0 });
  assert.equal(fleetCostHasContent(f), true);
  assert.ok(render(f).includes("$0.75"));
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
  assert.ok(html.includes("Claude · 5-hr window"));
  assert.ok(html.includes("Codex · 1-week window"));
});

test("no PRs opened today means no cost-per-PR, rather than a division by zero", () => {
  const html = render(fleet({ prsToday: 0 }));
  assert.ok(!html.includes("Per shipped PR"));
  assert.ok(!html.includes("Infinity"));
  assert.ok(html.includes("Fleet today"));
});

test("cost per PR divides today's estimate by today's proven PRs, and says by how many", () => {
  // $14.82 over 6 pull requests. The denominator rides along, because a unit price without
  // the count it was taken over is a figure a reader cannot check.
  const html = render(fleet({ estimatedCostToday: 14.82, prsToday: 6 }));
  assert.ok(html.includes("$2.47"));
  assert.ok(html.includes("· 6 today"));
});

test("a runway meter states the consumption AND the projection, not one of the two", () => {
  // The strip had room for one and pushed the other into a tooltip. "74% used" and "about
  // 41 minutes left" are the same sentence, and a reader given only the first plans around
  // a comfortable percentage an hour before it stops being one.
  const html = render(fleet({
    rateLimits: { fiveHour: liveWin(74, 2 * HOUR), sevenDay: null, updatedAt: NOW },
  }));
  // Both halves in one figure: the percentage we were handed, then the `~` projection.
  assert.match(html, /<b>74% · ~\d/);
});

test("a window with no reading renders nothing rather than a bar at zero", () => {
  const html = render(fleet({ rateLimits: { fiveHour: null, sevenDay: null, updatedAt: NOW } }));
  assert.ok(!html.includes("runway"));
});

test("the plan view leads with the windows; the usd view leads with the dollars", () => {
  const f = fleet({ rateLimits: { fiveHour: win(60, 2 * HOUR), sevenDay: null, updatedAt: NOW } });
  const usd = render(f, "usd");
  const plan = render(f, "plan");
  assert.ok(usd.indexOf("spend-rows") < usd.indexOf("spend-runways"));
  assert.ok(plan.indexOf("spend-runways") < plan.indexOf("spend-rows"));
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
