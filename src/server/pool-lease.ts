import { existsSync, realpathSync } from "node:fs";
import { LEASE_HOLDER } from "../shared/harness-runtime.mjs";
import { run, type RunResult } from "./util/exec.ts";

/**
 * The one place in this process that writes a `treehouse` argv, and the mutex that keeps
 * two of them from interleaving.
 *
 * Three callers used to spell these commands independently - `provisionWorktree` /
 * `teardownWorktree` (`dispatcher.ts`), the pool reaper (`pool.ts`), and now the check
 * lease manager - and the two that existed already DISAGREED: the dispatcher returned a
 * tree with `["return", path]`, the reaper with `["return", "--force", path]`. That
 * disagreement is real and deliberate (see `TreehouseCli.return`), so this module keeps it
 * as an argument every caller must answer rather than unifying on whichever spelling it
 * read first.
 *
 * `scripts/new-session.mjs` writes the acquire argv a THIRD time and deliberately stays
 * that way: it runs under bare `node` with no build step and no bundle, so it cannot
 * import a `.ts` module. `LEASE_HOLDER` crossing that boundary through
 * `shared/harness-runtime.mjs` is the only thing the two copies can share; if you change
 * the acquire argv here, change it there too.
 *
 * ## The lock, and exactly how far it reaches
 *
 * `treehouse status` and `treehouse return` are separate processes, so "read the pool,
 * decide, then act" is not atomic - and `return` is destructive (it terminates processes
 * in the tree, then cleans and hard-resets it). `withPoolLock` serialises those sequences
 * so THIS process cannot return a tree on the strength of a status read that its own
 * concurrent return or lease has already invalidated.
 *
 * **The lock binds one process, and that residual is not papered over.** A `make session`,
 * a hand-run `treehouse get`, or a second daemon is outside it, so a status-read-then-return
 * remains non-atomic against them. What makes that survivable is holder identity, not the
 * lock: an out-of-process actor re-leasing a path takes it under `mission-control` or its own
 * label, never under `mission-control-check-<attemptId>`, so the check lease manager's
 * identity comparison fails and it refuses the return. `pool.ts` lives with the analogous
 * residual on the reaper's side and names it in the same register: *"The uncovered sliver is
 * a re-lease whose agent has yet to start a process."*
 *
 * If a future treehouse grows a holder-aware `return` (it has none today: `return [path]
 * [--force]`, and `--lease-holder` is a label it records and never checks), that residual
 * closes at the source and the identity dance in `workflows/check-lease.ts` can be replaced
 * by passing the holder to the CLI. Update this comment when it does.
 */

/**
 * Every `treehouse` invocation this process makes, as an injectable seam - so tests drive
 * the real adapter, the real lock and the real callers against a fake subprocess, without
 * needing the binary installed.
 */
export interface TreehouseCli {
  /** `treehouse status` in `repoRoot`, which is how treehouse resolves WHICH pool. */
  status(repoRoot: string): Promise<RunResult>;
  /**
   * `treehouse get --lease --lease-holder <holder>`. The holder is an argument because a
   * check lease must NOT be stamped `mission-control` - see `checkHolderToken`.
   *
   * The 180s timeout is treehouse's worst case, not ours: an empty pool creates the tree,
   * which means a fresh clone plus whatever `post_create` hook the user configured.
   */
  get(repoRoot: string, holder: string): Promise<RunResult>;
  /**
   * `treehouse return [--force] <path>`.
   *
   * `force` is a REQUIRED argument with no default, because the two spellings differ in a
   * way that is invisible at the call site and expensive to get wrong. `treehouse return
   * --help`: *"Clean, reset, and return without prompting."* Without `--force` the command
   * can PROMPT - fine for the dispatcher's ordinary teardown, which is returning a tree it
   * knows is idle and can afford to be told "no"; not fine for a poller or a reclaimer,
   * which have no stdin and would hang until their timeout and then report a failure that
   * reads like a broken pool.
   *
   * `cwd` is null for the dispatcher's teardown alone, preserving byte-for-byte what that
   * path has always done (it runs from the daemon's own cwd and lets treehouse resolve the
   * pool from the path argument). Everything else names the repository root it swept, which
   * is the same root it read `status` from.
   */
  return(opts: { cwd: string | null; path: string; force: boolean }): Promise<RunResult>;
}

/**
 * The binary, named once. Exported so a caller asking whether the pool exists at all
 * (`provisionWorktree`, before it decides between a pooled tree and a throwaway one) spells
 * it the same way the argv below does.
 */
