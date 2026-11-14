// Pausing sessions: stopping agents from using the machine and the network without ending them,
// and giving one session the machine to itself. Browser-safe: no `node:` imports.
//
// A pause has exactly one owner, its REASON, and that is the rule every bulk control follows:
// a bulk lift resumes only what that bulk action paused. Ending priority does not resume a
// session you paused yourself, and the fleet's morning resume does not either.

import { capabilitiesFor } from "./harness-capabilities.ts";
import type { Session } from "./types.ts";

/**
 * Who paused a session. APPEND-ONLY: persisted in the `pause.state` app_config row.
 *
 *  - `operator`: a person paused this one session.
 *  - `priority`: another session became the priority session, and this one paused for it.
 *  - `fleet`: Pause all.
 */
export const SESSION_PAUSE_REASONS = ["operator", "priority", "fleet"] as const;
export type SessionPauseReason = (typeof SESSION_PAUSE_REASONS)[number];

/**
 * How a single pause is asked for. `now` freezes the agent where it stands; `after-turn` lets
 * the current turn finish and freezes it then. Both stop anything automated from starting a
 * new turn from the moment they are asked for.
 */
export const SESSION_PAUSE_MODES = ["now", "after-turn"] as const;
export type SessionPauseMode = (typeof SESSION_PAUSE_MODES)[number];

/**
 * A session's pause, as the daemon publishes it on `Session.pause`.
 *
 * `phase` is the honest half: `pending` while an after-turn pause waits for the turn to end
 * (nothing new may start, but the agent is still running), `frozen` once its process tree is
 * stopped and it sends and receives nothing.
 */
export interface SessionPause {
  reason: SessionPauseReason;
  phase: "pending" | "frozen";
  /** When the pause was asked for, epoch ms. */
  since: number;
  /** What the agent was doing when it froze, for the card's activity line. Null when idle. */
  interrupted: string | null;
  /**
   * Whether processes of this agent are stopped right now, which is what a write into it would
   * meet. Usually the same as `frozen`, and deliberately its own fact: a freeze the last daemon
   * did not live to finish leaves its processes stopped under a `pending` record until the next
   * one completes it, and every write gate refuses on this, never on the phase.
   */
  stopped: boolean;
  /**
   * When the pause settled frozen, as opposed to when it was asked for (`since`): an after-turn
   * pause asked for early freezes only when its turn ends. Null or absent until then; a reader
   * falls back to `since` when it is absent.
   */
  frozenAt?: number | null;
  /**
   * How it was asked for. A pending `now` pause is one whose freeze failed and is being retried -
   * the agent may still be running - which is not the same as an after-turn pause waiting for
   * its turn to end, and the label says which. Absent reads as after-turn.
   */
  mode?: SessionPauseMode;
}

/**
 * What a pending pause is doing, in the words every control uses: waiting for the turn to end,
 * or (a `now` pause whose freeze has not succeeded yet) held while the freeze is retried.
 */
export function pendingPauseLabel(pause: Pick<SessionPause, "mode">): string {
  return pause.mode === "now" ? "Held - not frozen yet" : "Pausing after this turn";
}

/** When the session actually stopped for its pause: the freeze time, else when it was asked for. */
export function pausedAt(pause: Pick<SessionPause, "since" | "frozenAt">): number {
  return pause.frozenAt ?? pause.since;
}

/** Pause all: every live session paused, optionally with automatic launches held too. */
export interface FleetPause {
  since: number;
  /** Epoch ms at which the daemon resumes what this pause paused, or null to wait for a person. */
  resumeAt: number | null;
  /** Whether automatic launches (backlog autopilot, recurring missions) are held meanwhile. */
  holdDispatch: boolean;
}

/** The priority session: the one left running while every other live session pauses for it. */
export interface PriorityFocus {
  sessionId: string;
  since: number;
}

/**
 * The fleet-wide half of pausing, published on its own event because it is not a property of
 * any one session. Bounded by construction: two nullable singletons.
 */
export interface PauseState {
  fleet: FleetPause | null;
  priority: PriorityFocus | null;
}

export const EMPTY_PAUSE_STATE: PauseState = { fleet: null, priority: null };

/** The one refusal every gate gives a write into a paused session. */
export const PAUSED_SESSION_REASON = "this session is paused - resume it before sending it anything";

