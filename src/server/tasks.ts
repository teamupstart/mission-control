import { randomUUID } from "node:crypto";
import type { AgentType, Task, TaskKind } from "@shared/types.ts";
import type { Registry } from "./registry.ts";
import { Dispatcher, deriveTitle, teardownWorktree, tmuxSessionAlive } from "./dispatcher.ts";
import { injectPrompt, kill } from "./actions.ts";

export interface CreateTaskInput {
  repoRoot: string;
  intent: string;
  title?: string;
  kind: TaskKind;
  agent: AgentType;
  /** Only add to the backlog (no worktree/session) - dispatch it later. */
  backlog: boolean;
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
      // Every `dispatching` task needs reconciling even before it acquired a
      // worktree (a restart mid-provision would otherwise strand it forever);
      // running/failed/done only when they still hold a worktree to check/reclaim.
      const needsReconcile =
        t.status === "dispatching" ||
        (Boolean(t.worktreePath) &&
          (t.status === "running" || t.status === "failed" || t.status === "done"));
      if (needsReconcile) void this.reconcileOnStartup(t);
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
      status: input.backlog ? "backlog" : "dispatching",
      outcome: null,
      outcomeUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
      completedAt: null,
    };
    this.registry.upsertTask(task);
    if (!input.backlog) void this.dispatcher.dispatch(task.id);
    return task;
  }

  /**
   * Dispatch a backlog task, or retry a failed one - but only when the failure was
   * cleanly torn down (no lingering worktree). A failed task that still holds a
   * worktree means its agent may still be running; the user should Cancel it first
   * (which reclaims the tree) rather than dispatch a second agent onto it.
   */
  dispatch(id: string): Task | null {
    const t = this.registry.getTask(id);
    if (!t) return null;
    if (t.status === "backlog" || (t.status === "failed" && !t.worktreePath)) {
      void this.dispatcher.dispatch(id);
    }
    return this.registry.getTask(id) ?? t;
  }

  /**
   * Hand a backlog task to an agent that is ALREADY running, instead of cutting a
   * fresh worktree and launching one. This is what the board's drag-onto-an-idle-
   * agent gesture calls: the operator has an agent sitting free in the right repo
   * and would rather feed it than pay for another checkout.
   *
   * The critical difference from `dispatch`: an assigned task owns no worktree. The
   * agent keeps its own checkout - very often the operator's real one - so
   * `worktreePath` stays null, and that is precisely what keeps a later Cancel from
   * running `git worktree remove --force` over a directory we did not create.
   *
   * Every refusal below is a state conflict the caller should surface, not retry.
   */
  async assign(id: string, sessionId: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (t.status !== "backlog") return { ok: false, error: `task is ${t.status}, not in the backlog` };

    const s = this.registry.getSession(sessionId);
    if (!s) return { ok: false, error: "no such session" };
    if (s.state !== "idle") {
      return { ok: false, error: `that agent is ${s.state.replace("_", " ")} - drop onto an idle one` };
    }
    // Reports idle, but something is already parked on it waiting for the human. The
    // dashboard files such a session under "needs you" rather than "idle" and won't
    // offer it as a target; refuse it here too, so the API can't route around a rule
    // the operator can see being applied on screen.
    if (s.pendingReviews > 0) {
      return { ok: false, error: "that agent has a review waiting on you - clear it first" };
    }
    // Running a task's intent against the wrong checkout is the one way this gesture
    // does damage you cannot undo from the dashboard, so a mismatch is refused rather
    // than best-efforted. Compared on repoRoot, not cwd: a linked worktree of the
    // task's repo is a legitimate home for it, a different repo never is.
    if (!s.repoRoot || s.repoRoot !== t.repoRoot) {
      return { ok: false, error: `that agent is in a different repo (${s.repoRoot ?? "no repo"})` };
    }

    // Type the prompt BEFORE claiming the task: if the pane refuses (it is locked, or
    // the agent died between the drop and here) the task must stay in the backlog,
    // droppable again, rather than sit marked `running` with nothing running it.
    const r = await injectPrompt(s, t.intent);
    if (!r.ok) return { ok: false, error: r.error ?? "could not type into the agent's pane" };

    const now = Date.now();
    this.registry.upsertTask({
      ...t,
      status: "running",
      sessionId: s.id,
      dispatchedAt: now,
      updatedAt: now,
    });
    return { ok: true };
  }

  /**
   * Stop a task's agent and reclaim its (ephemeral) worktree, marking it
   * cancelled. A dispatched agent's tree is throwaway - to preserve work you
   * Focus and commit/PR it before cancelling - so cancel always reclaims, which
   * keeps the teardown model simple and leak-free (no keep/remove ambiguity that
   * an in-flight dispatch could race).
   *
   * Cancel only kills agents we LAUNCHED. An assigned task (dropped onto an agent
   * that was already running) never had a tmux session of ours, and killing it would
   * take down the operator's own session - along with whatever else it was doing
   * before we handed it this task. For those, cancel means "stop tracking it", and
   * the human stops the agent themselves if they want it stopped.
   */
  async cancel(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };

    if (t.sessionId && t.tmuxSession) {
      const s = this.registry.getSession(t.sessionId);
      if (s) await kill(s);
    }
    // Re-read before tearing down so we don't miss resources a concurrent dispatch
    // created during the kill above. teardownWorktree also kills the tmux session.
    await teardownWorktree(this.registry.getTask(id) ?? t).catch(() => {});

    // Merge onto the LATEST snapshot, not a stale one, so we don't resurrect fields
    // the dispatcher patched during the awaits.
    const cur = this.registry.getTask(id) ?? t;
    const now = Date.now();
    this.registry.upsertTask({
      ...cur,
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

  /**
   * Record a task's outcome. Deliberately does NOT tear down the worktree/agent -
   * "Mark done" annotates a result, it must not silently discard unpushed work.
   * The tree is freed later by an explicit, confirmed `reclaim` (or `remove`).
   */
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

  /**
   * Free a terminal task's leftover worktree + agent (the explicit, confirmed
   * "reclaim" action) while KEEPING its status and outcome - unlike cancel, which
   * aborts an active task.
   */
  async reclaim(id: string): Promise<Ok> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    await teardownWorktree(this.registry.getTask(id) ?? t).catch(() => {});
    const cur = this.registry.getTask(id) ?? t;
    this.registry.upsertTask({
      ...cur,
      worktreePath: null,
      branch: null,
      provider: null,
      tmuxSession: null,
      sessionId: null,
      updatedAt: Date.now(),
    });
    return { ok: true };
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
      return; // running / failed / done stay as loaded; their session re-binds by cwd
    }
    // The agent is gone - reclaim its worktree. A `done` task keeps its status and
    // outcome (its work was already recorded); everything else becomes `failed`.
    await teardownWorktree(t).catch(() => {});
    this.registry.upsertTask({
      ...t,
      status: t.status === "done" ? "done" : "failed",
      error:
        t.status === "done"
          ? t.error
          : t.status === "dispatching"
            ? "dispatch interrupted by a restart - re-dispatch"
            : "the agent's session did not survive a restart",
      worktreePath: null,
      branch: null,
      provider: null,
      tmuxSession: null,
      sessionId: null,
      updatedAt: Date.now(),
    });
  }
}
