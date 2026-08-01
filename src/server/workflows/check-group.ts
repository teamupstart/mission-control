import { processStartIdentity } from "./check-identity.ts";

// Taking a check's process group down, and PROVING afterwards that it is gone.
//
// This is deliberately not a generalisation of the two `killTree` helpers that already exist
// (`claude-cli.ts`, `llm/codex.ts`). Both send `SIGKILL` immediately, with no grace period and
// no identity check, and both are correct for what they do: a model subprocess we own end to
// end, whose death costs at worst a wasted call. A check is a build that may have spawned a
// test runner that spawned a browser, in a pooled worktree somebody else is about to be handed.
// Two things follow, and neither belongs on the model-subprocess path:
//
//  - **A grace period.** `SIGTERM` first, so a test runner can flush its output and remove its
//    own temporary state, and only then `SIGKILL`.
//  - **An identity check before every signal.** The pid comes from a durable row that may have
//    been written by a previous daemon; the operating system is free to have handed that number
//    to a stranger since. Signalling on a pid alone is how a recovery pass kills somebody's
//    editor.
//
// And one thing that is not obvious until it bites: **leader exit is not emptiness.** The
// supervisor exiting says nothing about the grandchildren it left behind, and returning a
// leased tree while one of them is still writing into it corrupts the next lessee. So every
// path here ends in a positive probe of the GROUP rather than of the leader.
//
// POSIX only. `process.kill(-pid, …)` has no Windows equivalent, and `checkRuntimeSupport()`
// refuses to run checks anywhere this file could not work - so this module may assume it, and
// does.

/**
 * What we were able to PROVE about a check's process group.
 *
 *  - `empty`     - proven gone. The only answer that authorises returning the leased tree.
 *  - `not-empty` - proven still alive: our group, correct identity, still answering after the
 *                  full ladder. Keep the row and the pin.
 *  - `unknown`   - could not tell. An unreadable or mismatched identity means we may not
 *                  signal, and something is still answering on that group id. Keep the row and
 *                  the pin, which is the fail-closed direction: keeping a tree we own costs a
 *                  pool slot until the next pass, while returning one that is still being
 *                  written into costs somebody their work.
 */
export type CheckGroupEmptiness = "empty" | "not-empty" | "unknown";

/**
 * How long a group gets between `SIGTERM` and `SIGKILL`.
 *
 * The grace is the whole reason this is not the existing `killTree`, and it is sized for a
 * test runner's shutdown hook rather than for a build's runtime: long enough to flush a report
 * and unlink a temp directory, short enough that a cancelled check does not feel hung.
 */
export const CHECK_GROUP_GRACE_MS = 5_000;

/**
 * How long we keep asking after `SIGKILL` before reporting `not-empty`.
 *
 * `SIGKILL` is not instantaneous - a process blocked in an uninterruptible syscall exits when
 * that returns - and the whole point of this bound is that giving up is REPORTED rather than
 * assumed. Reaching it is not an error; it means the next reclamation pass asks again.
 */
export const CHECK_GROUP_CONFIRM_MS = 5_000;

/** How often the emptiness probe runs. Cheap - one `kill(pid, 0)` per tick. */
const POLL_MS = 100;

export interface CheckGroupTeardownOptions {
  graceMs?: number;
  confirmMs?: number;
  pollMs?: number;
}

/**
 * Whether a pid may be signalled as a process GROUP at all.
 *
 * The bound is not defensive noise. `process.kill(-0, …)` signals our OWN process group -
 * the daemon, and every session it launched - and `process.kill(-1, …)` signals every process
 * this user may signal, which on a developer's machine is every process they are running. Both
 * are reachable from a database column that holds `0` as its "nothing ever ran" sentinel, so
 * the guard is the difference between a sentinel row and a machine-wide kill.
 */
