import { useSyncExternalStore } from "react";
import type { UiConfig, UiConfigPatch, UiConfigView } from "@shared/protocol.ts";
import type { VoiceConfirmationPlacement, VoiceIndicatorId, VoiceRevision } from "@shared/voice.ts";
import { api, fetchUiConfig } from "./api.ts";
import { isSkinId } from "@shared/skins.ts";
import { readCache, readLegacySettings, writeCache } from "./uiCache.ts";

/**
 * The dashboard's preferences, as one module-level store over `app_config.ui`.
 *
 * A MODULE store rather than a hook plus a provider, matching `keybindings.ts` (which now
 * reads from this one) and for its reason: the four consumers sit at different heights -
 * `App` renders the layout, `RichTextProvider` is mounted above `App` in `main.tsx`, the
 * keybinding store is not in the tree at all, and the transcript is many levels down. A
 * provider would have to wrap all of that, and any consumer holding its own `useState`
 * over the same key would let two surfaces disagree about one setting.
 *
 * `current` is seeded SYNCHRONOUSLY from the cache at module load, so the first paint has
 * the real layout and the real chords rather than a frame of defaults that then snap.
 * The fetch that follows is authoritative and replaces it.
 *
 * Deliberately not polled, unlike `useHarnesses` / `useForeman`: those hooks are alive
 * only while a rarely-opened modal is, whereas this one is alive for the life of the app,
 * and a request every 4s forever to notice an edit made in a second dashboard tab is a
 * bad trade. Voice indicator edits arrive through their own bounded event.
 */

/**
 * The skin the daemon served this document with (`src/server/dashboard-document.ts`), or null
 * where nothing served one - the Vite dev server, a test. It is the daemon's stored answer at
 * load time, so it beats a cache that a new profile does not have or another browser made stale:
 * without it `lib/skin.ts` would apply the cache's Default over the document's Daylight before
 * the fetch below put it back, which is a dark frame.
 */
function servedSkin(): UiConfig["skin"] | null {
  if (typeof document === "undefined") return null;
  const value = document.querySelector?.('meta[name="mission-skin"]')?.getAttribute("content");
  return isSkinId(value) ? value : null;
}

function firstPaintConfig(): UiConfig {
  const cached = readCache();
  const served = servedSkin();
  return served === null ? cached : { ...cached, skin: served };
}

let current: UiConfig = firstPaintConfig();
const listeners = new Set<() => void>();
let hydrated = false;
let hydrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
const writeGeneration = new Map<keyof UiConfig, number>();

export const UI_CONFIG_HYDRATE_RETRY_MS = 1_000;
export const UI_CONFIG_HYDRATE_MAX_RETRY_MS = 30_000;
let hydrationRetryDelay = UI_CONFIG_HYDRATE_RETRY_MS;

function emit(): void {
  for (const l of listeners) l();
}

/** Adopt a config as the truth: store it, mirror it to the cache, wake subscribers. */
function commit(next: UiConfig): void {
  current = next;
  writeCache(next);
  emit();
}

/**
 * The daemon's config as this window keeps it. `voice` is withheld while the `voice` flag is off
 * (`UiConfigViewSchema`); this window then keeps the value it already holds, cached or default,
 * so the record it draws from stays whole.
 */
function applyHydratedConfig({ config, voiceIndicatorVersion }: UiConfigView, indicatorsAtRead: string[]): void {
  const voice = config.voice ?? current.voice;
  const overlap = current.voice.indicators !== indicatorsAtRead;
  if (config.voice && (overlap || !acceptIndicatorVersion(voiceIndicatorVersion))) {
    // The snapshot may predate our save or include a peer's later edit.
    commit({ ...config, voice: current.voice });
    if (overlap) void reconcileVoiceIndicators();
    return;
  }
  commit({ ...config, voice });
}

/** The live config. Safe to read at module load and outside React. */
export function uiConfig(): UiConfig {
  return current;
}

/** Whether a daemon-backed config has arrived and automatic onboarding may evaluate it. */
export function uiConfigHydrated(): boolean {
  return hydrated;
}

function retryHydration(): void {
  if (hydrated || hydrationRetryTimer !== null) return;
  const delay = hydrationRetryDelay;
  hydrationRetryDelay = Math.min(delay * 2, UI_CONFIG_HYDRATE_MAX_RETRY_MS);
  hydrationRetryTimer = setTimeout(() => {
    hydrationRetryTimer = null;
    void hydrateUiConfig();
  }, delay);
}