export const TREEHOUSE_BIN = "treehouse";

export const defaultTreehouseCli: TreehouseCli = {
  status: (repoRoot) => run(TREEHOUSE_BIN, ["status"], { cwd: repoRoot, timeoutMs: 15000 }),
  get: (repoRoot, holder) =>
    run(TREEHOUSE_BIN, ["get", "--lease", "--lease-holder", holder], {
      cwd: repoRoot,
      timeoutMs: 180000,
    }),
  return: ({ cwd, path, force }) =>
    run(TREEHOUSE_BIN, ["return", ...(force ? ["--force"] : []), path], {
      ...(cwd === null ? {} : { cwd }),
      timeoutMs: 30000,
    }),
};

/**
 * Resolve a path to its physical form, because every path this subsystem compares arrives
 * by a different route and only agrees once canonicalized. A session's cwd is read from the
 * kernel (`lsof`), which always reports the physical path; a tree's path is whatever
 * `treehouse status` prints for the configured `root`; a lease path was `realpath`d when it
 * was taken. One symlink anywhere on that route - `~/work` -> `/Volumes/Data/work`, a
 * `$TMPDIR` under `/private` - and the strings never match, which would silently retire the
 * liveness rung that saves a just-pushed agent, or key two lock acquisitions for the same
 * pool onto two different queues.
 *
 * An unresolvable path (gone, unreadable) falls back to the raw string: a failed realpath
 * must read as "compare what we have", never as "nobody is standing here".
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ---- the per-repository pool lock ------------------------------------------

/**
 * One promise chain per pool, keyed by the canonical repo root. Entries are dropped when
 * their chain drains, so a daemon that swept a thousand repos does not hold a thousand
 * settled promises forever.
 */
const chains = new Map<string, Promise<void>>();

/**
 * Hold a pool exclusively for the length of `fn`, so a sequence of treehouse calls sees a
 * pool this process is not concurrently changing.
 *
 * Holding across a SEQUENCE is the entire point, not a convenience: `reapPool` re-reads
 * status immediately before each return specifically to catch a tree that came alive while
 * it waited, and if its own lease manager can slip a `get` between that re-read and the
 * `return`, the re-read proves nothing. Same for the check lease manager's
 * status → compare-identity → return.
 *
 * **Not reentrant.** A `fn` that calls `withPoolLock` again for the same repo deadlocks
 * against itself, so helpers that assume the lock is already held are named `…Locked` and
 * are never exported. A plain FIFO chain is the right shape here because the critical
 * sections are one to three subprocess calls long and contention is between a poller and an
 * occasional dispatch - fairness matters, throughput does not.
 */
export function withPoolLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalPath(repoRoot);
  const prior = chains.get(key) ?? Promise.resolve();
  const result = prior.then(fn);
  // The chain must survive `fn` rejecting: a failed return is routine (a busy tree, a
  // treehouse that exited non-zero), and one of them must not wedge the pool's queue
  // forever or spill an unhandled rejection into a waiter that never asked.
  const drained = result.then(
    () => {},
    () => {},
  );
  chains.set(key, drained);
  void drained.then(() => {
    if (chains.get(key) === drained) chains.delete(key);
  });
  return result;
}

// ---- acquire ---------------------------------------------------------------

/**
 * Why the pool didn't hand a tree over. Carried rather than collapsed to null, because the
 * three ways `get` can fail look identical to the caller and mean completely different
 * things - a dry pool is routine and reaping may fix it, a broken binary or an unreadable
 * pool never will. `stderr` is treehouse's own account: `get --help` promises stdout
 * carries the path ALONE and every banner and error goes to stderr, so it is the only
 * channel a cause we never anticipated can arrive on, and it is quoted rather than
 * interpreted.
 */
export interface LeaseFailure {
  what: string;
  stderr: string;
}

export type LeaseAttempt =
  | { path: string; failure?: undefined }
  | { path: null; failure: LeaseFailure };

