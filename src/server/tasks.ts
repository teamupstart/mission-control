import { randomUUID } from "node:crypto";
import type {
  AgentType,
  AssignRefusalScope,
  AssignResetConfirm,
  ResetResult,
  Session,
  Task,
  TaskDependency,
  TaskKind,
  TaskPriority,
} from "@shared/types.ts";
import type { TaskDependencyInput, UpdateTask } from "@shared/protocol.ts";
import type { TaskSourceRef } from "@shared/task-source.ts";
import { isAnnotationOnlyUpdate } from "@shared/protocol.ts";
import { supportsEffort } from "@shared/harness-capabilities.ts";
import { canWriteTo } from "@shared/pane.ts";
import { gateParked } from "@shared/session.ts";
import { declaredBlockers, type BacklogBlocker } from "@shared/backlog.ts";
import type { Registry } from "./registry.ts";
import { Dispatcher, deriveTitle, teardownWorktree } from "./dispatcher.ts";
import {
  branchReleasedByReset,
  injectPrompt,
  kill,
  nameRulesFor,
  paneAcceptsPrompt,
  rename,
  resetWouldDestroyWork,
  validateSessionName,
  validateSessionNameAgainstTasks,
  type ActionResult,
} from "./actions.ts";
import { resetSession } from "./reset.ts";
import { homeAlive } from "./terminal/home.ts";
import { summariseTaskTitle } from "./task-title.ts";

export interface CreateTaskInput {
  repoRoot: string;
  intent: string;
  title?: string;
  kind: TaskKind;
  agent: AgentType;
  /** Optional urgency. Omitted means unset, which is not the same as `low`. */
  priority?: TaskPriority | null;
  /** Optional tags, already normalized by the schema that parsed them. */
  labels?: string[];
  /** Launch this agent on a specific model; omitted follows the harness default. */
  model?: string;
  /** Launch with a specific reasoning effort; omitted follows the harness default. */
  effort?: import("@shared/types.ts").ThinkingLevel;
  /** Prerequisites selected from current backlog tasks or live sessions. */
  dependencies?: TaskDependencyInput[];
  /**
   * Where a task source swept this from. Omitted by every human-facing caller, which is
   * nearly all of them. Provenance only (see `Task.source`) - it is never consulted to
   * decide whether an item has been filed before.
   */
  source?: TaskSourceRef;
  /** Only add to the backlog (no worktree/session) - dispatch it later. */
  backlog: boolean;
}

export interface Ok {
  ok: boolean;
  error?: string;
}

/** A user-fixable dependency selection conflict, safe to return as HTTP 409. */
export class TaskDependencyError extends Error {}

/** A launch-time default that Foreman may supply for an otherwise-unpinned backlog task. */
export interface DispatchOptions {
  defaultModel?: string | null;
}

/** The seams and the one decision `TaskManager.assign` takes from its caller. */
export interface AssignOptions {
  /**
   * The caller has accepted what the handover reset discards beyond git state. False -
   * the default, and what an omitted flag gets - means a reset with anything to lose is
   * refused with the breakdown attached instead of run.
   */
  confirmReset?: boolean;
  /** Deliver the task's intent to the agent. The one call that types. */
  inject?: typeof injectPrompt;
  /** Ask whether the pane could take a prompt, before anything is done to the agent. */
  paneReady?: (session: Session) => Promise<ActionResult>;
  /** Hand the agent's checkout back in the shape a fresh one starts in. */
  reset?: (session: Session) => Promise<ResetResult>;
  /** Rename the agent's terminal after the task it just took. Cosmetic, never fatal. */
  rename?: (session: Session, name: string) => Promise<ActionResult>;
}

/**
 * An assign's answer. A refusal says whose fault it is, and - when the caller only has
 * to say yes - exactly what saying yes would spend.
 */
export interface AssignOutcome extends Ok {
  scope?: AssignRefusalScope;
  resetConfirm?: AssignResetConfirm;
}

/** Whether the handover would take anything the caller has not already agreed to. */
function needsResetConfirm(c: AssignResetConfirm): boolean {
  // `clearsContext` is deliberately NOT a trigger, though it IS reported. Every agent
  // that can be assigned at all has a pane, so treating the `/clear` as something to ask
  // about would put a dialog in front of every drop - including onto a pooled worktree
  // sitting detached with nothing in it, which is the case that must stay one gesture.
  return c.queuedItems > 0 || c.branch != null;
}

