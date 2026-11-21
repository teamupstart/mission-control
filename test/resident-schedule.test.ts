import assert from "node:assert/strict";
import test from "node:test";
import {
  ResidentScheduleSectionSchema,
  residentActiveWindowAt,
  residentAwakeAt,
  residentNextActiveAt,
  residentScheduleDaysLabel,
  residentScheduleSummary,
  residentSleepingUntil,
} from "../src/shared/resident-schedule.ts";
import { ResidentProfileRevisionSchema, ResidentProfileRevisionRequestSchema } from "../src/shared/residents.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const utc = (iso: string) => Date.parse(iso);
const schedule = (over: Record<string, unknown> = {}) =>
  ResidentScheduleSectionSchema.parse({ enabled: true, timeZone: "UTC", ...over });

test("a revision saved before active hours existed reads as always awake", () => {
  const parsed = ResidentProfileRevisionSchema.parse({ identity: { name: "Old" }, persona: { personaId: "p" } });
  assert.deepEqual(parsed.schedule, { enabled: false, days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timeZone: null });
  assert.equal(residentAwakeAt(parsed.schedule, utc("2027-01-16T03:00:00Z")), true);
  assert.equal(residentSleepingUntil(parsed.schedule, utc("2027-01-16T03:00:00Z"), 0), null);
});

test("Monday to Friday, 09:00 to 17:00: awake inside, asleep outside, next window across the weekend", () => {
  const workday = schedule();
  assert.equal(residentAwakeAt(workday, utc("2027-01-15T09:00:00Z")), true, "the window opens at its start");
  assert.equal(residentAwakeAt(workday, utc("2027-01-15T16:59:59Z")), true);
  assert.equal(residentAwakeAt(workday, utc("2027-01-15T17:00:00Z")), false, "and closes at its end");
  assert.equal(residentAwakeAt(workday, utc("2027-01-16T12:00:00Z")), false, "Saturday sleeps");
  assert.equal(residentNextActiveAt(workday, utc("2027-01-15T17:03:00Z")), utc("2027-01-18T09:00:00Z"));
  assert.equal(residentNextActiveAt(workday, utc("2027-01-15T10:00:00Z")), utc("2027-01-15T10:00:00Z"));
  assert.deepEqual(residentActiveWindowAt(workday, utc("2027-01-15T10:00:00Z")),
    { start: utc("2027-01-15T09:00:00Z"), end: utc("2027-01-15T17:00:00Z") });
});

test("a window ending at or before its start runs past midnight; equal times are the whole day", () => {
  const night = schedule({ days: [5], start: "22:00", end: "06:00" });
  assert.equal(residentAwakeAt(night, utc("2027-01-15T23:00:00Z")), true, "Friday night");
  assert.equal(residentAwakeAt(night, utc("2027-01-16T05:59:00Z")), true, "into Saturday morning");
  assert.equal(residentAwakeAt(night, utc("2027-01-16T06:00:00Z")), false);
  assert.equal(residentNextActiveAt(night, utc("2027-01-16T06:00:00Z")), utc("2027-01-22T22:00:00Z"), "next Friday");
  const allDay = schedule({ days: [0, 6], start: "00:00", end: "00:00" });
  assert.equal(residentAwakeAt(allDay, utc("2027-01-16T00:00:00Z")), true);
  assert.equal(residentAwakeAt(allDay, utc("2027-01-17T23:59:00Z")), true);
  assert.equal(residentAwakeAt(allDay, utc("2027-01-18T00:00:00Z")), false, "Monday is not selected");
});

