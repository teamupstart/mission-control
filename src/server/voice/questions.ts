import type { OpenCardsReport, VoiceAnswer, VoiceTimeBounds } from "@shared/voice-answers.ts";
import { optionLetter, voiceFocusClockSkewMs, voiceReplyState } from "@shared/voice-answers.ts";
import type { ReviewItem } from "@shared/types.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import type { VoiceDecider } from "./decide.ts";

export interface VoiceQuestions {
  pending(): ReviewItem[];
  resolve(answer: VoiceAnswer): Promise<boolean>;
  publish(reviewId: string, answer: VoiceAnswer | null): void;
  removeCompanion(id: string): void;
  open(windowId: string, review: ReviewItem): void;
  confirmFocus(windowId: string, sequence: number): void;
}

interface CardReportTiming {
  focusAtUs?: number;
  revision?: number;
  withdraw?: boolean;
  observation?: VoiceTimeBounds;
  observationId?: number;
  calibrating?: boolean;
  confirmed?: number;
}

// The browser and daemon each round their wall-to-monotonic calibration to milliseconds.
const FOCUS_CLOCK_ROUNDING_US = 2_000;

/** Reports belong to a dashboard stream. A reconnect has ten seconds to reclaim its report. */
export class VoiceOpenCards {
  private readonly streams = new Map<string, { floorUs: number; clockOffsetUs: number; connectedAt: number; browser: boolean }>();
  private clockSkewMs = 0;
  private changedAt = 0;
  private observedAt?: VoiceTimeBounds;
  private replyState?: string;
  private latestFocusUs = 0;
  private readonly reports = new Map<string, { report: OpenCardsReport | null; focusAtUs: number; revision: number; clockOffsetUs: number;
    observation?: VoiceTimeBounds; observationId?: number; receivedAt: number; calibrating?: boolean }>();
  private confirmationSequence = 0;
  private readonly confirmations = new Map<number, { windowId: string; finish: (ok: boolean) => void }>();

  constructor(private readonly changed: () => void = () => {}) {}

  connect(windowId: string, browser = false): () => void {
    // The first observation in this stream happens after the dashboard gets its ID.
    // Freeze the causal lower bound here so HTTP arrival order cannot move it.
    const previous = this.reports.get(windowId);
    this.clockSkewMs = voiceFocusClockSkewMs(this.clockSkewMs);
    const token = { floorUs: this.latestFocusUs, clockOffsetUs: previous?.clockOffsetUs ?? this.clockSkewMs * 1000, connectedAt: performance.now(), browser };
    this.streams.set(windowId, token);
    if (previous) this.reportChanged();
    return () => {
      if (this.streams.get(windowId) !== token) return;
      this.streams.delete(windowId);
      for (const request of this.confirmations.values()) if (request.windowId === windowId) request.finish(false);
      // Keep the report for reconnection, but its footer cannot show a live countdown.
      if (this.reports.has(windowId)) this.reportChanged();
      setTimeout(() => {
        if (this.streams.has(windowId)) return;
        if (this.reports.delete(windowId)) this.changed();
      }, 10_000).unref();
    };
  }

  report(report: OpenCardsReport, timing: CardReportTiming = {}): boolean {
    const { focusAtUs: observedAtUs, revision = 0, withdraw, observation, observationId, calibrating } = timing;
    const stream = this.streams.get(report.windowId);
    if (!stream) return false;
    // A new stream cannot have observed focus before it existed. Keep later reports
    // on the same translated clock even if a browser's time has coarser precision.
    const offsetUs = observedAtUs !== undefined && !this.reports.has(report.windowId) && observedAtUs + stream.clockOffsetUs < stream.floorUs
      ? stream.floorUs + 1 - observedAtUs : stream.clockOffsetUs;
    const receivedUs = Math.floor((performance.timeOrigin + performance.now()) * 1000);
    const focusAtUs = observedAtUs === undefined ? Math.max(receivedUs, this.latestFocusUs + 1) : observedAtUs + offsetUs;
    if (focusAtUs > receivedUs + FOCUS_CLOCK_ROUNDING_US) return false;
    stream.clockOffsetUs = offsetUs;
    // A focus transition is dated by the observing dashboard, before HTTP delivery.
    const last = this.reports.get(report.windowId);
    if (last && (focusAtUs < last.focusAtUs || (focusAtUs === last.focusAtUs && revision < last.revision))) return true;
    // A standalone surface keeps its stream but ceases to be a dashboard. Retain
    // the order of its withdrawal so an in-flight report cannot resurrect its footer.
    const sameObservation = observationId !== undefined && last?.observationId === observationId;
    const receivedAt = sameObservation ? last.receivedAt : performance.now();
    this.reports.set(report.windowId, { report: withdraw ? null : report, focusAtUs, revision, clockOffsetUs: stream.clockOffsetUs,
      observation, observationId, receivedAt, calibrating });
    if (!withdraw && report.focused) this.latestFocusUs = Math.max(this.latestFocusUs, focusAtUs);
    // The question was already drawn by the first receipt of this observation.
    const clamp = (stamp: number) => Math.max(stream.connectedAt, Math.min(stamp, receivedAt));
    const observedAt = this.current === report && observation
      ? { earliest: clamp(observation.earliest), latest: clamp(observation.latest) }
      : this.current === report && observationId !== undefined
        ? { earliest: calibrating ? stream.connectedAt : receivedAt, latest: receivedAt } : undefined;
    this.reportChanged(observedAt, observationId !== last?.observationId || observation?.latest !== last?.observation?.latest ||
      observation?.earliest !== last?.observation?.earliest || !!calibrating !== !!last?.calibrating);
    if (!calibrating && timing.confirmed && timing.confirmed <= this.confirmationSequence) {
      for (const [sequence, request] of this.confirmations) {
        if (request.windowId === report.windowId && sequence <= timing.confirmed) request.finish(true);
      }
    }
    return true;
  }

