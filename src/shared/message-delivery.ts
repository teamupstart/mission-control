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

/**
 * The turn id prefix of a launch's after-work skills prompt (task shaping's `route` stage), which
 * the daemon writes once the work is complete. Such a row is delivered only when the session
 * settles idle: it asks for work after the work, so steering it into a running turn, or
 * interrupting one for it, would cut across the very turn it follows. An operator who expedites
 * it by hand still can.
 */
export const AFTER_WORK_SKILLS_TURN_PREFIX = "shaping-after-work:";

/** Whether a queued row waits for settled idle and never escalates on the standard clock. */
export function idleOnlyTurn(turn: Pick<PendingTurn, "id">): boolean {
  return turn.id.startsWith(AFTER_WORK_SKILLS_TURN_PREFIX);
}

/** What a message may do to a turn that is already running. */
export type MessageDeliveryAction = "steer" | "interrupt";

/** Addressed speech waits for its own turn; the separate spoken stop command interrupts directly. */
export function canExpediteTurn(turn: Pick<PendingTurn, "spokenWords">): boolean {
  return turn.spokenWords === undefined;
}

export function canSteerMessage(session: Pick<Session, "agent" | "runtime">): boolean {
  return capabilitiesFor(session.agent).steering?.runtimes.includes(session.runtime) ?? false;
}

/**
 * The session fields that decide which delivery actions can reach the running turn.
 * `pendingReviews` is required: a caller that left it out would read as "not waiting on a
 * question" and steer into a turn that cannot read it, so an omission must fail to compile.
 */
export type DeliverySession = Pick<Session, "agent" | "runtime" | "pendingReviews">;

/**
 * Whether the running turn is stopped inside a call that waits on the operator: a call-mode
 * `request_input`, a diff review, or another question counted in `pendingReviews`.
 *
 * A steer joins the running turn, and an agent reads a steered message only between tool calls.
 * While the turn is parked in a call that returns only when a question is answered, a steer sits
 * unread for as long as the question stays open, which can be hours, and nothing escalates it
 * because the outbox already handed it over. Interruption is what reaches that turn.
 */
export function turnWaitsOnQuestion(session: DeliverySession): boolean {
  return session.pendingReviews > 0;
}

/** Whether a steered message would be read by this session's running turn. */
export function canSteerRunningTurn(session: DeliverySession): boolean {
  return canSteerMessage(session) && !turnWaitsOnQuestion(session);
}