/**
 * Fetch the daemon's copy and take it as the truth, adopting pre-rename `localStorage`
 * first if the daemon has never held one.
 *
 * On an unreachable daemon this keeps the current cache for rendering but leaves hydration
 * incomplete and retries. A default-on onboarding setting must never infer a fresh profile
 * merely because the daemon could not answer.
 */
export async function hydrateUiConfig(): Promise<void> {
  if (hydrated) return;
  const indicatorsAtRead = current.voice.indicators;
  const view = await fetchUiConfig();
  if (!view) {
    retryHydration();
    return;
  }
  hydrationRetryDelay = UI_CONFIG_HYDRATE_RETRY_MS;
  if (!view.configured) {
    // Nothing has ever been saved, so anything this origin still holds under an older
    // product name is worth rescuing. Only here: once the daemon has a config, it wins,
    // and a stray from a rename two generations back must never overwrite it.
    const legacy = readLegacySettings();
    if (legacy) {
      // Retain the old one-time flag's upgrade behavior for compatible clients.
      // The independent startup-picker preference keeps its default-on value, and an
      // adopted profile predates every announced tour, so it is owed each of them once.
      // Legacy storage never held `voice`: `coerce` filled its default, and a patch naming it is
      // refused while the voice flag is off, which would fail the whole adoption.
      const { voice: _filledDefault, ...adopted } = legacy;
      if (!await updateUiConfig({ ...adopted, guidedTour: false, announcedTours: [] })) {
        retryHydration();
        return;
      }
    } else {
      applyHydratedConfig(view, indicatorsAtRead);
    }
  } else {
    applyHydratedConfig(view, indicatorsAtRead);
  }
  hydrated = true;
  emit();
}

/**
 * Apply a patch optimistically and TAKE IT BACK if the daemon refuses, so no control ever
 * shows a setting that isn't in force. Same contract as `useHarnesses.update`.
 */
export async function updateUiConfig(patch: UiConfigPatch): Promise<boolean> {
  const before = current;
  const optimistic = { ...before, ...patch };
  const generations = new Map<keyof UiConfig, number>();
  for (const field of Object.keys(patch) as Array<keyof UiConfigPatch>) {
    const key = field as keyof UiConfig;
    const generation = (writeGeneration.get(key) ?? 0) + 1;
    writeGeneration.set(key, generation);
    generations.set(key, generation);
  }
  commit(optimistic);
  const res = await api.setUiConfig(patch);
  if (!res.ok) {
    // A later optimistic patch, including one setting this field to the same value, may have
    // already superseded this request. Roll back only fields this request still owns, never
    // its whole old snapshot.
    const rollback = { ...current };
    for (const field of Object.keys(patch) as Array<keyof UiConfigPatch>) {
      const key = field as keyof UiConfig;
      if (writeGeneration.get(key) === generations.get(key) && Object.is(current[key], optimistic[key])) {
        Object.assign(rollback, { [key]: before[key] });
      }
    }
    commit(rollback);
    return false;
  }
  return true;
}

/**
 * Re-read `announcedTours` from the daemon and adopt it, for the one automatic decision that
 * must not act on a stale copy: opening the startup picker on account of a new-tour
 * announcement. Preferences do not live-sync between windows, so a window that waited behind a
 * dialog can still hold a record another window has since announced the tour into.
 *
 * Only this field is adopted, and not when a write of it from this window began meanwhile -
 * that write is newer than the read. Resolves to whether the daemon answered.
 */
export async function refreshAnnouncedTours(): Promise<boolean> {
  const generation = writeGeneration.get("announcedTours") ?? 0;
  const view = await fetchUiConfig();
  if (!view) return false;
  if ((writeGeneration.get("announcedTours") ?? 0) !== generation) return true;
  if (!Object.is(current.announcedTours, view.config.announcedTours)) {
    commit({ ...current, announcedTours: view.config.announcedTours });
  }
  return true;
}

let indicatorReadGeneration = 0;
let indicatorRetryTimer: ReturnType<typeof setTimeout> | undefined;
let indicatorRetryDelay = UI_CONFIG_HYDRATE_RETRY_MS;
const INDICATOR_REQUEST_TIMEOUT_MS = 5000;
let latestIndicatorVersion: VoiceRevision | undefined;

/** The ordered stream can establish a new daemon, including when voice is enabled after reconnect. */
function acceptIndicatorVersion(next?: VoiceRevision, fromStream = false): boolean {
  if (latestIndicatorVersion) {
    if (next?.source === latestIndicatorVersion.source) {
      if (next.revision < latestIndicatorVersion.revision) return false;
    } else if (!fromStream) return false;
  }
  latestIndicatorVersion = next;
  return true;
}

