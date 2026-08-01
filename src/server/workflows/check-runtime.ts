import type { DatabaseSync } from "node:sqlite";
import { run } from "../util/exec.ts";
import type {
  CheckExecutionRequest,
  CheckExecutionResult,
  CheckExecutor,
} from "./checks.ts";
import {
  CheckLeaseStore,
  type CheckGroupRecovery,
  type CheckLeaseManager,
  type CheckLeaseRelease,
} from "./check-lease.ts";
import type { CheckGroupEmptiness, CheckGroupTeardownOptions } from "./check-group.ts";
import { checkRuntimeSupport, type CheckRuntimeSupport } from "./check-identity.ts";
import {
  createCheckGroupRecovery,
  runSupervisedCheck,
  type CheckSpawnOutcome,
  type CheckSupervisorLookup,
} from "./check-supervisor.ts";

// The execution runtime a Check node reaches: the ONE place the pooled lease and the gated
// process supervisor meet, and the change that makes a configured check gate stop passing
// without running.
//
// Everything hard already happened in the two halves this composes. The lease half owns
// ownership, pinning, durability and reclamation; the supervisor half owns spawning, output,
// identity and proving a process group gone. What is left here is an ORDER, and every step of
// it is a rule with a failure behind it:
//
//  1. **Platform first, before anything is leased.** Somewhere a process identity cannot be
//     read, a check could be started and never proven finished - so it is declined, and
//     declining costs no pool slot.
//  2. **A null `headSha` is infrastructure, not `unavailable`.** A capture with no commit
//     cannot be pinned, and running against whatever the tree happens to hold is the exact
//     wrong answer this whole unit exists to avoid. `unavailable` PASSES the gate; this must
//     not.
//  3. **Cleanup precedes classification.** The lease is resolved before any result is
//     returned, especially an `infrastructure` one - because that result sends the engine
//     straight to a retry, a retry is a new attempt id, and a new attempt id would cheerfully
//     lease a SECOND tree while the first group may still be writing into the first.
//  4. **Only a proven-empty group authorises the return.** Anything else keeps the row and
//     the pin and hands the lease to the reclamation pass.
//
// It never decides pass or fail. The ladder in `checks.ts` and `checkVerdict` in `engine.ts`
// own that, and an exit code reaches them exactly as the supervisor reported it.

/**
 * Which attempt an executor is running for.
 *
 * Declared HERE, by the consumer, rather than added to `CheckExecutionRequest`. That type is
 * published, closed, and describes a COMMAND - a slot, an argv, a repository, a commit - while
 * this describes the attempt whose resources the command borrows, which is not something the
 * ladder in `checks.ts` knows or should learn. Widening it would also have made every existing
 * caller of `runCheck` supply an identity it has no reason to hold.
 *
 * This is the same direction the supervisor took with `CheckSupervisorLookup`: the consumer
 * names the narrow shape it needs and its composer supplies one, rather than an earlier phase's
 * published contract growing a member to serve a later phase's consumer. The engine builds one
 * of these per attempt and binds it; nothing in `checks.ts` changes.
 *
 * All three fields answer different questions. `attemptId` is the lease key, the process
 * registry key, and what makes the pooled worktree's holder token unique to one attempt.
 * `submissionId` and `nodeId` are what let the engine ask, before it creates a retry, whether
 * this node still owns a lease that has not resolved - a retry carries a NEW attempt id, so
 * nothing about the retry itself would collide with the lease it must not outrun.
 */
export interface CheckAttemptRef {
  attemptId: string;
  submissionId: string;
  nodeId: string;
}

