import type { VoiceAnswer } from "@shared/voice-answers.ts";
import type { ReviewItem } from "@shared/types.ts";
import { matchAnswer, requestedChoice, spokenIndex, VoiceOpenCards, type VoiceQuestions } from "./questions.ts";
import {
  routeUtterance,
  type HeardEntry,
  type VoiceAddressedCommand,
  type VoiceCard,
  type VoiceDeliveryOutcome,
  type VoiceRouteDecision,
  type VoiceSplitPoint,
  type VoiceUtterance,
} from "@shared/voice-routing.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import { VOICE_TURN_PREFIX } from "@shared/voice-delivery.ts";
import type { Session } from "@shared/types.ts";
import { voiceHostTimeUs } from "./host-clock.ts";
import { voiceCaptures, type VoiceBackend, type VoiceConfig, type VoiceState } from "@shared/voice.ts";
import { VOICE_RESOLVING_AFTER_MS, voiceAnswersUnsure, type VoiceChoice, type VoiceDecisionResult, type VoiceQuestion } from "@shared/voice-decide.ts";
import type { VoiceDecider } from "./decide.ts";

type DeliveryResult = Exclude<VoiceDeliveryOutcome, "failed">
  | { outcome: "failed"; detail: string }
  | { outcome: "queued" | "held"; turnId: string };

export interface VoiceDeliverer {
  available?(sessionId: string): boolean;
  openQuestions?(sessionId: string): number;
  deliver(target: SpokenName, text: string, utteranceId: string, command?: VoiceAddressedCommand, active?: () => boolean,
    onQueued?: (turnId: string) => void): Promise<DeliveryResult>;
}

interface ActionTime {
  openedAt: number;
  openedAtHostUs?: number;
}

// Captures on the shared host timeline retain their physical order across clock
// adjustments. Use Unix time when either participant only supplies wall time.
function offsetUs(time: ActionTime, reference: ActionTime): number {
  return time.openedAtHostUs !== undefined && reference.openedAtHostUs !== undefined
    ? time.openedAtHostUs - reference.openedAtHostUs : (time.openedAt - reference.openedAt) * 1000;
}

function laterTime(a: ActionTime, b: ActionTime): ActionTime {
  return offsetUs(a, b) > 0 ? a : b;
}

export interface PendingVoiceAction extends ActionTime {
  id: string;
  kind: string;
  cancel(): void;
}

const HISTORY_LIMIT = 50;
const MAX_ACTIVE_CARDS = 50;
const MAX_SPLIT_QUESTIONS = 8;
const MAX_UNSURE_CARDS = 5;
const MAX_CAPTURE_CLOCK_SKEW_MS = 1000;

export class RecentlyHeard {
  private entries: HeardEntry[] = [];
  list(): readonly HeardEntry[] { return this.entries; }
  record(entry: HeardEntry): void {
    const index = this.entries.findIndex((existing) => existing.time <= entry.time);
    this.entries.splice(index < 0 ? this.entries.length : index, 0, entry);
    if (this.entries.length > HISTORY_LIMIT) this.entries.pop();
  }
  clear(): void { this.entries = []; }
}

interface AnswerAttempt extends ActionTime {
  reviewId: string;
  sequence: number;
}

function compareAnswerCaptures(a: AnswerAttempt, b: AnswerAttempt): number {
  return offsetUs(a, b) || a.sequence - b.sequence;
}

interface OpenCard {
  answer?: VoiceAnswer;
  /** Daemon monotonic deadline. The wire deadline is in wall time for dashboard calibration. */
  answerExpiresAt?: number;
  /** The original answer's speech order survives a picker click and later corrections. */
  answerCapture?: ActionTime & { sequence: number };
  answerAttempt?: AnswerAttempt;
  questionPick?: { target: SpokenName; words: string; choiceCommand: boolean };
  time: ActionTime;
  card: VoiceCard;
  entry: HeardEntry;
  message: string;
  pickTargets?: readonly SpokenName[];
  choicesOfferedAt?: ActionTime;
  splitPicks?: Map<string, VoiceSplitPoint>;
  modelStep?: AbortController;
  resolvingVisible?: boolean;
  remainingSplits?: VoiceSplitPoint[];
  commands?: VoiceSplitPoint["commands"];
  splitStops?: { delivery: CardDelivery; done: Promise<void> };
  timer?: ReturnType<typeof setTimeout>;
}

type SpokenSettlement = "sent" | "cancelled" | Extract<DeliveryResult, { outcome: "failed" }>;

type PartOutcome = VoiceDeliveryOutcome | "cancelled";
interface PartDelivery {
  outcome: PartOutcome;
  detail?: string;
}

interface CardDelivery {
  card: VoiceCard;
  entry?: WeakRef<HeardEntry>;
  routingDetail: string;
  results: PartDelivery[];
  ready: boolean;
  published?: VoiceCard;
}

interface OutboxReceipt {
  delivery: CardDelivery;
  index: number;
  /** A session update can observe the row before deliver() returns it. */
  queueState?: "held" | "queued";
}

type NeedsModel = Extract<VoiceRouteDecision, { kind: "needs-model" }>;

/** A decider with no rung: every answer "not sure". Routing then shows the roster rows. */
const NO_DECIDER: VoiceDecider = {
  ask: async (questions) => ({ rung: "none", answers: voiceAnswersUnsure(questions), detail: "no model step" }),
};

function choiceOf(name: SpokenName): VoiceChoice {
  return { id: name.key, label: name.name, detail: name.role };
}

/** The first target's roster id keeps the message whole. Repeated targets need a boundary id. */
function splitPickOptions(firstKey: string, splits: VoiceSplitPoint[], prefix: string): Map<string, VoiceSplitPoint> {
  const counts = new Map([[firstKey, 1]]);
  for (const { target } of splits) counts.set(target.key, (counts.get(target.key) ?? 0) + 1);
  return new Map(splits.map((split) => {
    const key = split.target.key;
    const id = counts.get(key) === 1 ? key : `split:${split.at}:${key}`;
    return [prefix + id, split];
  }));
}

function agentRow(target: SpokenName): VoiceCard["candidates"][number] {
  return { kind: "agent", id: target.key, title: target.name, detail: target.role, target };
}

function setSplitPicks(item: OpenCard, card: VoiceCard, first: SpokenName, splits: VoiceSplitPoint[], prefix = ""): void {
  item.splitPicks = splitPickOptions(first.key, splits, prefix);
  card.candidates = [{ ...agentRow(first), id: prefix + first.key, detail: `${first.role} · Keep the whole message` }];
  for (const [id, { target, tail }] of item.splitPicks) {
    const label = item.splitPicks.size === 1 ? "Split here" : `Split option ${card.candidates.length}`;
    card.candidates.push({ ...agentRow(target), id, detail: `${target.role} · ${label}: ${tail.slice(0, 120)}` });
  }
}

