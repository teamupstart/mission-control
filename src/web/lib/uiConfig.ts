import { useSyncExternalStore } from "react";
import type { UiConfig, UiConfigPatch } from "@shared/protocol.ts";
import { api, fetchUiConfig } from "./api.ts";
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
 * bad trade. Reconciling tabs live is a `ui_config` ServerEvent, noted as follow-up.
 */

let current: UiConfig = readCache();
const listeners = new Set<() => void>();
let hydrated = false;

function emit(): void {
  for (const l of listeners) l();
}

/** Adopt a config as the truth: store it, mirror it to the cache, wake subscribers. */
function commit(next: UiConfig): void {
  current = next;
  writeCache(next);
  emit();
}

/** The live config. Safe to read at module load and outside React. */
export function uiConfig(): UiConfig {
  return current;
}

/**
 * Fetch the daemon's copy and take it as the truth, adopting pre-rename `localStorage`
 * first if the daemon has never held one.
 *
 * On an unreachable daemon this returns having changed nothing, which is the point of
 * keeping a cache at all: under `vite` the dashboard is served by something other than
 * the daemon, so it can render before (or without) one, and it should render with the
 * operator's settings rather than the shipped defaults.
 */
export async function hydrateUiConfig(): Promise<void> {
  try {
    const view = await fetchUiConfig();
    if (!view) return; // daemon unreachable - the cache stands
    if (!view.configured) {
      // Nothing has ever been saved, so anything this origin still holds under an older
      // product name is worth rescuing. Only here: once the daemon has a config, it wins,
      // and a stray from a rename two generations back must never overwrite it.
      const legacy = readLegacySettings();
      if (legacy) {
        await updateUiConfig(legacy);
        return;
      }
    }
    commit(view.config);
  } finally {
    hydrated = true;
    emit();
  }
}

/**
 * Apply a patch optimistically and TAKE IT BACK if the daemon refuses, so no control ever
 * shows a setting that isn't in force. Same contract as `useHarnesses.update`.
 */
export async function updateUiConfig(patch: UiConfigPatch): Promise<void> {
  const before = current;
  commit({ ...before, ...patch });
  const res = await api.setUiConfig(patch);
  if (!res.ok) commit(before);
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
  return hydrated;
}

/** Live view of the whole config; re-renders on any change from any surface. */
export function useUiConfig(): UiConfig {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** True once the daemon-backed preferences have settled, even when the daemon is unavailable. */
export function useUiConfigHydrated(): boolean {
  return useSyncExternalStore(subscribe, getHydrationSnapshot, getHydrationSnapshot);
}
