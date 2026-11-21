// "Remind me later" on a `request_input` question, said once for both sides.
//
// Browser-safe: no `node:` import may reach this module. The daemon validates and stores a
// snooze with these delays and modes, the MCP tool result the agent reads is written here, and
// the dashboard draws its sheet and its reminder from the same words, so the operator and the
// agent are never told two different things about one choice.

import type { PlanDecisionOption, ReviewItem, ReviewSnooze, ReviewSnoozeMode } from "./types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The delays the operator picks from. Only the id crosses the wire; the daemon owns the clock
 * and adds `ms` to its own `Date.now()`, so a browser with a skewed clock cannot park a question
 * for longer or shorter than it says.
 */
export const REVIEW_SNOOZE_DELAYS = [
  { id: "15m", label: "15 minutes", short: "15 min", ms: 15 * MINUTE },
  { id: "1h", label: "1 hour", short: "1 hr", ms: HOUR },
  { id: "2h", label: "2 hours", short: "2 hr", ms: 2 * HOUR },
  { id: "4h", label: "4 hours", short: "4 hr", ms: 4 * HOUR },
  { id: "1d", label: "1 day", short: "1 day", ms: 24 * HOUR },
] as const;

export type ReviewSnoozeDelay = (typeof REVIEW_SNOOZE_DELAYS)[number];
export type ReviewSnoozeDelayId = ReviewSnoozeDelay["id"];
export const REVIEW_SNOOZE_DELAY_IDS = REVIEW_SNOOZE_DELAYS.map((d) => d.id) as [
  ReviewSnoozeDelayId,
  ...ReviewSnoozeDelayId[],
];
/** What the sheet starts on: long enough to step away, short enough to come back today. */
export const DEFAULT_REVIEW_SNOOZE_DELAY: ReviewSnoozeDelayId = "1h";

export function reviewSnoozeDelay(id: ReviewSnoozeDelayId): ReviewSnoozeDelay {
  return REVIEW_SNOOZE_DELAYS.find((d) => d.id === id)!;
}

/** What the operator chose for the agent to do meanwhile, as the snooze route takes it. */
export type ReviewSnoozeMeanwhile =
  | { mode: "judgment" }
  | { mode: "hold" }
  | { mode: "option"; optionId: string };

/** Whether this question offers "Remind me later" right now. */
export function canSnoozeReview(review: ReviewItem): boolean {
  return review.snoozable === true && review.status === "pending";
}

/**
 * The options the agent can be told to carry on with: the question's own, in its order.
 * Empty for an open-ended question, which can still be snoozed on best judgment or held.
 */
export function provisionalOptions(review: Pick<ReviewItem, "decisions">): readonly PlanDecisionOption[] {
  return review.decisions?.[0]?.options ?? [];
}

/** Why a `meanwhile` cannot apply to this question, or null when it can. */
export function snoozeMeanwhileProblem(
  review: ReviewItem,
  meanwhile: ReviewSnoozeMeanwhile,
): string | null {
  if (meanwhile.mode !== "option") return null;
  return provisionalOptions(review).some((o) => o.id === meanwhile.optionId)
    ? null
    : "the provisional answer is not one of this question's options";
}

function optionLabel(review: Pick<ReviewItem, "decisions">, optionId: string | null): string | null {
  if (!optionId) return null;
  return provisionalOptions(review).find((o) => o.id === optionId)?.label ?? null;
}

/**
 * The `judgment` choice, as the sheet and every later line name it for a message-mode question
 * (`async-input`). Its agent never waited: it filed the question and said what it would do
 * meanwhile, so the default is to let it keep doing that, which sends it nothing. The mode id
 * stays `judgment`; only the words differ.
 */
export const KEEP_DOING_WHAT_IT_SAID = "Keep doing what it said";

/**
 * What the agent was told to do meanwhile, as the operator reads it on the reminder and in the
 * inbox. An option that no longer resolves falls back to best judgment, which is what the agent
 * would have been told for a question with nothing to carry on with.
 */
export function snoozeMeanwhileLabel(
  review: Pick<ReviewItem, "decisions" | "waitMode">,
  snooze: Pick<ReviewSnooze, "mode" | "optionId">,
): string {
  const label = snooze.mode === "option" ? optionLabel(review, snooze.optionId) : null;
  if (label) return `Go with "${label}" for now`;
  if (snooze.mode === "hold") return "Hold work that depends on this";
  return review.waitMode === "message" ? KEEP_DOING_WHAT_IT_SAID : "Use its best judgment";
}