/** How bad each outcome is, for a split whose two parts ended differently: the card shows the worse. */
const OUTCOME_SEVERITY: readonly PartOutcome[] = ["failed", "not-running", "cancelled", "held", "queued", "sent"];

/**
 * The questions a `needs-model` decision asks: who, when the heard name is in doubt; otherwise
 * one split question per later name, the first target fixed and never asked about.
 */
export function voiceQuestionsFor(decision: NeedsModel, utterance: VoiceUtterance): VoiceQuestion[] {
  // Two roster entries for the same spoken name share one boundary.
  if (new Set(decision.splits.map(split => split.at)).size > MAX_SPLIT_QUESTIONS) return [];
  if (decision.reason === "ambiguous-name") {
    if (decision.match === "exact") return [];
    return [{ kind: "who", text: utterance.text, candidates: decision.candidates.map(choiceOf) }];
  }
  // An earlier split can settle the sentence before a name shared by several agents.
  const ambiguous = decision.splits.findIndex(split => split.ambiguousTarget);
  const decidable = ambiguous < 0 ? decision.splits : decision.splits.slice(0, ambiguous);
  return decidable.map((split) => ({
    kind: "split", text: utterance.text, first: choiceOf(decision.target), second: choiceOf(split.target),
    nameOffset: split.at,
  }));
}

/**
 * Turn the model step's answers into the card. Who: one target. Split questions, in the order
 * the names were said: a mention lets the next be asked, the first split ends it, and a "not
 * sure" before any split leaves the card unsure, since cutting at a later name would decide the
 * earlier one too. Every later name a mention: the whole text goes to the first target.
 */
export function resolveVoiceDecision(
  decision: NeedsModel,
  result: VoiceDecisionResult,
): { state: "pending"; reason: "model" | "split" | "mention"; commands?: VoiceSplitPoint["commands"]; parts: VoiceCard["parts"] } | { state: "unsure" } {
  if (decision.reason === "ambiguous-name") {
    const target = decision.candidates.find((candidate) => candidate.key === result.answers[0]?.choice);
    return target ? { state: "pending", reason: "model", parts: [{ target, text: decision.text }] } : { state: "unsure" };
  }
  if (decision.splits.length === 0) return { state: "unsure" };
  for (const [index, split] of decision.splits.entries()) {
    if (split.ambiguousTarget) return { state: "unsure" };
    const choice = result.answers[index]?.choice ?? null;
    if (choice === "mention") continue;
    if (choice !== "split") return { state: "unsure" };
    return { state: "pending", reason: "split", commands: split.commands, parts: [{ target: decision.target, text: split.head }, { target: split.target, text: split.tail }] };
  }
  return { state: "pending", reason: "mention", parts: [{ target: decision.target, text: decision.text }] };
}

export class VoiceRouter {
  readonly openCards = new VoiceOpenCards(() => {
    for (const item of this.open.values()) {
      if (!item.answer) continue;
      const owner = this.openCards.footerOwner(item.answer.reviewId);
      if (owner === item.answer.footerWindowId) continue;
      if (!this.questions!.pending().some(q => q.id === item.answer!.reviewId)) continue;
      const hadCompanion = !item.answer.footerWindowId;
      item.answer = { ...item.answer, footerWindowId: owner };
      this.questions!.publish(item.answer.reviewId, item.answer);
      if (!owner) this.publish(item.card);
      else if (hadCompanion) this.questions!.removeCompanion(item.card.id);
    }
  });
  readonly heard = new RecentlyHeard();
  readonly pendingVoiceActions: PendingVoiceAction[] = [];
  private readonly open = new Map<string, OpenCard>();
  // Keep the last accepted capture until its question settles, even after a Cancel.
  private readonly lastAnswer = new Map<string, AnswerAttempt>();
  private answerSequence = 0;
  // Which answer a correction could address at capture. Retiring an answer leaves
  // its interval in history, so a delayed correction cannot fall back to a neighbor.
  private readonly correctionTargets: { at: ActionTime; slot?: number; retired: boolean }[] = [];
  // The outbox can outlive its Recently heard entry. Only the card is needed to publish the receipt.
  private lifetime = new AbortController();
  private readonly outbox = new Map<string, OutboxReceipt>();
  // Earlier choice rows can block a delayed spoken pick, but can never be picked again.
  private readonly priorChoices: {
    cardId: string; from: ActionTime; until: ActionTime; state: "resolving" | "unsure"; reason: string; choices: { id: string; title: string }[];
  }[] = [];
  private picksLostThrough?: ActionTime;
  private readonly delivering = new Map<string, VoiceCard>();
  // Retry protection for recent utterances, including controls. Clearing history releases
  // its words immediately and doesn't make a retried cancel act on another card.
  private readonly recentIds = new Set<string>();

  // The model step of each utterance still resolving, so a caller can wait for it.
  private readonly resolutions = new Map<string, Promise<void>>();

  constructor(
    private readonly state: () => Pick<VoiceState, "mode" | "roster"> & { backend: VoiceBackend | null },
    private readonly window: () => VoiceConfig["cancelWindow"],
    private readonly deliverer: VoiceDeliverer,
    private readonly publish: (card: VoiceCard) => void,
    private readonly decider: VoiceDecider = NO_DECIDER,
    private readonly hostNowUs: () => number = voiceHostTimeUs,
    private readonly questions?: VoiceQuestions,
  ) {}

  /** The model step for an utterance, while it runs: settles once its card is resolved. */
  resolution(id: string): Promise<void> | undefined {
    return this.resolutions.get(id);
  }

  reviewSettled(reviewId: string): void {
    this.lastAnswer.delete(reviewId);
    for (const item of this.open.values()) {
      if (item.answerAttempt?.reviewId !== reviewId) continue;
      item.modelStep?.abort();
      this.take(item);
      this.questionNotice(item, "That question is already settled.");
    }
  }

  activeAnswers(): VoiceAnswer[] {
    return [...this.open.values()].flatMap(item => item.answer ? [item.answer] : []);
  }

  activeCards(): VoiceCard[] {
    const visible = [...this.open.values()].filter(item => !item.answer?.footerWindowId && (item.card.state !== "resolving" || item.resolvingVisible));
    const held = new Set<VoiceCard>();
    for (const { delivery } of this.outbox.values()) {
      if (delivery.published?.parts.some(part => part.outcome === "held")) held.add(delivery.published);
    }
    return [...held, ...visible.map(item => item.card), ...this.delivering.values()];
  }

  private now(): ActionTime {
    return { openedAt: Date.now(), openedAtHostUs: this.hostNowUs() };
  }