export function signallableGroup(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/**
 * Does anything still answer on this process group?
 *
 * `kill(-pid, 0)` sends nothing; it asks the kernel whether the group exists. `ESRCH` is the
 * one answer that proves emptiness. `EPERM` means the group is there and we may not signal it,
 * which is still "something is there".
 *
 * Two honest limitations, stated here because every caller inherits them.
 *
 * **A descendant that calls `setsid()` LEAVES this group**, and nothing signalled at a group
 * can reach it afterwards. Group emptiness is the contract; a deliberate daemoniser escaping
 * its group is outside what any of this can see.
 *
 * **A ZOMBIE still answers.** A dead-but-unreaped process stays in its group, so this reports
 * "something is there" for one that is provably writing nothing. That is the safe direction -
 * it delays a lease return rather than authorising one early - and in the ordinary case it
 * resolves in milliseconds, because a leader's orphans are reparented to init and reaped at
 * once. It does NOT resolve where the daemon is itself a container's pid 1, since a process
 * that adopts orphans has to reap them and Node only reaps children it started. Measured, not
 * assumed: this suite's Linux run reports `not-empty` forever as a bare container entrypoint
 * and `empty` under `docker run --init`. A daemon deployed as pid 1 wants an init that reaps.
 */
export function checkGroupAnswers(pid: number): boolean {
  if (!signallableGroup(pid)) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH here means the group went away between the probe and the signal, which is the
    // outcome we were aiming for. Anything else is re-answered by the probe below rather
    // than guessed at from an errno.
  }
}

/**
 * Deliberately NOT `unref`'d, unlike the command timeout that calls into here.
 *
 * A promise is waiting on this timer, so unreffing it lets the event loop drain while an
 * `await` is still outstanding - which is exactly what happened the first time: the group died,
 * every child handle closed, and the emptiness proof was left suspended on a timer that could
 * no longer keep the process alive. The wait is bounded by `confirmMs`, so what this holds open
 * is a few seconds of proving a tree is safe to hand back.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForEmpty(pid: number, budgetMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!checkGroupAnswers(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Take a check's process group down and report what could be proven about it.
 *
 * The one function used by live cancellation, by a timeout, by daemon shutdown and by startup
 * recovery, because all four have to obey the same rule and a second implementation is how one
 * of them stops obeying it.
 *
 * The ladder:
 *
 *  1. A sentinel pid means the gate was never released - no branch code ever ran, so there is
 *     nothing to signal and nothing to prove. `empty`.
 *  2. Read the identity again. **A mismatch, or an unreadable identity, is NEVER signalled.**
 *     But it is still probed: an identity we cannot confirm says nothing about the group, and
 *     `ESRCH` on the group id proves emptiness on its own, without a signal being sent.
 *     That distinction is what lets a daemon that crashed after its checks finished hand
 *     their trees back instead of stranding a pool slot per crash.
 *
 *     The consequence worth knowing, because it decides how a stuck lease eventually clears:
 *     once the LEADER is gone, its identity is unreadable, so a group that still has surviving
 *     descendants can never be signalled again by a later pass - it answers `unknown` until
 *     those descendants exit on their own, and only then does a pass prove it `empty`. That is
 *     the fail-closed direction (the lease is held, never wrongly returned) and it is
 *     self-healing rather than permanent. It is also rare by construction: the ladder below
 *     `SIGKILL`s the whole group while the leader is still identifiable, so reaching this state
 *     needs a descendant that outlives `SIGKILL` or has left the group. Asserted in
 *     `test/workflow-check-supervisor.test.ts`.
 *  3. A match is signalled: `SIGTERM`, a bounded grace, then `SIGKILL`.
 *  4. Then prove it. Poll the group, bounded, and report what the probe actually said.
 *
 * Step 3's escalation does not re-read the identity, and that is deliberate rather than
 * sloppy: the leader may legitimately have exited during the grace while a descendant lives
 * on, which makes the identity unreadable on a group we have already positively identified
 * within this call. Both kernels refuse to reuse a pid while a process group still bears it,
 * so the group id we verified at step 2 still names our group for as long as it answers.
 */
export async function terminateCheckGroup(
  pid: number,
  expectedIdentity: string,
  options: CheckGroupTeardownOptions = {},
): Promise<CheckGroupEmptiness> {
  const graceMs = options.graceMs ?? CHECK_GROUP_GRACE_MS;
  const confirmMs = options.confirmMs ?? CHECK_GROUP_CONFIRM_MS;
  const pollMs = options.pollMs ?? POLL_MS;

  if (!signallableGroup(pid) || expectedIdentity === "") return "empty";

  if (processStartIdentity(pid) !== expectedIdentity) {
    return checkGroupAnswers(pid) ? "unknown" : "empty";
  }
  // Already finished, and nothing left behind: the common case for a check that exited on its
  // own. Probing before signalling keeps a clean run from sending signals nobody needed.
  if (!checkGroupAnswers(pid)) return "empty";

  signalGroup(pid, "SIGTERM");
  if (await waitForEmpty(pid, graceMs, pollMs)) return "empty";
  signalGroup(pid, "SIGKILL");
  if (await waitForEmpty(pid, confirmMs, pollMs)) return "empty";
  return "not-empty";
}

