import { randomUUID } from "node:crypto";
import { PLAN_APPROVAL_DECISION, PLAN_APPROVAL_OPTION, type PlanIdentity, type PlanPublicationReceipt, type PlanReadiness } from "@shared/managed-plans.ts";
import type { PlanDecision, PlanDecisionAnswer, Task } from "@shared/types.ts";
import { decisionLead, formatResponse, STANDING_APPROVAL_NOTE } from "@shared/review-item.ts";
import type { PlanPublicationContext } from "@shared/plan-publication.ts";
import type { WorkflowBinding, WorkflowSubmission, WorkflowVersion } from "@shared/workflow.ts";
import { openDb, loadHumanResolvedReviews } from "../db.ts";
import type { Registry } from "../registry.ts";
import type { TaskManager } from "../tasks.ts";
import type { WorkflowManager } from "../workflows/manager.ts";
import { WorkflowStore } from "../workflows/store.ts";
import { run } from "../util/exec.ts";
import { planRecord, planRevisionRecord, readPlanRevision, readPlanFile, PlanStoreError, type PlanAuthority } from "./store.ts";
import { publicationReceipt } from "./inputs.ts";
import { planAuthority, taskPlanAuthority } from "./authority.ts";

interface ApprovalRow {
  review_id: string; plan_id: string; revision: number; session_id: string; task_id: string | null;
  episode_id: string | null; manifest_hash: string; binding_id: string | null; workflow_version_id: string | null;
}

export const finalBundleDecision: PlanDecision = {
  id: PLAN_APPROVAL_DECISION,
  question: "Approve this complete, exact plan bundle for publication?",
  options: [{ id: PLAN_APPROVAL_OPTION, label: "Approve final bundle" }, { id: "revise", label: "Needs revision" }],
  multiSelect: false, allowOther: false,
};

/** The task a final-bundle review belongs to, or a refusal when it cannot carry a standing approval. */
function standingApprovalTask(reviewId: string): string {
  const row = openDb().prepare("SELECT task_id FROM managed_plan_reviews WHERE review_id = ?").get(reviewId) as { task_id: string | null } | undefined;
  if (!row) throw new PlanStoreError("Only a managed plan's final-bundle approval can approve future bundles", 400);
  if (!row.task_id) throw new PlanStoreError("This plan session has no task to remember future approvals for", 400);
  return row.task_id;
}

/** Refuses before the review is resolved, so a grant that cannot be kept leaves the question open. */
export function assertStandingApprovalGrantable(reviewId: string): void {
  standingApprovalTask(reviewId);
}

/** "Approve all future bundles for this task": recorded from the human answer that ticked it. */
export function grantStandingBundleApproval(reviewId: string): void {
  openDb().prepare("INSERT OR IGNORE INTO managed_plan_standing_approvals VALUES (?, ?, ?)").run(standingApprovalTask(reviewId), reviewId, Date.now());
}

export function hasStandingBundleApproval(taskId: string | null): boolean {
  return Boolean(taskId && openDb().prepare("SELECT 1 FROM managed_plan_standing_approvals WHERE task_id = ?").get(taskId));
}

/** The answer a standing approval gives to the final-bundle question. */
export function standingBundleAnswer(): { decisions: PlanDecision[]; selections: PlanDecisionAnswer[]; response: string } {
  const decisions = [finalBundleDecision];
  const selections = [{ decisionId: PLAN_APPROVAL_DECISION, selected: [PLAN_APPROVAL_OPTION], other: null }];
  return { decisions, selections, response: `${STANDING_APPROVAL_NOTE}\n\n${formatResponse(decisions, selections, decisionLead("plan-decisions"))}` };
}

/**
 * The bundle was approved automatically, but the agent asked other questions beside it; those
 * go to the operator as their own review. Recorded so the agent's answer says the bundle is
 * already approved, since that review no longer carries the approval question.
 */
export const STANDING_FOLLOW_UP_NOTE = "The final bundle was approved automatically: the operator chose to approve all future plan bundles for this task. Answers to the remaining decisions follow.";

