import type { SettingsStatus } from "@shared/types.ts";
import { getInspectorConfig } from "./inspector/config.ts";
import { getShippingConfig } from "./shipping/config.ts";
import { getTaskSourcesConfig } from "./task-sources/config.ts";
import { taskSourceStatuses } from "./task-sources/sweeper.ts";
import { pipelinesPresent } from "./pipelines/index.ts";

// The one place the Settings status tuple is composed, and the one helper that emits it.
//
// Everything here is a daemon-side read of the daemon's OWN config stores - the Inspector's
// and YOLO mode's `app_config` blobs and the task-source sweeper's in-memory status map. It
// touches nothing the Foreman worker owns (the Foreman dot derives from `ForemanState`, which
// App already holds), and it opens no new poll: `publishSettingsStatus` is a side-effect of
// the config writes and sweep completions that can change the tuple, and `settingsStatus`
// is folded into `registry.snapshot()` so a freshly connected dashboard is right at once.

/**
 * Compose the current status tuple from the three stores.
 *
 * Pure-ish: it reads config but keeps no state and emits nothing. "Failing" is defined
 * exactly as the Task sources panel defines it - a source whose LAST sweep recorded an
 * error (`taskSourceStatuses(...).lastError`) - so the dot and the panel cannot disagree
 * about what a red source is.
 */
export function settingsStatus(): SettingsStatus {
  const inspector = getInspectorConfig();
  const shipping = getShippingConfig();
  const sources = getTaskSourcesConfig().sources;
  const failing = taskSourceStatuses(sources).filter((s) => s.lastError !== null).length;
  return {
    inspector: { enabled: inspector.enabled, mode: inspector.mode },
    shipping: { autoMerge: shipping.autoMerge },
    taskSources: { failing },
    // Whether the Conductor category is DRAWN at all, which is a different kind of fact from
    // its three neighbours: they tint a dot on a row that always exists. Cheap enough to
    // recompute here - see `pipelinesPresent`, which spawns nothing.
    pipelines: { present: pipelinesPresent() },
  };
}

/**
 * What `publishSettingsStatus` needs of a registry: a way to emit the tuple.
 *
 * A narrow structural interface rather than the concrete `Registry` so this module never
 * imports `registry.ts` - the dependency runs the other way (the registry imports
 * `settingsStatus` for its snapshot), and a cycle would put the sweeper's whole graph
 * behind the registry's module load for no reason.
 */
export interface SettingsStatusPublisher {
  emitSettingsStatus(status: SettingsStatus): void;
}

/**
 * Recompose the tuple and hand it to the registry to emit.
 *
 * Called on every config write and after every sweep that could have moved a fact.
 * Emitting on each call is acceptable per the phase plan; the registry drops no-change
 * frames (see `Registry.emitSettingsStatus`) so an unchanged recompute wakes no browser.
 */
export function publishSettingsStatus(registry: SettingsStatusPublisher): void {
  registry.emitSettingsStatus(settingsStatus());
}
