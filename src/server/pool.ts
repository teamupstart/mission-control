import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { LEASE_HOLDER, LEASE_HOLDERS } from "../shared/harness-runtime.mjs";
import { remoteDefaultRef } from "./actions.ts";
import { envVar } from "./config.ts";
import {
  canonicalPath,
  checkLeasePaths,
  defaultPoolDeps,
  leaseGeneration,
  leasedSince,
  leasePendingRegistration,
  TREEHOUSE_BIN,
  withPoolLock,
  type PoolDeps,
} from "./pool-lease.ts";
import type { Registry } from "./registry.ts";
import { listRepos } from "./repos.ts";
import { hasBin, run, type RunResult } from "./util/exec.ts";
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
 * then falls back to a throwaway `git worktree`, so the pool's whole point
 * (pre-warmed, reused trees) is lost. That fallback now warns rather than passing
 * silently - which is how the leak stayed invisible long enough to fill a pool -
 * but a warning only reports the leak; this module is what collects it.
 *
 * treehouse's own `prune` can't fix this: it skips any tree with an owner
 * reservation, and a leaked lease IS a reservation. So the harness collects its
 * own leases - and ONLY its own, which is a rule we impose on ourselves rather
 * than one treehouse enforces: `return` takes a path and no holder, and
 * `--lease-holder` is a label treehouse records and never checks. The rule exists
 * because a lease means something. treehouse's contract is that one survives "even
 * with no process running inside it, until you release it", so an idle lease is a
 * deliberate reservation, not litter, and someone may be relying on finding their
 * tree tomorrow. Reaping a `mission-control` lease is defensible only because this
 * harness is what took it and can tell when its holder is gone; it can say nothing
 * about anyone else's - which is what makes the rung load-bearing now that the
 * sweep reaches every pool under the workspace, not just the ones we dispatch into.
 *
 * `treehouse return` is destructive - it terminates processes in the tree, then
 * cleans and resets it - so a wrong reap kills a live agent AND discards its
 * work. Every check in `planReap` exists to make that impossible; see the gate
 * there for what each one is actually protecting against.
 */

/**
 * The holder this harness records on every lease it takes, alongside `LEASE_HOLDERS` -
 * every name it has ever stamped, which is what the gate below actually matches, since
 * a lease keeps its original holder forever. Defined on the shared runtime surface rather than here
 * beside the policy that reads it, because the third site that has to agree -
 * `scripts/new-session.mjs`, which is what takes the leases that actually leak -
 * runs under bare `node` with no build step, so the only definition all three can
 * share is one that crosses that boundary. Re-exported so the rung below and the
 * dispatcher's `--lease-holder` keep reading it from one place; see the constant
 * itself for why drift here is silent in both directions.
 */
export { LEASE_HOLDER, LEASE_HOLDERS };

