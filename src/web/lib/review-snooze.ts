import type { ReviewItem, Session } from "@shared/types.ts";
import { formatConversationTimestamp } from "./format.ts";

/**
 * When a reminder comes back, as the operator reads it: the clock time, prefixed with
 * "tomorrow" when it falls on the next calendar day. "Remind me later" offers at most a day, so
 * a later date never needs more than that one word, and a time on the same day needs none.
 *
 * Calendar days are compared in the zone the time is printed in, so the word and the clock can
 * never disagree about which day it is. Locale and zone are injectable for tests.
 */
export function reminderClock(
  at: number,
  now = Date.now(),
  locales?: Intl.LocalesArgument,
  timeZone?: string,
): string {
  const clock = formatConversationTimestamp(at, locales, timeZone);
  const day = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  if (day.format(at) === day.format(now)) return clock;
  const tomorrow = day.format(now + 24 * 60 * 60_000);
  return day.format(at) === tomorrow ? `tomorrow ${clock}` : clock;
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