/**
 * When this process last took each pool path, as a monotonic count of acquisitions.
 *
 * This exists to close a race the reaper cannot see any other way. `treehouse status` prints
 * no lease id and no timestamp, so "same path, same holder" is the whole of the identity it
 * can compare - which means a tree that was RETURNED and then FRESHLY RE-LEASED between the
 * sweep's snapshot and its per-candidate re-read reads *identical* to the stale lease the
 * sweep judged. Both hold as `mission-control`, because that is what dispatch and
 * `new-session.mjs` both stamp.
 *
 * That window is not theoretical for a dispatch: `provisionWorktree` gets its tree here, and
 * the task does not record `worktreePath` until provisioning has returned, so in between
 * there is no process, no session and no task pin. The reaper would find a tree that looks
 * exactly like the leak it planned to collect and `return --force` a checkout a dispatch is
 * about to launch an agent into.
 *
 * A counter rather than a pin, deliberately: a pin is a lifetime somebody has to remember to
 * end, and one leaked pin costs a pool slot for the life of the daemon. This is a fact about
 * the past that nobody has to clean up - the sweep asks "did I take this since I looked?",
 * which is answerable without anyone tracking when provisioning finished. Bounded by the
 * number of distinct pool paths this process has ever leased.
 */
const acquiredAt = new Map<string, number>();
let acquisitions = 0;

/**
 * The acquisition count as of now. Read by a sweep BEFORE it reads pool status, so anything
 * it takes afterwards is provably newer than the reading it is about to judge.
 */
export function leaseGeneration(): number {
  return acquisitions;
}

/** Whether this process has taken `path` since `generation`. */
export function leasedSince(path: string, generation: number): boolean {
  return (acquiredAt.get(canonicalPath(path)) ?? 0) > generation;
}

/**
 * Leases this process has taken but not yet made visible to the reaper, and when.
 *
 * The generation counter above only answers "did I take this since I looked?", which covers
 * a sweep that read the pool BEFORE the acquisition. It cannot cover a sweep that STARTS
 * afterwards: that one's generation already includes the lease, so `leasedSince` is false,
 * and the tree is still idle, still unpinned, still untracked by any task. And that sweep is
 * not hypothetical - `provisionWorktree` runs one itself whenever it finds the pool dry, so
 * a second concurrent dispatch is exactly the thing that triggers it.
 *
 * So the acquisition also has to be protected by ELAPSED OWNERSHIP, not just ordering, until
 * whoever took it has made it visible some other way (a task's `worktreePath`, or the check
 * lease manager's own pin). `settleLease` is that handover.
 *
 * The TTL is the answer to the obvious objection - that this is a lifetime someone has to
 * remember to end, and a forgotten one costs a pool slot for the life of the daemon. It
 * cannot: an entry nobody settles stops counting after the window, so the worst a missed
 * `settleLease` can do is delay a reap. The window is generous against provisioning (a reset
 * and a clean) rather than tuned, because being early here is the expensive direction.
 */
const pendingLeases = new Map<string, number>();
const PENDING_LEASE_TTL_MS = 300_000;

/** Whether this process is still wiring up its lease of `path`. */
export function leasePendingRegistration(path: string, now: number = Date.now()): boolean {
  const key = canonicalPath(path);
  const takenAt = pendingLeases.get(key);
  if (takenAt === undefined) return false;
  if (now - takenAt > PENDING_LEASE_TTL_MS) {
    pendingLeases.delete(key);
    return false;
  }
  return true;
}

/**
 * Hand a freshly acquired lease over to whatever will represent it from now on - a task's
 * recorded `worktreePath`, or the check lease manager's pin. Call it once ownership is
 * visible to the reaper, and on every path that gives the tree back instead.
 */
export function settleLease(path: string): void {
  pendingLeases.delete(canonicalPath(path));
}

/**
 * Ask a pool for a tree under `holder`. Returns its path, or the reason it got nothing
 * (which `provisionWorktree` treats as "maybe leaked", not "no pool").
 *
 * Deliberately does NOT fall back to `git worktree add`, and deliberately does not reap
 * either. Both are policy: a dispatched session can afford a cold throwaway tree, and
 * `provisionWorktree` decides to take one; a check cannot, because the pool is precisely
 * what carries the warm ignored dependencies a `clean -fd` preserves, and a three-minute
 * check that becomes a twelve-minute one is a different feature. Keeping both decisions at
 * the call sites is what lets them differ.
 */