  private recordCorrectionTarget(retired: boolean): void {
    let newest: OpenCard | undefined;
    for (const candidate of this.open.values()) {
      if (!candidate.answer) continue;
      if (!newest || (offsetUs(candidate.time, newest.time) || candidate.answerCapture!.sequence - newest.answerCapture!.sequence) > 0) {
        newest = candidate;
      }
    }
    const slot = newest?.answerCapture?.sequence;
    if (slot === this.correctionTargets.at(-1)?.slot) return;
    this.correctionTargets.push({ at: this.now(), slot, retired });
    if (this.correctionTargets.length > HISTORY_LIMIT) this.correctionTargets.shift();
  }

  private correctionTarget(time: ActionTime): OpenCard | undefined {
    const target = this.correctionTargets.findLast(change => offsetUs(change.at, time) <= 0);
    // A capture on the same clock tick as retirement cannot safely fall back to an older answer.
    if (!target?.slot || (target.retired && offsetUs(target.at, time) === 0)) return;
    return [...this.open.values()].find(item => item.answer && item.answerCapture?.sequence === target.slot);
  }

  private cancelLatestAt(time: ActionTime): string | undefined {
    // Captures can arrive out of order. For equal timestamps, the last action opened wins.
    const eligible = this.pendingVoiceActions.filter((action) => offsetUs(action, time) <= 0)
      .reverse().sort((a, b) => offsetUs(b, time) - offsetUs(a, time));
    for (const action of eligible) {
      if (action.kind === "card" && this.open.has(action.id)) {
        if (!this.cancel(action.id, undefined, time)) continue;
      } else {
        action.cancel();
      }
      return action.id;
    }
  }

  holdsSession(sessionId: string, taskId?: string): boolean {
    return this.activeCards().some(card => card.state === "pending" && card.parts.some(({ target }) =>
      target?.sessionId === sessionId || (taskId && target?.taskId === taskId)));
  }

  private closeChoices(item: OpenCard, at?: ActionTime): void {
    if (item.card.state !== "resolving" && item.card.state !== "unsure") return;
    const from = item.choicesOfferedAt ?? item.time;
    const until = laterTime(laterTime(from, at ?? from), this.now());
    item.choicesOfferedAt = until;
    const { id: cardId, state, reason, candidates } = item.card;
    this.priorChoices.push({ cardId, from, until, state, reason, choices: candidates.map(({ id, title }) => ({ id, title })) });
    if (this.priorChoices.length > HISTORY_LIMIT) {
      const lost = this.priorChoices.shift()!.until;
      this.picksLostThrough = this.picksLostThrough ? laterTime(this.picksLostThrough, lost) : lost;
    }
  }

  async accept(utterance: VoiceUtterance, timing: { heldBeforeRelease?: boolean; startHostUs?: number; speechStartHostUs?: number } = {}): Promise<boolean> {
    const { heldBeforeRelease, startHostUs, speechStartHostUs } = timing;
    const onsetUs = speechStartHostUs ?? startHostUs;
    const { mode, roster, backend } = this.state();
    if (!(voiceCaptures(mode) || (mode === "auto-muted" && heldBeforeRelease)) || backend !== utterance.backend) return false;
    const { id, capturedAt } = utterance;
    // Released holds already passed the route's monotonic key-down/key-up bounds.
    if (!heldBeforeRelease) {
      const aheadUs = onsetUs !== undefined
        ? onsetUs - this.hostNowUs() : (capturedAt - Date.now()) * 1000;
      if (aheadUs > MAX_CAPTURE_CLOCK_SKEW_MS * 1000) return false;
    }
    if (this.open.has(id) || this.delivering.has(id) || this.recentIds.has(id)) return true;
    const leadMs = speechStartHostUs !== undefined && startHostUs !== undefined ? (speechStartHostUs - startHostUs) / 1000 : 0;
    const time = { openedAt: capturedAt + leadMs, openedAtHostUs: onsetUs };
    const unsureCards = this.picksLostThrough && offsetUs(time, this.picksLostThrough) <= 0 ? [] : Array.from(this.open.values())
      .filter(item => (item.card.state === "unsure" || item.card.state === "resolving") &&
        offsetUs(item.time, time) <= 0 && (!item.choicesOfferedAt || offsetUs(item.choicesOfferedAt, time) <= 0))
      .map(({ card }) => card);
    const priorPickNames = this.priorChoices
      .filter(window => offsetUs(window.from, time) <= 0 && offsetUs(time, window.until) <= 0)
      .flatMap(window => {
        // At a timestamp tie, count an unchanged action once. A row with the same
        // name can now confirm a different recipient or split.
        const current = offsetUs(window.until, time) === 0 && unsureCards.find(card =>
          card.id === window.cardId && card.state === window.state && card.reason === window.reason);
        if (!current) return window.choices.map(choice => choice.title);
        const titlesById = new Map(current.candidates.map(row => [row.id, row.title]));
        return window.choices.filter(choice => titlesById.get(choice.id) !== choice.title).map(choice => choice.title);
      });
    // Bind every potential part to the roster session present when the utterance arrived.
    const decision = routeUtterance(utterance, { roster: roster.map(target => ({ ...target })), unsureCards, priorPickNames });
    // An unsure card reserves its delivery slot so it can still be picked at capacity.
    if ((decision.kind === "addressed" || decision.kind === "needs-model") &&
        this.open.size + this.delivering.size >= MAX_ACTIVE_CARDS) return false;
    this.recentIds.add(id);
    if (this.recentIds.size > HISTORY_LIMIT) this.recentIds.delete(this.recentIds.values().next().value!);
    const entry: HeardEntry = { id, time: capturedAt, text: utterance.text, outcome: "ignored",
      rule: decision.kind, matchedName: null, pauseMs: null, detail: "" };
    this.heard.record(entry);
    if (this.questions) {
      const routed = this.routeQuestion(utterance, decision, entry, time, unsureCards);
      if (routed !== false) return routed;
    }
    if (decision.kind === "ignored") {
      entry.rule = decision.reason;
      entry.matchedName = decision.closest ?? null;
      return true;
    }
    if (decision.kind === "control") {
      entry.outcome = "control";
      entry.rule = decision.command;
      if (decision.command === "cancel") {
        const cancelled = this.cancelLatestAt(time);
        if (cancelled) entry.detail = cancelled;
        else entry.rule = "nothing-pending";
      } else if (!await this.pick(decision.cardId, decision.candidateId, time)) {
        entry.outcome = "ignored";
        entry.rule = "candidate-unavailable";
      }
      return true;
    }
    entry.pauseMs = decision.pauseMs;
    if (decision.kind === "needs-model") {
      this.startModelStep(decision, utterance, entry, time);
      return true;
    }
    entry.rule = decision.match;
    entry.matchedName = decision.target.name;
    const card: VoiceCard = {
      id, state: "pending", deadline: null, openQuestions: 0, reason: entry.rule,
      parts: [{ target: decision.target, text: decision.text }], candidates: [],
    };
    this.openCard({ card, entry, time, message: decision.text, commands: [decision.command] });
    return true;
  }

