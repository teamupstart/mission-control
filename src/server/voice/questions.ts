import type { OpenCardsReport, VoiceAnswer } from "@shared/voice-answers.ts";
import { optionLetter, voiceFocusClockSkewMs } from "@shared/voice-answers.ts";
import type { ReviewItem } from "@shared/types.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import type { VoiceDecider } from "./decide.ts";

export interface VoiceQuestions {
  pending(): ReviewItem[];
  resolve(answer: VoiceAnswer): Promise<boolean>;
  publish(reviewId: string, answer: VoiceAnswer | null): void;
  removeCompanion(id: string): void;
  open(windowId: string, review: ReviewItem): void;
}

/** Reports belong to a dashboard stream. A reconnect has ten seconds to reclaim its report. */
export class VoiceOpenCards {
  private readonly streams = new Map<string, { floorUs: number; clockOffsetUs: number }>();
  private clockSkewMs = 0;
  private changedAt = 0;
  private latestFocusUs = 0;
  private readonly reports = new Map<string, { report: OpenCardsReport | null; focusAtUs: number; revision: number; clockOffsetUs: number }>();

  constructor(private readonly changed: () => void = () => {}) {}

  connect(windowId: string): () => void {
    // The first observation in this stream happens after the dashboard gets its ID.
    // Freeze the causal lower bound here so HTTP arrival order cannot move it.
    const previous = this.reports.get(windowId);
    this.clockSkewMs = voiceFocusClockSkewMs(this.clockSkewMs);
    const token = { floorUs: this.latestFocusUs, clockOffsetUs: previous?.clockOffsetUs ?? this.clockSkewMs * 1000 };
    const beforeConnect = this.current;
    this.streams.set(windowId, token);
    if (previous) {
      if (this.current !== beforeConnect) this.changedAt = Date.now();
      this.changed();
    }
    return () => {
      if (this.streams.get(windowId) !== token) return;
      const beforeDisconnect = this.current;
      this.streams.delete(windowId);
      if (this.current !== beforeDisconnect) this.changedAt = Date.now();
      // Keep the report for reconnection, but its footer cannot show a live countdown.
      if (this.reports.has(windowId)) this.changed();
      setTimeout(() => {
        if (this.streams.has(windowId)) return;
        if (this.reports.delete(windowId)) this.changed();
      }, 10_000).unref();
    };
  }

  report(report: OpenCardsReport, observedAtUs?: number, revision = 0, withdraw = false): boolean {
    const stream = this.streams.get(report.windowId);
    if (!stream) return false;
    // A new stream cannot have observed focus before it existed. Keep later reports
    // on the same translated clock even if a browser's time has coarser precision.
    if (observedAtUs !== undefined && !this.reports.has(report.windowId) && observedAtUs + stream.clockOffsetUs < stream.floorUs) {
      stream.clockOffsetUs = stream.floorUs + 1 - observedAtUs;
    }
    const focusAtUs = observedAtUs === undefined ? Math.max(Date.now() * 1000, this.latestFocusUs + 1)
      : observedAtUs + stream.clockOffsetUs;
    // A focus transition is dated by the observing dashboard, before HTTP delivery.
    const last = this.reports.get(report.windowId);
    if (last && (focusAtUs < last.focusAtUs || (focusAtUs === last.focusAtUs && revision < last.revision))) return true;
    const previous = this.current;
    // A standalone surface keeps its stream but ceases to be a dashboard. Retain
    // the order of its withdrawal so an in-flight report cannot resurrect its footer.
    this.reports.set(report.windowId, { report: withdraw ? null : report, focusAtUs, revision, clockOffsetUs: stream.clockOffsetUs });
    if (!withdraw && report.focused) this.latestFocusUs = Math.max(this.latestFocusUs, focusAtUs);
    if (this.current !== previous) this.changedAt = Date.now();
    this.changed();
    return true;
  }

  private get current(): OpenCardsReport | undefined {
    let current: OpenCardsReport | undefined;
    for (const { report, focusAtUs } of this.reports.values()) {
      if (!report?.focused || focusAtUs !== this.latestFocusUs || !this.streams.has(report.windowId)) continue;
      if (current) return undefined; // Indistinguishable focus transitions cannot target a reply.
      current = report;
    }
    return current;
  }

  get dashboard(): string | undefined {
    const focused = this.current;
    if (focused) return focused.windowId;
    // A click in the standalone companion can blur the dashboard before the pick arrives.
    // A sole live dashboard can still open a review. Only foreground cards receive replies.
    const live = [...this.reports.values()].flatMap(({ report }) => report && this.streams.has(report.windowId) ? [report.windowId] : []);
    return live.length === 1 ? live[0] : undefined;
  }