test("wall-clock hours follow the named time zone through a daylight-saving change", () => {
  const ny = schedule({ timeZone: "America/New_York" });
  // Friday 2026-03-06 is EST (UTC-5); Monday 2026-03-09 is EDT (UTC-4).
  assert.equal(residentNextActiveAt(ny, utc("2026-03-06T22:30:00Z")), utc("2026-03-09T13:00:00Z"));
  assert.equal(residentAwakeAt(ny, utc("2026-03-06T14:00:00Z")), true, "09:00 EST");
  assert.equal(residentAwakeAt(ny, utc("2026-03-06T13:59:00Z")), false);
  assert.equal(residentAwakeAt(ny, utc("2026-03-09T13:00:00Z")), true, "09:00 EDT");
});

test("sleeping-until is the next opening for a due or overdue wake, and nothing while off or in hours", () => {
  const workday = schedule();
  const friday1658 = utc("2027-01-15T16:58:00Z");
  assert.equal(residentSleepingUntil(workday, friday1658 + 5 * 60_000, friday1658), utc("2027-01-18T09:00:00Z"));
  assert.equal(residentSleepingUntil(workday, friday1658 + 60_000, friday1658), null, "16:59 is inside");
  assert.equal(residentSleepingUntil(workday, friday1658 - DAY, utc("2027-01-16T10:00:00Z")), utc("2027-01-18T09:00:00Z"), "overdue counts from now");
  assert.equal(residentSleepingUntil(workday, null, friday1658), null, "no wake, nothing held");
  assert.equal(residentSleepingUntil(workday, friday1658 + HOUR, friday1658, false), null, "the preview gate off holds nothing");
  assert.equal(residentAwakeAt(workday, utc("2027-01-16T10:00:00Z"), false), true);
});

test("the schema refuses an enabled schedule with no days, a repeated day, a bad time and an unknown zone", () => {
  assert.equal(ResidentScheduleSectionSchema.safeParse({ enabled: true, days: [] }).success, false);
  assert.equal(ResidentScheduleSectionSchema.safeParse({ enabled: false, days: [] }).success, true, "off keeps whatever was chosen");
  assert.equal(ResidentScheduleSectionSchema.safeParse({ days: [1, 1] }).success, false);
  assert.equal(ResidentScheduleSectionSchema.safeParse({ start: "24:00" }).success, false);
  assert.equal(ResidentScheduleSectionSchema.safeParse({ end: "9:00" }).success, false);
  assert.equal(ResidentScheduleSectionSchema.safeParse({ timeZone: "Mars/Olympus" }).success, false);
  const request = ResidentProfileRevisionRequestSchema.safeParse({
    identity: { name: "Night" }, persona: { personaId: "p" }, schedule: { enabled: true, days: [] },
  });
  assert.equal(request.success, false);
  assert.match(request.error!.issues[0]!.message, /choose at least one day/);
});

test("labels collapse runs of days and name the zone", () => {
  assert.equal(residentScheduleDaysLabel([1, 2, 3, 4, 5]), "Mon–Fri");
  assert.equal(residentScheduleDaysLabel([1, 3, 5]), "Mon, Wed, Fri");
  assert.equal(residentScheduleDaysLabel([0, 1, 2, 3, 4, 5, 6]), "Every day");
  assert.equal(residentScheduleDaysLabel([6, 0, 1]), "Mon, Sat, Sun");
  assert.equal(residentScheduleSummary(schedule({ timeZone: null }), "Europe/Berlin"), "Mon–Fri, 09:00–17:00 (Europe/Berlin)");
  assert.equal(residentScheduleSummary(schedule({ start: "22:00", end: "06:00" })), "Mon–Fri, 22:00–06:00 (next day) (UTC)");
  assert.equal(residentScheduleSummary(schedule({ enabled: false })), "Always awake");
});