  private routeQuestion(utterance: VoiceUtterance, decision: VoiceRouteDecision, entry: HeardEntry,
    time: ActionTime, unsure: VoiceCard[]): boolean | Promise<boolean> {
    const words = utterance.text.trim();
    const correction = /^no(?:,\s*|\s+)(.+)$/iu.exec(words);
    if (correction) {
      const latest = this.correctionTarget(time);
      if (!latest?.answer) return false;
      const review = this.questions!.pending().find(q => q.id === latest.answer!.reviewId);
      entry.outcome = "control";
      entry.rule = "switch-answer";
      const index = spokenIndex(correction[1]!, true);
      if (index !== undefined && review && performance.now() < latest.answerExpiresAt! && review.decisions?.[0]?.options[index]) {
        return this.prepareAnswer(latest, review, "option " + (index + 1), false, { id: utterance.id, time }).then(() => true);
      }
      return true;
    }
    const picks = unsure.filter(c => c.candidates[0]?.kind === "question");
    const index = spokenIndex(words);
    if (picks.length && index !== undefined && index >= 0 && !/^(?:option |[a-z][.!?]?$)/iu.test(words)) {
      const row = picks.length === 1 && picks[0]!.candidates[index];
      entry.outcome = "control";
      entry.rule = "pick-question";
      return row ? this.pick(picks[0]!.id, row.id, time) : true;
    }
    if (decision.kind === "control") return false;
    const reply = /^reply(?:,\s*|\s+)([\s\S]+)$/iu.exec(words);
    const addressed = (decision.kind === "addressed" && !decision.command) ||
      (decision.kind === "needs-model" && decision.reason === "second-name") ? decision : null;
    if (!reply && !addressed) return false;
    const target = reply ? null : addressed?.target ?? null;
    const pending = this.questions!.pending().filter(q => q.createdAt <= time.openedAt && (!target || q.sessionId === target.sessionId))
      .sort((a, b) => a.createdAt - b.createdAt);
    const body = (reply?.[1] ?? addressed!.text).trim();
    if (!body) return false;
    const answer = /^answer(?:\s*[:,]\s*|[.!?]?$)([\s\S]*)$/iu.exec(body);
    const choiceCommand = requestedChoice(body) !== undefined;
    const explicit = !!target && (!!answer || choiceCommand);
    if (!explicit && !(reply && pending.length && this.openCards.reportingWindows().length)) return false;
    if (this.open.size + this.delivering.size >= MAX_ACTIVE_CARDS) return true;
    const content = explicit && answer ? answer[1]!.trim() : body;
    const item: OpenCard = { entry, time, message: body, answerCapture: { ...time, sequence: ++this.answerSequence },
      card: { id: utterance.id, reason: "answer", state: "pending", parts: [{ target, text: body }],
        openQuestions: 0, deadline: null, candidates: [] } };
    entry.matchedName = target?.name ?? null;
    if (!pending.length) {
      this.questionNotice(item, target!.name + " has no open questions");
      return true;
    }
    if (!content && target) {
      this.offerQuestions(item, pending, target, content, choiceCommand);
      return true;
    }
    return this.routeAnswerContent(item, pending, content, choiceCommand, target).then(() => true);
  }

  private offerQuestions(item: OpenCard, pending: ReviewItem[], target: SpokenName, words: string, choiceCommand: boolean): void {
    item.choicesOfferedAt = laterTime(item.time, this.now());
    item.questionPick = { target, words, choiceCommand };
    item.card.state = "unsure";
    item.card.candidates = pending.map((q, i) => ({ kind: "question", id: q.id, title: q.title,
      detail: (i + 1) + " · asked " + Math.max(0, Math.floor((Date.now() - q.createdAt) / 60000)) + "m ago" }));
    this.openCard(item);
  }

  private questionCaptureTiming(time: ActionTime) {
    const monotonic = time.openedAtHostUs === undefined ? undefined : performance.now() + (time.openedAtHostUs - this.hostNowUs()) / 1000;
    return this.openCards.captureTiming(time.openedAt, monotonic);
  }

  private confirmationSignal(signal?: AbortSignal): AbortSignal {
    const signals = [this.lifetime.signal, AbortSignal.timeout(3000)];
    if (signal) signals.push(signal);
    return AbortSignal.any(signals);
  }

  private prepareQuestionReply(item: OpenCard, review: ReviewItem, words: string, choiceCommand: boolean, open?: ReviewItem) {
    const allowText = !choiceCommand && (review.id === open?.id || !review.decisions?.length);
    return this.prepareAnswer(item, review, words, allowText);
  }

  private questionNotice(item: OpenCard, detail: string): void {
    item.entry.detail = detail;
    item.entry.outcome = "cancelled";
    this.publish({ ...item.card, state: "cancelled", reason: "question-notice", detail, deadline: null });
  }

  private reserveAnswer(item: OpenCard): void {
    const id = item.card.id;
    item.card = { ...item.card, state: "resolving", candidates: [] };
    item.modelStep = new AbortController();
    this.open.set(id, item);
    this.pendingVoiceActions.push({ id, kind: "card", ...item.time, cancel: () => this.cancel(id) });
  }

