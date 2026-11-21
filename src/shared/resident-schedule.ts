// A resident's active hours: the days of the week and the time of day its loop may wake it.
//
// Browser-safe and free of `node:` imports. The daemon's loop and every dashboard surface read
// the same functions here, so "is it asleep, and until when" has one answer.
//
// Outside its active hours a resident keeps running - its session, conversation and task stay
// open - but its loop sends no wake: no loop prompt, no compaction before one, no tokens. A
// wake that falls due while it sleeps is held until the next window opens. A human message,
// Run now and the launch's opening turn are the operator's own and are never held.

import { z } from "zod";

/**
 * The days a schedule may name, in the order the editor draws them: Monday first. `day` is the
 * JavaScript weekday number (`Date#getDay`, Sunday is 0), which is what a stored schedule
 * carries, so this list may be reordered for display but a `day` value never changes.
 */
export const RESIDENT_WEEKDAYS = [
  { day: 1, short: "Mon", label: "Monday" },
  { day: 2, short: "Tue", label: "Tuesday" },
  { day: 3, short: "Wed", label: "Wednesday" },
  { day: 4, short: "Thu", label: "Thursday" },
  { day: 5, short: "Fri", label: "Friday" },
  { day: 6, short: "Sat", label: "Saturday" },
  { day: 0, short: "Sun", label: "Sunday" },
] as const;

/** Monday to Friday: what a new schedule starts with. */
export const RESIDENT_WORKDAYS = [1, 2, 3, 4, 5] as const;

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether this runtime can resolve an IANA time zone name. */
export function isResidentTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The schedule section of a resident profile.
 *
 * `start` and `end` are wall-clock times, `HH:MM`, in `timeZone` (null: the daemon's own local
 * time zone). A window opens at `start` on each selected day. It closes at `end` the same day
 * when `end` is later than `start`; otherwise it runs past midnight and closes at `end` the next
 * day, so `22:00`-`06:00` is a night shift and `00:00`-`00:00` is the whole day.
 */
export const ResidentScheduleSectionSchema = z
  .object({
    enabled: z.boolean().default(false),
    days: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .default([...RESIDENT_WORKDAYS]),
    start: z.string().regex(TIME_OF_DAY, "start must be a time of day, HH:MM").default("09:00"),
    end: z.string().regex(TIME_OF_DAY, "end must be a time of day, HH:MM").default("17:00"),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine(isResidentTimeZone, "time zone must be an IANA time zone, such as America/New_York")
      .nullable()
      .default(null),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.days).size !== value.days.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["days"], message: "a day is selected twice" });
    }
    if (value.enabled && value.days.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["days"], message: "choose at least one day for active hours, or turn active hours off" });
    }
  });
export type ResidentScheduleSection = z.infer<typeof ResidentScheduleSectionSchema>;

/** Minutes after midnight for an `HH:MM` time. */
function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}

interface WallClock { year: number; month: number; day: number; weekday: number; minutes: number }

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(zone, found);
  }
  return found;
}

/** The calendar date and time of day an instant reads as in a zone. */
function wallClock(at: number, zone: string | null): WallClock {
  if (zone === null) {
    const date = new Date(at);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), weekday: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes() };
  }
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(at))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const weekday = new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!)).getUTCDay();
  return { year: parts.year!, month: parts.month!, day: parts.day!, weekday, minutes: parts.hour! * 60 + parts.minute! };
}

/** How far a zone's wall clock (null: this runtime's local clock) is ahead of UTC at an instant, in milliseconds. */
function zoneOffset(at: number, zone: string | null): number {
  if (zone === null) return -new Date(at).getTimezoneOffset() * 60_000;
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(at))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** How far either side of a wall time its zone's offsets are read: past the widest real offset, UTC+14. */
const RESIDENT_ZONE_BRACKET_MS = 36 * 3_600_000;

/**
 * The instant a wall-clock time names in a zone. `minutes` may pass midnight; the date rolls on.
 *
 * A time a daylight-saving change repeats resolves to its first occurrence. A time a change
 * skips (02:30 on a spring-forward night) resolves to the moment the clock jumps past it, so a
 * window never opens before the time the operator chose: on that night a 02:30 opening is 03:00.
 */
function zonedInstant(year: number, month: number, day: number, minutes: number, zone: string | null): number {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  // The instant this wall time names is `guess` minus the zone's offset, and real offsets run
  // from UTC-12 to UTC+14, so it lies within 14 hours either side of `guess`. Sampling the
  // offsets 36 hours out brackets that whole span, so a clock change anywhere near the answer
  // falls between `before` and `after` - in a UTC+13 zone as much as in New York.
  const before = zoneOffset(guess - RESIDENT_ZONE_BRACKET_MS, zone);
  const after = zoneOffset(guess + RESIDENT_ZONE_BRACKET_MS, zone);
  const valid = [guess - before, guess - after].filter((instant, index) => zoneOffset(instant, zone) === (index === 0 ? before : after));
  if (valid.length > 0) return Math.min(...valid);
  // Skipped: the wall clock reads earlier than the chosen time on one side of the jump and later
  // on the other. Find the jump itself, to the minute every zone transition falls on.
  let lo = Math.min(guess - before, guess - after);
  let hi = Math.max(guess - before, guess - after);
  // The later reading is past the jump, so returning it can only open late, never early.
  if (zoneOffset(lo, zone) !== before || zoneOffset(hi, zone) !== after) return hi;
  while (hi - lo > 60_000) {
    const mid = lo + Math.max(1, Math.floor((hi - lo) / 120_000)) * 60_000;
    if (mid >= hi) break;
    if (zoneOffset(mid, zone) === after) hi = mid; else lo = mid;
  }
  return hi;
}

