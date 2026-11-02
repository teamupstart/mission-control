import type { CodeRabbitComparison, CodeRabbitConfigSnapshot, CodeRabbitTuning, WorkflowCommandView } from "@shared/workflow.ts";
import { checkBlockedReason, defaultWorkflowCommandMaxRuns, effectiveWorkflowCommandTimeoutMs, WORKFLOW_COMMAND_DEFAULT_TIMEOUT_MS, WORKFLOW_EXECUTION_LIMITS } from "@shared/workflow.ts";
import { locateExecutable } from "../executables/locator.ts";
import { run, type RunResult } from "../util/exec.ts";
import { readToken } from "../../shared/harness-runtime.mjs";
import { cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";
import { scrubCheckEnv } from "./check-env.ts";
import { resolveCapturedCommit, FULL_SHA } from "./commit-id.ts";
import type { CheckResult, CheckRunDeps, CheckRunReservation, RunCheckInput } from "./checks.ts";
import { workflowLog } from "./log.ts";

export const CODERABBIT_SETUP = "Settings > Setup";
export const CODERABBIT_MANAGED_ENV = { CODERABBIT_CLI_DISABLE_AUTO_UPDATE: "true", CR_CLI_AUTH_TIMEOUT: "5000" };

export function codeRabbitVersionCompatible(output: string): boolean {
  const m = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim());
  return !!m && (Number(m[1]) > 0 || Number(m[2]) > 9 || Number(m[2]) === 9 && Number(m[3]) >= 1);
}

/** Never returns account identifiers, credentials or arbitrary stderr in fleet diagnostics. */
export async function codeRabbitReadiness(execute: (argv: string[]) => Promise<RunResult>, onVersion?: (version: string) => void): Promise<string | null> {
  const version = await execute(["--version"]);
  if (version.code !== 0 || version.outcomeUnknown || version.overflowed || !codeRabbitVersionCompatible(version.stdout)) return "CodeRabbit CLI >=0.9.1 is required. Install or upgrade the CLI";
  onVersion?.(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(version.stdout.trim())![1]!);
  const auth = await execute(["auth", "status", "--agent"]);
  if (auth.code !== 0 || auth.outcomeUnknown || auth.overflowed) return "CodeRabbit authentication is unavailable. Run coderabbit auth login using the daemon's effective HOME";
  try {
    const events = auth.stdout.trim().split(/\r?\n/).map((s) => JSON.parse(s) as Record<string, unknown>);
    if (!events.some((e) => e.type === "status" && e.authenticated === true)
      || events.some((e) => e.type === "error" || e.type === "action_required")) throw new Error();
  } catch { return "CodeRabbit stored authentication could not be confirmed. Run coderabbit auth login using the daemon's effective HOME"; }
  return null;
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
}): Promise<CodeRabbitComparison> {
  const rule = input.command.overrides.find((r) => r.repoRoot === input.repoRoot)?.review;
  const tuning: CodeRabbitTuning = rule ?? { kind: "coderabbit", baseRef: null, severity: "major" };
  const result: CodeRabbitComparison = { interpreterVersion: 1, yaml: input.yaml, severity: tuning.severity,
    ruleRevision: input.command.revision, baseRef: tuning.baseRef, baseTip: null, mergeBase: null, head: null, empty: false,
    timeoutMs: effectiveWorkflowCommandTimeoutMs(input.command), maxRuns: input.command.maxRuns, error: null };
  const git = async (args: string[]) => {
    const r = await run("git", ["-C", input.repoRoot, ...args], { timeoutMs: 5000, maxBuffer: 64 * 1024 });
    if (r.code !== 0 || r.outcomeUnknown || r.overflowed || r.stderr.trim()) throw new Error("Git comparison could not be resolved unambiguously. Correct local refs or set an explicit baseRef in Library > Commands, then retry");
    return r.stdout.trim();
  };
  try {
    if (!input.headSha) throw new Error("No captured committed head. Commit and submit again");
    result.head = await resolveCapturedCommit(input.repoRoot, input.headSha);
    if (!result.baseRef) {
      // A locally observed remote HEAD is reliable; guessing main/master is not.
      result.baseRef = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(result.baseRef) || result.baseRef.includes("..")) throw new Error("Set a valid explicit baseRef in Library > Commands and retry");
    result.baseTip = await git(["rev-parse", "--verify", "--end-of-options", `${result.baseRef}^{commit}`]);
    if (!FULL_SHA.test(result.baseTip)) throw new Error("The configured base did not resolve to one commit");
    result.mergeBase = await git(["merge-base", "--all", result.baseTip, result.head]);
    if (!FULL_SHA.test(result.mergeBase)) throw new Error("The comparison has no unique merge base");
    result.empty = (await git(["diff", "--name-only", result.mergeBase, result.head, "--"])) === "";
  } catch (error) { result.error = error instanceof Error ? error.message : "CodeRabbit comparison is unavailable"; }
  return result;
}