  private async routeAnswerContent(item: OpenCard, candidates: ReviewItem[], words: string, choiceCommand: boolean,
    target: SpokenName | null, picked?: ReviewItem): Promise<void> {
    const fixed = picked ?? (target && candidates.length === 1 ? candidates[0] : undefined);
    const windows = this.openCards.reportingWindows();
    // A single named or picked question has a destination even with every dashboard
    // closed. Its Other field still needs a confirmed open card to accept dictation.
    if (fixed && (!windows.length || choiceCommand || !fixed.decisions?.[0]?.allowOther)) {
      await this.prepareQuestionReply(item, fixed, words, choiceCommand);
      return;
    }
    if (!windows.length) {
      if (target) this.offerQuestions(item, candidates, target, words, choiceCommand);
      return;
    }
    const drawn = this.openCards.target(candidates, !!target);
    const previousWindow = this.openCards.dashboard;
    const calibratingTarget = this.openCards.calibrating ? drawn?.id : undefined;
    this.reserveAnswer(item);
    const windowId = await this.openCards.confirmReplyWindow(windows, this.questions!.confirmFocus, this.confirmationSignal(item.modelStep!.signal));
    if (this.open.get(item.card.id) !== item) return;
    const pendingIds = new Set(this.questions!.pending().map(q => q.id));
    const pending = candidates.filter(q => pendingIds.has(q.id));
    // Include the originally eligible cards when reading focus. Settling one while
    // we await the report must not turn its unfocused neighbor into the sole target.
    const focused = this.openCards.target(candidates, !!target);
    // Picking sets a new time for cancellation priority. Only the original
    // speech can establish whether the operator dictated into an open card.
    const timing = this.questionCaptureTiming(item.answerCapture!);
    const changedDuringCalibration = windowId === previousWindow && calibratingTarget && calibratingTarget !== focused?.id;
    const open = windowId && focused && timing === "eligible" && this.openCards.footerOwner(focused.id) === windowId &&
      !changedDuringCalibration ? focused : undefined;
    const review = fixed ?? open;
    if (review && pendingIds.has(review.id)) {
      await this.prepareQuestionReply(item, review, words, choiceCommand, open);
      return;
    }
    this.take(item);
    if (target) {
      if (pending.length && !fixed) this.offerQuestions(item, pending, target, words, choiceCommand);
      else this.questionNotice(item, "That question is already settled.");
    } else if ((!windowId && (drawn || !previousWindow)) || (focused && timing !== "eligible" && (timing === "uncertain" || windowId !== previousWindow)) ||
      changedDuringCalibration) {
      this.questionNotice(item, "Question focus changed near the start of speech. Say “reply” and your answer again.");
    }
  }

  private async prepareAnswer(item: OpenCard, review: ReviewItem, words: string, allowText: boolean,
    correction?: { id: string; time: ActionTime }): Promise<void> {
    const id = correction?.id ?? item.card.id;
    const signal = this.lifetime.signal;
    const capture = correction ? { ...correction.time, sequence: ++this.answerSequence } : item.answerCapture!;
    const attempt = { ...capture, reviewId: review.id };
    const accepted = this.lastAnswer.get(review.id);
    if (accepted && compareAnswerCaptures(attempt, accepted) < 0) {
      if (!correction && this.open.get(id) === item) this.take(item);
      return;
    }
    if (!correction) {
      item.answerAttempt = attempt;
      if (this.open.get(id) !== item) this.reserveAnswer(item);
    }
    const target = item.card.parts[0]?.target ?? null;
    const result = await matchAnswer(review, words, allowText, this.decider, target, item.modelStep?.signal ?? signal);
    // A concurrent correction can have changed the action ID while matching. Compare
    // capture times on the live item; its original time still orders spoken Cancel.
    const previousId = item.card.id;
    if (signal.aborted || this.open.get(previousId) !== item || this.state().mode === "off") return;
    const latest = this.lastAnswer.get(review.id);
    if (latest && compareAnswerCaptures(attempt, latest) < 0) return;
    if (!this.questions!.pending().some(q => q.id === review.id)) {
      this.take(item);
      this.questionNotice(item, "That question is already settled.");
      return;
    }
    if (!result || result === "matcher-failed") {
      if (correction) return;
      this.take(item);
      this.questionNotice(item, result === "matcher-failed" ? "Could not match an option. Try again." : "No matching option.");
      return;
    }
    for (const other of this.open.values()) {
      if (other === item || other.answerAttempt?.reviewId !== review.id) continue;
      if (compareAnswerCaptures(other.answerAttempt, attempt) > 0) continue;
      if (!this.cancel(other.card.id)) { this.take(item); return; }
    }
    item.answerAttempt = attempt;
    this.lastAnswer.set(review.id, attempt);
    clearTimeout(item.timer);
    const window = this.window();
    const windowMs = window.enabled ? window.seconds * 1000 : 0;
    const deadline = Date.now() + windowMs;
    const expiresAt = performance.now() + windowMs;
    item.answerExpiresAt = expiresAt;
    if (correction) {
      // Replace the action in place so delayed buttons cannot act on the new answer,
      // while spoken Cancel still follows the original capture order.
      this.open.delete(previousId);
      this.open.set(id, item);
      const action = this.pendingVoiceActions.find(a => a.kind === "card" && a.id === previousId)!;
      action.id = id;
      action.cancel = () => this.cancel(id);
      if (!item.answer?.footerWindowId) this.questions!.removeCompanion(previousId);
    }
    item.answer = { ...result, id, originId: item.entry.id, reviewId: review.id, deadline, windowMs, switched: !!correction,
      footerWindowId: this.openCards.footerOwner(review.id) };
    if (!correction) this.recordCorrectionTarget(false);
    item.card = { ...item.card, id, state: "pending", reason: "voice-answer", questionTitle: review.title, deadline, windowMs,
      parts: [{ target: target ?? this.state().roster.find(row => row.sessionId === review.sessionId) ?? null, text: result.text }] };
    item.entry.rule = "voice-answer";
    item.entry.outcome = "pending";
    this.questions!.publish(review.id, item.answer);
    if (!item.answer.footerWindowId) this.publish(item.card);
    if (!windowMs) { await this.sendNow(id); return; }
    item.timer = setTimeout(() => { void this.sendNow(id); }, Math.ceil(expiresAt - performance.now()));
    item.timer.unref();
  }