/** One active window, `[start, end)`, in epoch milliseconds. */
export interface ResidentActiveWindow { start: number; end: number }

/**
 * The windows that could contain or follow `at`: every selected day from the day before `at`
 * (whose overnight window may still be open) through eight days after it, in order.
 */
function windowsAround(schedule: ResidentScheduleSection, at: number): ResidentActiveWindow[] {
  const today = wallClock(at, schedule.timeZone);
  const start = minutesOf(schedule.start);
  const end = minutesOf(schedule.end);
  const length = end > start ? end - start : end - start + 24 * 60;
  const out: ResidentActiveWindow[] = [];
  for (let offset = -1; offset <= 8; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!schedule.days.includes(date.getUTCDay())) continue;
    const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
    out.push({ start: zonedInstant(y, m, d, start, schedule.timeZone), end: zonedInstant(y, m, d, start + length, schedule.timeZone) });
  }
  return out;
}

/** The active window `at` falls in, or null while the resident sleeps. A disabled schedule is always awake. */
export function residentActiveWindowAt(schedule: ResidentScheduleSection, at: number): ResidentActiveWindow | null {
  if (!schedule.enabled) return { start: -Infinity, end: Infinity };
  return windowsAround(schedule, at).find((window) => window.start <= at && at < window.end) ?? null;
}

/**
 * The earliest instant at or after `at` inside the active hours: `at` itself when it is inside,
 * otherwise the next window's opening. Null only for an enabled schedule with no days, which the
 * schema refuses.
 */
export function residentNextActiveAt(schedule: ResidentScheduleSection, at: number): number | null {
  if (residentActiveWindowAt(schedule, at)) return at;
  const next = windowsAround(schedule, at).find((window) => window.start > at);
  return next ? next.start : null;
}

/**
 * When a sleeping resident's held wake will be sent, or null when its next wake is not held.
 *
 * A wake due at `nextWakeAt` (or overdue, so due `now`) inside the active hours is sent as
 * usual. One that falls outside them waits for the next window, and that opening is this
 * answer. `enabled` is the resolved feature gate: off, nothing is ever held.
 */
export function residentSleepingUntil(
  schedule: ResidentScheduleSection | undefined,
  nextWakeAt: number | null,
  now: number,
  enabled = true,
): number | null {
  if (!enabled || !schedule?.enabled || nextWakeAt === null) return null;
  const due = Math.max(nextWakeAt, now);
  const next = residentNextActiveAt(schedule, due);
  return next !== null && next > due ? next : null;
}

/** Whether a scheduled loop wake may be sent at `at`. Run now and human turns never ask. */
export function residentAwakeAt(schedule: ResidentScheduleSection | undefined, at: number, enabled = true): boolean {
  if (!enabled || !schedule?.enabled) return true;
  return residentActiveWindowAt(schedule, at) !== null;
}

/** "Mon–Fri", "Mon, Wed, Fri", "Every day": the selected days, Monday first, runs collapsed. */
export function residentScheduleDaysLabel(days: readonly number[]): string {
  const ordered = RESIDENT_WEEKDAYS.filter((entry) => days.includes(entry.day));
  if (ordered.length === 7) return "Every day";
  if (ordered.length === 0) return "No days";
  const indexes = ordered.map((entry) => RESIDENT_WEEKDAYS.indexOf(entry));
  const runs: string[] = [];
  for (let i = 0; i < ordered.length;) {
    let j = i;
    while (j + 1 < ordered.length && indexes[j + 1] === indexes[j]! + 1) j++;
    runs.push(j - i >= 2 ? `${ordered[i]!.short}–${ordered[j]!.short}` : ordered.slice(i, j + 1).map((entry) => entry.short).join(", "));
    i = j + 1;
  }
  return runs.join(", ");
}

/** One line for a schedule: "Mon–Fri, 09:00–17:00 (America/New_York)". */
export function residentScheduleSummary(schedule: ResidentScheduleSection, localZoneLabel = "local time"): string {
  if (!schedule.enabled) return "Always awake";
  const overnight = minutesOf(schedule.end) <= minutesOf(schedule.start);
  const hours = schedule.start === schedule.end ? "all day" : `${schedule.start}–${schedule.end}${overnight ? " (next day)" : ""}`;
  return `${residentScheduleDaysLabel(schedule.days)}, ${hours} (${schedule.timeZone ?? localZoneLabel})`;
}

/**
 * "Mon 09:00": when a held wake is sent. Read on `zone`'s clock (null: the reader's own), so an
 * editor can name a window in the schedule's zone and a live surface in the operator's.
 */
export function residentWakeOpeningLabel(at: number, now: number, zone: string | null = null): string {
  const when = wallClock(at, zone);
  const today = wallClock(now, zone);
  const time = `${String(Math.floor(when.minutes / 60)).padStart(2, "0")}:${String(when.minutes % 60).padStart(2, "0")}`;
  if (when.year === today.year && when.month === today.month && when.day === today.day) return time;
  const day = RESIDENT_WEEKDAYS.find((entry) => entry.day === when.weekday)!.short;
  return at - now < 6 * 86_400_000 ? `${day} ${time}` : `${day} ${when.month}/${when.day} ${time}`;
}
