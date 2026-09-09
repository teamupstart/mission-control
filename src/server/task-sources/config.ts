import { TaskSourcesConfigSchema } from "@shared/task-source.ts";
import type { TaskSourcesConfigPatch } from "@shared/protocol.ts";
import type { TaskSourceInstance, TaskSourcesConfig } from "@shared/task-source.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { discardWritebacks, forgetTaskSourceSeen, getAppConfig, setAppConfig } from "../db.ts";

// Which task sources are configured, and how. A schema-validated blob over the
// `app_config` KV - the same pattern as `harnesses.ts` / `foreman/config.ts` /
// `inspector/config.ts` - so a new key needs no migration: zod's defaults are applied on
// every read, and a blob written by an older build gains new fields for free.

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.taskSources;

/** The configured sources, with schema defaults applied over whatever was stored. */
export function getTaskSourcesConfig(): TaskSourcesConfig {
  return TaskSourcesConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/** One configured source by id, or undefined. What the per-source routes resolve. */
export function taskSourceById(id: string): TaskSourceInstance | undefined {
  return getTaskSourcesConfig().sources.find((s) => s.id === id);
}

/**
 * Replace the configured set, persist, and return the result.
 *
 * A whole-list write rather than a merge (see `TaskSourcesConfigPatchSchema`), which
 * makes removal expressible at all - and removal is where the one non-obvious step is:
 * a removed source's SEEN ROWS are dropped with it, and so is its OWED WRITE-BACK QUEUE.
 *
 * That is the only reading that isn't a trap. Keeping the seen rows would mean re-adding a
 * source under the same id files nothing, ever, with no way to tell that from "there is no
 * new work" - and since the panel's own "Forget seen items" exists precisely to undo the
 * suppression, a delete that left it in force would be the one gesture with no undo.
 *
 * The write-back queue goes for both halves of that argument. Delivering against a
 * configuration nobody has any more is the obvious half; the second is that rows kept past
 * a removal are still there if the source comes back under the same id, and the ledger's
 * identity index would then swallow the new deliveries as duplicates of deliveries nobody
 * remembers owing.
 */
export function setTaskSourcesConfig(patch: TaskSourcesConfigPatch): TaskSourcesConfig {
  const before = new Set(getTaskSourcesConfig().sources.map((s) => s.id));
  const next = TaskSourcesConfigSchema.parse(patch);
  setAppConfig(CONFIG_ENTRY, next);
  const kept = new Set(next.sources.map((s) => s.id));
  for (const id of before) {
    if (kept.has(id)) continue;
    forgetTaskSourceSeen(id);
    discardWritebacks(id);
  }
  return next;
}
