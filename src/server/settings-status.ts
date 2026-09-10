import type { SettingsStatus } from "@shared/types.ts";
import { countWritebacks } from "./db.ts";
import { getPipelinesConfig } from "./pipelines/config.ts";
import { getInspectorConfig } from "./inspector/config.ts";
import { getShippingConfig } from "./shipping/config.ts";
import { getTaskSourcesConfig } from "./task-sources/config.ts";
import { taskSourceStatuses } from "./task-sources/sweeper.ts";
import {
  pipelineObservedRepoKeys,
  pipelinesObserving,
  pipelinesPresent,
} from "./pipelines/index.ts";

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
 * exactly as the Task sources panel defines it - so the dot and the panel cannot disagree
 * about what a red source is. That is now TWO ways a source can be failing, and the count
 * is per SOURCE rather than per problem, because the dot's job is to get somebody to open
 * the panel and the panel is where a source's two lines say which of them it is:
 *
 *  - its last sweep recorded an error (`taskSourceStatuses(...).lastError`); or
 *  - its write-back queue is stuck - a delivery that exhausted its retries, or one whose
 *    outcome could not be read and which is therefore never retried automatically.
 *
 * The second is here because a stuck queue is exactly the failure this whole surface
 * exists to prevent: nothing else in the app would ever mention it, so an issue that never
 * got its comment would go unnoticed for as long as nobody happened to open the panel. It
 * is also the reason `startWritebackWorker` recomposes this after a tick that settled
 * anything - the recompute was already triggered, and this is what it now counts.
 */
export function settingsStatus(): SettingsStatus {
  const inspector = getInspectorConfig();
  const shipping = getShippingConfig();
  const sources = getTaskSourcesConfig().sources;
  const sweepFailed = new Set(
    taskSourceStatuses(sources)
      .filter((s) => s.lastError !== null)
      .map((s) => s.sourceId),
  );
  const failing = sources.filter((s) => {
    if (sweepFailed.has(s.id)) return true;
    const queue = countWritebacks(s.id);
    return queue.failed > 0 || queue.unknown > 0;
  }).length;
  const pipelines = getPipelinesConfig();
  return {
    inspector: { enabled: inspector.enabled, mode: inspector.mode },
    shipping: { autoMerge: shipping.autoMerge },
    taskSources: { failing },
    // Keep the append-only `present` compatibility fact for older dashboards. The current
    // dashboard always draws Conductor and uses `observing` alone for the Runs and Dispatch
    // gates. Both values are cheap reads and spawn nothing.
    pipelines: {
      present: pipelinesPresent(),
      observing: pipelinesObserving(),
      observedRepoKeys: pipelineObservedRepoKeys(),
      launchRuntime: pipelines.launchRuntime,
    },
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
