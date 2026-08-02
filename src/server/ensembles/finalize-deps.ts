import type { Registry } from "../registry.ts";
import { TaskIdCollisionError, type TaskManager } from "../tasks.ts";
import type { WorkflowManager } from "../workflows/manager.ts";
import { injectPrompt, paneAcceptsPrompt, resetToCommit } from "../actions.ts";
import {
  driverClearFor,
  resetSession,
  type PendingTurnResetBoundary,
  type SdkClearer,
} from "../reset.ts";
import { resolveEnsembleRef } from "../git/ensemble-snapshot.ts";
import { run } from "../util/exec.ts";
import { SUBMIT_ENSEMBLE_RESULT_TOOL } from "./submission-tool.ts";
import type { EnsembleFinalizeDeps, EnsembleWorkflowHandoffDeps, TaskGatewayStatus } from "./engine.ts";
import type { ResolvedWorkflowVersion } from "./manager.ts";
import type { EnsembleJson } from "@shared/ensemble.ts";

/**
 * The production finalization authorities the engine is handed at daemon construction.
 *
 * This is the one place the engine's abstract finalization asks - "make this session exact", "reap
 * this loser", "hand this winner to a Workflow" - become real calls on TaskManager, the Registry,
 * `resetSession`, the pane-injection path, and WorkflowManager. Keeping every effect behind
 * `EnsembleFinalizeDeps` is what lets a finalization test drive the whole state machine against a
 * fake that never touches Git, a real agent, or a real Workflow, and it keeps the engine free of a
 * dependency on any of them.
 *
 * The Workflow slice reaches WorkflowManager's EXTERNAL boundary only (`ensureExternalBinding` /
 * `submitExternal`), never the internal manual methods: the daemon-owned handoff goes through the
 * same active-note conflict, exact-clean capture, and idempotency the manual path uses, and never
 * imports the ensemble store into Workflow code.
 */