  private reportChanged(observedAt?: VoiceTimeBounds, observedAgain = false): void {
    const current = this.current;
    const state = voiceReplyState(current);
    if (state !== this.replyState || (observedAt !== undefined && observedAgain)) {
      this.replyState = state;
      this.observedAt = observedAt;
      this.changedAt = Date.now();
    }
    this.changed();
  }

  /** Only a report read from the DOM after this request can confirm the surface. */
  private confirmReport(windowId: string, request: VoiceQuestions["confirmFocus"], signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.streams.has(windowId)) return Promise.resolve(false);
    const sequence = ++this.confirmationSequence;
    return new Promise(resolve => {
      const stop = () => finish(false);
      const finish = (ok: boolean) => {
        this.confirmations.delete(sequence);
        signal.removeEventListener("abort", stop);
        resolve(ok);
      };
      this.confirmations.set(sequence, { windowId, finish });
      signal.addEventListener("abort", stop, { once: true });
      request(windowId, sequence);
    });
  }

  async confirmFocus(windowId: string, request: VoiceQuestions["confirmFocus"], signal: AbortSignal): Promise<boolean> {
    return await this.confirmReport(windowId, request, signal) && this.current?.windowId === windowId;
  }

  private reportingWindows(): string[] {
    return [...this.streams].filter(([id, stream]) => stream.browser || this.reports.has(id)).map(([id]) => id);
  }

  async confirmCompanion(reviewId: string, request: VoiceQuestions["confirmFocus"], signal: AbortSignal): Promise<boolean> {
    const confirmed = new Set<string>();
    await Promise.all(this.reportingWindows().map(async windowId => {
      if (await this.confirmReport(windowId, request, signal)) confirmed.add(windowId);
    }));
    // A dashboard may have connected or disappeared during confirmation. Every
    // window still capable of taking the footer must have replied for this click.
    return !signal.aborted && !this.footerOwner(reviewId) && this.reportingWindows().every(id => confirmed.has(id));
  }

  get calibrating(): boolean {
    const report = this.current;
    return !!report && !!this.reports.get(report.windowId)?.calibrating;
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

  captureTiming(capturedAt: number, monotonicCapture = performance.now() + (capturedAt - Date.now())): "before" | "uncertain" | "eligible" {
    if (!this.observedAt) return capturedAt < this.changedAt ? "before" : "eligible";
    if (monotonicCapture < this.observedAt.earliest) return "before";
    return monotonicCapture < this.observedAt.latest ? "uncertain" : "eligible";
  }

  target(questions: ReviewItem[], addressed = false): ReviewItem | undefined {
    const cards = this.current?.cards ?? [];
    // An unnamed reply follows focus across all drawn questions, including manual
    // forms. An explicitly addressed agent retains its own open-card targeting rule.
    const candidates = addressed ? cards.filter(card => questions.some(q => q.id === card.id)) : cards;
    const focused = candidates.length === 1 ? candidates : candidates.filter(card => card.focused);
    return focused.length === 1 ? questions.find(q => q.id === focused[0]!.id) : undefined;
  }

  clear(): void {
    for (const request of this.confirmations.values()) request.finish(false);
    this.replyState = undefined;
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

export function spokenIndex(words: string, explicitLetters = false): number | undefined {
  const selector = words.trim().replace(/[.!?]+$/u, "").replace(/^(?:the |option )/iu, "");
  const value = selector.toLowerCase().replace(/-/gu, " ");
  if (/^\d+(?:st|nd|rd|th)?$/u.test(value)) return parseInt(value, 10) - 1;
  const number = spokenNumber(value) ?? (value.endsWith(" one") ? positions.get(value.slice(0, -4)) : undefined);
  if (number !== undefined) return number - 1;
  // Two letters cover every badge on a supported form. Longer labels can
  // still be identified as capitals or spelled letters, unlike “option pricing”.
  const letters = explicitLetters && /^(?:[a-z]\s+)+[a-z]$/u.test(value) ? value.replace(/\s+/gu, "") : value;
  const badge = explicitLetters && (/^[A-Z]+$/u.test(selector) || letters !== value || /^[a-z]{1,2}$/u.test(value));
  if (!badge && !/^a?[a-z]$/u.test(value)) return undefined;
  let position = 0;
  for (const letter of letters) position = position * 26 + letter.charCodeAt(0) - 96;
  return position - 1;
}

/** These commands request a particular option and cannot supply a written answer. */
export function requestedChoice(words: string): number | "recommended" | undefined {
  if (/^go with your recommendation[.!?]*$/iu.test(words)) return "recommended";
  const selector = /^option\s+(.+?)\s*[.!?]*$/iu.exec(words)?.[1];
  return selector ? spokenIndex(selector, true) : undefined;
}

function normalizedLabel(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/u, "").trimEnd();
}

export async function matchAnswer(review: ReviewItem, words: string, allowText: boolean,
  decider: VoiceDecider, target: SpokenName | null, signal: AbortSignal) {
  const decisions = review.decisions ?? [];
  if (decisions.length > 1) return null;
  const decision = decisions[0];
  if (!decision) return allowText ? { selections: null, text: words, label: "written reply" } : null;
  const options = decision.options;
  const normalized = normalizedLabel(words);
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
    const exact = options.filter(o => normalizedLabel(o.label) === normalized);
    option = exact.length === 1 ? exact[0] : index === undefined ? undefined : options[index];
    if (!option && index !== undefined) return null;
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
