import {
  WorktreesConfigSchema,
  type WorktreesConfig,
  type WorktreesConfigPatch,
} from "@shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.worktrees;

/** Resolved policy for one physical Git common directory. */
export interface WorktreePolicy {
  enabled: boolean;
  maxSlots: number;
  setupArgv: readonly string[] | null;
}

/** The current policy, with default-on and max-16 defaults applied on every read. */
export function getWorktreesConfig(): WorktreesConfig {
  return WorktreesConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/**
 * Merge a bounded patch without replacing repository overrides the caller did not name.
 * Null removes one override; null setup argv removes only that command.
 */
export function setWorktreesConfig(patch: WorktreesConfigPatch): WorktreesConfig {
  const current = getWorktreesConfig();
  const repositories: WorktreesConfig["repositories"] = { ...current.repositories };
  for (const [commonDirectory, repositoryPatch] of Object.entries(patch.repositories ?? {})) {
    if (repositoryPatch === null) {
      delete repositories[commonDirectory];
      continue;
    }
    const prior = repositories[commonDirectory] ?? {};
    const { setupArgv, ...scalarPatch } = repositoryPatch;
    const next = { ...prior, ...scalarPatch };
    if (setupArgv === null) delete next.setupArgv;
    else if (setupArgv !== undefined) next.setupArgv = setupArgv;
    repositories[commonDirectory] = next;
  }
  const resolved = WorktreesConfigSchema.parse({
    ...current,
    ...patch,
    repositories,
  });
  setAppConfig(CONFIG_ENTRY, resolved);
  return resolved;
}

/** Resolve a repository override over the global defaults, keyed only by physical common dir. */
export function resolveWorktreePolicy(
  commonDirectory: string,
  config = getWorktreesConfig(),
): WorktreePolicy {
  const override = config.repositories[commonDirectory];
  return {
    enabled: override?.enabled ?? config.enabled,
    maxSlots: override?.maxSlots ?? config.maxSlots,
    setupArgv: override?.setupArgv ?? null,
  };
}
