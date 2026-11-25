import type { CodeRabbitComparison, CodeRabbitConfigSnapshot, CodeRabbitTuning, WorkflowCommandView } from "@shared/workflow.ts";
import { isDeepStrictEqual } from "node:util";
import { checkBlockedReason, codeRabbitReviewArgv, CODERABBIT_REVIEW_COMMAND, DEFAULT_CODERABBIT_COMMAND, defaultWorkflowCommandMaxRuns, effectiveWorkflowCommandTimeoutMs, WORKFLOW_COMMAND_DEFAULT_TIMEOUT_MS, WORKFLOW_EXECUTION_LIMITS } from "@shared/workflow.ts";
import { locateExecutable } from "../executables/locator.ts";
import { run, type RunResult } from "../util/exec.ts";
import { readToken } from "../../shared/harness-runtime.mjs";
import { cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";
import { scrubCheckEnv } from "./check-env.ts";
import { FULL_SHA } from "./commit-id.ts";
import { resolveReviewComparison } from "./review-comparison.ts";
import type { CheckResult, CheckRunDeps, CheckRunReservation, RunCheckInput } from "./checks.ts";
import { workflowLog } from "./log.ts";
import { CODERABBIT_OPERATOR_ACTION } from "./coderabbit-result.ts";

export const CODERABBIT_SETUP = "Settings > Setup";
export const CODERABBIT_ALLOWANCE_REMEDY = "Inspect retained output and explicitly raise the run allowance in Library > Commands, then submit a new round to capture it";
export const CODERABBIT_MANAGED_ENV = { CODERABBIT_CLI_DISABLE_AUTO_UPDATE: "true", CR_CLI_AUTH_TIMEOUT: "5000" };

export function codeRabbitVersionCompatible(output: string): boolean {
  const m = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim());
  return !!m && (Number(m[1]) > 0 || Number(m[2]) > 9 || Number(m[2]) === 9 && Number(m[3]) >= 1);
}

/**
 * What `coderabbit --version` says, kept three ways apart. `obsolete` only for a version that
 * was read and is older than 0.9.1; a failed, timed-out, overflowing or unparseable answer is
 * `unreadable`, which says nothing about the version and must not be reported as too old.
 */
export type CodeRabbitVersionReading =
  | { state: "compatible"; version: string }
  | { state: "obsolete"; version: string }
  | { state: "unreadable" };

export async function codeRabbitVersionReading(execute: (argv: string[]) => Promise<RunResult>): Promise<CodeRabbitVersionReading> {
  const result = await execute(["--version"]);
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) return { state: "unreadable" };
  const version = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(result.stdout.trim())?.[1];
  if (!version) return { state: "unreadable" };
  return codeRabbitVersionCompatible(version) ? { state: "compatible", version } : { state: "obsolete", version };
}

/** The CLI version gate alone. Null when compatible; never echoes stderr. */
export async function codeRabbitVersionProblem(execute: (argv: string[]) => Promise<RunResult>, onVersion?: (version: string) => void): Promise<string | null> {
  const reading = await codeRabbitVersionReading(execute);
  if (reading.state !== "compatible") return "CodeRabbit CLI >=0.9.1 is required. Install or upgrade the CLI";
  onVersion?.(reading.version);
  return null;
}

/** Never returns account identifiers, credentials or arbitrary stderr in fleet diagnostics. */
export async function codeRabbitReadiness(execute: (argv: string[]) => Promise<RunResult>, onVersion?: (version: string) => void): Promise<string | null> {
  return await codeRabbitVersionProblem(execute, onVersion) ?? await codeRabbitAuthProblem(execute);
}

const AUTH_UNAVAILABLE_DIAGNOSTIC = "CodeRabbit authentication is unavailable";
const AUTH_UNCONFIRMED_DIAGNOSTIC = "CodeRabbit stored authentication could not be confirmed";
const AUTH_LOGIN_ADVICE = "Run coderabbit auth login using the daemon's effective HOME";
const AUTH_UNAVAILABLE = `${AUTH_UNAVAILABLE_DIAGNOSTIC}. ${AUTH_LOGIN_ADVICE}`;
const AUTH_UNCONFIRMED = `${AUTH_UNCONFIRMED_DIAGNOSTIC}. ${AUTH_LOGIN_ADVICE}`;

/**
 * What `coderabbit auth status --agent` says, kept three ways apart.
 *
 * `signed-out` only when the CLI answered cleanly and its own events say so - a status of
 * `authenticated: false` or an `action_required` - so Setup can ask for a sign-in. A failed,
 * timed-out, overflowing or unparseable answer, or an `error` event, is `unverified`: the
 * probe could not tell, and telling the operator they are signed out would send them through
 * a login that repairs nothing. Never carries account identifiers or arbitrary stderr.
 */