/** Same recipe for arbitrary workflows and No-Mistakes. YAML and allowance precede probes. */
export async function runCodeRabbit(input: RunCheckInput, deps: CheckRunDeps): Promise<CheckResult> {
  const yaml = input.coderabbit?.yaml;
  let comparison: CodeRabbitComparison | null = null;
  let reservation: CheckRunReservation | undefined;
  let started = false;
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
  const block = (reason: string, review?: import("@shared/workflow.ts").CodeRabbitReviewSummary, artifacts?: import("@shared/workflow.ts").WorkflowCommandArtifactDescriptor[]): CheckResult => ({ kind: "action_required", reason: `Error: ${reason}. Open ${CODERABBIT_SETUP}.`, review: { ...(review ?? summary("incomplete", reason)), remainingRuns: Math.max(0, (comparison?.maxRuns ?? input.command?.maxRuns ?? defaultWorkflowCommandMaxRuns("coderabbit")) - (reservation?.spent ?? 0) - (started ? 1 : 0)) }, ...(artifacts ? { artifacts } : {}), setup: true });
  if (!yaml?.enabled) return skip("skipped", yaml?.diagnostic ?? "No captured explicit YAML enablement; submit again to refresh configuration", yaml && ["invalid", "unreadable"].includes(yaml.state) ? yaml.diagnostic : undefined);
  reservation = input.reserveRun?.();
  if (reservation && !reservation.granted) return skip("budget_spent", `CodeRabbit execution allowance exhausted (${reservation.spent}/${input.command?.maxRuns ?? defaultWorkflowCommandMaxRuns("coderabbit")}). Review skipped without checking availability`);
  try {
    if (input.coderabbit?.retryAt && input.coderabbit.retryAt > Date.now()) return block(`CodeRabbit vendor wait is active until ${new Date(input.coderabbit.retryAt).toISOString()}. Retry after that time`);
    const denied = checkBlockedReason(input.policy, input.cwd, input.repoRoot);
    if (denied) return block(denied);
    if (!input.repoRoot || !deps.execute) return block("CodeRabbit execution runtime or repository is unavailable");
    if (input.coderabbit?.dirty || yaml.committed === false) return block("Submission contains uncommitted changes. Commit all reviewed content and create a new submission");
    failureStage = "comparison";
    comparison = await input.coderabbit!.comparison();
    if (comparison.error || !comparison.head || !comparison.mergeBase) return block(comparison.error ?? "CodeRabbit comparison is unavailable");
    failureStage = "readiness";
    const ready = await (deps.codeRabbitProbe ?? probeCodeRabbit)();
    if (ready.error || !("command" in ready)) return block(ready.error ?? "CodeRabbit is unavailable");
    const command = [ready.command, "review", "--agent", "--gate", comparison.severity, "--committed", "--base-commit", comparison.mergeBase];
    // An executor that throws cannot prove that the review never started. Keep its claim
    // unless a completed runtime result explicitly reports a pre-start refusal.
    started = true;
    failureStage = "execution";
    const execution = await deps.execute({ slot: "coderabbit", command, repoRoot: input.repoRoot, workingSubpath: "", headSha: comparison.head,
      timeoutMs: comparison.timeoutMs, coderabbit: comparison, env: ready.env });
    started = execution.kind !== "unavailable" && (execution.kind !== "infrastructure" || execution.started !== false);
    if (execution.kind === "unavailable") return block(execution.note);
    if (execution.kind === "infrastructure") return block(execution.reason, execution.review, execution.artifacts);
    failureStage = "result";
    const review = execution.review;
    if (!review || review.status === "incomplete") return block(review?.diagnostic ?? "CodeRabbit semantic result is missing", review, execution.artifacts);
    const skipped = review.status === "skipped";
    const note = `${review.diagnostic}. Head ${comparison.head}; base ${comparison.baseRef} at ${comparison.baseTip}; merge-base ${comparison.mergeBase}; threshold ${comparison.severity}. ${Object.entries(review.counts).map(([severity, count]) => `${severity}: ${count}`).join(", ")}. YAML ${comparison.yaml.source}: ${comparison.yaml.state}; digest ${comparison.yaml.digest}. ${review.titles.join("; ")}`.slice(0, WORKFLOW_EXECUTION_LIMITS.verdictSummary);
    return { kind: "outcome", outcome: { slot: "coderabbit", status: skipped ? "skipped" : execution.exitCode === 2 ? "failed" : "passed", command,
      exitCode: execution.exitCode, output: execution.output, truncatedBytes: execution.truncatedBytes, artifacts: execution.artifacts ?? [], timeoutMs: comparison.timeoutMs,
      note, review: { ...review, remainingRuns: Math.max(0, comparison.maxRuns - ((reservation?.spent ?? 0) + 1)) }, ...(skipped ? { warning: review.diagnostic } : {}),
    } };
  } catch (error) {
    // Raw exception messages and names can contain credentials, paths or vendor output.
    workflowLog("error", { event: "coderabbit_exception", state: failureStage,
      error: error instanceof SyntaxError ? "SyntaxError" : error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "unknown" });
    return block("CodeRabbit execution could not establish a complete review. Inspect daemon diagnostics and any retained output before retrying");
  } finally { if (!started) reservation?.release?.(); }
}
