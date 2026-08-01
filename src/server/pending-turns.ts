import { randomUUID } from "node:crypto";
import type { MessageSendDisposition, PendingTurn, ServerEvent, Session } from "@shared/types.ts";
import { canMessage } from "@shared/pane.ts";
import { settledIdle } from "@shared/session.ts";
import { injectPrompt, type InjectResult } from "./actions.ts";
import {
  claimNextPendingTurn,
  createPendingTurn,
  deleteClaimedPendingTurn,
  markPendingTurnUncertain,
  recallPendingTurn,
  recoverSendingPendingTurns,
  rekeyPendingTurns,
  releasePendingTurn,
  resolveUncertainPendingTurn,
  retryPendingTurn,
} from "./db.ts";
import { noteKeyFor, type Registry } from "./registry.ts";
import type { SdkTurn } from "./harness/types.ts";
import { unref } from "./util/timers.ts";

const DEFAULT_IDLE_SETTLE_MS = 1_500;
const DEFAULT_PICKUP_TIMEOUT_MS = 15_000;

export interface IdleSdkSender {
  sendWhenIdle(
    id: string,
    turn: SdkTurn,
    beforeSend?: () => string | null,
  ): Promise<"started" | null>;
}

export interface PendingTurnSubmitResult {
  ok: boolean;
  pasted: false;
  submitVerified: false;
  delivery?: MessageSendDisposition;
  pendingTurn?: PendingTurn;
  error?: string;
}

interface PendingTurnDeps {
  now: () => number;
  id: () => string;
  inject: typeof injectPrompt;
  idleSettleMs: number;
  pickupTimeoutMs: number;
}

interface PickupCandidate {
  turn: PendingTurn;
  boundaryAt: number;
  injectionSucceeded: boolean;
  pickupObserved: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Durable human-turn outbox shared by embedded and terminal conversations.
 *
 * The manager reacts only to registry evidence. An idle card is necessary but never the
 * delivery boundary by itself: SDK drivers re-check idleness while accepting, and terminal
 * rows remain claimed until a hook or passive reader observes work beginning. That keeps an
 * editable row on Mission Control's side of the line and makes every ambiguous terminal
 * outcome an explicit human decision instead of an automatic duplicate.
 */
export class PendingTurnManager {
  private readonly deps: PendingTurnDeps;
  private readonly draining = new Set<string>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pickup = new Map<string, PickupCandidate>();
  private readonly activeDeliveries = new Map<string, Promise<void>>();
  private readonly resetPreserve = new Map<string, Set<string>>();
  private readonly knownKeys = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly registry: Registry,
    private readonly sdk: IdleSdkSender,
    deps: Partial<PendingTurnDeps> = {},
  ) {
    this.deps = {
      now: deps.now ?? Date.now,
      id: deps.id ?? randomUUID,
      inject: deps.inject ?? injectPrompt,
      idleSettleMs: deps.idleSettleMs ?? DEFAULT_IDLE_SETTLE_MS,
      pickupTimeoutMs: deps.pickupTimeoutMs ?? DEFAULT_PICKUP_TIMEOUT_MS,
    };
  }

  /** Begin recovery and delivery only after the daemon has won its loopback port. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    recoverSendingPendingTurns(this.deps.now());
    this.unsubscribe = this.registry.subscribe((event) => this.observe(event));
    for (const session of this.registry.snapshot().sessions) {
      this.knownKeys.set(session.id, noteKeyFor(session));
      this.registry.refreshPendingTurns(noteKeyFor(session));
      this.observeSession(this.registry.getSession(session.id) ?? session);
    }
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    for (const candidate of this.pickup.values()) {
      if (candidate.timer) clearTimeout(candidate.timer);
    }
    this.idleTimers.clear();
    this.pickup.clear();
  }

  /**
   * Establish reset as a delivery boundary before reset policy clears durable rows.
   *
   * A queued row is safe for reset to discard. A row whose SDK handoff or terminal paste
   * may already have crossed is not: settle the active delivery and return its id so reset
   * retains the resulting `uncertain` row for explicit operator resolution.
   */
  async invalidateForReset(sessionId: string): Promise<readonly string[]> {
    const session = this.registry.getSession(sessionId);
    if (!session) return [];
    const key = noteKeyFor(session);
    const preserve = new Set<string>();
    this.resetPreserve.set(sessionId, preserve);
    this.cancelIdleTimer(key);

    const active = this.activeDeliveries.get(sessionId);
    if (active) {
      try {
        await active;
      } catch {
        // Delivery owns its durable transition. Reset still performs the defensive pickup
        // check below in case an unexpected failure left a terminal candidate behind.
      }
    }

    const candidate = this.pickup.get(key);
    if (candidate) {
      this.markResetUncertain(
        sessionId,
        candidate.turn,
        "Session reset began after terminal delivery may have crossed its write boundary.",
      );
    }
    return [...preserve];
  }

