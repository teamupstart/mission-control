import { PLAN_DECISION_LIMITS } from "@shared/protocol.ts";
import type { PlanDecisionAnswer, ReviewItem } from "@shared/types.ts";
import { ordinal, spokenOrdinal, type VoiceFormFill } from "@shared/voice-answers.ts";
import { matchAnswer } from "./questions.ts";
import type { VoiceDecider } from "./decide.ts";
import type { SpokenName } from "@shared/voice-names.ts";

// The display order includes the daemon-appended approval. Use the same labels the
// dashboard prints to recognize punctuation-free transcripts and compound ordinals.
const positions = new Map<string, number>();
for (let i = 1; i <= PLAN_DECISION_LIMITS.decisions; i++) {
  for (const label of [ordinal(i), spokenOrdinal(i), String(i)]) positions.set(label, i - 1);
}
const positionPattern = [...positions.keys()].sort((a, b) => b.length - a.length).join("|").replaceAll(" ", "[ -]");
const clause = new RegExp("(?:^|(?:,\\s*|\\s+)(?:and\\s+)?)(" + positionPattern + ")\\s+one\\s+", "giu");

export function isFormChoice(words: string) {
  return words.matchAll(clause).next().value?.index === 0;
}

export async function formChoices(review: ReviewItem, words: string, decider: VoiceDecider, target: SpokenName | null, signal: AbortSignal) {
  const starts = [...words.matchAll(clause)];
  if (starts[0]?.index !== 0) return null;
  const selections: PlanDecisionAnswer[] = [];
  for (const [i, start] of starts.entries()) {
    const index = positions.get(start[1]!.toLowerCase().replaceAll("-", " "))!;
    const decision = review.decisions?.[index];
    if (!decision || signal.aborted) return null;
    const answer = words.slice(start.index + start[0].length, starts[i + 1]?.index).trim().replace(/[.!?]+$/u, "");
    if (!answer) return null;
    const choice = /^(?:[a-z]|a[a-z])$/iu.test(answer) ? "option " + answer : answer;
    const result = await matchAnswer({ ...review, decisions: [decision] }, choice, false, decider, target, signal);
    if (!result || result === "matcher-failed" || !result.selections) return null;
    selections.push(...result.selections);
  }
  return selections;
}

export class VoicePlanForms {
  private readonly fills = new Map<string, VoiceFormFill>();
  private readonly observations = new Map<string, {
    timer: NodeJS.Timeout;
    latest: Map<string, { capture: number; sequence: number }>;
  }>();
  private sequence = 0;
  private readonly submits = new Map<string, { reviewId: string; timer: NodeJS.Timeout; refuse(missing?: number): void }>();

  observed(reviewId: string) {
    const previous = this.observations.get(reviewId);
    clearTimeout(previous?.timer);
    const timer = setTimeout(() => {
      this.fills.delete(reviewId);
      this.observations.delete(reviewId);
    }, 600_000).unref();
    this.observations.set(reviewId, { timer, latest: previous?.latest ?? new Map() });
  }

  /** Bind an asynchronous option lookup to this form's lifetime and the order of speech.
   * An older lookup may still fill a different decision, but cannot undo a newer pick. */
  beginFill(reviewId: string, capture: number) {
    const latest = this.observations.get(reviewId)?.latest;
    const sequence = ++this.sequence;
    return (selections: PlanDecisionAnswer[]) => {
      if (!latest || this.observations.get(reviewId)?.latest !== latest) return null;
      const merged = new Map(this.fills.get(reviewId)?.selections.map(s => [s.decisionId, s]));
      const changes: PlanDecisionAnswer[] = [];
      for (const selection of selections) {
        const previous = latest.get(selection.decisionId);
        if (previous && (capture < previous.capture || (capture === previous.capture && sequence < previous.sequence))) continue;
        latest.set(selection.decisionId, { capture, sequence });
        merged.set(selection.decisionId, selection);
        changes.push(selection);
      }
      this.fills.set(reviewId, { reviewId, selections: [...merged.values()] });
      return changes;
    };
  }

  get(reviewId: string) { return this.fills.get(reviewId); }

  request(reviewId: string, refuse: (missing?: number) => void) {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => this.refuse(id), 5000).unref();
    this.submits.set(id, { reviewId, timer, refuse });
    return id;
  }

  take(id: string, reviewId: string) {
    const pending = this.submits.get(id);
    if (!pending || pending.reviewId !== reviewId) return false;
    clearTimeout(pending.timer);
    this.submits.delete(id);
    return true;
  }

  refuse(id: string, missing?: number) {
    const pending = this.submits.get(id);
    if (!pending || !this.take(id, pending.reviewId)) return false;
    pending.refuse(missing);
    return true;
  }

  settled(reviewId: string) {
    this.fills.delete(reviewId);
    clearTimeout(this.observations.get(reviewId)?.timer);
    this.observations.delete(reviewId);
    for (const id of this.submits.keys()) this.take(id, reviewId);
  }

  clear() {
    for (const reviewId of this.observations.keys()) this.settled(reviewId);
    for (const [id, pending] of this.submits) this.take(id, pending.reviewId);
    this.fills.clear();
  }
}