export function supportsDeliveryAction(
  session: DeliverySession,
  action: MessageDeliveryAction,
): boolean {
  return action === "steer" ? canSteerRunningTurn(session) : canInterrupt(session.agent, session.runtime);
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
 * has an empty schedule and waits for the next turn, exactly as it always did. A turn stopped
 * on a question (`turnWaitsOnQuestion`) cannot read a steer, so only interruption reaches it.
 */
export function deliverySchedule(
  session: DeliverySession,
  turn: PendingTurn,
): { at: number; action: MessageDeliveryAction }[] {
  if (!canExpediteTurn(turn)) return [];
  const expedited = expeditedDelivery(turn);
  if (expedited && supportsDeliveryAction(session, expedited)) return [{ at: turn.deadlineAt!, action: expedited }];
  // A steer asked for by hand before the turn stopped on a question keeps the standard
  // interruption rather than waiting, unreadable, for a turn that may not end for hours.
  if (expedited && !(expedited === "steer" && canSteerMessage(session))) return [];
  if (idleOnlyTurn(turn)) return [];
  return ([["steer", MESSAGE_STEER_AFTER_MS], ["interrupt", MESSAGE_INTERRUPT_AFTER_MS]] as const)
    .filter(([action]) => supportsDeliveryAction(session, action))
    .map(([action, delay]) => ({ at: turn.createdAt + delay, action }));
}

/** What this message would do now: the latest stage already due, else the next one coming. */
export function deliveryStage(
  session: DeliverySession,
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

/**
 * Whitespace collapsed, and nothing else changed. Harness scaffolding around a user turn is
 * already removed where the transcript is parsed (Claude's `conversationText`, for one), so
 * the text arriving here is what the operator wrote. Stripping anything more would make
 * different messages equal: `use <Suspense> here` is not `use here`.
 */
function comparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether this transcript turn is the agent's record of having read this steer.
 *
 * The WHOLE message must be the steer, not merely contain it. With `includes`, reading
 * "yes please" would also count as reading an earlier, still unread "yes".
 */
function isSteerReceipt(turn: SteeredTurn, wanted: string, message: TranscriptMessage): boolean {
  if (message.role !== "user") return false;
  if (message.ts && message.ts < turn.acceptedAt - STEER_RECEIPT_SKEW_MS) return false;
  return comparableText(message.text) === wanted;
}

/**
 * Pair each steer with the transcript turn that is its receipt.
 *
 * An agent writes a user message to its transcript when it takes it, so that line is the
 * receipt. The daemon runs this over what the transcript appended since a steer was
 * accepted and retires each steer it pairs; the dashboard runs the same rule only to label
 * the turn that replaced a retired row. One definition, so the two can never disagree.
 *
 * Steers are taken in the order given, which is delivery order, and each takes the EARLIEST
 * matching turn nobody has claimed. One turn therefore answers at most one steer: two
 * steers that say the same thing need two turns, because the agent reads them one at a
 * time. `claimed` carries turns an earlier pass already paired, for a caller that reads the
 * same turns again.
 *
 * The match is on the whole message, ignoring only whitespace, so a longer message is never a
 * shorter steer's receipt and a message the operator did not write never retires one. A
 * turn more than a few seconds older than the steer is an earlier message that happens to
 * say the same thing ("yes"), and is never taken for it.
 */
export function assignSteerReceipts(
  turns: readonly SteeredTurn[],
  messages: readonly TranscriptMessage[],
  claimed: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const paired = new Map<string, string>();
  const taken = new Set(claimed);
  for (const turn of turns) {
    const wanted = comparableText(turn.text);
    if (!wanted) continue;
    const hit = messages.find((message) => !taken.has(message.id) && isSteerReceipt(turn, wanted, message));
    if (!hit) continue;
    taken.add(hit.id);
    paired.set(turn.id, hit.id);
  }
  return paired;
}

/**
 * The log with each steer drawn once, when the agent recorded it twice.
 *
 * A message taken mid-turn is written as its own kind of record (`takenMidTurn`). Should
 * the agent also write the same words as a plain user record before it has said anything,
 * both are the one message the operator sent, and drawing two would show it sent twice.
 *
 * The plain record is dropped only while nothing separates the two: an assistant turn in
 * between means the agent answered, so the same words afterwards are the operator saying
 * them again, and both stay. So does a record with a different author. The record kept is
 * the mid-turn one, the record a steer receipt names. Unchanged input comes back by
 * reference.
 */
export function collapseSteerEchoes(messages: TranscriptMessage[]): TranscriptMessage[] {
  let taken: TranscriptMessage | null = null;
  let dropped: Set<TranscriptMessage> | null = null;
  for (const message of messages) {
    if (message.role !== "user") {
      taken = null;
      continue;
    }
    if (message.takenMidTurn) {
      taken = message;
      continue;
    }
    if (taken && taken.origin === message.origin && comparableText(taken.text) === comparableText(message.text)) {
      (dropped ??= new Set()).add(message);
    }
    taken = null;
  }
  return dropped ? messages.filter((message) => !dropped.has(message)) : messages;
}

/** The receipt of one steer on its own, or null while no turn shows it was read. */
export function steeredTurnReceipt(
  turn: SteeredTurn,
  messages: readonly TranscriptMessage[],
): string | null {
  return assignSteerReceipts([turn], messages).get(turn.id) ?? null;
}