/** A worktree in the pool, as `treehouse status` reports it. */
export interface PoolTree {
  /** The pool slot's name ("1", "2", …), for logs. */
  name: string;
  /**
   * Every state treehouse's listing can print, read off the binary rather than off
   * the states a pool happened to be in: `internal/pool.List.func1` renders exactly
   * these five. Worth keeping exhaustive - a state missing from here doesn't fail
   * loudly, it just stops parsing, and the slot vanishes from the reap plan
   * entirely (neither reaped nor `skipped`, so nothing reports it).
   *
   * `you're here` is the odd one: it isn't a property of the tree at all, but of
   * whoever ran `status` - treehouse stamps it on the tree the CALLER is standing
   * in, masking that tree's real state. Unreachable for the sweep in practice,
   * which always asks from a main repo root, never from inside a pooled tree.
   */
  state: "leased" | "in-use" | "available" | "dirty" | "you're here";
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

/**
 * treehouse shell-outs, injectable so tests never need the binary installed.
 *
 * Re-exported rather than defined here: every `treehouse` argv this process writes lives in
 * `pool-lease.ts`, beside the mutex that serialises them and the holder tokens that decide
 * which of them are ours. Importers keep reading it from the reaper, which is where it is
 * used.
 */
export { defaultPoolDeps, type PoolDeps };

/** How often the daemon sweeps known pools for leaked leases, absent an override. */
const DEFAULT_REAP_MS = 300_000;

/**
 * The floor under a configured sweep interval. A sweep shells out to `treehouse
 * status` per pool and can reach the network, so a fat-fingered
 * `MISSION_POOL_REAP_MS=5` would hammer treehouse and origin forever. Nobody wants
 * a five-millisecond leak collector; clamp rather than obey.
 */
const MIN_REAP_MS = 30_000;

/**
 * The ceiling, which guards the SAME hot loop as the floor, reached from the far
 * end: `setTimeout`'s delay is a 32-bit signed int, so anything past 2^31-1 ms
 * (~24.8 days) silently becomes a 1ms tick rather than a long wait. Someone
 * disabling the sweep with `MISSION_POOL_REAP_MS=99999999999` would get the
 * busiest reaper possible.
 *
 * This exists ONLY to stay clear of that overflow, not to have an opinion about
 * cadence: a week is a deliberate interval and gets honored, so every realistic
 * value passes through untouched and only a nonsense one clamps. `0` stays the
 * one real off switch.
 */
const MAX_REAP_MS = 604_800_000;

/**
 * The sweep interval, or null when the sweep is switched OFF.
 *
 * `MISSION_POOL_REAP_MS=0` is how anyone would try to disable a periodic job, and
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
  return Math.min(Math.max(ms, MIN_REAP_MS), MAX_REAP_MS);
}

/** A repo opts into the pool by committing a `treehouse.toml` at its root. */
export function isTreehouseRepo(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "treehouse.toml"));
}

/**
 * Whether the pool binary is resolvable at all.
 *
 * **The half that was missing on the check path, and the only half a check asks.** It takes
 * no repository argument, and that is the point rather than an omission: a check must keep
 * working in a repository that never committed a `treehouse.toml`. `treehouse get` succeeds
 * there today, creating a pool from its own defaults, so folding `isTreehouseRepo` in here
 * would stop every such repository getting a pooled tree for its checks - a real behaviour
 * change wearing a bug fix's clothes, and one that silently answers a design question
 * (what counts as opting in?) that is deliberately filed separately.
 *
 * So this is named on its own rather than existing only inside the conjunction below. If a
 * later reader "tidies" the check call site into `poolAvailableFor`, they ship that deferred
 * decision by accident - which is the reason both predicates are spelled out here, together,
 * where the difference between them is readable in one screen.
 */
export async function treehouseInstalled(): Promise<boolean> {
  return hasBin(TREEHOUSE_BIN);
}

/**
 * The full dispatch gate: the binary is there AND this repository opted in.
 *
 * `provisionWorktree`'s question, and it used to be spelled inline at its one call site -
 * which is how the check path came to have no gate at all. Both halves live in this module
 * now, beside the opt-in predicate they are built from, so the next subsystem that wants a
 * worktree finds the question already answered instead of making the same omission a third
 * time.
 */
export async function poolAvailableFor(repoRoot: string): Promise<boolean> {
  return (await treehouseInstalled()) && isTreehouseRepo(repoRoot);
}

