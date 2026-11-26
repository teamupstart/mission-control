import { namedInboxCommand, spokenInboxAction } from "@shared/voice-inbox.ts";
import { VoicePlanForms, formChoices, isFormChoice } from "./plan-forms.ts";
import { addressedCards, focusedVoiceCard, planVoiceTarget, spokenOrdinal, VOICE_DASHBOARD_CONFIRM_MS, VOICE_INBOX_ACTION_TIMEOUT_MS, voiceFocusClockSkewMs, type VoiceAnswer } from "@shared/voice-answers.ts";
import type { ReviewItem } from "@shared/types.ts";
import { explicitAnswerText, matchAnswer, requestedChoice, spokenIndex, VoiceOpenCards, type VoiceQuestions } from "./questions.ts";
import {
  routeUtterance,
  voiceCardCanExpire,
  type HeardEntry,
  type VoiceAddressedCommand,
  type VoiceCard,
  type VoiceDeliveryOutcome,
  type VoiceRouteDecision,
  type VoiceSplitPoint,
  type VoiceUtterance,
} from "@shared/voice-routing.ts";
import { randomUUID } from "node:crypto";
import { spokenNameLabel, type SpokenName } from "@shared/voice-names.ts";
import { agentDisplayName, sessionDisplayNameInput } from "@shared/display-name.ts";
import { VOICE_TURN_PREFIX } from "@shared/voice-delivery.ts";
import type { Session } from "@shared/types.ts";
import { voiceHostTimeUs } from "./host-clock.ts";
import { normalizeSeparatorWord, splitAtSeparator, type SeparatedPart } from "@shared/voice-separator.ts";
import { awaitingVoiceHold, voiceCaptures, VOICE_MAX_HOLD_MS, type VoiceBackend, type VoiceConfig, type VoiceState } from "@shared/voice.ts";
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

