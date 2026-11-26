import { InspectorVerdictSchema, DEFAULT_LOCAL_INSPECTOR_SEVERITY, type LocalInspectorFinding } from "@shared/inspector-review.ts";
import { approvedPath } from "@shared/repository-policy.ts";
import { checkBlockedReason, effectiveWorkflowCommandTimeoutMs, emptyWorkflowCommandView, type WorkflowCheckOutcome } from "@shared/workflow.ts";
import { resolveMaxDiffBytes } from "../inspector/review-core.ts";
import { planLocalReview, SEVERITY_RANK } from "../inspector/verdict.ts";
import { buildLocalReviewPrompt } from "../inspector/prompt.ts";
import { renderLocalInspectorFindings } from "../inspector/findings-text.ts";
import { scrubSecrets } from "../inspector/scrub.ts";
import { run } from "../util/exec.ts";
import { FULL_SHA, resolveCapturedCommit } from "./commit-id.ts";
import { reviewChangedPaths, type ReviewComparison } from "./review-comparison.ts";
import type { CheckResult, RunCheckInput } from "./checks.ts";

export interface LocalInspectorInput {
  preview: boolean;
  enabled: boolean;
  localReview: boolean;
  captured: boolean | undefined;
  hasArtifact: () => boolean;
  compare: () => Promise<ReviewComparison>;
  review: (prompt: string, timeoutMs: number, offDiffFindings: ReadonlyMap<string, string>) => Promise<string>;
  retain: (findings: readonly LocalInspectorFinding[]) => WorkflowCheckOutcome["artifacts"];
  goal: string;
  round: number;
  previous: () => { findings: readonly LocalInspectorFinding[]; incomplete?: boolean };
}

export function localInspectorFindingsText(findings: readonly LocalInspectorFinding[], budgetBytes: number) {
  return renderLocalInspectorFindings(findings, { budgetBytes }).text;
}

