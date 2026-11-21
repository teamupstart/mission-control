import type { Session, SessionAwaiting, SessionAwaitingWakeSource } from "@shared/types.ts";
import { isAwaiting } from "@shared/session.ts";

/**
 * The dashboard's one reading of a declared wait (`Session.awaiting`): which sessions are
 * awaiting, in what order, and the words and numbers the card, the rail and the Conversation
 * band print. Every surface reads it from here so a card, its rail row and its band cannot
 * disagree about whether a wait is overdue or how long is left.
 */

/** No awaiting sessions: the default, which reproduces the fleet order before waits existed. */
export const NO_AWAITING_SESSIONS: ReadonlySet<string> = new Set();

/** Each wake source as a short noun, for hover copy. */
export const AWAITING_WAKE_LABELS: Record<SessionAwaitingWakeSource, string> = {
  command: "background command",
  monitor: "monitor",
  wakeup: "scheduled wakeup",
  other: "own signal",
};

/** Each wake source as the clause the Conversation band prints after the wait. */
export const AWAITING_WAKE_PHRASES: Record<SessionAwaitingWakeSource, string> = {
  command: "wakes when its background command finishes",
  monitor: "wakes when its monitor reports",
  wakeup: "wakes at its scheduled wakeup",
  other: "wakes on its own",
};

/**
 * The sessions inside a declared wait at `now`, which is the set the Idle column draws under
 * its Awaiting rule. An overdue wait is not in it: leaving the group is how an overdue card
 * says so. Empty while the preview is off, so a stale frame never draws the section.
 *
 * A join over the sessions rather than a property the ordering reads off each one, for the
 * reason `heldSessionIds` is: the answer depends on something outside a Session (the clock and
 * the flag), and `orderSessions` stays pure by being handed it.
 */
export function awaitingSessionIds(
  sessions: readonly Session[],
  enabled: boolean,
  now: number,
): ReadonlySet<string> {
  if (!enabled) return NO_AWAITING_SESSIONS;
  let ids: Set<string> | null = null;
  for (const s of sessions) {
    if (!isAwaiting(s, now)) continue;
    (ids ??= new Set()).add(s.id);
  }
  return ids ?? NO_AWAITING_SESSIONS;
}

/**
 * `next` when its members differ from `previous`, else `previous` itself. The awaiting set is
 * recomputed on every clock tick while a wait stands (an overdue one included), and a new Set of
 * the same ids would rerun every memo keyed on it and redraw every card for nothing.
 */
export function keepAwaitingIds(previous: ReadonlySet<string>, next: ReadonlySet<string>): ReadonlySet<string> {
  if (previous === next) return previous;
  if (previous.size !== next.size) return next;
  for (const id of next) if (!previous.has(id)) return next;
  return previous;
}

/** Whether any session declared a wait, so a view knows to keep a clock running. */
export function anyAwaiting(sessions: readonly Session[], enabled: boolean): boolean {
  return enabled && sessions.some((s) => s.awaiting != null);
}

/** Soonest due first, then the oldest wait: the order the Awaiting section reads in. */
export function byAwaitingDue(a: Session, b: Session): number {
  return (a.awaiting?.expectedBy ?? Infinity) - (b.awaiting?.expectedBy ?? Infinity)
    || (a.awaiting?.startedAt ?? 0) - (b.awaiting?.startedAt ?? 0);
}

/**
 * `12m`, `1h 05m`: the compact duration every awaiting surface prints. Time LEFT rounds up, so
 * "due in under a minute" never reads as "0m left"; time elapsed rounds down, as a clock does,
 * and reads at least a minute.
 */
export function awaitingDuration(ms: number, round: "up" | "down" = "down"): string {
  const m = Math.max(1, round === "up" ? Math.ceil(ms / 60_000) : Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** `3:40 PM`, in the operator's locale. */
export function awaitingClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Everything a surface draws about one wait at one instant. */
export interface AwaitingReading {
  overdue: boolean;
  /** How far through the declared window, 0 to 1. 1 once overdue. */
  progress: number;
  /** While waiting, the share of the bar past the deadline is 0; overdue, how much it overran. */
  overrun: number;
  /** `9m left` or `8m late`. */
  remaining: string;
  /** How long since the wait was first declared. */
  age: string;
  /** `3:40 PM`. */
  due: string;
  /** `3:19 PM`. */
  since: string;
  wake: string;
  /** `wakes when its background command finishes`. */
  wakePhrase: string;
}

export function readAwaiting(awaiting: SessionAwaiting, now: number): AwaitingReading {
  const window = Math.max(1, awaiting.expectedBy - awaiting.startedAt);
  const overdue = now >= awaiting.expectedBy;
  const late = now - awaiting.expectedBy;
  return {
    overdue,
    progress: overdue ? 1 : Math.min(1, Math.max(0, (now - awaiting.startedAt) / window)),
    // The overrun is drawn as a share of the whole bar, capped so a wait hours late still
    // leaves the declared window readable to its left.
    overrun: overdue ? Math.min(0.5, late / (window + late)) : 0,
    remaining: overdue ? `${awaitingDuration(late)} late` : `${awaitingDuration(awaiting.expectedBy - now, "up")} left`,
    age: awaitingDuration(now - awaiting.startedAt),
    due: awaitingClock(awaiting.expectedBy),
    since: awaitingClock(awaiting.startedAt),
    wake: AWAITING_WAKE_LABELS[awaiting.wakeSource],
    wakePhrase: AWAITING_WAKE_PHRASES[awaiting.wakeSource],
  };
}

/** The hover sentence a card's or rail row's wait carries. */
export function awaitingTitle(awaiting: SessionAwaiting, now: number): string {
  const r = readAwaiting(awaiting, now);
  return r.overdue
    ? `Overdue: ${awaiting.what}. Declared at ${r.since} and due at ${r.due}, ${r.remaining}. Idle automation and the stuck-session alerts apply again.`
    : `Awaiting ${awaiting.what}; it ${r.wakePhrase}. Declared at ${r.since}, due at ${r.due} (${r.remaining}). Idle automation leaves it alone until then.`;
}
