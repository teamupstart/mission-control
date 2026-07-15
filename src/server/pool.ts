import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { remoteDefaultRef } from "./actions.ts";
import { envVar } from "./config.ts";
import type { Registry } from "./registry.ts";
import { listRepos } from "./repos.ts";
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

/** How often the daemon sweeps known pools for leaked leases, absent an override. */
const DEFAULT_REAP_MS = 300_000;

/**
 * The floor under a configured sweep interval. A sweep shells out to `treehouse
 * status` per pool and can reach the network, so a fat-fingered
 * `FLEET_POOL_REAP_MS=5` would hammer treehouse and origin forever. Nobody wants
 * a five-millisecond leak collector; clamp rather than obey.
 */
const MIN_REAP_MS = 30_000;

/**
 * The sweep interval, or null when the sweep is switched OFF.
 *
 * `FLEET_POOL_REAP_MS=0` is how anyone would try to disable a periodic job, and
 * it has to actually disable it: handed to `setTimeout`, 0 is a ~1ms tick, which
 * turns the off switch into a hot loop of `treehouse status`, `git fetch`, and
 * forced returns - the opposite of what was asked for. Same for any negative
 * value. An unparseable value is a typo rather than an instruction, so it falls
 * back to the default instead of into that same spin.
 *
 * Read per call, not at import, so the value is whatever the daemon was started
 * with rather than whatever won the module-load race.
 */
export function reapIntervalMs(): number | null {
  const raw = envVar("POOL_REAP_MS");
  if (raw === undefined || raw.trim() === "") return DEFAULT_REAP_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return DEFAULT_REAP_MS;
  if (ms <= 0) return null;
  return Math.max(ms, MIN_REAP_MS);
}

/** A repo opts into the pool by committing a `treehouse.toml` at its root. */
export function isTreehouseRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "treehouse.toml"));
}

/**
 * Everything the harness itself is holding, so a reap can't pull a tree out from
 * under its own work. Two separate claims, because they miss different things:
 *
 *  - `sessionCwds` - where live agents are actually standing. Independent of the
 *    process list treehouse reports; either view seeing a session spares its tree.
 *  - `taskWorktrees` - worktrees still recorded on a task. A task deliberately
 *    KEEPS its tree after its agent exits (a mid-flight complete must not discard
 *    work; a failed-but-alive task still holds its checkout), and such a tree is
 *    exactly what the git gate green-lights: idle, clean, and merged if the agent
 *    pushed. Sessions alone cannot see it, because there is no session left.
 */
export interface PoolPins {
  sessionCwds: readonly string[];
  taskWorktrees: readonly string[];
}

/** The working dirs of every live agent. */
export function occupiedCwds(registry: Registry): string[] {
  return registry
    .liveSessions()
    .map((s) => s.cwd)
    .filter((cwd): cwd is string => cwd !== null);
}

/** Everything a reap must leave alone; pass to `reapPool`/`planReap`. */
export function poolPins(registry: Registry): PoolPins {
  return {
    sessionCwds: occupiedCwds(registry),
    taskWorktrees: registry
      .listTasks()
      .map((t) => t.worktreePath)
      .filter((p): p is string => p !== null && p !== undefined),
  };
}

/**
 * The pools worth sweeping, from three sources that each name what the others
 * miss, keeping only the repos that opted into treehouse:
 *
 *  - live sessions - where agents actually are. A session standing in a POOLED
 *    tree reports that tree as its cwd, not the repo that owns the pool, so we
 *    walk each one back to its main root before asking treehouse about it.
 *  - tracked tasks - repos the harness has dispatched into. These outlive their
 *    sessions, since the task list is rehydrated across a restart.
 *  - the workspace scan - the only source that can name a FULLY leaked pool.
 *    The first two describe currently-live state, and a fully leaked pool is
 *    defined by its sessions being dead: the repo that most needs the sweep is
 *    exactly the one that drops off both lists. Nor can the user advertise it by
 *    starting a session there, because `treehouse get` is what fails when the
 *    pool is dry. This is also where the leak actually comes from - `make
 *    session` / `make claude` lease directly and never go through a task at all.
 *
 * The scan walks the disk, so it is best-effort: a failure degrades to "sweep
 * the repos we already knew about" rather than costing the whole tick.
 */