/** A committed selection from the daemon's ordered stream, including its reconnect snapshot. */
export function applyVoiceIndicatorSelection(indicators: string[], version?: VoiceRevision, confirmation = current.voice.confirmation): void {
  if (acceptIndicatorVersion(version, true)) commitVoiceSelection(indicators, confirmation);
}

function commitVoiceSelection(indicators: string[], confirmation = current.voice.confirmation) {
  indicatorReadGeneration++;
  clearTimeout(indicatorRetryTimer);
  indicatorRetryDelay = UI_CONFIG_HYDRATE_RETRY_MS;
  commit({ ...current, voice: { ...current.voice, confirmation, indicators } });
}

/** Retry a failed or superseded read without keeping the settings controls disabled. */
async function reconcileVoiceIndicators(): Promise<void> {
  const generation = ++indicatorReadGeneration;
  clearTimeout(indicatorRetryTimer);
  const atRead = current.voice.indicators;
  const view = await fetchUiConfig(AbortSignal.timeout(INDICATOR_REQUEST_TIMEOUT_MS));
  if (generation !== indicatorReadGeneration) return;
  if (view && (!view.config.voice || current.voice.indicators === atRead)) {
    indicatorRetryDelay = UI_CONFIG_HYDRATE_RETRY_MS;
    if (view.config.voice && acceptIndicatorVersion(view.voiceIndicatorVersion)) {
      commit({ ...current, voice: { ...current.voice, indicators: view.config.voice.indicators, confirmation: view.config.voice.confirmation } });
    }
    return;
  }
  indicatorRetryTimer = setTimeout(() => void reconcileVoiceIndicators(), indicatorRetryDelay);
  indicatorRetryDelay = Math.min(indicatorRetryDelay * 2, UI_CONFIG_HYDRATE_MAX_RETRY_MS);
}

/** Apply the confirmed pair before the radio group releases its saving state. */
export async function updateVoicePlacement(placement: VoiceConfirmationPlacement): Promise<boolean> {
  const deadline = AbortSignal.timeout(INDICATOR_REQUEST_TIMEOUT_MS);
  const expected = latestIndicatorVersion ?? (await fetchUiConfig(deadline))?.voiceIndicatorVersion;
  if (!expected) return false;
  const result = await api.setVoicePlacement(placement, expected, deadline);
  if (!result.ok) {
    // The daemon may have committed a write whose response was lost.
    void reconcileVoiceIndicators();
    return false;
  }
  if (result.indicators && result.confirmation) {
    if (acceptIndicatorVersion(result.voiceIndicatorVersion)) commitVoiceSelection(result.indicators, result.confirmation);
  } else {
    // Older daemons acknowledged the write without returning the committed selection.
    await reconcileVoiceIndicators();
  }
  return true;
}

/** Persist one checkbox. Overlapping snapshots are reconciled against the daemon. */
export async function updateVoiceIndicator(id: VoiceIndicatorId, enabled: boolean): Promise<"saved" | "failed" | "unconfirmed"> {
  const atWrite = current.voice.indicators;
  const deadline = AbortSignal.timeout(INDICATOR_REQUEST_TIMEOUT_MS);
  const result = await api.setVoiceIndicator(id, enabled, deadline);
  if (deadline.aborted) {
    // The daemon may have persisted the edit before the response stalled.
    void reconcileVoiceIndicators();
    return "unconfirmed";
  }
  if (!result.ok || !result.indicators) return "failed";
  const overlap = current.voice.indicators !== atWrite;
  if ((!overlap || result.voiceIndicatorVersion) && acceptIndicatorVersion(result.voiceIndicatorVersion)) {
    commitVoiceSelection(result.indicators, result.confirmation);
  }
  if (overlap) {
    // The write is confirmed. Refresh the overlapping selection without holding the checkboxes.
    void reconcileVoiceIndicators();
  }
  return "saved";
}

// Stable references for useSyncExternalStore, so it doesn't drop and re-add the listener
// on every render (an inline arrow would).
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Subscribe outside React, or from a store built on top of this one. `keybindings.ts`
 * uses it to stay a store in its own right - with its own resolved-chord snapshot - while
 * holding no copy of the overrides it derives from.
 */
export const subscribeUiConfig = subscribe;
function getSnapshot(): UiConfig {
  return current;
}

function getHydrationSnapshot(): boolean {
  return uiConfigHydrated();
}

/** Live view of the whole config; re-renders on any change from any surface. */
export function useUiConfig(): UiConfig {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** True once a daemon-backed preference is available for automatic behavior to evaluate. */
export function useUiConfigHydrated(): boolean {
  return useSyncExternalStore(subscribe, getHydrationSnapshot, getHydrationSnapshot);
}
