import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readToken } from "../../shared/harness-runtime.mjs";
import type { CheckExecutionResult } from "./checks.ts";
import { scrubCheckEnv } from "./check-env.ts";
import { checkRuntimeSupport } from "./check-identity.ts";
import {
  terminateCheckGroup,
  unwatchCheckGroup,
  type CheckGroupTeardownOptions,
} from "./check-group.ts";
import { spawnCheckProcess, type CheckSpawnOutcome } from "./check-spawn.ts";
import type { CheckGroupRecovery, CheckProcessRegistry } from "./check-lease.ts";

// The composition: a platform preflight, a scrubbed environment, a leased directory, and the
// gate that persists a supervisor's identity before branch code is permitted to run.
//
// ## Nothing calls this yet, and that is the intended shape
//
// Its ONE consumer is the check executor, which composes this with the lease manager and is a
// separate change. Until then `CheckRunDeps.execute` stays null and a configured check reports
// `unavailable` and passes - the same honest degradation the check node shipped with, rather
// than a half-wired path that runs builds nobody asked for. What this file adds is a runtime
// that is fully tested against real processes before anything depends on it.
//
// ## What this is not
//
// **Not a sandbox.** `scrubCheckEnv` removes the daemon's admission credential and the
// variables that locate it; the command still runs with the daemon's own filesystem authority.
// Anything that describes this as isolation is describing something that is not here.
//
// **Not a shell.** An argv, always, spawned with `shell: false`. That removes shell injection
// as a CATEGORY rather than mitigating it - there is no string for a repository's configured
// command to escape out of.

/**
 * How long a check command gets before its process group is torn down.
 *
 * A default rather than a policy: the executor above this will take the operator's own value
 * once there is a setting for one. Sized for a real build - a typecheck or a test suite that
 * takes minutes is ordinary - and a timeout is infrastructure, never a fail, so an
 * under-generous value costs a blocked run rather than a false verdict on somebody's change.
 */
export const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

export interface SupervisedCheckRequest {
  /**
   * The attempt this check belongs to. It reaches the supervisor's argv, which is what makes
   * its start identity unique to one attempt rather than to one second.
   */
  attemptId: string;
  /** argv, never a shell string. */
  command: readonly string[];
  /** The pooled worktree this check was handed. Lease acquisition belongs to its manager. */
  leasePath: string;
  /** Where inside that tree the command runs, RELATIVE. `""` is the root. */
  workingSubpath: string;
  timeoutMs?: number;
}

export interface SupervisedCheckDeps {
  /** Contract P. The persist half of the gate; no path here touches its table directly. */
  registry: CheckProcessRegistry;
  /** Defaults to the daemon's own environment, which is then scrubbed. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the daemon's minted auth token, so a value carrying it can be dropped. */
  daemonToken?: string;
  maxOutputBytes?: number;
  readyMs?: number;
  teardown?: CheckGroupTeardownOptions;
}

/**
 * Run one check command under a durable, identity-verified supervisor.
 *
 * Returns the published three-variant result AND what could be proven about the command's
 * process group, because those are two different questions and only the second may authorise
 * handing the leased tree back. A check can exit 0 having left a background server running in
 * the tree; reporting the exit code without the emptiness would let a caller return a worktree
 * that is still being written into.
 */
export async function runSupervisedCheck(
  request: SupervisedCheckRequest,
  deps: SupervisedCheckDeps,
): Promise<CheckSpawnOutcome> {
  // Asked FIRST, and answered without starting anything. A platform whose process start
  // identities cannot be read is one where a check could never be proven dead afterwards, so
  // the honest move is to decline the gate rather than to strand a pooled worktree on the
  // first crash. `unavailable` routes into the already-tested third passing outcome.
  const support = checkRuntimeSupport();
  if (!support.supported) {
    return { result: { kind: "unavailable", note: support.note }, emptiness: "empty", supervisor: null };
  }

  const cwd = workingDirectory(request.leasePath, request.workingSubpath);
  if (!cwd.ok) {
    return {
      result: { kind: "infrastructure", reason: cwd.reason },
      emptiness: "empty",
      supervisor: null,
    };
  }

  const outcome = await spawnCheckProcess({
    attemptId: request.attemptId,
    command: request.command,
    // The RESOLVED path, so what was checked for containment is what the command is given.
    cwd: cwd.path,
    env: scrubCheckEnv(deps.env ?? process.env, deps.daemonToken ?? readToken()),
    timeoutMs: request.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    maxOutputBytes: deps.maxOutputBytes,
    readyMs: deps.readyMs,
    teardown: deps.teardown,
    // THE GATE, and its ordering is the invariant this whole module exists for: identity is
    // durable before the command is released, so there is no window in which branch code runs
    // without a persisted owner. A throw here closes the gate and kills the supervisor with
    // nothing ever started, which leaves the row carrying its sentinel - the positive proof
    // recovery needs to tell "never ran" from "may still be running".
    onSupervisorReady: ({ pid, identity }) => deps.registry.record(request.attemptId, pid, identity),
  });

  // Cleared only on PROVEN emptiness, never on the leader having exited. A row that keeps its
  // identity is a row whose group might still be writing into the tree, and that is precisely
  // what stops the lease being handed back.
  if (outcome.emptiness === "empty" && outcome.supervisor) deps.registry.clear(request.attemptId);
  return outcome;
}

