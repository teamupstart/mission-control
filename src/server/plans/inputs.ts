import path from "node:path";
import type { Task } from "@shared/types.ts";
import { PlanPublicationReceiptSchema, TaskPlanInputsSchema, type PlanIdentity, type PlanPublicationReceipt, type TaskPlanInput } from "@shared/managed-plans.ts";
import { openDb } from "../db.ts";
import { planRecord, planRevisionRecord, planRepositoryLocation, readPlanRevision, PlanStoreError } from "./store.ts";

export function publicationReceipt(input: PlanIdentity): PlanPublicationReceipt | null {
  const found = openDb().prepare("SELECT receipt FROM managed_plan_publications WHERE plan_id = ? AND revision = ?").get(input.planId, input.revision) as { receipt: string } | undefined;
  if (!found) return null;
  const receipt = PlanPublicationReceiptSchema.parse(JSON.parse(found.receipt));
  if (receipt.repoKey !== input.repoKey || receipt.planId !== input.planId || receipt.revision !== input.revision) throw new PlanStoreError("Plan publication receipt identity mismatch");
  if (receipt.manifestHash !== planRevisionRecord(input.planId, input.revision).manifest_hash) throw new PlanStoreError("Plan publication receipt manifest mismatch");
  return receipt;
}

/** Prepared task roots are canonical. No filename, slug, or latest-revision fallback. */
export function validatePlanInputs(inputs: TaskPlanInput[], roots: string[]): void {
  for (const input of TaskPlanInputsSchema.parse(inputs)) {
    const plan = planRecord(input.planId);
    if (!roots.includes(plan.repo_root) || plan.repo_key !== input.repoKey) throw new PlanStoreError("Pinned plan belongs to a repository outside this task's primary/attached set", 403);
    const { manifest } = readPlanRevision(input.planId, input.revision);
    for (const file of input.files) {
      if (!manifest.files.some((entry) => entry.name === file && entry.name.endsWith(".md"))) throw new PlanStoreError(`Pinned Markdown input is absent from revision ${input.revision}: ${file}`);
    }
  }
}

/** The source's existing durable merge edge remains authoritative for repository/mixed work. */
export function validatePlanInputDependencies(task: Pick<Task, "dependencies" | "planInputs">, requirePublished = false): void {
  for (const edge of task.dependencies) {
    if (edge.type === "plan" && !task.planInputs?.some((input) => input.planId === edge.planId && input.repoKey === edge.repoKey && input.revision === edge.revision)) {
      throw new PlanStoreError(`Plan publication prerequisite ${edge.planId} revision ${edge.revision} must also be an exact Markdown input`);
    }
  }
  for (const input of task.planInputs ?? []) {
    const saved = planRevisionRecord(input.planId, input.revision);
    if (publicationReceipt(input)) continue;
    const edge = task.dependencies.find((edge) => edge.type === "plan"
      ? edge.planId === input.planId && edge.repoKey === input.repoKey && edge.revision === input.revision
      : edge.type === "task" ? edge.taskId === saved.task_id && edge.episodeId === saved.episode_id
        : saved.task_id === null && edge.sessionId === saved.session_id && edge.episodeId === saved.episode_id);
    if (!edge) throw new PlanStoreError("Pinned plan input needs its exact local artifact prerequisite or originating task/session work episode merge dependency");
    if (requirePublished && (edge.type === "plan" || edge.satisfiedAt === null)) throw new PlanStoreError(`Plan ${input.planId} revision ${input.revision} is waiting for its publication prerequisite`);
  }
}

export function taskPlanInputProblem(task: Task): string | null {
  if (task.planInputError) return task.planInputError;
  if (task.planPolicyError) return task.planPolicyError;
  try {
    validatePlanInputs(task.planInputs ?? [], [task.repoRoot, ...task.extraRepos.map((r) => r.repoRoot)]);
    validatePlanInputDependencies(task, true);
    for (const edge of task.dependencies) {
      if (edge.type !== "plan") continue;
      validatePlanInputs([{ repoKey: edge.repoKey, planId: edge.planId, revision: edge.revision, files: ["plan.md"] }], [task.repoRoot, ...task.extraRepos.map((r) => r.repoRoot)]);
      if (!publicationReceipt(edge)) throw new PlanStoreError(`Plan ${edge.planId} revision ${edge.revision} has no publication receipt`);
    }
    return null;
  } catch (error) { return error instanceof Error ? error.message : "Pinned plan input is unavailable"; }
}

/** Read-only discovery at both delivery seams, independent of the current default or task kind. */
export async function taskPlanDiscovery(task: Task, fallbackRoot?: string | null): Promise<string> {
  const repositories = [{ repoRoot: task.repoRoot, checkout: task.worktreePath ?? fallbackRoot ?? task.repoRoot },
    ...task.extraRepos.map((r) => ({ repoRoot: r.repoRoot, checkout: r.worktreePath ?? r.repoRoot }))];
  const lines = ["## Plan inputs and discovery", "Check both plan locations for each repository. If historical names are ambiguous, report the ambiguity instead of choosing a plan."];
  for (const [index, repo] of repositories.entries()) {
    const repoSlot = `repo-${String(index + 1).padStart(2, "0")}`;
    const context = planRepositoryLocation(repo.repoRoot);
    lines.push(`- ${repoSlot}: repository plans ${path.join(repo.checkout, "docs/plans/")}; local plans ${context.localStore}/`);
    for (const input of task.planInputs ?? []) {
      if (input.repoKey !== context.repoKey) continue;
      lines.push(`  Exact input: read_plan({repoSlot: ${JSON.stringify(repoSlot)}, planId: ${JSON.stringify(input.planId)}, revision: ${input.revision}}). Read Markdown files: ${input.files.join(", ")}.`);
    }
  }
  lines.push("Use read_plan through Mission Control when the sandbox cannot read the local store. Pinned inputs must use their exact plan id, revision and Markdown files; never substitute a newer revision or a same-name file.");
  return lines.join("\n");
}
