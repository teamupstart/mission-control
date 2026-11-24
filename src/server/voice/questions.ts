import type { OpenCardsReport, VoiceAnswer } from "@shared/voice-answers.ts";
import { optionLetter } from "@shared/voice-answers.ts";
import type { ReviewItem } from "@shared/types.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import type { VoiceDecider } from "./decide.ts";

export interface VoiceQuestions {
  pending(): ReviewItem[];
  resolve(answer: VoiceAnswer): Promise<boolean>;
  publish(reviewId: string, answer: VoiceAnswer | null): void;
  open(windowId: string, review: ReviewItem): void;
}

/** Reports belong to a dashboard stream. A reconnect has ten seconds to reclaim its report. */
export class VoiceOpenCards {
  private readonly streams = new Map<string, symbol>();
  private current?: OpenCardsReport;
  private changedAt = 0;

  constructor(private readonly changed: () => void = () => {}) {}

  connect(windowId: string): () => void {
    const token = Symbol();
    this.streams.set(windowId, token);
    return () => {
      if (this.streams.get(windowId) !== token) return;
      this.streams.delete(windowId);
      setTimeout(() => {
        if (this.streams.has(windowId)) return;
        if (this.current?.windowId === windowId) { this.clear(); this.changed(); }
      }, 10_000).unref();
    };
  }

  report(report: OpenCardsReport): boolean {
    if (!this.streams.has(report.windowId)) return false;
    if (report.focused || report.windowId === this.current?.windowId) {
      this.current = report;
      this.changedAt = Date.now();
      this.changed();
    }
    return true;
  }

  get dashboard(): string | undefined { return this.current?.focused && this.streams.has(this.current.windowId) ? this.current.windowId : undefined; }

  target(questions: ReviewItem[], capturedAt = Infinity): ReviewItem | undefined {
    if (capturedAt < this.changedAt) return undefined;
    const cards = this.current?.focused ? this.current.cards : [];
    const open = questions.filter(q => cards.some(c => c.id === q.id));
    const focused = open.filter(q => cards.some(c => c.id === q.id && c.focused));
    return open.length === 1 ? open[0] : focused.length === 1 ? focused[0] : undefined;
  }

  clear(): void { this.current = undefined; }
}

const cardinals = "one two three four five six seven eight nine ten".split(" ");
const ordinals = "first second third fourth fifth sixth seventh eighth ninth tenth".split(" ");

export function spokenIndex(words: string): number {
  const value = words.trim().toLowerCase().replace(/[.!?]+$/u, "").replace(/^(?:the |option )/u, "").replace(/ one$/u, "");
  if (/^[a-z]$/u.test(value)) return value.charCodeAt(0) - 97;
  if (/^a[a-z]$/u.test(value)) return 26 + value.charCodeAt(1) - 97;
  if (/^\d+(?:st|nd|rd|th)?$/u.test(value)) return parseInt(value, 10) - 1;
  return Math.max(ordinals.indexOf(value), cardinals.indexOf(value));
}

/** These commands request a particular option and cannot supply a written answer. */
export function requestedChoice(words: string): number | "recommended" | undefined {
  if (/^go with your recommendation[.!?]*$/iu.test(words)) return "recommended";
  if (!/^option\s+/iu.test(words)) return undefined;
  const index = spokenIndex(words);
  return index >= 0 ? index : undefined;
}

export async function matchAnswer(review: ReviewItem, words: string, allowText: boolean,
  decider: VoiceDecider, target: SpokenName | null, signal: AbortSignal) {
  const decisions = review.decisions ?? [];
  if (decisions.length > 1) return null;
  const decision = decisions[0];
  if (!decision) return allowText ? { selections: null, text: words, label: "written reply" } : null;
  const options = decision.options;
  const normalized = words.trim().toLowerCase().replace(/[.!?]+$/u, "");
  const choice = requestedChoice(words);
  let option;
  if (choice === "recommended") {
    const recommended = options.filter(o => o.recommended);
    if (recommended.length !== 1) return null;
    option = recommended[0];
  } else if (choice !== undefined) {
    option = options[choice];
    if (!option) return null;
  } else {
    const index = spokenIndex(words);
    option = options[index];
    const exact = options.filter(o => o.label.toLowerCase() === normalized);
    if (!option && exact.length === 1) option = exact[0];
    if (!option && index >= 0) return null;
    if (!option && options.length) {
      const result = await decider.ask([{ kind: "option", text: words, prompt: decision.question,
        options: options.map(o => ({ ...o, detail: o.detail ?? "" })) }], { agents: target ? [target.agent] : [], signal }).catch(() => null);
      option = options.find(o => o.id === result?.answers[0]?.choice);
    }
  }
  if (!option && !(allowText && decision.allowOther)) return null;
  const selections = [{ decisionId: decision.id, selected: option ? [option.id] : [], other: option ? null : words }];
  return { selections, text: option?.label ?? words, label: option ? optionLetter(options.indexOf(option)) + " · " + option.label : "written reply" };
}