/**
 * How this module reads back an identity it persisted through Contract P.
 *
 * Declared HERE, as this phase's own dependency, rather than added to `CheckProcessRegistry`.
 * That interface is owned and published by the lease foundation, which has already merged, and
 * widening somebody else's contract to serve a consumer is the wrong direction even when the
 * addition is additive: it makes a later phase's need into an earlier phase's obligation. The
 * seam pattern this repository already uses everywhere - `CheckExecutor`,
 * `CheckoutSubpathResolver`, `PaneDeps.pane` - is for the consumer to name the narrow function
 * it needs and let its composer supply one.
 *
 * So the executor that composes this with the lease manager provides the reader, from whatever
 * accessor it already holds. Contract P is consumed exactly as published: `record` at the gate,
 * `clear` on proven emptiness, and nothing else.
 *
 * Returning `null` means "nothing was ever recorded". Passing a row's raw sentinel values
 * through instead is also safe and needs no special handling by the supplier, because
 * `terminateCheckGroup` already treats a non-signallable pid or an empty identity as "nothing
 * ever ran" - which is the same conclusion by a different route, and one fewer place for the
 * sentinel comparison to be re-derived incorrectly.
 */
export type CheckSupervisorLookup = (
  attemptId: string,
) => { pid: number; startTimeTicks: string } | null;

/**
 * The other direction of the seam: can this attempt's process group be proven gone?
 *
 * The lease manager declares `CheckGroupRecovery` with a default that refuses, because at
 * startup it can prove a leased tree is OURS (path plus holder token) and cannot prove anything
 * about what is running inside it. This supplies the real answer, and the executor injects it.
 *
 * It applies the live teardown unchanged - a sentinel means nothing ever ran, a mismatch is
 * never signalled, a match is signalled, graced, escalated and then proven - because a
 * recovery pass that used softer rules than a live cancellation would be a second policy for
 * the same question, and the softer one would be the one that killed a stranger.
 */
export function createCheckGroupRecovery(
  lookup: CheckSupervisorLookup,
  teardown: CheckGroupTeardownOptions = {},
): CheckGroupRecovery {
  return async (attemptId: string) => {
    const owner = lookup(attemptId);
    // No identity recorded: either no lease row at all, or one still carrying the sentinel.
    // Both mean the gate was never released, so no branch code ever ran and there is no group
    // to prove empty.
    if (!owner) return "empty";
    const emptiness = await terminateCheckGroup(owner.pid, owner.startTimeTicks, teardown);
    // The other end of the rule that keeps an unproven group watched: a live run hands a
    // `not-empty` or `unknown` group on to the exit hook rather than dropping it, and this is
    // the pass that eventually proves it gone and stops the tracking. Without it, a daemon that
    // ran many checks would accumulate entries nothing ever removes - harmless to correctness,
    // since the hook re-verifies identity before signalling, but an unbounded set is not a
    // thing to leave lying around.
    if (emptiness === "empty") unwatchCheckGroup(owner.pid);
    return emptiness;
  };
}

type WorkingDirectory = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Join a relative working subpath onto a leased tree, refusing anything that leaves it.
 *
 * Running a build one directory ABOVE the leased tree would execute against a checkout the run
 * never captured and report the answer as if it were about this submission - a wrong verdict
 * rather than a crash, which is the worst shape a failure can take here.
 *
 * ## Why this resolves symlinks, and why a lexical check is not enough
 *
 * The subpath STRING is operator-authored, but the filesystem it lands on is not: a leased
 * worktree is a checkout of branch-authored content, and git stores symlinks. So a branch can
 * commit `packages/web` as a link to anywhere on the machine, and a lexically perfect subpath
 * the operator configured in good faith then resolves outside the tree. `spawn` follows the
 * link; a `resolve()`-only check does not, which is the whole gap.
 *
 * Both sides are therefore run through `realpath` before being compared, and the RESOLVED path
 * is what the command is given - so what was checked is what runs, rather than a spelling of it
 * that could resolve differently a moment later. Anything that cannot be resolved fails closed
 * with a reason, including a subpath that simply is not there.
 *
 * Deliberately not `canonicalPath` from the pool adapter, which falls back to the raw string
 * when `realpath` fails. That is right for its job - comparing two spellings of a tree we
 * already own - and exactly wrong for a containment check, where an unresolvable path must
 * refuse rather than degrade into a string comparison.
 *
 * The residual, stated because it cannot be closed from user space: a component swapped between
 * this check and the `chdir` inside `spawn` is a race no sequence of stat calls can win. What
 * `realpath` buys is that the ordinary, persistent case - a symlink sitting in the tree - is
 * caught, rather than only the case where the operator typed `..`.
 */
function workingDirectory(leasePath: string, workingSubpath: string): WorkingDirectory {
  if (isAbsolute(workingSubpath)) {
    return {
      ok: false,
      reason:
        `the check's working subpath ${JSON.stringify(workingSubpath)} is absolute, and it must ` +
        "be relative to the worktree that was leased",
    };
  }
  let root: string;
  try {
    root = realpathSync(resolve(leasePath));
  } catch (err) {
    return {
      ok: false,
      reason: `the leased worktree ${leasePath} could not be resolved: ${message(err)}`,
    };
  }
  let candidate: string;
  try {
    candidate = realpathSync(resolve(join(root, workingSubpath)));
  } catch (err) {
    return {
      ok: false,
      reason:
        `the check's working directory ${JSON.stringify(workingSubpath)} could not be resolved ` +
        `inside the leased worktree: ${message(err)}`,
    };
  }
  if (candidate !== root) {
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      return {
        ok: false,
        reason:
          `the check's working subpath ${JSON.stringify(workingSubpath)} resolves to ${candidate}, ` +
          "which is outside the worktree it was leased",
      };
    }
  }
  return { ok: true, path: candidate };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type { CheckSpawnOutcome } from "./check-spawn.ts";
export type { CheckExecutionResult };