export async function poolRepos(registry: Registry): Promise<string[]> {
  const roots = new Set<string>();
  for (const cwd of occupiedCwds(registry)) {
    const root = mainRepoRoot(cwd);
    if (root) roots.add(root);
  }
  for (const task of registry.listTasks()) roots.add(task.repoRoot);
  for (const repo of await listRepos().catch(() => [])) roots.add(repo);
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
 *
 * `FLEET_POOL_REAP_MS=0` switches the sweep off entirely - nothing is scheduled.
 * The dispatch-time reap stays on either way: that one is on-demand, and its
 * alternative is abandoning the pool for a throwaway worktree.
 */
export function startPoolReaper(registry: Registry): () => void {
  const intervalMs = reapIntervalMs();
  if (intervalMs === null) return () => {};

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      for (const repoRoot of await poolRepos(registry)) {
        const { reaped } = await reapPool(repoRoot, () => poolPins(registry));
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
    if (!stopped) timer = unref(setTimeout(() => void tick(), intervalMs));
  };

  timer = unref(setTimeout(() => void tick(), intervalMs));
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

/**
 * Resolve a path to its physical form, because the two sides of `within` arrive
 * by different routes and only agree once canonicalized. A session's cwd is read
 * from the kernel (`lsof`), which always reports the physical path; a tree's path
 * is whatever `treehouse status` prints for the configured `root`. One symlink
 * anywhere on that route - `~/work` -> `/Volumes/Data/work`, a `$TMPDIR` under
 * `/private` - and the strings never match, which would silently retire the
 * liveness rung that is the one saving a just-pushed agent.
 *
 * An unresolvable path (gone, unreadable) falls back to the raw string: a failed
 * realpath must read as "compare what we have", never as "nobody is standing here".
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `PoolPins` with every path resolved once, rather than per tree. */
interface CanonicalPins {
  sessionCwds: string[];
  taskWorktrees: string[];
}

function canonicalPins(pins: PoolPins): CanonicalPins {
  return {
    sessionCwds: pins.sessionCwds.map(canonical),
    taskWorktrees: pins.taskWorktrees.map(canonical),
  };
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
 *  - a task still holds it - the harness's own record of ownership, and the only
 *    rung that survives the agent's exit: a task keeps its tree precisely so a
 *    mid-flight complete doesn't discard work, and that tree has no processes and
 *    no session left to speak for it. Reaping one both throws the work away and
 *    leaves the task pointing at a path the pool may have re-leased to someone
 *    else, whose tree its teardown would then return.
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
export async function planReap(trees: readonly PoolTree[], pins: PoolPins): Promise<ReapCandidate[]> {
  return planReapWith(trees, canonicalPins(pins));
}

async function planReapWith(
  trees: readonly PoolTree[],
  pins: CanonicalPins,
): Promise<ReapCandidate[]> {
  const out: ReapCandidate[] = [];
  for (const tree of trees) {
    out.push({ tree, skip: await verdict(tree, pins) });
  }
  return out;
}

/**
 * The rungs that need no subprocess: lease state, liveness, existence. Split out
 * so `reapPool` can tell "nothing here could possibly be reclaimed" without
 * paying for a fetch - the common case, since a healthy pool is all busy trees.
 * Returns the skip reason, or null when the tree is still a candidate.
 */
function cheapVerdict(tree: PoolTree, pins: CanonicalPins): string | null {
  if (tree.state !== "leased") return `it is ${tree.state}`;
  if (tree.busy) return "processes are still running in it";
  const root = canonical(tree.path);
  if (pins.taskWorktrees.some((wt) => within(wt, root))) return "a task still holds it";
  if (pins.sessionCwds.some((cwd) => within(cwd, root))) return "a live session is standing in it";
  if (!existsSync(tree.path)) return "the worktree is missing";
  return null;
}

async function verdict(tree: PoolTree, pins: CanonicalPins): Promise<string | null> {
  const cheap = cheapVerdict(tree, pins);
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
 * `pins` is everything the harness is already holding - live sessions' cwds and
 * task-held worktrees - so a tree it knows is in use is spared even when treehouse
 * can see no processes under it. It is read as a CALLBACK, not a snapshot: this
 * function blocks on a fetch, and only a reading taken at the reap can see a tree
 * that was claimed while we waited.
 */
export async function reapPool(
  repoRoot: string,
  pins: () => PoolPins,
  deps: PoolDeps = defaultPoolDeps,
): Promise<ReapResult> {
  const empty: ReapResult = { reaped: [], skipped: [] };
  if (!isTreehouseRepo(repoRoot)) return empty;

  const status = await deps.status(repoRoot);
  if (status.code !== 0) return empty;
  const trees = parsePoolStatus(status.stdout);
  if (trees.length === 0) return empty;

  const canon = canonicalPins(pins());
  // Nothing even plausibly idle (the healthy case: every tree busy or available)?
  // Then don't reach for the network at all - a sweep costs one `treehouse status`.
  const cheap = trees.map((tree) => ({ tree, skip: cheapVerdict(tree, canon) }));
  if (cheap.every((c) => c.skip !== null)) return { reaped: [], skipped: cheap };

  // One fetch for the whole pool: linked worktrees share the main repo's git dir,
  // so this refreshes `origin/*` for every tree at once. It's what keeps the
  // merged check honest for a branch that landed since the last sweep.
  // Best-effort - offline just leaves origin stale, which reads as "unmerged" and
  // skips. Safe.
  await git(repoRoot, ["fetch", "origin"], 30000);

  const plan = await planReapWith(trees, canon);
  const result: ReapResult = { reaped: [], skipped: plan.filter((c) => c.skip !== null) };
  const candidates = plan.filter((c) => c.skip === null).map((c) => c.tree);
  if (candidates.length === 0) return result;

  // Everything above was judged against evidence the fetch has now left up to
  // 30s stale, and `return --force` kills whatever it finds. That gap is enough
  // to lose a tree leased while we waited - by `make session`, or by a dispatch
  // that hasn't recorded its worktree yet - which at the instant we looked had no
  // processes, no session (discovery only polls every ~1.5s), and no task record,
  // and so read as a leak. Re-derive the liveness rungs against a reading taken
  // NOW, immediately before acting. The git rungs stand: work only ever appears,
  // so an older dirty/unmerged answer is the conservative one.
  const fresh = await deps.status(repoRoot);
  // Fail closed: a re-check we couldn't take is not a re-check that passed.
  if (fresh.code !== 0) {
    return {
      reaped: [],
      skipped: plan.map((c) => ({
        tree: c.tree,
        skip: c.skip ?? "its pool state could not be re-read before returning it",
      })),
    };
  }
  const now = parsePoolStatus(fresh.stdout);
  const nowPins = canonicalPins(pins());

  for (const tree of candidates) {
    // Same tree, same holder, or it is not the lease we judged: one returned and
    // re-leased in the window is someone else's now, and no rung below would
    // notice, because a just-leased tree looks exactly like a leaked one.
    const still = now.find((t) => t.path === tree.path && t.holder === tree.holder);
    const changed = still ? cheapVerdict(still, nowPins) : "its lease changed while we looked";
    if (changed) {
      result.skipped.push({ tree, skip: changed });
      continue;
    }
    const r = await deps.returnTree(repoRoot, tree.path);
    if (r.code === 0) result.reaped.push(tree);
    else result.skipped.push({ tree, skip: `treehouse return failed: ${r.stderr.trim() || "unknown"}` });
  }
  return result;
}
