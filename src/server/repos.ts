import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR, envVar } from "./config.ts";
import { run } from "./util/exec.ts";
import { bareRepositoryStatus, isBareRepository, mainRepoRoot } from "./util/git.ts";
import { indexedDirectories } from "./repo-index-config.ts";

/**
 * Index the git repositories a dispatch can target. The dispatch form needs the
 * user's *repos* - not the live sessions' cwds, which are throwaway worktrees the
 * harness itself created. We scan the configured indexed directories for git
 * checkouts and hand back their top-level paths.
 */

/**
 * How old a scan may be before a read starts a rescan behind it. An ordinary read never
 * WAITS on age (see `listRepos`); only a `fresh` or `rescan` read does.
 */
const CACHE_TTL_MS = Number(envVar("REPOS_CACHE_MS") ?? 30_000);
/** Where the last completed scan survives a daemon restart. */
const SNAPSHOT_PATH = join(STATE_DIR, "repo-index-cache.json");
// 2: the identity became roots AND depth. 3: the wall-clock start rides beside the ordering
// stamp. An older file is ignored, never misread.
const SNAPSHOT_VERSION = 3;
/** Scan all nesting levels unless the operator explicitly limits traversal. */
function maximumDepth(): number {
  const value = envVar("REPOS_MAX_DEPTH");
  if (value === undefined || !value.trim()) return Infinity;
  const depth = Number(value);
  return Number.isSafeInteger(depth) && depth >= 0 ? depth : Infinity;
}
/** Directories that never contain a repo we'd want and would only slow the walk. */
const SKIP = new Set(["node_modules", "dist", "build", "target", "vendor", ".next", "coverage"]);

/**
 * The last completed scan.
 *
 * `key` names what it walked - the exact roots AND the depth limit - because a scan of other
 * roots, or of the same roots to another depth, does not answer the question at all.
 * `generation` is the invalidation count when the scan STARTED, so a scan already running
 * when the config changed or the operator pressed Rescan is never mistaken for the answer to
 * that request. `at` orders scans, from `nextScanStamp`: unique and increasing, so it tells
 * two apart even when they start within one millisecond. `startedAt` is the wall clock when
 * it started, unadjusted - what the TTL measures and what Settings reports as "scanned at",
 * neither of which should drift by the nudges that keep `at` unique.
 */
interface Snapshot {
  at: number;
  startedAt: number;
  key: string;
  generation: number;
  repos: string[];
}

let cache: Snapshot | null = null;
let generation = 0;
let snapshotLoaded = false;
/** The last stamp handed out. Never repeats and never goes backwards within a process. */
let lastStamp = 0;
/**
 * The one walk on disk right now, if any. Walks never overlap: under load each `readdir`
 * already queues behind the rest of the daemon's I/O, and two walks of the same tree at
 * once would only double that for an answer one of them could give.
 */
let walking: { slot: string; at: number; scan: Promise<Snapshot> } | null = null;
/**
 * The walk queued behind it, per (generation, key). Not started, so it is stamped after
 * every request that joins it - which is what lets any number of rescans share it.
 */
const queued = new Map<string, Promise<Snapshot>>();
/** Settles when the last walk handed out has finished; the next one starts after it. */
let walksDone: Promise<unknown> = Promise.resolve();

/**
 * The start time of a new scan: wall-clock milliseconds, nudged forward by one when the clock
 * has not moved past the previous stamp. Strictly increasing, so "started later" is never a
 * tie - on the daemon and in the browser, which orders answers by this same value.
 */
function nextScanStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

/**
 * Roots to scan for repos. Settings > Repositories owns the saved list, while
 * `MISSION_WORKSPACE_DIRS` (colon-separated, like PATH) keeps launch-time precedence.
 */
export function workspaceRoots(): string[] {
  return indexedDirectories();
}