/** The past-tense line the returned question carries: what the agent has been doing. */
export function snoozeMeanwhileSince(
  review: Pick<ReviewItem, "decisions" | "waitMode">,
  snooze: Pick<ReviewSnooze, "mode" | "optionId">,
): string {
  const label = snooze.mode === "option" ? optionLabel(review, snooze.optionId) : null;
  if (label) return `The agent has kept working with "${label}" as a provisional answer.`;
  if (snooze.mode === "hold") return "The agent has held the work that depends on this and carried on with the rest.";
  return review.waitMode === "message"
    ? "The agent has kept doing what it said it would when it asked."
    : "The agent has kept working on its best judgment.";
}

/** "15 minutes", "1 hour", "about 3 hours", "1 day" - the coarse figure an agent needs. */
export function describeSnoozeWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes < 24 * 60) {
    const hours = minutes / 60;
    const whole = Math.round(hours);
    return `${Number.isInteger(hours) ? "" : "about "}${whole} hour${whole === 1 ? "" : "s"}`;
  }
  const days = minutes / (24 * 60);
  const whole = Math.round(days);
  return `${Number.isInteger(days) ? "" : "about "}${whole} day${whole === 1 ? "" : "s"}`;
}

const MEANWHILE_INSTRUCTION: Record<ReviewSnoozeMode, (label: string | null) => string> = {
  judgment: () =>
    "Where your work depends on this question, proceed on your best judgment (the recommended " +
    "option, if one was offered), keep that choice easy to reverse, and say in your next update " +
    "which assumption you made.",
  option: (label) =>
    `The operator chose "${label}" as a provisional answer. Proceed with it for now and keep ` +
    "that choice easy to reverse; they will confirm or change it when the question comes back.",
  hold: () =>
    "Do not do any work that depends on this answer. Continue with every other part of your " +
    "task. If nothing else remains, say what is waiting on this question and end your turn.",
};

/**
 * The tool result a snoozed `request_input` call returns.
 *
 * The question is NOT answered, and the text says so before anything else, so an agent cannot
 * read the deferral as a decision. It then says exactly one thing about the work, the mode the
 * operator chose, and closes on the two rules that keep a snooze from turning into a second
 * card: do not ask again, and expect the answer as a message.
 */
export function snoozedToolResultText(review: ReviewItem, now = Date.now()): string {
  const snooze = review.snooze;
  const wait = snooze ? describeSnoozeWait(snooze.until - now) : "a while";
  const label = snooze?.mode === "option" ? optionLabel(review, snooze.optionId) : null;
  const mode: ReviewSnoozeMode = snooze?.mode === "option" && !label ? "judgment" : (snooze?.mode ?? "judgment");
  return [
    `Not answered yet: the operator chose "Remind me later" for this question, and Mission Control will ask them again in ${wait}. Nothing is waiting on you.`,
    `Do not wait for the answer. Continue your original task now. ${MEANWHILE_INSTRUCTION[mode](label)}`,
    "Do not ask this question again yourself: Mission Control asks the operator again. When they answer, the answer arrives as a message in this conversation; reconcile your work with it then.",
  ].join("\n\n");
}

/**
 * The message that carries a snooze's "carry on" instruction when the agent's `request_input`
 * call had already ended before the operator chose, so there was no tool result to put it in.
 * It names the question, says the call it answers is over, and then says exactly what the tool
 * result would have said.
 */
export function snoozedInstructionText(review: ReviewItem, now = Date.now()): string {
  return (
    `Your earlier request_input question "${review.title}" (Mission Control review ${review.id}) ` +
    "ended before the operator chose, and they have now chosen \"Remind me later\". " +
    `Treat this as that call's result:\n\n${snoozedToolResultText(review, now)}`
  );
}

/**
 * The lead line of the message that carries a snoozed question's eventual answer, in place of
 * the generic "answered after its MCP wait ended" - which would read as the result of a call the
 * agent is no longer making, when what it needs to hear is that this settles work it already did.
 */
export function snoozedContinuationLead(review: ReviewItem): string {
  const verb = review.status === "dismissed" ? "dismissed" : "answered";
  const keep = review.status === "dismissed"
    ? " Keep what you chose meanwhile."
    : " Reconcile what you did meanwhile with it:";
  return `The operator has now ${verb} the question you were told to carry on without (Mission Control review ${review.id}, which they chose "Remind me later" on).${keep}`;
}
