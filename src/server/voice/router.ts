import { routeUtterance, type HeardEntry, type VoiceAddressedCommand, type VoiceCard, type VoiceDeliveryOutcome, type VoiceUtterance } from "@shared/voice-routing.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import type { VoiceConfig, VoiceState } from "@shared/voice.ts";

type DeliveryResult = Exclude<VoiceDeliveryOutcome, "failed"> | { outcome: "failed"; detail: string };

export interface VoiceDeliverer {
  deliver(target: SpokenName, text: string, utteranceId: string, command?: VoiceAddressedCommand): Promise<DeliveryResult>;
}

export interface PendingVoiceAction {
  id: string;
  kind: string;
  openedAt: number;
  cancel(): void;
}

const HISTORY_LIMIT = 50;
const MAX_UNSURE_CARDS = 5;

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
  command?: VoiceAddressedCommand;
  timer?: ReturnType<typeof setTimeout>;
}

export class VoiceRouter {
  readonly heard = new RecentlyHeard();
  readonly pendingVoiceActions: PendingVoiceAction[] = [];
  private readonly open = new Map<string, OpenCard>();
  private readonly delivering = new Map<string, OpenCard>();
  // Retry protection for recent utterances, including controls. Clearing history releases
  // its words immediately and doesn't make a retried cancel act on another card.
  private readonly recentIds = new Set<string>();

  constructor(
    private readonly state: () => VoiceState,
    private readonly window: () => VoiceConfig["cancelWindow"],
    private readonly deliverer: VoiceDeliverer,
    private readonly publish: (card: VoiceCard) => void,
  ) {}

  activeCards(): VoiceCard[] { return Array.from(this.open.values(), ({ card }) => card); }

  private latestActionAt(capturedAt: number): PendingVoiceAction | undefined {
    let latest: PendingVoiceAction | undefined;
    for (const action of this.pendingVoiceActions) {
      // Captures can arrive out of order. For equal timestamps, the last action opened wins.
      if (action.openedAt <= capturedAt && (!latest || action.openedAt >= latest.openedAt)) latest = action;
    }
    return latest;
  }

  async accept(utterance: VoiceUtterance): Promise<boolean> {
    const { mode, roster } = this.state();
    if (mode !== "listening" && mode !== "push-to-talk") return false;
    const { id } = utterance;
    if (this.open.has(id) || this.delivering.has(id) || this.recentIds.has(id)) return true;
    this.recentIds.add(id);
    if (this.recentIds.size > HISTORY_LIMIT) this.recentIds.delete(this.recentIds.values().next().value!);
    const unsureCards = Array.from(this.open.values())
      .filter(({ card, entry }) => card.state === "unsure" && entry.time <= utterance.capturedAt)
      .map(({ card }) => card);
    const decision = routeUtterance(utterance, { roster, unsureCards });
    const entry: HeardEntry = { id, time: utterance.capturedAt, text: utterance.text, outcome: "ignored",
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
        const action = this.latestActionAt(utterance.capturedAt);
        if (action) { entry.detail = action.id; action.cancel(); }
        else entry.rule = "nothing-pending";
      } else if (!await this.pick(decision.cardId, decision.candidateId, utterance.capturedAt)) {
        entry.outcome = "ignored";
        entry.rule = "candidate-unavailable";
      }
      return true;
    }
    entry.pauseMs = decision.pauseMs;
    const addressed = decision.kind === "addressed";
    entry.rule = addressed ? decision.match : decision.reason;
    entry.matchedName = addressed ? decision.target.name : null;
    const card: VoiceCard = {
      id, state: addressed ? "pending" : "unsure", deadline: null, openQuestions: 0, reason: entry.rule,
      parts: [{ target: addressed ? { ...decision.target } : null, text: addressed ? decision.text : utterance.text }],
      candidates: addressed ? [] : decision.candidates.map((c) => ({ kind: "agent", id: c.key, title: c.name, detail: c.role })),
    };
    await this.openCard({ card, entry, message: decision.text, command: decision.command }, utterance.capturedAt);
    return true;
  }

  private async openCard(item: OpenCard, openedAt: number): Promise<void> {
    const { card, entry } = item;
    this.open.set(card.id, item);
    this.pendingVoiceActions.push({ id: card.id, kind: "card", openedAt, cancel: () => this.cancel(card.id) });
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
      if (!window.enabled) { await this.sendNow(card.id); return; }
      const ms = window.seconds * 1000;
      card.deadline = Date.now() + ms;
      item.timer = setTimeout(() => { void this.sendNow(card.id); }, ms);
      item.timer.unref?.();
    }
    this.publish(card);
  }

  // Claim synchronously before delivery can yield, so a timer and a button can't both send.
  private take(item: OpenCard): void {
    clearTimeout(item.timer);
    this.open.delete(item.card.id);
    const index = this.pendingVoiceActions.findIndex((a) => a.kind === "card" && a.id === item.card.id);
    if (index >= 0) this.pendingVoiceActions.splice(index, 1);
  }

  cancel(id: string, detail?: string): boolean {
    const item = this.open.get(id);
    if (!item) return false;
    this.take(item);
    item.entry.outcome = "cancelled";
    if (detail) item.entry.detail = detail;
    this.publish({ ...item.card, state: "cancelled", deadline: null });
    return true;
  }

  async pick(id: string, candidateId: string, pickedAt = Date.now()): Promise<boolean> {
    const item = this.open.get(id);
    if (item?.card.state !== "unsure" || !item.card.candidates.some((c) => c.id === candidateId)) return false;
    const target = this.state().roster.find((c) => c.key === candidateId);
    if (!target) return false;
    this.take(item);
    item.entry.matchedName = target.name;
    item.entry.detail = "picked";
    await this.openCard({ ...item, card: { ...item.card, state: "pending", reason: "picked",
      candidates: [], parts: [{ target: { ...target }, text: item.message }] } }, Math.max(item.entry.time, pickedAt));
    return true;
  }

  async sendNow(id: string): Promise<boolean> {
    const item = this.open.get(id);
    if (item?.card.state !== "pending") return false;
    this.take(item);
    const { mode, roster } = this.state();
    if (mode === "off") return false;
    const part = item.card.parts[0]!;
    // A roster key can outlive the session shown on the pending card.
    const selected = part.target;
    const target = selected && roster.find((name) => name.key === selected.key && name.sessionId === selected.sessionId);
    this.delivering.set(id, item);
    let result: DeliveryResult = "not-running";
    try {
      if (target) result = await this.deliverer.deliver(target, part.text, id, item.command);
    } catch (error) {
      result = { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    // Disabling voice or shutting down discards even an in-flight interrupt's late card.
    if (this.delivering.get(id) !== item) return true;
    this.delivering.delete(id);
    const outcome = typeof result === "string" ? result : result.outcome;
    if (typeof result !== "string") item.entry.detail = result.detail;
    else if (outcome === "not-running") item.entry.detail = "The selected session is unavailable.";
    item.entry.outcome = outcome;
    if (this.state().mode !== "off") this.publish({ ...item.card, state: outcome, deadline: null });
    return true;
  }

  clearActionsAndHistory(): void {
    for (const item of this.open.values()) clearTimeout(item.timer);
    this.open.clear();
    this.delivering.clear();
    this.pendingVoiceActions.length = 0;
    this.heard.clear();
  }

  reset(): void {
    this.clearActionsAndHistory();
    this.recentIds.clear();
  }
}
