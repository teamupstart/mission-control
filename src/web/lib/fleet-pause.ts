import { createContext, useContext } from "react";
import { canPause, countFrozenFor, countPausedFor, EMPTY_PAUSE_STATE, isPaused, pauseFreezes, type PauseState } from "@shared/pause.ts";
import type { Session } from "@shared/types.ts";

/**
 * The fleet-wide half of pausing, as every pause control reads it: the daemon's `PauseState`
 * plus the counts the controls print. Folded once in App from the SSE store and handed down
 * by context, so a card, the console and the title bar cannot count differently.
 */
export interface FleetPauseView {
  state: PauseState;
  /** Live sessions, paused or not. */
  live: number;
  /** Live sessions paused for any reason. */
  paused: number;
  pausedForFleet: number;
  pausedForPriority: number;
  /**
   * Of those, the ones actually frozen. The rest are held but still running - a process refused
   * to stop, or a turn has not ended - and a banner must never call them frozen: the person
   * pausing to free the network needs to know an agent is still using it.
   */
  frozenForFleet: number;
  frozenForPriority: number;
  /** Live sessions Pause all would take right now. */
  pausable: number;
  /** Of those, the ones a pause can only hold, not freeze (`pauseFreezes`). */
  holdOnly: number;
  /** The priority session's name, for the banner; null without one. */
  priorityName: string | null;
}

export const EMPTY_FLEET_PAUSE: FleetPauseView = {
  state: EMPTY_PAUSE_STATE,
  live: 0,
  paused: 0,
  pausedForFleet: 0,
  pausedForPriority: 0,
  frozenForFleet: 0,
  frozenForPriority: 0,
  pausable: 0,
  holdOnly: 0,
  priorityName: null,
};

export function fleetPauseView(sessions: readonly Session[], state: PauseState): FleetPauseView {
  const live = sessions.filter(canPause);
  return {
    state,
    live: live.length,
    paused: live.filter(isPaused).length,
    pausedForFleet: countPausedFor(live, "fleet"),
    pausedForPriority: countPausedFor(live, "priority"),
    frozenForFleet: countFrozenFor(live, "fleet"),
    frozenForPriority: countFrozenFor(live, "priority"),
    pausable: live.filter((s) => !isPaused(s)).length,
    holdOnly: live.filter((s) => !isPaused(s) && !pauseFreezes(s)).length,
    priorityName: state.priority ? (live.find((s) => s.id === state.priority!.sessionId)?.name ?? null) : null,
  };
}

export const FleetPauseContext = createContext<FleetPauseView>(EMPTY_FLEET_PAUSE);

export function useFleetPause(): FleetPauseView {
  return useContext(FleetPauseContext);
}

/** Whether this session is the priority session. */
export function isPrioritySession(view: FleetPauseView, sessionId: string): boolean {
  return view.state.priority?.sessionId === sessionId;
}

/** `1 session` / `9 sessions`. */
export function sessionCount(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}