/**
 * Everything the harness itself is holding, so a reap can't pull a tree out from
 * under its own work. Three separate claims, because they miss different things:
 *
 *  - `sessionCwds` - where live agents are actually standing. Independent of the
 *    process list treehouse reports; either view seeing a session spares its tree.
 *  - `taskWorktrees` - worktrees still recorded on a task. A task deliberately
 *    KEEPS its tree after its agent exits (a mid-flight complete must not discard
 *    work; a failed-but-alive task still holds its checkout), and such a tree is
 *    exactly what the git gate green-lights: idle, clean, and merged if the agent
 *    pushed. Sessions alone cannot see it, because there is no session left.
 *  - `checkLeasePaths` - trees a Workflow check is holding. A check has no session
 *    and no task: it is a build running in a leased tree, and between the lease and
 *    the spawn it has no processes either, so all three rungs above read "idle" on a
 *    tree that is about to be written into.
 *
 * `checkLeasePaths` is DEFENCE IN DEPTH and its redundancy is the point, so do not
 * delete it as duplicated work. The reaper already refuses a check lease on the rung
 * above these, because a check is held under `mission-control-check-<attemptId>` and
 * that is not in `LEASE_HOLDERS`. The two protections fail differently: the holder is
 * a STRING, and a rename, a legacy row, or a future caller widening `LEASE_HOLDERS`
 * breaks it silently; the pin is a PATH this process knows it is holding right now,
 * and it survives all three. Neither alone is worth a hard-reset of a tree with a
 * running build in it.
 */
export interface PoolPins {
  sessionCwds: readonly string[];
  taskWorktrees: readonly string[];
  /**
   * Required, with no `?` and no `?? []` anywhere downstream: this is a
   * `readonly string[]`, so every constructor of a `PoolPins` has to say what it means,
   * and a test that has not thought about check leases fails to compile rather than
   * quietly disarming a rung.
   */
  checkLeasePaths: readonly string[];
}

/** The working dirs of every live agent. */
export function occupiedCwds(registry: Registry): string[] {
  return registry
    .liveSessions()
    .map((s) => s.cwd)
    .filter((cwd): cwd is string => cwd !== null);
}

/**
 * Everything a reap must leave alone; pass to `reapPool`/`planReap`.
 *
 * The check-lease half comes from a source the daemon installs (`installCheckLeasePins`)
 * rather than an import, so this module - which every layer above it uses - never pulls in
 * a Workflow module or the database. Nothing installed means no check leases, which is the
 * truthful answer for a process that has none.
 */
export function poolPins(registry: Registry): PoolPins {
  return {
    sessionCwds: occupiedCwds(registry),
    // EVERY worktree a task holds, not just its primary. A multi-repo task's secondary
    // trees are provisioned by the same dispatcher, leased from the same pools, and worked
    // in by the same live agent - and the reaper spares only what is pinned, so a secondary
    // missing from this list is a tree that can be `reset --hard` and returned to its pool
    // underneath an agent that is writing to it. That is why the pins and the provisioning
    // are one change: shipping the loop without this line is destructive, not incomplete.
    taskWorktrees: registry
      .listTasks()
      .flatMap((t) => [t.worktreePath, ...t.extraRepos.map((entry) => entry.worktreePath)])
      .filter((p): p is string => p !== null && p !== undefined),
    checkLeasePaths: checkLeasePaths(),
  };
}

