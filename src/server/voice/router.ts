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
import type { VoiceBackend, VoiceConfig, VoiceState } from "@shared/voice.ts";
import { VOICE_MODEL_STAGE_DEADLINE_MS, VOICE_RESOLVING_AFTER_MS, voiceAnswersUnsure, type VoiceChoice, type VoiceDecisionResult, type VoiceQuestion } from "@shared/voice-decide.ts";
import type { VoiceDecider } from "./decide.ts";

type DeliveryResult = Exclude<VoiceDeliveryOutcome, "failed"> | { outcome: "failed"; detail: string };

export interface VoiceDeliverer {
  available?(sessionId: string): boolean;
  deliver(target: SpokenName, text: string, utteranceId: string, command?: VoiceAddressedCommand): Promise<DeliveryResult>;
}

export interface PendingVoiceAction {
  id: string;
  kind: string;
  openedAt: number;
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

interface OpenCard {
  card: VoiceCard;
  entry: HeardEntry;
  message: string;
  pickTargets?: readonly SpokenName[];
  choicesOfferedAt?: number;
  splitPicks?: Map<string, VoiceSplitPoint>;
  modelStep?: AbortController;
  resolvingVisible?: boolean;
  remainingSplits?: VoiceSplitPoint[];
  commands?: VoiceSplitPoint["commands"];
  timer?: ReturnType<typeof setTimeout>;
}

type NeedsModel = Extract<VoiceRouteDecision, { kind: "needs-model" }>;

/** A decider with no rung: every answer "not sure". Routing then shows the roster rows. */
const NO_DECIDER: VoiceDecider = {
  ask: async (questions) => ({ rung: "none", answers: voiceAnswersUnsure(questions), detail: "no model step" }),
};

function choiceOf(name: SpokenName): VoiceChoice {
  return { id: name.key, label: name.name, detail: name.role };
}

function selectedSession(roster: readonly SpokenName[], selected: SpokenName) {
  return roster.find(name => name.key === selected.key && name.sessionId === selected.sessionId);
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
  return { kind: "agent", id: target.key, title: target.name, detail: target.role };
}

function setSplitPicks(item: OpenCard, card: VoiceCard, first: SpokenName, splits: VoiceSplitPoint[], prefix = ""): void {
  item.splitPicks = splitPickOptions(first.key, splits, prefix);
  card.candidates = [{ ...agentRow(first), id: prefix + first.key, detail: `${first.role} · Keep the whole message` }];
  for (const [id, { target, tail }] of item.splitPicks) {
    card.candidates.push({ ...agentRow(target), id, detail: `${target.role} · Split here: ${tail.slice(0, 120)}` });
  }
}

/** How bad each outcome is, for a split whose two parts ended differently: the card shows the worse. */
const OUTCOME_SEVERITY: readonly VoiceDeliveryOutcome[] = ["failed", "not-running", "held", "queued", "sent"];

function worse(a: VoiceDeliveryOutcome, b: VoiceDeliveryOutcome): VoiceDeliveryOutcome {
  return OUTCOME_SEVERITY.indexOf(a) <= OUTCOME_SEVERITY.indexOf(b) ? a : b;
}

/**
 * The questions a `needs-model` decision asks: who, when the heard name is in doubt; otherwise
 * one split question per later name, the first target fixed and never asked about.
 */
export function voiceQuestionsFor(decision: NeedsModel, utterance: VoiceUtterance): VoiceQuestion[] {
  if (decision.reason === "ambiguous-name") {
    if (decision.match === "exact") return [];
    return [{ kind: "who", text: utterance.text, candidates: decision.candidates.map(choiceOf) }];
  }
  // An earlier split can settle the sentence before a name shared by several agents.
  const ambiguous = decision.splits.findIndex(split => split.ambiguousTarget);
  const decidable = ambiguous < 0 ? decision.splits : decision.splits.slice(0, ambiguous);
  if (decidable.length > MAX_SPLIT_QUESTIONS) return [];
  return decidable.map((split) => ({
    kind: "split", text: utterance.text, first: choiceOf(decision.target), second: choiceOf(split.target),
    ...(decision.splits.length > 1 ? { nameOffset: split.at } : {}),
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
  readonly heard = new RecentlyHeard();
  readonly pendingVoiceActions: PendingVoiceAction[] = [];
  private readonly open = new Map<string, OpenCard>();
  // Earlier choice rows can block a delayed spoken pick, but can never be picked again.
  private readonly priorChoices: { from: number; until: number; names: string[] }[] = [];
  private picksKnownFrom = 0;
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
  ) {}

  /** The model step for an utterance, while it runs: settles once its card is resolved. */
  resolution(id: string): Promise<void> | undefined {
    return this.resolutions.get(id);
  }

  activeCards(): VoiceCard[] {
    const visible = [...this.open.values()].filter(item => item.card.state !== "resolving" || item.resolvingVisible);
    return [...visible.map(item => item.card), ...this.delivering.values()];
  }

  private cancelLatestAt(capturedAt: number): string | undefined {
    // Captures can arrive out of order. For equal timestamps, the last action opened wins.
    const eligible = this.pendingVoiceActions.filter((action) => action.openedAt <= capturedAt)
      .reverse().sort((a, b) => b.openedAt - a.openedAt);
    for (const action of eligible) {
      if (action.kind === "card" && this.open.has(action.id)) {
        if (!this.cancel(action.id)) continue;
      } else {
        action.cancel();
      }
      return action.id;
    }
  }

  private closeChoices(item: OpenCard, at = Date.now()): void {
    if (item.card.state !== "resolving" && item.card.state !== "unsure") return;
    const from = item.choicesOfferedAt ?? item.entry.time;
    const until = Math.max(from, at);
    item.choicesOfferedAt = until;
    if (until === from) return;
    this.priorChoices.push({ from, until, names: [...new Set(item.card.candidates.map(c => c.title))] });
    if (this.priorChoices.length > HISTORY_LIMIT) {
      this.picksKnownFrom = Math.max(this.picksKnownFrom, this.priorChoices.shift()!.until);
    }
  }

  async accept(utterance: VoiceUtterance): Promise<boolean> {
    const { mode, roster, backend } = this.state();
    if ((mode !== "listening" && mode !== "push-to-talk") || backend !== utterance.backend) return false;
    const { id, capturedAt } = utterance;
    if (capturedAt > Date.now() + MAX_CAPTURE_CLOCK_SKEW_MS) return false;
    if (this.open.has(id) || this.delivering.has(id) || this.recentIds.has(id)) return true;
    const unsureCards = capturedAt < this.picksKnownFrom ? [] : Array.from(this.open.values())
      .filter(({ card, entry, choicesOfferedAt }) => (card.state === "unsure" || card.state === "resolving") &&
        entry.time <= capturedAt && (choicesOfferedAt === undefined || choicesOfferedAt <= capturedAt))
      .map(({ card }) => card);
    const priorPickNames = this.priorChoices
      .filter(window => window.from <= capturedAt && capturedAt < window.until)
      .flatMap(window => window.names);
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
    if (decision.kind === "ignored") {
      entry.rule = decision.reason;
      entry.matchedName = decision.closest ?? null;
      return true;
    }
    if (decision.kind === "control") {
      entry.outcome = "control";
      entry.rule = decision.command;
      if (decision.command === "cancel") {
        const cancelled = this.cancelLatestAt(capturedAt);
        if (cancelled) entry.detail = cancelled;
        else entry.rule = "nothing-pending";
      } else if (!await this.pick(decision.cardId, decision.candidateId, capturedAt)) {
        entry.outcome = "ignored";
        entry.rule = "candidate-unavailable";
      }
      return true;
    }
    entry.pauseMs = decision.pauseMs;
    if (decision.kind === "needs-model") {
      this.startModelStep(decision, utterance, entry);
      return true;
    }
    entry.rule = decision.match;
    entry.matchedName = decision.target.name;
    const card: VoiceCard = {
      id, state: "pending", deadline: null, openQuestions: 0, reason: entry.rule,
      parts: [{ target: decision.target, text: decision.text }], candidates: [],
    };
    this.openCard({ card, entry, message: decision.text, commands: [decision.command] }, capturedAt);
    return true;
  }

  /**
   * Hand a `needs-model` decision to the model step without holding the listener's request.
   *
   * The card is open, and in the cancel order, from the start, so "cancel" stops it while it is
   * resolving; it is published as `resolving` only once the step has taken a second, so a quick
   * answer shows no intermediate state. A card cancelled, or voice turned off, while the step
   * runs is gone from `open` when the answer comes, and that answer is dropped.
   */
  private startModelStep(decision: NeedsModel, utterance: VoiceUtterance, entry: HeardEntry): void {
    const { id } = utterance;
    entry.rule = decision.reason;
    entry.matchedName = decision.reason === "second-name" ? decision.target.name : null;
    entry.outcome = "resolving";
    const possible = decision.reason === "ambiguous-name" ? new Set([...decision.candidates, ...decision.splits.map(s => s.target)]) : decision.candidates;
    const candidates = [...possible].map(agentRow);
    const modelStep = new AbortController();
    const item: OpenCard = {
      entry,
      message: decision.text,
      modelStep,
      commands: decision.reason === "ambiguous-name" ? [decision.command] : undefined,
      card: { id, state: "resolving", deadline: null, openQuestions: 0, reason: decision.reason, candidates,
        parts: [{ target: decision.reason === "second-name" ? decision.target : null, text: utterance.text }] },
    };
    this.open.set(id, item);
    this.pendingVoiceActions.push({ id, kind: "card", openedAt: entry.time, cancel: () => this.cancel(id) });
    item.timer = setTimeout(() => {
      if (this.open.get(id) !== item) return;
      item.resolvingVisible = true;
      this.publish(item.card);
    }, VOICE_RESOLVING_AFTER_MS);
    item.timer.unref?.();
    const deadline = performance.now() + VOICE_MODEL_STAGE_DEADLINE_MS;
    const ask = async (current: NeedsModel): Promise<VoiceDecisionResult> => {
      const questions = voiceQuestionsFor(current, utterance);
      if (!questions.length) return { rung: "none", answers: [], detail: "manual selection required" };
      const involved = new Set(questions.flatMap(q => q.kind === "split" ? [q.first.id, q.second.id] :
        q.kind === "who" ? q.candidates.map(c => c.id) : []));
      const agents = current.candidates.filter(c => involved.has(c.key)).map(c => c.agent);
      try {
        return await this.decider.ask(questions, { agents, signal: modelStep.signal, deadline });
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
          item.card = { ...item.card, parts: [{ ...item.card.parts[0]!, target }], candidates: decision.candidates.map(agentRow) };
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
        this.openCard({ ...item, timer: undefined, card, pickTargets: decision.candidates }, entry.time);
        return;
      }
      if (resolved.reason === "model") entry.matchedName = resolved.parts[0]!.target!.name;
      this.openCard({ ...item, timer: undefined, commands: resolved.commands ?? item.commands,
        card: { ...item.card, state: "pending", reason: resolved.reason, candidates: [], parts: resolved.parts } }, entry.time);
    };
    const done = settle().finally(() => { if (this.resolutions.get(id) === done) this.resolutions.delete(id); });
    this.resolutions.set(id, done);
  }

  private openCard(item: OpenCard, openedAt: number): void {
    const { card, entry } = item;
    // A resolving card already has its place in capture order, including ties.
    if (!this.open.has(card.id)) {
      this.pendingVoiceActions.push({ id: card.id, kind: "card", openedAt, cancel: () => this.cancel(card.id) });
    }
    this.open.set(card.id, item);
    entry.outcome = card.state;
    if (card.state === "unsure") {
      const unsure = Array.from(this.open.values()).filter((item) => item.card.state === "unsure");
      if (unsure.length > MAX_UNSURE_CARDS) {
        const oldest = unsure.reduce((first, next) => next.entry.time < first.entry.time ? next : first);
        this.cancel(oldest.card.id, "Replaced by a newer unsure card.");
        if (oldest === item) return;
      }
    }
    if (card.state === "pending") {
      const window = this.window();
      if (!window.enabled) { void this.sendNow(card.id); return; }
      const ms = window.seconds * 1000;
      card.deadline = Date.now() + ms;
      item.timer = setTimeout(() => { void this.sendNow(card.id); }, ms);
      item.timer.unref?.();
    }
    this.publish(card);
  }

  // Claim synchronously before delivery can yield, so a timer and a button can't both send.
  private take(item: OpenCard): void {
    this.closeChoices(item);
    clearTimeout(item.timer);
    this.open.delete(item.card.id);
    const index = this.pendingVoiceActions.findIndex((a) => a.kind === "card" && a.id === item.card.id);
    if (index >= 0) this.pendingVoiceActions.splice(index, 1);
  }

  cancel(id: string, detail?: string): boolean {
    const item = this.open.get(id);
    if (!item) return false;
    if (item.card.deadline !== null && Date.now() >= item.card.deadline) return false;
    this.take(item);
    item.modelStep?.abort();
    item.entry.outcome = "cancelled";
    if (detail) item.entry.detail = detail;
    this.publish({ ...item.card, state: "cancelled", deadline: null });
    return true;
  }

  async pick(id: string, candidateId: string, pickedAt = Date.now()): Promise<boolean> {
    const item = this.open.get(id);
    if (item?.card.state !== "unsure" || !item.card.candidates.some((c) => c.id === candidateId)) return false;
    const roster = this.state().roster;
    const split = item.splitPicks?.get(candidateId);
    const target = item.splitPicks ? split?.target ?? item.card.parts[0]?.target
      : item.pickTargets?.find(c => c.key === candidateId);
    if (!target) return false;
    let parts = [{ target, text: item.message }];
    if (split) {
      const first = item.card.parts[0]?.target;
      if (!first) return false;
      parts = [{ target: first, text: split.head }, { target, text: split.tail }];
    }
    if (parts.some(part => !selectedSession(roster, part.target))) return false;
    if (item.remainingSplits?.length) {
      const card: VoiceCard = { ...item.card, reason: "second-name", parts };
      this.closeChoices(item, Math.max(Date.now(), pickedAt));
      setSplitPicks(item, card, target, item.remainingSplits, "boundary:");
      delete item.remainingSplits;
      item.card = card;
      delete item.pickTargets;
      item.entry.matchedName = target.name;
      this.publish(card);
      return true;
    }
    this.take(item);
    item.entry.matchedName = parts[0]!.target.name;
    item.entry.detail = "picked";
    this.openCard({ ...item, commands: split ? split.commands : item.commands, card: { ...item.card, state: "pending", reason: split ? "split" : "picked",
      candidates: [], parts } }, pickedAt);
    return true;
  }

  private deliveryTarget(roster: readonly SpokenName[], captured: SpokenName | null): SpokenName | undefined {
    const target = captured && selectedSession(roster, captured);
    return target?.state === "running" && target.sessionId && this.deliverer.available?.(target.sessionId) !== false
      ? target : undefined;
  }

  async sendNow(id: string): Promise<boolean> {
    const item = this.open.get(id);
    if (item?.card.state !== "pending") return false;
    this.take(item);
    const { mode, roster } = this.state();
    if (mode === "off") return false;
    if (item.card.parts.some(({ target }) => !this.deliveryTarget(roster, target))) {
      item.entry.outcome = "not-running";
      item.entry.detail = "The selected session is unavailable.";
      this.publish({ ...item.card, state: "not-running", deadline: null });
      return true;
    }
    const inFlight = { ...item.card, reason: "delivering", deadline: null };
    this.delivering.set(id, inFlight);
    this.publish(inFlight);
    // A split delivers each part in the order it was said; the card shows the worse outcome.
    let outcome: VoiceDeliveryOutcome | null = null;
    for (const [index, part] of item.card.parts.entries()) {
      const state = this.state();
      if (this.delivering.get(id) !== inFlight || state.mode === "off") return true;
      const target = this.deliveryTarget(state.roster, part.target);
      let result: DeliveryResult = "not-running";
      try {
        if (target) {
          const partId = index === 0 ? id : `${id}#${index + 1}`;
          result = await this.deliverer.deliver(target, part.text, partId, item.commands?.[index]);
        }
      } catch (error) {
        result = { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
      }
      const delivered = typeof result === "string" ? result : result.outcome;
      if (typeof result !== "string") item.entry.detail = result.detail;
      outcome = outcome === null ? delivered : worse(outcome, delivered);
    }
    outcome ??= "not-running";
    if (outcome === "not-running") item.entry.detail = "The selected session is unavailable.";
    // Disabling voice or shutting down discards even an in-flight interrupt's late card.
    if (this.delivering.get(id) !== inFlight) return true;
    this.delivering.delete(id);
    item.entry.outcome = outcome;
    if (this.state().mode !== "off") this.publish({ ...item.card, state: outcome, deadline: null });
    return true;
  }

  clearActionsAndHistory(): void {
    for (const item of this.open.values()) {
      clearTimeout(item.timer);
      item.modelStep?.abort();
    }
    this.open.clear();
    this.resolutions.clear();
    this.delivering.clear();
    this.pendingVoiceActions.length = 0;
    this.heard.clear();
    this.priorChoices.length = 0;
    this.picksKnownFrom = 0;
  }

  reset(): void {
    this.clearActionsAndHistory();
    this.recentIds.clear();
  }
}
