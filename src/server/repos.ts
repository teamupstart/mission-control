import { existsSync, realpathSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { envVar } from "./config.ts";
import { run } from "./util/exec.ts";
import { mainRepoRoot } from "./util/git.ts";

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
 * `MISSION_WORKSPACE_DIRS` (colon-separated, like PATH) to point at other trees.
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

/**
 * Validate a target is a git repo and return the realpath'd root of the checkout that
 * OWNS it, or null.
 *
 * ONE definition, deliberately. It began as a private helper in `routes.ts` behind
 * `POST /api/tasks`, and it has to stay the same check for every door into the task
 * list: a task source files rows with nobody looking at the path it named, so if its
 * validation drifted from the dispatch form's, the first anyone would learn of it is a
 * dispatcher half-way through cutting a worktree in a directory that is not a checkout.
 *
 * A linked worktree resolves to its OWNER, and that walk-back is the whole point.
 * `rev-parse --show-toplevel` inside a pooled tree names the tree, and every agent we
 * dispatch stands in one - so a task filed by an agent through the MCP `create_task`
 * tool recorded `~/.treehouse/<repo>-<hash>/16/<repo>` as its repo. Two things break
 * downstream, and neither says why:
 *
 *  - the Foreman allowlist is a path-prefix rule over the repos an operator named
 *    (`cwdAllowlisted`, and `decideBacklogTick` asks it of `Task.repoRoot`), so a task
 *    rooted in a pooled tree is in no trusted repo and is silently never scheduled. Seen
 *    exactly that way: 17 of a 19-item backlog unschedulable, while the popover - which
 *    deliberately ignores the allowlist - still counted them ready.
 *  - a pooled tree is reclaimed and handed to someone else, so the row outlives the path
 *    it names. One of those 17 already pointed at a directory that no longer existed.
 *
 * `Session.repoRoot` has always been the owner (`gitInfo`, whose doc comment says why),
 * so before this the two sides of the same question disagreed: an agent cleared the
 * allowlist while the task it filed from that very checkout did not.
 *
 * The walk-back is `mainRepoRoot`, which returns null rather than guessing for a bare
 * repo, a submodule or a relocated git dir. Those fall back to the top-level git itself
 * reported, which is what this returned for every input before - so nothing that
 * resolved yesterday stops resolving, it only stops naming a throwaway directory.
 */
export async function resolveRepoRoot(p: string): Promise<string | null> {
  if (!existsSync(p)) return null;
  const r = await run("git", ["-C", p, "rev-parse", "--show-toplevel"]);
  const top = r.stdout.trim();
  if (r.code !== 0 || !top) return null;
  const owner = mainRepoRoot(top);
  if (owner) return owner;
  try {
    return realpathSync(top);
  } catch {
    return top;
  }
}

/** A resolved repo root a task may be filed against, or the sentence refusing it. */
export type TaskRepoRoot = { ok: true; repoRoot: string } | { ok: false; error: string };

/**
 * Resolve a repo root for a task, and refuse one that is not a repo's main checkout.
 *
 * The validating door every task-creating route goes through - the dispatch form, the
 * MCP `create_task` tool, a repo edit, and a task source's sweep - so no writer can
 * reach the task list with a root the scheduler will never act on.
 *
 * `resolveRepoRoot` already walks a linked worktree back to its owner, so the normal
 * case never reaches the refusal: an agent standing in `~/.treehouse/…` files its task
 * against the repo that owns that tree, which is what it meant. This is the backstop for
 * the case the walk-back CANNOT correct - a checkout whose `.git` is a file pointing
 * somewhere we cannot follow back to a main worktree (a submodule, a relocated git dir,
 * a pool tree whose `.git` file is unreadable). Storing one of those is the same defect
 * arriving by a door the resolver cannot close: a row rooted in a directory that is
 * nobody's repo, unschedulable under the allowlist and reclaimable underneath itself.
 *
 * A refusal is a 400 naming the path, not a silent correction, because there is nothing
 * left to correct it TO - and a caller told which path was rejected can name a real repo,
 * where a caller handed a guess cannot tell that anything happened.
 *
 * Deliberately NOT folded into `resolveRepoRoot`: its other two callers - the Foreman
 * allowlist picker and the task-source config form - ask "is this a repo?" about a path a
 * human just typed, and answering that with a null would report "not a git repository"
 * about a checkout that plainly is one.
 */
export async function resolveTaskRepoRoot(p: string): Promise<TaskRepoRoot> {
  const repoRoot = await resolveRepoRoot(p);
  if (!repoRoot) return { ok: false, error: `not a git repository: ${p}` };
  // The main checkout is the one `mainRepoRoot` maps to ITSELF. Anything else is a
  // worktree we could not attribute to a repo - see above.
  if (mainRepoRoot(repoRoot) !== repoRoot) {
    return {
      ok: false,
      error:
        `not a repo's main checkout: ${repoRoot} - it is a worktree with no reachable ` +
        `main checkout, so a task filed against it could never be scheduled. Name the ` +
        `repo that owns it instead.`,
    };
  }
  return { ok: true, repoRoot };
}