/**
 * Mark the current scan stale after the root list changes or an operator requests it.
 *
 * Stale, not discarded: an ordinary read (the dispatch form) keeps answering from it while
 * the rescan runs, and a `fresh` read (Settings) waits for a scan started after this call.
 */
export function invalidateReposCache(): void {
  generation += 1;
}

/** Timestamp of the scan currently backing `listRepos`, for the Settings freshness readout. */
export function reposCacheScannedAt(): number | null {
  return cache?.startedAt ?? null;
}

/** What a scan walks: the roots and the effective depth limit (Infinity spelled out). */
function scanKeyFor(roots: readonly string[]): string {
  return JSON.stringify({ roots, maxDepth: String(maximumDepth()) });
}

function identityOf(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/**
 * A short, stable name for what the index walks right now - the effective roots and depth.
 *
 * Stable across restarts while nothing changes, and different the moment a directory is
 * added or removed, the depth limit moves, or a settings restore replaces either. A browser
 * keeps a repository list only while the list's identity matches this one, which is how a
 * window that missed the change while disconnected still drops a list for directories that
 * are no longer indexed - and keeps one that is still right.
 */
export function repoIndexIdentity(): string {
  return identityOf(scanKeyFor(workspaceRoots()));
}

/**
 * Seed memory from the scan the previous daemon left, once per process. It is served as
 * stale whatever its age, so the first dispatch after a restart answers at once and the
 * walk runs behind it rather than in front of the operator.
 */
function loadPersistedSnapshot(): void {
  if (snapshotLoaded) return;
  snapshotLoaded = true;
  if (cache) return;
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Record<string, unknown>;
    if (
      parsed.version === SNAPSHOT_VERSION
      && typeof parsed.at === "number"
      && typeof parsed.startedAt === "number"
      && typeof parsed.key === "string"
      && Array.isArray(parsed.repos)
      && parsed.repos.every((repo) => typeof repo === "string")
    ) {
      // Older than every invalidation this process has seen, so always refreshed behind.
      cache = {
        at: parsed.at,
        startedAt: parsed.startedAt,
        key: parsed.key,
        generation: -1,
        repos: parsed.repos as string[],
      };
      // Every scan this process starts is stamped after the one it inherited.
      lastStamp = Math.max(lastStamp, parsed.at);
    }
  } catch {
    // Missing or unreadable: the first read scans, as it did before there was a snapshot.
  }
}

let persisting: Promise<void> = Promise.resolve();

/** Queue a write of `snapshot`, one at a time, so two writes never share the temp file. */
function persistSnapshot(snapshot: Snapshot): void {
  persisting = persisting.then(() => writeSnapshot(snapshot));
}

