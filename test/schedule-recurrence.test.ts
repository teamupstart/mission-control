import { test } from "node:test";
import assert from "node:assert/strict";
import { recurrence, zoneOffsetMinutes } from "../src/server/schedules/recurrence.ts";
import { SCHEDULE_BETWEEN_MAX, SCHEDULE_PREVIEW_MAX_COUNT } from "../src/shared/schedules.ts";

// What is at stake: this module decides WHEN a recurring mission comes due, and it is the
// only thing in the product that does. Everything downstream - the cursor in SQLite, the
// exactly-once claim, the preview an operator approves a schedule from - inherits whatever
// it says, so an hour of error here is an hour of error everywhere, twice a year, silently.
//
// Two classes of failure are pinned here rather than left to the library:
//
//  - `cron-parser` accepts three, four, five AND six fields, and does not validate the
//    time zone at all. Both were measured against 5.6.2. A six-field expression is
//    seconds syntax; read as five it schedules something wildly more often than the
//    operator asked for, and a mistyped zone computes in UTC without complaint.
//  - DST. The fixtures below are VERBATIM measured output, not hand-reasoned expectations,
//    and they exist so that a dependency upgrade that changes transition behaviour fails
//    here instead of quietly moving somebody's 2am mission.
//
// 2026 transitions used below: US 2026-03-08 (spring) and 2026-11-01 (fall);
// Europe/London 2026-03-29 and 2026-10-25; Australia/Sydney 2026-04-05 (fall, southern).

const iso = (ms: number) => new Date(ms).toISOString();

/** How the instant reads on the wall clock in that zone - the half a UTC epoch hides. */
function localTime(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

function nextN(expression: string, timezone: string, from: string, n: number): string[] {
  const out: string[] = [];
  let at = Date.parse(from);
  for (let i = 0; i < n; i++) {
    const next = recurrence.nextAfter(expression, timezone, at);
    assert.ok(next !== null, `expected an instant after ${iso(at)}`);
    out.push(iso(next));
    at = next;
  }
  return out;
}

// ---- field count ----

test("a six-field expression is refused as seconds syntax, not silently parsed", () => {
  // The whole reason the count is checked here: cron-parser PARSES this one. Left to the
  // library, "0 0 8 * * *" - which an operator wrote meaning 8am - becomes every second
  // of the eighth minute of every hour.
  const r = recurrence.validate("0 0 8 * * *", "UTC");
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error.field === "expression");
  assert.match(!r.ok ? r.error.message : "", /seconds are not supported/i);
});

test("fewer than five fields is refused, and says how many it saw", () => {
  const r = recurrence.validate("* * *", "UTC");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error.message : "", /this has 3/);
});

test("cron aliases are refused: one grammar, five fields", () => {
  // cron-parser accepts @daily and @hourly. Accepting them would mean the editor's
  // presets, the stored value and the validator no longer describe the same language.
  for (const alias of ["@daily", "@hourly"]) {
    assert.equal(recurrence.validate(alias, "UTC").ok, false, alias);
  }
});

test("whitespace is canonicalized rather than counted against the operator", () => {
  const r = recurrence.validate("  0   8  *  *  *  ", "UTC");
  assert.ok(r.ok);
  assert.equal(r.ok && r.expression, "0 8 * * *");
});

// ---- time zones ----

test("a bogus time zone is refused - cron-parser would compute it in UTC in silence", () => {
  const r = recurrence.validate("0 8 * * *", "Not/AZone");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.field, "timezone");
});

test("an empty time zone is refused rather than defaulting to the machine's", () => {
  assert.equal(recurrence.validate("0 8 * * *", "").ok, false);
});

test("a valid zone comes back canonicalized, so what gets stored is stable", () => {
  const lower = recurrence.validate("0 8 * * *", "utc");
  assert.ok(lower.ok);
  assert.equal(lower.ok && lower.timezone, "UTC");

  const legacy = recurrence.validate("0 8 * * *", "US/Pacific");
  assert.equal(legacy.ok && legacy.timezone, "America/Los_Angeles");
});