export function createFinalizeDeps(deps: {
  registry: Registry;
  tasks: TaskManager;
  workflows: WorkflowManager;
  /** Present so an embedded winner's context can be cleared - see `restoreWinner`. */
  sdk?: SdkClearer;
  /** Coordinates pending delivery with the winner reset boundary. */
  pendingTurns?: PendingTurnResetBoundary;
}): EnsembleFinalizeDeps {
  const { registry, tasks, workflows } = deps;

  const workflow: EnsembleWorkflowHandoffDeps = {
    ensureBinding({ sessionId, workflowVersionId, sourceId, resultId }) {
      const result = workflows.ensureExternalBinding({
        source: { kind: "ensemble", sourceId, resultId },
        workflowVersionId,
        sessionId,
      });
      if (result.ok) return { ok: true, bindingId: result.value.binding.id, created: result.value.created };
      const reason =
        result.reason === "conflict"
          ? "conflict"
          : result.reason === "ineligible_session"
            ? "ineligible"
            : result.reason === "unsupported_mode" || result.reason === "session_unavailable" || result.reason === "not_found"
              ? "unavailable"
              : "other";
      return { ok: false, reason, detail: result.message };
    },
    async submit({ bindingId, sourceId, resultId, expectedHeadSha }) {
      const result = await workflows.submitExternal(bindingId, {
        source: { kind: "ensemble", sourceId, resultId },
        expectation: { expectedHeadSha, requireCleanWorktree: true },
      });
      if (result.ok) return { ok: true, runId: result.value.run.id, submissionId: result.value.submission.id };
      const reason =
        result.reason === "artifact_mismatch" || result.reason === "stale_capture" || result.reason === "unchanged_evidence"
          ? "mismatch"
          : result.reason === "conflict"
            ? "conflict"
            : result.reason === "unsupported_mode" || result.reason === "session_unavailable" || result.reason === "not_found" || result.reason === "inactive_binding"
              ? "unavailable"
              : "other";
      return { ok: false, reason, detail: result.message };
    },
  };

  return {
    async verifyArtifact({ locator, repoPath }) {
      const ref = readRef(locator);
      if (ref === null) return null;
      return resolveEnsembleRef(repoPath, ref);
    },

    async sessionSafeToRebind(sessionId) {
      const session = registry.getSession(sessionId);
      if (!session) return false;
      // The exact safe-idle predicate `TaskManager.assign` re-checks before it rebinds an agent:
      // idle, live hook instrumentation, and no review parked on a human.
      if (session.state !== "idle" || !session.instrumented || session.pendingReviews > 0) return false;
      const probe = await paneAcceptsPrompt(session);
      return probe.ok;
    },

    async restoreWinner({ sessionId, snapshotSha }) {
      const session = registry.getSession(sessionId);
      if (!session) return { ok: false, detail: "the winner session is gone" };
      // Through `resetSession`, so every registered session-scoped family (queue, drafts, message
      // log, observed effort, work episode) is cleared once, and through
      // `resetToCommit` for the git half so the branch is reset to the exact snapshot and kept.
      const result = await resetSession(
        registry,
        session,
        true,
        (s, clear, lockOwner, driverClear) =>
          resetToCommit(s, snapshotSha, clear, undefined, lockOwner, driverClear),
        driverClearFor(deps.sdk),
        deps.pendingTurns,
      );
      if (!result.ok) {
        return { ok: false, detail: result.error ?? "the winner reset failed" };
      }
      return result.cleared && result.workIdentityReady
        ? { ok: true }
        : {
            ok: false,
            detail: "the winner context was not cleared/rebound yet; retry",
          };
    },

    async worktreeHead({ worktreePath }) {
      const head = await run("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
      const status = await run("git", ["-C", worktreePath, "status", "--porcelain"]);
      return {
        headSha: head.code === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null,
        clean: status.code === 0 && status.stdout.trim() === "",
      };
    },

    async deliverContinuation({ sessionId, text }) {
      const session = registry.getSession(sessionId);
      if (!session) {
        return {
          ok: false,
          retryable: true,
          detail: "the winner session is gone",
        };
      }
      const r = await injectPrompt(session, text, undefined, () => registry.promptResourceBlockerForSession(session.id));
      return r.ok
        ? { ok: true }
        : {
            ok: false,
            retryable: r.pasted === false,
            detail: r.error ?? "the continuation could not be delivered",
          };
    },

    async materializeReplacement(request) {
      try {
        // Idempotent on the preallocated id: a matching retry returns the existing Task, a mismatch
        // throws. So a lost response or a restart reconciles to the SAME Task rather than a second.
        tasks.create(
          {
            repoRoot: request.repoRoot,
            intent: request.intent,
            title: request.title,
            kind: "ship",
            agent: request.agent,
            model: request.model ?? undefined,
            effort: request.effort ?? undefined,
            workflowId: null,
            backlog: true,
          },
          { id: request.taskId },
        );
      } catch (err) {
        if (err instanceof TaskIdCollisionError) {
          return { ok: false, detail: "the replacement task id collides with a different task" };
        }
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      const existing = registry.getTask(request.taskId);
      // Only dispatch a Task still in backlog: a resume may find it already dispatched, and
      // dispatching twice would provision a second worktree.
      if (existing && existing.status === "backlog") {
        const outcome = await tasks.dispatch(request.taskId, {
          baseSha: request.snapshotSha,
          missionMcp: { tools: [SUBMIT_ENSEMBLE_RESULT_TOOL] },
        });
        if (!outcome.ok) return { ok: false, detail: outcome.error };
      }
      return { ok: true };
    },

    replacementStatus(taskId) {
      const task = registry.getTask(taskId);
      if (!task) return { status: null, sessionId: null, worktreePath: null };
      return {
        status: (task.status as TaskGatewayStatus) ?? null,
        sessionId: task.sessionId ?? null,
        worktreePath: task.worktreePath ?? null,
      };
    },

    workflow,
  };
}

function readRef(locator: EnsembleJson): string | null {
  if (locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.ref === "string") {
    return locator.ref;
  }
  return null;
}

/**
 * Resolve an operator's Workflow placement to an immutable version plus a support verdict.
 *
 * The load-bearing field is `supported`: on this baseline only Preview + manual is executable as an
 * after-selection handoff, so a Live or Foreman-triggered version comes back unsupported with a
 * reason and creation refuses it - never a silent Preview downgrade. The version itself is immutable
 * and pinned, so a later edit or archive of the definition cannot re-aim a run created against it.
 */
export function resolveEnsembleWorkflowVersion(
  workflows: WorkflowManager,
  workflowId: string,
  version: number,
): ResolvedWorkflowVersion | null {
  const v = workflows.version(workflowId, version);
  if (!v) return null;
  const { triggerMode, deliveryMode, maxRepairRounds } = v.bindingDefaults;
  const supported = deliveryMode === "preview" && triggerMode === "manual";
  const unsupportedReason = supported
    ? null
    : deliveryMode !== "preview"
      ? "Live delivery is not available for an ensemble handoff on this build; only Preview is"
      : "This workflow's trigger mode is not available for an ensemble handoff on this build";
  return {
    workflowId,
    workflowVersionId: v.id,
    workflowVersion: v.version,
    workflowName: workflows.store.getWorkflow(workflowId)?.name ?? workflowId,
    triggerMode,
    deliveryMode,
    maxRepairRounds,
    completionPolicy: v.completionPolicy.kind,
    supported,
    unsupportedReason,
  };
}