/**
 * The pause controls a board card can draw. Ids persist in `UiConfig.pauseCardControls`, so
 * they are permanent: never rename one. Several may be on at once.
 *
 *  - `corner`: pause and priority buttons in the card's head, shown when you point at it.
 *  - `chip`: a Running / Paused / Priority chip leading the runtime row, with a menu.
 *  - `menu`: a ⋯ menu in the head, plus a Resume pill on a paused card.
 */
export const PAUSE_CARD_CONTROLS = ["corner", "chip", "menu"] as const;
export type PauseCardControl = (typeof PAUSE_CARD_CONTROLS)[number];

/**
 * The pause controls the console can draw, persisted in `UiConfig.pauseConsoleControls`.
 *
 *  - `toolbar`: a button in the tab row's toolbar, beside session control, with a menu.
 *  - `composer`: a button beside Send, and a paused band above the message box.
 *  - `badge`: a pause half on the header's state badge, and a paused band under the header.
 */
export const PAUSE_CONSOLE_CONTROLS = ["toolbar", "composer", "badge"] as const;
export type PauseConsoleControl = (typeof PAUSE_CONSOLE_CONTROLS)[number];

/** Whether nothing automated may start a turn in this session: any pause, pending or frozen. */
export function isPaused(session: Pick<Session, "pause">): boolean {
  return session.pause != null;
}

/** Whether the session's process tree is stopped right now. */
/**
 * Whether the session is frozen: its pause has settled AND processes of it are stopped. A pause
 * that settled with nothing stopped - an agent whose driver runs inside the daemon (Pi), or one
 * whose processes had already gone - is a hold, never called frozen on a card or in a count.
 */
export function isFrozen(session: Pick<Session, "pause">): boolean {
  return session.pause?.phase === "frozen" && session.pause.stopped;
}

/** Whether an operator may pause or resume this session: live, and not on its way out. */
export function canPause(session: Pick<Session, "state">): boolean {
  return session.state !== "exited" && session.state !== "stopping";
}

/**
 * The sessions a bulk pause takes: every live session not already paused, less the one
 * excepted (the priority session).
 */
export function bulkPauseTargets<S extends Pick<Session, "id" | "state" | "pause">>(
  sessions: Iterable<S>,
  except: string | null = null,
): S[] {
  const out: S[] = [];
  for (const session of sessions) {
    if (session.id === except || !canPause(session) || isPaused(session)) continue;
    out.push(session);
  }
  return out;
}

/** The short reason a paused card's flag prints. */
export function pauseFlagLabel(pause: SessionPause, now: number): string {
  if (pause.phase === "pending") return pendingPauseLabel(pause);
  switch (pause.reason) {
    case "priority":
      return "Paused for priority";
    case "fleet":
      return "Fleet paused";
    case "operator":
      // From when it actually froze: an after-turn pause asked for an hour ago is not an hour old.
      return `Paused · ${pauseAge(pausedAt(pause), now)}`;
  }
}

/** A pause's age, compact: `<1m`, `14m`, `2h`, `3d`. Seconds would only tick for nothing. */
export function pauseAge(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return "<1m";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** How many live sessions `reason` paused that are actually frozen, not only held. */
export function countFrozenFor(
  sessions: Iterable<Pick<Session, "pause">>,
  reason: SessionPauseReason,
): number {
  let n = 0;
  for (const session of sessions) if (session.pause?.reason === reason && isFrozen(session)) n += 1;
  return n;
}

/** How many live sessions are paused because of `reason`, frozen or only held. */
export function countPausedFor(
  sessions: Iterable<Pick<Session, "pause">>,
  reason: SessionPauseReason,
): number {
  let n = 0;
  for (const session of sessions) if (session.pause?.reason === reason) n += 1;
  return n;
}

/**
 * Whether pausing this session freezes a process, or only holds it. A terminal agent is always
 * its own process; an SDK session is when its harness's driver is (`sdkDriverStoppable`). Held
 * only, its current turn finishes and keeps using the network until it does, so every control
 * says "holds", never "freezes", for it.
 */
export function pauseFreezes(session: Pick<Session, "runtime" | "agent">): boolean {
  if (session.runtime !== "sdk") return true;
  // An agent outside the registry is assumed to be a process, which is the cautious answer:
  // it is held and retried rather than called frozen over nothing.
  const capabilities: { sdkDriverStoppable: boolean } | undefined = capabilitiesFor(session.agent);
  return capabilities?.sdkDriverStoppable !== false;
}