/**
 * The pools worth sweeping, from three sources that each name what the others
 * miss, keeping only the repos that opted into treehouse:
 *
 *  - live sessions - where agents actually are.
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
 * All three are path-shaped, and every one gets walked back to its main root,
 * because treehouse keys a pool off the OWNING repo while all three routinely name
 * something else: a session standing in a POOLED tree reports that TREE as its cwd;
 * the scan collects linked worktrees as readily as clones (it matches a `.git`
 * ENTRY, dir or file alike, and `treehouse.toml` is committed, so a plain `git
 * worktree add` under the workspace is indistinguishable from a pool owner); and a
 * task's `repoRoot` is `git rev-parse --show-toplevel`, which inside a linked
 * worktree is that worktree. The walk-back is what turns any of them into a pool we
 * can actually sweep, and it is what makes the dedupe real.
 *
 * The cost of skipping it is small but not nothing: treehouse resolves its pool the
 * same `--show-toplevel` way, so an unwalked checkout names a DIFFERENT, empty pool
 * that `reapPool` early-returns on before it fetches - one wasted `treehouse status`
 * per checkout per tick, against an owner already in the set. A path we can't walk
 * back names no pool at all, so it is dropped rather than guessed at.
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
  for (const task of registry.listTasks()) {
    // Every repo the task dispatched into, so a secondary repo's pool is swept on the same
    // terms as the primary's - it leaks leases the same way, from the same dispatcher.
    for (const repoRoot of [task.repoRoot, ...task.extraRepos.map((e) => e.repoRoot)]) {
      const root = mainRepoRoot(repoRoot);
      if (root) roots.add(root);
    }
  }
  for (const repo of await listRepos().catch(() => [])) {
    const root = mainRepoRoot(repo);
    if (root) roots.add(root);
  }
  return [...roots].filter(isTreehouseRepo);
}

/**
 * Work that rides the sweep's timer without being the sweep's business.
 *
 * `reclaimLeases` is the check lease manager's own collection pass. It gets a seat on this
 * tick rather than a timer of its own because it wants the same cadence and the same lock,
 * and one pool-facing schedule is easier to reason about than two - but it stays the
 * caller's logic, injected here, never a fourth rung inside `cheapVerdict`. The reaper
 * decides nothing about check leases; it cannot even see them.
 *
 * The consequence of sharing the timer is stated rather than hidden: `MISSION_POOL_REAP_MS=0`
 * switches this off too. That is coherent - both are leak collectors, and an operator who
 * turned leak collection off gets what they asked for - and it costs nothing while a check
 * is running, because a live lease is not a leak. Startup reconciliation is unconditional
 * either way.
 */
export interface PoolReapHooks {
  reclaimLeases?: () => Promise<void>;
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
 * `MISSION_POOL_REAP_MS=0` switches the sweep off entirely - nothing is scheduled.
 * The dispatch-time reap stays on either way: that one is on-demand, and its
 * alternative is abandoning the pool for a throwaway worktree.
 */
export function startPoolReaper(registry: Registry, hooks: PoolReapHooks = {}): () => void {
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
            `[mission-control] returned ${reaped.length} leaked lease(s) to the pool in ` +
              `${repoRoot}: ${reaped.map((t) => t.name).join(", ")}`,
          );
        }
      }
      // The leases this sweep is structurally blind to, collected by whoever owns them.
      // After the sweep, so a tree a check hands back here is available to the next one
      // rather than waiting a full interval.
      await hooks.reclaimLeases?.();
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
 * by INDENTED lines listing the processes running under the tree above them:
 *
 *   1     leased       ~/.treehouse/repo-abc/1/repo  (held by mission-control)
 *   8     leased       ~/.treehouse/repo-abc/8/repo  (held by mission-control)
 *                      claude (74975), node (75244)
 *   13    dirty        ~/.treehouse/repo-abc/13/repo
 *   15    in-use       ~/.treehouse/repo-abc/15/repo
 *
 * The process list is what makes `busy` trustworthy: `leased` alone says nothing
 * about liveness (a dead agent's tree stays `leased` forever - that's the leak),
 * so we take treehouse's own view of what's running rather than re-deriving it.
 *
 * A line we can't read (a banner like "Shell cwd was reset to …", or a state
 * treehouse grows later) is skipped AND closes the tree above it, so an indented
 * list can only ever mark the tree it actually belongs to. Letting it bind to the
 * last tree we happened to parse would pin `busy` on an unrelated slot several
 * lines up and report it as "processes are still running in it" - a false reason
 * on a real decision. Dropping those processes instead costs nothing: they belong
 * to a tree we failed to parse, and a tree we can't parse is never a candidate.
 */