// ---- minimum interval ----

test("a sub-hour cadence is refused, and the message says what it would have done", () => {
  const r = recurrence.validate("*/30 * * * *", "UTC", Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error.message : "", /every 30 minutes/);
  assert.match(!r.ok ? r.error.message : "", /minimum interval is 60 minutes/);
});

test("hourly is allowed: exactly one hour is not less than one hour", () => {
  assert.ok(recurrence.validate("0 * * * *", "UTC", Date.parse("2026-07-01T00:00:00Z")).ok);
});

test("hourly stays allowed across both DST transitions", () => {
  // The reason the probe may look at five instants instead of two: if a transition ever
  // shortened a gap below the hour, a legitimate hourly schedule would become unsavable
  // for one day a year. Measured at a 60-minute minimum in every zone tried.
  for (const [zone, anchor] of [
    ["America/New_York", "2026-03-08T05:00:00Z"],
    ["America/New_York", "2026-11-01T04:00:00Z"],
    ["Europe/London", "2026-03-29T00:00:00Z"],
  ] as const) {
    assert.ok(recurrence.validate("0 * * * *", zone, Date.parse(anchor)).ok, `${zone} ${anchor}`);
  }
});

test("a sub-hour gap that is not the FIRST gap is still caught", () => {
  // "0 8,9,9 * * *" collapses, so use two minutes inside one hour: the first gap is an
  // hour and the offending one is second. Checking only the first two instants, as the
  // source plan literally specifies, would let this through.
  const r = recurrence.validate("0,5 8 * * *", "UTC", Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error.message : "", /every 5 minutes/);
});

test("the short gap is found wherever in the day it sits, and whatever the anchor", () => {
  // The probe spans a whole day rather than sampling N instants, so "no short gap in the
  // first N" can never be reported as "no short gap". Each of these puts the offending
  // pair somewhere a fixed-count sample looks like it could miss: late in a dense day,
  // straddling midnight, or on the far side of an anchor that landed mid-pattern. All of
  // them were in fact caught by the five-instant sample too - a short pair recurs every
  // selected hour, so it surfaces immediately - which is the point of pinning them: they
  // are the cases someone will reach for when they next want to shrink this window.
  const cases: Array<[string, string]> = [
    ["0,10,20,30,40,45 8 * * *", "2026-07-01T08:41:00Z"], // anchor past all but the last
    ["0,45 8 * * *", "2026-07-01T08:10:00Z"], // 45-minute pair, anchored between them
    ["0,59 0,23 * * *", "2026-07-01T01:00:00Z"], // one minute apart, across midnight
    ["50,10 8,9 * * *", "2026-07-01T00:00:00Z"], // adjacent hours, 20 minutes apart
    ["0,30 0 1 * *", "2026-07-15T00:00:00Z"], // monthly, and the pair is a month away
  ];
  for (const [expression, anchor] of cases) {
    const r = recurrence.validate(expression, "UTC", Date.parse(anchor));
    assert.equal(r.ok, false, `${expression} from ${anchor} must be refused`);
  }
});

test("a legitimately sparse cadence is not rejected by the wider probe", () => {
  // The other half: widening the window must not start refusing schedules that are fine.
  // Yearly is the extreme - two instants a year apart end the probe immediately.
  for (const expression of ["0 8 * * *", "0 9 * * 1", "0 6 1 * *", "0 8 1 1 *", "0 * * * *"]) {
    assert.ok(
      recurrence.validate(expression, "UTC", Date.parse("2026-07-01T00:00:00Z")).ok,
      expression,
    );
  }
});

test("the densest possible expression is refused without walking the whole day", () => {
  // Every minute of every hour is 1,440 instants. The probe stops at the first short gap,
  // so this is two instants of work, not 1,440 - the early exit is what keeps the wider
  // window affordable.
  const started = process.hrtime.bigint();
  const r = recurrence.validate("* * * * *", "UTC", Date.parse("2026-07-01T00:00:00Z"));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.ok, false);
  assert.ok(elapsedMs < 250, `expected an early exit, took ${elapsedMs.toFixed(1)}ms`);
});