/**
 * `problem` is the workflow gate's full message, login advice included. `diagnostic` is the
 * same reading without that advice, for a surface that must not tell an operator to log in
 * when the sign-in state was never read.
 */
export type CodeRabbitAuthReading =
  | { state: "ready" }
  | { state: "signed-out"; problem: string; diagnostic: string }
  | { state: "unverified"; problem: string; diagnostic: string };

export async function codeRabbitAuthReading(execute: (argv: string[]) => Promise<RunResult>): Promise<CodeRabbitAuthReading> {
  const auth = await execute(["auth", "status", "--agent"]);
  const unavailable = { problem: AUTH_UNAVAILABLE, diagnostic: AUTH_UNAVAILABLE_DIAGNOSTIC };
  const unconfirmed = { problem: AUTH_UNCONFIRMED, diagnostic: AUTH_UNCONFIRMED_DIAGNOSTIC };
  if (auth.code !== 0 || auth.outcomeUnknown || auth.overflowed) return { state: "unverified", ...unavailable };
  let events: Record<string, unknown>[];
  try {
    events = auth.stdout.trim().split(/\r?\n/).map((s) => JSON.parse(s) as Record<string, unknown>);
  } catch { return { state: "unverified", ...unconfirmed }; }
  if (events.some((e) => e?.type === "error")) return { state: "unverified", ...unconfirmed };
  const signedIn = events.some((e) => e?.type === "status" && e.authenticated === true);
  if (signedIn && !events.some((e) => e?.type === "action_required")) return { state: "ready" };
  const signedOut = events.some((e) => e?.type === "action_required" || (e?.type === "status" && e.authenticated === false));
  return signedOut ? { state: "signed-out", ...unconfirmed } : { state: "unverified", ...unconfirmed };
}

/** The stored-authentication gate alone, for a CLI already known to be compatible. */
export async function codeRabbitAuthProblem(execute: (argv: string[]) => Promise<RunResult>): Promise<string | null> {
  const reading = await codeRabbitAuthReading(execute);
  return reading.state === "ready" ? null : reading.problem;
}

export async function probeCodeRabbit(): Promise<{ command: string; env: NodeJS.ProcessEnv; error: string | null } | { error: string }> {
  const executable = await locateExecutable("coderabbit");
  if (!executable) return { error: "CodeRabbit CLI was not found. Install CodeRabbit >=0.9.1" };
  const env: NodeJS.ProcessEnv = { ...scrubCheckEnv(executable.env, readToken()), ...CODERABBIT_MANAGED_ENV };
  let error: string | null;
  try { error = await codeRabbitReadiness((args) => run(executable.path, args, { env, timeoutMs: 7000, maxBuffer: 64 * 1024 })); }
  finally { cleanupAgentSubprocessEnv(env); }
  // Retain the scrubbed values, never the locator's credential-bearing environment.
  // The supervisor creates the review's state home; the probe's home is already gone.
  const { MISSION_HOME: _probeStateHome, ...reviewEnv } = env;
  return { command: executable.path, env: reviewEnv, error };
}

export async function resolveCodeRabbitComparison(input: {
  repoRoot: string; headSha: string | null; yaml: CodeRabbitConfigSnapshot; command: WorkflowCommandView;
  /**
   * Stacked pull requests: the refreshed, verified parent base a stacked task is reviewed
   * against. When it names one, it is the comparison base - the same base the Persona diff
   * used - and an operator's explicit baseRef does not override it. Throws when the refresh
   * failed; that becomes the comparison's error.
   */
  stackBase?: () => Promise<{ branch: string; sha: string; repoRoot: string } | null>;
}): Promise<CodeRabbitComparison> {
  const rule = input.command.overrides.find((r) => r.repoRoot === input.repoRoot)?.review;
  const tuning: CodeRabbitTuning = rule ?? { kind: "coderabbit", baseRef: null, severity: "major" };
  return { interpreterVersion: 1, yaml: input.yaml, severity: tuning.severity,
    command: [...(tuning.command ?? input.command.defaultCommand ?? DEFAULT_CODERABBIT_COMMAND)],
    ruleRevision: input.command.revision, timeoutMs: effectiveWorkflowCommandTimeoutMs(input.command), maxRuns: input.command.maxRuns,
    ...await resolveReviewComparison(input, tuning.baseRef) };
}

