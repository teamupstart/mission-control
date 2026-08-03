import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InspectorInspection } from "../src/shared/types.ts";
import { costPerPrToday } from "../src/shared/cost.ts";
import type { FleetCost } from "../src/shared/types.ts";
import { ShipLogPage } from "../src/web/components/ShipLogPage.tsx";
import { PrLink, sessionHandle } from "../src/web/components/settings-console.tsx";
import {
  PR_STANDINGS,
  mergeBucket,
  mergeStatus,
  prLabel,
  prStanding,
  standingTallies,
} from "../src/web/lib/pr-standing.ts";
import {
  DAY_MS,
  SHIP_LOG_RANGES,
  SHIP_LOG_WINDOW_DAYS,
  dayHeading,
  groupByDay,
  rangeStart,
  repoTallies,
  rowsInPriorRange,
  rowsInRange,
  shipLogSummary,
  sparklinePoints,
  startOfLocalDay,
  weeklyTrend,
} from "../src/web/lib/ship-log.ts";

// What is at stake: this page turns the adoption ledger into four headline numbers, a
// repository rail and a week of rows, and every one of those is a figure an operator will
// take at face value about work that already happened. Three failures are specific to it
// and none is visible in a diff:
//
//  1. **The rail and the rows must be the same set.** A mix bar saying "8 open" over a feed
//     showing six is a number the operator now distrusts on the one page whose whole claim
//     is that it accounts for the week.
//  2. **A day is a LOCAL day.** Grouped by a UTC multiple, a pull request opened at 19:00
//     in New York lands under tomorrow, and the "Today" heading then holds work from two
//     dates - on the surface whose headings are its only ordering.
//  3. **Absence must never be manufactured.** A row the Inspector has not polled has no
//     title, and a ledger that cannot be read is not a quiet week.
//
// Times are built from a fixed local noon rather than `Date.now()`, so the assertions hold
// in every zone the suite runs in without pinning `TZ`.

const NOON = new Date(2026, 6, 15, 12, 0, 0, 0).getTime();

function row(over: Partial<InspectorInspection> = {}): InspectorInspection {
  return {
    key: "owner/repo#1",
    url: "https://github.com/owner/repo/pull/1",
    owner: "owner",
    repo: "repo",
    number: 1,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId: null,
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: null,
    adoptedAt: NOON,
    updatedAt: NOON,
    openFindings: 0,
    postedOpenFindings: 0,
    resolvedFindings: 0,
    ...over,
  };
}

// ---- the coarse standing is a FOLD, and it agrees with the five-way one -----------------

test("every merge bucket maps to exactly one of merged / open / gone", () => {
  const cases: [InspectorInspection, string][] = [
    [row({ mergedAt: 5 }), "merged"],
    [row({ state: "closed" }), "gone"],
    [row({ mergeBlock: "soaking" }), "open"],
    [row({ mergeBlock: "checks-failing" }), "open"],
    [row({}), "open"],
  ];
  for (const [candidate, expected] of cases) {
    assert.equal(prStanding(candidate), expected, `${mergeBucket(candidate)} folded wrong`);
    assert.ok((PR_STANDINGS as readonly string[]).includes(prStanding(candidate)));
  }
});

// The one thing the five-way reading cannot see. `mergedAt` means YOLO MODE landed it, so a
// pull request a person merged carries `mergedAt: null` and `state: "closed"` - which
// buckets as `closed` and would be drawn as "gone" on a page about what shipped. The poll's
// own observation is the only witness that it landed, and on this page it wins.
test("a pull request a human merged is merged here, not gone", () => {
  const humanMerged = row({ state: "closed", mergedAt: null, observedState: "MERGED" });
  assert.equal(mergeBucket(humanMerged), "closed");
  assert.equal(prStanding(humanMerged), "merged");
  // And an unpolled closed row still reads as gone - null is not an observation.
  assert.equal(prStanding(row({ state: "closed", observedState: null })), "gone");
  // An OPEN observation never overrides a merge YOLO mode recorded.
  assert.equal(prStanding(row({ mergedAt: 9, observedState: "OPEN" })), "merged");
});