test("an expression that never comes due is refused rather than returning nothing", () => {
  const r = recurrence.validate("0 0 30 2 *", "UTC");
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.field, "expression");
});

// ---- plain enumeration ----

test("daily, weekly and monthly enumerate the instants they say they do", () => {
  assert.deepEqual(nextN("0 8 * * *", "UTC", "2026-07-23T00:00:00Z", 3), [
    "2026-07-23T08:00:00.000Z",
    "2026-07-24T08:00:00.000Z",
    "2026-07-25T08:00:00.000Z",
  ]);
  assert.deepEqual(nextN("0 9 * * 1", "UTC", "2026-07-23T00:00:00Z", 3), [
    "2026-07-27T09:00:00.000Z",
    "2026-08-03T09:00:00.000Z",
    "2026-08-10T09:00:00.000Z",
  ]);
  assert.deepEqual(nextN("0 6 1 * *", "UTC", "2026-07-23T00:00:00Z", 3), [
    "2026-08-01T06:00:00.000Z",
    "2026-09-01T06:00:00.000Z",
    "2026-10-01T06:00:00.000Z",
  ]);
});

test("nextAfter is strictly after its anchor, even standing exactly on an instant", () => {
  const at = Date.parse("2026-07-23T08:00:00Z");
  assert.equal(iso(recurrence.nextAfter("0 8 * * *", "UTC", at)!), "2026-07-24T08:00:00.000Z");
});

test("a stored cadence this build cannot read yields null, never a guessed instant", () => {
  // Null is what leaves the cursor where it was and puts the schedule into attention.
  // Any number here would be a due instant nobody asked for.
  assert.equal(recurrence.nextAfter("0 0 8 * * *", "UTC", 0), null);
  assert.equal(recurrence.nextAfter("0 8 * * *", "Not/AZone", 0), null);
});

// ---- DST: United States ----

test("US spring-forward: the skipped wall-clock hour yields one instant, shifted", () => {
  // 2026-03-08, 02:00 -> 03:00 local. 02:30 does not exist that day. Measured behaviour
  // is one occurrence at the same UTC instant as the day before, which reads as 03:30
  // local - the day is not skipped and the run is not duplicated.
  const got = nextN("30 2 * * *", "America/New_York", "2026-03-06T12:00:00Z", 3);
  assert.deepEqual(got, [
    "2026-03-07T07:30:00.000Z",
    "2026-03-08T07:30:00.000Z",
    "2026-03-09T06:30:00.000Z",
  ]);
  assert.equal(localTime(Date.parse(got[0]!), "America/New_York"), "07/03/2026, 02:30");
  assert.equal(localTime(Date.parse(got[1]!), "America/New_York"), "08/03/2026, 03:30");
  assert.equal(localTime(Date.parse(got[2]!), "America/New_York"), "09/03/2026, 02:30");
});

test("US spring-forward: exactly one instant falls inside the 23-hour local day", () => {
  // 2026-03-08 in New York runs 05:00Z to 04:00Z next day.
  const day = recurrence.between(
    "30 2 * * *",
    "America/New_York",
    Date.parse("2026-03-08T05:00:00Z"),
    Date.parse("2026-03-09T04:00:00Z"),
    10,
  );
  assert.deepEqual(day.map(iso), ["2026-03-08T07:30:00.000Z"]);
});

test("US fall-back: the repeated wall-clock hour yields ONE instant, the first", () => {
  // 2026-11-01, 02:00 -> 01:00 local, so 01:30 happens twice. A schedule must fire once.
  const got = nextN("30 1 * * *", "America/New_York", "2026-10-30T12:00:00Z", 3);
  assert.deepEqual(got, [
    "2026-10-31T05:30:00.000Z",
    "2026-11-01T05:30:00.000Z",
    "2026-11-02T06:30:00.000Z",
  ]);
  // 05:30Z is 01:30 EDT - the first pass. The second 01:30 (EST, 06:30Z) is not a run.
  assert.equal(zoneOffsetMinutes(Date.parse(got[1]!), "America/New_York"), -240);
});

