import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { envVar } from "./config.ts";

/**
 * Index the git repositories a dispatch can target. The dispatch form needs the
 * user's *repos* - not the live sessions' cwds, which are throwaway worktrees the
 * harness itself created. We scan a small set of workspace roots (default
 * `~/workspace`) for git checkouts and hand back their top-level paths.
 *
 * The pool reaper (`./pool.ts`) is a second consumer, and wants the scan for the
 * opposite reason: it needs the repos NOTHING else can name. A fully leaked
 * treehouse pool has no live session and no tracked task left to advertise it, so
 * this walk is the only thing that finds it. That consumer leans on the `.git`
 * ENTRY rule below - it takes linked worktrees as readily as clones, and walks
 * each hit back to its owning repo itself.
 */

/** Cache the scan briefly so the endpoint stays cheap under the UI's polling. */
const CACHE_TTL_MS = Number(envVar("REPOS_CACHE_MS") ?? 30_000);
/** How deep below a workspace root to look before giving up (repos may be nested a
 *  couple of folders down, e.g. `~/workspace/org/repo`). */
const MAX_DEPTH = Number(envVar("REPOS_MAX_DEPTH") ?? 3);
/** Directories that never contain a repo we'd want and would only slow the walk. */
const SKIP = new Set(["node_modules", "dist", "build", "target", "vendor", ".next", "coverage"]);

let cache: { at: number; repos: string[] } | null = null;

/**
 * Roots to scan for repos. Defaults to `~/workspace`; override with
 * `FLEET_WORKSPACE_DIRS` (colon-separated, like PATH) to point at other trees.
 */
export function workspaceRoots(): string[] {
  const override = envVar("WORKSPACE_DIRS") ?? envVar("WORKSPACE_DIR");
  const raw = override
    ? override.split(":").map((s) => s.trim()).filter(Boolean)
    : [join(homedir(), "workspace")];
  return raw;
}

/**
 * Walk `dir` collecting git checkouts into `out`. A directory holding a `.git`
 * entry (dir for a normal clone, file for a linked worktree/submodule) is itself
 * a repo: record it and stop - we never descend into a repo, so nested worktrees
 * and vendored checkouts don't pollute the list.
 */
async function scan(dir: string, depth: number, out: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / vanished mid-walk - skip quietly
  }
  if (entries.some((e) => e.name === ".git")) {
    out.add(dir);
    return;
  }
  if (depth >= MAX_DEPTH) return;
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
      .map((e) => scan(join(dir, e.name), depth + 1, out)),
  );
}

/** Scan the given roots for git repos, deduped and sorted. Uncached (see listRepos). */
export async function scanRepos(roots: string[]): Promise<string[]> {
  const out = new Set<string>();
  await Promise.all(
    roots.map(async (root) => {
      // Resolve symlinked roots so recorded paths match a repo's real top-level.
      const real = await realpath(root).catch(() => root);
      await scan(real, 0, out);
    }),
  );
  return [...out].sort();
}

/**
 * All git repos under the workspace roots, deduped and sorted. Cached for
 * `CACHE_TTL_MS` so repeated dispatch-modal opens - and the pool reaper's sweep -
 * don't rescan the disk.
 */
export async function listRepos(): Promise<string[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.repos;
  const repos = await scanRepos(workspaceRoots());
  cache = { at: now, repos };
  return repos;
}
