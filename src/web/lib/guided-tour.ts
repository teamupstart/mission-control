import { useCallback, useEffect, useRef } from "react";
import type { UiConfigPatch } from "@shared/protocol.ts";
import { updateUiConfig, useUiConfig, useUiConfigHydrated } from "./uiConfig.ts";

export const GUIDED_TOUR_PERSIST_RETRY_MS = 1_000;
export const GUIDED_TOUR_PERSIST_MAX_RETRY_MS = 30_000;
export const GUIDED_TOUR_PERSIST_MAX_RETRIES = 5;
const PENDING_GUIDED_TOUR_CONSUMPTION = "ai-harness.guided-tour-consumption-pending";

type Persist = (patch: UiConfigPatch) => Promise<boolean>;
type Schedule = (callback: () => void, delay: number) => unknown;

function pendingGuidedTourConsumption(): boolean {
  return localStorage.getItem(PENDING_GUIDED_TOUR_CONSUMPTION) === "true";
}

function markGuidedTourConsumptionPending(): void {
  localStorage.setItem(PENDING_GUIDED_TOUR_CONSUMPTION, "true");
}

function clearGuidedTourConsumptionPending(): void {
  localStorage.removeItem(PENDING_GUIDED_TOUR_CONSUMPTION);
}

/** A tour that opened in this dashboard session stays consumed even while its PUT retries. */
export function canStartGuidedTour(persisted: boolean, consumedThisSession: boolean): boolean {
  return persisted && !consumedThisSession;
}

/**
 * Record the consumed onboarding state, retrying if the daemon was temporarily unavailable.
 * A new profile must not receive a second blocking tour merely because its first PUT raced a
 * short outage after the tour had already opened. The local pending marker survives a reload;
 * each new dashboard load gets a bounded, capped-backoff attempt to make that marker durable.
 */
export function consumeGuidedTour(
  persist: Persist = updateUiConfig,
  scheduleRetry: Schedule = setTimeout,
  retry = 0,
): void {
  if (retry === 0) markGuidedTourConsumptionPending();
  void persist({ guidedTour: false }).then(
    (saved) => {
      if (saved) {
        clearGuidedTourConsumptionPending();
      } else {
        retryGuidedTourConsumption(persist, scheduleRetry, retry);
      }
    },
    () => retryGuidedTourConsumption(persist, scheduleRetry, retry),
  );
}

function retryGuidedTourConsumption(persist: Persist, scheduleRetry: Schedule, retry: number): void {
  if (retry >= GUIDED_TOUR_PERSIST_MAX_RETRIES) return;
  const delay = Math.min(
    GUIDED_TOUR_PERSIST_RETRY_MS * (2 ** retry),
    GUIDED_TOUR_PERSIST_MAX_RETRY_MS,
  );
  scheduleRetry(() => consumeGuidedTour(persist, scheduleRetry, retry + 1), delay);
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
  const pendingConsumption = pendingGuidedTourConsumption();
  const enabled = canStartGuidedTour(persisted, consumedThisSession.current || pendingConsumption);
  useEffect(() => {
    if (hydrated && pendingConsumption) consumeGuidedTour();
  }, [hydrated, pendingConsumption]);
  const consume = useCallback(() => {
    consumedThisSession.current = true;
    consumeGuidedTour();
  }, []);
  return [enabled, hydrated, consume];
}