export function recordStandingFollowUp(reviewId: string, approvalReviewId: string): void {
  openDb().prepare("INSERT OR IGNORE INTO managed_plan_standing_follow_ups VALUES (?, ?)").run(reviewId, approvalReviewId);
}

export function isStandingFollowUp(reviewId: string): boolean {
  return Boolean(openDb().prepare("SELECT 1 FROM managed_plan_standing_follow_ups WHERE review_id = ?").get(reviewId));
}

/** Both selection and pinned bindings require review-only completion. */
function localWorkflowCompatible(version: WorkflowVersion): boolean {
  return version.completionPolicy.kind === "none" && !version.graph.nodes.some((node) => node.kind === "session_action");
}

/** Selection stays explicit. A PR action or Inspector gate cannot be skipped in local mode. */
export function localWorkflowProblem(workflowId: string | null, store = new WorkflowStore()): string | null {
  if (!workflowId) return null;
  const workflow = store.getWorkflow(workflowId);
  const version = workflow?.currentVersionId ? store.getWorkflowVersionById(workflow.currentVersionId) : null;
  return !version ? "The selected local plan workflow is unavailable. Select Local Plan Validation, a review-only workflow, or None."
    : !localWorkflowCompatible(version)
      ? "Local plan-only publication requires a review-only workflow without session actions or a PR/Inspector gate. Select Local Plan Validation or use a ship task for code and plans."
      : null;
}

export function localPlanAuthorityContext(workflows: WorkflowManager, sessionId: string) {
  return compatibleContext(workflows.store, workflows.planPublicationContext(sessionId));
}

function compatibleContext(store: WorkflowStore, context: PlanPublicationContext) {
  if (context.owner === "unavailable") throw new PlanStoreError(context.reason);
  if (context.owner === "workflow") {
    const version = store.getWorkflowVersionById(context.workflowVersionId);
    if (!version || !localWorkflowCompatible(version)) throw new PlanStoreError("The bound workflow requires publication actions incompatible with a local-only plan. Bind Local Plan Validation or another review-only workflow explicitly.");
  }
  return context;
}

function exactWriter(authority: PlanAuthority, input: PlanIdentity): void {
  authority.assertCurrent?.();
  const plan = planRecord(input.planId);
  const saved = planRevisionRecord(input.planId, input.revision);
  readPlanRevision(input.planId, input.revision);
  if (plan.repo_key !== input.repoKey || plan.current_revision !== input.revision) throw new PlanStoreError("The reviewed plan revision is stale; save and approve the current final bundle");
  if (openDb().prepare("SELECT 1 FROM managed_plan_revisions WHERE plan_id = ? AND status != 'ready'").get(input.planId)) throw new PlanStoreError("A newer plan save is incomplete");
  if (saved.session_id !== authority.sessionId || saved.task_id !== authority.taskId || saved.episode_id !== authority.episodeId) throw new PlanStoreError("Plan revision belongs to a different work episode");
  if (plan.repo_root !== authority.repoRoot || saved.repo_slot !== authority.repoSlot || saved.checkout_root !== authority.checkout) throw new PlanStoreError("Plan revision belongs to a different repository scope");
}

export function validatePlanReview(authority: PlanAuthority, input: PlanIdentity, workflows: WorkflowManager): void {
  exactWriter(authority, input);
  if (readPlanRevision(input.planId, input.revision).manifest.policy.storage === "local") localPlanAuthorityContext(workflows, authority.sessionId);
}

export function bindPlanReview(authority: PlanAuthority, input: PlanIdentity, reviewId: string, workflows: WorkflowManager): void {
  validatePlanReview(authority, input, workflows);
  const context = workflows.planPublicationContext(authority.sessionId);
  if (context.owner === "unavailable") throw new PlanStoreError(context.reason);
  const saved = planRevisionRecord(input.planId, input.revision);
  openDb().prepare("INSERT OR IGNORE INTO managed_plan_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(reviewId, input.planId, input.revision, authority.sessionId, authority.taskId, authority.episodeId, saved.manifest_hash,
      context.owner === "workflow" ? context.bindingId : null, context.owner === "workflow" ? context.workflowVersionId : null);
}