async function writeSnapshot(snapshot: Snapshot): Promise<void> {
  // A later scan already replaced this one in memory; its own queued write follows.
  if (cache !== snapshot) return;
  const temporary = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
  const body = {
    version: SNAPSHOT_VERSION,
    at: snapshot.at,
    startedAt: snapshot.startedAt,
    key: snapshot.key,
    repos: snapshot.repos,
  };
  try {
    await writeFile(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    // A rename, so a starting daemon never reads half a file.
    await rename(temporary, SNAPSHOT_PATH);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Start, or join, a scan of `roots` for the current generation.
 *
 * At most one walk runs at a time and at most one waits behind it per (generation, key), so
 * however many readers ask while a walk is running, they cost at most one more walk.
 *
 * Without `after`, the running walk answers when it is of this generation and key, and
 * otherwise the queued one does. With `after`, only a walk stamped later than `after`
 * answers: the running one started before the request and may already have passed a
 * directory a checkout was just cloned into, so the request joins - or becomes - the walk
 * queued behind it, which is stamped when it starts and so after the request.
 */
function refresh(roots: string[], after?: number): Promise<Snapshot> {
  const key = scanKeyFor(roots);
  const startedGeneration = generation;
  const slot = `${startedGeneration}|${key}`;
  if (walking?.slot === slot && (after === undefined || walking.at > after)) return walking.scan;
  const waiting = queued.get(slot);
  if (waiting) return waiting;
  const previous = walksDone;
  // Assigned before the body below first runs: it waits on `previous` before reading it.
  let scan!: Promise<Snapshot>;
  scan = (async () => {
    await previous;
    // Leaving the queue: a request from here on finds this walk running, stamped below.
    queued.delete(slot);
    const startedAt = Date.now();
    const at = nextScanStamp();
    walking = { slot, at, scan };
    try {
      const repos = await scanRepos(roots);
      const snapshot: Snapshot = { at, startedAt, key, generation: startedGeneration, repos };
      // A scan that started earlier never overwrites a later one, whichever finishes first.
      if (!cache || cache.at < at) {
        cache = snapshot;
        persistSnapshot(snapshot);
      }
      return snapshot;
    } finally {
      if (walking?.scan === scan) walking = null;
    }
  })();
  queued.set(slot, scan);
  walksDone = scan.catch(() => {});
  return scan;
}

/**
 * Walk `dir` collecting git checkouts into `out`. A directory holding a `.git`
 * entry (dir for a normal clone, file for a linked worktree/submodule) is itself
 * a repo: record it and stop - we never descend into a repo, so nested worktrees
 * and vendored checkouts don't pollute the list.
 */
async function scan(root: string, out: Set<string>, maxDepth: number): Promise<void> {
  const pending = [{ dir: root, depth: 0 }];
  // An iterative walk keeps both open directory reads and the call stack bounded even
  // when an indexed directory contains thousands of deeply nested folders.
  while (pending.length) {
    const { dir, depth } = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Decide from the listing already in hand. Bare metadata is a HEAD beside objects/ and
    // refs/, so a directory missing any of the three cannot be one and costs no further
    // syscall. The walk used to stat `HEAD` synchronously in EVERY directory it visited, on
    // the daemon's event loop.
    const names = new Set(entries.map((e) => e.name));
    if (names.has("HEAD") && names.has("objects") && names.has("refs")) {
      const bare = bareRepositoryStatus(dir);
      if (bare === null) continue;
      if (bare) {
        out.add(dir);
        continue;
      }
    }
    if (names.has(".git")) {
      const metadata = join(dir, ".git");
      const metadataBare = bareRepositoryStatus(metadata);
      if (metadataBare !== null) out.add(metadataBare ? metadata : dir);
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      // A common bare-clone layout keeps metadata in .bare beside its worktrees.
      // Do not open other hidden folders or follow descendant symlinks.
      if (entry.name.startsWith(".") && entry.name !== ".bare") continue;
      const child = join(dir, entry.name);
      if (entry.name === ".bare" && !isBareRepository(child)) continue;
      pending.push({ dir: child, depth: depth + 1 });
    }
  }
}

/** Scan the given roots for git repos, deduped and sorted. Uncached (see listRepos). */
export async function scanRepos(roots: string[]): Promise<string[]> {
  const out = new Set<string>();
  const maxDepth = maximumDepth();
  await Promise.all(
    roots.map(async (root) => {
      // Resolve symlinked roots so recorded paths match a repo's real top-level.
      const real = await realpath(root).catch(() => root);
      await scan(real, out, maxDepth);
    }),
  );
  return [...out].sort();
}

/**
 * All git repos under the workspace roots, deduped and sorted.
 *
 * An ordinary read answers from the last scan of these roots whatever its age, and starts a
 * rescan behind the answer when that scan is older than `CACHE_TTL_MS` or was invalidated.
 * It waits only when no scan of these roots exists at all - and then every concurrent
 * reader waits on the same walk. The dispatch form reads this way: under load every
 * `readdir` queues on the libuv pool the rest of the daemon shares, and a slow walk must
 * never leave the Repo picker empty while the answer from thirty seconds ago is in hand.
 *
 * `fresh` is for a reader that must reflect a change made through Mission Control - Settings
 * after a config write or Rescan now. It waits for a scan within the TTL that postdates the
 * latest invalidation, sharing one already running for that generation.
 *
 * `rescan` is for a reader that must reflect a change made on DISK - the Dispatch form, so a
 * checkout cloned a moment ago is offered. It waits for a scan that started after this call,
 * whatever the TTL, because no earlier scan can vouch for a directory it may already have
 * walked past.
 */
export async function listRepos(options: ListReposOptions = {}): Promise<string[]> {
  return (await listReposScan(options)).repos;
}

export interface ListReposOptions {
  /** Wait for a scan within the TTL that postdates the latest invalidation. */
  fresh?: boolean;
  /** Wait for a scan that started after this call. */
  rescan?: boolean;
}

/**
 * `listRepos`, together with the stamp of the scan that answered it (`nextScanStamp`). The
 * HTTP route sends it so a browser holding two answers keeps the newer one, whichever
 * arrived last.
 */
export async function listReposScan(
  options: ListReposOptions = {},
): Promise<{ repos: string[]; scannedAt: number; identity: string }> {
  loadPersistedSnapshot();
  const roots = workspaceRoots();
  const answer = (snapshot: Snapshot) => ({
    repos: snapshot.repos,
    scannedAt: snapshot.at,
    identity: identityOf(snapshot.key),
  });
  // Every stamp handed out so far belongs to a scan that started before this call.
  if (options.rescan) return answer(await refresh(roots, lastStamp));
  const current = cache?.key === scanKeyFor(roots) ? cache : null;
  if (current && current.generation === generation && Date.now() - current.startedAt < CACHE_TTL_MS) {
    return answer(current);
  }
  // A TTL of zero turns caching off: every read is answered by a current walk.
  if (current && !options.fresh && CACHE_TTL_MS > 0) {
    void refresh(roots).catch(() => {});
    return answer(current);
  }
  return answer(await refresh(roots));
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
 * Bare owners use their Git directory. Submodules and relocated non-bare metadata
 * still fall back to the working tree reported by Git; task validation refuses those.
 */
export async function resolveRepoRoot(p: string): Promise<string | null> {
  if (!existsSync(p)) return null;
  const r = await run("git", ["-C", p, "rev-parse", "--show-toplevel"]);
  if (r.outcomeUnknown || r.overflowed) return null;
  const top = r.stdout.trim();
  if (r.code !== 0 || !top) {
    const bare = await run("git", ["-C", p, "rev-parse", "--is-bare-repository", "--absolute-git-dir"]);
    if (bare.code !== 0 || bare.outcomeUnknown || bare.overflowed) return null;
    const [kind, dir] = bare.stdout.trim().split("\n");
    return kind === "true" && dir && isBareRepository(dir) ? realpathSync(dir) : null;
  }
  const owner = mainRepoRoot(top);
  if (owner) return owner;
  try {
    return realpathSync(top);
  } catch {
    return top;
  }
}

/**
 * The repository a path belongs to, AND the canonical form of the path itself.
 *
 * Two answers because resolving to a repository is lossy in one direction that a caller
 * may need back: `/repo/packages/web` resolves to `/repo`, and a caller configuring a
 * per-package command has no way to recover the package from the root alone. Callers that
 * only want the repository keep using `resolveRepoRoot`.
 *
 * `path` is canonical (symlinks followed) so it can be compared against `repoRoot` by
 * prefix, which is what makes "is this inside that repository" answerable at all.
 */
export async function resolveRepoPath(
  p: string,
): Promise<{ repoRoot: string; path: string } | null> {
  const repoRoot = await resolveRepoRoot(p);
  if (!repoRoot) return null;
  // `path` is expressed against `repoRoot`, NOT against whichever tree the caller happened
  // to be standing in. That distinction is the whole difficulty here: `resolveRepoRoot`
  // walks a linked worktree back to the repository that owns it, so for a path inside
  // `~/.treehouse/…/repo/packages/web` the root is the MAIN checkout and a bare realpath
  // would answer with a path that is not inside it at all. A caller comparing the two by
  // prefix would conclude "outside the repository" and discard a perfectly good
  // subdirectory - which is the same lost-subdirectory bug one level down.
  //
  // So: take the subpath within the tree the caller named, then re-root it onto the
  // repository. Sessions normally run in pooled worktrees, so this is the common case, not
  // an exotic one.
  const top = await run("git", ["-C", p, "rev-parse", "--show-toplevel"]);
  const toplevel = top.code === 0 ? top.stdout.trim() : "";
  const canonical = (dir: string): string => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  };
  const here = canonical(p);
  const tree = toplevel ? canonical(toplevel) : "";
  const sub = tree && here !== tree && here.startsWith(`${tree}/`)
    ? here.slice(tree.length + 1)
    : "";
  return { repoRoot, path: sub ? join(repoRoot, sub) : repoRoot };
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
/** A task's whole repo set, resolved: the primary plus its secondaries in request order. */
export type TaskRepoSet =
  | { ok: true; repoRoot: string; extraRepoRoots: string[] }
  | { ok: false; error: string };

/**
 * Resolve a task's PRIMARY repo together with its secondaries, as one answer.
 *
 * The single door for a multi-repo task, for the reason `resolveTaskRepoRoot` is the door
 * for a single one: the three refusals below are only checkable once every entry has been
 * walked back to its main checkout, so a caller resolving the primary and then looping the
 * extras itself would compare typed paths and let two spellings of one repo through.
 *
 * Refuses, in order:
 *
 *  - anything `resolveTaskRepoRoot` refuses, per entry, naming that entry;
 *  - a secondary that resolves to the primary - one repo attached twice is a task that
 *    would provision two worktrees of the same checkout on one branch name;
 *  - a duplicate among the secondaries, for the same reason.
 *
 * Order is preserved and is the entry's persisted `position`, which the git fallback
 * derives its worktree path from. Resolution is sequential rather than concurrent: each
 * entry is a couple of git subprocesses, the cap is small, and a stable first-failure
 * message is worth more here than the latency.
 */
export async function resolveTaskRepoSet(
  primary: string,
  extras: readonly string[],
): Promise<TaskRepoSet> {
  const resolvedPrimary = await resolveTaskRepoRoot(primary);
  if (!resolvedPrimary.ok) return resolvedPrimary;
  const extraRepoRoots = await resolveTaskExtraRepoRoots(resolvedPrimary.repoRoot, extras);
  if (!extraRepoRoots.ok) return extraRepoRoots;
  return { ok: true, repoRoot: resolvedPrimary.repoRoot, extraRepoRoots: extraRepoRoots.repoRoots };
}

/**
 * The secondaries half of `resolveTaskRepoSet`, against a primary that is ALREADY resolved.
 *
 * Split out for the task-edit route, which resolves the primary only when the edit actually
 * moves it: re-resolving an untouched root there would make a task uneditable the moment
 * its repo directory goes away, under an error about git that names neither the field the
 * operator changed nor the task.
 */
export async function resolveTaskExtraRepoRoots(
  repoRoot: string,
  extras: readonly string[],
): Promise<{ ok: true; repoRoots: string[] } | { ok: false; error: string }> {
  const repoRoots: string[] = [];
  for (const entry of extras) {
    const resolved = await resolveTaskRepoRoot(entry);
    if (!resolved.ok) return resolved;
    if (resolved.repoRoot === repoRoot) {
      return {
        ok: false,
        error:
          `${resolved.repoRoot} is already this task's primary repo - attach a different ` +
          `repo, or make it the primary`,
      };
    }
    if (repoRoots.includes(resolved.repoRoot)) {
      return { ok: false, error: `${resolved.repoRoot} is attached twice` };
    }
    repoRoots.push(resolved.repoRoot);
  }
  return { ok: true, repoRoots };
}

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
