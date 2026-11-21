import { randomUUID } from "node:crypto";
import type { ServerEvent, SessionControlRequestView } from "@shared/types.ts";
import type { SessionControlRequestResult, SessionControlRequestStatus } from "@shared/protocol.ts";
import { featureEnabled, onFeatureFlagsChanged } from "./feature-flags/index.ts";
import type { Registry } from "./registry.ts";

// A session's own ask for Control other sessions.
//
// An ask is a request for the grant, never the grant. Nothing here can enable control: an ask
// is settled `granted` only by OBSERVING the grant the operator's trusted desktop click
// already applied through `PUT /api/sessions/:id/session-control`. So the ask deliberately
// is not a review: a review can be resolved over loopback HTTP with a body-asserted
// `by: "human"`, by Foreman, and by another session through `control_session`, and any of
// those approving an ask would let one agent grant itself or another agent authority.

export const SESSION_CONTROL_REQUESTS_FLAG = "session-control-requests" as const;
/** How long one long-poll round waits before answering "still pending". */
export const SESSION_CONTROL_REQUEST_WAIT_MS = 25_000;
/** Settled outcomes kept for a late poll. Bounded: the oldest answer is forgotten first. */
const SETTLED_MAX = 256;

export const SESSION_CONTROL_REQUEST_EXPIRED = {
  conversation: "this conversation was reset, replaced or reassigned before the operator answered",
  ended: "the session ended before the operator answered",
  disabled: "session control requests were turned off in Settings > Feature flags",
} as const;

type Settled = Exclude<SessionControlRequestStatus, "pending">;

interface PendingAsk {
  sessionId: string;
  view: SessionControlRequestView;
  /** `Registry.sessionControlIdentity` when asked: the same binding the grant itself keeps. */
  identity: string;
}

export class SessionControlRequests {
  /** At most one pending ask per session, keyed by session id. */
  private readonly pending = new Map<string, PendingAsk>();
  private readonly settled = new Map<string, { sessionId: string; status: Settled; detail?: string }>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly unsubscribe: Array<() => void>;

