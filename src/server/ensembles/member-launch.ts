import type { Registry } from "../registry.ts";
import type { TaskManager } from "../tasks.ts";
import type { EnsembleTaskGateway, MemberDispatchRequest, MemberTaskRequest, TaskGatewayStatus } from "./engine.ts";
import { SUBMIT_ENSEMBLE_RESULT_TOOL } from "./submission-tool.ts";

/**
 * The production bridge between the engine and TaskManager/Registry.
 *
 * The engine owns no Task lifecycle; this is where its abstract asks - "create a backlog member",
 * "dispatch it at this commit", "is its task still alive?" - become real calls on TaskManager and
 * reads off the Registry. Keeping it behind `EnsembleTaskGateway` is what lets an engine test drive
 * the whole state machine against a fake that never spawns an agent, and keeps the one vendor
 * default a member launch needs (a null agent becomes the primary harness) out of the engine.
 *
 * Every dispatch requires exactly one Mission MCP tool: `submit_ensemble_result`. That is the
 * launch-scoped capability that lets a Claude or Codex member the daemon dispatched submit even
 * when the operator never installed the global MCP integration.
 */
export class TaskManagerGateway implements EnsembleTaskGateway {
  constructor(
    private readonly tasks: TaskManager,
    private readonly registry: Registry,
  ) {}

  create(request: MemberTaskRequest): void {
    this.tasks.create({
      repoRoot: request.repoRoot,
      intent: request.intent,
      title: request.title,
      // A member implements and is compared; it is an ordinary implementation task, so it takes the
      // same kind a dispatched implementation does. It never opens a PR - its prompt forbids that.
      kind: "ship",
      agent: request.agent,
      model: request.model ?? undefined,
      effort: request.effort ?? undefined,
      backlog: true,
    }, { id: request.taskId });
  }

  dispatch(request: MemberDispatchRequest): void {
    // Fire-and-forget through the owner: TaskManager provisions the worktree at the pinned base,
    // launches the agent, and streams status over SSE. The engine learns the outcome from durable
    // Task state on its next reconcile, never from this call returning.
    void this.tasks.dispatch(request.taskId, {
      baseSha: request.baseSha,
      missionMcp: { tools: [SUBMIT_ENSEMBLE_RESULT_TOOL] },
    });
  }

  async cancel(taskId: string): Promise<void> {
    const result = await this.tasks.cancel(taskId);
    if (!result.ok) {
      throw new Error(result.error ?? `could not cancel member Task ${taskId}`);
    }
  }

  status(taskId: string): TaskGatewayStatus | null {
    return this.registry.getTask(taskId)?.status ?? null;
  }

  worktreePath(taskId: string): string | null {
    return this.registry.getTask(taskId)?.worktreePath ?? null;
  }

  sessionId(taskId: string): string | null {
    return this.registry.getTask(taskId)?.sessionId ?? null;
  }

  observedModel(_taskId: string): string | null {
    // The member's observed model is session telemetry a later phase records; the attempt keeps its
    // requested model in the meantime, and null here is honestly "not yet observed", never zero.
    return null;
  }
}
