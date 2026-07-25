import { CronExpressionParser } from "cron-parser";
import {
  SCHEDULE_BETWEEN_MAX,
  SCHEDULE_CRON_FIELD_COUNT,
  SCHEDULE_MIN_INTERVAL_MAX_PROBE,
  SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULE_MIN_INTERVAL_SPAN_MS,
  clampPreviewCount,
  cronFieldCount,
  normalizeCronExpression,
} from "@shared/schedules.ts";
import type {
  SchedulePreviewInput,
  SchedulePreviewInstant,
  SchedulePreviewResult,
  ScheduleStandbySimulation,
  ScheduleValidation,
} from "@shared/schedules.ts";

/**
 * The ONE place cron and time zones are calculated.
 *
 * `cron-parser` is imported here and nowhere else, deliberately: the moment a second
 * caller reaches it, "when is this due?" has two answers that agree only by luck, and a
 * DST bug in one of them is invisible in the other's tests. Everything downstream - the
 * scheduler loop, Run now, the preview route, the browser - consumes this module's
 * results and does no date arithmetic of its own.
 *
 * The library answers questions; it never schedules anything. No callback, no timer, no
 * subscription. The database cursor decides when work is due and this decides what
 * instant that is.
 *
 * Two of its behaviours are load-bearing and were MEASURED against 5.6.2, not read off
 * the README:
 *  - it accepts three, four, five AND six fields. Six-field seconds syntax parses
 *    silently, so an operator's `0 0 8 * * *` would be read as "every second of the
 *    eighth minute". The field count is checked here, before the parser sees the string.
 *  - it does not validate the time zone at all. `Not/AZone` parses and quietly computes
 *    in UTC. `Intl.DateTimeFormat` is what rejects it.
 */

/** Only the parts of the parser this module uses, so a test can supply its own. */
export interface RecurrenceEvaluator {
  /**
   * Check a cadence, and canonicalize both halves of it.
   *
   * `at` is the anchor the minimum-interval probe runs from; it defaults to now and
   * exists so tests pin an instant rather than racing the clock.
   */
  validate(expression: string, timezone: string, at?: number): ScheduleValidation;
  /**
   * The first instant strictly after `instant`, or null when there is none this build
   * can compute - an unreadable cadence, or one that never comes due again.
   *
   * Null is the cursor's "leave it where it was and mark the schedule for attention";
   * it is never read as "run now".
   */
  nextAfter(expression: string, timezone: string, instant: number): number | null;
  /** Instants in `(afterExclusive, throughInclusive]`, oldest first, bounded by `limit`. */
  between(
    expression: string,
    timezone: string,
    afterExclusive: number,
    throughInclusive: number,
    limit: number,
  ): number[];
  /** Non-mutating: what this cadence would do next, and what a standby window would miss. */
  preview(input: SchedulePreviewInput, now: number): SchedulePreviewResult;
}

/**
 * Resolve a time zone to its canonical IANA id, or null if it is not one.
 *
 * Doubles as the validator, because `Intl` is the only thing on either side of the wire
 * that knows the zone database. Canonicalizing rather than merely accepting is what makes
 * the stored value stable: `utc` persists as `UTC` and `US/Pacific` as
 * `America/Los_Angeles`, so two schedules typed differently sort and render the same.
 */
function canonicalTimezone(timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Formatters are cached per zone: building one is the expensive half of asking for an
 * offset, and a 50-instant preview asks 50 times for the same zone.
 */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormatters.set(timeZone, f);
  }
  return f;
}

/**
 * Minutes east of UTC in `timeZone` at `at` - EDT is -240, IST is +330.
 *
 * Read off `longOffset` ("GMT-04:00") rather than reconstructed from formatted date
 * parts: the parts route has to reason about hour 24, the 12/24-hour toggle and the
 * calendar rolling over, and every one of those is a place to be quietly wrong by an hour
 * exactly on the transition this exists to describe.
 */