/** Same recipe for arbitrary workflows and No-Mistakes. YAML and allowance precede probes. */
export async function runCodeRabbit(input: RunCheckInput, deps: CheckRunDeps): Promise<CheckResult> {
  const yaml = input.coderabbit?.yaml;
  let comparison: CodeRabbitComparison | null = null;
  let reservation: CheckRunReservation | undefined;
  let chargeRun = false;
  let failureStage = "preflight";
  const summary = (status: "skipped" | "incomplete", diagnostic: string): import("@shared/workflow.ts").CodeRabbitReviewSummary => ({
    comparison: comparison ?? { interpreterVersion: 1,
      yaml: yaml ?? { source: ".coderabbit.yaml", digest: null, enabled: false, state: "missing", diagnostic: "No captured YAML" },
      head: input.headSha && FULL_SHA.test(input.headSha) ? input.headSha : null, baseRef: null, baseTip: null, mergeBase: null, empty: false,
      severity: "major", ruleRevision: input.command?.revision ?? 1, timeoutMs: input.command ? effectiveWorkflowCommandTimeoutMs(input.command) : WORKFLOW_COMMAND_DEFAULT_TIMEOUT_MS.coderabbit,
      maxRuns: input.command?.maxRuns ?? defaultWorkflowCommandMaxRuns("coderabbit"), error: status === "incomplete" ? diagnostic : null },
    status, counts: { critical: 0, major: 0, minor: 0, trivial: 0, info: 0, none: 0 }, diagnostic, titles: [],
  });
  const skip = (status: "skipped" | "budget_spent", warning: string, error?: string): CheckResult => ({ kind: "outcome", outcome: {
    slot: "coderabbit", status, command: null, exitCode: null, output: "", truncatedBytes: 0, artifacts: [], timeoutMs: null,
    note: `Warning: ${warning}. YAML ${yaml?.source ?? ".coderabbit.yaml"}: ${yaml?.state ?? "missing"}; digest ${yaml?.digest ?? "unavailable"}.`, warning, review: { ...summary("skipped", warning), ...(status === "budget_spent" ? { remainingRuns: 0 } : {}) }, ...(error ? { diagnosticError: error } : {}),
  } });
  // Setup is the remedy for installation, login, trust and runtime problems. A review that ran
  // and returned a result Mission Control cannot accept is a different problem: Setup would
  // show a healthy CLI, so point at the retained output instead.
  // `remedy` replaces both: a problem neither Setup nor the retained output can fix says its own.
  const remainingRuns = () => Math.max(0,
    (comparison?.maxRuns ?? input.command?.maxRuns ?? defaultWorkflowCommandMaxRuns("coderabbit"))
      - (reservation?.spent ?? 0) - Number(chargeRun));
  const block = (reason: string, review?: import("@shared/workflow.ts").CodeRabbitReviewSummary, artifacts?: import("@shared/workflow.ts").WorkflowCommandArtifactDescriptor[], setup = true, remedy?: string): CheckResult => ({ kind: "action_required", reason: remedy ? `Error: ${reason}. ${remedy}.` : setup ? `Error: ${reason}. Open ${CODERABBIT_SETUP}.` : `Error: ${reason}. Inspect this attempt's retained CodeRabbit output.`, review: { ...(review ?? summary("incomplete", reason)), remainingRuns: remainingRuns() }, ...(artifacts ? { artifacts } : {}), ...(setup ? { setup: true } : {}) });
  if (!yaml?.enabled) return skip("skipped", yaml?.diagnostic ?? "No captured explicit YAML enablement; submit again to refresh configuration", yaml && ["invalid", "unreadable"].includes(yaml.state) ? yaml.diagnostic : undefined);
  const preflight = () => {
    if (input.coderabbit?.retryAt && input.coderabbit.retryAt > Date.now()) return block(`CodeRabbit vendor wait is active until ${new Date(input.coderabbit.retryAt).toISOString()}. Retry after that time`);
    const denied = checkBlockedReason(input.policy, input.cwd, input.repoRoot);
    if (denied) return block(denied);
    if (!input.repoRoot || !deps.execute) return block("CodeRabbit execution runtime or repository is unavailable");
    // Uncommitted work is reviewed through the capture's review snapshot, so `dirty` means a
    // submission captured before snapshots existed: it has no commit holding what it reviewed.
    if (input.coderabbit?.dirty) return block("This submission captured uncommitted changes without a review snapshot", undefined, undefined, false, "Submit again so Mission Control captures one");
    if (yaml.committed === false) return block(`The captured ${yaml.source} is not the one in the reviewed commit`, undefined, undefined, false, `Make sure ${yaml.source} is not ignored, then submit again`);
    return null;
  };
  try {
    const prior = input.coderabbit?.priorCleanReview;
    const priorComparison = prior?.review.comparison;
    let comparisonRequest: Promise<CodeRabbitComparison> | undefined;
    if (prior && priorComparison?.command && !priorComparison.command.includes("--fresh") && !preflight()) {
      failureStage = "comparison";
      // Resolve a reuse candidate before asking for an execution. If it cannot be reused,
      // keep the allowance-first outcome for an exhausted run, including comparison errors.
      comparisonRequest = Promise.resolve().then(input.coderabbit!.comparison);
      const candidate = await comparisonRequest.catch(() => null);
      if (candidate?.head && candidate.mergeBase && !candidate.error && isDeepStrictEqual(priorComparison, candidate)) {
        const diagnostic = `Reused complete CodeRabbit review with no findings from attempt ${prior.attemptId} at unchanged head ${candidate.head}`;
        const remainingRuns = Math.max(0, candidate.maxRuns - (input.coderabbit?.readRunsSpent?.() ?? 0));
        return { kind: "outcome", outcome: {
          slot: "coderabbit", status: "passed", command: null, exitCode: null, output: "", truncatedBytes: 0,
          artifacts: [], timeoutMs: null, note: diagnostic, review: { ...prior.review, diagnostic, remainingRuns },
        } };
      }
    }
    failureStage = "preflight";
    reservation = input.reserveRun?.();
    if (reservation && !reservation.granted && input.coderabbit?.incompleteReview) return block(
      "CodeRabbit review remains incomplete and its execution allowance is exhausted", undefined, undefined, false,
      `${CODERABBIT_ALLOWANCE_REMEDY}; no additional credits were authorized`);
    if (reservation && !reservation.granted) return skip("budget_spent", `CodeRabbit execution allowance exhausted (${reservation.spent}/${input.command?.maxRuns ?? defaultWorkflowCommandMaxRuns("coderabbit")}). Review skipped without checking availability`);
    const problem = preflight();
    if (problem) return problem;
    failureStage = "comparison";
    comparison = await (comparisonRequest ?? input.coderabbit!.comparison());
    if (comparison.error || !comparison.head || !comparison.mergeBase) return block(comparison.error ?? "CodeRabbit comparison is unavailable");
    failureStage = "readiness";
    const ready = await (deps.codeRabbitProbe ?? probeCodeRabbit)();
    if (ready.error || !("command" in ready)) return block(ready.error ?? "CodeRabbit is unavailable");
    const argv = codeRabbitReviewArgv(comparison.command ?? CODERABBIT_REVIEW_COMMAND, comparison.severity, comparison.mergeBase);
    const command = [ready.command, ...argv.slice(1)];
    // Charge ambiguous executor exceptions. Only a typed runtime or provider failure
    // establishes that the attempt ended for an infrastructure reason.
    chargeRun = true;
    failureStage = "execution";
    const execution = await deps.execute!({ slot: "coderabbit", command, repoRoot: input.repoRoot!, workingSubpath: "", headSha: comparison.head,
      timeoutMs: comparison.timeoutMs, coderabbit: comparison, env: ready.env });
    chargeRun = execution.kind === "exited";
    // A review takes its tree without a dependency claim, so it is never decided by one.
    if (execution.kind === "unavailable" || execution.kind === "decided") return block(execution.note);
    if (execution.kind === "infrastructure") return block(execution.reason, execution.review, execution.artifacts);
    failureStage = "result";
    const review = execution.review;
    if (review?.status === "incomplete" && review.retryableConnection) {
      chargeRun = false;
      return {
        kind: "retryable_connection", reason: review.diagnostic, artifacts: execution.artifacts,
        review: { ...review, remainingRuns: remainingRuns() },
      };
    }
    if (!review || review.status === "incomplete") return block(review?.diagnostic ?? "CodeRabbit semantic result is missing", review, execution.artifacts,
      !review || review.diagnostic === CODERABBIT_OPERATOR_ACTION);
    const skipped = review.status === "skipped";
    const note = `${review.diagnostic}. Head ${comparison.head}; base ${comparison.baseRef} at ${comparison.baseTip}; merge-base ${comparison.mergeBase}; threshold ${comparison.severity}. ${Object.entries(review.counts).map(([severity, count]) => `${severity}: ${count}`).join(", ")}. YAML ${comparison.yaml.source}: ${comparison.yaml.state}; digest ${comparison.yaml.digest}. ${review.titles.join("; ")}`.slice(0, WORKFLOW_EXECUTION_LIMITS.verdictSummary);
    return { kind: "outcome", outcome: { slot: "coderabbit", status: skipped ? "skipped" : execution.exitCode === 2 ? "failed" : "passed", command,
      exitCode: execution.exitCode, output: execution.output, truncatedBytes: execution.truncatedBytes, artifacts: execution.artifacts ?? [], timeoutMs: comparison.timeoutMs,
      note, review: { ...review, remainingRuns: remainingRuns() }, ...(skipped ? { warning: review.diagnostic } : {}),
    } };
  } catch (error) {
    // Raw exception messages and names can contain credentials, paths or vendor output.
    workflowLog("error", { event: "coderabbit_exception", state: failureStage,
      error: error instanceof SyntaxError ? "SyntaxError" : error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "unknown" });
    return block("CodeRabbit execution could not establish a complete review. Inspect daemon diagnostics and any retained output before retrying");
  } finally { if (!chargeRun) reservation?.release?.(); }
}
