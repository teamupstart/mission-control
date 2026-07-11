import { randomUUID } from "node:crypto";
import type { AgentType, Task, TaskKind } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { Dispatcher, deriveTitle, teardownWorktree } from "./dispatcher.ts";
import { kill } from "./actions.ts";
import { run } from "./util/exec.ts";

export interface CreateTaskInput {
  repoRoot: string;
  intent: string;
  title?: string;
  kind: TaskKind;
  agent: AgentType;
  /** Only add to the backlog (no worktree/session) - dispatch it later. */
  queue: boolean;
}

export interface Ok {
  ok: boolean;
  error?: string;
}

/**
 * Owns the task lifecycle: create/queue, kick off dispatch, cancel (tearing down
 * the live session + tmux + optional worktree), complete with an outcome, and
 * remove from the list. The registry is the single store; this class is the
 * policy layer routes call into - the task analog of ReviewManager.
 */
export class TaskManager {
  private dispatcher: Dispatcher;

  constructor(private registry: Registry) {
    this.dispatcher = new Dispatcher(registry);
    // A daemon restart can leave tasks stuck mid-dispatch (worktree/session state
    // is on disk, but the in-flight dispatch promise is gone). Re-reconcile them.
    for (const t of registry.listTasks()) {
      if (t.status === "dispatching") void this.reconcileDispatching(t);
    }
  }

  list(): Task[] {
    return this.registry.listTasks();
  }

  get(id: string): Task | undefined {
    return this.registry.getTask(id);
  }

  create(input: CreateTaskInput): Task {
    const now = Date.now();
    const title = input.title?.trim() || deriveTitle(input.intent);
    const task: Task = {
      id: randomUUID(),
      title,
      intent: input.intent,
      kind: input.kind,
      agent: input.agent,
      repoRoot: input.repoRoot,
      worktreePath: null,
      branch: null,
      provider: null,
      tmuxSession: null,
      sessionId: null,
      status: input.queue ? "queued" : "dispatching",
      outcome: null,
      outcomeUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
      completedAt: null,
    };
    this.registry.upsertTask(task);
    if (!input.queue) void this.dispatcher.dispatch(task.id);
    return task;
  }

  /**
   * Dispatch a queued task, or retry a failed one - but only when the failure was
   * cleanly torn down (no lingering worktree). A failed task that still holds a
   * worktree means its agent may still be running; the user should Cancel it first
   * (which reclaims the tree) rather than dispatch a second agent onto it.
   */
  dispatch(id: string): Task | null {
    const t = this.registry.getTask(id);
    if (!t) return null;
    if (t.status === "queued" || (t.status === "failed" && !t.worktreePath)) {
      void this.dispatcher.dispatch(id);
    }
    return this.registry.getTask(id) ?? t;
  }

  /** Stop a task's crewmate and mark it cancelled; optionally tear down its worktree. */
  async cancel(id: string, removeWorktree: boolean): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };

    if (t.sessionId) {
      const s = this.registry.getSession(t.sessionId);
      if (s) kill(s);
    }
    if (removeWorktree) {
      // teardownWorktree also kills the tmux session and returns/removes the tree.
      await teardownWorktree(t);
    } else if (t.tmuxSession) {
      await run("tmux", ["kill-session", "-t", t.tmuxSession], { timeoutMs: 10000 });
    }

    const now = Date.now();
    const kept = removeWorktree ? { worktreePath: null, branch: null, provider: null, tmuxSession: null } : {};
    this.registry.upsertTask({ ...t, ...kept, status: "cancelled", completedAt: now, updatedAt: now });
    return { ok: true };
  }

  complete(id: string, outcome: string, outcomeUrl?: string): Task | null {
    const t = this.registry.getTask(id);
    if (!t) return null;
    const now = Date.now();
    const updated: Task = {
      ...t,
      status: "done",
      outcome,
      outcomeUrl: outcomeUrl ?? null,
      error: null,
      completedAt: now,
      updatedAt: now,
    };
    this.registry.upsertTask(updated);
    return updated;
  }

  remove(id: string): Ok {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (t.status === "running" || t.status === "dispatching") {
      return { ok: false, error: "cancel the task before removing it" };
    }
    this.registry.removeTask(id);
    return { ok: true };
  }

  /**
   * Reconcile a task left in `dispatching` by a restart. A task only stays
   * `dispatching` because the initial prompt hadn't been delivered yet (status
   * flips to `running` immediately after send succeeds), so any tmux session that
   * survived is an agent sitting at an empty prompt - it would never do the task.
   * Don't fake a live crewmate: tear the orphan down and fail it so it can be
   * re-dispatched cleanly.
   */
  private async reconcileDispatching(t: Task): Promise<void> {
    await teardownWorktree(t).catch(() => {});
    this.registry.upsertTask({
      ...t,
      status: "failed",
      error: "dispatch interrupted by a restart - re-dispatch",
      worktreePath: null,
      branch: null,
      provider: null,
      tmuxSession: null,
      sessionId: null,
      updatedAt: Date.now(),
    });
  }
}
