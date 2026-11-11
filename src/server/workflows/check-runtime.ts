import { CodeRabbitResultParser, CODERABBIT_RESULT_LIMITS, type CodeRabbitChangedPaths } from "./coderabbit-result.ts";
import { codeRabbitChangedPaths } from "./coderabbit.ts";
import type { DatabaseSync } from "node:sqlite";
import { WORKFLOW_COMMAND_INTERPRETERS, type WorkflowCommandArtifactDescriptor } from "@shared/workflow.ts";
import type {
  CheckExecutionRequest,
  CheckExecutionResult,
  CheckExecutor,
  CheckSlot,
} from "./checks.ts";
import { mergeBaseWithSource } from "../diff.ts";
import { changedFingerprintInputs, readTreeBlobs, renderClaimArgv } from "../worktrees/claim.ts";
import {
  CheckDependencyClaimError,
  CheckLeaseStore,
  type CheckClaimFailure,
  type CheckGroupRecovery,
  type CheckLeaseManager,
  type CheckLeaseRelease,
} from "./check-lease.ts";
import type { CheckGroupEmptiness, CheckGroupTeardownOptions } from "./check-group.ts";
import { checkRuntimeSupport, type CheckRuntimeSupport } from "./check-identity.ts";
import { resolveCapturedCommit } from "./commit-id.ts";
import {
  createCheckGroupRecovery,
  DEFAULT_CHECK_TIMEOUT_MS,
  runSupervisedCheck,
  type CheckSpawnOutcome,
  type CheckSupervisorLookup,
} from "./check-supervisor.ts";
import { WorkflowCommandArtifactService } from "./command-artifacts.ts";

// The execution runtime a Check node reaches: the ONE place the worktree lease and the gated
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
  runId?: string;
  attemptId: string;
  submissionId: string;
  nodeId: string;
  /**
   * The check-concurrency slot this attempt holds. Released while a dependency claim runs, and
   * taken again before the Command spawns, so a long install never keeps another check queued.
   * Absent means the attempt keeps whatever its caller holds throughout.
   */
  checkSlot?: CheckSlot;
  /**
   * Aborted when this attempt's run is cancelled. The dependency claim follows it, so a cancel
   * stops a claim that is running and one that has not started yet alike.
   */
  signal?: AbortSignal;
}

/** Which of a claim's fingerprint inputs a change touched, or why that could not be read. */
export type ClaimInputsChanged =
  | { ok: true; changed: string[] }
  | { ok: false; reason: string };

/**
 * The fingerprint inputs whose blob differs between `headSha` and its merge base with origin's
 * default branch, read from objects in the main checkout, never from a worktree: the attempt's tree has
 * already been handed back when this is asked.
 */
export async function claimInputsChangedSinceMergeBase(input: {
  repoRoot: string;
  headSha: string;
  fingerprintPaths: readonly string[];
}): Promise<ClaimInputsChanged> {
  const base = await mergeBaseWithSource(input.repoRoot, input.headSha);
  if (!base.ok) return base;
  const [head, merged] = await Promise.all([
    readTreeBlobs(input.repoRoot, input.headSha),
    readTreeBlobs(input.repoRoot, base.base),
  ]);
  if (!head.ok) return { ok: false, reason: head.reason };
  if (!merged.ok) return { ok: false, reason: merged.reason };
  return { ok: true, changed: changedFingerprintInputs(input.fingerprintPaths, head.value, merged.value) };
}

/** Test suites get the larger budget; faster check slots keep the supervisor default. */
export function defaultCheckTimeoutMs(slot: CheckExecutionRequest["slot"]): number {
  return slot === "coderabbit" ? 45 * 60_000 : slot === "test" ? 60 * 60_000 : DEFAULT_CHECK_TIMEOUT_MS;
}