/**
 * Groups this process started and has not yet confirmed empty, so a hard daemon exit still
 * signals them.
 *
 * The shape is `claude-cli.ts`'s - a module-level set plus one `exit` hook registered once -
 * because that shape is right. The POLICY is this module's, and it differs in the one way that
 * matters: the hook verifies identity before it signals.
 */
const live = new Map<number, string>();

/** Remember a live group. Called by the spawn adapter the moment identity is known. */
export function watchCheckGroup(pid: number, identity: string): void {
  if (!signallableGroup(pid) || identity === "") return;
  live.set(pid, identity);
  hookExitOnce();
}

/** Forget a group, once its emptiness has been decided one way or the other. */
export function unwatchCheckGroup(pid: number): void {
  live.delete(pid);
}

/** Test-only: how many groups the exit hook would currently try to signal. */
export function liveCheckGroupCount(): number {
  return live.size;
}

/**
 * The ORDERLY counterpart to `killLiveCheckGroups`, for a shutdown that can still await.
 *
 * `WorkflowEngine.stop()` awaits every in-flight attempt, and a check attempt is a build that
 * may have minutes of its timeout left - so without this a daemon restart waits out somebody's
 * test suite. Cancelling first turns that into the seconds the ladder actually needs.
 *
 * It gets the full ladder rather than the exit hook's bare `SIGKILL` precisely because there
 * IS time here: a test runner gets its grace to flush and unlink, and the group is then proven
 * empty, which is what authorises the leased worktree going back to the pool on the way out.
 * Groups are torn down concurrently, so shutdown costs one ladder rather than one per check.
 *
 * A group this cannot prove empty stays watched, for the same reason `finish()` keeps one: the
 * hard-exit hook is the last thing that will ever see it, and it re-verifies identity before
 * signalling anything.
 */
export async function terminateLiveCheckGroups(
  options: CheckGroupTeardownOptions = {},
): Promise<void> {
  await Promise.all(
    [...live].map(async ([pid, identity]) => {
      if ((await terminateCheckGroup(pid, identity, options)) === "empty") live.delete(pid);
    }),
  );
}

/**
 * The last-resort teardown, on daemon exit.
 *
 * `SIGKILL` with no grace, and that is not this module forgetting its own rule: an `exit`
 * handler cannot await anything, so there is no grace period available to give. The ORDERLY
 * path - a timeout, a cancellation, `WorkflowEngine.stop()` - goes through
 * `terminateCheckGroup` and gets the full ladder. This is what runs when the daemon is already
 * on its way out, and a check's build outliving the daemon that started it, writing into a
 * pooled tree nobody is tracking any more, is worse than a build that loses its chance to
 * flush.
 *
 * The identity check is NOT dropped, though. Whatever else is true on the way out, we do not
 * signal a stranger.
 *
 * ## What this depends on, stated because it is somebody else's decision
 *
 * `process.on("exit")` does NOT run when a signal terminates a process by default, so this hook
 * is only reached because `src/server/index.ts` registers handlers for `SIGINT` and `SIGTERM`
 * that run `shutdown()`, which ends at `process.exit(0)`. That turns a service stop into an
 * ordinary exit, and an ordinary exit fires this. Measured both ways in
 * `test/workflow-check-supervisor.test.ts`: with the daemon's shape the group dies, and with
 * Node's default signal handling it survives.
 *
 * Deliberately NOT fixed here by registering our own signal handlers. A second `SIGTERM`
 * listener calling `process.exit` would race the daemon's orderly shutdown and truncate it -
 * skipping `sdkSessions.stopAll()` and `workflows.stop()`, cutting embedded sessions off
 * mid-turn - which trades a hypothetical leak for a certain one. The daemon owns its shutdown
 * sequence; this module owns being reachable from it.
 *
 * `SIGKILL` of the daemon defeats every version of this, which is exactly why the durable row
 * and identity-verified startup recovery exist.
 */
export function killLiveCheckGroups(): void {
  for (const [pid, identity] of live) {
    if (processStartIdentity(pid) === identity) signalGroup(pid, "SIGKILL");
  }
  live.clear();
}

let exitHooked = false;
function hookExitOnce(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", killLiveCheckGroups);
}