  /** Resume a safely refused queued row only after reset's registry marker is gone. */
  finishReset(sessionId: string): void {
    this.resetPreserve.delete(sessionId);
    const session = this.registry.getSession(sessionId);
    if (session && this.readyToDrain(session)) this.scheduleDrain(noteKeyFor(session));
  }

  submit(sessionId: string, text: string): PendingTurnSubmitResult {
    if (!this.started) {
      return {
        ok: false,
        pasted: false,
        submitVerified: false,
        error: "pending turns are still starting",
      };
    }
    const session = this.registry.getSession(sessionId);
    if (!session) {
      return { ok: false, pasted: false, submitVerified: false, error: "no such session" };
    }
    if (!canMessage(session) || session.state === "exited") {
      return {
        ok: false,
        pasted: false,
        submitVerified: false,
        error: "this session cannot receive messages",
      };
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, pasted: false, submitVerified: false, error: "message is empty" };
    }
    const pendingTurn = createPendingTurn({
      id: this.deps.id(),
      noteKey: noteKeyFor(session),
      text,
      now: this.deps.now(),
    });
    this.registry.refreshPendingTurns(pendingTurn.noteKey);
    this.scheduleDrain(pendingTurn.noteKey);
    return {
      ok: true,
      pasted: false,
      submitVerified: false,
      delivery: "pending",
      pendingTurn,
    };
  }

  recall(sessionId: string, id: string, revision: number): PendingTurn | null {
    if (!this.started) return null;
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    const key = noteKeyFor(session);
    const recalled = recallPendingTurn(key, id, revision);
    if (recalled) this.registry.refreshPendingTurns(key);
    return recalled;
  }

  retry(sessionId: string, id: string, revision: number): PendingTurn | null {
    if (!this.started) return null;
    const session = this.registry.getSession(sessionId);
    if (!session) return null;
    const key = noteKeyFor(session);
    const row = session.pendingTurns.find((turn) => turn.id === id);
    if (!row || row.noteKey !== key) return null;
    const retried = retryPendingTurn(id, revision, this.deps.now());
    if (retried) {
      this.registry.refreshPendingTurns(key);
      this.scheduleDrain(key);
    }
    return retried;
  }

  resolve(sessionId: string, id: string, revision: number): boolean {
    if (!this.started) return false;
    const session = this.registry.getSession(sessionId);
    if (!session) return false;
    const key = noteKeyFor(session);
    const row = session.pendingTurns.find((turn) => turn.id === id);
    if (!row || row.noteKey !== key) return false;
    const resolved = resolveUncertainPendingTurn(id, revision);
    if (resolved) {
      this.registry.refreshPendingTurns(key);
      this.scheduleDrain(key);
    }
    return resolved;
  }

  private observe(event: ServerEvent): void {
    if (event.type === "session_remove") {
      const key = this.knownKeys.get(event.id);
      this.knownKeys.delete(event.id);
      if (key) {
        const owner = this.registry.sessionForNoteKey(key);
        if (owner) this.observeSession(owner);
      }
      return;
    }
    if (event.type === "session_upsert") this.observeSession(event.session);
  }

  private observeSession(session: Session): void {
    const key = noteKeyFor(session);
    const previousKey = this.knownKeys.get(session.id);
    this.knownKeys.set(session.id, key);
    if (previousKey && previousKey !== key) this.moveConversationKey(previousKey, key);
    const candidate = this.pickup.get(key);
    if (
      candidate &&
      session.state === "working" &&
      session.stateConfirmed &&
      (session.lastActivity ?? 0) >= candidate.boundaryAt
    ) {
      candidate.pickupObserved = true;
      // A reset owns the session now. Evidence that arrives while injection is settling is
      // provisional until deliverTerminal records the reset-safe uncertain transition.
      if (
        candidate.injectionSucceeded &&
        !this.registry.sessionResetInProgress(session.id)
      ) {
        this.completePickup(candidate.turn);
      }
      return;
    }
    if (this.readyToDrain(session)) this.scheduleDrain(key);
    else this.cancelIdleTimer(key);
  }

  private moveConversationKey(fromKey: string, toKey: string): void {
    this.cancelIdleTimer(fromKey);
    if (!rekeyPendingTurns(fromKey, toKey, this.deps.now())) return;
    const candidate = this.pickup.get(fromKey);
    if (candidate) {
      this.pickup.delete(fromKey);
      candidate.turn.noteKey = toKey;
      this.pickup.set(toKey, candidate);
    }
    this.registry.refreshPendingTurns(fromKey);
    this.registry.refreshPendingTurns(toKey);
  }

  private readyToDrain(session: Session): boolean {
    return (
      session.stateConfirmed &&
      session.paneDialog === null &&
      !this.registry.sessionResetInProgress(session.id) &&
      canMessage(session) &&
      settledIdle(session, this.deps.now(), this.deps.idleSettleMs)
    );
  }

  private scheduleDrain(key: string): void {
    if (this.stopped || this.idleTimers.has(key) || this.draining.has(key) || this.pickup.has(key)) {
      return;
    }
    const session = this.registry.sessionForNoteKey(key);
    if (!session || !session.stateConfirmed || session.state !== "idle" || session.paneDialog) return;
    const idleSince = session.lastActivity ?? session.firstSeen;
    const delay = Math.max(0, idleSince + this.deps.idleSettleMs - this.deps.now());
    const timer = unref(
      setTimeout(() => {
        this.idleTimers.delete(key);
        void this.drain(key);
      }, delay),
    );
    this.idleTimers.set(key, timer);
  }

  private cancelIdleTimer(key: string): void {
    const timer = this.idleTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.idleTimers.delete(key);
  }

  private drain(key: string): Promise<void> {
    const session = this.registry.sessionForNoteKey(key);
    if (!session) return Promise.resolve();
    const existing = this.activeDeliveries.get(session.id);
    if (existing) return existing;
    const active = this.drainOne(key);
    this.activeDeliveries.set(session.id, active);
    void active.then(
      () => {
        if (this.activeDeliveries.get(session.id) === active) {
          this.activeDeliveries.delete(session.id);
        }
      },
      () => {
        if (this.activeDeliveries.get(session.id) === active) {
          this.activeDeliveries.delete(session.id);
        }
      },
    );
    return active;
  }

  private async drainOne(key: string): Promise<void> {
    if (this.stopped || this.draining.has(key) || this.pickup.has(key)) return;
    const session = this.registry.sessionForNoteKey(key);
    if (!session || !this.readyToDrain(session)) return;
    this.draining.add(key);
    try {
      const turn = claimNextPendingTurn(key, this.deps.now());
      if (!turn) return;
      this.registry.refreshPendingTurns(key);
      if (session.runtime === "sdk") await this.deliverSdk(session, turn);
      else await this.deliverTerminal(session, turn);
    } finally {
      this.draining.delete(key);
    }
  }

  private async deliverSdk(session: Session, turn: PendingTurn): Promise<void> {
    let acceptanceBoundaryCrossed = false;
    try {
      const accepted = await this.sdk.sendWhenIdle(session.id, { text: turn.text }, () => {
        const blocker = this.acceptanceBlocker(session.id, turn.noteKey);
        if (!blocker) acceptanceBoundaryCrossed = true;
        return blocker;
      });
      if (accepted === null) {
        releasePendingTurn(
          turn.id,
          turn.revision,
          "The agent became busy before delivery.",
          this.deps.now(),
        );
      } else if (this.registry.sessionResetInProgress(session.id)) {
        this.markResetUncertain(
          session.id,
          turn,
          "Session reset began while the SDK was accepting this message.",
        );
      } else {
        deleteClaimedPendingTurn(turn.id, turn.revision);
      }
    } catch (err) {
      if (
        acceptanceBoundaryCrossed &&
        this.registry.sessionResetInProgress(session.id)
      ) {
        this.markResetUncertain(
          session.id,
          turn,
          `Session reset began after SDK delivery may have crossed its acceptance boundary: ${errorMessage(err)}`,
        );
      } else {
        releasePendingTurn(turn.id, turn.revision, errorMessage(err), this.deps.now());
      }
    }
    this.registry.refreshPendingTurns(turn.noteKey);
    const current = this.registry.getSession(session.id);
    if (current && noteKeyFor(current) !== turn.noteKey) {
      this.registry.refreshPendingTurns(noteKeyFor(current));
    }
  }

  private async deliverTerminal(session: Session, turn: PendingTurn): Promise<void> {
    let boundaryCrossed = false;
    const beforeWrite = (): string | null => {
      const current = this.registry.getSession(session.id);
      if (
        !current ||
        current.runtime !== "terminal" ||
        noteKeyFor(current) !== turn.noteKey ||
        !this.readyToDrain(current)
      ) {
        return "The agent became busy or opened a dialog before delivery.";
      }
      const resourceBlocker = this.registry.promptResourceBlockerForSession(session.id);
      if (resourceBlocker) return resourceBlocker;
      if (!boundaryCrossed) {
        boundaryCrossed = true;
        this.pickup.set(turn.noteKey, {
          turn,
          boundaryAt: this.deps.now(),
          injectionSucceeded: false,
          pickupObserved: false,
          timer: null,
        });
      }
      return null;
    };

    let result: InjectResult;
    try {
      result = await this.deps.inject(session, turn.text, undefined, beforeWrite);
    } catch (err) {
      result = {
        ok: false,
        error: errorMessage(err),
        pasted: true,
        submitVerified: false,
      };
    }

    const candidate = this.pickup.get(turn.noteKey);
    if (!candidate || candidate.turn.id !== turn.id) {
      if (boundaryCrossed) return;
      if (result.pasted || result.ok) {
        markPendingTurnUncertain(
          turn.id,
          turn.revision,
          result.error ?? "The terminal delivery outcome is unknown.",
          this.deps.now(),
        );
      } else {
        releasePendingTurn(
          turn.id,
          turn.revision,
          result.error ?? "The terminal refused the message.",
          this.deps.now(),
        );
      }
      this.registry.refreshPendingTurns(turn.noteKey);
      return;
    }
    if (result.ok) {
      if (this.registry.sessionResetInProgress(session.id)) {
        this.markResetUncertain(
          session.id,
          turn,
          "Session reset began after terminal delivery may have crossed its write boundary.",
        );
        return;
      }
      candidate.injectionSucceeded = true;
      // A collapsed-paste placeholder observed before Enter and gone afterwards is direct
      // prompt-pickup evidence. Do not wait for a second hook/passive state signal that may
      // never exist on an otherwise readable terminal session.
      if (result.submitVerified || candidate.pickupObserved) {
        this.completePickup(turn);
        return;
      }
      const latest = this.registry.getSession(session.id);
      if (latest) this.observeSession(latest);
      this.armPickupTimeout(turn);
      return;
    }

    if (candidate.timer) clearTimeout(candidate.timer);
    this.pickup.delete(turn.noteKey);
    if (result.pasted) {
      if (this.registry.sessionResetInProgress(session.id)) {
        this.markResetUncertain(
          session.id,
          turn,
          result.error ??
            "Session reset began after terminal delivery may have crossed its write boundary.",
        );
      } else {
        markPendingTurnUncertain(
          turn.id,
          turn.revision,
          result.error ?? "The terminal delivery outcome is unknown.",
          this.deps.now(),
        );
      }
    } else {
      releasePendingTurn(
        turn.id,
        turn.revision,
        result.error ?? "The terminal refused the message.",
        this.deps.now(),
      );
    }
    this.registry.refreshPendingTurns(turn.noteKey);
  }

  private acceptanceBlocker(sessionId: string, noteKey: string): string | null {
    const current = this.registry.getSession(sessionId);
    if (
      !current ||
      noteKeyFor(current) !== noteKey ||
      !this.readyToDrain(current)
    ) {
      return "The session reset, became busy, or opened a dialog before delivery.";
    }
    return null;
  }

  private markResetUncertain(sessionId: string, turn: PendingTurn, error: string): void {
    const candidate = this.pickup.get(turn.noteKey);
    if (candidate?.turn.id === turn.id) {
      if (candidate.timer) clearTimeout(candidate.timer);
      this.pickup.delete(turn.noteKey);
    }
    const uncertain = markPendingTurnUncertain(
      turn.id,
      turn.revision,
      error,
      this.deps.now(),
    );
    if (uncertain) this.resetPreserve.get(sessionId)?.add(turn.id);
    this.registry.refreshPendingTurns(turn.noteKey);
  }

  private completePickup(turn: PendingTurn): void {
    const candidate = this.pickup.get(turn.noteKey);
    if (!candidate || candidate.turn.id !== turn.id) return;
    if (candidate.timer) clearTimeout(candidate.timer);
    this.pickup.delete(turn.noteKey);
    deleteClaimedPendingTurn(turn.id, turn.revision);
    this.registry.refreshPendingTurns(turn.noteKey);
  }

  private armPickupTimeout(turn: PendingTurn): void {
    const candidate = this.pickup.get(turn.noteKey);
    if (!candidate || candidate.turn.id !== turn.id || candidate.timer) return;
    candidate.timer = unref(
      setTimeout(() => {
        const current = this.pickup.get(turn.noteKey);
        if (!current || current.turn.id !== turn.id) return;
        this.pickup.delete(turn.noteKey);
        markPendingTurnUncertain(
          turn.id,
          turn.revision,
          "Mission Control could not confirm that the terminal accepted this message.",
          this.deps.now(),
        );
        this.registry.refreshPendingTurns(turn.noteKey);
      }, this.deps.pickupTimeoutMs),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