/** How the composed runtime is driven, and every seam a test needs to drive it without a pool. */
export interface CheckRuntimeDeps {
  /** Defaults to the real gated supervisor. */
  supervise?: typeof runSupervisedCheck;
  /** Defaults to the platform probe. Asked once per check, before anything is leased. */
  platform?: () => CheckRuntimeSupport;
  /** How long one check command gets. Defaults to the supervisor's own value. */
  timeoutMs?: number;
  /** Teardown timings, for both live cancellation and startup recovery. */
  teardown?: CheckGroupTeardownOptions;
  /**
   * Where the durable supervisor identity is read back from.
   *
   * The supervisor persists identity through Contract P (`record` / `clear`) and deliberately
   * has no reader on that interface - so the composer supplies one, which is this module. The
   * lease store is the published accessor for those two columns, and passing a row's raw
   * sentinel values straight through is safe: `terminateCheckGroup` already treats a
   * non-signallable pid or an empty identity as "nothing ever ran".
   */
  leaseStore?: CheckLeaseStore;
  /** Only consulted when no store is injected. */
  db?: DatabaseSync;
  /** Defaults to asking git. See `resolveCapturedCommit`. */
  resolveCommit?: (repoRoot: string, headSha: string) => Promise<string>;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Turn the capture's commit identifier into the full 40-character id a pin requires.
 *
 * **Found by running this end to end, and invisible from the code alone.** Evidence capture
 * records `git rev-parse --short HEAD` (`src/server/diff.ts`), so `headSha` on a real
 * submission is an ABBREVIATION - while `verifyPinnedBase` refuses anything that is not a full
 * 40-hex id, deliberately, because `requireSha` will not hard-reset a worktree onto a name it
 * cannot pin exactly. Wired without this step, every check on every real submission failed as
 * infrastructure before it ever leased a tree: the gate still never ran, which is the headline
 * defect wearing a different hat.
 *
 * Resolved through git rather than by relaxing the pin's rule, and that direction is the point.
 * An abbreviation only names a commit if this repository says which one, and `rev-parse
 * --verify` refuses an ambiguous abbreviation outright - so this narrows to exactly one commit
 * or it fails, and what reaches the pin is still a full id held to its own standard. Relaxing
 * `requireSha` instead would have let an ambiguous prefix decide which commit a build ran
 * against.
 *
 * A full id short-circuits, which is the shape `submission.prHeadSha` already arrives in.
 */
async function resolveCapturedCommit(repoRoot: string, headSha: string): Promise<string> {
  if (FULL_SHA.test(headSha)) return headSha;
  const r = await run("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${headSha}^{commit}`]);
  const full = r.stdout.trim();
  if (r.code !== 0 || !FULL_SHA.test(full)) {
    throw new Error(
      `the captured commit ${headSha} could not be resolved to a single commit in ${repoRoot}` +
        (r.stderr.trim() ? ` - git said: ${r.stderr.trim()}` : ""),
    );
  }
  return full;
}

/**
 * The composed check execution runtime.
 *
 * Constructed once per daemon, in `src/server/index.ts`, ABOVE the pool reaper and above the
 * `WorkflowManager` - a check must not be able to start before the daemon knows which trees it
 * already holds.
 */
export class CheckRuntime {
  private readonly supervise: typeof runSupervisedCheck;
  private readonly platform: () => CheckRuntimeSupport;
  private readonly timeoutMs: number | undefined;
  private readonly teardown: CheckGroupTeardownOptions | undefined;
  private readonly resolveCommit: (repoRoot: string, headSha: string) => Promise<string>;

  /**
   * Phase 3's answer to the lease manager's open question, ready to inject.
   *
   * The lease manager can prove a leased tree is OURS and cannot prove anything about what is
   * running inside it; only the second authorises a destructive return. Its own default
   * refuses, so an uninjected daemon keeps every non-sentinel lease across a restart - fail
   * closed, but a pool slot per restart. This is the injection that closes it, and it is
   * consumed by BOTH `reconcileOnStartup` and the reclamation pass that rides the reaper tick.
   */
  readonly groupRecovery: CheckGroupRecovery;

  constructor(
    private readonly leases: CheckLeaseManager,
    deps: CheckRuntimeDeps = {},
  ) {
    this.supervise = deps.supervise ?? runSupervisedCheck;
    this.platform = deps.platform ?? checkRuntimeSupport;
    this.timeoutMs = deps.timeoutMs;
    this.teardown = deps.teardown;
    this.resolveCommit = deps.resolveCommit ?? resolveCapturedCommit;
    const store = deps.leaseStore ?? new CheckLeaseStore(deps.db);
    const lookup: CheckSupervisorLookup = (attemptId) => {
      const row = store.get(attemptId);
      return row ? { pid: row.supervisorPid, startTimeTicks: row.supervisorStartTicks } : null;
    };
    this.groupRecovery = createCheckGroupRecovery(lookup, deps.teardown ?? {});
  }

  /** Bind the runtime to one attempt. The result is Contract E's published executor type. */
  executorFor(attempt: CheckAttemptRef): CheckExecutor {
    return (request) => this.execute(attempt, request);
  }

  /**
   * Contract R, asked by the engine before it creates a retry for a check node.
   *
   * Exposed here rather than reached for directly so the daemon wires one object into the
   * workflow manager instead of two halves that could be injected apart.
   */
  unresolvedLeaseForNode(submissionId: string, nodeId: string): boolean {
    return this.leases.unresolvedLeaseForNode(submissionId, nodeId);
  }

  private async execute(
    attempt: CheckAttemptRef,
    request: CheckExecutionRequest,
  ): Promise<CheckExecutionResult> {
    // Asked before a tree is taken. `runSupervisedCheck` asks it again - it has to, since it
    // is reachable on its own - but an unsupported platform must never reach a pool at all:
    // leasing a worktree to decline a check would spend the resource the decline exists to
    // protect.
    const support = this.platform();
    if (!support.supported) return { kind: "unavailable", note: support.note };

    if (request.headSha === null) {
      // Not `unavailable`, which PASSES. There is nothing to pin the worktree to, and a check
      // run against whatever a pooled tree happens to be holding would report an answer about
      // some other commit as though it were about this submission.
      return {
        kind: "infrastructure",
        reason:
          "this submission captured no commit, so there was nothing to pin a check worktree to",
      };
    }

    // `acquireForAttempt` verifies the commit BEFORE it leases, using the same full-40-hex
    // check the dispatcher uses, and unwinds its own lease on any pin failure - so a commit
    // this repository does not have costs an error rather than a pool slot. Every failure it
    // can produce is infrastructure and never a verdict.
    let leasePath: string;
    try {
      leasePath = await this.leases.acquireForAttempt({
        attemptId: attempt.attemptId,
        submissionId: attempt.submissionId,
        nodeId: attempt.nodeId,
        repoRoot: request.repoRoot,
        // The capture records an abbreviation and a pin takes a full id, so this is the step
        // that turns one into the other. See `resolveCapturedCommit`: without it every check on
        // every real submission failed here, before a tree was ever leased.
        headSha: await this.resolveCommit(request.repoRoot, request.headSha),
      });
    } catch (err) {
      return {
        kind: "infrastructure",
        reason: `a worktree for the ${request.slot} check could not be prepared: ${message(err)}`,
      };
    }

    let outcome: CheckSpawnOutcome;
    try {
      outcome = await this.supervise(
        {
          attemptId: attempt.attemptId,
          command: request.command,
          // THE LEASED TREE, joined with the subpath the winning command entry named. Never
          // the binding's `sessionRepoRoot`: on the ordinary dispatch shape that names the
          // shared main repository behind a linked worktree, so a check would test an
          // unrelated checkout and report the answer as if it were about this submission.
          leasePath,
          workingSubpath: request.workingSubpath,
          timeoutMs: this.timeoutMs,
        },
        {
          registry: this.leases.processes,
          teardown: this.teardown,
        },
      );
    } catch (err) {
      // The supervisor is written not to throw, and a lease outliving one that did would be a
      // pool slot lost to a bug nobody can see. Resolved as unproven, which is the fail-closed
      // reading: the row and the pin are kept and reclamation asks about the group later.
      await this.settle(attempt.attemptId, "unknown");
      return {
        kind: "infrastructure",
        reason: `the ${request.slot} check runtime failed: ${message(err)}`,
      };
    }

    // BEFORE the result surfaces, always. An `infrastructure` result reaches
    // `handleInfrastructureFailure`, which finishes this attempt and creates a fresh one, and
    // the retry gate it consults can only be right if this lease has already reached its true
    // state by the time it is asked.
    const cleanup = await this.settle(attempt.attemptId, outcome.emptiness);
    // A cleanup that did not resolve is an INFRASTRUCTURE failure, and it outranks whatever the
    // command said. Two reasons, and the second is the one that makes this load-bearing rather
    // than fastidious:
    //
    //  - A gate whose worktree is still held, or was re-leased to somebody else while it ran,
    //    has not been shown to have run against the commit it claims. Reporting `passed` on a
    //    tree we cannot account for is the same class of wrong answer as running the command in
    //    `sessionRepoRoot` - a verdict about the wrong thing, delivered confidently.
    //  - The retry gate only ever sees an attempt through `handleInfrastructureFailure`. Let a
    //    verdict through here and a run whose check exited 0 with a stranded lease advances,
    //    completes, and holds a pool slot with nothing anywhere saying so. Returning
    //    infrastructure is what turns that into a visible `check_cleanup_unresolved` block that
    //    reclamation then clears.
    //
    // The command's own outcome rides along in the reason rather than being dropped, so the
    // operator can still see what the build said before the lease went wrong.
    if (!cleanup.ok) {
      return {
        kind: "infrastructure",
        reason:
          `the ${request.slot} check ran and ${describeResult(outcome.result)}, but that result is `
          + `not reported because its pooled worktree could not be accounted for: ${cleanup.reason}`,
      };
    }
    return outcome.result;
  }

  /**
   * Resolve the lease against what the supervisor could PROVE, not against how the command
   * exited, and say whether the resource ended up accounted for.
   *
   * Those are two different questions and the caller needs both. A command that exits zero
   * having left a background server running is ordinary, and its exit code is still zero - but
   * its tree is not free, and only a proven-empty group may authorise a `return --force`.
   */
  private async settle(attemptId: string, emptiness: CheckGroupEmptiness): Promise<CheckCleanup> {
    if (emptiness !== "empty") {
      // Keep the row, keep the pin, drop only this process's claim - so the reclamation pass
      // stops treating the lease as a check that is still running and starts asking whether
      // its group has finally gone.
      this.leases.handOffForReclaim(attemptId);
      return {
        ok: false,
        reason:
          `its process group could not be proven empty (${emptiness}), so the worktree is kept `
          + "until reclamation can prove it gone",
      };
    }
    let released: CheckLeaseRelease;
    try {
      released = await this.leases.releaseForAttempt(attemptId);
    } catch (err) {
      // Ownership is dropped in `releaseForAttempt`'s own `finally`, but a throw before that is
      // reached would leave this attempt looking like a check still running - which is the one
      // state reclamation skips.
      this.leases.handOffForReclaim(attemptId);
      return { ok: false, reason: `releasing the worktree failed outright: ${message(err)}` };
    }
    if (released.outcome === "returned") return { ok: true };
    if (released.outcome === "lost") {
      // The tree was leased to somebody else by the time we tried to give it back, which means
      // it may have been reset under the command while it ran. Nothing can be concluded about
      // what that command was standing in, so nothing is concluded.
      return {
        ok: false,
        reason:
          `the worktree was held by ${released.holder ?? "another holder"} by the time it was `
          + "handed back, so what the command was standing in cannot be established",
      };
    }
    return {
      ok: false,
      reason: `the worktree could not be handed back (${released.reason}), and the lease is kept`,
    };
  }
}

/** Whether a check's pooled worktree ended up accounted for, and why not when it did not. */
type CheckCleanup = { ok: true } | { ok: false; reason: string };

/**
 * What the command did, for a reason line whose whole job is to explain a discarded result.
 *
 * The outcome is not lost just because it is not reported as a verdict: an operator looking at
 * a blocked run has to be able to tell "the build failed and then cleanup went wrong" from
 * "the build passed and then cleanup went wrong", because only one of those is also a repair.
 */
function describeResult(result: CheckExecutionResult): string {
  if (result.kind === "exited") return `exited ${result.exitCode}`;
  if (result.kind === "unavailable") return "reported that its command was not found";
  return `could not be run (${result.reason})`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