  constructor(
    private readonly registry: Registry,
    private readonly enabled: () => boolean = () => featureEnabled(SESSION_CONTROL_REQUESTS_FLAG),
  ) {
    this.unsubscribe = [
      // Every way a grant or an identity moves already emits the session, so observing that is
      // what settles an ask, whichever surface - card, menu or resident launch - granted it.
      registry.subscribe((event) => this.observe(event)),
      // Switching the preview off withdraws every card at once and tells each waiting agent so,
      // rather than leaving an ask to reappear if the flag comes back on.
      onFeatureFlagsChanged(() => {
        if (this.enabled()) return;
        for (const ask of this.pending.values()) this.settle(ask, "expired", SESSION_CONTROL_REQUEST_EXPIRED.disabled);
      }),
    ];
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  /**
   * Raise the verified caller's ask, or rejoin the one it already has. The caller must already
   * be verified by `sessionControlCaller`; this never reads a session id from a request body.
   * A repeated call keeps the first reason, so the words the operator is reading never change
   * underneath them.
   */
  request(sessionId: string, reason: string, now = Date.now()): SessionControlRequestResult {
    if (this.registry.sessionControlEnabled(sessionId)) return { id: randomUUID(), status: "granted" };
    const existing = this.current(sessionId);
    if (existing) return { id: existing.view.id, status: "pending" };
    const identity = this.registry.sessionControlIdentity(sessionId);
    const view: SessionControlRequestView = { id: randomUUID(), reason, requestedAt: now };
    if (!identity || !this.enabled()) {
      const detail = identity ? SESSION_CONTROL_REQUEST_EXPIRED.disabled : SESSION_CONTROL_REQUEST_EXPIRED.conversation;
      this.remember(view.id, sessionId, "expired", detail);
      return { id: view.id, status: "expired", detail };
    }
    const ask = { sessionId, view, identity };
    this.pending.set(sessionId, ask);
    if (!this.registry.setSessionControlRequest(sessionId, view)) {
      this.settle(ask, "expired", SESSION_CONTROL_REQUEST_EXPIRED.ended);
      return { id: view.id, status: "expired", detail: SESSION_CONTROL_REQUEST_EXPIRED.ended };
    }
    return { id: view.id, status: "pending" };
  }

  /** True only while `requestId` is the session's live ask for its current conversation. */
  isPending(sessionId: string, requestId: string): boolean {
    return this.current(sessionId)?.view.id === requestId;
  }

  /** Where one ask stands, answered only to the session that raised it. */
  status(sessionId: string, requestId: string): SessionControlRequestResult | null {
    if (this.isPending(sessionId, requestId)) return { id: requestId, status: "pending" };
    const outcome = this.settled.get(requestId);
    if (!outcome || outcome.sessionId !== sessionId) return null;
    return { id: requestId, status: outcome.status, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }

  /** Long-poll one ask: answers once it settles, or after `timeoutMs` while still pending. */
  async wait(
    sessionId: string,
    requestId: string,
    timeoutMs = SESSION_CONTROL_REQUEST_WAIT_MS,
    signal?: AbortSignal,
  ): Promise<SessionControlRequestResult | null> {
    const first = this.status(sessionId, requestId);
    if (first?.status !== "pending" || signal?.aborted) return first;
    await new Promise<void>((resolve) => {
      const wakers = this.waiters.get(requestId) ?? new Set<() => void>();
      this.waiters.set(requestId, wakers);
      const wake = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        wakers.delete(wake);
        if (wakers.size === 0) this.waiters.delete(requestId);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      wakers.add(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
    return this.status(sessionId, requestId);
  }

  /** The operator's Decline. Only removes an ask, so it needs no trusted click. */
  decline(sessionId: string, requestId: string): boolean {
    const ask = this.current(sessionId);
    if (!ask || ask.view.id !== requestId) return false;
    this.settle(ask, "declined");
    return true;
  }

  /**
   * The session's ask, re-validated the way `Registry.sessionControlEnabled` re-validates a
   * grant: a grant now held settles it `granted`; a changed conversation or a feature switched
   * off settles it `expired`, so a stale card can never grant a conversation that did not ask.
   */
  private current(sessionId: string): PendingAsk | null {
    const ask = this.pending.get(sessionId);
    if (!ask) return null;
    if (this.registry.sessionControlEnabled(sessionId)) {
      this.settle(ask, "granted");
      return null;
    }
    if (this.registry.sessionControlIdentity(sessionId) !== ask.identity) {
      const session = this.registry.getSession(sessionId);
      const ended = !session || session.state === "exited" || session.state === "stopping";
      this.settle(ask, "expired", ended ? SESSION_CONTROL_REQUEST_EXPIRED.ended : SESSION_CONTROL_REQUEST_EXPIRED.conversation);
      return null;
    }
    if (!this.enabled()) {
      this.settle(ask, "expired", SESSION_CONTROL_REQUEST_EXPIRED.disabled);
      return null;
    }
    return ask;
  }

  private observe(event: ServerEvent): void {
    if (event.type === "session_remove") {
      const ask = this.pending.get(event.id);
      if (ask) this.settle(ask, "expired", SESSION_CONTROL_REQUEST_EXPIRED.ended);
    } else if (event.type === "session_upsert" && this.pending.has(event.session.id)) {
      this.current(event.session.id);
    }
  }

  private settle(ask: PendingAsk, status: Settled, detail?: string): void {
    if (this.pending.get(ask.sessionId) !== ask) return;
    this.pending.delete(ask.sessionId);
    this.remember(ask.view.id, ask.sessionId, status, detail);
    this.registry.setSessionControlRequest(ask.sessionId, null);
    for (const wake of this.waiters.get(ask.view.id) ?? []) wake();
  }

  private remember(id: string, sessionId: string, status: Settled, detail?: string): void {
    this.settled.set(id, { sessionId, status, ...(detail ? { detail } : {}) });
    while (this.settled.size > SETTLED_MAX) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }
}
