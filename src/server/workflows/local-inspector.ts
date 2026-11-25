import { InspectorVerdictSchema, DEFAULT_LOCAL_INSPECTOR_SEVERITY, type LocalInspectorFinding } from "@shared/inspector-review.ts";
import { approvedPath } from "@shared/repository-policy.ts";
import { checkBlockedReason, effectiveWorkflowCommandTimeoutMs, emptyWorkflowCommandView, type WorkflowCheckOutcome } from "@shared/workflow.ts";
import { resolveMaxDiffBytes } from "../inspector/review-core.ts";
import { planLocalReview } from "../inspector/verdict.ts";
import { buildLocalReviewPrompt } from "../inspector/prompt.ts";
import { renderLocalInspectorFindings } from "../inspector/findings-text.ts";
import { scrubSecrets } from "../inspector/scrub.ts";
import { run } from "../util/exec.ts";
import { reviewChangedPaths, type ReviewComparison } from "./review-comparison.ts";
import type { CheckResult, RunCheckInput } from "./checks.ts";

export interface LocalInspectorInput {
  preview: boolean;
  enabled: boolean;
  localReview: boolean;
  captured: boolean | undefined;
  hasArtifact: () => boolean;
  compare: () => Promise<ReviewComparison>;
  review: (prompt: string, timeoutMs: number) => Promise<string>;
  retain: (findings: readonly LocalInspectorFinding[]) => WorkflowCheckOutcome["artifacts"];
  goal: string;
  round: number;
  previous: () => readonly LocalInspectorFinding[];
}

export function localInspectorFindingsText(findings: readonly LocalInspectorFinding[], budgetBytes: number) {
  return renderLocalInspectorFindings(findings, { budgetBytes }).text;
}

async function submittedDiff(root: string, mergeBase: string, head: string) {
  const cap = resolveMaxDiffBytes();
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("The Inspector diff byte cap is invalid");
  const gitDiff = async (paths: string[], budget: number) => {
    const result = await run("git", ["-C", root, "diff", "--no-renames", "--no-ext-diff",
      "--no-textconv", "--no-color", "--no-relative", mergeBase, head, "--", ...paths],
    { timeoutMs: 10_000, maxBuffer: budget + 1 });
    if (result.overflowed || Buffer.byteLength(result.stdout) > budget) {
      throw new Error("The submitted diff exceeds the Inspector byte cap. Narrow the submission and retry");
    }
    if (result.code !== 0 || result.outcomeUnknown || result.stderr.trim()) {
      throw new Error("The submitted diff could not be read. Verify local Git refs and resubmit");
    }
    return result.stdout;
  };
  const { allowed } = await reviewChangedPaths(root, mergeBase, head);
  const safe = allowed.filter(approvedPath);
  // Apply the same sensitive-path policy as the workload before giving the provider a diff.
  // In the common case a single git invocation also enforces the cap for the whole patch.
  if (safe.length === allowed.length) return { paths: safe, text: scrubSecrets(await gitDiff([], cap)) };
  const parts: string[] = [];
  let remaining = cap;
  for (let i = 0; i < safe.length; i += 32) {
    const patch = await gitDiff(safe.slice(i, i + 32).map(path => `:(literal)${path}`), remaining);
    remaining -= Buffer.byteLength(patch);
    parts.push(patch);
  }
  return { paths: safe, text: scrubSecrets(parts.join("")) };
}

