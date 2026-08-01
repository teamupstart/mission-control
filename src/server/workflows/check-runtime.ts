import type { DatabaseSync } from "node:sqlite";
import { run } from "../util/exec.ts";
import type {
  CheckAttemptRef,
  CheckExecutionRequest,
  CheckExecutionResult,
  CheckExecutor,
} from "./checks.ts";
import { CheckLeaseStore, type CheckGroupRecovery, type CheckLeaseManager } from "./check-lease.ts";
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
    await this.settle(attempt.attemptId, outcome.emptiness);
    return outcome.result;
  }

  /**
   * Resolve the lease against what the supervisor could PROVE, not against how the command
   * exited.
   *
   * A command that exits zero having left a background server running is ordinary, and its
   * verdict is still a pass - but its tree is not free. The two answers are separate on
   * purpose and only the second one may authorise a `return --force`.
   */
  private async settle(attemptId: string, emptiness: CheckGroupEmptiness): Promise<void> {
    if (emptiness !== "empty") {
      // Keep the row, keep the pin, drop only this process's claim - so the reclamation pass
      // stops treating the lease as a check that is still running and starts asking whether
      // its group has finally gone.
      this.leases.handOffForReclaim(attemptId);
      console.warn(
        `[mission-control] a check's process group could not be proven empty (${emptiness}); ` +
          "its pooled worktree is kept until reclamation can prove it gone",
      );
      return;
    }
    try {
      const released = await this.leases.releaseForAttempt(attemptId);
      if (released.outcome === "retry") {
        console.warn(
          `[mission-control] a check's pooled worktree could not be returned (${released.reason}); ` +
            "the lease is kept and reclamation will retry",
        );
      }
    } catch (err) {
      // Swallowed rather than thrown into the caller: the check has an answer, and losing it
      // to a cleanup failure would turn a real verdict into an infrastructure retry that runs
      // the whole build again. The lease survives in the durable table either way.
      console.error(
        "[mission-control] could not release a check's pooled worktree:",
        message(err),
      );
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