export function parsePoolStatus(stdout: string): PoolTree[] {
  const trees: PoolTree[] = [];
  const line =
    /^(\S+)[ \t]+(leased|in-use|available|dirty|you're here)[ \t]+(\S+)(?:[ \t]+\(held by (.+?)\))?[ \t]*$/;
  // The tree an indented process list would belong to, or null when the last line
  // left us somewhere we don't understand.
  let current: PoolTree | null = null;
  for (const raw of stdout.split("\n")) {
    // Blank lines are layout, not content: they say nothing about whose processes
    // follow, so they leave `current` alone. Forgetting the tree here would be the
    // one unsafe direction - a dropped process list reads as "not busy", which is
    // the reading a reap acts on.
    if (!raw.trim()) continue;
    // Indented => a process list belonging to the tree above it.
    if (/^\s/.test(raw)) {
      if (current) current.busy = true;
      continue;
    }
    const m = line.exec(raw);
    if (!m) {
      current = null;
      continue;
    }
    current = {
      name: m[1]!,
      state: m[2] as PoolTree["state"],
      path: expandHome(m[3]!),
      holder: m[4] ?? null,
      busy: false,
    };
    trees.push(current);
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
 * by different routes and only agree once canonicalized. Defined in `pool-lease.ts`,
 * which needs the same resolution to key its mutex; see the reasoning there.
 */
const canonical = canonicalPath;

/** `PoolPins` with every path resolved once, rather than per tree. */
interface CanonicalPins {
  sessionCwds: string[];
  taskWorktrees: string[];
  checkLeasePaths: string[];
}

function canonicalPins(pins: PoolPins): CanonicalPins {
  return {
    sessionCwds: pins.sessionCwds.map(canonical),
    taskWorktrees: pins.taskWorktrees.map(canonical),
    checkLeasePaths: pins.checkLeasePaths.map(canonical),
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
 *  - not `leased`      - `available` needs nothing; `in-use` is live by definition;
 *    `dirty` treehouse already counts as unavailable; `you're here` describes the
 *    caller, not the tree.
 *  - not recorded under one of OUR labels - the standing rung, and the only one about
 *    ownership rather than liveness: an idle lease is a deliberate reservation, so
 *    being idle is what a reservation LOOKS like, not proof of a leak. We can only
 *    claim to know a holder is gone for the leases we took ourselves. "Ours" is every
 *    name this app has ever stamped (`LEASE_HOLDERS`: mission-control, fleet-control,
 *    ai-harness), not just the current one: a lease records its holder forever and is
 *    never restamped, so matching the current name alone silently stranded every lease
 *    taken before a rename - the leaks the sweep exists to collect. A former name only
 *    clears THIS rung; busy/dirty/unmerged/pinned still decide. A stranger's lease is
 *    still refused. Self-imposed either way - see the module docstring; treehouse's own
 *    `return` verifies no holder at all.
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
 * Why a tree in each non-`leased` state is not ours to hand back. Spelled out per
 * state rather than interpolated, because `skipped` is the only account this module
 * gives of what it decided, and "it is you're here" explains nothing to the person
 * reading it. Exhaustive by type: a state added to `PoolTree` doesn't compile until
 * it says why it is being declined.
 */
const NOT_LEASED: Record<Exclude<PoolTree["state"], "leased">, string> = {
  available: "it is available",
  "in-use": "it is in-use",
  // Nothing to collect: treehouse already counts a dirty tree as unavailable, and
  // the git rung would refuse it anyway. Named here so it lands in the plan rather
  // than disappearing from it.
  dirty: "it is dirty",
  "you're here": "treehouse reports the status caller standing in it",
};

/**
 * The rungs that need no subprocess: lease state, liveness, existence. Split out
 * so `reapPool` can tell "nothing here could possibly be reclaimed" without
 * paying for a fetch - the common case, since a healthy pool is all busy trees.
 * Returns the skip reason, or null when the tree is still a candidate.
 */
function cheapVerdict(tree: PoolTree, pins: CanonicalPins): string | null {
  if (tree.state !== "leased") return NOT_LEASED[tree.state];
  // Standing, asked before liveness: is this lease ours to touch at all? An idle
  // lease is a reservation someone made on purpose (treehouse keeps one "even with
  // no process running inside it, until you release it"), so "nothing is running in
  // it" is not evidence of a leak - it is what a reservation looks like. What makes
  // OUR idle leases collectable is that we took them and can see their holders are
  // gone; that argument doesn't extend to a stranger's, and the sweep now walks
  // every pool under the workspace, most of which we have no relationship with.
  // Both harness lease paths record this label, so the leak we exist for is still
  // fully covered. An unrecorded holder is not proof of ownership, so it skips like
  // every other uncertainty here.
  //
  // Matched against EVERY name this app has stamped, not just the current one. A lease
  // records its holder forever and is never restamped, so a gate that knew only the
  // current name would refuse every lease taken before a rename - silently, permanently,
  // and precisely for the leases the sweep exists to collect. That is not theoretical:
  // this comment used to explain that leases reading `ai-harness` predated a rename and
  // were "left for a manual `treehouse return`", and one such worktree is still sitting
  // in the pool uncollected. The `mission-control` rename would have stranded six more.
  // These names were all us, so answering the gate's real question - did WE take it? -
  // means asking about all of them. A stranger's lease is still refused.
  if (!LEASE_HOLDERS.includes(tree.holder ?? "")) {
    return tree.holder
      ? `it is leased to ${tree.holder}; we only return our own leases (${LEASE_HOLDERS.join(", ")})`
      : "its lease records no holder";
  }
  if (tree.busy) return "processes are still running in it";
  const root = canonical(tree.path);
  if (pins.taskWorktrees.some((wt) => within(wt, root))) return "a task still holds it";
  if (pins.sessionCwds.some((cwd) => within(cwd, root))) return "a live session is standing in it";
  // A Workflow check's lease. Unreachable in practice - a check holds its tree under a
  // token no rung above recognises, so the holder rung already refused it - and that is
  // exactly why this one is here rather than deleted as dead code. It is the rung that
  // still stands if the token scheme is renamed, if a legacy row reads `mission-control`,
  // or if someone appends the check token to `LEASE_HOLDERS` (which nobody may do). The
  // failure it prevents is a forced return under a running build: processes killed,
  // tree hard-reset, and a check that reports infrastructure noise instead of a verdict.
  if (pins.checkLeasePaths.some((lease) => within(lease, root))) return "a check is running in it";
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
 * function blocks on a fetch and then on every return before a given candidate's,
 * and only a reading taken at that candidate's own reap can see a tree that was
 * claimed while we waited.
 */
export async function reapPool(
  repoRoot: string,
  pins: () => PoolPins,
  deps: PoolDeps = defaultPoolDeps,
): Promise<ReapResult> {
  const empty: ReapResult = { reaped: [], skipped: [] };
  if (!isTreehouseRepo(repoRoot)) return empty;

  // Read BEFORE the status below, so "this process leased that tree after we looked" is
  // answerable at the moment of each return. See `returnIfStillIdle`.
  const generation = leaseGeneration();
  const status = await withPoolLock(repoRoot, () => deps.status(repoRoot));
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
  // NOW, immediately before acting.
  //
  // Per candidate, not once for the batch: a `return --force` is itself allowed
  // 30s, so on a pool with ten leaks to collect the last one would act on a
  // reading taken nine forced returns ago - minutes in which the user can walk
  // into any tree still on the list and start an agent in it. Freshness only
  // means anything if it holds at the moment of each return.
  //
  // The git rungs are deliberately NOT re-read, and that is a tradeoff rather
  // than a free pass. Staleness is only conservative in the skip direction - a
  // tree already judged dirty or unmerged stays skipped, since work only ever
  // appears. A reap acts on the other direction: a stale CLEAN reading, and
  // `return --force` would clean away anything written since. Be honest about how
  // stale: `planReapWith` runs ONCE above, so the last candidate's clean/merged
  // answer predates the fetch AND every forced return before it - the same
  // minutes the paragraph above describes, not the fetch's 30s. What makes that
  // acceptable is that dirtying a tree takes a WRITER, and no writer gets in
  // without a process, a session, or a task record - every one of which IS re-read
  // below, per candidate, fresh.
  //
  // The re-read and the return it authorises happen inside ONE acquisition of this
  // pool's lock. Splitting them would leave the re-read proving nothing about the
  // moment that matters: this process's own lease manager could take the very tree we
  // just re-read as free and be pinning it while we shell out to return it. The lock
  // does not reach another process (see `pool-lease.ts`), which is why the holder rung
  // above and not the lock is what keeps a stranger's lease safe - but it does close
  // the window against ourselves, which is the one we can close.
  for (const tree of candidates) {
    const outcome = await withPoolLock(repoRoot, () =>
      returnIfStillIdle(repoRoot, tree, pins, deps, generation));
    if (outcome === null) result.reaped.push(tree);
    else result.skipped.push({ tree, skip: outcome });
  }
  return result;
}

/**
 * Re-derive the liveness rungs against a reading taken NOW and, if they still pass, hand
 * the tree back. Returns null when it was reaped, or the reason it was spared.
 *
 * Callers must already hold this repo's pool lock - the freshness of the re-read is only
 * worth anything for as long as nothing else in this process can act between it and the
 * return below.
 */
async function returnIfStillIdle(
  repoRoot: string,
  tree: PoolTree,
  pins: () => PoolPins,
  deps: PoolDeps,
  /** The acquisition count read before the status this candidate was judged against. */
  generation: number,
): Promise<string | null> {
  const fresh = await deps.status(repoRoot);
  // Fail closed, and only for this tree: a re-check we couldn't take is not a
  // re-check that passed, but one unreadable moment is no reason to strand the
  // rest of the pool until the next sweep.
  if (fresh.code !== 0) return "its pool state could not be re-read before returning it";
  const now = parsePoolStatus(fresh.stdout);
  const nowPins = canonicalPins(pins());
  // Re-confirm the slot is still leased and still looks like the lease we
  // judged. Same path, same holder is ALL the identity `treehouse status`
  // affords - it prints no lease id and no timestamp - so be clear about what
  // this cannot do: a return plus a re-lease inside the window reads identical
  // to an untouched lease, since both lease paths hold as `mission-control`
  // (the dispatcher's `--lease-holder`, and new-session.mjs's default). That
  // window is covered instead by the rung below, re-derived from the fresh
  // status: a re-leased tree with an agent running in it reads busy. The
  // uncovered sliver is a re-lease whose agent has yet to start a process.
  const still = now.find((t) => t.path === tree.path && t.holder === tree.holder);
  const changed = still ? cheapVerdict(still, nowPins) : "its lease changed while we looked";
  if (changed) return changed;
  // That sliver, closed for the half of it we can actually see. A dispatch takes its tree
  // and does not record `worktreePath` on the task until provisioning returns, so for the
  // whole of that window it has no process, no session and no task pin - and because it
  // stamps the same `mission-control` holder, the re-read above cannot tell it apart from
  // the stale lease this sweep planned to collect. Force-returning it would clean and reset
  // a checkout an agent is about to be launched into. The lease ledger answers the one
  // question status cannot: did WE take this tree after we looked?
  //
  // Only the in-process half. A `make session` or a hand-run `treehouse get` is still
  // outside this, and stays the documented residual - see `pool-lease.ts`.
  if (leasedSince(tree.path, generation)) return "this process re-leased it while we looked";
  // And the same window seen from a sweep that STARTED inside it, where the check above is
  // no help: this sweep's generation already includes the acquisition, so ordering says
  // nothing. `provisionWorktree` runs exactly such a sweep whenever it finds the pool dry,
  // which makes a second concurrent dispatch the trigger. Elapsed ownership is what answers
  // it - the lease is spared until its taker has made it visible some other way.
  if (leasePendingRegistration(tree.path)) return "this process is still provisioning it";
  const r = await deps.returnTree(repoRoot, tree.path);
  if (r.code === 0) return null;
  return `treehouse return failed: ${r.stderr.trim() || "unknown"}`;
}