export function zoneOffsetMinutes(at: number, timeZone: string): number {
  const name = offsetFormatterFor(timeZone)
    .formatToParts(new Date(at))
    .find((p) => p.type === "timeZoneName")?.value;
  if (!name) return 0;
  // "GMT" alone is the zero offset; anything else is "GMT+HH:MM" or "GMT-HH:MM".
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/**
 * Pull up to `limit` instants after `after`, optionally stopping at `through`.
 *
 * The one place `cron-parser` is actually driven. `hasNext()` is checked before every
 * `next()` because at the end of a computable range `next()` THROWS ("Out of the time
 * span range") rather than returning nothing - measured, and the reason a bare `for` loop
 * here would turn an ordinary empty window into a 500.
 *
 * The upper bound is enforced here rather than with the parser's `endDate`. Measured
 * against 5.6.2, `endDate` can omit an instant within a second of the bound, depending
 * non-monotonically on both the expression and `currentDate`; padding it cannot make the
 * `(after, through]` contract reliable. Comparing the returned millisecond timestamps
 * makes the inclusive upper bound exact.
 *
 * The lower bound remains the parser's `currentDate`, which is strictly exclusive to the
 * millisecond and is also the behavior `nextAfter` depends on.
 *
 * `truncated` is honest rather than inferred from the length: one extra instant is
 * requested and dropped, so a window holding exactly `limit` instants does not claim to
 * have held more. A window that ends because the cadence left it is not truncated at all.
 */
function enumerate(
  expression: string,
  timezone: string,
  after: number,
  through: number | null,
  limit: number,
): { instants: number[]; truncated: boolean } {
  if (limit <= 0) return { instants: [], truncated: false };
  if (through !== null && through <= after) return { instants: [], truncated: false };
  try {
    const it = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: new Date(after),
    });
    const instants: number[] = [];
    while (instants.length <= limit && it.hasNext()) {
      const at = it.next().toDate().getTime();
      if (through !== null && at > through) break;
      instants.push(at);
    }
    const truncated = instants.length > limit;
    if (truncated) instants.pop();
    return { instants, truncated };
  } catch {
    // Every throw this can produce is "that cadence is not computable" - a malformed
    // field, an explicit day that no month has, a range walked off its end. The caller
    // that needs the sentence calls `validate`; the callers here need a value.
    return { instants: [], truncated: false };
  }
}

/**
 * The smallest gap this cadence ever puts between two runs, and whether it fires at all.
 *
 * Enumerates until a whole day has been traversed rather than sampling a fixed number of
 * instants - see `SCHEDULE_MIN_INTERVAL_SPAN_MS` for why one day is provably every gap a
 * five-field expression can produce, and for what the measurement says about the sample
 * this replaced.
 *
 * Stops early on the first gap under the minimum, because that is already the answer -
 * which is what keeps a dense expression from paying for the full traversal.
 */
function probeCadence(
  expression: string,
  timezone: string,
  after: number,
): { fires: boolean; smallestGap: number | null } {
  try {
    const it = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: new Date(after),
    });
    let count = 0;
    let first: number | null = null;
    let previous: number | null = null;
    let smallest: number | null = null;
    while (count < SCHEDULE_MIN_INTERVAL_MAX_PROBE && it.hasNext()) {
      const at = it.next().toDate().getTime();
      count++;
      if (first === null) first = at;
      if (previous !== null) {
        const gap = at - previous;
        if (smallest === null || gap < smallest) smallest = gap;
        if (gap < SCHEDULE_MIN_INTERVAL_MS) break;
      }
      previous = at;
      if (at - first > SCHEDULE_MIN_INTERVAL_SPAN_MS) break;
    }
    return { fires: count > 0, smallestGap: smallest };
  } catch {
    return { fires: false, smallestGap: null };
  }
}