export async function acquireLease(
  repoRoot: string,
  holder: string = LEASE_HOLDER,
  cli: TreehouseCli = defaultTreehouseCli,
): Promise<LeaseAttempt> {
  const r = await cli.get(repoRoot, holder);
  const stderr = r.stderr.trim();
  const path = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (r.code !== 0) return { path: null, failure: { what: `treehouse get exited ${r.code}`, stderr } };
  if (!path) return { path: null, failure: { what: "treehouse get printed no worktree path", stderr } };
  if (!existsSync(path)) {
    return {
      path: null,
      failure: { what: `treehouse get printed a path that does not exist: ${path}`, stderr },
    };
  }
  // Recorded HERE, in the one place every acquisition goes through, so no caller can forget
  // and no caller has to opt in. A dispatch is protected by the same line that protects a
  // check, from the instant treehouse hands the path over. The two records answer different
  // questions - ordering, and elapsed ownership - and a lease needs both until it settles.
  const key = canonicalPath(path);
  acquiredAt.set(key, ++acquisitions);
  pendingLeases.set(key, Date.now());
  return { path };
}

// ---- check holder tokens ---------------------------------------------------

/**
 * The prefix every Workflow check lease is stamped with.
 *
 * **Deliberately not a member of `LEASE_HOLDERS`, and nobody may add it.** That array is
 * the shared pool reaper's "is this lease ours to touch?" gate (`cheapVerdict`), and a
 * check lease has to answer *no*. Walk the gate against an idle check lease held as plain
 * `mission-control` and every rung passes - state `leased`, holder ours, no processes yet
 * (the command has not spawned, or is between the pin and the spawn), no task, no session -
 * so the reaper hands the tree back with `treehouse return --force`, killing the check and
 * hard-resetting the tree under it. A holder the gate does not recognise makes that
 * structurally impossible, with no new logic in the reaper at all.
 *
 * The price is that the shared reaper can never collect a LEAKED check lease either, which
 * is why `workflows/check-lease.ts` owns its own reclamation. That obligation is the direct
 * consequence of this constant; the two travel together.
 */
export const CHECK_HOLDER_PREFIX = "mission-control-check-";

/**
 * The holder for one check attempt. One function so the format and the parse below cannot
 * drift apart - the token is the only identity `treehouse status` affords us (it prints no
 * lease id and no timestamp), so a mismatch between how we write it and how we read it
 * would silently turn every identity comparison into "someone else holds this".
 */
export function checkHolderToken(attemptId: string): string {
  return `${CHECK_HOLDER_PREFIX}${attemptId}`;
}

/**
 * Whether a holder `treehouse status` reported is one of ours as a check.
 *
 * The only reader of the format, so the two sides cannot drift. Note what is deliberately
 * NOT here: a function extracting the attempt id back out of a label. Nothing needs one -
 * a lease is identified by its row, and the row carries the attempt id already - and an
 * unused parser is a second spelling of the format waiting to disagree with the first.
 */
export function isCheckHolder(holder: string | null | undefined): boolean {
  return typeof holder === "string" && holder.startsWith(CHECK_HOLDER_PREFIX);
}

// ---- the check-lease pin source -------------------------------------------

/**
 * Where `poolPins` reads `checkLeasePaths` from.
 *
 * Registered by the daemon rather than imported, so `pool.ts` - infrastructure every layer
 * uses - never has to import a Workflow module or, through it, the database. Uninstalled it
 * answers with nothing, which is exactly today's behaviour and is honest in the only two
 * situations that reach it: a test that never installed one, and a process that has not yet
 * reconciled (the daemon installs before it starts the reaper, and the ordering is asserted
 * in `index.ts`).
 *
 * A pin lost this way costs defence in depth, never the primary protection: the holder
 * token above already makes the reaper refuse a check lease outright.
 */
let checkLeasePinSource: (() => readonly string[]) | null = null;

export function installCheckLeasePins(source: (() => readonly string[]) | null): void {
  checkLeasePinSource = source;
}

export function checkLeasePaths(): readonly string[] {
  return checkLeasePinSource?.() ?? [];
}

// ---- the reaper's seam -----------------------------------------------------

/**
 * treehouse shell-outs as the reaper wants them, injectable so tests never need the binary
 * installed. Narrower than `TreehouseCli` on purpose: the reaper never leases, and it has
 * exactly one answer to the `--force` question (it is a poller with no stdin), so that
 * answer is baked in HERE, once, rather than at each of its call sites.
 */
export interface PoolDeps {
  status: (repoRoot: string) => Promise<RunResult>;
  /** `treehouse return --force <path>` - non-interactive, so it can't block a poller. */
  returnTree: (repoRoot: string, path: string) => Promise<RunResult>;
}

export const defaultPoolDeps: PoolDeps = {
  status: (repoRoot) => defaultTreehouseCli.status(repoRoot),
  returnTree: (repoRoot, path) =>
    defaultTreehouseCli.return({ cwd: repoRoot, path, force: true }),
};