  /**
   * Hand a `needs-model` decision to the model step without holding the listener's request.
   *
   * The card is open, and in the cancel order, from the start, so "cancel" stops it while it is
   * resolving; it is published as `resolving` only once the step has taken a second, so a quick
   * answer shows no intermediate state. A card cancelled, or voice turned off, while the step
   * runs is gone from `open` when the answer comes, and that answer is dropped.
   */
  private startModelStep(decision: NeedsModel, utterance: VoiceUtterance, entry: HeardEntry, time: ActionTime): void {
    const { id } = utterance;
    entry.rule = decision.reason;
    entry.matchedName = decision.reason === "second-name" ? decision.target.name : null;
    entry.outcome = "resolving";
    const possible = decision.reason === "ambiguous-name" ? new Set([...decision.candidates, ...decision.splits.map(s => s.target)]) : decision.candidates;
    const candidates = [...possible].map(agentRow);
    const modelStep = new AbortController();
    const item: OpenCard = {
      entry, time,
      message: decision.text,
      choicesOfferedAt: laterTime(time, this.now()),
      modelStep,
      commands: decision.reason === "ambiguous-name" ? [decision.command] : undefined,
      card: { id, state: "resolving", deadline: null, openQuestions: 0, reason: decision.reason, candidates,
        parts: [{ target: decision.reason === "second-name" ? decision.target : null, text: utterance.text }] },
    };
    this.open.set(id, item);
    this.pendingVoiceActions.push({ id, kind: "card", ...time, cancel: () => this.cancel(id) });
    item.timer = setTimeout(() => {
      if (this.open.get(id) !== item) return;
      item.resolvingVisible = true;
      this.publish(item.card);
    }, VOICE_RESOLVING_AFTER_MS);
    item.timer.unref?.();
    const startedAt = performance.now();
    const ask = async (current: NeedsModel): Promise<VoiceDecisionResult> => {
      const questions = voiceQuestionsFor(current, utterance);
      if (!questions.length) return { rung: "none", answers: [], detail: "manual selection required" };
      const involved = new Set(questions.flatMap(q => q.kind === "split" ? [q.first.id, q.second.id] :
        q.kind === "who" ? q.candidates.map(c => c.id) : []));
      const agents = current.candidates.filter(c => involved.has(c.key)).map(c => c.agent);
      try {
        return await this.decider.ask(questions, { agents, signal: modelStep.signal, startedAt });
      } catch {
        return { rung: "none", answers: [], detail: "routing failed" };
      }
    };
    const settle = async (): Promise<void> => {
      let result = await ask(decision);
      if (this.open.get(id) !== item) return;
      if (decision.reason === "ambiguous-name" && decision.splits.length) {
        const target = decision.candidates.find(c => c.key === result.answers[0]?.choice);
        if (target) {
          decision = { ...decision, target, reason: "second-name",
            candidates: [...new Set([target, ...decision.splits.map(s => s.target)])] };
          entry.matchedName = target.name;
          this.closeChoices(item);
          item.card = { ...item.card, reason: decision.reason,
            parts: [{ ...item.card.parts[0]!, target }], candidates: decision.candidates.map(agentRow) };
          if (item.resolvingVisible) {
            this.publish(item.card);
            if (this.open.get(id) !== item) return;
          }
          result = await ask(decision);
          if (this.open.get(id) !== item) return;
        } else {
          item.remainingSplits = decision.splits;
        }
      }
      delete item.modelStep;
      clearTimeout(item.timer);
      this.closeChoices(item);
      const resolved = resolveVoiceDecision(decision, result);
      const verdict = resolved.state === "unsure" ? "not sure" : resolved.reason;
      entry.detail = `${result.detail}: ${verdict}`;
      if (resolved.state === "unsure") {
        const card: VoiceCard = { ...item.card, state: "unsure", candidates: decision.candidates.map(agentRow) };
        if (decision.reason === "second-name") {
          setSplitPicks(item, card, decision.target, decision.splits);
        }
        this.openCard({ ...item, timer: undefined, card, pickTargets: decision.candidates });
        return;
      }
      if (resolved.reason === "model") entry.matchedName = resolved.parts[0]!.target!.name;
      this.openCard({ ...item, timer: undefined, commands: resolved.commands ?? item.commands,
        card: { ...item.card, state: "pending", reason: resolved.reason, candidates: [], parts: resolved.parts,
          ...(resolved.reason === "mention" && decision.reason === "second-name" && { mentions: decision.candidates.filter(t => t.key !== resolved.parts[0]?.target?.key) }) } });
    };
    this.trackResolution(id, settle());
  }

  private trackResolution(id: string, work: Promise<void>): void {
    const done = work.finally(() => { if (this.resolutions.get(id) === done) this.resolutions.delete(id); });
    this.resolutions.set(id, done);
  }

  private openCard(item: OpenCard): void {
    const { card, entry } = item;
    // A resolving card already has its place in capture order, including ties.
    if (!this.open.has(card.id)) {
      this.pendingVoiceActions.push({ id: card.id, kind: "card", ...item.time, cancel: () => this.cancel(card.id) });
    }
    this.open.set(card.id, item);
    entry.outcome = card.state;
    if (card.state === "unsure") {
      const unsure = Array.from(this.open.values()).filter((item) => item.card.state === "unsure");
      if (unsure.length > MAX_UNSURE_CARDS) {
        const oldest = unsure.reduce((first, next) => offsetUs(next.time, item.time) < offsetUs(first.time, item.time) ? next : first);
        this.cancel(oldest.card.id, "Replaced by a newer unsure card.");
        if (oldest === item) return;
      }
    }
    if (card.state === "pending") {
      const window = this.window();
      card.openQuestions = this.openQuestionCount(card);
      if (card.parts.length > 1 && item.commands?.includes("stop")) {
        card.parts = card.parts.map((part, i) => item.commands?.[i] === "stop" ? { ...part, immediateStop: true } : part);
        const delivery = this.newDelivery(item);
        const { signal } = this.lifetime;
        const stops = card.parts.flatMap((_, index) => item.commands?.[index] === "stop"
          ? [this.deliverPart(delivery, index, "stop", () => !signal.aborted)] : []);
        const done = Promise.all(stops).then(() => {
          if (this.open.get(card.id) !== item) return;
          item.card = { ...card, parts: delivery.card.parts.map((part, index) => ({ ...part, ...delivery.results[index] })) };
          this.publish(item.card);
        });
        item.splitStops = { delivery, done };
      }
      if (card.parts.every((_, index) => item.commands?.[index] === "stop") || !window.enabled) { void this.sendNow(card.id); return; }
      const ms = window.seconds * 1000;
      card.windowMs = ms;
      card.deadline = Date.now() + ms;
      item.timer = setTimeout(() => { void this.sendNow(card.id); }, ms);
      item.timer.unref?.();
    }
    this.publish(card);
  }

  // Claim synchronously before delivery can yield, so a timer and a button can't both send.
  private take(item: OpenCard, at?: ActionTime): void {
    this.closeChoices(item, at);
    clearTimeout(item.timer);
    this.open.delete(item.card.id);
    if (item.answer) {
      this.recordCorrectionTarget(true);
      this.questions?.publish(item.answer.reviewId, null);
    }
    const index = this.pendingVoiceActions.findIndex((a) => a.kind === "card" && a.id === item.card.id);
    if (index >= 0) this.pendingVoiceActions.splice(index, 1);
  }

  cancelEditedAnswer(reviewId: string, originId: string): boolean {
    const item = [...this.open.values()].find(i => i.answer?.reviewId === reviewId && i.answer.originId === originId);
    return !!item && this.cancel(item.card.id);
  }