test("US fall-back: exactly one instant falls inside the 25-hour local day", () => {
  const day = recurrence.between(
    "30 1 * * *",
    "America/New_York",
    Date.parse("2026-11-01T04:00:00Z"),
    Date.parse("2026-11-02T05:00:00Z"),
    10,
  );
  assert.deepEqual(day.map(iso), ["2026-11-01T05:30:00.000Z"]);
});

// ---- DST: outside the United States ----

test("Europe/London spring-forward is pinned: one instant, shifted an hour", () => {
  const got = nextN("30 1 * * *", "Europe/London", "2026-03-27T00:00:00Z", 3);
  assert.deepEqual(got, [
    "2026-03-27T01:30:00.000Z",
    "2026-03-28T01:30:00.000Z",
    "2026-03-29T01:30:00.000Z",
  ]);
  // 2026-03-29 is the transition: 01:00 GMT becomes 02:00 BST, so 01:30 reads as 02:30.
  assert.equal(localTime(Date.parse(got[2]!), "Europe/London"), "29/03/2026, 02:30");
});

test("Europe/London fall-back is pinned: one instant on the 25-hour day", () => {
  const day = recurrence.between(
    "30 1 * * *",
    "Europe/London",
    Date.parse("2026-10-24T23:00:00Z"),
    Date.parse("2026-10-26T00:00:00Z"),
    10,
  );
  assert.deepEqual(day.map(iso), ["2026-10-25T00:30:00.000Z"]);
});

test("a southern-hemisphere transition is pinned too - Australia/Sydney falls back in April", () => {
  // Sydney leaves DST on 2026-04-05, which is a spring date in the north. A fixture set
  // drawn only from northern zones would not notice a library that hard-coded the season.
  const got = nextN("30 2 * * *", "Australia/Sydney", "2026-04-03T00:00:00Z", 3);
  assert.deepEqual(got, [
    "2026-04-03T15:30:00.000Z",
    "2026-04-04T15:30:00.000Z",
    "2026-04-05T16:30:00.000Z",
  ]);
  assert.equal(zoneOffsetMinutes(Date.parse(got[1]!), "Australia/Sydney"), 660); // AEDT
  assert.equal(zoneOffsetMinutes(Date.parse(got[2]!), "Australia/Sydney"), 600); // AEST
});

test("zone offsets are read in minutes east of UTC, including half-hour zones", () => {
  const at = Date.parse("2026-07-01T00:00:00Z");
  assert.equal(zoneOffsetMinutes(at, "UTC"), 0);
  assert.equal(zoneOffsetMinutes(at, "America/New_York"), -240);
  assert.equal(zoneOffsetMinutes(at, "Asia/Kolkata"), 330);
  assert.equal(zoneOffsetMinutes(at, "Asia/Kathmandu"), 345);
});

// ---- between ----

test("between is exclusive at the start and inclusive at the end", () => {
  const got = recurrence.between(
    "0 * * * *",
    "UTC",
    Date.parse("2026-01-01T00:00:00Z"),
    Date.parse("2026-01-01T03:00:00Z"),
    10,
  );
  assert.deepEqual(got.map(iso), [
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T02:00:00.000Z",
    "2026-01-01T03:00:00.000Z",
  ]);
});

test("between bounds its output before allocating, and never exceeds the hard cap", () => {
  const limited = recurrence.between(
    "0 * * * *",
    "UTC",
    Date.parse("2026-01-01T00:00:00Z"),
    Date.parse("2026-12-31T00:00:00Z"),
    3,
  );
  assert.equal(limited.length, 3);

  const capped = recurrence.between(
    "0 * * * *",
    "UTC",
    Date.parse("2026-01-01T00:00:00Z"),
    Date.parse("2026-12-31T00:00:00Z"),
    100_000,
  );
  assert.equal(capped.length, SCHEDULE_BETWEEN_MAX);
});