interface SeparatedCapture {
  parts: SeparatedPart<VoiceUtterance["words"][number]>[];
  time: ActionTime;
  startHostUs?: number;
  captureKey?: string;
  /** The roster the capture was authorized against. Every part binds to these sessions. */
  roster: SpokenName[];
  /**
   * How many parts have already routed. A routed part keeps only its offset, so a cached
   * capture holds the speech still to be routed and nothing already shown in Recently heard.
   */
  routed: number;
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

// Allow a final Core Audio tap, its 20 ms VAD frame and a loopback POST to arrive.
const ONSET_TRANSIT_MS = 250;
// A missing Cancel result must eventually release its countdown reservation.
const SPEECH_RESULT_TIMEOUT_MS = 35_000;
const FLUID_SPEECH_RESULT_TIMEOUT_MS = 90_000; // One minute of speech, closing silence and CPU decoding.

const HISTORY_LIMIT = 50;
// At most HISTORY_LIMIT reservations can time out per 35 s. Two batches cover
// the listener's 55 s held-POST retry budget even under sustained load.
const EXPIRED_SPEECH_LIMIT = 2 * HISTORY_LIMIT;
const MAX_ACTIVE_CARDS = 50;
const MAX_SPLIT_QUESTIONS = 8;
const MAX_UNSURE_CARDS = 5;
const MAX_CAPTURE_CLOCK_SKEW_MS = 1000;

function recordMatchedName(entry: HeardEntry, target: SpokenName | null | undefined): void {
  entry.matchedName = target?.name ?? null;
  if (target?.isReferenceName) entry.matchedReferenceName = true;
  else delete entry.matchedReferenceName;
}

export class RecentlyHeard {
  private entries: HeardEntry[] = [];
  private readonly epoch = randomUUID();
  private revision = 0;
  private receipts = new Map<string, { revision: number; card: VoiceCard }>();
  get receiptCursor(): string { return this.epoch + ":" + this.revision; }
  recordCard(card: VoiceCard): void {
    this.receipts.delete(card.id);
    if (!voiceCardCanExpire(card)) return;
    this.receipts.set(card.id, { revision: ++this.revision, card });
    if (this.receipts.size > HISTORY_LIMIT) this.receipts.delete(this.receipts.keys().next().value!);
  }
  receiptsAfter(cursor?: string): VoiceCard[] {
    if (!cursor?.startsWith(this.epoch + ":")) return [];
    const revision = Number(cursor.slice(this.epoch.length + 1));
    if (!Number.isSafeInteger(revision) || revision < 0 || cursor !== this.epoch + ":" + revision) return [];
    return [...this.receipts.values()].filter(entry => entry.revision > revision).map(entry => entry.card);
  }
  list(): readonly HeardEntry[] { return this.entries; }
  record(entry: HeardEntry): void {
    const index = this.entries.findIndex((existing) => existing.time <= entry.time);
    this.entries.splice(index < 0 ? this.entries.length : index, 0, entry);
    if (this.entries.length > HISTORY_LIMIT) this.entries.pop();
  }
  clear(): void {
    this.entries = [];
    this.receipts.clear();
  }
}

interface AnswerCapture extends ActionTime {
  sequence: number;
  monotonicMs: number;
}

interface AnswerAttempt extends AnswerCapture {
  reviewId: string;
}

function compareAnswerCaptures(a: AnswerCapture, b: AnswerCapture): number {
  const delta = a.openedAtHostUs !== undefined && b.openedAtHostUs !== undefined
    ? a.openedAtHostUs - b.openedAtHostUs : a.monotonicMs - b.monotonicMs;
  return delta || a.sequence - b.sequence;
}

const inboxActionDetails = {
  invoked: "Inbox action invoked.",
  unavailable: "The inbox action is no longer available.",
  unconfirmed: "The dashboard did not confirm the inbox action.",
};
type InboxActionResult = keyof typeof inboxActionDetails;

interface OpenCard {
  /** Set while a separated capture is routing; the card is sent when the capture's parts are done. */
  heldSends?: Set<string>;
  inboxAction?: () => Promise<InboxActionResult>;
  answer?: VoiceAnswer;
  /** Daemon monotonic deadline. The wire deadline is in wall time for dashboard calibration. */
  answerExpiresAt?: number;
  /** The original answer's speech order survives a picker click and later corrections. */
  answerCapture?: AnswerCapture;
  answerAttempt?: AnswerAttempt;
  recipientAnswer?: { words: string; choiceCommand: boolean };
  questionPick?: { target: SpokenName; words: string; choiceCommand: boolean };
  speechDeadlineUs?: number;
  awaitingSpeech?: boolean;
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
/** How often a held separated action checks whether the card spoken before it has settled. */
const SETTLE_POLL_MS = 50;

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
  readonly forms = new VoicePlanForms();
  private readonly inboxRequests = new Map<string, { claimed: boolean; timer: NodeJS.Timeout; finish(result: InboxActionResult): void }>();
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
  }, report => {
    for (const card of report.cards) if (card.kind === "plan") this.forms.observed(card.id);
  });
  readonly heard = new RecentlyHeard();
  // An active onset starts unclaimed. Once an editor claims it, a later blur
  // must not turn the draft into a session command.
  private readonly dictationCaptures = new Map<string, {
    field?: { windowId: string; target: string };
    boundSequence: number;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private probeSequence = 0;
  private expiredDictationThroughUs = -1;

  async resolveDictation() {
    return this.questions?.probeDictation ? this.openCards.dictationField(this.questions.probeDictation, this.lifetime.signal) : this.focusedField();
  }

  private focusedField() {
    const report = this.openCards.current;
    return report?.dictationTarget ? { windowId: report.windowId, target: report.dictationTarget } : undefined;
  }

  private readonly speechCaptures = new Map<string, { cardId: string; timeout: ReturnType<typeof setTimeout> }>();
  private readonly expiredSpeechKeys = new Set<string>();
  readonly pendingVoiceActions: PendingVoiceAction[] = [];
  private readonly open = new Map<string, OpenCard>();
  // Keep the last accepted capture until its question settles, even after a Cancel.
  private readonly lastAnswer = new Map<string, AnswerAttempt>();
  // Keep the monotonic boundaries for as long as the registry holds the review.
  private questionTimes = new WeakMap<ReviewItem, { created?: number; reminded?: number; closed?: number }>();
  private questionClockOffsetMs = voiceFocusClockSkewMs();
  private clockSampleAt = performance.now();
  private epochStart = this.clockSampleAt;
  private readonly priorEpochs: { start: number; end: number; offset: number }[] = [];
  private lostEpochThrough = -Infinity;
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
  // A separated capture with a refused part keeps its original split, roster and timing until every
  // part has routed, so a retry routes the same messages after a separator or roster edit.
  private readonly separatedCaptures = new Map<string, SeparatedCapture>();
  /** Hold sets of separated captures that are still routing. A card copied later carries a stale one. */
  private readonly activeHolds = new Set<Set<string>>();

  // The model step of each utterance still resolving, so a caller can wait for it.
  private readonly resolutions = new Map<string, Promise<void>>();

  constructor(
    private readonly state: () => Pick<VoiceState, "mode" | "roster"> & {
      backend: VoiceBackend | null; reportsSpeechOnset?: boolean; longCapture?: boolean;
      /** The Always-on separator word. Absent or null routes every capture whole. */
      separatorWord?: string | null;
    },
    private readonly window: () => VoiceConfig["cancelWindow"],
    private readonly deliverer: VoiceDeliverer,
    private readonly emitCard: (card: VoiceCard) => void,
    private readonly decider: VoiceDecider = NO_DECIDER,
    private readonly hostNowUs: () => number = voiceHostTimeUs,
    private readonly questions?: VoiceQuestions,
    private readonly speech?: { resolving?(): void; unsure(card: VoiceCard): void; stop(cardId: string): void },
    private readonly onCancelWindowChange?: (open: boolean) => void,
  ) {}

  captureLimit(key: string): void {
    const id = randomUUID();
    const detail = "Voice capture exceeded 60 seconds. Repeat the message in shorter parts.";
    // The discarded phrase may have been Cancel. Settle only the card it reserved at onset.
    const capture = this.speechCaptures.get(key);
    if (capture) this.cancel(capture.cardId, detail, undefined, key);
    this.heard.record({ id, time: Date.now(), text: "", outcome: "ignored", matchedName: null,
      rule: "capture-limit", pauseMs: null, detail });
    this.publish({ id, state: "cancelled", reason: "capture-limit", detail, deadline: null, candidates: [], parts: [], openQuestions: 0 });
  }

  private publish(card: VoiceCard): void {
    this.heard.recordCard(card);
    this.emitCard(card);
  }

  /** The model step for an utterance, while it runs: settles once its card is resolved. */
  resolution(id: string): Promise<void> | undefined {
    return this.resolutions.get(id);
  }

  private questionTime(capture?: ActionTime): number {
    if (capture?.openedAtHostUs !== undefined) {
      return performance.now() + (capture.openedAtHostUs - this.hostNowUs()) / 1000;
    }
    const now = performance.now();
    const offset = voiceFocusClockSkewMs(this.questionClockOffsetMs);
    if (now < this.clockSampleAt) this.epochStart = now;
    else if (offset !== this.questionClockOffsetMs) {
      this.priorEpochs.push({ start: this.epochStart, end: now, offset: this.questionClockOffsetMs });
      if (this.priorEpochs.length > HISTORY_LIMIT) {
        const oldest = this.priorEpochs.shift()!;
        this.lostEpochThrough = Math.max(this.lostEpochThrough, oldest.end - oldest.offset);
      }
      // The step occurred between two observations. Both epochs can be plausible in that interval.
      this.epochStart = this.clockSampleAt;
    }
    this.questionClockOffsetMs = offset;
    this.clockSampleAt = now;
    const wall = (capture?.openedAt ?? Date.now()) - performance.timeOrigin;
    const current = wall + offset;
    if (!capture || !this.priorEpochs.length) return current;
    if (wall <= this.lostEpochThrough) return NaN;
    const possible = new Set<number>();
    if (current >= this.epochStart - 1 && current <= now + MAX_CAPTURE_CLOCK_SKEW_MS) possible.add(current);
    for (const epoch of this.priorEpochs) {
      const at = wall + epoch.offset;
      if (at >= epoch.start - 1 && at <= epoch.end + 1) possible.add(at);
    }
    return possible.size === 1 ? [...possible][0]! : NaN;
  }

  observeQuestion(review: ReviewItem, previous?: ReviewItem): void {
    let times = previous && this.questionTimes.get(previous);
    if (review.status === "pending" && previous?.status !== "pending") {
      const at = this.questionTime();
      times = previous ? { created: times?.created, reminded: at } : { created: at };
    } else if (review.status !== "pending" && previous?.status === "pending") {
      times = { ...times, closed: this.questionTime() };
    }
    if (times) this.questionTimes.set(review, times);
  }

  reviewSettled(reviewId: string): void {
    this.forms.settled(reviewId);
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

  private actionsAt(time: ActionTime) {
    // Captures can arrive out of order. For equal timestamps, the last action opened wins.
    return this.pendingVoiceActions.filter((action) => offsetUs(action, time) <= 0)
      .reverse().sort((a, b) => offsetUs(b, time) - offsetUs(a, time));
  }

  async probeDictationCapture(key: string, authorized: () => boolean, preview?: string): Promise<boolean> {
    const capture = this.dictationCaptures.get(key);
    if (!capture) return false;
    const sequence = ++this.probeSequence;
    capture.timeout.refresh();
    const field = await this.resolveDictation();
    if (!field || !authorized() || this.dictationCaptures.get(key) !== capture || sequence < capture.boundSequence) return false;
    if (!capture.field) this.releaseSpeechReservation(key);
    capture.field = field;
    capture.boundSequence = sequence;
    if (preview !== undefined) this.questions?.dictate?.(field.windowId, field.target, preview, key, true);
    return true;
  }

  /** Reserve only the action that a cancel at this physical onset could address. */
  speechStarted(key: string, onsetUs: number): void {
    const ageMs = (this.hostNowUs() - onsetUs) / 1000;
    if (this.dictationCaptures.has(key) || onsetUs <= this.expiredDictationThroughUs || ageMs < -MAX_CAPTURE_CLOCK_SKEW_MS) return;
    // Keep each active phrase independently. A missing finish expires after a
    // full hold plus the decoder budget since its last probe.
    const timeout = setTimeout(() => {
      if (this.dictationCaptures.get(key)?.field) {
        this.expiredDictationThroughUs = Math.max(this.expiredDictationThroughUs, onsetUs);
      }
      this.dictationCaptures.delete(key);
    }, VOICE_MAX_HOLD_MS + SPEECH_RESULT_TIMEOUT_MS);
    timeout.unref();
    this.dictationCaptures.set(key, { boundSequence: 0, timeout });
    if (ageMs < 0 || ageMs > ONSET_TRANSIT_MS || this.speechCaptures.has(key) || this.speechCaptures.size >= HISTORY_LIMIT) return;
    const time = { openedAt: Date.now() - ageMs, openedAtHostUs: onsetUs };
    for (const action of this.actionsAt(time)) {
      const item = this.open.get(action.id);
      if (!item?.speechDeadlineUs) return;
      if (onsetUs >= item.speechDeadlineUs) continue;
      const timeout = setTimeout(() => {
        this.expiredSpeechKeys.add(key);
        if (this.expiredSpeechKeys.size > EXPIRED_SPEECH_LIMIT) {
          this.expiredSpeechKeys.delete(this.expiredSpeechKeys.values().next().value!);
        }
        this.releaseSpeechReservation(key);
      }, this.state().longCapture ? FLUID_SPEECH_RESULT_TIMEOUT_MS : SPEECH_RESULT_TIMEOUT_MS);
      timeout.unref();
      this.speechCaptures.set(key, { cardId: action.id, timeout });
      return;
    }
  }

  hasSpeechOnset(key: string): boolean {
    return this.dictationCaptures.has(key);
  }

  speechFinished(key: string): void {
    clearTimeout(this.dictationCaptures.get(key)?.timeout);
    this.dictationCaptures.delete(key);
    this.releaseSpeechReservation(key);
  }

  private releaseSpeechReservation(key: string): void {
    const capture = this.speechCaptures.get(key);
    if (!capture) return;
    this.speechCaptures.delete(key);
    clearTimeout(capture.timeout);
    const item = this.open.get(capture.cardId);
    if (item?.awaitingSpeech) this.sendAfterSpeech(capture.cardId);
  }

  private sendAfterSpeech(id: string): void {
    const item = this.open.get(id);
    if (!item) return;
    for (const capture of this.speechCaptures.values()) {
      if (capture.cardId === id) {
        item.awaitingSpeech = true;
        return;
      }
    }
    void this.sendNow(id);
  }

  private armCountdown(item: OpenCard, duration: number): void {
    item.speechDeadlineUs = this.hostNowUs() + duration * 1000;
    item.awaitingSpeech = false;
    const transit = this.state().reportsSpeechOnset ? ONSET_TRANSIT_MS : 0;
    const id = item.card.id;
    item.timer = setTimeout(() => this.sendAfterSpeech(id), duration + transit);
    item.timer.unref();
    this.onCancelWindowChange?.(true);
  }

  private cancelLatestAt(time: ActionTime, captureKey?: string): string | undefined {
    if (captureKey && this.expiredSpeechKeys.has(captureKey)) return;
    const reserved = captureKey && this.speechCaptures.get(captureKey);
    if (reserved) {
      // Never fall through to another card if an explicit action already settled this one.
      return this.cancel(reserved.cardId, undefined, time, captureKey) ? reserved.cardId : undefined;
    }
    for (const action of this.actionsAt(time)) {
      if (action.kind === "card" && this.open.has(action.id)) {
        if (!this.cancel(action.id, undefined, time)) continue;
      } else {
        action.cancel();
      }
      return action.id;
    }
  }

  holdsSession(sessionId: string, taskId?: string): boolean {
    return [...this.open.values()].map(item => item.card).concat([...this.delivering.values()]).some(card => card.state === "pending" && card.parts.some(({ target }) =>
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

  /** Clears Recently heard and the speech a refused separated capture kept for its retry. */
  clearHistory(): void {
    this.heard.clear();
    this.separatedCaptures.clear();
  }

  private rememberUtterance(id: string) {
    this.recentIds.add(id);
    if (this.recentIds.size > HISTORY_LIMIT) this.recentIds.delete(this.recentIds.values().next().value!);
  }

  async accept(utterance: VoiceUtterance, timing: { heldBeforeRelease?: boolean; startHostUs?: number; speechStartHostUs?: number; captureKey?: string; dictation?: { windowId: string; target: string } | null } = {}): Promise<boolean> {
    const { heldBeforeRelease, startHostUs, speechStartHostUs } = timing;
    const onsetUs = speechStartHostUs ?? startHostUs;
    const { mode, roster, backend, separatorWord } = this.state();
    if (!(voiceCaptures(mode) || (awaitingVoiceHold(mode) && heldBeforeRelease)) || backend !== utterance.backend) return false;
    const { id, capturedAt } = utterance;
    // Released holds already passed the route's monotonic key-down/key-up bounds.
    if (!heldBeforeRelease) {
      const aheadUs = onsetUs !== undefined
        ? onsetUs - this.hostNowUs() : (capturedAt - Date.now()) * 1000;
      if (aheadUs > MAX_CAPTURE_CLOCK_SKEW_MS * 1000) return false;
    }
    if (this.open.has(id) || this.delivering.has(id) || this.recentIds.has(id)) return true;
    const pendingSplit = this.separatedCaptures.get(id);
    if (pendingSplit) return this.routeSeparated(utterance, pendingSplit);
    const capture = timing.captureKey ? this.dictationCaptures.get(timing.captureKey) : undefined;
    const field = (timing.dictation === undefined ? this.focusedField() : timing.dictation)
      ?? capture?.field;
    if (field) {
      this.rememberUtterance(id);
      this.questions?.dictate?.(field.windowId, field.target, utterance.text, timing.captureKey ?? id, false);
      return true;
    }
    // A very late final with no surviving record might belong to an expired
    // editor claim. It cannot safely become a command.
    if (timing.captureKey && !capture && speechStartHostUs !== undefined && speechStartHostUs <= this.expiredDictationThroughUs) return false;
    const leadMs = speechStartHostUs !== undefined && startHostUs !== undefined ? (speechStartHostUs - startHostUs) / 1000 : 0;
    const time = { openedAt: capturedAt + leadMs, openedAtHostUs: onsetUs };
    // Only automatic capture ends at the separator. A hold ends on key release, so the word is text.
    // A call sign spelled like the separator still addresses its agent as the capture's first word.
    const separated = mode === "listening" && !heldBeforeRelease && separatorWord
      ? splitAtSeparator(utterance.text, utterance.words, separatorWord, {
        leadingAddress: roster.some(name => normalizeSeparatorWord(name.name) === normalizeSeparatorWord(separatorWord)),
      }) : null;
    if (separated) {
      return this.routeSeparated(utterance, { parts: separated, time, startHostUs, captureKey: timing.captureKey,
        roster: roster.map(target => ({ ...target })), routed: 0 });
    }
    return this.route(utterance, time, timing.captureKey);
  }

  /**
   * Route each part of a separated capture as its own utterance, in spoken order. A part keeps
   * its own Recently heard entry, card, confirmation and Cancel. Part IDs are `<capture>:<n>`;
   * `:` cannot appear in a listener's capture ID, so they never collide with another capture.
   *
   * Routing stops at the first refused part. The capture keeps its split, roster and timing,
   * and a retry routes from that part on, so a later part (a spoken Cancel included) never
   * runs ahead of the message it follows.
   */
  private async routeSeparated(utterance: VoiceUtterance, split: SeparatedCapture): Promise<boolean> {
    const { id, capturedAt, text } = utterance;
    if (!split.parts.length) {
      this.rememberUtterance(id);
      this.heard.record({ id, time: capturedAt, text, outcome: "ignored", rule: "separator-only", matchedName: null, pauseMs: null, detail: "" });
      return true;
    }
    // With the Cancel window Off a card would be sent as it opens. Hold each one until every part
    // of this capture has routed, so an in-capture Cancel settles before anything is dispatched.
    const heldSends = new Set<string>();
    this.activeHolds.add(heldSends);
    try {
      return await this.routeSeparatedParts(utterance, split, heldSends);
    } finally {
      void this.sendHeldInOrder(split.parts.map((_, index) => `${utterance.id}:${index + 1}`), heldSends);
    }
  }

  /**
   * Releases a separated capture's held cards in capture order, one after another, so a later
   * Stop never overtakes. A part still with the decision model keeps its place: later parts wait
   * for it, and the hold stays active so the card it opens joins the hold too.
   */
  private async sendHeldInOrder(partIds: string[], heldSends: Set<string>): Promise<void> {
    // Earlier parts that were not held: a message on its countdown, an unsure card, a delivery
    // still in flight. A held action after them waits until each is sent or cancelled.
    const earlier: string[] = [];
    try {
      for (const partId of partIds) {
        const resolving = this.resolutions.get(partId);
        if (resolving) await resolving;
        if (!heldSends.has(partId)) {
          earlier.push(partId);
          continue;
        }
        for (const id of earlier.splice(0)) await this.untilSettled(id);
        const item = this.open.get(partId);
        if (!item) continue;
        const sent = this.releasePending(item);
        if (sent) await sent;
        else {
          this.publish(item.card);
          earlier.push(partId);
        }
      }
    } finally {
      this.activeHolds.delete(heldSends);
    }
  }

  /** Resolves once a card has left both the open and the delivering maps: sent, cancelled or cleared. */
  private async untilSettled(id: string): Promise<void> {
    while (this.open.has(id) || this.delivering.has(id)) {
      await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }

  private async routeSeparatedParts(utterance: VoiceUtterance, split: SeparatedCapture, heldSends: Set<string>): Promise<boolean> {
    const { id, capturedAt } = utterance;
    // Turning Voice off (or a reset) ends this lifetime while a part may still be waiting. The
    // unrouted tail is dropped with the history and actions that lifetime held.
    const lifetime = this.lifetime.signal;
    let previous = split.time;
    // The card the preceding part opened. A Cancel spoken after the separator addresses it alone.
    let preceding: string | undefined;
    for (const [index, part] of split.parts.entries()) {
      if (lifetime.aborted) {
        this.separatedCaptures.delete(id);
        return false;
      }
      const partId = `${id}:${index + 1}`;
      // The first part starts at the capture's onset. Later parts start at their first word.
      let at = previous;
      if (index > 0 && part.offsetMs !== null) {
        const candidate = { openedAt: capturedAt + part.offsetMs,
          openedAtHostUs: split.startHostUs !== undefined ? split.startHostUs + Math.round(part.offsetMs * 1000) : split.time.openedAtHostUs };
        at = offsetUs(candidate, previous) >= 0 ? candidate : previous;
      }
      previous = at;
      const done = index < split.routed || this.open.has(partId) || this.delivering.has(partId) || this.recentIds.has(partId);
      if (!done && !await this.route({ ...utterance, id: partId, text: part.text, words: part.words,
        capturedAt: index === 0 ? capturedAt : Math.round(at.openedAt) }, at,
      index === 0 ? split.captureKey : undefined, { roster: split.roster, cancelTarget: index > 0 ? preceding ?? null : undefined, heldSends })) {
        this.separatedCaptures.delete(id);
        if (lifetime.aborted) return false;
        this.separatedCaptures.set(id, split);
        if (this.separatedCaptures.size > HISTORY_LIMIT) this.separatedCaptures.delete(this.separatedCaptures.keys().next().value!);
        return false;
      }
      // Its speech now lives in Recently heard; the retry cache keeps only where it started.
      if (index >= split.routed) {
        split.parts[index] = { text: "", words: [], offsetMs: part.offsetMs };
        split.routed = index + 1;
      }
      preceding = this.open.has(partId) || this.delivering.has(partId) ? partId : undefined;
    }
    this.separatedCaptures.delete(id);
    this.rememberUtterance(id);
    return true;
  }

  /**
   * `roster` pins a separated part to the sessions its capture was authorized against; delivery
   * then refuses a destination another session has since taken over. `cancelTarget` binds a
   * bare Cancel to the card the preceding part opened. It is null when that part opened no card:
   * the Cancel then has nothing to cancel and leaves earlier cards pending. Only a capture that
   * is not separated (`undefined`) lets Cancel take the newest pending action.
   */
  private async route(utterance: VoiceUtterance, time: ActionTime, captureKey?: string,
    options: { roster?: SpokenName[]; cancelTarget?: string | null; heldSends?: Set<string> } = {}): Promise<boolean> {
    const roster = options.roster ?? this.state().roster;
    const { id, capturedAt } = utterance;
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
    this.rememberUtterance(id);
    const entry: HeardEntry = { id, time: capturedAt, text: utterance.text, outcome: "ignored",
      rule: decision.kind, matchedName: null, pauseMs: null, detail: "" };
    this.heard.record(entry);
    if (this.questions) {
      const inbox = this.routeInbox(utterance, decision, entry, time, options.heldSends);
      if (inbox !== false) return inbox;
      const routed = this.routeQuestion(utterance, decision, entry, time, unsureCards, options.heldSends);
      if (routed !== false) return routed;
    }
    if (decision.kind === "ignored") {
      entry.rule = decision.reason;
      entry.matchedName = decision.closest ?? null;
      if (decision.closestReferenceName) entry.matchedReferenceName = true;
      return true;
    }
    if (decision.kind === "control") {
      entry.outcome = "control";
      entry.rule = decision.command;
      if (decision.command === "cancel") {
        const target = options.cancelTarget;
        const cancelled = target === undefined ? this.cancelLatestAt(time, captureKey)
          : target !== null && this.cancel(target, undefined, time) ? target : undefined;
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
      this.startModelStep(decision, utterance, entry, time, options.heldSends);
      return true;
    }
    entry.rule = decision.match;
    recordMatchedName(entry, decision.target);
    const card: VoiceCard = {
      id, state: "pending", deadline: null, openQuestions: 0, reason: entry.rule,
      parts: [{ target: decision.target, text: decision.text }], candidates: [],
    };
    this.openCard({ card, entry, time, message: decision.text, commands: [decision.command], heldSends: options.heldSends });
    return true;
  }

  private routeInbox(utterance: VoiceUtterance, decision: VoiceRouteDecision, entry: HeardEntry, time: ActionTime,
    heldSends?: Set<string>): boolean | Promise<boolean> {
    const inbox = this.questions?.inbox;
    if (!inbox || decision.kind === "control") return false;
    const reply = /^reply(?:,\s*|\s+)(.+)$/iu.exec(utterance.text.trim());
    const named = decision.kind === "addressed" && !decision.command ? decision : null;
    if (!reply && !named) return false;
    const body = (reply?.[1] ?? named!.text).trim();
    const target = reply ? null : named!.target;
    const report = this.openCards.current;
    const address = target && { key: target.key, sessionId: target.sessionId };
    const candidates = addressedCards(report?.cards ?? [], address);
    const card = focusedVoiceCard(candidates);
    const owner = target ?? (card && this.state().roster.find(r => r.sessionId === card.sessionId || (card.kind !== "question" && r.key === card.agentKey))) ?? null;
    const item: OpenCard = { time, entry, message: body, heldSends, card: { id: utterance.id, state: "pending", reason: "inbox-action",
      parts: [{ target: owner, text: body }], deadline: null, openQuestions: 0, candidates: [] } };
    const notice = (detail: string, reason: string) => {
      entry.rule = reason;
      entry.outcome = "cancelled";
      entry.detail = detail;
      this.publish({ ...item.card, state: "cancelled", reason, detail });
      return true;
    };
    const submit = /^submit[.!?]*$/iu.test(body);
    const eligibleCapture = (at: number) => Number.isFinite(at) && this.openCards.captureTiming(time.openedAt, at) === "eligible";
    const planCommand = (submit || isFormChoice(body)) && inbox.formsEnabled();
    const plan = planCommand && report ? planVoiceTarget(report.cards, address) : undefined;
    const forms = planCommand ? inbox.forms() : [];
    const form = plan && forms.find(f => f.id === plan.id);
    const windowId = report?.windowId;
    const name = owner ? spokenNameLabel(owner) : "reply";
    const notOpen = () => {
      const formName = owner ? name + "'s plan form" : "the plan form";
      return notice("Open " + formName + (submit ? " to submit it" : " and say your choice again"), "form-not-open");
    };
    if (planCommand && target && !plan && candidates.some(c => c.kind === "plan")) {
      return notice("Focus the plan form you want and say it again.", "question-notice");
    }
    if (planCommand && target && !form && forms.some(f => f.sessionId === target.sessionId)) return notOpen();
    if (form && windowId) {
      const signal = this.lifetime.signal;
      const current = () => {
        const live = this.openCards.current;
        return !signal.aborted && live?.windowId === windowId && planVoiceTarget(live.cards, address)?.id === form.id &&
          inbox.formsEnabled() && inbox.forms().some(f => f.id === form.id);
      };
      const capturedAtMonotonicMs = this.questionTime(time);
      if (!eligibleCapture(capturedAtMonotonicMs)) return notice("The open card changed. Say it again.", "question-notice");
      entry.rule = submit ? "form-submit" : "form-fill";
      entry.outcome = "control";
      if (submit) {
        const retry = () => notice("Still matching a plan choice. When the selection appears, say “" + name + ", submit” again.", "question-notice");
        if (this.forms.isMatching(form.id)) return retry();
        const submitId = this.forms.request(form.id, capturedAtMonotonicMs, missing => {
          if (missing === undefined) notOpen();
          else if (missing === "matching") retry();
          else notice("Not sent. The " + spokenOrdinal(missing) + " one has no answer yet. Say “" + name + ", " + spokenOrdinal(missing) + " one A”.", "form-incomplete");
        });
        inbox.emit({ type: "voice_form_submit", address, windowId, reviewId: form.id, submitId });
        return true;
      }
      const match = this.forms.beginFill(form.id, capturedAtMonotonicMs);
      return formChoices(form, body, this.decider, owner, signal).then(selections => {
        if (signal.aborted) return true;
        if (!selections || !current()) return notice("No matching decision. Say its position and option letter.", "question-notice");
        const changes = match.apply(selections);
        if (!changes) return notice("Open the plan form and say your selection again.", "question-notice");
        if (changes.length) inbox.emit({ type: "voice_form_fill", address, windowId, reviewId: form.id, selections: changes, capturedAtMonotonicMs });
        return true;
      }).finally(match.finish);
    }
    // Explicit question-answer phrases retain their phase 13 meaning even beside an inbox reply box.
    if (target && (requestedChoice(body) !== undefined || explicitAnswerText(body) !== undefined)) return false;
    let actionCard = card;
    if (target) {
      // A named command identifies its control across the agent's open cards. Plain
      // dictation is contextual, and an unnamed "reply" always stays with the focused card.
      const command = namedInboxCommand(body);
      // routeUtterance already classified interrupts. A remaining "stop" is message text.
      if (command?.action === "stop") return false;
      const offering = candidates.filter(c => (c.kind === "report" || c.kind === "stuck") &&
        (command ? c.actions?.includes(command.action) : spokenInboxAction(c.actions ?? [], body, false)));
      const selected = focusedVoiceCard(offering);
      if (command?.action === "mark-read") {
        if (!selected && candidates.some(c => c.kind === "report")) return notice("Open the report first.", "question-notice");
        const id = inbox.markReadTarget(target, selected?.id ?? null);
        if (!id) return notice("Open the report first.", "question-notice");
        actionCard = candidates.find(c => c.kind === "report" && c.id === id);
        if (!actionCard) {
          // A sole unread report can be addressed even without a dashboard. Recheck the
          // target before running the button's operator action after the cancel window.
          item.inboxAction = async () => {
            const invoked = inbox.markReadTarget(target, null) === id && await inbox.markUndrawnReportRead(id);
            return invoked ? "invoked" : "unavailable";
          };
        }
      } else if (command && !offering.length) {
        return notice(inboxActionDetails.unavailable, "inbox-action");
      } else if (offering.length && (command || !card || card.kind === "report" || card.kind === "stuck")) {
        actionCard = selected;
        if (!actionCard && command) return notice("Focus the card you want and say it again.", "question-notice");
      }
    }
    if (!item.inboxAction) {
      if (!actionCard || !windowId || (actionCard.kind !== "report" && actionCard.kind !== "stuck")) return false;
      if (!eligibleCapture(this.questionTime(time))) return notice("The open card changed. Say it again.", "question-notice");
      const action = spokenInboxAction(actionCard.actions ?? [], body, !!reply);
      if (!action || action.action === "stop") return false;
      const { kind, id } = actionCard;
      item.inboxAction = () => {
        const live = this.openCards.current;
        if (live?.windowId !== windowId || !live.cards.some(c => c.kind === kind && c.id === id && c.actions?.includes(action.action))) return Promise.resolve("unavailable");
        const requestId = crypto.randomUUID();
        return new Promise(resolve => {
          const finish = (result: InboxActionResult) => {
            clearTimeout(request.timer);
            this.inboxRequests.delete(requestId);
            resolve(result);
          };
          const timer = setTimeout(finish, VOICE_INBOX_ACTION_TIMEOUT_MS, "unavailable").unref();
          const request = { claimed: false, timer, finish };
          this.inboxRequests.set(requestId, request);
          inbox.emit({ type: "voice_inbox_action", address, windowId, kind, cardId: id, ...action, requestId });
        });
      };
    }
    if (this.open.size + this.delivering.size >= MAX_ACTIVE_CARDS) return true;
    entry.rule = "inbox-action";
    recordMatchedName(entry, owner);
    this.openCard(item);
    return true;
  }

  claimInbox(id: string) {
    const request = this.inboxRequests.get(id);
    if (!request || request.claimed) return false;
    request.claimed = true;
    clearTimeout(request.timer);
    request.timer = setTimeout(request.finish, VOICE_INBOX_ACTION_TIMEOUT_MS, "unconfirmed").unref();
    return true;
  }

  completeInbox(id: string, invoked: boolean) {
    const request = this.inboxRequests.get(id);
    if (!request?.claimed) return false;
    request.finish(invoked ? "invoked" : "unavailable");
    return true;
  }

  private routeQuestion(utterance: VoiceUtterance, decision: VoiceRouteDecision, entry: HeardEntry,
    time: ActionTime, unsure: VoiceCard[], heldSends?: Set<string>): boolean | Promise<boolean> {
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
    const index = /^option /iu.test(words) ? undefined : spokenIndex(words, false, false);
    if (picks.length && index !== undefined && index >= 0) {
      const retired = this.priorChoices.some(window => window.reason === "answer" && window.state === "unsure" &&
        offsetUs(window.from, time) <= 0 && offsetUs(time, window.until) <= 0);
      const row = !retired && picks.length === 1 && picks[0]!.candidates[index];
      entry.outcome = "control";
      entry.rule = "pick-question";
      return row ? this.pick(picks[0]!.id, row.id, time) : true;
    }
    if (decision.kind === "control") return false;
    const reply = /^reply(?:,\s*|\s+)([\s\S]+)$/iu.exec(words);
    const addressed = (decision.kind === "addressed" && !decision.command) ||
      (decision.kind === "needs-model" && decision.reason === "second-name") ? decision : null;
    const ambiguous = decision.kind === "needs-model" && decision.reason === "ambiguous-name" && !decision.command ? decision : null;
    if (!reply && !addressed && !ambiguous) return false;
    const target = reply ? null : addressed?.target ?? null;
    const body = (reply?.[1] ?? addressed?.text ?? ambiguous!.text).trim();
    if (!body) return false;
    const answer = explicitAnswerText(body);
    const choiceCommand = requestedChoice(body) !== undefined;
    const explicit = !reply && (answer !== undefined || choiceCommand);
    if (!explicit && !(reply && this.openCards.reportingWindows().length)) return false;
    const monotonicMs = this.questionTime(time);
    if (this.open.size + this.delivering.size >= MAX_ACTIVE_CARDS) return true;
    const content = explicit ? answer ?? body : body;
    const item: OpenCard = { entry, time, message: body, heldSends, answerCapture: { ...time, monotonicMs, sequence: ++this.answerSequence },
      card: { id: utterance.id, reason: "answer", state: "pending", parts: [{ target, text: body }],
        openQuestions: 0, deadline: null, candidates: [] } };
    if (!Number.isFinite(monotonicMs)) {
      this.questionNotice(item, "The clock changed during capture. Say your answer again.");
      return true;
    }
    if (ambiguous && explicit) {
      item.recipientAnswer = { words: content, choiceCommand };
      item.pickTargets = ambiguous.candidates;
      item.card = { ...item.card, state: "unsure", reason: "ambiguous-name", candidates: ambiguous.candidates.map(agentRow) };
      item.choicesOfferedAt = laterTime(time, this.now());
      this.openCard(item);
      return true;
    }
    return this.routeCapturedAnswer(item, target, content, choiceCommand);
  }

  private routeCapturedAnswer(item: OpenCard, target: SpokenName | null, content: string, choiceCommand: boolean): boolean | Promise<boolean> {
    const monotonicMs = item.answerCapture!.monotonicMs;
    const reviews = target ? (target.sessionId ? this.questions!.forSession(target.sessionId) : []) : this.questions!.pending();
    const candidates = reviews.filter(review => {
      const times = this.questionTimes.get(review);
      // Restored pending questions predate this listener. A question that closed
      // during transcription still counts, so its answer cannot move to a neighbor.
      return (times?.created === undefined || times.created <= monotonicMs) &&
        (review.status === "pending" || (times?.closed !== undefined && times.closed >= monotonicMs));
    });
    const pending = candidates.filter(q => q.status === "pending");
    recordMatchedName(item.entry, target);
    if (!target && !pending.length) return false;
    if (!pending.length) {
      this.questionNotice(item, spokenNameLabel(target!) + " has no open questions");
      return true;
    }
    if (!content && target) {
      this.offerQuestions(item, pending, target, content, choiceCommand);
      return true;
    }
    return this.routeAnswerContent(item, candidates, content, choiceCommand, target).then(() => true);
  }

  private offerQuestions(item: OpenCard, pending: ReviewItem[], target: SpokenName, words: string, choiceCommand: boolean): void {
    item.choicesOfferedAt = laterTime(item.time, this.now());
    item.questionPick = { target, words, choiceCommand };
    item.card.state = "unsure";
    item.card.candidates = pending.map((q, i) => ({ kind: "question", id: q.id, title: q.title,
      detail: (i + 1) + " · asked " + Math.max(0, Math.floor((Date.now() - q.createdAt) / 60000)) + "m ago" }));
    this.openCard(item);
  }

  private confirmationSignal(signal?: AbortSignal): AbortSignal {
    const signals = [this.lifetime.signal, AbortSignal.timeout(VOICE_DASHBOARD_CONFIRM_MS)];
    if (signal) signals.push(signal);
    return AbortSignal.any(signals);
  }

  private prepareQuestionReply(item: OpenCard, review: ReviewItem, words: string, choiceCommand: boolean, open?: ReviewItem) {
    const woke = this.questionTimes.get(review)?.reminded;
    if (woke !== undefined && item.answerCapture!.monotonicMs <= woke) {
      if (this.open.get(item.card.id) === item) this.take(item);
      this.questionNotice(item, "This question reopened after you spoke. Say your answer again.");
      return;
    }
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
      if (target) this.offerQuestions(item, candidates.filter(q => q.status === "pending"), target, words, choiceCommand);
      return;
    }
    const drawn = this.openCards.target(candidates, !!target);
    const previousWindow = this.openCards.dashboard;
    const calibratingTarget = this.openCards.calibrating ? drawn?.id : undefined;
    this.reserveAnswer(item);
    const windowId = await this.openCards.confirmReplyWindow(windows, this.questions!.confirmFocus, this.confirmationSignal(item.modelStep!.signal));
    if (this.open.get(item.card.id) !== item) return;
    const current = new Map(this.questions!.pending().map(q => [q.id, q]));
    const pending = candidates.filter(q => current.has(q.id));
    // Include the originally eligible cards when reading focus. Settling one while
    // we await the report must not turn its unfocused neighbor into the sole target.
    const focused = this.openCards.target(candidates, !!target);
    // Picking sets a new time for cancellation priority. Only the original
    // speech can establish whether the operator dictated into an open card.
    const capture = item.answerCapture!;
    const timing = this.openCards.captureTiming(capture.openedAt, capture.monotonicMs);
    const changedDuringCalibration = windowId === previousWindow && calibratingTarget && calibratingTarget !== focused?.id;
    const open = windowId && focused && timing === "eligible" && this.openCards.footerOwner(focused.id) === windowId &&
      !changedDuringCalibration ? focused : undefined;
    const destination = fixed ?? open;
    const review = destination && current.get(destination.id);
    if (review) {
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
    const capture = correction
      ? { ...correction.time, monotonicMs: this.questionTime(correction.time), sequence: ++this.answerSequence }
      : item.answerCapture!;
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
    item.card = { ...item.card, id, state: "pending", reason: "voice-answer", detail: undefined, candidates: [], questionTitle: review.title, deadline, windowMs,
      parts: [{ target: target ?? this.state().roster.find(row => row.sessionId === review.sessionId) ?? null, text: result.text }] };
    item.entry.rule = "voice-answer";
    item.entry.outcome = "pending";
    if (windowMs) this.armCountdown(item, Math.max(0, Math.ceil(expiresAt - performance.now())));
    this.questions!.publish(review.id, item.answer);
    if (!item.answer.footerWindowId) this.publish(item.card);
    if (!windowMs) {
      // In a separated capture still routing, a Cancel later in the capture must reach it first.
      // Its zero-length window has not started, so the card has no deadline to expire meanwhile.
      if (item.heldSends && this.activeHolds.has(item.heldSends)) {
        item.card = { ...item.card, deadline: null };
        item.heldSends.add(id);
      } else await this.sendNow(id);
    }
  }

  /**
   * Hand a `needs-model` decision to the model step without holding the listener's request.
   *
   * The card is open, and in the cancel order, from the start, so "cancel" stops it while it is
   * resolving; it is published as `resolving` only once the step has taken a second, so a quick
   * answer shows no intermediate state. A card cancelled, or voice turned off, while the step
   * runs is gone from `open` when the answer comes, and that answer is dropped.
   */
  private startModelStep(decision: NeedsModel, utterance: VoiceUtterance, entry: HeardEntry, time: ActionTime,
    heldSends?: Set<string>): void {
    const { id } = utterance;
    entry.rule = decision.reason;
    recordMatchedName(entry, decision.reason === "second-name" ? decision.target : null);
    entry.outcome = "resolving";
    const possible = decision.reason === "ambiguous-name" ? new Set([...decision.candidates, ...decision.splits.map(s => s.target)]) : decision.candidates;
    const candidates = [...possible].map(agentRow);
    const modelStep = new AbortController();
    const item: OpenCard = {
      entry, time, heldSends,
      message: decision.text,
      choicesOfferedAt: laterTime(time, this.now()),
      modelStep,
      commands: decision.reason === "ambiguous-name" ? [decision.command] : undefined,
      card: { id, state: "resolving", deadline: null, openQuestions: 0, reason: decision.reason, candidates,
        parts: [{ target: decision.reason === "second-name" ? decision.target : null, text: utterance.text }] },
    };
    this.open.set(id, item);
    this.speech?.resolving?.();
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
          recordMatchedName(entry, target);
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
      if (resolved.reason === "model") recordMatchedName(entry, resolved.parts[0]!.target);
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
      // A separated capture is still routing. Nothing it opens may act yet - an immediate Stop
      // or, with the Cancel window Off, an immediate send: a Cancel later in the capture must
      // reach its card first. The capture releases its held cards in spoken order when done.
      // Once the capture holds an action, every later card waits behind it too: a message's
      // countdown must not run out before a Stop spoken ahead of it has been released.
      const actsNow = !window.enabled || !!item.commands?.includes("stop");
      if (item.heldSends && this.activeHolds.has(item.heldSends) && (actsNow || item.heldSends.size > 0)) {
        item.heldSends.add(card.id);
        this.publish(card);
        return;
      }
      if (this.releasePending(item, window)) return;
    }
    this.publish(card);
    if (card.state === "unsure" && !item.questionPick && this.open.get(card.id) === item) this.speech?.unsure(card);
  }

  /**
   * Starts what an open pending card does now: deliver its Stop parts, send it at once (only
   * Stops, or the Cancel window Off), or arm its countdown. Returns the send when it went out at
   * once; otherwise the caller publishes the card with its countdown.
   */
  private releasePending(item: OpenCard, window = this.window()): Promise<boolean> | undefined {
    const { card } = item;
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
    const stopsOnly = card.parts.every((_, index) => item.commands?.[index] === "stop");
    if (stopsOnly || !window.enabled) return this.sendNow(card.id);
    const ms = window.seconds * 1000;
    card.windowMs = ms;
    card.deadline = Date.now() + ms;
    this.armCountdown(item, ms);
    return undefined;
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
    if (item.card.deadline !== null) {
      this.onCancelWindowChange?.([...this.open.values()].some(({ card }) => card.state === "pending" && !!card.windowMs));
    }
  }

  cancelEditedAnswer(reviewId: string, originId: string): boolean {
    const item = [...this.open.values()].find(i => i.answer?.reviewId === reviewId && i.answer.originId === originId);
    return !!item && this.cancel(item.card.id);
  }

  cancel(id: string, detail?: string, capturedAt?: ActionTime, captureKey?: string): boolean {
    const item = this.open.get(id);
    if (!item) return false;
    if (capturedAt?.openedAtHostUs !== undefined && item.speechDeadlineUs !== undefined &&
        capturedAt.openedAtHostUs >= item.speechDeadlineUs) return false;
    if (item.card.deadline !== null && Date.now() >= item.card.deadline) {
      if (!captureKey || this.speechCaptures.get(captureKey)?.cardId !== id) return false;
    }
    this.speech?.stop(id);
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
      if (review && !words) {
        if (item.modelStep) return false;
        item.modelStep = new AbortController();
        const isPending = () => this.questions!.pending().some(q => q.id === candidateId && q.sessionId === target.sessionId);
        const opened = await this.openCards.openQuestion(candidateId, this.questions!.confirmFocus, windowId => {
          if (!isPending()) return false;
          this.questions!.open(windowId, review);
          return true;
        }, this.confirmationSignal(item.modelStep.signal));
        if (this.open.get(id) !== item) return false;
        delete item.modelStep;
        if (!opened && isPending()) {
          item.card = { ...item.card, detail: "Focus a dashboard, then choose this question again." };
          this.publish(item.card);
        } else {
          this.take(item, time);
          this.questionNotice(item, opened ? "Opened question." : "That question is already settled.");
        }
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
    this.speech?.stop(id);
    if (item.recipientAnswer) {
      const { words, choiceCommand } = item.recipientAnswer;
      this.take(item, pickedAt);
      this.questions!.removeCompanion(id);
      delete item.recipientAnswer;
      item.time = pickedAt;
      item.card = { ...item.card, reason: "answer", candidates: [], parts: [{ target, text: words }] };
      return this.routeCapturedAnswer(item, target, words, choiceCommand);
    }
    if (item.remainingSplits?.length) {
      const card: VoiceCard = { ...item.card, reason: "second-name", parts };
      this.closeChoices(item, pickedAt);
      setSplitPicks(item, card, target, item.remainingSplits, "boundary:");
      delete item.remainingSplits;
      item.card = card;
      delete item.pickTargets;
      recordMatchedName(item.entry, target);
      this.publish(card);
      return true;
    }
    this.take(item, pickedAt);
    recordMatchedName(item.entry, parts[0]!.target);
    item.entry.detail = "picked";
    this.openCard({ ...item, time: pickedAt, commands: split ? split.commands : item.commands, card: { ...item.card, state: "pending", reason: split ? "split" : "picked",
      ...(!split && item.splitPicks && { mentions: [...new Set([...item.splitPicks.values()].map(s => s.target))].filter(t => t.key !== target.key) }),
      candidates: [], parts } });
    return true;
  }

  private openQuestionCount(card: VoiceCard): number {
    const ids = new Set(card.parts.map(part => part.target?.sessionId ?? part.restoredSession?.id));
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
        return `Part ${index + 1} (${spokenNameLabel(card.parts[index]!.target!)}) ${status}.${reason}`;
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
        ? `${spokenNameLabel(latest)} isn't running. Nothing was sent. ${latest.kind === "resident" ? "Relaunch the resident." : "Start a follow-up task."}`
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
    if (item.inboxAction) {
      const signal = this.lifetime.signal;
      const result = await item.inboxAction().catch(() => "unavailable" as const);
      if (signal.aborted) return false;
      const ok = result === "invoked";
      item.entry.outcome = ok ? "sent" : "failed";
      this.publish({ ...item.card, state: item.entry.outcome, deadline: null, detail: inboxActionDetails[result] });
      return ok;
    }
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
    if (mode === "off") return;
    const target = roster.find(row => row.sessionId === session.id) ?? null;
    const restoredSession = target ? undefined : { id: session.id, name: agentDisplayName(sessionDisplayNameInput(session, [])).name };
    for (const turn of missing) {
      const id = turn.id.slice(VOICE_TURN_PREFIX.length);
      // Split parts append # and their index to the URL-unreserved capture ID. The
      // live delivery owns every part, even before its queue callback registers a receipt.
      if (this.delivering.has(id.split("#", 1)[0]!)) continue;
      const card: VoiceCard = { id, state: "held", deadline: null,
        parts: [{ target, restoredSession, text: turn.spokenWords!, turnId: turn.id }], candidates: [], reason: "outbox",
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
    this.forms.clear();
    for (const request of this.inboxRequests.values()) request.finish(request.claimed ? "unconfirmed" : "unavailable");
    for (const item of this.open.values()) {
      clearTimeout(item.timer);
      item.modelStep?.abort();
    }
    for (const capture of this.speechCaptures.values()) clearTimeout(capture.timeout);
    for (const capture of this.dictationCaptures.values()) clearTimeout(capture.timeout);
    this.dictationCaptures.clear();
    this.expiredDictationThroughUs = -1;
    this.speechCaptures.clear();
    this.expiredSpeechKeys.clear();
    this.openCards.clear();
    this.open.clear();
    this.lastAnswer.clear();
    this.questionTimes = new WeakMap();
    this.correctionTargets.length = 0;
    this.resolutions.clear();
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.delivering.clear();
    this.outbox.clear();
    this.pendingVoiceActions.length = 0;
    this.clearHistory();
    this.priorChoices.length = 0;
    this.picksLostThrough = undefined;
    this.onCancelWindowChange?.(false);
  }

  reset(): void {
    this.clearActionsAndHistory();
    this.epochStart = this.clockSampleAt = performance.now();
    this.questionClockOffsetMs = voiceFocusClockSkewMs();
    this.priorEpochs.length = 0;
    this.lostEpochThrough = -Infinity;
    this.recentIds.clear();
  }
}