  cancel(id: string, detail?: string, capturedAt?: ActionTime): boolean {
    const item = this.open.get(id);
    if (!item) return false;
    if (item.card.deadline !== null && Date.now() >= item.card.deadline) return false;
    this.take(item, capturedAt);
    item.modelStep?.abort();
    item.entry.outcome = "cancelled";
    if (detail) item.entry.detail = detail;
    if (item.splitStops) {
      const { delivery, done } = item.splitStops;
      for (const index of item.card.parts.keys()) {
        if (item.commands?.[index] !== "stop") delivery.results[index] = { outcome: "cancelled" };
      }
      if (delivery.card.parts.every((_, i) => delivery.results[i])) {
        delivery.ready = true;
        this.publishDelivery(delivery);
      } else {
        const stopping: VoiceCard = { ...delivery.card, state: "cancelled",
          parts: delivery.card.parts.map((part, i) => ({ ...part, ...delivery.results[i] })) };
        this.delivering.set(id, stopping);
        this.publish(stopping);
        void done.then(() => {
          if (this.delivering.get(id) !== stopping) return;
          this.delivering.delete(id);
          delivery.ready = true;
          this.publishDelivery(delivery);
        });
      }
    } else if (!item.answer?.footerWindowId && !(item.answerAttempt && !item.answer)) {
      this.publish({ ...item.card, state: "cancelled", deadline: null });
    }
    return true;
  }

  async pick(id: string, candidateId: string, time?: ActionTime): Promise<boolean> {
    const item = this.open.get(id);
    if (item?.card.state !== "unsure" || !item.card.candidates.some((c) => c.id === candidateId)) return false;
    if (item.questionPick) {
      const { target, words, choiceCommand } = item.questionPick;
      const pending = this.questions!.pending().filter(q => q.sessionId === target.sessionId);
      const review = pending.find(q => q.id === candidateId);
      const dashboard = this.openCards.dashboard;
      if (review && !words && !dashboard) {
        item.card = { ...item.card, detail: "Focus a dashboard, then choose this question again." };
        this.publish(item.card);
        return true;
      }
      this.take(item, time);
      delete item.questionPick;
      if (!review) this.questionNotice(item, "That question is already settled.");
      else if (words) {
        this.questions!.removeCompanion(id);
        item.time = time ?? this.now();
        const work = this.routeAnswerContent(item, pending, words, choiceCommand, target, review)
          .catch(() => {
            if (this.open.get(id) !== item) return;
            this.take(item);
            this.questionNotice(item, "Could not match an option. Try again.");
          });
        this.trackResolution(id, work);
      } else if (dashboard) {
        this.questions!.open(dashboard, review);
        this.questionNotice(item, "Opened question.");
      }
      return true;
    }
    const roster = this.state().roster;
    const split = item.splitPicks?.get(candidateId);
    const target = item.splitPicks ? split?.target ?? item.card.parts[0]?.target
      : item.pickTargets?.find(c => c.key === candidateId);
    if (!target) return false;
    const pickedAt = time ?? this.now();
    let parts = [{ target, text: item.message }];
    if (split) {
      const first = item.card.parts[0]?.target;
      if (!first) return false;
      parts = [{ target: first, text: split.head }, { target, text: split.tail }];
    }
    if (parts.some(part => !this.checkedTarget(roster, part.target, split ? "deliver" : "single-pick"))) return false;
    if (item.remainingSplits?.length) {
      const card: VoiceCard = { ...item.card, reason: "second-name", parts };
      this.closeChoices(item, pickedAt);
      setSplitPicks(item, card, target, item.remainingSplits, "boundary:");
      delete item.remainingSplits;
      item.card = card;
      delete item.pickTargets;
      item.entry.matchedName = target.name;
      this.publish(card);
      return true;
    }
    this.take(item, pickedAt);
    item.entry.matchedName = parts[0]!.target.name;
    item.entry.detail = "picked";
    this.openCard({ ...item, time: pickedAt, commands: split ? split.commands : item.commands, card: { ...item.card, state: "pending", reason: split ? "split" : "picked",
      ...(!split && item.splitPicks && { mentions: [...new Set([...item.splitPicks.values()].map(s => s.target))].filter(t => t.key !== target.key) }),
      candidates: [], parts } });
    return true;
  }

  private openQuestionCount(card: VoiceCard): number {
    const ids = new Set(card.parts.map(part => part.target?.sessionId));
    let count = 0;
    for (const id of ids) if (id) count += this.deliverer.openQuestions?.(id) ?? 0;
    return count;
  }

  private checkedTarget(roster: readonly SpokenName[], captured: SpokenName | null, purpose: "deliver" | "single-pick" = "deliver"): SpokenName | undefined {
    if (!captured) return;
    // A sleeping task may wake during the cancel window. A running session stays pinned.
    const target = roster.find(row => row.key === captured.key && (captured.state === "hibernated"
      ? captured.taskId !== null && row.taskId === captured.taskId : row.sessionId === captured.sessionId));
    if (target?.state === "hibernated" && target.taskId) return target;
    if (purpose === "single-pick" && target?.state === "not-running" && captured.state === "not-running") return target;
    return target?.state === "running" && target.sessionId && this.deliverer.available?.(target.sessionId) !== false ? target : undefined;
  }

  private publishDelivery(delivery: CardDelivery): void {
    const { results, card, routingDetail } = delivery;
    const state = OUTCOME_SEVERITY.find(outcome => results.some(part => part.outcome === outcome))!;
    let detail = results[0]?.detail ?? routingDetail;
    if (results.length > 1) {
      const summary = results.map((part, index) => {
        const status = part.outcome === "not-running" ? "unavailable" : part.outcome;
        const reason = part.outcome === "failed" && part.detail ? " " + part.detail : "";
        return `Part ${index + 1} (${card.parts[index]!.target!.name}) ${status}.${reason}`;
      });
      detail = [routingDetail, summary.join(" ")].filter(Boolean).join("\n");
    }
    const entry = delivery.entry?.deref();
    if (entry) Object.assign(entry, { outcome: state, detail });
    delivery.published = { ...card, state, parts: card.parts.map((part, i) => ({ ...part, ...results[i] })), ...(detail && { detail }) };
    this.publish(delivery.published);
  }

  private newDelivery(item: OpenCard): CardDelivery {
    return { card: { ...item.card, parts: [...item.card.parts], deadline: null },
      entry: new WeakRef(item.entry), routingDetail: item.entry.detail, results: [], ready: false };
  }

