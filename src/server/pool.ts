import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { remoteDefaultRef } from "./actions.ts";
import { envVar } from "./config.ts";
import type { Registry } from "./registry.ts";
import { run, type RunResult } from "./util/exec.ts";
import { mainRepoRoot } from "./util/git.ts";
import { unref } from "./util/timers.ts";

/**
 * Reclaiming leaked leases from a repo's treehouse worktree pool.
 *
 * treehouse keeps a fixed-size pool (`max_trees`) of pre-warmed worktrees and
 * hands one out per `treehouse get --lease`. A lease is deliberately DURABLE -
 * `scripts/new-session.mjs` leases a tree and leaves it leased so a backgrounded
 * agent keeps its checkout across restarts - which means nothing frees a tree
 * when its agent simply goes away. Leases accumulate, the pool hits `max_trees`
 * with zero available, and every later `treehouse get` fails: `provisionWorktree`
 * then quietly falls back to a throwaway `git worktree`, so the pool's whole
 * point (pre-warmed, reused trees) is lost while the leak stays invisible.
 *
 * treehouse's own `prune` can't fix this: it skips any tree with an owner
 * reservation, and a leaked lease IS a reservation. Only the lease holder can
 * hand one back, so the harness reaps its own.
 *
 * `treehouse return` is destructive - it terminates processes in the tree, then
 * cleans and resets it - so a wrong reap kills a live agent AND discards its
 * work. Every check in `planReap` exists to make that impossible; see the gate
 * there for what each one is actually protecting against.
 */

/** A worktree in the pool, as `treehouse status` reports it. */
export interface PoolTree {
  /** The pool slot's name ("1", "2", …), for logs. */
  name: string;
  state: "leased" | "in-use" | "available";
  /** Absolute path (treehouse abbreviates $HOME to `~`; we expand it). */
  path: string;
  /** Who holds the lease, when leased. */
  holder: string | null;
  /** treehouse listed live processes under this tree - something is using it. */
  busy: boolean;
}

/** A pool tree and the verdict on reclaiming it. */
export interface ReapCandidate {
  tree: PoolTree;
  /** Null when reclaimable; otherwise the reason we left it alone (for logs). */
  skip: string | null;
}

export interface ReapResult {
  /** Trees handed back to the pool. */
  reaped: PoolTree[];
  /** Every tree we considered and declined, with the reason. */
  skipped: ReapCandidate[];
}

/** treehouse shell-outs, injectable so tests never need the binary installed. */
export interface PoolDeps {
  status: (repoRoot: string) => Promise<RunResult>;
  /** `treehouse return --force <path>` - non-interactive, so it can't block a poller. */
  returnTree: (repoRoot: string, path: string) => Promise<RunResult>;
}

export const defaultPoolDeps: PoolDeps = {
  status: (repoRoot) => run("treehouse", ["status"], { cwd: repoRoot, timeoutMs: 15000 }),
  returnTree: (repoRoot, path) =>
    run("treehouse", ["return", "--force", path], { cwd: repoRoot, timeoutMs: 30000 }),
};

/** How often the daemon sweeps known pools for leaked leases. */
const POOL_REAP_MS = Number(envVar("POOL_REAP_MS") ?? 300_000);

/** A repo opts into the pool by committing a `treehouse.toml` at its root. */
export function isTreehouseRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "treehouse.toml"));
}

/**
 * The working dirs of every live agent, so a reap can't pull a tree out from
 * under one. This is the harness's own view of liveness, independent of the
 * process list treehouse reports - either one seeing a session is enough to
 * spare its tree.
 */
export function occupiedCwds(registry: Registry): string[] {
  return registry
    .liveSessions()
    .map((s) => s.cwd)
    .filter((cwd): cwd is string => cwd !== null);
}

/**
 * The pools worth sweeping: the main repos behind every live session and every
 * task the harness tracks, keeping only those that opted into treehouse.
 *
 * Sessions are the important half. A leaked lease is usually left by `make
 * session` / `make claude`, which never go through a task at all - and a session
 * standing in a POOLED tree reports that tree as its cwd, not the repo that owns
 * the pool, so we walk each one back to its main root before asking treehouse
 * about it.
 */
