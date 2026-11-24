import { routeUtterance, type HeardEntry, type VoiceAddressedCommand, type VoiceCard, type VoiceDeliveryOutcome, type VoiceUtterance } from "@shared/voice-routing.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import type { VoiceBackend, VoiceConfig, VoiceState } from "@shared/voice.ts";

type DeliveryResult = Exclude<VoiceDeliveryOutcome, "failed">
  | { outcome: "failed"; detail: string }
  | { outcome: "queued" | "held"; turnId: string };

export interface VoiceDeliverer {
  openQuestions?(sessionId: string): number;
  deliver(target: SpokenName, text: string, utteranceId: string, command?: VoiceAddressedCommand, active?: () => boolean,
    onQueued?: (turnId: string) => void): Promise<DeliveryResult>;
}

export interface PendingVoiceAction {
  id: string;
  kind: string;
  openedAt: number;
  cancel(): void;
}

const HISTORY_LIMIT = 50;
const MAX_ACTIVE_CARDS = 50;
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
  command?: VoiceAddressedCommand;
  timer?: ReturnType<typeof setTimeout>;
}

interface OutboxReceipt {
  card?: VoiceCard;
  entry: WeakRef<HeardEntry>;
  outcome?: "sent" | "cancelled";
}

export class VoiceRouter {
  readonly heard = new RecentlyHeard();
  readonly pendingVoiceActions: PendingVoiceAction[] = [];
  private readonly open = new Map<string, OpenCard>();
  // The outbox can outlive its Recently heard entry. Only the card is needed to publish the receipt.
  private readonly outbox = new Map<string, OutboxReceipt>();
  private readonly delivering = new Map<string, VoiceCard>();
  // Retry protection for recent utterances, including controls. Clearing history releases
  // its words immediately and doesn't make a retried cancel act on another card.
  private readonly recentIds = new Set<string>();

  constructor(
    private readonly state: () => Pick<VoiceState, "mode" | "roster"> & { backend: VoiceBackend | null },
    private readonly window: () => VoiceConfig["cancelWindow"],
    private readonly deliverer: VoiceDeliverer,
    private readonly publish: (card: VoiceCard) => void,
  ) {}

  activeCards(): VoiceCard[] {
    return [...Array.from(this.open.values(), ({ card }) => card), ...this.delivering.values()];
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

  holdsSession(sessionId: string, taskId?: string): boolean {
    return this.activeCards().some(card => card.state === "pending" && card.parts.some(({ target }) =>
      target?.sessionId === sessionId || (taskId && target?.taskId === taskId)));
  }

  async accept(utterance: VoiceUtterance): Promise<boolean> {
    const { mode, roster, backend } = this.state();
    if ((mode !== "listening" && mode !== "push-to-talk") || backend !== utterance.backend) return false;
    const { id, capturedAt } = utterance;
    if (capturedAt > Date.now() + MAX_CAPTURE_CLOCK_SKEW_MS) return false;
    if (this.open.has(id) || this.delivering.has(id) || this.recentIds.has(id)) return true;
    const unsureCards = Array.from(this.open.values())
      .filter(({ card, entry }) => card.state === "unsure" && entry.time <= capturedAt)
      .map(({ card }) => card);
    const decision = routeUtterance(utterance, { roster, unsureCards });
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
    const addressed = decision.kind === "addressed";
    entry.rule = addressed ? decision.match : decision.reason;
    entry.matchedName = addressed ? decision.target.name : null;
    const card: VoiceCard = {
      id, state: addressed ? "pending" : "unsure", deadline: null, openQuestions: 0, reason: entry.rule,
      parts: [{ target: addressed ? { ...decision.target } : null, text: addressed ? decision.text : utterance.text }],
      candidates: addressed ? [] : decision.candidates.map((c) => ({ kind: "agent", id: c.key, title: c.name, detail: c.role })),
    };
    this.openCard({ card, entry, message: decision.text, command: decision.command }, capturedAt);
    return true;
  }

  private openCard(item: OpenCard, openedAt: number): void {
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
      const sessionId = card.parts[0]?.target?.sessionId;
      card.openQuestions = sessionId ? this.deliverer.openQuestions?.(sessionId) ?? 0 : 0;
      if (item.command === "stop" || !window.enabled) { void this.sendNow(card.id); return; }
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
    if (item.card.deadline !== null && Date.now() >= item.card.deadline) return false;
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
    this.openCard({ ...item, card: { ...item.card, state: "pending", reason: "picked",
      candidates: [], parts: [{ target: { ...target }, text: item.message }] } }, pickedAt);
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
    const inFlight = { ...item.card, reason: "delivering", deadline: null };
    this.delivering.set(id, inFlight);
    const active = () => this.delivering.get(id) === inFlight;
    const receipt: OutboxReceipt = { entry: new WeakRef(item.entry) };
    let registeredId: string | undefined;
    let result: DeliveryResult = "not-running";
    try {
      if (target) {
        this.publish(inFlight);
        result = await this.deliverer.deliver(target, part.text, id, item.command, active, turnId => {
          if (!active()) return;
          registeredId = turnId;
          this.outbox.set(turnId, receipt);
        });
      }
    } catch (error) {
      result = { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    // Disabling voice or shutting down discards even an in-flight interrupt's late card.
    if (registeredId !== undefined && this.outbox.get(registeredId) === receipt) this.outbox.delete(registeredId);
    if (!active()) return true;
    this.delivering.delete(id);
    const outcome = receipt.outcome ?? (typeof result === "string" ? result : result.outcome);
    if (typeof result !== "string" && result.outcome === "failed") item.entry.detail = result.detail;
    const recipient = target ?? part.target;
    if (outcome === "not-running" && !target) {
      item.entry.detail = "The selected session is unavailable.";
    } else if (outcome === "not-running" && recipient) {
      item.entry.detail = `${recipient.name} isn't running. Nothing was sent. ${recipient.kind === "resident" ? "Relaunch the resident." : "Start a follow-up task."}`;
    }
    item.entry.outcome = outcome;
    const current = this.state();
    if (current.mode !== "off") {
      const latest = (target && current.roster.find(name => name.key === target.key)) ?? recipient;
      const card: VoiceCard = { ...item.card, state: outcome, deadline: null,
        parts: [{ ...part, target: latest }],
        openQuestions: latest?.sessionId ? this.deliverer.openQuestions?.(latest.sessionId) ?? 0 : 0,
        ...(item.entry.detail && { detail: item.entry.detail }),
      };
      if (!receipt.outcome && typeof result !== "string" && "turnId" in result) {
        receipt.card = card;
        this.outbox.set(result.turnId, receipt);
      }
      this.publish(card);
    }
    return true;
  }

  settleSpoken(turnId: string, outcome: "sent" | "cancelled"): void {
    const pending = this.outbox.get(turnId);
    if (!pending) return;
    this.outbox.delete(turnId);
    pending.outcome = outcome;
    const entry = pending.entry.deref();
    if (entry) entry.outcome = outcome;
    if (pending.card) this.publish({ ...pending.card, state: outcome });
  }

  clearActionsAndHistory(): void {
    for (const item of this.open.values()) clearTimeout(item.timer);
    this.open.clear();
    this.delivering.clear();
    this.outbox.clear();
    this.pendingVoiceActions.length = 0;
    this.heard.clear();
  }

  reset(): void {
    this.clearActionsAndHistory();
    this.recentIds.clear();
  }
}