  private async deliverPart(delivery: CardDelivery, index: number, command: VoiceAddressedCommand | undefined, active: () => boolean): Promise<void> {
    const { id, parts } = delivery.card;
    const part = parts[index]!;
    const target = this.checkedTarget(this.state().roster, part.target);
    const receipt: OutboxReceipt = { delivery, index };
    let registeredId: string | undefined;
    let result: DeliveryResult = "not-running";
    try {
      if (target) {
        const partId = index === 0 ? id : `${id}#${index + 1}`;
        result = await this.deliverer.deliver(target, part.text, partId, command, active, turnId => {
          if (!active()) return;
          registeredId = turnId;
          this.outbox.set(turnId, receipt);
        });
      }
    } catch (error) {
      result = { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    if (registeredId !== undefined && this.outbox.get(registeredId) === receipt) this.outbox.delete(registeredId);
    if (!active()) return;
    const roster = this.state().roster;
    let latest = this.checkedTarget(roster, part.target) ?? target ?? part.target;
    let detail = typeof result !== "string" && result.outcome === "failed" ? result.detail : undefined;
    if (result === "not-running") {
      const stopped = roster.find(row => row.key === part.target?.key && row.state === "not-running");
      latest = stopped ?? latest;
      detail = (stopped || target) && latest
        ? `${latest.name} isn't running. Nothing was sent. ${latest.kind === "resident" ? "Relaunch the resident." : "Start a follow-up task."}`
        : "The selected session is unavailable.";
    }
    delivery.card.parts[index] = { ...part, target: latest, ...(command && { command }),
      ...(typeof result !== "string" && "turnId" in result && { turnId: result.turnId }) };
    // A replay can settle synchronously inside submitSpoken, before deliver returns its row.
    if (!delivery.results[index]) {
      if (typeof result !== "string" && "turnId" in result) {
        delivery.results[index] = { outcome: receipt.queueState ?? result.outcome };
        this.outbox.set(result.turnId, receipt);
      } else {
        delivery.results[index] = { outcome: typeof result === "string" ? result : result.outcome, detail };
      }
    }
  }

  async sendNow(id: string, source?: { companion: boolean; windowId?: string }): Promise<boolean> {
    const item = this.open.get(id);
    if (item?.card.state !== "pending") return false;
    if (source?.companion && !item.answer) return false;
    if (source && item.answer) {
      const owner = source.companion ? undefined : source.windowId;
      if ((!source.companion && !owner) || item.answer.footerWindowId !== owner) return false;
      // Either submit control can overtake a handoff. Keep Cancel and expiry live
      // while the windows confirm which surface still owns this exact action.
      const request = this.questions!.confirmFocus;
      const signal = this.confirmationSignal();
      const confirmed = owner ? await this.openCards.confirmFocus(owner, request, signal)
        : await this.openCards.confirmCompanion(item.answer.reviewId, request, signal);
      if (!confirmed || this.open.get(id) !== item || item.answer.footerWindowId !== owner) return false;
    }
    this.take(item);
    if (this.state().mode === "off") return false;
    if (item.answer) {
      const ok = this.questions!.pending().some(q => q.id === item.answer!.reviewId)
        && await this.questions!.resolve(item.answer).catch(() => false);
      item.entry.outcome = ok ? "sent" : "failed";
      if (!ok || !item.answer.footerWindowId) this.publish({ ...item.card, state: item.entry.outcome, deadline: null,
        detail: ok ? "Answer submitted." : "The question could not be answered." });
      return ok;
    }
    const inFlight = { ...item.card, reason: "delivering", deadline: null };
    this.delivering.set(id, inFlight);
    const active = () => this.delivering.get(id) === inFlight && this.state().mode !== "off";
    const delivery = item.splitStops?.delivery ?? this.newDelivery(item);
    if (item.card.parts.length > 1 || this.checkedTarget(this.state().roster, item.card.parts[0]!.target)) this.publish(inFlight);
    for (const index of item.card.parts.keys()) {
      if (!active()) return true;
      if (item.splitStops && item.commands?.[index] === "stop") continue;
      await this.deliverPart(delivery, index, item.commands?.[index], active);
    }
    if (item.splitStops) await item.splitStops.done;
    if (!active()) return true;
    this.delivering.delete(id);
    delivery.ready = true;
    delivery.card.openQuestions = this.openQuestionCount(delivery.card);
    this.publishDelivery(delivery);
    return true;
  }

  /** Keep live receipts in sync with blocking reviews and restore held rows after discovery. */
  syncQueuedTurns(session: Session, blockingReview: boolean): void {
    const outcome = blockingReview ? "held" : "queued";
    const changed = new Set<CardDelivery>();
    const missing: Session["pendingTurns"] = [];
    for (const turn of session.pendingTurns) {
      if (turn.state !== "queued" || turn.spokenWords === undefined || !turn.id.startsWith(VOICE_TURN_PREFIX)) continue;
      const receipt = this.outbox.get(turn.id);
      if (!receipt) {
        if (outcome === "held") missing.push(turn);
        continue;
      }
      const { delivery, index } = receipt;
      receipt.queueState = outcome;
      const result = delivery.results[index];
      if (result && result.outcome !== outcome) {
        delivery.results[index] = { outcome };
        if (delivery.ready) changed.add(delivery);
      }
    }
    for (const delivery of changed) {
      delivery.card.openQuestions = this.openQuestionCount(delivery.card);
      this.publishDelivery(delivery);
    }
    if (!missing.length) return;
    const { mode, roster } = this.state();
    const target = roster.find(row => row.sessionId === session.id);
    if (mode === "off" || !target) return;
    for (const turn of missing) {
      const id = turn.id.slice(VOICE_TURN_PREFIX.length);
      // Split parts append # and their index to the URL-unreserved capture ID. The
      // live delivery owns every part, even before its queue callback registers a receipt.
      if (this.delivering.has(id.split("#", 1)[0]!)) continue;
      const card: VoiceCard = { id, state: "held", deadline: null,
        parts: [{ target, text: turn.spokenWords!, turnId: turn.id }], candidates: [], reason: "outbox",
        openQuestions: this.deliverer.openQuestions?.(session.id) ?? session.pendingReviews };
      const delivery: CardDelivery = { card, results: [{ outcome: "held" }], ready: true, routingDetail: "" };
      this.outbox.set(turn.id, { delivery, index: 0 });
      this.publishDelivery(delivery);
    }
  }

  isHeldTurn(turnId: string): boolean {
    const receipt = this.outbox.get(turnId);
    return receipt?.delivery.results[receipt.index]?.outcome === "held";
  }

  settleSpoken(turnId: string, outcome: SpokenSettlement): void {
    const receipt = this.outbox.get(turnId);
    if (!receipt) return;
    this.outbox.delete(turnId);
    receipt.delivery.results[receipt.index] = typeof outcome === "string" ? { outcome } : outcome;
    if (receipt.delivery.ready) this.publishDelivery(receipt.delivery);
  }

  clearActionsAndHistory(): void {
    for (const item of this.open.values()) {
      clearTimeout(item.timer);
      item.modelStep?.abort();
    }
    this.openCards.clear();
    this.open.clear();
    this.lastAnswer.clear();
    this.correctionTargets.length = 0;
    this.resolutions.clear();
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.delivering.clear();
    this.outbox.clear();
    this.pendingVoiceActions.length = 0;
    this.heard.clear();
    this.priorChoices.length = 0;
    this.picksLostThrough = undefined;
  }

  reset(): void {
    this.clearActionsAndHistory();
    this.recentIds.clear();
  }
}