/** The loss in one sentence, for the refusal a caller may show as-is. */
function describeResetLoss(c: AssignResetConfirm): string {
  const parts: string[] = [];
  if (c.queuedItems > 0) parts.push(`${c.queuedItems} queued work item(s)`);
  if (c.branch) parts.push(`the branch ${c.branch}`);
  if (c.clearsContext) parts.push("the agent's context");
  return parts.join(", ");
}

/**
 * Owns the task lifecycle: create/queue, kick off dispatch, cancel (tearing down
 * the live session + tmux + optional worktree), complete with an outcome, and
 * remove from the list. The registry is the single store; this class is the
 * policy layer routes call into - the task analog of ReviewManager.
 */
export class TaskManager {
  private dispatcher: Dispatcher;
  /**
   * In-flight titling runs, by task id.
   *
   * A backlogged untitled task is on the board - and dispatchable - the instant `create`
   * returns, while its title is still being decided. Dispatching in that window would cut
   * the branch and the tmux session from the heuristic title and then rename only the card,
   * which is the exact mismatch the awaited-titling ordering exists to prevent. `dispatch`
   * awaits this first, so an early click waits a beat and gets the model's title instead.
   * Held here rather than checked at the route so the invariant holds on every path.
   */
  private titling = new Map<string, Promise<void>>();
  private assigningTasks = new Set<string>();
  private assigningSessions = new Set<string>();

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

  /** Explicit blockers are enforced on every path that can start a task. */
  dependencyBlockers(task: Task): BacklogBlocker[] {
    return declaredBlockers(task, this.registry.listTasks());
  }

  private observedPrFor(session: Session, taskId?: string): string | null {
    const observation = this.registry.prObservationFor(session.id);
    const episode = this.registry.workEpisodeForSession(session.id);
    if (
      !observation ||
      !episode ||
      observation.url !== session.prUrl ||
      observation.branch !== session.gitBranch ||
      observation.agentSessionId !== session.agentSessionId ||
      observation.episodeId !== episode.episodeId ||
      (taskId !== undefined && !this.registry.taskOwnsWorkEpisode(taskId, session.id, observation.url))
    ) {
      return null;
    }
    return observation.url;
  }