export function poolRepos(registry: Registry): string[] {
  const roots = new Set<string>();
  for (const cwd of occupiedCwds(registry)) {
    const root = mainRepoRoot(cwd);
    if (root) roots.add(root);
  }
  for (const task of registry.listTasks()) roots.add(task.repoRoot);
  return [...roots].filter(isTreehouseRepo);
}

/**
 * Sweep known pools for leaked leases on a slow timer, so a tree freed by an
 * agent that has simply gone away is back in the pool before anyone needs it -
 * including `make session`, which leases directly and never asks the daemon for
 * anything.
 *
 * Slow on purpose: each tick shells out to treehouse and git per pool, and a
 * leaked lease is a resource leak, not an emergency. Reaping is idempotent, so a
 * missed tick costs nothing.
 */
export function startPoolReaper(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      for (const repoRoot of poolRepos(registry)) {
        const { reaped } = await reapPool(repoRoot, occupiedCwds(registry));
        if (reaped.length > 0) {
          console.log(
            `[fleet-control] returned ${reaped.length} leaked lease(s) to the pool in ` +
              `${repoRoot}: ${reaped.map((t) => t.name).join(", ")}`,
          );
        }
      }
    } catch {
      // Never let a sweep take the daemon down - the pool heals on the next tick.
    }
    if (!stopped) timer = unref(setTimeout(() => void tick(), POOL_REAP_MS));
  };

  timer = unref(setTimeout(() => void tick(), POOL_REAP_MS));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Parse `treehouse status`. Its output is one line per tree, optionally followed
 * by INDENTED lines listing the processes running under the previous tree:
 *
 *   1     leased       ~/.treehouse/repo-abc/1/repo  (held by fleet-control)
 *   8     leased       ~/.treehouse/repo-abc/8/repo  (held by fleet-control)
 *                      claude (74975), node (75244)
 *   13    in-use       ~/.treehouse/repo-abc/13/repo
 *
 * The process list is what makes `busy` trustworthy: `leased` alone says nothing
 * about liveness (a dead agent's tree stays `leased` forever - that's the leak),
 * so we take treehouse's own view of what's running rather than re-deriving it.
 * Unrecognized lines (banners like "Shell cwd was reset to …") are ignored.
 */
export function parsePoolStatus(stdout: string): PoolTree[] {
  const trees: PoolTree[] = [];
  const line = /^(\S+)[ \t]+(leased|in-use|available)[ \t]+(\S+)(?:[ \t]+\(held by (.+?)\))?[ \t]*$/;
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    // Indented => a process list belonging to the tree above it.
    if (/^\s/.test(raw)) {
      const last = trees[trees.length - 1];
      if (last) last.busy = true;
      continue;
    }
    const m = line.exec(raw);
    if (!m) continue;
    trees.push({
      name: m[1]!,
      state: m[2] as PoolTree["state"],
      path: expandHome(m[3]!),
      holder: m[4] ?? null,
      busy: false,
    });
  }
  return trees;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith(`~${sep}`) ? join(homedir(), p.slice(2)) : p;
}

/** True when `cwd` is the worktree itself or anywhere inside it. */
function within(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);
}

function git(cwd: string, args: string[], timeoutMs = 15000): Promise<RunResult> {
  return run("git", ["-C", cwd, ...args], { timeoutMs });
}

/**
 * Decide, tree by tree, which leases are safe to hand back.
 *
 * The gate is ordered cheapest-first and every rung is load-bearing:
 *
 *  - not `leased`      - `available` needs nothing; `in-use` is live by definition.
 *  - treehouse says busy - processes are running under it. This is the check that
 *    saves a live agent, and it is NOT redundant with the git checks below: an
 *    agent that has just pushed sits in a tree that is clean AND merged, so the
 *    git gate alone would happily reap the tree out from under it.
 *  - a live session's cwd is inside it - the harness's own independent view of
 *    liveness, so a session treehouse can't see still pins its tree.
 *  - uncommitted changes  - `return` would `clean`/`reset` them away.
 *  - commits origin doesn't have - unpushed work the reset would discard.
 *
 * The last two mirror `treehouse prune`'s own staleness rule ("no uncommitted
 * changes, HEAD already merged into the default branch"); we deliberately differ
 * only on the reservation, which is the leak we're here to collect.
 *
 * Every uncertainty resolves to *skip*: no default ref, an unreadable tree, a
 * failed git call. Leaving a lease leaked costs a pool slot; a wrong reap costs
 * the user's work.
 */
