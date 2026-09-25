import type { PendingTurn, Session, SteeredTurn, TranscriptMessage } from "./types.ts";
import { canInterrupt, capabilitiesFor } from "./harness-capabilities.ts";

/**
 * One policy, applied to every message, instead of a choice the operator has to make before
 * every send: wait for the current turn, steer into it after a minute, interrupt after three.
 *
 * Both deadlines are measured from the moment the message was queued, never from the latest
 * output, so a turn that keeps talking cannot postpone them. A message still leaves the
 * outbox the ordinary way the instant the session reports settled idle - the escalation only
 * describes what happens to a message a running turn has kept waiting.
 */
export const MESSAGE_STEER_AFTER_MS = 60_000;
export const MESSAGE_INTERRUPT_AFTER_MS = 180_000;

/**
 * Persisted identifiers: append only. A queued row carries `after-turn`, which now means the
 * policy above; `steer` and `interrupt-after-wait` mark a row an operator expedited by hand
 * from the queue, and act at the instant recorded with them. `steer-after-wait` is only ever
 * read: databases written while the composer offered a delivery selector still contain it,
 * and such a row follows the standard policy, whose first stage it already described.
 */
export const MESSAGE_DELIVERY_MODES = [
  "after-turn", "steer", "steer-after-wait", "interrupt-after-wait",
] as const;
export type MessageDeliveryMode = (typeof MESSAGE_DELIVERY_MODES)[number];

/** What a message may do to a turn that is already running. */
export type MessageDeliveryAction = "steer" | "interrupt";

export function canSteerMessage(session: Pick<Session, "agent" | "runtime">): boolean {
  return capabilitiesFor(session.agent).steering?.runtimes.includes(session.runtime) ?? false;
}

export function supportsDeliveryAction(
  session: Pick<Session, "agent" | "runtime">,
  action: MessageDeliveryAction,
): boolean {
  return action === "steer" ? canSteerMessage(session) : canInterrupt(session.agent, session.runtime);
}

/** The operator's explicit action on a queued row, which acts at its own recorded instant. */
export function expeditedDelivery(turn: PendingTurn): MessageDeliveryAction | null {
  if (turn.deadlineAt == null) return null;
  if (turn.deliveryMode === "steer") return "steer";
  if (turn.deliveryMode === "interrupt-after-wait") return "interrupt";
  return null;
}

/**
 * Every instant this message may act on a running turn, earliest first, filtered to what the
 * harness and runtime can actually do. A session that can neither steer nor be interrupted
 * has an empty schedule and waits for the next turn, exactly as it always did.
 */
export function deliverySchedule(
  session: Pick<Session, "agent" | "runtime">,
  turn: PendingTurn,
): { at: number; action: MessageDeliveryAction }[] {
  const expedited = expeditedDelivery(turn);
  if (expedited) {
    return supportsDeliveryAction(session, expedited) ? [{ at: turn.deadlineAt!, action: expedited }] : [];
  }
  return ([["steer", MESSAGE_STEER_AFTER_MS], ["interrupt", MESSAGE_INTERRUPT_AFTER_MS]] as const)
    .filter(([action]) => supportsDeliveryAction(session, action))
    .map(([action, delay]) => ({ at: turn.createdAt + delay, action }));
}

/** What this message would do now: the latest stage already due, else the next one coming. */
export function deliveryStage(
  session: Pick<Session, "agent" | "runtime">,
  turn: PendingTurn,
  now: number,
): { at: number; action: MessageDeliveryAction } | null {
  const schedule = deliverySchedule(session, turn);
  const due = schedule.filter((stage) => stage.at <= now);
  return due.at(-1) ?? schedule[0] ?? null;
}

export const MESSAGE_WAIT_NOTICE_MS = 30_000;
export const MESSAGE_INTERRUPT_WATCHDOG_MS = 10_000;

/**
 * How far a transcript clock may trail the daemon's and still be the steer it records.
 * Both are this machine's clock; the slack only absorbs the write landing a moment before
 * the driver's acknowledgement returns.
 */
const STEER_RECEIPT_SKEW_MS = 5_000;

function comparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The transcript turn that shows this steered message was read, or null while none does.
 *
 * An agent writes a user message to its transcript when it takes it, so that line is the
 * receipt. The daemon runs this over what the transcript appended since the steer was
 * accepted and retires the steer on a match; the dashboard runs the same rule only to label
 * the turn that replaced a retired row. One definition, so the two can never disagree.
 * `includes` rather than equality because a harness may wrap what it records around the
 * text it was given. A turn older than the steer is an earlier message that happens to say
 * the same thing ("yes"), and is never taken for it.
 */
export function steeredTurnReceipt(
  turn: SteeredTurn,
  messages: readonly TranscriptMessage[],
): string | null {
  const wanted = comparableText(turn.text);
  if (!wanted) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (message.ts && message.ts < turn.acceptedAt - STEER_RECEIPT_SKEW_MS) continue;
    if (comparableText(message.text).includes(wanted)) return message.id;
  }
  return null;
}