// `mergeStatus` moved out of the settings panel with the rest of the folds, and the line
// this pins is the reason it is a `??` and not a lookup: an unknown `mergeBlock` is the
// message `gh` gave when it refused, and it is the only account of a rule we cannot read.
test("gh's verbatim refusal survives the move to the shared module", () => {
  assert.equal(
    mergeStatus(row({ mergeBlock: "Protected branch update failed for refs/heads/main" })),
    "Protected branch update failed for refs/heads/main",
  );
  assert.equal(mergeStatus(row({ mergeBlock: "soaking" })), "waiting out the soak window");
  assert.equal(mergeStatus(row({ mergedAt: 1 })), "merged");
});

test("standing tallies account for every row", () => {
  const rows = [
    row({ key: "a", mergedAt: 1 }),
    row({ key: "b", observedState: "MERGED", state: "closed" }),
    row({ key: "c" }),
    row({ key: "d", state: "closed" }),
  ];
  const tally = standingTallies(rows);
  assert.deepEqual(tally, { merged: 2, open: 1, gone: 1 });
  assert.equal(Object.values(tally).reduce((a, b) => a + b, 0), rows.length);
});

// ---- what a row is CALLED ---------------------------------------------------------------

// The whole point of Phase 1's nullable `title`: a row adopted and not yet polled has no
// title, and a row adopted by a build older than the column may never get one, because the
// tick retires merged and closed rows and never looks again.
test("a row falls back from title to branch to number, and never to blank", () => {
  assert.equal(prLabel(row({ title: "Focus order for line drawer chips" })), "Focus order for line drawer chips");
  assert.equal(prLabel(row({ title: null, headRefName: "fix/line-drawer-focus" })), "fix/line-drawer-focus");
  assert.equal(prLabel(row({ title: null, headRefName: null, number: 241 })), "#241");
  // An empty title is a title GitHub actually reported, not a missing one - `??` and not
  // `||`, or a pull request someone named "" would silently become its branch.
  assert.equal(prLabel(row({ title: "", headRefName: "b" })), "");
});

// Every session id space this ledger holds, abbreviated where it carries its identity.
// `sdk:` is the one the Ship log sees most - a dispatched session is what opens most pull
// requests - and a bare eight-character slice spends three of them on the prefix, leaving
// four hex digits to tell every dispatched session apart.
test("a session handle keeps the identifying part of each id shape", () => {
  assert.equal(sessionHandle("proc:/dev/ttys004:4123:1700"), "ttys004:4123");
  assert.equal(sessionHandle("sdk:9f2a1b3c-0d44-4d1e-9f1a-77e2b0c9aa10"), "9f2a1b3c");
  assert.notEqual(sessionHandle("sdk:9f2a1b3c-0d44-4d1e-9f1a-77e2b0c9aa10"), "sdk:9f2a");
  // The Foreman ledger's bare-UUID form, unchanged by the move and by the new branch.
  assert.equal(sessionHandle("3f2a91cc-0d44-4d1e-9f1a-77e2b0c9aa10"), "3f2a91cc");
  assert.equal(sessionHandle(""), "unknown");
  assert.equal(sessionHandle("sdk:"), "sdk:");
});