async function submittedDiff(root: string, mergeBase: string, head: string) {
  const cap = resolveMaxDiffBytes();
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("The Inspector diff byte cap is invalid");
  const gitDiff = async (paths: string[], budget: number, filter?: "D" | "ACMTUX") => {
    // Ask Git for NUL-delimited paths from the same file pairs as the patch. Account for
    // that metadata separately so only the patch spends the Inspector's byte budget.
    const result = await run("git", ["-C", root, "diff", "--raw", "-z", "--patch", "--no-renames", "--no-ext-diff",
      "--no-textconv", "--no-color", "--no-relative", "--submodule=short", ...(filter ? [`--diff-filter=${filter}`] : []),
      mergeBase, head, "--", ...(filter ? paths.map(path => `:(literal)${path}`) : [])],
    { timeoutMs: 10_000, maxBuffer: budget + 8 * 1024 * 1024 });
    if (result.overflowed) {
      throw new Error("The submitted diff exceeds the Inspector byte cap. Narrow the submission and retry");
    }
    if (result.code !== 0 || result.outcomeUnknown || result.stderr.trim()) {
      throw new Error("The submitted diff could not be read. Verify local Git refs and resubmit");
    }
    const split = result.stdout.indexOf("\0\0");
    const fields = split < 0 ? [] : result.stdout.slice(0, split).split("\0");
    const patch = split < 0 ? "" : result.stdout.slice(split + 2);
    const expected = new Set(paths);
    const invalidPatch = "The submitted diff could not be verified against the approved paths. Check local Git refs and retry";
    if (fields.length !== paths.length * 2 || !patch.startsWith("diff --git ")) throw new Error(invalidPatch);
    let expectedSections = 0;
    for (let i = 0; i < fields.length; i += 2) {
      const status = /^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ ([ACDMTUX])$/.exec(fields[i]!)?.[1];
      if (!status || !expected.delete(fields[i + 1]!)) throw new Error(invalidPatch);
      // Git renders one type-change pair as a deletion and an addition at the same path.
      expectedSections += status === "T" ? 2 : 1;
    }
    if ([...patch.matchAll(/(?:^|\n)diff --git /g)].length !== expectedSections) throw new Error(invalidPatch);
    if (Buffer.byteLength(patch) > budget) {
      throw new Error("The submitted diff exceeds the Inspector byte cap. Narrow the submission and retry");
    }
    return patch;
  };
  const { allowed, required } = await reviewChangedPaths(root, mergeBase, head);
  const safe = allowed.filter(approvedPath);
  if (safe.length === 0) return { paths: safe, text: "" };
  if (safe.length === allowed.length) return { paths: safe, text: scrubSecrets(await gitDiff(safe, cap)) };
  // Literal pathspecs also match descendants. A file/directory replacement splits into
  // deletes and additions, so ask for those groups separately and verify each batch above.
  const present = new Set(required);
  const parts: string[] = [];
  let remaining = cap;
  for (const filter of ["D", "ACMTUX"] as const) {
    const group = safe.filter(path => present.has(path) === (filter !== "D"));
    for (let i = 0; i < group.length; i += 32) {
      const patch = await gitDiff(group.slice(i, i + 32), remaining, filter);
      remaining -= Buffer.byteLength(patch);
      parts.push(patch);
    }
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
  const block = (reason: string, findingCount = 0): CheckResult => ({
    kind: "action_required", reason,
    localInspector: { ...provenance, status: "blocked", findingCount },
  });

  if (!local) return block("Local Inspector repository review runtime is unavailable.");
  if (!local.preview) return skip("Local Inspector skipped because its preview is off.");
  if (!local.enabled) return skip("Local Inspector skipped because Inspector is off.");
  if (!(local.captured ?? local.localReview)) return skip("Local Inspector skipped because local review was off for this submission.");
  const denied = checkBlockedReason(input.policy, input.cwd, input.repoRoot);
  if (denied) return block(`Local Inspector requires permission to read the submitted worktree. ${denied}`);

  const reservation = input.reserveRun?.();
  let reviewReturned = false;
  try {
    const { findings: previous, incomplete } = local.previous();
    if (reservation && !reservation.granted) {
      const note = `Local Inspector execution allowance is exhausted (${reservation.spent}/${command.maxRuns}).`;
      const knownBlockers = previous.some(finding => SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[threshold]);
      if (command.onBudgetExhausted === "skip" && !knownBlockers && !incomplete) return skip(`${note} Review skipped.`, "budget_spent");
      const blockers = knownBlockers ? " Earlier blocking findings remain unresolved." : "";
      const unfinished = incomplete ? " An earlier review could not be completed." : "";
      return block(`${note}${blockers}${unfinished} Raise the allowance in Library > Commands and retry.`, previous.length);
    }
    if (!input.repoRoot) return block("Local Inspector could not locate the submitted repository.");
    const comparison = await local.compare();
    provenance.baseRef = comparison.baseRef;
    provenance.mergeBase = comparison.mergeBase;
    const submittedHead = input.headSha && !FULL_SHA.test(input.headSha) && !comparison.error
      ? await resolveCapturedCommit(input.repoRoot, input.headSha)
      : input.headSha;
    if (comparison.error || !comparison.head || comparison.head !== submittedHead || !comparison.mergeBase) {
      return block("Local Inspector could not resolve the submitted comparison. Check the local origin/HEAD or stacked base and retry.");
    }
    if (!provenance.publicationTree || !local.hasArtifact()) {
      return block("Local Inspector requires the submitted checkout. Submit again to capture an active repository artifact.");
    }
    const diff = await submittedDiff(input.repoRoot, comparison.mergeBase, comparison.head);
    const changedPaths = new Set(diff.paths);
    const { prompt, prompted } = buildLocalReviewPrompt({
      goal: local.goal, diff: diff.text, changedPaths: diff.paths, open: previous, round: local.round,
    });
    const offDiffFindings = new Map(previous.filter(finding => prompted.has(finding.fingerprint) && !changedPaths.has(finding.path))
      .map(finding => [finding.fingerprint, finding.path]));
    const raw = await local.review(prompt, timeoutMs, offDiffFindings);
    reviewReturned = true;
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
    if (!reviewReturned && reservation?.granted) reservation.release?.();
  }
}
