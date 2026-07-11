import { randomUUID } from "node:crypto";
import type { AgentType, Task, TaskKind } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { Dispatcher, deriveTitle, teardownWorktree, tmuxSessionAlive } from "./dispatcher.ts";
import { kill } from "./actions.ts";

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
    // A restart severs the in-flight dispatch promises but leaves worktrees + tmux
    // sessions on disk. Reconcile every task that still holds resources by checking
    // whether its agent's tmux session survived.
    for (const t of registry.listTasks()) {
      const holdsResources =
        Boolean(t.worktreePath) &&
        (t.status === "dispatching" || t.status === "running" || t.status === "failed");
      if (holdsResources) void this.reconcileOnStartup(t);
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

  /**
   * Stop a task's crewmate and reclaim its (ephemeral) worktree, marking it
   * cancelled. A dispatched crewmate's tree is throwaway - to preserve work you
   * Focus and commit/PR it before cancelling - so cancel always reclaims, which
   * keeps the teardown model simple and leak-free (no keep/remove ambiguity that
   * an in-flight dispatch could race).
   */
  async cancel(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };

    if (t.sessionId) {
      const s = this.registry.getSession(t.sessionId);
      if (s) kill(s);
    }
    // teardownWorktree also kills the tmux session and returns/removes the tree.
    await teardownWorktree(t).catch(() => {});

    const now = Date.now();
    this.registry.upsertTask({
      ...t,
      status: "cancelled",
      worktreePath: null,
      branch: null,
      provider: null,
      tmuxSession: null,
      completedAt: now,
      updatedAt: now,
    });
    return { ok: true };
  }

  /** Record a task's outcome and reclaim its worktree - the crewmate's job is done. */
  async complete(id: string, outcome: string, outcomeUrl?: string): Promise<Task | null> {
    const t = this.registry.getTask(id);
    if (!t) return null;
    await teardownWorktree(t).catch(() => {});
    const now = Date.now();
    const updated: Task = {
      ...t,
      status: "done",
      outcome,
      outcomeUrl: outcomeUrl ?? null,
      error: null,
      worktreePath: null,
      branch: null,
      provider: null,
      tmuxSession: null,
      sessionId: null,
      completedAt: now,
      updatedAt: now,
    };
    this.registry.upsertTask(updated);
    return updated;
  }

  async remove(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (t.status === "running" || t.status === "dispatching") {
      return { ok: false, error: "cancel the task before removing it" };
    }
    // A terminal task may still hold a tree (e.g. a failed-but-alive dispatch);
    // reclaim it so removing the record never leaks a worktree/lease.
    if (t.worktreePath) await teardownWorktree(t).catch(() => {});
    this.registry.removeTask(id);
    return { ok: true };
  }

  /**
   * Reconcile a resource-holding task after a restart. If its agent's tmux session
   * survived, keep it (a `running`/`failed` task re-binds to its rediscovered
   * session; a `dispatching` one can't confirm its prompt landed, so it fails
   * honestly but keeps the live agent to Focus/Cancel). If the session is gone, the
   * agent died with the daemon - reclaim its worktree so nothing leaks invisibly.
   */
  private async reconcileOnStartup(t: Task): Promise<void> {
    const alive = t.tmuxSession ? await tmuxSessionAlive(t.tmuxSession) : false;
    if (alive) {
      if (t.status === "dispatching") {
        this.registry.upsertTask({
          ...t,
          status: "failed",
          error: "dispatch interrupted by a restart - Focus or Cancel it",
          updatedAt: Date.now(),
        });
      }
      return; // running / failed stay as loaded; their session re-binds by cwd
    }
    await teardownWorktree(t).catch(() => {});
    this.registry.upsertTask({
      ...t,
      status: "failed",
      error: "the agent's session did not survive a restart",
      worktreePath: null,
      branch: null,
      provider: null,
      tmuxSession: null,
      sessionId: null,
      updatedAt: Date.now(),
    });
  }
}