export const recurrence: RecurrenceEvaluator = {
  validate(expression, timezone, at = Date.now()) {
    const zone = canonicalTimezone(timezone);
    if (zone === null) {
      return {
        ok: false,
        error: { field: "timezone", message: `"${timezone}" is not an IANA time zone name.` },
      };
    }

    const expr = normalizeCronExpression(expression);
    const fields = cronFieldCount(expr);
    if (fields !== SCHEDULE_CRON_FIELD_COUNT) {
      // The six-field case gets its own sentence because it is the one that PARSES.
      // Told only "expected 5 fields", an operator reads it as pedantry and pads the
      // expression; told seconds are unsupported, they know the cadence they wanted is
      // not available at all.
      const message =
        fields > SCHEDULE_CRON_FIELD_COUNT
          ? "Use five fields (minute hour day-of-month month day-of-week). Seconds are not " +
            "supported - one minute is the smallest unit a schedule can name."
          : `Use five fields (minute hour day-of-month month day-of-week); this has ${fields}.`;
      return { ok: false, error: { field: "expression", message } };
    }

    const { fires, smallestGap } = probeCadence(expr, zone, at);
    if (!fires) {
      return {
        ok: false,
        error: { field: "expression", message: "This expression never comes due." },
      };
    }

    if (smallestGap !== null && smallestGap < SCHEDULE_MIN_INTERVAL_MS) {
      const minutes = Math.max(1, Math.round(smallestGap / 60000));
      return {
        ok: false,
        error: {
          field: "expression",
          message:
            `This would run every ${minutes} minute${minutes === 1 ? "" : "s"}. The minimum ` +
            "interval is 60 minutes, so one mistyped field cannot file hundreds of agent tasks.",
        },
      };
    }

    return { ok: true, expression: expr, timezone: zone };
  },

  nextAfter(expression, timezone, instant) {
    const zone = canonicalTimezone(timezone);
    if (zone === null) return null;
    const expr = normalizeCronExpression(expression);
    if (cronFieldCount(expr) !== SCHEDULE_CRON_FIELD_COUNT) return null;
    const { instants } = enumerate(expr, zone, instant, null, 1);
    return instants[0] ?? null;
  },

  between(expression, timezone, afterExclusive, throughInclusive, limit) {
    const zone = canonicalTimezone(timezone);
    if (zone === null) return [];
    const expr = normalizeCronExpression(expression);
    if (cronFieldCount(expr) !== SCHEDULE_CRON_FIELD_COUNT) return [];
    const cap = Math.min(Math.floor(limit), SCHEDULE_BETWEEN_MAX);
    return enumerate(expr, zone, afterExclusive, throughInclusive, cap).instants;
  },

  preview(input, now) {
    // Validated through the same call the save route will make, so a preview can never
    // succeed on a cadence the save would refuse.
    const checked = this.validate(input.expression, input.timezone, input.after ?? now);
    if (!checked.ok) return checked;
    const { expression, timezone } = checked;

    const after = input.after ?? now;
    const count = clampPreviewCount(input.count);
    const { instants } = enumerate(expression, timezone, after, null, count);

    // dstShift compares each instant with the one BEFORE IT IN THIS LIST, so the first
    // is always false. Comparing the first against the anchor instead would flag every
    // preview taken in the days around a transition, which is noise where this is meant
    // to be a pointer at the one row that moved.
    let previousOffset: number | null = null;
    const previewInstants: SchedulePreviewInstant[] = instants.map((at) => {
      const offsetMinutes = zoneOffsetMinutes(at, timezone);
      const dstShift = previousOffset !== null && offsetMinutes !== previousOffset;
      previousOffset = offsetMinutes;
      return { at, offsetMinutes, dstShift };
    });

    let standby: ScheduleStandbySimulation | null = null;
    if (input.sleepStartedAt !== undefined && input.resumedAt !== undefined) {
      const missed = enumerate(
        expression,
        timezone,
        input.sleepStartedAt,
        input.resumedAt,
        SCHEDULE_BETWEEN_MAX,
      );
      standby = {
        sleepStartedAt: input.sleepStartedAt,
        resumedAt: input.resumedAt,
        missed: missed.instants,
        truncated: missed.truncated,
        // The cadence half of the answer, and only that. Which of these instants would
        // actually create work is a missed-policy question, and this module owns no
        // policy - the manager runs `planMissedInstants` over `missed` and fills this in.
        // Null rather than an empty array, so "nobody judged these" cannot be misread as
        // "none of them do anything".
        plan: null,
      };
    }

    // Collisions need the catalog, which this module never reads: it answers questions
    // about one expression, so that a preview costs no schedule query and stays usable
    // from the create form before anything has been saved. The manager fills it.
    return { ok: true, expression, timezone, instants: previewInstants, standby, collisions: [] };
  },
};
