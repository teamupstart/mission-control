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
  sessionId: string;
  turn: PendingTurn;
  boundaryAt: number;
  injectionSucceeded: boolean;
  pickupObserved: boolean;
  pickupObservedAt: number | null;
  ownershipUncertain: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface TerminalDrainBoundary {
  sessionId: string;
  writeBoundaryAt: number;
  activityObservedAt: number | null;
}

interface SdkHandoff {
  sessionId: string;
  turn: PendingTurn;
  acceptanceBoundaryCrossed: boolean;
  ownershipUncertain: boolean;
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
  private readonly terminalDrainBoundaries = new Map<string, TerminalDrainBoundary>();
  private readonly sdkHandoffs = new Map<string, SdkHandoff>();
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
    this.terminalDrainBoundaries.clear();
    this.sdkHandoffs.clear();
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
    const preserve = this.resetPreserve.get(sessionId) ?? new Set<string>();
    for (const turn of session.pendingTurns) {
      if (turn.state === "uncertain") preserve.add(turn.id);
    }
    this.resetPreserve.set(sessionId, preserve);
    this.cancelIdleTimer(key);
    this.terminalDrainBoundaries.delete(key);

    const active = this.activeDeliveries.get(sessionId);
    if (active) {
      try {
        await active;
      } catch {
        // Delivery owns its durable transition. Reset still performs the defensive pickup
        // check below in case an unexpected failure left a terminal candidate behind.
      }
    }

    const current = this.registry.getSession(sessionId);
    // An accepted turn may have installed this boundary just before the reset marker became
    // visible. Reset owns all later work, so an old turn must not hold its new outbox closed.
    this.terminalDrainBoundaries.delete(key);
    for (const turn of current?.pendingTurns ?? []) {
      if (turn.state === "uncertain") preserve.add(turn.id);
    }