export async function planReap(
  trees: readonly PoolTree[],
  occupiedCwds: readonly string[],
): Promise<ReapCandidate[]> {
  const out: ReapCandidate[] = [];
  for (const tree of trees) {
    out.push({ tree, skip: await verdict(tree, occupiedCwds) });
  }
  return out;
}

/**
 * The rungs that need no subprocess: lease state, liveness, existence. Split out
 * so `reapPool` can tell "nothing here could possibly be reclaimed" without
 * paying for a fetch - the common case, since a healthy pool is all busy trees.
 * Returns the skip reason, or null when the tree is still a candidate.
 */
function cheapVerdict(tree: PoolTree, occupiedCwds: readonly string[]): string | null {
  if (tree.state !== "leased") return `it is ${tree.state}`;
  if (tree.busy) return "processes are still running in it";
  if (occupiedCwds.some((cwd) => within(cwd, tree.path))) return "a live session is standing in it";
  if (!existsSync(tree.path)) return "the worktree is missing";
  return null;
}

async function verdict(tree: PoolTree, occupiedCwds: readonly string[]): Promise<string | null> {
  const cheap = cheapVerdict(tree, occupiedCwds);
  if (cheap) return cheap;

  const dirty = await git(tree.path, ["status", "--porcelain"]);
  if (dirty.code !== 0) return "its git status could not be read";
  if (dirty.stdout.trim()) return "it has uncommitted changes";

  // Remote-only, like the reset's target: a stale *local* main would call work
  // merged that origin has never seen.
  const target = await remoteDefaultRef(tree.path);
  if (!target) return "it has no origin default branch to compare against";
  // `--is-ancestor` is exactly "origin already contains everything here", and it
  // reads a detached HEAD as happily as a branch (half the pool sits detached).
  const merged = await git(tree.path, ["merge-base", "--is-ancestor", "HEAD", target]);
  if (merged.code !== 0) return `it has commits ${target} doesn't have`;
  return null;
}

/**
 * Hand every provably-idle lease in `repoRoot`'s pool back, so the next
 * `treehouse get` is served from the pool instead of failing into a throwaway
 * worktree. Best-effort throughout: a repo without treehouse, an uninstalled
 * binary, or a single failed `return` degrades to "reaped fewer trees", never to
 * a thrown error - this runs on a poller and behind a dispatch.
 *
 * `occupiedCwds` are the live sessions' working dirs; pass them so a tree the
 * harness knows is in use is spared even if treehouse can't see its processes.
 */
export async function reapPool(
  repoRoot: string,
  occupiedCwds: readonly string[],
  deps: PoolDeps = defaultPoolDeps,
): Promise<ReapResult> {
  const empty: ReapResult = { reaped: [], skipped: [] };
  if (!isTreehouseRepo(repoRoot)) return empty;

  const status = await deps.status(repoRoot);
  if (status.code !== 0) return empty;
  const trees = parsePoolStatus(status.stdout);
  if (trees.length === 0) return empty;
  // Nothing even plausibly idle (the healthy case: every tree busy or available)?
  // Then don't reach for the network at all - a sweep costs one `treehouse status`.
  if (trees.every((t) => cheapVerdict(t, occupiedCwds) !== null)) {
    return { reaped: [], skipped: trees.map((t) => ({ tree: t, skip: cheapVerdict(t, occupiedCwds)! })) };
  }

  // One fetch for the whole pool: linked worktrees share the main repo's git dir,
  // so this refreshes `origin/*` for every tree at once. It's what keeps the
  // merged check honest for a branch that landed since the last sweep.
  // Best-effort - offline just leaves origin stale, which reads as "unmerged" and
  // skips. Safe.
  await git(repoRoot, ["fetch", "origin"], 30000);

  const plan = await planReap(trees, occupiedCwds);
  const result: ReapResult = { reaped: [], skipped: plan.filter((c) => c.skip !== null) };
  for (const { tree } of plan.filter((c) => c.skip === null)) {
    const r = await deps.returnTree(repoRoot, tree.path);
    if (r.code === 0) result.reaped.push(tree);
    else result.skipped.push({ tree, skip: `treehouse return failed: ${r.stderr.trim() || "unknown"}` });
  }
  return result;
}