// Markup shape, because this is a leaf whose contract just widened: told a label it renders
// the label, told nothing it still renders the identity every row is guaranteed to have.
test("PrLink renders the label it is handed, and owner/repo#number when it is not", () => {
  const titled = renderToStaticMarkup(createElement(PrLink, {
    repo: "mancej-cyc/ai-harness",
    number: 241,
    url: "https://example.test/pr/241",
    tooltip: "Open it",
    label: "Focus order for line drawer chips",
  }));
  assert.match(titled, /Focus order for line drawer chips/);
  assert.doesNotMatch(titled, /ai-harness#241<\/a>/);

  const bare = renderToStaticMarkup(createElement(PrLink, {
    repo: "mancej-cyc/ai-harness",
    number: 241,
    url: "https://example.test/pr/241",
    tooltip: "Open it",
  }));
  assert.match(bare, /mancej-cyc\/ai-harness#241/);
});

// ---- days are LOCAL days ----------------------------------------------------------------

test("rows group by the operator's local midnight, newest day first", () => {
  const todayStart = startOfLocalDay(NOON);
  const lateYesterday = todayStart - 1;
  const earlyToday = todayStart + 1;
  const grouped = groupByDay([
    row({ key: "late", adoptedAt: lateYesterday }),
    row({ key: "early", adoptedAt: earlyToday, mergedAt: 1 }),
    row({ key: "noon", adoptedAt: NOON }),
  ]);
  assert.equal(grouped.length, 2, "two milliseconds apart across midnight is two days");
  assert.equal(grouped[0]!.day, todayStart);
  assert.equal(grouped[1]!.day, todayStart - DAY_MS);
  // Newest first WITHIN the day, and the day's own merged count is folded the same way the
  // rows are - so the heading and the rows under it cannot disagree.
  assert.deepEqual(grouped[0]!.rows.map((r) => r.key), ["noon", "early"]);
  assert.equal(grouped[0]!.merged, 1);
  assert.equal(grouped[1]!.merged, 0);
});

// DST, which is where every "just subtract 86,400,000" day boundary breaks. Run under a
// zone that HAS transitions and at the two dates they happen, because in UTC - which is
// where CI runs - a fixed-ms day and a calendar day are the same thing and none of this
// can fail. The failures are not subtle: a range that starts at 23:00 renders an eighth
// day heading under a chip that says seven, and one that starts at 01:00 moves a row out
// of the total and into the figure the total is compared against.
//
// `TZ` is set per-case with `process.env` because `node:test` gives no zone fixture; the
// `Date` constructor reads it afresh, and the cases restore it.
function inZone<T>(tz: string, run: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test("a calendar day survives a DST transition in both directions", () => {
  inZone("America/New_York", () => {
    // Spring forward: 2026-03-08 loses an hour.
    const afterSpring = new Date(2026, 2, 10, 12, 0, 0, 0).getTime();
    const springStart = rangeStart(afterSpring, 7);
    assert.equal(
      springStart,
      startOfLocalDay(springStart),
      "the 7-day range must begin AT a local midnight, not an hour either side of one",
    );
    assert.equal(new Date(springStart).getDate(), 4, "seven calendar days back from the 10th");
    // The eighth heading this used to produce: a row in the 23:00-24:00 sliver of the day
    // before the range must be OUT of it, and in the range it is compared against.
    const sliver = row({ adoptedAt: new Date(2026, 2, 3, 23, 30).getTime() });
    assert.equal(rowsInRange([sliver], afterSpring, 7).length, 0);
    assert.equal(rowsInPriorRange([sliver], afterSpring, 7).length, 1);

    // Fall back: 2026-11-01 gains an hour.
    const afterFall = new Date(2026, 10, 2, 12, 0, 0, 0).getTime();
    const fallStart = rangeStart(afterFall, 7);
    assert.equal(fallStart, startOfLocalDay(fallStart));
    assert.equal(new Date(fallStart).getDate(), 27);
    // And the row this used to drop: 00:30 on the range's first day is inside it.
    const earlyRow = row({ adoptedAt: new Date(2026, 9, 27, 0, 30).getTime() });
    assert.equal(rowsInRange([earlyRow], afterFall, 7).length, 1);
    assert.equal(rowsInPriorRange([earlyRow], afterFall, 7).length, 0);

    // Every weekly bucket lands on a midnight too, or the trend borrows an hour per week.
    for (const boundary of [afterSpring, afterFall]) {
      const trend = weeklyTrend([], boundary, 12);
      assert.equal(trend.length, 12);
    }
  });
});

test("'Yesterday' is still yesterday on the day after the clocks change", () => {
  inZone("America/New_York", () => {
    // The day after spring forward: yesterday's midnight is 23 hours back, so a fixed-ms
    // comparison matches no group at all and the heading silently becomes a date.
    const now = new Date(2026, 2, 9, 12, 0, 0, 0).getTime();
    const yesterday = startOfLocalDay(new Date(2026, 2, 8, 12, 0).getTime());
    assert.notEqual(yesterday, startOfLocalDay(now) - DAY_MS, "the case must be a real one");
    assert.equal(dayHeading(yesterday, now), "Yesterday");
    assert.equal(dayHeading(startOfLocalDay(now), now), "Today");
  });
});

test("the two relative day headings are exact, and everything older carries its date", () => {
  const today = startOfLocalDay(NOON);
  assert.equal(dayHeading(today, NOON), "Today");
  assert.equal(dayHeading(today - DAY_MS, NOON), "Yesterday");
  const older = dayHeading(today - 3 * DAY_MS, NOON, "en-US");
  assert.doesNotMatch(older, /Today|Yesterday/);
  // Weekday AND date: "Friday" alone is ambiguous inside a 30-day range.
  assert.match(older, /Jul 12/);
});

// ---- ranges are whole calendar days, and the delta has a denominator --------------------

test("a range is calendar days ending today, so this morning never rolls out of Today", () => {
  const today = startOfLocalDay(NOON);
  assert.equal(rangeStart(NOON, 1), today, "'Today' begins at local midnight, not 24h ago");
  assert.equal(rangeStart(NOON, 7), today - 6 * DAY_MS);
  // 08:00 is inside "Today" at noon. A rolling 24-hour window would keep it; a rolling
  // window anchored at `now` for a 1-day range would not have this row by tomorrow's
  // breakfast, which is the bug the calendar anchoring exists to avoid.
  const morning = row({ adoptedAt: today + 8 * 60 * 60 * 1000 });
  assert.equal(rowsInRange([morning], NOON, 1).length, 1);
});

test("the prior range is the range immediately before it, and does not overlap", () => {
  const today = startOfLocalDay(NOON);
  const rows = [
    row({ key: "in", adoptedAt: today }),
    row({ key: "edge-in", adoptedAt: rangeStart(NOON, 7) }),
    row({ key: "edge-prior", adoptedAt: rangeStart(NOON, 7) - 1 }),
    row({ key: "way-back", adoptedAt: today - 40 * DAY_MS }),
  ];
  assert.deepEqual(rowsInRange(rows, NOON, 7).map((r) => r.key), ["in", "edge-in"]);
  assert.deepEqual(rowsInPriorRange(rows, NOON, 7).map((r) => r.key), ["edge-prior"]);
  // No row is in both, which is what makes the delta a comparison rather than a mixture.
  const inRange = new Set(rowsInRange(rows, NOON, 7).map((r) => r.key));
  for (const prior of rowsInPriorRange(rows, NOON, 7)) assert.ok(!inRange.has(prior.key));
});

// A row stamped ahead of this clock still belongs to the week it says it does. Bounding the
// range at `now` would drop it from the page while the Line's uncapped count still held it.
test("a row adopted slightly in the future is still in the range", () => {
  assert.equal(rowsInRange([row({ adoptedAt: NOON + 60_000 })], NOON, 7).length, 1);
});

test("every offered range fits inside the window the page actually reads", () => {
  for (const range of SHIP_LOG_RANGES) {
    assert.ok(
      range.days * 2 <= SHIP_LOG_WINDOW_DAYS,
      `${range.label} cannot be compared with the range before it inside one read`,
    );
    assert.equal(shipLogSummary([], NOON, range.days).priorKnown, true);
  }
});

// ---- the KPI row ------------------------------------------------------------------------

test("the summary counts, compares and rates the range it was asked about", () => {
  const today = startOfLocalDay(NOON);
  const rows = [
    row({ key: "a", owner: "o", repo: "one", adoptedAt: today, mergedAt: 1 }),
    row({ key: "b", owner: "o", repo: "one", adoptedAt: today - DAY_MS, mergedAt: 1 }),
    row({ key: "c", owner: "o", repo: "two", adoptedAt: today - 2 * DAY_MS }),
    row({ key: "d", owner: "o", repo: "two", adoptedAt: today - 3 * DAY_MS, state: "closed" }),
    // Prior week: two rows, so the delta is +2.
    row({ key: "e", owner: "o", repo: "one", adoptedAt: today - 8 * DAY_MS }),
    row({ key: "f", owner: "o", repo: "three", adoptedAt: today - 9 * DAY_MS }),
  ];
  const summary = shipLogSummary(rows, NOON, 7);
  assert.equal(summary.total, 4);
  assert.equal(summary.prior, 2);
  assert.equal(summary.delta, 2);
  assert.deepEqual(summary.standing, { merged: 2, open: 1, gone: 1 });
  assert.equal(summary.mergeRate, 50);
  assert.equal(summary.repos, 2, "the third repo is in the PRIOR week, not this one");
  assert.equal(summary.reposToday, 1);
});

// A rate over nothing is not 0%, it is not a rate. `0%` on an empty week reads as "we
// merged none of what we shipped", which is a report about work that does not exist.
test("an empty range has no merge rate at all", () => {
  const summary = shipLogSummary([], NOON, 7);
  assert.equal(summary.total, 0);
  assert.equal(summary.mergeRate, null);
  assert.equal(summary.delta, 0);
  assert.equal(summary.repos, 0);
});

// ---- the repository rail ----------------------------------------------------------------

test("the rail is busiest first, ties by name, and its mix is the rows' own tally", () => {
  const rows = [
    row({ key: "1", owner: "mancej-cyc", repo: "ai-harness", mergedAt: 1 }),
    row({ key: "2", owner: "mancej-cyc", repo: "ai-harness" }),
    row({ key: "3", owner: "mancej-cyc", repo: "ai-harness", state: "closed" }),
    row({ key: "4", owner: "z-owner", repo: "beta", mergedAt: 1 }),
    row({ key: "5", owner: "a-owner", repo: "alpha", mergedAt: 1 }),
  ];
  const tallies = repoTallies(rows);
  assert.deepEqual(tallies.map((t) => t.repo), [
    "mancej-cyc/ai-harness",
    "a-owner/alpha",
    "z-owner/beta",
  ]);
  assert.deepEqual(tallies[0], {
    repo: "mancej-cyc/ai-harness",
    total: 3,
    merged: 1,
    open: 1,
    gone: 1,
  });
  // The rail's segments and the feed's rows are one tally: every repo's parts sum to its
  // total, and every total sums to the row count.
  for (const tally of tallies) {
    assert.equal(tally.merged + tally.open + tally.gone, tally.total);
  }
  assert.equal(tallies.reduce((sum, t) => sum + t.total, 0), rows.length);
});

// The rail is keyed on `owner/repo`, not `repo`: two owners with a repo of the same name
// are two repositories, and folding them would be this page's headline claim gone wrong.
test("two owners with the same repo name are two rail entries", () => {
  const tallies = repoTallies([
    row({ key: "a", owner: "one", repo: "infra" }),
    row({ key: "b", owner: "two", repo: "infra" }),
  ]);
  assert.equal(tallies.length, 2);
});

// ---- the trend ---------------------------------------------------------------------------

test("the trend's last bucket is the same seven days the weekly KPI counts", () => {
  const today = startOfLocalDay(NOON);
  const rows = [
    row({ key: "a", adoptedAt: today }),
    row({ key: "b", adoptedAt: today - 6 * DAY_MS }),
    row({ key: "c", adoptedAt: today - 8 * DAY_MS }),
  ];
  const trend = weeklyTrend(rows, NOON, 3);
  assert.equal(trend.length, 3);
  assert.equal(trend.at(-1), 2);
  assert.equal(trend.at(-1), shipLogSummary(rows, NOON, 7).total);
  assert.equal(trend.at(-2), 1);
});

test("a sparkline over a fleet that shipped nothing draws a line, not a NaN", () => {
  const flat = sparklinePoints([0, 0, 0], 68, 26);
  assert.doesNotMatch(flat.points, /NaN/);
  assert.equal(flat.last?.y, 26, "a zero week sits on the floor of the plot");
  assert.deepEqual(sparklinePoints([], 68, 26), { points: "", tail: "", last: null });
  const rising = sparklinePoints([1, 4], 68, 26);
  assert.equal(rising.last?.x, 68);
  assert.equal(rising.last?.y, 0, "the peak touches the top of the box");
  // The tail is the LAST leg, so the loud stroke over it starts where the quiet one ends
  // rather than anywhere the drawing chose - two polylines, one shape.
  assert.equal(rising.tail, rising.points);
  const twelve = sparklinePoints([1, 2, 3], 68, 26);
  assert.ok(twelve.points.endsWith(twelve.tail), "the tail must be the end of the line");
  assert.equal(twelve.tail.split(" ").length, 2);
  // One point is a dot with no leg to draw, and an empty `points` renders nothing at all.
  assert.equal(sparklinePoints([5], 68, 26).tail, "");
});

// ---- the cost KPI refuses rather than divides -------------------------------------------

test("the per-PR figure is withheld on every reading that would be a lie", () => {
  const fleet = (over: Partial<FleetCost>): FleetCost => ({
    estimatedCostToday: 40,
    estimatedBurnPerHour: 1,
    tokensToday: 10,
    prsToday: 2,
    rateLimits: null,
    automation: { estimatedCostToday: 0, tokensToday: 0, roles: [] },
    updatedAt: 0,
    ...over,
  });
  assert.equal(costPerPrToday(fleet({})), 20);
  assert.equal(costPerPrToday(null), null);
  // Unpriced usage in the window: a known subtotal is not a total, and dividing it would
  // publish an under-estimate as a measurement.
  assert.equal(costPerPrToday(fleet({ estimatedCostToday: null })), null);
  // The division by zero. "Nothing shipped today" is not "shipping was free today".
  assert.equal(costPerPrToday(fleet({ prsToday: 0 })), null);
  assert.equal(costPerPrToday(fleet({ estimatedCostToday: 0 })), null);
  assert.equal(costPerPrToday(fleet({ estimatedCostToday: -1 })), null);

  // Not a number at all, which is the reading a NEGATED guard lets through: `NaN > 0` is
  // false and refuses, `NaN <= 0` is false and accepts. Both operands, because either one
  // arriving corrupt produces the same non-finite quotient - and the surfaces would then
  // draw a per-PR row with a dash in it rather than withholding the figure.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(costPerPrToday(fleet({ estimatedCostToday: bad })), null, `estimate ${bad}`);
    assert.equal(costPerPrToday(fleet({ prsToday: bad })), null, `prsToday ${bad}`);
  }
  // Every refusal above is a refusal by this fold, so no caller has to spot a non-finite
  // number for itself - which is the whole reason the division has one home.
  assert.equal(costPerPrToday(fleet({ estimatedCostToday: Number.NaN, prsToday: 3 })), null);
});

// ---- the page's own frame ----------------------------------------------------------------

// Effects never run under `renderToStaticMarkup`, so this is the page BEFORE its one fetch
// resolves - which is exactly the state worth pinning: the frame, the range chips and the
// heading are up, and not one number is on screen yet.
test("the Ship log renders its heading and range chips before the ledger answers", () => {
  const html = renderToStaticMarkup(createElement(ShipLogPage, { fleetCost: null, now: NOON }));
  // The h2 is a cross-phase contract: the drawer's escalation in the next phase, the
  // palette's destination and the e2e spec all name this page by this heading.
  assert.match(html, /<h2>Ship log<\/h2>/);
  assert.match(html, /across every repo/);
  for (const range of SHIP_LOG_RANGES) assert.match(html, new RegExp(range.label));
  // Default range, stated in the markup rather than only in state.
  assert.match(html, /aria-pressed="true"[^>]*>7 days</);
  assert.match(html, /Reading the ledger/);
  // Nothing has been read, so nothing is claimed - least of all an empty week.
  assert.doesNotMatch(html, /No pull request was adopted/);
});