/** How the composed runtime is driven, and every seam a test needs to drive it without a pool. */
export interface CheckRuntimeDeps {
  /** Defaults to the real gated supervisor. */
  supervise?: typeof runSupervisedCheck;
  /** Defaults to the platform probe. Asked once per check, before anything is leased. */
  platform?: () => CheckRuntimeSupport;
  /** How long one check command gets. Overrides the slot-specific production defaults. */
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
  /** Defaults to asking git. See `codeRabbitChangedPaths`. */
  changedPaths?: (repoRoot: string, mergeBase: string, head: string) => Promise<CodeRabbitChangedPaths>;
  artifacts?: WorkflowCommandArtifactService;
  /** Defaults to `claimInputsChangedSinceMergeBase`. Asked only after a failed dependency claim. */
  claimInputsChanged?: typeof claimInputsChangedSinceMergeBase;
}

/**
 * The composed check execution runtime.
 *
 * Constructed once per daemon, in `src/server/index.ts`, above the `WorkflowManager`: a check
 * must not start before durable check-lease recovery knows which trees it already holds.
 */
export class CheckRuntime {
  private readonly supervise: typeof runSupervisedCheck;
  private readonly platform: () => CheckRuntimeSupport;
  private readonly timeoutMs: number | undefined;
  private readonly teardown: CheckGroupTeardownOptions | undefined;
  private readonly resolveCommit: (repoRoot: string, headSha: string) => Promise<string>;
  private readonly changedPaths: (repoRoot: string, mergeBase: string, head: string) => Promise<CodeRabbitChangedPaths>;
  private readonly artifacts: WorkflowCommandArtifactService;
  private readonly claimInputsChanged: typeof claimInputsChangedSinceMergeBase;

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
    this.changedPaths = deps.changedPaths ?? codeRabbitChangedPaths;
    this.artifacts = deps.artifacts ?? new WorkflowCommandArtifactService(deps.db);
    this.claimInputsChanged = deps.claimInputsChanged ?? claimInputsChangedSinceMergeBase;
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
    if (request.signal?.aborted) {
      return {kind: "infrastructure", started: false,
        reason: "check interrupted because Mission Control is shutting down"};
    }
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
        started: false,
        reason:
          "this submission captured no commit, so there was nothing to pin a check worktree to",
      };
    }

    // Resolved before a tree is leased, so a failure costs nothing to unwind. A CLI that
    // reports `reviewedFiles` is checked against these rather than trusted.
    let changedPaths: CodeRabbitChangedPaths | null = null;
    if (request.coderabbit) {
      const { mergeBase, head } = request.coderabbit;
      try {
        if (!mergeBase || !head) throw new Error("the comparison is not pinned");
        changedPaths = await this.changedPaths(request.repoRoot, mergeBase, head);
      } catch (err) {
        return { kind: "infrastructure", started: false,
          reason: `the CodeRabbit comparison's changed files could not be listed: ${message(err)}` };
      }
    }

    // `acquireForAttempt` verifies the commit BEFORE it leases, using the same full-40-hex
    // check the dispatcher uses, and unwinds its own lease on any pin failure - so a commit
    // this repository does not have costs an error rather than a pool slot. Every failure it
    // can produce is infrastructure and never a verdict.
    //
    // The repository's dependency claim runs inside that acquisition. While it runs, this
    // attempt gives up its check slot: an install is not a build, and a claim may run for hours.
    // The budget reservation was taken before any of this, so it does not move. The Command's
    // own timeout starts at spawn, below, so claim time never
    // counts against it: a slow install ends under the claim's own limit, as a dependency
    // failure. A CodeRabbit review installs and runs nothing from the tree, so it takes its tree
    // without a claim at all.
    let leasePath: string;
    let headSha: string | null = null;
    let slotReleased = false;
    const slot = attempt.checkSlot;
    try {
      // The capture records an abbreviation and a pin takes a full id, so this is the step
      // that turns one into the other. See `resolveCapturedCommit`: without it every check on
      // every real submission failed here, before a tree was ever leased.
      headSha = await this.resolveCommit(request.repoRoot, request.headSha);
      leasePath = await this.leases.acquireForAttempt({
        attemptId: attempt.attemptId,
        submissionId: attempt.submissionId,
        nodeId: attempt.nodeId,
        repoRoot: request.repoRoot,
        headSha,
        runClaim: WORKFLOW_COMMAND_INTERPRETERS[request.slot] !== "coderabbit",
        ...(attempt.signal ? { signal: attempt.signal } : {}),
        ...(slot
          ? {
              onClaimStart: () => {
                slotReleased = true;
                slot.release();
              },
            }
          : {}),
      });
    } catch (err) {
      // The tree is already back: `acquireForAttempt` throws this only after its return is
      // confirmed. Nothing ran, so this attempt never retakes the slot it gave up.
      if (err instanceof CheckDependencyClaimError && headSha) {
        return await this.dependencyFailure(request, headSha, err.failure);
      }
      return {
        kind: "infrastructure",
        started: false,
        reason: `a worktree for the ${request.slot} check could not be prepared: ${message(err)}`,
      };
    }
    // Taken again before anything else runs in the tree, so the spawn runs under a check slot,
    // exactly as it did before claims existed.
    if (slotReleased && slot) await slot.reacquire();

    const parser = request.coderabbit ? new CodeRabbitResultParser(attempt.attemptId, request.coderabbit.severity, changedPaths) : null;
    let capture: ReturnType<WorkflowCommandArtifactService["beginCapture"]> | undefined;
    try {
      capture = attempt.runId ? this.artifacts.beginCapture({
        runId: attempt.runId,
        submissionId: attempt.submissionId,
        attemptId: attempt.attemptId,
        semanticBytes: parser ? CODERABBIT_RESULT_LIMITS.findingsBytes : 0,
      }) : undefined;
    } catch (error) {
      // No process has started. A metadata database failure stays fail-closed, but must
      // first release the leased tree rather than leave it owned until daemon restart.
      await this.settle(attempt.attemptId, "empty");
      throw error;
    }
    let outcome: CheckSpawnOutcome;
    try {
      outcome = await this.supervise(
        {
          signal: request.signal,
          attemptId: attempt.attemptId,
          command: request.command,
          // THE LEASED TREE, joined with the subpath the winning command entry named. Never
          // the binding's `sessionRepoRoot`: on the ordinary dispatch shape that names the
          // shared main repository behind a linked worktree, so a check would test an
          // unrelated checkout and report the answer as if it were about this submission.
          leasePath,
          workingSubpath: request.workingSubpath,
          timeoutMs: this.timeoutMs ?? request.timeoutMs ?? defaultCheckTimeoutMs(request.slot),
          capture: { push: (kind, chunk) => {
            if (kind === "stdout") parser?.push(chunk);
            capture?.push(kind, chunk);
          } },
        },
        {
          registry: this.leases.processes,
          env: request.env,
          teardown: this.teardown,
        },
      );
    } catch (err) {
      let artifacts: WorkflowCommandArtifactDescriptor[];
      let review: import("@shared/workflow.ts").CodeRabbitReviewSummary | undefined;
      try {
        artifacts = capture?.finalize(false) ?? [];
        review = this.retainReview(attempt, request, parser, artifacts, false, 1);
      } catch (captureError) {
        throw new AggregateError([err, captureError], "Check supervision and artifact metadata failed");
      } finally {
        await this.settle(attempt.attemptId, "unknown");
      }
      return { kind: "infrastructure", reason: `the ${request.slot} check runtime failed: ${message(err)}`,
        artifacts, ...(review ? { review } : {}) };
    }

    // BEFORE the result surfaces, always. An `infrastructure` result reaches
    // `handleInfrastructureFailure`, which finishes this attempt and creates a fresh one, and
    // the retry gate it consults can only be right if this lease has already reached its true
    // state by the time it is asked.
    let artifacts: WorkflowCommandArtifactDescriptor[];
    let cleanup: CheckCleanup;
    try {
      artifacts = capture?.finalize(
        outcome.result.kind === "exited" || outcome.result.kind === "unavailable",
      ) ?? [];
    } finally {
      cleanup = await this.settle(attempt.attemptId, outcome.emptiness);
    }
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
    const review = this.retainReview(attempt, request, parser, artifacts, cleanup.ok,
      outcome.result.kind === "exited" ? outcome.result.exitCode : 1);
    if (!cleanup.ok) {
      return { kind: "infrastructure",
        reason: `the ${request.slot} check ran and ${describeResult(outcome.result)}, but its result is withheld because its pooled worktree could not be accounted for: ${cleanup.reason}`,
        artifacts, review };
    }
    return outcome.result.kind === "exited" || outcome.result.kind === "infrastructure"
      ? { ...outcome.result, artifacts, ...(review ? { review } : {}), ...(outcome.result.kind === "infrastructure" ? { started: outcome.supervisor !== null } : {}) }
      : outcome.result;
  }

  /** Findings share the raw artifact lifecycle and quota, including partial failures. */
  private retainReview(
    attempt: CheckAttemptRef,
    request: CheckExecutionRequest,
    parser: CodeRabbitResultParser | null,
    artifacts: WorkflowCommandArtifactDescriptor[],
    cleanupComplete: boolean,
    exitCode: number,
  ): import("@shared/workflow.ts").CodeRabbitReviewSummary | undefined {
    if (!parser || !request.coderabbit) return undefined;
    const semantic = parser.finish(exitCode, request.coderabbit.empty);
    const complete = cleanupComplete && semantic.status !== "incomplete";
    const findings = attempt.runId ? this.artifacts.publishFindings({
      runId: attempt.runId, submissionId: attempt.submissionId, attemptId: attempt.attemptId,
    }, semantic.body, complete) : null;
    if (findings) artifacts.push(findings);
    const lost = !findings || findings.availability !== "retained";
    return { comparison: request.coderabbit,
      status: lost || !complete ? "incomplete" : semantic.status === "skipped" ? "skipped" : "complete",
      counts: semantic.counts, titles: semantic.titles,
      ...(semantic.retryAt ? { retryAt: semantic.retryAt } : {}),
      ...(semantic.expectedDuration ? { expectedDuration: semantic.expectedDuration } : {}),
      diagnostic: lost ? "CodeRabbit findings could not be durably retained" : semantic.diagnostic };
  }

  /**
   * A failed dependency claim, as a check result. The Command did not run.
   *
   * The change owns the failure only when it changed one of the claim's fingerprint inputs
   * against its merge base with the base branch: a lockfile the branch broke fails the check,
   * with the claim's output tail as the check's output. Otherwise the failure is the machine's,
   * a registry or a token, and it is infrastructure: the engine retries it as the same
   * execution, up to its infrastructure cap, with the run budget handed back. A claim with no
   * fingerprint paths cannot tell the two apart, and neither can a merge base that cannot be
   * read, so both are infrastructure: a failure is never blamed on a change on a guess.
   */
  private async dependencyFailure(
    request: CheckExecutionRequest,
    headSha: string,
    failure: CheckClaimFailure,
  ): Promise<CheckExecutionResult> {
    const { warning } = failure;
    const what = `the dependency claim failed at step ${warning.step} of ${warning.stepCount} `
      + `(${renderClaimArgv(warning.argv)}) ${warning.reason}`;
    let changed: ClaimInputsChanged = { ok: true, changed: [] };
    let why: string;
    if (failure.fingerprintPaths.length === 0) {
      why = "the claim lists no fingerprint paths, so the failure cannot be traced to this change";
    } else {
      try {
        changed = await this.claimInputsChanged({
          repoRoot: request.repoRoot,
          headSha,
          fingerprintPaths: failure.fingerprintPaths,
        });
      } catch (err) {
        changed = { ok: false, reason: message(err) };
      }
      why = changed.ok
        ? "none of its fingerprint inputs changed against the merge base"
        : `whether this change touched its fingerprint inputs could not be read (${changed.reason})`;
    }
    if (changed.ok && changed.changed.length > 0) {
      const named = changed.changed.slice(0, 5).join(", ")
        + (changed.changed.length > 5 ? ` and ${changed.changed.length - 5} more` : "");
      return {
        kind: "decided",
        status: "failed",
        note: `${capitalize(what)}, and this change modified its inputs (${named}), so the failure `
          + `is the change's. The ${request.slot} Command did not run.`,
        exitCode: null,
        output: warning.tail,
        truncatedBytes: warning.truncatedBytes,
      };
    }
    return {
      kind: "infrastructure",
      reason: `${what}; ${why}, so it is treated as infrastructure and the ${request.slot} Command `
        + "did not run."
        + (warning.tail ? `\nClaim output:\n${warning.tail}` : ""),
      ranNothing: true,
    };
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
  if (result.kind === "decided") return `was decided ${result.status} before its command ran`;
  return `could not be run (${result.reason})`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
