import type { ReviewItem, Session } from "@shared/types.ts";
import { formatConversationTimestamp } from "./format.ts";

/**
 * When a reminder comes back, as the operator reads it: the clock time, prefixed with
 * "tomorrow" when it falls on the next calendar day. "Remind me later" offers at most a day, so
 * that one word nearly always suffices and a time on the same day needs none. The exception is
 * a day-long snooze taken just before midnight on the night clocks spring forward, which lands
 * two dates ahead; anything past tomorrow is named by its weekday instead.
 *
 * Calendar days are compared in the zone the time is printed in, so the word and the clock can
 * never disagree about which day it is. "Tomorrow" is the next calendar DATE, never now plus
 * 24 hours: across a daylight-saving change a day is 23 or 25 hours long, and the shortcut
 * named the wrong day for reminders near midnight. Locale and zone are injectable for tests.
 */
export function reminderClock(
  at: number,
  now = Date.now(),
  locales?: Intl.LocalesArgument,
  timeZone?: string,
): string {
  const clock = formatConversationTimestamp(at, locales, timeZone);
  // `en-CA` prints the date as YYYY-MM-DD, which both compares and parses as a plain date.
  const day = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  const today = day.format(now);
  const target = day.format(at);
  if (target === today) return clock;
  const [year, month, date] = today.split("-").map(Number);
  // Date arithmetic on a zone-free UTC date, so no offset can move it off the calendar day.
  const tomorrow = new Date(Date.UTC(year!, month! - 1, date! + 1)).toISOString().slice(0, 10);
  if (target === tomorrow) return `tomorrow ${clock}`;
  const weekday = new Intl.DateTimeFormat(locales, { weekday: "short", ...(timeZone ? { timeZone } : {}) });
  return `${weekday.format(at)} ${clock}`;
}

/** One parked question and the live session it belongs to, as the inbox lists it. */
export interface SnoozedQuestion {
  review: ReviewItem;
  session: Session;
}

/**
 * The snoozed questions the inbox lists: those whose session is still here to hear an answer,
 * soonest back first.
 *
 * A session on its way out is left off for the reason the fold leaves its pending questions
 * off: nothing answered there can be delivered, and the daemon settles them as it goes.
 */
export function snoozedQuestions(
  reviews: readonly ReviewItem[],
  sessions: readonly Session[],
): SnoozedQuestion[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out: SnoozedQuestion[] = [];
  for (const review of reviews) {
    if (review.status !== "snoozed") continue;
    const session = byId.get(review.sessionId);
    if (!session || session.state === "exited" || session.state === "stopping") continue;
    out.push({ review, session });
  }
  return out.sort(
    (a, b) =>
      (a.review.snooze?.until ?? 0) - (b.review.snooze?.until ?? 0) ||
      (a.review.id < b.review.id ? -1 : 1),
  );
}
