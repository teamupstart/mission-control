import { useCallback, useRef } from "react";
import type { UiConfigPatch } from "@shared/protocol.ts";
import { updateUiConfig, useUiConfig, useUiConfigHydrated } from "./uiConfig.ts";

export const GUIDED_TOUR_PERSIST_RETRY_MS = 1_000;

type Persist = (patch: UiConfigPatch) => Promise<boolean>;
type Schedule = (callback: () => void, delay: number) => unknown;

/** A tour that opened in this dashboard session stays consumed even while its PUT retries. */
export function canStartGuidedTour(persisted: boolean, consumedThisSession: boolean): boolean {
  return persisted && !consumedThisSession;
}

/**
 * Record the consumed onboarding state, retrying if the daemon was temporarily unavailable.
 * A new profile must not receive a second blocking tour merely because its first PUT raced a
 * short outage after the tour had already opened.
 */
export function consumeGuidedTour(
  persist: Persist = updateUiConfig,
  scheduleRetry: Schedule = setTimeout,
): void {
  void persist({ guidedTour: false }).then(
    (saved) => {
      if (!saved) scheduleRetry(() => consumeGuidedTour(persist, scheduleRetry), GUIDED_TOUR_PERSIST_RETRY_MS);
    },
    () => scheduleRetry(() => consumeGuidedTour(persist, scheduleRetry), GUIDED_TOUR_PERSIST_RETRY_MS),
  );
}

/**
 * The one-time automatic product orientation.
 *
 * The setting starts on for a new profile, and is consumed as soon as the tour opens. Waiting
 * for the daemon-backed config to hydrate keeps a known false preference from flashing a tour
 * while a cold browser cache still contains only the shipped defaults.
 */
export function useGuidedTour(): [enabled: boolean, hydrated: boolean, consume: () => void] {
  const persisted = useUiConfig().guidedTour;
  const hydrated = useUiConfigHydrated();
  const consumedThisSession = useRef(false);
  const enabled = canStartGuidedTour(persisted, consumedThisSession.current);
  const consume = useCallback(() => {
    consumedThisSession.current = true;
    consumeGuidedTour();
  }, []);
  return [enabled, hydrated, consume];
}