export async function runLocalInspector(input: RunCheckInput): Promise<CheckResult> {
  const local = input.localInspector;
  const command = input.command ?? emptyWorkflowCommandView("inspector");
  const threshold = command.inspectorSeverity ?? DEFAULT_LOCAL_INSPECTOR_SEVERITY;
  const timeoutMs = effectiveWorkflowCommandTimeoutMs(command);
  const provenance = { publicationTree: input.publicationTreeOid ?? null, baseRef: null as string | null,
    mergeBase: null as string | null, blockingSeverity: threshold };
  const skip = (note: string, status: "skipped" | "budget_spent" = "skipped"): CheckResult => ({
    kind: "outcome", outcome: { slot: "inspector", status, command: null, exitCode: null,
      output: "", truncatedBytes: 0, artifacts: [], timeoutMs: null, note,
      localInspector: { ...provenance, status: "skipped", findingCount: 0 } },
  });
  const block = (reason: string): CheckResult => ({
    kind: "action_required", reason,
    localInspector: { ...provenance, status: "blocked", findingCount: 0 },
  });

  if (!local) return block("Local Inspector repository review runtime is unavailable.");
  if (!local.preview) return skip("Local Inspector skipped because its preview is off.");
  if (!local.enabled) return skip("Local Inspector skipped because Inspector is off.");
  if (!(local.captured ?? local.localReview)) return skip("Local Inspector skipped because local review was off for this submission.");
  const denied = checkBlockedReason(input.policy, input.cwd, input.repoRoot);
  if (denied) return block(`Local Inspector requires permission to read the submitted worktree. ${denied}`);

  const reservation = input.reserveRun?.();
  if (reservation && !reservation.granted) {
    const note = `Local Inspector execution allowance is exhausted (${reservation.spent}/${command.maxRuns}).`;
    return command.onBudgetExhausted === "skip" ? skip(`${note} Review skipped.`, "budget_spent")
      : block(`${note} Raise the allowance in Library > Commands and retry.`);
  }

  let completed = false;
  try {
    if (!input.repoRoot) return block("Local Inspector could not locate the submitted repository.");
    const comparison = await local.compare();
    provenance.baseRef = comparison.baseRef;
    provenance.mergeBase = comparison.mergeBase;
    if (comparison.error || !comparison.head || comparison.head !== input.headSha || !comparison.mergeBase) {
      return block("Local Inspector could not resolve the submitted comparison. Check the local origin/HEAD or stacked base and retry.");
    }
    if (!provenance.publicationTree || !local.hasArtifact()) {
      return block("Local Inspector requires the submitted checkout. Submit again to capture an active repository artifact.");
    }
    const diff = await submittedDiff(input.repoRoot, comparison.mergeBase, comparison.head);
    const changedPaths = new Set(diff.paths);
    const previous = local.previous();
    const { prompt, prompted } = buildLocalReviewPrompt({
      goal: local.goal, diff: diff.text, changedPaths: diff.paths, open: previous, round: local.round,
    });
    const raw = await local.review(prompt, timeoutMs);
    const verdict = InspectorVerdictSchema.parse(JSON.parse(raw));
    const plan = planLocalReview({
      verdict, changedPaths, previous, prompted,
      blockingSeverity: threshold,
    });
    const artifacts = local.retain(plan.findings);
    if (plan.findings.length > 0 && !artifacts.some(a => a.kind === "findings" && a.availability === "retained")) {
      return block("Local Inspector findings could not be retained. Check workflow artifact storage and retry.");
    }
    const status = plan.blocked ? "failed" : "passed";
    const count = plan.findings.length;
    completed = true;
    return { kind: "outcome", outcome: {
      slot: "inspector", status, command: null, exitCode: null, artifacts, timeoutMs,
      localInspector: { ...provenance, status, findingCount: count },
      output: localInspectorFindingsText(plan.findings, 3000),
      truncatedBytes: 0,
      note: plan.blocked ? `Local Inspector found issues at ${threshold} severity or above.`
        : count ? `Local Inspector found ${count} advisory ${count === 1 ? "issue" : "issues"}.`
        : "Local Inspector found no unresolved issues.",
    } };
  } catch (error) {
    return block(`Local Inspector could not complete repository review. ${scrubSecrets(error instanceof Error ? error.message : "Retry after checking repository access and provider setup.").slice(0, 1000)}`);
  } finally {
    if (!completed && reservation?.granted) reservation.release?.();
  }
}
