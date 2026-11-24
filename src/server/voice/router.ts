import { routeUtterance, type HeardEntry, type VoiceAddressedCommand, type VoiceCard, type VoiceDeliveryOutcome, type VoiceUtterance } from "@shared/voice-routing.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import { voiceCaptures, type VoiceBackend, type VoiceConfig, type VoiceState } from "@shared/voice.ts";

type DeliveryResult = Exclude<VoiceDeliveryOutcome, "failed"> | { outcome: "failed"; detail: string };

export interface VoiceDeliverer {
  deliver(target: SpokenName, text: string, utteranceId: string, command?: VoiceAddressedCommand): Promise<DeliveryResult>;
}

interface ActionTime {
  openedAt: number;
  openedAtHostUs?: number;
}

// Captures on the shared host timeline retain their physical order across clock
// adjustments. Dashboard actions and Unix-only clients supply the wall time.
function offsetUs(time: ActionTime, reference: ActionTime): number {
  return time.openedAtHostUs !== undefined && reference.openedAtHostUs !== undefined
    ? time.openedAtHostUs - reference.openedAtHostUs : (time.openedAt - reference.openedAt) * 1000;
}

export interface PendingVoiceAction extends ActionTime {
  id: string;
  kind: string;
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
  time: ActionTime;
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

  private cancelLatestAt(time: ActionTime): string | undefined {
    // Captures can arrive out of order. For equal timestamps, the last action opened wins.
    const eligible = this.pendingVoiceActions.filter((action) => offsetUs(action, time) <= 0)
      .reverse().sort((a, b) => offsetUs(b, time) - offsetUs(a, time));
    for (const action of eligible) {
      if (action.kind === "card" && this.open.has(action.id)) {
        if (!this.cancel(action.id)) continue;
      } else {
        action.cancel();
      }
      return action.id;
    }
  }

  async accept(utterance: VoiceUtterance, timing: { heldBeforeRelease?: boolean; startHostUs?: number } = {}): Promise<boolean> {
    const { heldBeforeRelease, startHostUs } = timing;
    const { mode, roster, backend } = this.state();
    if (!(voiceCaptures(mode) || (mode === "auto-muted" && heldBeforeRelease)) || backend !== utterance.backend) return false;
    const { id, capturedAt } = utterance;
    // Released holds already passed the route's monotonic key-down/key-up bounds.
    if (!heldBeforeRelease && capturedAt > Date.now() + MAX_CAPTURE_CLOCK_SKEW_MS) return false;
    if (this.open.has(id) || this.delivering.has(id) || this.recentIds.has(id)) return true;
    const time = { openedAt: capturedAt, openedAtHostUs: startHostUs };
    const unsureCards = Array.from(this.open.values())
      .filter(item => item.card.state === "unsure" && offsetUs(item.time, time) <= 0)
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
    const addressed = decision.kind === "addressed";
    entry.rule = addressed ? decision.match : decision.reason;
    entry.matchedName = addressed ? decision.target.name : null;
    const card: VoiceCard = {
      id, state: addressed ? "pending" : "unsure", deadline: null, openQuestions: 0, reason: entry.rule,
      parts: [{ target: addressed ? { ...decision.target } : null, text: addressed ? decision.text : utterance.text }],
      candidates: addressed ? [] : decision.candidates.map((c) => ({ kind: "agent", id: c.key, title: c.name, detail: c.role })),
    };
    this.openCard({ card, entry, time, message: decision.text, command: decision.command });
    return true;
  }

  private openCard(item: OpenCard): void {
    const { card, entry } = item;
    this.open.set(card.id, item);
    this.pendingVoiceActions.push({ id: card.id, kind: "card", ...item.time, cancel: () => this.cancel(card.id) });
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

  async pick(id: string, candidateId: string, time: ActionTime = { openedAt: Date.now() }): Promise<boolean> {
    const item = this.open.get(id);
    if (item?.card.state !== "unsure" || !item.card.candidates.some((c) => c.id === candidateId)) return false;
    const target = this.state().roster.find((c) => c.key === candidateId);
    if (!target) return false;
    this.take(item);
    item.entry.matchedName = target.name;
    item.entry.detail = "picked";
    this.openCard({ ...item, time, card: { ...item.card, state: "pending", reason: "picked",
      candidates: [], parts: [{ target: { ...target }, text: item.message }] } });
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
    let result: DeliveryResult = "not-running";
    try {
      if (target) {
        this.publish(inFlight);
        result = await this.deliverer.deliver(target, part.text, id, item.command);
      }
    } catch (error) {
      result = { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    // Disabling voice or shutting down discards even an in-flight interrupt's late card.
    if (this.delivering.get(id) !== inFlight) return true;
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