    const candidate = this.pickup.get(key);
    if (candidate) {
      if (candidate.sessionId === sessionId) {
        this.markResetUncertain(
          sessionId,
          candidate.turn,
          "Session reset began after terminal delivery may have crossed its write boundary.",
        );
      } else {
        candidate.ownershipUncertain = true;
        preserve.add(candidate.turn.id);
      }
    }
    const sdkHandoff = this.sdkHandoffs.get(key);
    if (sdkHandoff) {
      if (sdkHandoff.sessionId === sessionId) {
        this.markResetUncertain(
          sessionId,
          sdkHandoff.turn,
          "Session reset began while the SDK was accepting this message.",
        );
      } else {
        sdkHandoff.ownershipUncertain = true;
        preserve.add(sdkHandoff.turn.id);
      }
    }
    return [...preserve];
  }

  /** Resume a safely refused queued row only after reset's registry marker is gone. */
  finishReset(sessionId: string): void {
    if (this.registry.sessionResetInProgress(sessionId)) return;
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
        if (this.terminalDrainBoundaries.get(key)?.sessionId === event.id) {
          this.terminalDrainBoundaries.delete(key);
        }
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
    if (previousKey && previousKey !== key) {
      this.moveConversationKey(session.id, previousKey, key);
    }
    const sdkHandoff = this.sdkHandoffs.get(key);
    if (sdkHandoff && sdkHandoff.sessionId !== session.id && session.state !== "exited") {
      sdkHandoff.ownershipUncertain = true;
    }
    const drainBoundary = this.terminalDrainBoundaries.get(key);
    if (drainBoundary) {
      if (drainBoundary.sessionId !== session.id || session.state === "exited") {
        this.terminalDrainBoundaries.delete(key);
      } else if (
        session.stateConfirmed &&
        session.state === "working" &&
        (session.lastActivity ?? 0) >= drainBoundary.writeBoundaryAt
      ) {
        const observedAt = session.lastActivity ?? this.deps.now();
        drainBoundary.activityObservedAt = Math.max(
          drainBoundary.activityObservedAt ?? drainBoundary.writeBoundaryAt,
          observedAt,
        );
        this.cancelIdleTimer(key);
        return;
      } else if (
        drainBoundary.activityObservedAt !== null &&
        session.stateConfirmed &&
        session.state === "idle" &&
        (session.lastActivity ?? 0) >= drainBoundary.activityObservedAt
      ) {
        this.terminalDrainBoundaries.delete(key);
      } else {
        this.cancelIdleTimer(key);
        return;
      }
    }
    const candidate = this.pickup.get(key);
    if (candidate && candidate.sessionId !== session.id && session.state !== "exited") {
      candidate.ownershipUncertain = true;
      return;
    }
    if (
      candidate &&
      candidate.sessionId === session.id &&
      session.state === "working" &&
      session.stateConfirmed &&
      (session.lastActivity ?? 0) >= candidate.boundaryAt
    ) {
      candidate.pickupObserved = true;
      const observedAt = session.lastActivity ?? this.deps.now();
      candidate.pickupObservedAt = Math.max(
        candidate.pickupObservedAt ?? candidate.boundaryAt,
        observedAt,
      );
      // A reset owns the session now. Evidence that arrives while injection is settling is
      // provisional until deliverTerminal records the reset-safe uncertain transition.
      if (
        candidate.injectionSucceeded &&
        !this.registry.sessionResetInProgress(session.id)
      ) {
        this.completePickup(session.id, candidate.turn);
      }
      return;
    }
    if (this.readyToDrain(session)) this.scheduleDrain(key);
    else this.cancelIdleTimer(key);
  }

  private moveConversationKey(sessionId: string, fromKey: string, toKey: string): void {
    this.cancelIdleTimer(fromKey);
    const candidate = this.pickup.get(fromKey);
    const sdkHandoff = this.sdkHandoffs.get(fromKey);
    const drainBoundary = this.terminalDrainBoundaries.get(fromKey);
    if (
      (candidate && candidate.sessionId !== sessionId) ||
      (sdkHandoff && sdkHandoff.sessionId !== sessionId)
    ) {
      if (candidate) candidate.ownershipUncertain = true;
      if (sdkHandoff) sdkHandoff.ownershipUncertain = true;
      return;
    }
    if (!rekeyPendingTurns(fromKey, toKey, this.deps.now())) {
      if (drainBoundary?.sessionId === sessionId) {
        this.terminalDrainBoundaries.delete(fromKey);
      }
      return;
    }
    if (candidate) {
      this.pickup.delete(fromKey);
      candidate.turn.noteKey = toKey;
      this.pickup.set(toKey, candidate);
    }
    if (sdkHandoff) {
      this.sdkHandoffs.delete(fromKey);
      sdkHandoff.turn.noteKey = toKey;
      this.sdkHandoffs.set(toKey, sdkHandoff);
    }
    if (drainBoundary?.sessionId === sessionId) {
      this.terminalDrainBoundaries.delete(fromKey);
      this.terminalDrainBoundaries.set(toKey, drainBoundary);
    }
    this.registry.refreshPendingTurns(fromKey);
    this.registry.refreshPendingTurns(toKey);
  }

  private readyToDrain(session: Session): boolean {
    const drainBoundary = this.terminalDrainBoundaries.get(noteKeyFor(session));
    return (
      drainBoundary?.sessionId !== session.id &&
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
    if (this.terminalDrainBoundaries.get(key)?.sessionId === session.id) return;
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
    const handoff: SdkHandoff = {
      sessionId: session.id,
      turn,
      acceptanceBoundaryCrossed: false,
      ownershipUncertain: false,
    };
    this.sdkHandoffs.set(turn.noteKey, handoff);
    try {
      const accepted = await this.sdk.sendWhenIdle(session.id, { text: turn.text }, () => {
        const blocker = this.acceptanceBlocker(handoff);
        if (!blocker) handoff.acceptanceBoundaryCrossed = true;
        return blocker;
      });
      if (
        handoff.ownershipUncertain ||
        this.registry.sessionForNoteKey(turn.noteKey)?.id !== session.id
      ) {
        this.markBoundaryUncertain(
          session.id,
          turn,
          "SDK conversation ownership changed during delivery.",
          handoff.acceptanceBoundaryCrossed,
        );
      } else if (accepted === null) {
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
        handoff.ownershipUncertain ||
        this.registry.sessionForNoteKey(turn.noteKey)?.id !== session.id
      ) {
        this.markBoundaryUncertain(
          session.id,
          turn,
          `SDK conversation ownership changed during delivery: ${errorMessage(err)}`,
          handoff.acceptanceBoundaryCrossed,
        );
      } else if (handoff.acceptanceBoundaryCrossed) {
        // Once the supervisor crossed its serialized acceptance guard, a thrown
        // transport response is not proof of refusal: Codex may already have written
        // `turn/start`. Keep fail-closed uncertainty instead of automatically replaying
        // the same text on the next idle transition. markBoundaryUncertain also carries
        // the row through a concurrent reset.
        this.markBoundaryUncertain(
          session.id,
          turn,
          `SDK delivery may have crossed its acceptance boundary before failing: ${errorMessage(err)}`,
          true,
        );
      } else {
        releasePendingTurn(turn.id, turn.revision, errorMessage(err), this.deps.now());
      }
    } finally {
      if (this.sdkHandoffs.get(turn.noteKey) === handoff) {
        this.sdkHandoffs.delete(turn.noteKey);
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
        this.registry.sessionForNoteKey(turn.noteKey)?.id !== session.id ||
        !this.readyToDrain(current)
      ) {
        return "The agent became busy or opened a dialog before delivery.";
      }
      const resourceBlocker = this.registry.promptResourceBlockerForSession(session.id);
      if (resourceBlocker) return resourceBlocker;
      if (!boundaryCrossed) {
        boundaryCrossed = true;
        this.pickup.set(turn.noteKey, {
          sessionId: session.id,
          turn,
          boundaryAt: this.deps.now(),
          injectionSucceeded: false,
          pickupObserved: false,
          pickupObservedAt: null,
          ownershipUncertain: false,
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
    if (
      !candidate ||
      candidate.turn.id !== turn.id ||
      candidate.sessionId !== session.id
    ) {
      if (boundaryCrossed || result.pasted || result.ok) {
        this.markBoundaryUncertain(
          session.id,
          turn,
          result.error ?? "The terminal delivery owner or outcome is unknown.",
          boundaryCrossed || result.pasted || result.ok,
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
    if (
      candidate.ownershipUncertain ||
      this.registry.sessionForNoteKey(turn.noteKey)?.id !== session.id
    ) {
      this.markBoundaryUncertain(
        session.id,
        turn,
        "Terminal conversation ownership changed during delivery.",
        true,
      );
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
        this.completePickup(session.id, turn);
        return;
      }
      const latest = this.registry.getSession(session.id);
      if (latest) this.observeSession(latest);
      this.armPickupTimeout(session.id, turn);
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

  private acceptanceBlocker(handoff: SdkHandoff): string | null {
    const current = this.registry.getSession(handoff.sessionId);
    if (
      handoff.ownershipUncertain ||
      !current ||
      noteKeyFor(current) !== handoff.turn.noteKey ||
      this.registry.sessionForNoteKey(handoff.turn.noteKey)?.id !== handoff.sessionId
    ) {
      handoff.ownershipUncertain = true;
      return "The SDK conversation owner changed before delivery.";
    }
    if (!this.readyToDrain(current)) {
      return "The session reset, became busy, or opened a dialog before delivery.";
    }
    return null;
  }

  private markResetUncertain(sessionId: string, turn: PendingTurn, error: string): void {
    const uncertain = this.markDeliveryUncertain(sessionId, turn, error);
    if (uncertain) this.resetPreserve.get(sessionId)?.add(turn.id);
  }

  private markBoundaryUncertain(
    sessionId: string,
    turn: PendingTurn,
    error: string,
    boundaryCrossed: boolean,
  ): void {
    if (boundaryCrossed && this.registry.sessionResetInProgress(sessionId)) {
      this.markResetUncertain(sessionId, turn, error);
    } else {
      this.markDeliveryUncertain(sessionId, turn, error);
    }
  }

  private markDeliveryUncertain(sessionId: string, turn: PendingTurn, error: string): PendingTurn | null {
    const candidate = this.pickup.get(turn.noteKey);
    if (candidate?.turn.id === turn.id && candidate.sessionId === sessionId) {
      if (candidate.timer) clearTimeout(candidate.timer);
      this.pickup.delete(turn.noteKey);
    }
    const uncertain = markPendingTurnUncertain(
      turn.id,
      turn.revision,
      error,
      this.deps.now(),
    );
    this.registry.refreshPendingTurns(turn.noteKey);
    return uncertain;
  }

  private completePickup(sessionId: string, turn: PendingTurn): void {
    const candidate = this.pickup.get(turn.noteKey);
    if (
      !candidate ||
      candidate.turn.id !== turn.id ||
      candidate.sessionId !== sessionId ||
      candidate.ownershipUncertain
    ) return;
    if (candidate.timer) clearTimeout(candidate.timer);
    // A verified paste proves this row crossed the terminal boundary, but the registry may
    // still contain the idle observation from BEFORE Enter. Keep the FIFO closed until work
    // is observed and a later idle transition proves that work finished. When a hook or
    // passive read already supplied pickup evidence, carry that evidence into the boundary
    // so only the corresponding idle transition remains.
    this.terminalDrainBoundaries.set(turn.noteKey, {
      sessionId,
      writeBoundaryAt: candidate.boundaryAt,
      activityObservedAt: candidate.pickupObservedAt,
    });
    this.pickup.delete(turn.noteKey);
    deleteClaimedPendingTurn(turn.id, turn.revision);
    this.registry.refreshPendingTurns(turn.noteKey);
  }

  private armPickupTimeout(sessionId: string, turn: PendingTurn): void {
    const candidate = this.pickup.get(turn.noteKey);
    if (
      !candidate ||
      candidate.turn.id !== turn.id ||
      candidate.sessionId !== sessionId ||
      candidate.timer
    ) return;
    candidate.timer = unref(
      setTimeout(() => {
        const current = this.pickup.get(turn.noteKey);
        if (
          !current ||
          current.turn.id !== turn.id ||
          current.sessionId !== sessionId
        ) return;
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
