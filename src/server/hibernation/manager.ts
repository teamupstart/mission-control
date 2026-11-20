import {
  hibernateRefusal,
  hibernationPermissionMode,
  TASK_HIBERNATION_FLAG,
  type TaskHibernation,
  type TaskHibernationLaunch,
} from "@shared/hibernation.ts";
import { terminalResourceIds } from "@shared/pane.ts";
import type { PauseState } from "@shared/pause.ts";
import type { Session, Task } from "@shared/types.ts";
import { workflowRunIsOpen } from "@shared/workflow.ts";
import { kill } from "../actions.ts";
import { logEvent } from "../db.ts";
import { sessionLabel, spawnManagedResume } from "../dispatcher.ts";
import { listProcesses } from "../discovery/processes.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { prepareTerminalResume, type PreparedResume, type ResumeSource } from "../harness/resume.ts";
import { resolveDispatchTerminalBackend } from "../harnesses.ts";
import type { PauseRelease } from "../pause/release.ts";
import { noteKeyFor, type Registry } from "../registry.ts";
import { resumeContext } from "../resume-context.ts";
import { requestSessionStop } from "../sdk/control.ts";
import type { SdkSupervisor } from "../sdk/supervisor.ts";
import { homeRecord, killHome, type SpawnedHome } from "../terminal/home.ts";
import { belongsToLaunch } from "../terminal/launch-process.ts";
import { readResumeLease, resumeLeaseStatus } from "../terminal/resume-lease.ts";
import type { WorkflowManager } from "../workflows/manager.ts";
import { checkoutIdentity, checkoutMismatch } from "./checkout.ts";

export type HibernationResult =
  | { ok: true; task: Task }
  | { ok: false; status: 404 | 409 | 503; error: string };

/** How long an Agent SDK Resume waits for the woken driver to report the conversation it opened. */
export const CONVERSATION_CONFIRM_MS = 30_000;

/** What a Resume answers when its task was deleted, cancelled or completed while it ran. */
const TASK_CHANGED = "The task changed while it was resuming";

/** How long Hibernate waits for a stopped terminal agent's process to be gone. */
export const STOP_CONFIRM_MS = 10_000;

/** Whether a process is still there. EPERM is a process this user may not signal: still there. */
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a terminal Resume's watch found once its launch returned. */
type LaunchOutcome =
  | { kind: "launched"; session: Session; others: Session[] }
  | { kind: "competitor"; session: Session }
  | { kind: "absent" };

/**
 * The terminal half's side effects, injectable so tests can drive it without a terminal.
 * Production composes them from the same owners Kill and the managed terminal resume use.
 */
export interface TerminalHibernationDeps {
  /** Stop a terminal agent the way Kill does, its pause lifted first. */
  stop: (session: Session) => Promise<{ ok: boolean; error?: string }>;
  /** Prepare the managed resume of a conversation in its checkout (`prepareTerminalResume`). */
  prepare: (source: ResumeSource, task: Task) => Promise<PreparedResume>;
  /** Launch a prepared resume in a new terminal home; preparation owns its cleanup. */
  spawn: (input: { name: string; prepared: PreparedResume; shortId: string; terminalBackend: string | null }) => Promise<SpawnedHome>;
  /**
   * Whether this discovered session is the agent THIS launch started: in the launched emulator
   * tab, or descended from the guard that claimed this launch's lease - the proof the transfer
   * coordinator adopts a successor on. A session merely holding the same conversation is not.
   */
  provesLaunch: (session: Session, home: SpawnedHome, prepared: PreparedResume) => Promise<boolean>;
  /** Close a home a failed resume opened. Says when it could not, never swallows it. */
  closeHome: (home: { homeName: string; homeBackend: string; terminalResourceId: string | null }) => Promise<{ ok: boolean; error?: string }>;
  /** Whether a launch's lease is still live: its agent may be running, or about to. */
  launchLive: (launch: Pick<TaskHibernationLaunch, "leaseRoot" | "leaseId">) => boolean;
  /**
   * How long a launch whose home was closed is given to end. Closing a home only signals its
   * agent, and the guard releases the lease once the agent and its descendants are gone.
   */
  launchEndMs: number;
  /**
   * Whether a stopped terminal agent's process has actually gone, waiting a bounded time for it.
   * A stop that was delivered is not one that took effect, and Hibernate's promise is the memory.
   */
  exited: (session: Session) => Promise<boolean>;
  /** The backend a resumed task's new home opens in, or null for the automatic choice. */
  backendFor: (task: Task) => string | null;
  /** How long Resume waits for the resumed agent to report its conversation. */
  appearMs: number;
}

