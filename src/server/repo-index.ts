import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  DEFAULT_INDEXED_DIRECTORIES,
  RepoIndexConfigSchema,
  type IndexedDirectoryView,
  type RepoIndexConfig,
  type RepoIndexConfigPatch,
  type RepoIndexView,
} from "@shared/repo-index.ts";
import { setAppConfig } from "./db.ts";
import {
  RepoIndexConfigError,
  canonicalize,
  environmentDirectories,
  expandHome,
  getRepoIndexConfig,
  indexedDirectories,
  repositoryIndexEnvironmentOverride,
  validateIndexedDirectories,
} from "./repo-index-config.ts";
import {
  invalidateReposCache,
  listRepos,
  reposCacheScannedAt,
} from "./repos.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.repoIndex;

/** Merge, validate, persist, and make the next repository read scan the new roots. */
export function setRepoIndexConfig(patch: RepoIndexConfigPatch): RepoIndexConfig {
  const next = RepoIndexConfigSchema.parse({ ...getRepoIndexConfig(), ...patch });
  validateIndexedDirectories(next.directories);
  setAppConfig(CONFIG_ENTRY, next);
  invalidateReposCache();
  return next;
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === ""
    || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function statusForError(error: unknown): "missing" | "unreadable" {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
}

async function directoryView(
  path: string,
  repos: readonly string[] | null,
): Promise<IndexedDirectoryView> {
  const expanded = expandHome(path);
  let info;
  try {
    info = await stat(expanded);
  } catch (error) {
    return {
      path,
      resolved: null,
      status: statusForError(error),
      repoCount: null,
      isDefault: DEFAULT_INDEXED_DIRECTORIES.includes(
        path as (typeof DEFAULT_INDEXED_DIRECTORIES)[number],
      ),
    };
  }

  let resolved: string | null;
  try {
    resolved = await realpath(expanded);
  } catch {
    resolved = null;
  }

  if (!info.isDirectory()) {
    return {
      path,
      resolved,
      status: "not-a-directory",
      repoCount: null,
      isDefault: DEFAULT_INDEXED_DIRECTORIES.includes(
        path as (typeof DEFAULT_INDEXED_DIRECTORIES)[number],
      ),
    };
  }

  try {
    await access(expanded, constants.R_OK | constants.X_OK);
  } catch {
    return {
      path,
      resolved,
      status: "unreadable",
      repoCount: null,
      isDefault: DEFAULT_INDEXED_DIRECTORIES.includes(
        path as (typeof DEFAULT_INDEXED_DIRECTORIES)[number],
      ),
    };
  }

  if (resolved === null) {
    return {
      path,
      resolved,
      status: "unreadable",
      repoCount: null,
      isDefault: DEFAULT_INDEXED_DIRECTORIES.includes(
        path as (typeof DEFAULT_INDEXED_DIRECTORIES)[number],
      ),
    };
  }

  return {
    path,
    resolved,
    status: "ok",
    repoCount: repos === null ? null : repos.filter((repo) => isWithin(resolved, repo)).length,
    isDefault: DEFAULT_INDEXED_DIRECTORIES.includes(
      path as (typeof DEFAULT_INDEXED_DIRECTORIES)[number],
    ),
  };
}

/** Effective roots and their filesystem readings for the Settings panel. */
export async function repoIndexView(): Promise<RepoIndexView> {
  const config = getRepoIndexConfig();
  const override = repositoryIndexEnvironmentOverride();
  const effectivePaths = override ? environmentDirectories() : config.directories.map((row) => row.path);
  const repos = await listRepos();
  const directories = await Promise.all(effectivePaths.map((path) => directoryView(path, repos)));
  const savedDirectories = override
    ? await Promise.all(config.directories.map((row) => directoryView(row.path, null)))
    : [];
  const saved = new Set(config.directories.map((row) => canonicalize(row.path)));

  return {
    directories,
    managedBy: override ? "environment" : "config",
    environmentVariable: override?.variable ?? null,
    environmentValue: override?.value ?? null,
    savedDirectories,
    defaultsMissing: DEFAULT_INDEXED_DIRECTORIES.filter(
      (path) => !saved.has(canonicalize(path)),
    ),
    repoCount: repos.length,
    scannedAt: reposCacheScannedAt() ?? Date.now(),
  };
}

export {
  RepoIndexConfigError,
  canonicalize,
  environmentDirectories,
  expandHome,
  getRepoIndexConfig,
  indexedDirectories,
  validateIndexedDirectories,
};