  /**
   * Resolve untrusted ids to durable dependency edges and reject deadlocks.
   *
   * A selected session already carrying a task becomes a task edge. That is what lets
   * the dependency survive a process restart and follow the work through its PR merge.
   * Bare operator-started sessions remain session edges.
   */
  private resolveDependencies(
    inputs: TaskDependencyInput[],
    taskId: string,
    current: Task["dependencies"] = [],
  ): TaskDependency[] {
    const existing = new Map(
      current.map((dependency) => [
        dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`,
        dependency,
      ]),
    );
    const sessions = this.registry.snapshot().sessions;
    const resolved: TaskDependency[] = [];
    const seen = new Set<string>();

    for (const input of inputs) {
      let dependency: TaskDependency;
      if (input.type === "session") {
        const kept = existing.get(`session:${input.sessionId}`);
        if (kept?.type === "session") {
          dependency = kept;
          const key = `session:${dependency.sessionId}`;
          if (!seen.has(key)) resolved.push(dependency);
          seen.add(key);
          continue;
        }
        const session = sessions.find((candidate) => candidate.id === input.sessionId && candidate.state !== "exited");
        // Preserve an existing edge whose target disappeared so the operator can edit
        // other fields or remove dependencies without the daemon resurrecting/dropping it.
        if (!session) {
          throw new TaskDependencyError("dependency session is no longer active");
        } else if (session.task && this.registry.getTask(session.task.id)) {
          const target = this.registry.getTask(session.task.id)!;
          const observedPr = this.observedPrFor(session, target.id);
          const previouslySatisfied =
            existing.get(`task:${target.id}`)?.satisfiedAt ??
            existing.get(`session:${session.id}`)?.satisfiedAt;
          dependency = {
            type: "task",
            taskId: target.id,
            title: target.title,
            satisfiedAt:
              target.kind === "scout" && target.status === "done"
                ? target.completedAt ?? Date.now()
                : observedPr && session.prState === "merged"
                  ? Date.now()
                  : previouslySatisfied ?? null,
          };
        } else {
          const episode = this.registry.workEpisodeForSession(session.id);
          if (!session.agentSessionId || !episode) {
            throw new TaskDependencyError("dependency session has no stable work identity yet");
          }
          const observedPr = this.observedPrFor(session);
          dependency = {
            type: "session",
            sessionId: session.id,
            title: session.name,
            episodeId: episode.episodeId,
            agentSessionId: session.agentSessionId,
            branch: session.gitBranch,
            prUrl: observedPr,
            satisfiedAt: observedPr && session.prState === "merged" ? Date.now() : null,
          };
        }
      } else {
        const target = this.registry.getTask(input.taskId);
        if (!target) {
          const kept = existing.get(`task:${input.taskId}`);
          if (!kept) throw new TaskDependencyError("dependency task is no longer available");
          dependency = kept;
        } else {
          const activeSession = sessions.find(
            (session) => session.state !== "exited" && session.task?.id === target.id,
          );
          const observedPr = activeSession ? this.observedPrFor(activeSession, target.id) : null;
          const eligible = target.status === "backlog" || target.status === "dispatching" || target.status === "running" || Boolean(activeSession);
          if (!eligible && !existing.has(`task:${target.id}`)) {
            throw new TaskDependencyError("dependency task is neither backlogged nor active");
          }
          dependency = {
            type: "task",
            taskId: target.id,
            title: target.title,
            satisfiedAt:
              target.kind === "scout" && target.status === "done"
                ? target.completedAt ?? Date.now()
                : observedPr && activeSession?.prState === "merged"
                  ? Date.now()
                  : existing.get(`task:${target.id}`)?.satisfiedAt ?? null,
          };
        }
      }

      const key = dependency.type === "task" ? `task:${dependency.taskId}` : `session:${dependency.sessionId}`;
      if (dependency.type === "task" && dependency.taskId === taskId) {
        throw new TaskDependencyError("a task cannot depend on itself");
      }
      if (!seen.has(key)) resolved.push(dependency);
      seen.add(key);
    }

    if (this.createsDependencyCycle(taskId, resolved)) {
      throw new TaskDependencyError("task dependencies cannot form a cycle");
    }
    return resolved;
  }

  private createsDependencyCycle(taskId: string, proposed: TaskDependency[]): boolean {
    const tasks = new Map(this.registry.listTasks().map((task) => [task.id, task]));
    const visiting = new Set<string>();
    const reachesTask = (id: string): boolean => {
      if (id === taskId) return true;
      if (visiting.has(id)) return false;
      visiting.add(id);
      const dependencies = id === taskId ? proposed : tasks.get(id)?.dependencies ?? [];
      for (const dependency of dependencies) {
        if (dependency.satisfiedAt !== null || dependency.type !== "task") continue;
        if (reachesTask(dependency.taskId)) return true;
      }
      return false;
    };
    return proposed.some(
      (dependency) =>
        dependency.satisfiedAt === null &&
        dependency.type === "task" &&
        reachesTask(dependency.taskId),
    );
  }

  /**
   * Create a task, and - when the operator left the title blank - name it with a model
   * before anything downstream reads that name.
   *
   * Stays synchronous so the POST returns a task immediately: the card must appear the
   * instant it is dispatched, not after a subprocess. It appears under the heuristic title,
   * which `autoTitleThenDispatch` replaces over SSE a beat later.
   */
  create(input: CreateTaskInput): Task {
    const now = Date.now();
    const explicitTitle = input.title?.trim();
    const id = randomUUID();
    const dependencies = this.resolveDependencies(input.dependencies ?? [], id);
    const mustBacklog = dependencies.some((dependency) => dependency.satisfiedAt === null);
    const task: Task = {
      id,
      title: explicitTitle || deriveTitle(input.intent),
      intent: input.intent,
      kind: input.kind,
      agent: input.agent,
      priority: input.priority ?? null,
      labels: input.labels ?? [],
      dependencies,
      // Stored as an override, not a resolved value: unset means the dispatcher asks
      // the harness config at launch time, so shelving a task doesn't freeze the
      // defaults it happened to see (see `resolveDispatchModel` and
      // `resolveDispatchEffort`).
      model: input.model ?? null,
      effort: input.effort ?? null,
      source: input.source ?? null,
      repoRoot: input.repoRoot,
      worktreePath: null,
      branch: null,
      provider: null,
      tmuxSession: null,
      sessionId: null,
      status: input.backlog || mustBacklog ? "backlog" : "dispatching",
      outcome: null,
      outcomeUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      dispatchedAt: null,
      completedAt: null,
    };
    this.registry.upsertTask(task);
    if (explicitTitle) {
      if (task.status === "dispatching") void this.dispatcher.dispatch(task.id);
    } else {
      // Registered synchronously, before this returns, so no caller can observe the task
      // without also observing that its title is still in flight.
      const settled = this.autoTitleThenDispatch(task.id, input.intent, task.status === "backlog")
        .catch((err) => console.error("[title] titling failed:", err))
        .finally(() => this.titling.delete(task.id));
      this.titling.set(task.id, settled);
    }
    return task;
  }

  /**
   * Replace an auto-derived title with a model's, THEN dispatch.
   *
   * The ordering is the whole point, and it is why dispatch waits on a cosmetic call.
   * `Dispatcher.dispatch` reads `task.title` once, at the top, to build the git branch
   * (`slugify`) and the terminal session name (`sessionLabel`) - both of which are permanent for
   * the life of the task and neither of which can be renamed afterwards from the dashboard.
   * Dispatching first and patching the title after would leave every untitled task with a
   * card whose name no longer matches its branch or its terminal, which is worse than the
   * rough title this feature exists to replace. The wait is `TITLE_TIMEOUT_MS` per attempt,
   * and almost always exactly one attempt: a timeout or a missing `claude` makes
   * `runStructured` return on the first exception rather than retry, so the slow path costs
   * one budget (~15s) and the answered path costs however long Haiku takes (~7s measured).
   * Only a parse miss - a clean exit whose output won't validate - takes the second attempt
   * and so roughly twice the budget. All of it against a dispatch that spends far longer
   * cutting a worktree and waiting for the agent to boot.
   *
   * Never throws: `summariseTaskTitle` reports failure as null, and the title write is
   * guarded, so a failure of either simply leaves the heuristic title standing - the
   * dispatch below happens either way.
   */
  private async autoTitleThenDispatch(id: string, intent: string, backlog: boolean): Promise<void> {
    const title = await summariseTaskTitle(intent);
    // Re-read rather than closing over the created task: the operator can cancel or remove a
    // task while the model is thinking, and both of those are decisions this must not undo.
    const cur = this.registry.getTask(id);
    if (!cur) return;
    if (title && title !== cur.title) {
      try {
        this.registry.upsertTask({ ...cur, title, updatedAt: Date.now() });
      } catch (err) {
        // A failed write must not cost the dispatch. Throwing here would strand the task in
        // `dispatching` forever - no error on the card, and `remove` refuses that status -
        // over a cosmetic rename. The heuristic title stands and we fall through.
        console.error("[title] could not store the title:", err);
      }
    }
    if (backlog) return;
    // A task cancelled mid-title is withdrawn, not merely renamed - launching an agent for it
    // now would strand a worktree and a tmux session behind a card that says "cancelled".
    if ((this.registry.getTask(id) ?? cur).status !== "dispatching") return;
    void this.dispatcher.dispatch(id);
  }

  /**
   * Dispatch a backlog task, or retry a failed one - but only when the failure was
   * cleanly torn down (no lingering worktree). A failed task that still holds a
   * worktree means its agent may still be running; the user should Cancel it first
   * (which reclaims the tree) rather than dispatch a second agent onto it.
   *
   * Waits out any in-flight titling first: the branch and the tmux session are cut from
   * `task.title` and can never be renamed afterwards, so dispatching mid-titling would
   * name them after the heuristic title and leave the card disagreeing with both.
   */
  async dispatch(id: string, options: DispatchOptions = {}): Promise<Task | null> {
    await this.titling.get(id);
    // Read only AFTER the wait - the task may have been cancelled or removed during it.
    const t = this.registry.getTask(id);
    if (!t) return null;
    if (this.assigningTasks.has(id)) return t;
    if (t.status === "backlog" || (t.status === "failed" && !t.worktreePath)) {
      if (this.dependencyBlockers(t).length > 0) return t;
      // A task-specific model is an explicit operator choice and must always win. Foreman
      // supplies this only for a fresh backlog launch; persisting it before the async
      // dispatcher starts makes the task card's model match the command line it will use.
      if (t.status === "backlog" && t.model === null && options.defaultModel) {
        const selected = { ...t, model: options.defaultModel, updatedAt: Date.now() };
        this.registry.upsertTask(selected);
      }
      void this.dispatcher.dispatch(id);
    }
    return this.registry.getTask(id) ?? t;
  }

  /**
   * Edit a task - the dispatch modal reopened on a card, or the backlog column's
   * priority picker.
   *
   * The status guard applies to the PROVISIONING fields only, and that split is the
   * whole rule. The moment a task dispatches, its title is baked into a git branch and a
   * tmux session name that nothing downstream can rename (see `autoTitleThenDispatch`),
   * and its intent has already been typed at an agent - so an edit to those after that
   * point would change the card and nothing else, which is worse than a refusal. Every
   * other status is a conflict the caller shows, not retries.
   *
   * Dependencies share that guard because changing them can change whether launch is
   * allowed. `priority` and `labels` are exempt because nothing is provisioned from them. They
   * are annotation, so re-marking a RUNNING task `blocker` is safe, and re-marking a
   * finished one keeps the record honest - the two things the guard above is protecting
   * simply are not at stake. Refusing them would make the board's priority picker dead
   * the instant its card was dispatched, for no reason anyone could name.
   *
   * Waits out any in-flight titling for the same reason `dispatch` does, inverted: the
   * model writes the whole row back when it lands, so an edit applied before it would be
   * silently reverted a beat later, in front of an operator who watched their text go in.
   */
  async update(id: string, patch: UpdateTask): Promise<Ok & { task?: Task }> {
    await this.titling.get(id);
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task" };
    if (this.assigningTasks.has(id) && !isAnnotationOnlyUpdate(patch)) {
      return { ok: false, error: "task is being assigned" };
    }
    if (t.status !== "backlog" && !isAnnotationOnlyUpdate(patch)) {
      return { ok: false, error: `task is ${t.status}, not in the backlog` };
    }
    const intent = patch.intent?.trim() ?? t.intent;
    const title = patch.title?.trim();
    const agent = patch.agent ?? t.agent;
    const agentChanged = agent !== t.agent;
    const model = patch.model === undefined ? (agentChanged ? null : t.model) : patch.model;
    const effort = patch.effort === undefined ? (agentChanged ? null : t.effort) : patch.effort;
    if (effort !== null && !supportsEffort(agent, effort)) {
      return { ok: false, error: `reasoning effort ${effort} is not supported by ${agent}` };
    }
    let dependencies = t.dependencies;
    try {
      if (patch.dependencies !== undefined) {
        dependencies = this.resolveDependencies(patch.dependencies, t.id, t.dependencies);
      }
    } catch (error) {
      if (error instanceof TaskDependencyError) return { ok: false, error: error.message };
      throw error;
    }
    const next: Task = {
      ...t,
      repoRoot: patch.repoRoot ?? t.repoRoot,
      intent,
      // Emptying the title asks for one to be derived again - and from the intent as it
      // now reads, not the one the task was first shelved under. Derived here rather than
      // re-run through the model: an edit is a synchronous answer to a click, and the
      // titling wait it would cost buys a nicety on a name the operator is looking at and
      // can simply type.
      title: title === undefined ? t.title : title || deriveTitle(intent),
      kind: patch.kind ?? t.kind,
      agent,
      // Read by `in`, not by truthiness: `priority: null` is a caller deliberately
      // clearing the field back to unset, and `?? t.priority` would silently ignore them.
      priority: "priority" in patch ? (patch.priority ?? null) : t.priority,
      labels: patch.labels ?? t.labels,
      dependencies,
      // `undefined` leaves an override as it stands unless the agent changed; `null` is
      // the caller clearing it, which is a value the row can hold and cannot use `??`.
      model,
      effort,
      updatedAt: Date.now(),
    };
    this.registry.upsertTask(next);
    return { ok: true, task: next };
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
   * That reuse is what the reset below is for: the agent keeps the checkout, so unless
   * something puts it back to origin's default branch the new task inherits the last
   * one's branch and context. It also means an assign CLEARS the session's work queue,
   * because the reset does - those items were authored against a branch that no longer
   * exists.
   *
   * Which is why an assign that would take any of that ASKS FIRST. `resetWouldDestroyWork`
   * covers only what git holds; the queue, the context and the branch name are losses
   * origin cannot undo, and a drag gesture that spends them unannounced is the same
   * unconfirmed destruction the Reset button's dialog exists to prevent. An agent with
   * nothing to lose - empty queue, no branch - still takes a task in one gesture.
   *
   * Every refusal below is a state conflict the caller should surface, not retry, and
   * each says whose fault it is (`scope`) - see `AssignRefusalScope`.
   *
   * `inject` and `paneReady` are parameters for the same reason `inject` is one on
   * `injectPrompt` itself: they are the calls here that leave the process, and the
   * window they hold open is where this method's ordering rules can be broken.
   */
  async assign(id: string, sessionId: string, opts: AssignOptions = {}): Promise<AssignOutcome> {
    const t = this.registry.getTask(id);
    if (!t) return { ok: false, error: "no such task", scope: "task" };
    if (t.status !== "backlog") {
      return { ok: false, error: `task is ${t.status}, not in the backlog`, scope: "task" };
    }
    const dependencyBlockers = this.dependencyBlockers(t);
    if (dependencyBlockers.length > 0) {
      return {
        ok: false,
        error: `task is waiting on ${dependencyBlockers.map((blocker) => blocker.title).join(", ")}`,
        scope: "task",
      };
    }

    const s = this.registry.getSession(sessionId);
    if (!s) return { ok: false, error: "no such session", scope: "session" };
    if (this.assigningTasks.has(id)) {
      return { ok: false, error: "task is already being assigned", scope: "task" };
    }
    if (this.assigningSessions.has(sessionId)) {
      return { ok: false, error: "that agent is already taking another task", scope: "session" };
    }
    this.assigningTasks.add(id);
    this.assigningSessions.add(sessionId);
    try {
      return await this.assignReserved(t, s, opts);
    } finally {
      this.assigningTasks.delete(id);
      this.assigningSessions.delete(sessionId);
    }
  }

  private async assignReserved(
    t: Task,
    s: Session,
    opts: AssignOptions,
  ): Promise<AssignOutcome> {
    const inject = opts.inject ?? injectPrompt;
    const paneReady = opts.paneReady ?? paneAcceptsPrompt;
    const reset = opts.reset ?? ((session: Session) => resetSession(this.registry, session, true));
    const doRename = opts.rename ?? rename;

    if (s.state !== "idle") {
      return {
        ok: false,
        error: `that agent is ${s.state.replace("_", " ")} - drop onto an idle one`,
        scope: "session",
      };
    }
    if (!s.instrumented) {
      return {
        ok: false,
        error: "that agent has no live hook instrumentation to confirm a safe handover",
        scope: "session",
      };
    }
    // Reports idle, but something is already parked on it waiting for the human. The
    // dashboard files such a session under "needs you" rather than "idle" and won't
    // offer it as a target; refuse it here too, so the API can't route around a rule
    // the operator can see being applied on screen.
    if (s.pendingReviews > 0) {
      return {
        ok: false,
        error: "that agent has a review waiting on you - clear it first",
        scope: "session",
      };
    }
    if (gateParked(s, this.registry.snapshot().sessions)) {
      return {
        ok: false,
        error: "that agent has a no-mistakes gate waiting on you - resolve it first",
        scope: "session",
      };
    }
    // Running a task's intent against the wrong checkout is the one way this gesture
    // does damage you cannot undo from the dashboard, so a mismatch is refused rather
    // than best-efforted. Compared on repoRoot, not cwd: a linked worktree of the
    // task's repo is a legitimate home for it, a different repo never is.
    if (!s.repoRoot || s.repoRoot !== t.repoRoot) {
      return {
        ok: false,
        error: `that agent is in a different repo (${s.repoRoot ?? "no repo"})`,
        scope: "session",
      };
    }
    // Asked BEFORE the reset, and that ordering is the whole reason it is a separate
    // probe. Everything below strips the agent - detaches its checkout, drops its work
    // queue, wipes its context - for the sake of a prompt that is typed at the very end.
    // Finding out then that the pane has no handle, or that a human is sitting in
    // copy-mode reading their scrollback, leaves an agent taken apart for a task that
    // goes straight back to the backlog.
    const pane = await paneReady(s);
    if (!pane.ok) {
      return { ok: false, error: pane.error ?? "that agent's pane cannot take a prompt", scope: "session" };
    }

    // A reused agent starts the new task from origin's default branch with a cleared
    // context, not wherever the last one left it.
    //
    // The state this fixes is the ordinary one, not an edge case: an agent that just
    // shipped is standing on its own feature branch with that work committed. Typing
    // the next task in stacks unrelated commits on top of it, and no-mistakes, seeing a
    // non-default branch, validates and pushes onto it - so two tasks arrive in one PR.
    // `resetSession` is the same operation the Reset button performs (git reset --hard
    // onto origin/main, clean, detach the branch, /clear), so a recycled agent is handed
    // over in the shape a freshly dispatched one starts in.
    //
    // Guarded rather than unconditional, and the guard REFUSES rather than proceeding.
    // A reset is destructive and the autopilot's is unwatched: the button has a confirm
    // dialog with a loss preview in front of it. So a checkout holding work sends the
    // task back to the backlog with a sentence saying what is in the way, which the
    // operator can act on - the one outcome we cannot offer is silently discarding it.
    const holding = await resetWouldDestroyWork(s);
    if (holding) {
      return { ok: false, error: `that agent's checkout cannot be reset - ${holding}`, scope: "session" };
    }
    // Git is not the whole loss. The reset also drops the agent's work queue, wipes its
    // context and takes its branch away, and none of that is recoverable from origin -
    // so the human drag gesture is told what it is about to spend and asked once. The
    // breakdown travels WITH the refusal so the dialog and the action cannot disagree
    // about a queue that moved in between.
    if (!opts.confirmReset) {
      const confirm = await this.resetConfirmFor(s);
      if (needsResetConfirm(confirm)) {
        return {
          ok: false,
          error: `resetting that agent first would discard ${describeResetLoss(confirm)}`,
          scope: "session",
          resetConfirm: confirm,
        };
      }
    }
    // Re-read immediately before the destructive step. The idle check above is by now
    // several git invocations old, and the reset itself spends up to 30s in a fetch -
    // an agent a human woke up in that window must not be reset out from under them.
    const fresh = this.registry.getSession(s.id);
    if (
      !fresh ||
      !fresh.instrumented ||
      fresh.state !== "idle" ||
      fresh.pendingReviews > 0 ||
      gateParked(fresh, this.registry.snapshot().sessions)
    ) {
      return { ok: false, error: "that agent stopped being idle - try again", scope: "session" };
    }

    const done = await reset(s);
    if (!done.ok) {
      return { ok: false, error: `could not reset that agent's checkout - ${done.error}`, scope: "session" };
    }
    // `cleared` means the agent was SEEN acting on the `/clear`, not that tmux took the
    // keystrokes. Believing the weaker one is how a task gets claimed with nothing
    // running it: a `/clear` processed after the paste below wipes the prompt off the
    // composer, and the pane read that follows the paste finds nothing pending and calls
    // that success. Unconfirmed, the task stays in the backlog.
    if (!done.cleared) {
      return {
        ok: false,
        error: "could not confirm the agent cleared its context, so the task was not typed",
        scope: "session",
      };
    }
    if (opts.reset) {
      this.registry.resetWorkEpisode(s.id, {
        awaitingAgentRebind: true,
        previousAgentSessionId: s.agentSessionId,
      });
    }

    const ready = this.registry.getTask(t.id);
    if (!ready || ready.status !== "backlog") {
      return {
        ok: false,
        error: ready ? `task is ${ready.status}, not in the backlog` : "no such task",
        scope: "task",
      };
    }
    const blockers = this.dependencyBlockers(ready);
    if (blockers.length > 0) {
      return {
        ok: false,
        error: `task is waiting on ${blockers.map((blocker) => blocker.title).join(", ")}`,
        scope: "task",
      };
    }

    // Type the prompt BEFORE claiming the task: if the pane refuses (it is locked, or
    // the agent died between the drop and here) the task must stay in the backlog,
    // droppable again, rather than sit marked `running` with nothing running it.
    const r = await inject(this.registry.getSession(s.id) ?? s, ready.intent);
    if (!r.ok) {
      return { ok: false, error: r.error ?? "could not type into the agent's pane", scope: "session" };
    }

    // Merge onto the LATEST snapshot, not the one read before the injection, for the
    // same reason `cancel` and `reclaim` do it: typing into a pane takes long enough
    // for a retriage to land, and priority/labels stay editable in every status - so a
    // stale spread here writes yesterday's priority back over one just set on the card,
    // silently, on a gesture that was only meant to hand the task to an agent.
    const cur = this.registry.getTask(t.id) ?? t;
    const now = Date.now();
    this.registry.upsertTask({
      ...cur,
      status: "running",
      sessionId: s.id,
      dispatchedAt: now,
      updatedAt: now,
    });
    this.registry.bindTaskToWorkEpisode(t.id, s.id);
    // The agent now IS this task, so its terminal has to say so - see `renameForTask`.
    // Last, and after the claim: it is the one step here that changes nothing about
    // whether the task is running, so it must not sit in front of anything that does.
    await this.renameForTask(
      // Re-read for the same reason the task is: the reset detached the checkout and the
      // injection took a round trip, and `rename` targets the tmux session BY NAME.
      this.registry.getSession(s.id) ?? s,
      this.registry.getTask(t.id) ?? cur,
      doRename,
    );
    return { ok: true };
  }

  /**
   * Name the agent's terminal after the task it just took, the way a fresh dispatch does.
   *
   * A dispatch cuts its session name from the task title, so a launched agent's card is
   * titled by its work from the first frame. An assign reuses a terminal that was
   * named for something else - the pooled worktree it was handed out as, or the task it
   * finished ten minutes ago - and everything else about the handover (branch back to
   * origin's default, work queue dropped, context cleared) already says this is a fresh
   * start. Leaving the name behind is how a board ends up with a card reading one task
   * while running another, which is worse than either name alone: the operator cannot tell
   * from the card which of the two is the lie.
   *
   * Best-effort, and deliberately AFTER the task is claimed. The task is typed and running
   * by the time this is reached; failing the assign over a cosmetic rename would send a
   * task that an agent is already working on back to the backlog, to be handed to a second
   * agent. So every refusal below is a silent no-op that leaves the old name standing.
   *
   * The fallback name exists for one reason: tmux session names are unique, so a rename
   * onto a name a live session already holds fails, and `validateSessionNameAgainstTasks`
   * refuses a name a task's teardown still aims at (taking it would point that task's
   * `tmux kill-session` at this agent). Both are answered the same way `spawnUniquely`
   * answers them - retry once under a name the task id makes unique.
   */
  private async renameForTask(
    s: Session,
    t: Task,
    doRename: NonNullable<AssignOptions["rename"]>,
  ): Promise<void> {
    // This session's OWN backend spells the name, not the one a fresh dispatch would land
    // on: the two can differ (an operator's tmux session on a machine where a dispatch
    // would open a tab), and sanitizing for the wrong one strips characters this rename
    // could have kept - or keeps ones it cannot.
    const label = nameRulesFor(s).sanitize(t.title);
    if (s.name === label) return;
    for (const candidate of [label, `${label}-${t.id.slice(0, 6)}`]) {
      // `sanitize` already strips what this backend's names cannot hold, so this normally
      // only refuses a session with no terminal handle at all - one where there is nothing
      // to rename, whose card is named after its process.
      const valid = validateSessionName(s, candidate);
      if (!valid.ok) continue;
      if (!validateSessionNameAgainstTasks(s, valid.name, this.list()).ok) continue;
      const r = await doRename(s, valid.name).catch((err) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (r.ok) {
        this.registry.renameSession(s.id, valid.name);
        return;
      }
    }
  }

  /**
   * What the handover reset would take from this agent that git cannot give back.
   *
   * Read from the registry and the checkout at the moment of deciding, and returned
   * with the refusal, so the dialog the operator answers describes the same state the
   * assign will act on.
   */
  private async resetConfirmFor(s: Session): Promise<AssignResetConfirm> {
    return {
      queuedItems: s.queue?.openCount ?? 0,
      // A pane is what `/clear` needs, and `assign` has already refused a session
      // without one by the time this is asked.
      clearsContext: canWriteTo(s),
      branch: await branchReleasedByReset(s),
    };
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
    if (updated.kind === "scout") this.registry.satisfyTaskDependencies(updated.id, now);
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
   * Reconcile a resource-holding task after a restart. If its agent's terminal home
   * survived, keep it (a `running`/`failed` task re-binds to its rediscovered
   * session; a `dispatching` one can't confirm its prompt landed, so it fails
   * honestly but keeps the live agent to Focus/Cancel). If the home is gone, the
   * agent died with the daemon - reclaim its worktree so nothing leaks invisibly.
   *
   * `homeAlive` has three answers and only ONE of them may reclaim. `null` - no installed
   * backend could hold a named home, so the recorded name proves nothing either way - is
   * grouped with "survived", because this is the most destructive branch in the product:
   * the reclaim path runs `git worktree remove --force` and hands a pooled lease back. A
   * wrong "gone" deletes work an agent is still doing; a wrong "survived" leaves a tree the
   * operator frees with one Reclaim. The `t.tmuxSession ? probe : false` this replaced
   * turned an adapter lookup that found nothing into the destructive answer by omission.
   */
  private async reconcileOnStartup(t: Task): Promise<void> {
    const alive = t.tmuxSession ? await homeAlive(t.tmuxSession) : false;
    if (alive !== false) {
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