/**
 * Hibernate and resume a task (issue #1547). See `@shared/hibernation.ts` for what it means.
 *
 * The ORDER is the whole of the safety argument, in both directions:
 *
 *  - Hibernate records the task `hibernated`, unbound from its session, BEFORE stopping the
 *    agent. The session's eviction then finds no active task bound to it, so nothing settles
 *    the task `failed`, clears its blocker or orphans its workflow binding. A daemon that dies
 *    in between comes back to a hibernated task; for an embedded session restore leaves its row
 *    hibernated (`SdkSupervisor.prepareRestore`). A stop that fails puts the task back.
 *  - Resume starts the agent FIRST and binds the task back only once the conversation is open,
 *    the order an ordinary dispatch uses. An Agent SDK session comes back under its own id. A
 *    terminal one comes back as a new process in a new terminal home, and the task, its work
 *    episode and any armed workflow binding move to it. A relaunch that fails leaves the task
 *    hibernated with the reason recorded on it, so the Backlog shows why and offers Retry;
 *    nothing about the worktree is touched.
 */
export class HibernationManager {
  /** Task ids with a hibernate or resume in flight: one at a time per task. */
  private readonly busy = new Set<string>();
  private readonly terminal: TerminalHibernationDeps;

  constructor(
    private readonly registry: Registry,
    private readonly supervisor: SdkSupervisor | null,
    private readonly options: {
      workflows?: WorkflowManager;
      /** Thaws an agent before it is stopped, and names the priority session, never hibernated. */
      pause?: PauseRelease & { state(): Pick<PauseState, "priority"> };
      /** Whether a task is an ensemble member, for the tools its resumed terminal agent needs. */
      ensembleMember?: (taskId: string) => boolean;
      terminal?: Partial<TerminalHibernationDeps>;
      /** How long an Agent SDK Resume waits for the woken driver to report its conversation. */
      confirmMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.terminal = {
      stop: (session) => requestSessionStop(session, undefined, kill, options.pause),
      prepare: (source, task) =>
        prepareTerminalResume(source, resumeContext(source, task,
          options.workflows?.resumeNeedsEvidence(source) ?? false,
          options.ensembleMember?.(task.id) ?? false)),
      spawn: (input) => spawnManagedResume(input),
      provesLaunch: async (session, home, prepared) => {
        if (home.terminalResourceId?.startsWith("emulator:") && terminalResourceIds(session).has(home.terminalResourceId)) return true;
        const owner = resumeLeaseStatus(prepared.lease).owner;
        return Boolean(owner && belongsToLaunch(session, owner, await listProcesses()));
      },
      closeHome: async (home) => {
        try {
          const closed = await killHome(home.homeName, undefined, home.homeBackend, home.terminalResourceId);
          return closed.ok ? { ok: true } : { ok: false, error: closed.error ?? `${home.homeBackend} could not close it` };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      exited: async (session) => {
        const deadline = Date.now() + STOP_CONFIRM_MS;
        while (processAlive(session.pid)) {
          if (Date.now() >= deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return true;
      },
      launchLive: (launch) => {
        try {
          const { state } = resumeLeaseStatus(readResumeLease(launch.leaseRoot, launch.leaseId));
          return state === "preparing" || state === "pending" || state === "claimed";
        } catch {
          // Unreadable is not proof that nothing runs: fail closed, as lease admission does.
          return true;
        }
      },
      backendFor: (task) => task.homeBackend ?? resolveDispatchTerminalBackend(task.agent),
      appearMs: 60_000,
      launchEndMs: STOP_CONFIRM_MS,
      ...options.terminal,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async hibernate(sessionId: string): Promise<HibernationResult> {
    if (!featureEnabled(TASK_HIBERNATION_FLAG)) {
      return { ok: false, status: 404, error: "Hibernate is a preview feature that is switched off" };
    }
    const session = this.registry.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "no such session" };
    const refusal = hibernateRefusal(session);
    if (refusal) return { ok: false, status: 409, error: refusal };
    // The Pause menu never offers it either: the fleet was paused for this session to run.
    if (this.options.pause?.state().priority?.sessionId === session.id) {
      return { ok: false, status: 409, error: "It is the priority session. End priority before hibernating it." };
    }
    const task = session.task ? this.registry.getTask(session.task.id) : undefined;
    if (!task || task.sessionId !== session.id || task.status !== "running") {
      return { ok: false, status: 409, error: "Its task is not running." };
    }
    if (this.openWorkflowRun(session)) {
      return { ok: false, status: 409, error: "A workflow run is in progress for it. Let the run finish first." };
    }
    if (session.runtime === "sdk" && !this.supervisor?.handleFor(session.id)) {
      return { ok: false, status: 409, error: "Its agent is not running in this Mission Control." };
    }
    // Recorded BEFORE anything stops: a conversation whose checkout cannot be identified now
    // could not be verifiably reopened in it later, so it is not hibernated at all.
    const checkout = checkoutIdentity(session.cwd);
    if (!checkout) {
      return {
        ok: false,
        status: 409,
        error: `Mission Control could not read its checkout${session.cwd ? ` ${session.cwd}` : ""}, so it could not reopen the conversation there.`,
      };
    }
    if (this.busy.has(task.id)) return { ok: false, status: 409, error: "It is already being hibernated." };
    this.busy.add(task.id);
    try {
      const at = this.now();
      const hibernation: TaskHibernation = {
        sessionId: session.id,
        runtime: session.runtime,
        // Checked by `hibernateRefusal`: no conversation id, nothing to reopen.
        agentSessionId: session.agentSessionId!,
        noteKey: noteKeyFor(session),
        permissionMode: session.permissionMode ?? null,
        checkout,
        hibernatedAt: at,
        blocker: session.blocker
          ? {
              kind: session.blocker.kind,
              reason: session.blocker.reason,
              waitingOn: session.blocker.waitingOn,
              startedAt: session.blocker.startedAt,
            }
          : null,
        failure: null,
      };
      this.registry.upsertTask({ ...task, status: "hibernated", sessionId: null, hibernation, updatedAt: at });
      let stopped: string | null = null;
      let lingering = false;
      try {
        // An embedded stop returns only once the driver's process has ended (`drain`).
        if (session.runtime === "sdk") await this.supervisor!.hibernate(session.id);
        else {
          const result = await this.terminal.stop(session);
          if (!result.ok) stopped = result.error ?? "the agent could not be stopped";
          else lingering = !(await this.terminal.exited(session));
        }
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
      }
      if (stopped !== null) {
        this.restoreRunning(task.id, session.id);
        return {
          ok: false,
          status: 409,
          error: `Mission Control could not stop the agent, so it is still running: ${stopped}`,
        };
      }
      if (lingering) {
        // Asked to stop, and not gone. The task stays hibernated - putting it back on a
        // process about to exit would fail it the moment that process went - with the
        // incomplete stop on its record, and Resume refuses while that agent is live.
        const reason =
          `Hibernate asked its agent in "${session.name}" to stop, but it had not exited after ` +
          `${Math.round(STOP_CONFIRM_MS / 1000)} seconds and may still be running and using memory`;
        this.resumeFailed(task.id, `${reason}. Stop that session, or wait for it to exit, then Resume`);
        return {
          ok: false,
          status: 409,
          error: `${reason}. The task is hibernated with its work kept; stop that session, or wait for it to exit, then Resume.`,
        };
      }
      logEvent(session.id, at, "task_hibernated", { taskId: task.id, runtime: session.runtime });
      return { ok: true, task: this.registry.getTask(task.id) ?? task };
    } finally {
      this.busy.delete(task.id);
    }
  }

  async resume(taskId: string): Promise<HibernationResult> {
    const task = this.registry.getTask(taskId);
    if (!task) return { ok: false, status: 404, error: "no such task" };
    if (task.status !== "hibernated" || !task.hibernation) {
      return { ok: false, status: 409, error: "This task is not hibernated." };
    }
    if (this.busy.has(taskId)) return { ok: false, status: 409, error: "It is already resuming." };
    this.busy.add(taskId);
    try {
      const record = task.hibernation;
      // Two processes on one conversation would interleave its file, so nothing launches while
      // any live session holds it - the hibernated session itself included. That one is still
      // live when its agent has not exited yet, or when Mission Control stopped between
      // recording the hibernation and stopping a terminal agent, which then outlives it and is
      // rediscovered under the same id on the next start.
      const live = () => this.registry.snapshot().sessions.filter((s) => s.state !== "exited");
      // An Agent SDK driver of this task's own, left running by an earlier Resume that could not
      // stop it again: it is put back to sleep first, and nothing launches until that is
      // confirmed - not even a second look at the conversation.
      if (record.runtime === "sdk" && this.supervisor?.handleFor(record.sessionId)) {
        try {
          await this.supervisor.hibernate(record.sessionId);
        } catch (error) {
          return this.resumeFailed(
            taskId,
            `the driver an earlier attempt started is still running and could not be stopped ` +
              `(${error instanceof Error ? error.message : String(error)}). Stop that session, then Retry`,
          );
        }
      }
      const sessions = live();
      const original = sessions.find((s) => s.id === record.sessionId);
      if (original) {
        return this.resumeFailed(
          taskId,
          `its original agent in "${original.name}" is still running: it has not exited since it was hibernated. ` +
            "Stop that session, or wait for it to exit, then Retry",
        );
      }
      // One already open elsewhere: resumed by hand, or by an earlier attempt whose outcome was
      // not known.
      const open = sessions.find((s) => s.agentSessionId === record.agentSessionId);
      if (open) return this.resumeFailed(taskId, `its conversation is already open in "${open.name}"`);
      return record.runtime === "sdk"
        ? await this.resumeEmbedded(taskId, record)
        : await this.resumeTerminal(task, record);
    } finally {
      this.busy.delete(taskId);
    }
  }

  private async resumeEmbedded(taskId: string, record: TaskHibernation): Promise<HibernationResult> {
    if (!this.supervisor) return this.resumeFailed(taskId, "this Mission Control has no Agent SDK supervisor");
    const mismatch = checkoutMismatch(record.checkout);
    if (mismatch) return this.resumeFailed(taskId, mismatch);
    let session: Session;
    try {
      session = await this.supervisor.wake(record.sessionId);
    } catch (error) {
      return this.resumeFailed(taskId, error instanceof Error ? error.message : String(error));
    }
    // Cancelled, completed or removed while the driver was starting: the conversation it
    // reopened belongs to nobody, so it is stopped again rather than left running unowned.
    if (!this.stillHibernated(taskId, record)) return this.taskChangedWhileResuming(session);
    // Read again now the driver is up: the checkout may have been replaced while it started.
    const replaced = checkoutMismatch(record.checkout);
    if (replaced) return this.putBackToSleep(taskId, session, replaced);
    // The id the relaunch was handed is what was ASKED for. Only the driver's own report says
    // which conversation it actually opened, so the task waits for that before it is bound.
    const confirmMs = this.options.confirmMs ?? CONVERSATION_CONFIRM_MS;
    const reported = await this.supervisor.reportedConversation(session.id, confirmMs);
    if (reported !== record.agentSessionId) {
      return this.putBackToSleep(
        taskId,
        session,
        reported
          ? `its driver opened conversation ${reported} instead of ${record.agentSessionId}`
          : `its driver did not report reopening the conversation within ${Math.round(confirmMs / 1000)} seconds`,
      );
    }
    // The wait above is long enough for the checkout to be replaced in, so its identity is
    // read again at the last moment before the task is bound, as the terminal path does.
    const replacedWhileWaiting = checkoutMismatch(record.checkout);
    if (replacedWhileWaiting) return this.putBackToSleep(taskId, session, replacedWhileWaiting);
    const rival = this.rivalFor(session, record);
    if (rival) return this.putBackToSleep(taskId, session, `its conversation was opened in "${rival.name}" while it was resuming`);
    // And the task itself, read after that wait rather than before it: binding a copy taken
    // earlier would recreate a task deleted meanwhile, or overwrite whatever it became.
    const current = this.stillHibernated(taskId, record);
    if (!current) return this.taskChangedWhileResuming(session);
    // And the driver itself: one that reported the conversation and then ended is not a session
    // to put the task on. Its row is still `hibernated` (`SdkSupervisor.wakeBound`), so Retry
    // can reopen it.
    const live = this.registry.getSession(session.id);
    if (!live || live.state === "exited" || !this.supervisor.handleFor(session.id)) {
      return this.resumeFailed(taskId, "its agent exited after reopening the conversation, before the task could be bound to it");
    }
    // Its report says which conversation it opened, not which it holds now: one that moved on
    // since is not reopening this task's.
    if (live.agentSessionId !== record.agentSessionId) {
      return this.putBackToSleep(
        taskId,
        live,
        `its driver moved to conversation ${live.agentSessionId ?? "(none)"} before the task could be bound to it`,
      );
    }
    this.supervisor.wakeBound(session.id);
    return this.bindResumed(current, live, record, {});
  }

  /**
   * The task as it stands now, when it is still the hibernation this Resume set out to reopen:
   * hibernated, on the same session and the same conversation. Anything else - deleted,
   * cancelled, completed, or holding another record - is not this Resume's to bind.
   */
  private stillHibernated(taskId: string, record: TaskHibernation): Task | null {
    const current = this.registry.getTask(taskId);
    const now = current?.status === "hibernated" ? current.hibernation : null;
    return current && now && now.sessionId === record.sessionId && now.agentSessionId === record.agentSessionId
      ? current
      : null;
  }

  /**
   * A woken driver whose task changed under it belongs to nobody: stop it, never bind it. Its
   * row stays `hibernated` (`SdkSupervisor.wakeBound`). A stop that fails is said, not dropped:
   * there is no task left to record it on.
   */
  private async taskChangedWhileResuming(session: Session): Promise<HibernationResult> {
    try {
      await this.supervisor!.stop(session.id);
    } catch (error) {
      return {
        ok: false,
        status: 409,
        error: `${TASK_CHANGED}, and its agent in "${session.name}" could not be stopped ` +
          `(${error instanceof Error ? error.message : String(error)}). Stop that session.`,
      };
    }
    return { ok: false, status: 409, error: `${TASK_CHANGED}.` };
  }

  /**
   * A woken driver that will not be bound goes back to sleep - its row stays `hibernated`, so a
   * later Resume can reopen it - rather than run unowned. A driver that will not stop is said
   * so, and the next Resume stops it before it launches anything (see `resume`).
   */
  private async putBackToSleep(taskId: string, session: Session, reason: string): Promise<HibernationResult> {
    // Already ended on its own: nothing to stop, and its row stayed `hibernated`.
    if (!this.supervisor!.handleFor(session.id)) return this.resumeFailed(taskId, reason);
    try {
      await this.supervisor!.hibernate(session.id);
    } catch (error) {
      return this.resumeFailed(
        taskId,
        `${reason}, and its driver could not be stopped again ` +
          `(${error instanceof Error ? error.message : String(error)}). It may still be running: Retry stops it first`,
      );
    }
    return this.resumeFailed(taskId, reason);
  }

  /**
   * Reopen a terminal conversation: the managed terminal resume, in a new home in the task's
   * worktree, then the task, its work episode and its armed workflow follow the new session.
   *
   * Never two processes on one conversation. An earlier attempt whose terminal could not be
   * closed is closed (or found gone) before anything launches; only the session THIS launch
   * started is bound; and a launch that fails, or meets the conversation already reopened
   * elsewhere, is revoked or closed - or, when it cannot be, recorded so the next Resume
   * refuses to launch beside it.
   */
  private async resumeTerminal(task: Task, record: TaskHibernation): Promise<HibernationResult> {
    // The directory the conversation ran in, verified to still be that directory: the task's
    // own worktree path is not consulted, because it is not what the conversation is filed under.
    const mismatch = checkoutMismatch(record.checkout);
    if (mismatch) return this.resumeFailed(task.id, mismatch);
    const cwd = record.checkout!.path;
    const stranded = record.failure?.launch ?? null;
    if (stranded && this.terminal.launchLive(stranded)) {
      if (stranded.homeName === null || stranded.homeBackend === null) {
        // Its launcher failed before naming a home, so there is no terminal to close: only the
        // lease being released says that agent has ended.
        return this.resumeFailed(
          task.id,
          "the agent an earlier attempt may have started is still running, and Mission Control does not know its " +
            "terminal. Stop that agent, then Retry",
          stranded,
        );
      }
      const home = { homeName: stranded.homeName, homeBackend: stranded.homeBackend, terminalResourceId: stranded.terminalResourceId };
      const closed = await this.terminal.closeHome(home);
      if (!closed.ok || !(await this.launchEnded(stranded))) {
        return this.resumeFailed(
          task.id,
          `the agent an earlier attempt started in ${stranded.homeName} may still be running` +
            `${closed.ok ? "" : ` and could not be closed (${closed.error ?? "no reason given"})`}. ` +
            "Close that terminal, then Retry",
          stranded,
        );
      }
    }
    // Confirmed gone or closed: the only place a recorded launch is let go of. Every failure
    // before this point kept it (see `resumeFailed`).
    if (stranded) this.forgetLaunch(task.id);
    const source: ResumeSource = {
      id: record.sessionId,
      agent: task.agent,
      agentSessionId: record.agentSessionId,
      cwd,
      permissionMode: hibernationPermissionMode(record),
      runtime: "terminal",
      meta: null,
    };
    let prepared: PreparedResume;
    try {
      prepared = await this.terminal.prepare(source, task);
    } catch (error) {
      return this.resumeFailed(task.id, error instanceof Error ? error.message : String(error));
    }
    const backend = this.terminal.backendFor(task);
    // Watched from BEFORE the launch, so an agent that reports its conversation while the
    // launcher is still returning is not missed.
    const watch = this.watchConversation(cwd, task.agent, record.agentSessionId);
    let home: SpawnedHome;
    try {
      home = await this.terminal.spawn({
        name: sessionLabel(task.title.trim() || task.agent, backend),
        prepared,
        shortId: record.sessionId.slice(-6),
        terminalBackend: backend,
      });
    } catch (error) {
      watch.cancel();
      const reason = error instanceof Error ? error.message : String(error);
      // No home came back to close, but the preparation is this attempt's to release: revoking
      // its lease means no guard can start the agent late. A lease a guard already claimed cannot
      // be revoked; lease admission then refuses the next launch until that agent has ended.
      let revoked = false;
      try {
        revoked = prepared.dispose();
      } catch {
        revoked = false;
      }
      const claimed = { homeName: null, homeBackend: null, terminalResourceId: null, leaseRoot: prepared.lease.root, leaseId: prepared.lease.id };
      if (revoked || !this.terminal.launchLive(claimed)) return this.resumeFailed(task.id, reason);
      // A guard claimed the lease before the launcher failed: its agent may be running, so the
      // launch is recorded like one that could not be closed, and Retry refuses until it ends.
      return this.resumeFailed(
        task.id,
        `${reason}. Its launch may have started anyway: stop that agent, then Retry`,
        claimed,
      );
    }
    const outcome = await watch.settle((s) => this.terminal.provesLaunch(s, home, prepared), this.terminal.appearMs);
    if (outcome.kind !== "launched" || outcome.others.length > 0) {
      const opener = outcome.kind === "launched" ? outcome.others[0]! : outcome.kind === "competitor" ? outcome.session : null;
      const reason = opener
        ? `its conversation was opened in "${opener.name}" by something other than this resume`
        : `its agent did not reopen the conversation in ${home.homeName} within ${Math.round(this.terminal.appearMs / 1000)} seconds`;
      return this.abandonLaunch(task.id, reason, home, prepared);
    }
    // The watch proved this session while it held the conversation, but proof is asynchronous:
    // read it again now, and bind it only if it is still live, still in the saved checkout and
    // still on the saved conversation.
    const session = this.registry.getSession(outcome.session.id);
    if (!session || session.state === "exited" || session.cwd !== cwd || session.agentSessionId !== record.agentSessionId) {
      return this.abandonLaunch(
        task.id,
        session && session.state !== "exited"
          ? `the agent it launched in ${home.homeName} left the conversation before the task could be bound to it`
          : `the agent it launched in ${home.homeName} exited before the task could be bound to it`,
        home,
        prepared,
      );
    }
    const current = this.stillHibernated(task.id, record);
    if (!current) {
      // Deleted, cancelled or completed while the agent started. The launch is undone exactly as
      // a refused one is; there is no hibernated task left to record it on, so what could not be
      // undone is said here instead.
      const undone = await this.undoLaunch(home, prepared);
      return {
        ok: false,
        status: 409,
        error: undone.ok ? `${TASK_CHANGED}.` : `${TASK_CHANGED}, and ${undone.detail}.`,
      };
    }
    // The checkout may have been replaced while the agent started: verify its identity again.
    const replaced = checkoutMismatch(record.checkout);
    if (replaced) return this.abandonLaunch(task.id, replaced, home, prepared);
    // The watch only counts sessions that appeared after it began. One that was already here
    // and has since switched to this conversation holds it too, so ownership is read again
    // across every live session at the last moment before the task is bound.
    const rival = this.rivalFor(session, record);
    if (rival) {
      return this.abandonLaunch(task.id, `its conversation was opened in "${rival.name}" by something other than this resume`, home, prepared);
    }
    return this.bindResumed(current, session, record, {
      ...homeRecord(home),
      terminalLaunch: home.terminalResourceId?.startsWith("emulator:")
        ? { resourceId: home.terminalResourceId, sessionId: session.id }
        : null,
    });
  }

  /**
   * Undo a launch that will not be bound, and record it on the failure when that could not be
   * confirmed, so the next Resume will not launch beside it.
   */
  private async abandonLaunch(taskId: string, reason: string, home: SpawnedHome, prepared: PreparedResume): Promise<HibernationResult> {
    const undone = await this.undoLaunch(home, prepared);
    if (undone.ok) return this.resumeFailed(taskId, reason);
    return this.resumeFailed(taskId, `${reason}, and ${undone.detail}, then Retry`, undone.launch);
  }

  /**
   * Undo a launch. Revoking an unclaimed lease means its guard can never start the agent.
   * Closing the home of one that already started only signals it, so the launch counts as undone
   * once its lease is released too - the guard's own word that the agent and everything it
   * started have exited. Otherwise it answers the launch, and what the operator has to do.
   */
  private async undoLaunch(
    home: SpawnedHome,
    prepared: PreparedResume,
  ): Promise<{ ok: true } | { ok: false; launch: TaskHibernationLaunch; detail: string }> {
    let revoked = false;
    try {
      revoked = prepared.dispose();
    } catch {
      revoked = false;
    }
    const launch: TaskHibernationLaunch = {
      homeName: home.homeName,
      homeBackend: home.homeBackend,
      terminalResourceId: home.terminalResourceId,
      leaseRoot: prepared.lease.root,
      leaseId: prepared.lease.id,
    };
    const closed = await this.terminal.closeHome(home);
    if (revoked || (closed.ok && await this.launchEnded(launch))) return { ok: true };
    return {
      ok: false,
      launch,
      detail: closed.ok
        ? `the agent it started was still running ${Math.round(this.terminal.launchEndMs / 1000)} seconds ` +
          `after ${home.homeName} closed. Stop that agent`
        : `${home.homeName} could not be closed (${closed.error ?? "no reason given"}). ` +
          "Its agent may still be running: close that terminal",
    };
  }

  /** Whether a launch has ended, given `launchEndMs` for its lease to be released. */
  private async launchEnded(launch: TaskHibernationLaunch): Promise<boolean> {
    const deadline = Date.now() + this.terminal.launchEndMs;
    while (this.terminal.launchLive(launch)) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, left)));
    }
    return true;
  }

  /**
   * Any live session other than `resumed` that holds the hibernated conversation right now.
   * Read across every session, not only the ones a watch saw arrive, immediately before a task
   * is bound: two processes on one conversation would interleave its file.
   */
  private rivalFor(resumed: Session, record: TaskHibernation): Session | undefined {
    return this.registry.snapshot().sessions.find((s) =>
      s.id !== resumed.id && s.state !== "exited" && s.agentSessionId === record.agentSessionId);
  }

  /** The task, its work episode and its armed workflow follow the session that reopened it. */
  private bindResumed(
    current: Task,
    session: Session,
    record: TaskHibernation,
    home: Partial<Pick<Task, "homeName" | "homeBackend" | "terminalResourceId" | "terminalLaunch">>,
  ): HibernationResult {
    const at = this.now();
    const running: Task = { ...current, ...home, status: "running", sessionId: session.id, hibernation: null, updatedAt: at };
    this.registry.upsertTask(running);
    this.registry.bindTaskToWorkEpisode(current.id, session.id);
    if (session.id !== record.sessionId) {
      this.options.workflows?.followResumedConversation(record.sessionId, record.noteKey, session, at);
    }
    logEvent(session.id, at, "task_resumed", { taskId: current.id, runtime: record.runtime });
    return { ok: true, task: this.registry.getTask(current.id) ?? running };
  }

  /**
   * Every NEW terminal session in `cwd` that reports holding the hibernated conversation, and
   * which of them this launch started.
   *
   * ONLY that conversation, reported: its id is what the note, blocker and workflow are keyed
   * on, and a new agent in the checkout reporting any other id is not this task's at all. And
   * only a session `prove` accepts as this launch's own - one the operator opened by hand on the
   * same conversation is a competitor, never the task's. `settle` answers with the launched
   * session and any competitors beside it, or the competitor or absence the deadline found.
   */
  private watchConversation(cwd: string, agent: Task["agent"], conversation: string): {
    cancel: () => void;
    settle: (prove: (s: Session) => Promise<boolean>, timeoutMs: number) => Promise<LaunchOutcome>;
  } {
    // Only a session that was not already there: another agent working in the same checkout is
    // not the one this resume started.
    const before = new Set(this.registry.snapshot().sessions.filter((s) => s.cwd === cwd).map((s) => s.id));
    const matches = (s: Session) =>
      !before.has(s.id) && s.runtime === "terminal" && s.agent === agent && s.cwd === cwd &&
      s.state !== "exited" && s.agentSessionId === conversation;
    const candidates = new Map<string, Session>();
    let changed: (() => void) | null = null;
    const unsubscribe = this.registry.subscribe((event) => {
      if (event.type === "session_upsert") {
        if (matches(event.session)) candidates.set(event.session.id, event.session);
        else candidates.delete(event.session.id);
        changed?.();
      } else if (event.type === "session_remove") {
        candidates.delete(event.id);
      }
    });
    const settle = (prove: (s: Session) => Promise<boolean>, timeoutMs: number) =>
      new Promise<LaunchOutcome>((resolve) => {
        let finished = false;
        let checking = false;
        let again = false;
        const finish = (outcome: LaunchOutcome) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          changed = null;
          unsubscribe();
          resolve(outcome);
        };
        const check = async (): Promise<void> => {
          if (checking) {
            again = true;
            return;
          }
          checking = true;
          try {
            do {
              again = false;
              for (const candidate of [...candidates.values()]) {
                if (finished) return;
                const ours = await prove(candidate).catch(() => false);
                if (ours && !finished) {
                  const others = [...candidates.values()].filter((s) => s.id !== candidate.id);
                  finish({ kind: "launched", session: this.registry.getSession(candidate.id) ?? candidate, others });
                  return;
                }
              }
            } while (again && !finished);
          } finally {
            checking = false;
          }
        };
        const timer = setTimeout(() => {
          const competitor = [...candidates.values()][0];
          finish(competitor ? { kind: "competitor", session: competitor } : { kind: "absent" });
        }, timeoutMs);
        timer.unref?.();
        changed = () => void check();
        void check();
      });
    return { cancel: unsubscribe, settle };
  }

  /**
   * Record why Resume failed on the still-hibernated task, so the Backlog can say so - with the
   * launch it could not close, when there is one, so the next Resume deals with it first.
   */
  private resumeFailed(taskId: string, reason: string, launch?: TaskHibernationLaunch): HibernationResult {
    const current = this.registry.getTask(taskId);
    const at = this.now();
    if (current?.status === "hibernated" && current.hibernation) {
      // A launch an earlier attempt could not close outlives every later failure - a missing
      // checkout, a refused relaunch - until `resumeTerminal` confirms it gone or closed. A
      // failure that replaced it would let the next Retry launch beside an agent still running.
      const kept = launch ?? current.hibernation.failure?.launch ?? null;
      this.registry.upsertTask({
        ...current,
        hibernation: { ...current.hibernation, failure: { reason, at, launch: kept } },
        updatedAt: at,
      });
    }
    return {
      ok: false,
      status: 409,
      error: `Could not resume: ${reason}. The task stays hibernated with its worktree and conversation kept.`,
    };
  }

  /** Let go of a recorded launch once `resumeTerminal` has confirmed it gone or closed. */
  private forgetLaunch(taskId: string): void {
    const current = this.registry.getTask(taskId);
    const failure = current?.hibernation?.failure;
    if (current?.status !== "hibernated" || !current.hibernation || !failure?.launch) return;
    this.registry.upsertTask({
      ...current,
      hibernation: { ...current.hibernation, failure: { ...failure, launch: null } },
      updatedAt: this.now(),
    });
  }

  /** A stop that failed left the agent running: give the task its session back. */
  private restoreRunning(taskId: string, sessionId: string): void {
    const current = this.registry.getTask(taskId);
    if (current?.status !== "hibernated") return;
    this.registry.upsertTask({ ...current, status: "running", sessionId, hibernation: null, updatedAt: this.now() });
    this.registry.bindTaskToWorkEpisode(taskId, sessionId);
  }

  /** A workflow run still in progress owns this session's next turn; hibernating would strand it. */
  private openWorkflowRun(session: Session): boolean {
    const runs = this.options.workflows?.runs() ?? [];
    return runs.some((run) => run.sessionId === session.id && workflowRunIsOpen(run.status));
  }
}