test("an opening is named on the requested clock, with the weekday once it is not today", async () => {
  const { residentWakeOpeningLabel } = await import("../src/shared/resident-schedule.ts");
  const thursday = utc("2026-11-19T15:00:00Z");
  assert.equal(residentWakeOpeningLabel(utc("2026-11-19T17:00:00Z"), thursday, "UTC"), "17:00");
  assert.equal(residentWakeOpeningLabel(utc("2026-11-20T08:30:00Z"), thursday, "UTC"), "Fri 08:30");
  assert.equal(residentWakeOpeningLabel(utc("2026-11-20T08:30:00Z"), thursday, "Asia/Tokyo"), "17:30", "already Friday in Tokyo");
  assert.equal(residentWakeOpeningLabel(utc("2026-11-30T08:30:00Z"), thursday, "UTC"), "Mon 11/30 08:30");
});

test("a start time the spring clock change skips opens when the clock jumps past it, never before", () => {
  // Sunday 2026-03-08 in New York: 02:00 EST (07:00Z) jumps to 03:00 EDT; 02:30 never happens.
  const gap = schedule({ days: [0], start: "02:30", end: "03:30", timeZone: "America/New_York" });
  const saturdayNight = utc("2026-03-08T05:00:00Z"); // 00:00 EST
  assert.equal(residentNextActiveAt(gap, saturdayNight), utc("2026-03-08T07:00:00Z"), "03:00 EDT, the first minute past 02:30");
  assert.equal(residentAwakeAt(gap, utc("2026-03-08T06:30:00Z")), false, "01:30 EST is before the chosen opening");
  assert.equal(residentAwakeAt(gap, utc("2026-03-08T06:59:59Z")), false);
  assert.equal(residentAwakeAt(gap, utc("2026-03-08T07:00:00Z")), true);
  assert.equal(residentAwakeAt(gap, utc("2026-03-08T07:30:00Z")), false, "closes at 03:30 EDT");
  // An end the change skips closes at the jump too, never later than chosen.
  const endsInGap = schedule({ days: [0], start: "01:00", end: "02:30", timeZone: "America/New_York" });
  assert.deepEqual(residentActiveWindowAt(endsInGap, utc("2026-03-08T06:30:00Z")),
    { start: utc("2026-03-08T06:00:00Z"), end: utc("2026-03-08T07:00:00Z") });
  // A repeated autumn time opens at its first occurrence: 01:30 EDT on 2026-11-01.
  const repeated = schedule({ days: [0], start: "01:30", end: "04:00", timeZone: "America/New_York" });
  assert.equal(residentNextActiveAt(repeated, utc("2026-11-01T04:00:00Z")), utc("2026-11-01T05:30:00Z"));
});

test("a skipped start opens at the jump in zones far east of UTC too, never before", () => {
  // Auckland, Sunday 2026-09-27: 02:00 NZST (UTC+12, 14:00Z Saturday) jumps to 03:00 NZDT (UTC+13).
  const auckland = schedule({ days: [0], start: "02:30", end: "04:00", timeZone: "Pacific/Auckland" });
  const jump = utc("2026-09-26T14:00:00Z");
  assert.equal(residentNextActiveAt(auckland, utc("2026-09-26T11:00:00Z")), jump, "03:00 NZDT, the first minute past 02:30");
  assert.equal(residentAwakeAt(auckland, utc("2026-09-26T13:30:00Z")), false, "01:30 NZST is before the chosen opening");
  assert.equal(residentAwakeAt(auckland, jump - 1), false);
  assert.equal(residentAwakeAt(auckland, jump), true);
  // Chatham, UTC+12:45 to +13:45 at 02:45 local on the same night: 03:00 is skipped.
  const chatham = schedule({ days: [0], start: "03:00", end: "05:00", timeZone: "Pacific/Chatham" });
  assert.equal(residentNextActiveAt(chatham, utc("2026-09-26T11:00:00Z")), jump);
  // And an ordinary day there still resolves exactly: Monday 09:00 NZDT is 20:00Z Sunday.
  const workday = schedule({ timeZone: "Pacific/Auckland" });
  assert.equal(residentNextActiveAt(workday, utc("2026-09-27T12:00:00Z")), utc("2026-09-27T20:00:00Z"));
});