function approval(authority: PlanAuthority, input: PlanIdentity, context: ReturnType<typeof compatibleContext>): ApprovalRow {
  exactWriter(authority, input);
  const candidates = openDb().prepare(`SELECT * FROM managed_plan_reviews WHERE plan_id = ? AND revision = ?
    AND session_id = ? AND task_id IS ? AND episode_id IS ? AND binding_id IS ? AND workflow_version_id IS ?`)
    .all(input.planId, input.revision, authority.sessionId, authority.taskId, authority.episodeId,
      context.owner === "workflow" ? context.bindingId : null, context.owner === "workflow" ? context.workflowVersionId : null) as unknown as ApprovalRow[];
  // Human resolutions are ordered oldest first. Choose the latest matching resolution
  // before checking its answer, so an earlier approval cannot survive a later refusal.
  const reviews = loadHumanResolvedReviews(authority.sessionId).filter((review) => candidates.some((candidate) => candidate.review_id === review.id));
  const latest = reviews.at(-1);
  // Millisecond timestamps cannot order simultaneous conflicting answers. Fail closed.
  if (!latest || !reviews.filter((review) => review.resolvedAt === latest.resolvedAt).every((review) =>
    review.status === "answered" && review.selections?.some((answer) => answer.decisionId === PLAN_APPROVAL_DECISION && answer.selected.length === 1 && answer.selected[0] === PLAN_APPROVAL_OPTION && !answer.other))) {
    throw new PlanStoreError("Waiting for explicit human approval of this complete final bundle and current workflow binding; dismissal or ordinary decisions are not approval");
  }
  const approved = candidates.find((candidate) => candidate.review_id === latest.id)!;
  if (approved.manifest_hash !== planRevisionRecord(input.planId, input.revision).manifest_hash) throw new PlanStoreError("Approved plan manifest changed");
  return approved;
}

function matchingValidation(input: PlanIdentity, approved: ApprovalRow, submissionId: string): boolean {
  return Boolean(openDb().prepare(`SELECT 1 FROM managed_plan_validations WHERE submission_id = ? AND plan_id = ?
    AND revision = ? AND review_id = ? AND binding_id IS ? AND workflow_version_id IS ? AND manifest_hash = ?`)
    .get(submissionId, input.planId, input.revision, approved.review_id, approved.binding_id, approved.workflow_version_id, approved.manifest_hash));
}

function episodeReceipt(authority: PlanAuthority, input: PlanIdentity): PlanPublicationReceipt | null {
  const receipt = publicationReceipt(input);
  if (receipt && (receipt.taskId !== authority.taskId || receipt.sessionId !== authority.sessionId || receipt.episodeId !== authority.episodeId)) throw new PlanStoreError("Publication receipt belongs to a different work episode");
  return receipt;
}

function authoredPlans(authority: Pick<PlanAuthority, "sessionId" | "taskId" | "episodeId">): Array<PlanIdentity & { repoSlot: string }> {
  const rows = openDb().prepare(`SELECT p.id, p.repo_key, p.current_revision, r.repo_slot FROM managed_plans p JOIN managed_plan_revisions r ON r.plan_id = p.id AND r.revision = p.current_revision
    WHERE r.session_id = ? AND r.task_id IS ? AND r.episode_id IS ? AND r.status = 'ready'`).all(authority.sessionId, authority.taskId, authority.episodeId) as unknown as { id: string; repo_key: string; current_revision: number; repo_slot: string }[];
  return rows.filter((r) => readPlanRevision(r.id, r.current_revision).manifest.policy.storage === "local")
    .map((r) => ({ planId: r.id, repoKey: r.repo_key, revision: r.current_revision, repoSlot: r.repo_slot }));
}