test("an inverted or empty window returns nothing rather than throwing", () => {
  const inverted = recurrence.between(
    "0 * * * *",
    "UTC",
    Date.parse("2026-02-01T00:00:00Z"),
    Date.parse("2026-01-01T00:00:00Z"),
    10,
  );
  assert.deepEqual(inverted, []);
});

// ---- preview ----

test("preview and between produce the SAME instants - one evaluator, not two", () => {
  // The property that stops the screen an operator approves from disagreeing with what
  // the scheduler later does.
  const after = Date.parse("2026-03-06T12:00:00Z");
  const p = recurrence.preview(
    { expression: "30 2 * * *", timezone: "America/New_York", after, count: 5 },
    after,
  );
  assert.ok(p.ok);
  if (!p.ok) return;
  const last = p.instants[p.instants.length - 1]!.at;
  const enumerated = recurrence.between("30 2 * * *", "America/New_York", after, last, 50);
  assert.deepEqual(
    p.instants.map((i) => i.at),
    enumerated,
  );
});

test("preview refuses exactly what save would refuse", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");
  const p = recurrence.preview({ expression: "*/5 * * * *", timezone: "UTC" }, now);
  assert.equal(p.ok, false);
  assert.equal(!p.ok && p.error.field, "expression");
});

test("preview marks the instant that crosses a DST transition", () => {
  const after = Date.parse("2026-03-06T12:00:00Z");
  const p = recurrence.preview(
    { expression: "30 2 * * *", timezone: "America/New_York", after, count: 4 },
    after,
  );
  assert.ok(p.ok);
  if (!p.ok) return;
  // 03-07 is EST (-300), 03-08 onwards EDT (-240): the shift is on the second row, and
  // the first row is never marked because it has nothing before it to differ from.
  assert.deepEqual(
    p.instants.map((i) => i.dstShift),
    [false, true, false, false],
  );
  assert.deepEqual(
    p.instants.map((i) => i.offsetMinutes),
    [-300, -240, -240, -240],
  );
});

test("preview count is clamped rather than trusted", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");
  const huge = recurrence.preview(
    { expression: "0 8 * * *", timezone: "UTC", after: now, count: 5_000 },
    now,
  );
  assert.ok(huge.ok);
  assert.equal(huge.ok && huge.instants.length, SCHEDULE_PREVIEW_MAX_COUNT);

  const none = recurrence.preview({ expression: "0 8 * * *", timezone: "UTC", after: now }, now);
  assert.equal(none.ok && none.instants.length, 10);
});

test("the standby simulation enumerates what an eight-day trip would have missed", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");
  const p = recurrence.preview(
    {
      expression: "0 8 * * *",
      timezone: "UTC",
      after: now,
      sleepStartedAt: Date.parse("2026-06-01T00:00:00Z"),
      resumedAt: Date.parse("2026-06-09T00:00:00Z"),
    },
    now,
  );
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.ok(p.standby);
  assert.equal(p.standby!.missed.length, 8);
  assert.equal(iso(p.standby!.missed[0]!), "2026-06-01T08:00:00.000Z");
  assert.equal(iso(p.standby!.missed[7]!), "2026-06-08T08:00:00.000Z");
  assert.equal(p.standby!.truncated, false);
});

test("a standby window longer than the cap reports that it was truncated", () => {
  // Honest rather than inferred from the length: a window holding exactly the cap must
  // not claim to have held more, so one extra instant is fetched and dropped.
  const now = Date.parse("2030-01-01T00:00:00Z");
  const p = recurrence.preview(
    {
      expression: "0 * * * *",
      timezone: "UTC",
      after: now,
      sleepStartedAt: Date.parse("2026-01-01T00:00:00Z"),
      resumedAt: Date.parse("2026-06-01T00:00:00Z"),
    },
    now,
  );
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.standby!.missed.length, SCHEDULE_BETWEEN_MAX);
  assert.equal(p.standby!.truncated, true);
});

test("no standby block unless BOTH ends of the window were given", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");
  const p = recurrence.preview(
    { expression: "0 8 * * *", timezone: "UTC", after: now, sleepStartedAt: now - 1000 },
    now,
  );
  assert.equal(p.ok && p.standby, null);
});
