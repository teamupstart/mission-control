import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  MAX_INDEXED_DIRECTORIES,
  RepoIndexConfigSchema,
  type IndexedDirectory,
  type RepoIndexConfig,
} from "@shared/repo-index.ts";
import { getAppConfig } from "./db.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.repoIndex;

/** A semantic config refusal whose message is safe to show beside the Settings field. */
export class RepoIndexConfigError extends Error {}

/** The current saved list, with the four removable defaults applied only when absent. */
export function getRepoIndexConfig(): RepoIndexConfig {
  return RepoIndexConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/** Expand the two home-relative forms the setting accepts. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Return the first environment override in the existing prefix and singular-fallback order.
 * Keeping the variable name with the value lets Settings state which launch-time setting is
 * making the saved rows read-only, including an older supported prefix.
 */
export function repositoryIndexEnvironmentOverride(): { variable: string; value: string } | null {
  for (const suffix of ["WORKSPACE_DIRS", "WORKSPACE_DIR"] as const) {
    for (const prefix of ["MISSION", "FLEET", "HARNESS"] as const) {
      const variable = `${prefix}_${suffix}`;
      const value = process.env[variable];
      if (value !== undefined) return { variable, value };
    }
  }
  return null;
}

/** PATH-style entries named by the launch environment, with empty segments discarded. */
export function environmentDirectories(): string[] {
  const override = repositoryIndexEnvironmentOverride();
  if (!override) return [];
  return override.value.split(":").map((entry) => entry.trim()).filter(Boolean);
}

/** Expand, normalize, and resolve symlinks where the target already exists. */
export function canonicalize(path: string): string {
  const normalized = resolve(expandHome(path.trim()));
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

/** Whether a path currently resolves to the operator's home or one of its ancestors. */
export function resolvesAtOrAboveHome(path: string): boolean {
  const canonical = canonicalize(path);
  const home = canonicalize(homedir());
  const fromPathToHome = relative(canonical, home);
  return fromPathToHome === ""
    || (!isAbsolute(fromPathToHome)
      && fromPathToHome !== ".."
      && !fromPathToHome.startsWith(`..${sep}`));
}

/** Validate the whole list so duplicate and broad-root checks compare canonical paths. */
export function validateIndexedDirectories(rows: readonly IndexedDirectory[]): void {
  if (rows.length > MAX_INDEXED_DIRECTORIES) {
    throw new RepoIndexConfigError(
      `At most ${MAX_INDEXED_DIRECTORIES} directories can be indexed.`,
    );
  }

  const seen = new Map<string, string>();
  for (const row of rows) {
    const path = row.path.trim();
    if (!path) throw new RepoIndexConfigError("Directory paths cannot be empty.");
    const expanded = expandHome(path);
    if (!isAbsolute(expanded)) {
      throw new RepoIndexConfigError(
        `"${path}" is not an absolute path. Start it with / or ~/.`,
      );
    }
    const canonical = canonicalize(path);
    if (resolvesAtOrAboveHome(canonical)) {
      throw new RepoIndexConfigError(
        `"${path}" is at or above your home directory. Name the folder that holds your checkouts.`,
      );
    }
    const duplicate = seen.get(canonical);
    if (duplicate !== undefined) {
      throw new RepoIndexConfigError(
        `"${path}" is the same directory as "${duplicate}". Each directory can be indexed once.`,
      );
    }
    seen.set(canonical, path);
  }
}

/**
 * The one answer to which roots discovery walks. A set environment value, including an
 * intentionally empty one, wins. Saved roots are expanded, canonicalized, and deduplicated.
 */
export function indexedDirectories(): string[] {
  if (repositoryIndexEnvironmentOverride()) return environmentDirectories();
  const roots = new Set<string>();
  for (const row of getRepoIndexConfig().directories) {
    const canonical = canonicalize(row.path);
    // A missing path can become a symlink after it was saved. Reapply the broad-root guard
    // at read time so that filesystem change cannot turn a safe deferred row into a home scan.
    if (!resolvesAtOrAboveHome(canonical)) roots.add(canonical);
  }
  return [...roots];
}