/** Freezes plan/approval identity before capture. A repair gets a new submission, never a new meaning for an old one. */
export function freezeLocalPlanSubmission(registry: Registry, workflows: WorkflowManager, binding: WorkflowBinding, submission: WorkflowSubmission): void {
  if (!binding.sessionId) return;
  const session = registry.getSession(binding.sessionId);
  const task = registry.taskForSession(binding.sessionId, session?.cwd ?? null);
  if (!session || task?.kind !== "plan" || task.planPolicy?.storage !== "local") return;
  const plans = authoredPlans(planAuthority(registry, session, "repo-01"));
  if (!plans.length) throw new PlanStoreError("Save and approve the complete local plan before submitting validation");
  for (const { repoSlot, ...input } of plans) {
    const authority = planAuthority(registry, session, repoSlot);
    const approved = approval(authority, input, localPlanAuthorityContext(workflows, authority.sessionId));
    if (approved.binding_id !== binding.id || approved.workflow_version_id !== binding.workflowVersionId) throw new PlanStoreError("Plan approval does not match this exact workflow binding/version");
    const existing = openDb().prepare("SELECT revision, review_id, manifest_hash FROM managed_plan_validations WHERE submission_id = ? AND plan_id = ?").get(submission.id, input.planId) as { revision: number; review_id: string; manifest_hash: string } | undefined;
    if (existing && (existing.revision !== input.revision || existing.review_id !== approved.review_id || existing.manifest_hash !== approved.manifest_hash)) throw new PlanStoreError("This workflow submission pins an older plan revision; submit the newly approved bundle as a new round");
    openDb().prepare("INSERT OR IGNORE INTO managed_plan_validations VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(submission.id, input.planId, input.revision, approved.review_id, binding.id, binding.workflowVersionId, approved.manifest_hash);
  }
}

/** Tool-less reviewers must receive the exact Markdown they are validating, not just paths. */
export function verifyLocalPlanEvidence(store: WorkflowStore, submissionId: string): void {
  const plans = openDb().prepare("SELECT plan_id, revision FROM managed_plan_validations WHERE submission_id = ?").all(submissionId) as unknown as { plan_id: string; revision: number }[];
  if (!plans.length) return;
  const artifacts = store.listSubmissionTextArtifacts(submissionId).filter((item) => item.availability === "retained");
  for (const plan of plans) {
    const { manifest } = readPlanRevision(plan.plan_id, plan.revision);
    for (const file of manifest.files.filter((f) => f.name.endsWith(".md"))) {
      const text = readPlanFile(plan.plan_id, plan.revision, file.name).toString("utf8");
      if (!artifacts.some((artifact) => artifact.content.includes(file.name) && artifact.content.includes(text))) throw new PlanStoreError(`Workflow evidence is missing the exact complete Markdown for ${manifest.slug} revision ${plan.revision}: ${file.name}. Register the final bundle text with submit_workflow_evidence; the workflow owns the next submission.`);
    }
  }
}

async function assertPlanOnly(task: Task): Promise<void> {
  if (task.kind !== "plan" || task.planPolicy?.storage !== "local") throw new PlanStoreError("A mixed code-and-plan or repository-policy task retains its ordinary merge prerequisite; local publication requires a task created for local plans");
  for (const repo of [{ checkout: task.worktreePath, base: task.baseSha }, ...task.extraRepos.map((r) => ({ checkout: r.worktreePath, base: r.baseSha }))]) {
    if (!repo.checkout || !repo.base) throw new PlanStoreError("Cannot verify the local plan-only task's checkout and base commit");
    const status = await run("git", ["-C", repo.checkout, "status", "--porcelain"]);
    const diff = await run("git", ["-C", repo.checkout, "diff", "--name-only", repo.base, "HEAD"]);
    if (status.code !== 0 || diff.code !== 0 || status.outcomeUnknown || diff.outcomeUnknown || status.overflowed || diff.overflowed || status.stdout.trim() || diff.stdout.trim()) throw new PlanStoreError("Local plan-only publication found repository changes or could not verify them. Ship code through its normal PR and merge workflow.");
  }
}

/** A recorded outcome or frozen review, not session liveness, owns this task's remaining work. */
export function localPlanRecoveryPending(registry: Registry, task: Task, store = new WorkflowStore(), bindingId?: string): boolean {
  if (task.kind !== "plan" || task.planPolicy?.storage !== "local" || task.status !== "running") return false;
  try {
    const authority = taskPlanAuthority(registry, task.id, "repo-01");
    const episode = registry.workEpisodeForTask(task.id)!;
    const binding = store.activeBindingForNote(episode.agentSessionId || episode.sessionId);
    if (bindingId && binding?.id !== bindingId) return false;
    return authoredPlans(authority).some(({ repoSlot, ...input }) => {
      const scoped = taskPlanAuthority(registry, task.id, repoSlot);
      exactWriter(scoped, input);
      if (episodeReceipt(scoped, input)) return true;
      if (!binding) return false;
      const context = compatibleContext(store, { owner: "workflow", bindingId: binding.id, workflowVersionId: binding.workflowVersionId, triggerMode: binding.triggerMode });
      const approved = approval(scoped, input, context);
      const run = store.latestRunForBinding(binding.id);
      const submission = run ? store.latestSubmission(run.id) : null;
      if (!run || !["running", "completed"].includes(run.status) || !submission
        || !["running", "completed"].includes(submission.status) || !submission.evidenceFingerprint) return false;
      return matchingValidation(input, approved, submission.id);
    });
  } catch { return false; }
}

/** Existing Workflow notifications and startup observation drive recovery. No polling owner. */
export class LocalPlanPublication {
  private inFlight = new Map<string, Promise<void>>();
  private unsubscribe: () => void;
  private unobserve: () => void;
  private stopped = false;
  constructor(private registry: Registry, private workflows: WorkflowManager, private tasks: TaskManager) {
    this.unsubscribe = registry.subscribe((event) => {
      if (event.type === "workflow_run_upsert" || event.type === "workflow_binding_upsert") this.reconcile();
    });
    this.unobserve = registry.onSessionsObserved(() => this.reconcile());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    this.unobserve();
    await Promise.allSettled(this.inFlight.values());
  }

  readiness(input: PlanIdentity): PlanReadiness {
    try {
      const receipt = publicationReceipt(input);
      readPlanRevision(input.planId, input.revision);
      if (receipt) return { version: 2, state: "published", reason: "Published locally; exact artifact prerequisites are released. Code merge prerequisites are unchanged.", receipt };
      const saved = planRevisionRecord(input.planId, input.revision);
      const session = this.registry.getSession(saved.session_id);
      if (!session) return { version: 2, state: "saved", reason: "Saved locally. Publication needs the originating work episode, final approval and applicable validation.", receipt: null };
      const approved = approval(planAuthority(this.registry, session, saved.repo_slot), input, localPlanAuthorityContext(this.workflows, session.id));
      const run = approved.binding_id ? this.workflows.store.latestRunForBinding(approved.binding_id) : null;
      return { version: 2, state: approved.binding_id ? "waiting-workflow" : "approved", reason: approved.binding_id
        ? `Final bundle approved; waiting for the exact workflow submission to pass${run ? ` (current run: ${run.status})` : ""}.`
        : "Final bundle approved; ready for publish_plan.", receipt: null };
    } catch (error) { return { version: 2, state: "blocked", reason: error instanceof Error ? error.message : String(error), receipt: null }; }
  }

  async publish(authority: PlanAuthority, input: PlanIdentity): Promise<PlanPublicationReceipt> {
    return this.publishRevision(authority, input, () => localPlanAuthorityContext(this.workflows, authority.sessionId));
  }

  private async publishRevision(authority: PlanAuthority, input: PlanIdentity, resolveContext: () => ReturnType<typeof compatibleContext>): Promise<PlanPublicationReceipt> {
    const task = authority.taskId ? this.registry.getTask(authority.taskId) : null;
    if (!task) throw new PlanStoreError("Local-only publication requires a managed plan task; mixed or taskless work keeps its merge publication boundary");
    await assertPlanOnly(task);
    const context = resolveContext();
    const approved = approval(authority, input, context);
    if (readPlanRevision(input.planId, input.revision).manifest.policy.storage !== "local") throw new PlanStoreError("Repository plans publish through their normal merge boundary");
    let submissionId: string | null = null;
    if (context.owner === "workflow") {
      const run = this.workflows.store.latestRunForBinding(context.bindingId);
      const submission = run ? this.workflows.store.latestSubmission(run.id) : null;
      if (!run || run.status !== "completed" || !submission || submission.status !== "completed" || !submission.evidenceFingerprint || !matchingValidation(input, approved, submission.id)) throw new PlanStoreError("Waiting for successful validation of this exact approved revision, binding and submission");
      verifyLocalPlanEvidence(this.workflows.store, submission.id);
      submissionId = submission.id;
    }
    authority.assertCurrent?.();
    const existing = episodeReceipt(authority, input);
    if (existing) return existing;
    const receipt: PlanPublicationReceipt = { ...input, version: 2, storage: "local", id: randomUUID(), reviewId: approved.review_id,
      sessionId: authority.sessionId, taskId: task.id, episodeId: authority.episodeId,
      bindingId: approved.binding_id, workflowVersionId: approved.workflow_version_id, submissionId,
      manifestHash: approved.manifest_hash, publishedAt: Date.now() };
    openDb().prepare("INSERT INTO managed_plan_publications VALUES (?, ?, ?) ON CONFLICT(plan_id, revision) DO NOTHING")
      .run(input.planId, input.revision, JSON.stringify(receipt));
    // The durable winner owns both the response and edge timestamp, including a contended insert.
    const published = episodeReceipt(authority, input);
    if (!published) throw new PlanStoreError("Publication receipt was not retained");
    this.release(published);
    return published;
  }

  private release(receipt: PlanPublicationReceipt): void {
    for (const task of this.registry.listTasks()) {
      let changed = false;
      const dependencies = task.dependencies.map((edge) => {
        if (edge.type !== "plan" || edge.planId !== receipt.planId || edge.revision !== receipt.revision || edge.repoKey !== receipt.repoKey || edge.satisfiedAt !== null) return edge;
        changed = true;
        return { ...edge, satisfiedAt: receipt.publishedAt };
      });
      if (changed) this.registry.upsertTask({ ...task, dependencies, updatedAt: Date.now() });
    }
  }

  reconcile(): void {
    if (this.stopped) return;
    const waiting = new Map<string, PlanIdentity>();
    for (const task of this.registry.listTasks()) {
      for (const edge of task.dependencies) {
        if (edge.type === "plan" && edge.satisfiedAt === null) waiting.set(`${edge.planId}:${edge.revision}`, edge);
      }
    }
    for (const input of waiting.values()) {
      try {
        const receipt = publicationReceipt(input);
        if (receipt) this.release(receipt);
      } catch { /* Corrupt receipts remain blocked at dispatch and in the reader. */ }
    }
    for (const task of this.registry.listTasks()) {
      if (task.kind !== "plan" || task.planPolicy?.storage !== "local" || task.status !== "running" || this.inFlight.has(task.id)) continue;
      const pending = (async () => {
        const authority = taskPlanAuthority(this.registry, task.id, "repo-01");
        const plans = authoredPlans(authority);
        if (!plans.length) return;
        const resolveContext = () => compatibleContext(this.workflows.store, this.workflows.taskPlanPublicationContext(task.id));
        // Decide before any I/O: an unbound draft has no automatic publication obligation.
        if (plans.some((input) => !publicationReceipt(input)) && resolveContext().owner !== "workflow") return;
        await assertPlanOnly(task);
        for (const { repoSlot, ...input } of plans) {
          const scoped = taskPlanAuthority(this.registry, task.id, repoSlot);
          exactWriter(scoped, input);
          const receipt = episodeReceipt(scoped, input);
          if (receipt) {
            this.release(receipt);
            continue;
          }
          // Unbound plans still require explicit publication; approval alone never completes one.
          if (resolveContext().owner !== "workflow") return;
          await this.publishRevision(scoped, input, resolveContext);
        }
        authority.assertCurrent?.();
        await this.tasks.complete(task.id, "Published approved local plan bundle", undefined, false);
      })().catch(() => { /* Readiness exposes the exact refusal; retry on the next owner notification. */ }).finally(() => this.inFlight.delete(task.id));
      this.inFlight.set(task.id, pending);
    }
  }
}