  footerOwner(reviewId: string): string | undefined {
    const current = this.current;
    return current?.cards.some(card => card.id === reviewId) ? current.windowId : undefined;
  }

  target(questions: ReviewItem[], capturedAt = Infinity): ReviewItem | undefined {
    if (capturedAt < this.changedAt) return undefined;
    const cards = this.current?.cards ?? [];
    const open = questions.filter(q => cards.some(c => c.id === q.id));
    const focused = open.filter(q => cards.some(c => c.id === q.id && c.focused));
    return open.length === 1 ? open[0] : focused.length === 1 ? focused[0] : undefined;
  }

  clear(): void {
    this.latestFocusUs = 0;
    this.clockSkewMs = voiceFocusClockSkewMs(this.clockSkewMs);
    for (const stream of this.streams.values()) {
      stream.floorUs = 0;
      stream.clockOffsetUs = this.clockSkewMs * 1000;
    }
    this.reports.clear();
  }
}

const smallNumbers = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const smallOrdinals = "zeroth first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth".split(" ");
const tens = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const positions = new Map<string, number>();
for (const [i, word] of smallNumbers.entries()) {
  positions.set(word, i);
  positions.set(smallOrdinals[i]!, i);
}
for (const [i, word] of tens.entries()) {
  const value = (i + 2) * 10;
  positions.set(word, value);
  positions.set(word.slice(0, -1) + "ieth", value);
  for (let unit = 1; unit <= 9; unit++) {
    positions.set(word + " " + smallNumbers[unit], value + unit);
    positions.set(word + " " + smallOrdinals[unit], value + unit);
  }
}

const numberScales = [["trillion", 1e12], ["billion", 1e9], ["million", 1e6], ["thousand", 1000], ["hundred", 100]] as const;

function spokenNumber(value: string, start = 0): number | undefined {
  const small = positions.get(value);
  if (small !== undefined) return small;
  // Larger selectors are still commands when their positions exceed the form's options.
  const words = value.split(" ");
  for (let i = start; i < numberScales.length; i++) {
    const [scale, magnitude] = numberScales[i]!;
    const at = words.findIndex(w => w === scale || w === scale + "th");
    if (at < 0) continue;
    const prefix = words.slice(0, at).join(" ");
    const suffix = words.slice(at + 1).join(" ").replace(/^and /u, "");
    if (words[at] !== scale && suffix) return undefined;
    const leading = !prefix || prefix === "a" ? 1 : spokenNumber(prefix, i + 1);
    const trailing = suffix ? spokenNumber(suffix, i + 1) : 0;
    return leading && trailing !== undefined ? leading * magnitude + trailing : undefined;
  }
  return undefined;
}

export function spokenIndex(words: string): number {
  const value = words.trim().toLowerCase().replace(/[.!?]+$/u, "").replace(/^(?:the |option )/u, "").replace(/-/gu, " ");
  if (/^[a-z]$/u.test(value)) return value.charCodeAt(0) - 97;
  if (/^a[a-z]$/u.test(value)) return 26 + value.charCodeAt(1) - 97;
  if (/^\d+(?:st|nd|rd|th)?$/u.test(value)) return parseInt(value, 10) - 1;
  const number = spokenNumber(value) ?? (value.endsWith(" one") ? positions.get(value.slice(0, -4)) : undefined);
  return (number ?? 0) - 1;
}

/** These commands request a particular option and cannot supply a written answer. */
export function requestedChoice(words: string): number | "recommended" | undefined {
  if (/^go with your recommendation[.!?]*$/iu.test(words)) return "recommended";
  const selector = /^option\s+(.+?)\s*[.!?]*$/iu.exec(words)?.[1];
  if (!selector) return undefined;
  const index = spokenIndex(selector);
  if (index >= 0) return index;
  if (/^(?:zero|0+(?:th)?)$/iu.test(selector)) return -1;
  return undefined;
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
    const exact = options.filter(o => o.label.trim().toLowerCase() === normalized);
    option = exact.length === 1 ? exact[0] : options[index];
    if (!option && index >= 0) return null;
    if (!option && options.length) {
      const result = await decider.ask([{ kind: "option", text: words, prompt: decision.question,
        options: options.map(o => ({ ...o, detail: o.detail ?? "" })) }], { agents: target ? [target.agent] : [], signal }).catch(() => null);
      if (!result || result.failed) return "matcher-failed" as const;
      option = options.find(o => o.id === result.answers[0]?.choice);
    }
  }
  if (!option && !(allowText && decision.allowOther)) return null;
  const selections = [{ decisionId: decision.id, selected: option ? [option.id] : [], other: option ? null : words }];
  return { selections, text: option?.label ?? words, label: option ? optionLetter(options.indexOf(option)) + " · " + option.label : "written reply" };
}
