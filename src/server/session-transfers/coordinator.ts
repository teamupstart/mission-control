import type { Session, Task, ReviewItem } from "@shared/types.ts";
import { isActiveTask } from "@shared/task-status.ts";
import { terminalResourceIds } from "@shared/pane.ts";
import { sessionTransferUnresolved, SESSION_TRANSFER_STATES } from "@shared/session-transfer.ts";
import { getTask, inTransaction, openDb, upsertTask, sessionWorkEpisodeFor, taskWorkEpisodeForTask } from "../db.ts";
import { canonicalWorktreePath } from "../worktrees/path.ts";
import { noteKeyFor, type Registry } from "../registry.ts";
import type { SdkSupervisor } from "../sdk/supervisor.ts";
import { clearSdkSessionTask, restoreSdkSessionTask, getSdkSession, getSdkSessionProcess } from "../sdk/store.ts";
import { prepareTerminalResume, recheckManagedResumes, type PreparedResume } from "../harness/resume.ts";
import { resumeContext } from "../resume-context.ts";
import { resumeLeaseStatus, readResumeLease, revokeResumeLease } from "../terminal/resume-lease.ts";
import { belongsToLaunch } from "../terminal/launch-process.ts";
import { listProcesses, listProcessesSnapshot } from "../discovery/processes.ts";
import { homeRecord, type SpawnedHome } from "../terminal/home.ts";
import { TerminalLaunchError } from "../terminal/launch-error.ts";
import { sessionLabel } from "../dispatcher.ts";
import { noteSessionHandoff } from "../telemetry/sessions.ts";
import { WorkflowStore } from "../workflows/store.ts";
import type { ReviewManager } from "../reviews.ts";
import type { WorkflowManager } from "../workflows/manager.ts";
import type { HandoffDeps, HandoffResult } from "../sdk/handoff.ts";
import { getSessionTransfer, reserveSessionTransfer, updateSessionTransfer, unresolvedSessionTransfers, failedSessionTransfers,
  transferForNote, transferForSource, transferForTask, transferBinding, transferTaskIdentity, transferScopeMatches,
  transferSummary, type SessionTransfer } from "./store.ts";

/** The only adopter. Neither restart nor recheck has access to the launch callback. */
export class SessionTransferCoordinator {
  private readonly store: WorkflowStore;
  private readonly executing = new Set<string>();
  private readonly checking = new Map<string, Promise<SessionTransfer>>();
  private readonly dirtyChecks = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private observedUnsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly registry: Registry, private readonly options: {
    workflows?: WorkflowManager;
    reviews?: ReviewManager;
    settleTask: (taskId: string) => void;
    taskBlocked?: (taskId: string) => boolean;
    processes?: typeof listProcesses;
    processSnapshot?: typeof listProcessesSnapshot;
  }) {
    this.store = options.workflows?.store ?? new WorkflowStore();
    this.store.assertRuntimeTransferConnection(openDb());
  }

  start(periodic = false): void {
    if (this.unsubscribe) return;
    // Queries used by every guard are durable and were available before TaskManager's
    // construction. Only an unused, still-matching preparation may release SDK restore,
    // including partial detachment that never reached the source-stop boundary.
    for (const transfer of unresolvedSessionTransfers()) {
      try {
        this.recoverBeforeStop(transfer);
      } catch { this.recovery(transfer, "Could not verify the interrupted preparation"); }
    }
    // Failure can commit just before publication/owner settlement is interrupted. Finish
    // only still-matching source ownership; these operations are idempotent in their owners.
    for (const transfer of failedSessionTransfers()) this.settleFailedOwners(transfer);
    this.unsubscribe = this.registry.subscribe((event) => {
      // Token/activity events elsewhere in the fleet must not start process scans for
      // every held transfer. Discovery and the periodic sweep still cover unnamed terminals.
      const transfer = event.type === "session_upsert"
        ? transferForSource(event.session.id) ?? transferForNote(noteKeyFor(event.session))
        : event.type === "session_remove" ? transferForSource(event.id) : null;
      if (transfer) void this.recheck(transfer.id);
    });
    this.observedUnsubscribe = this.registry.onSessionsObserved(() => { void this.recheckAll(); });
    if (periodic) this.timer = setInterval(() => { void this.recheckAll(); }, 5_000).unref();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = null;
    this.observedUnsubscribe?.(); this.observedUnsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(this.checking.values());
  }

  async resumeExited(source: Session, supervisor: SdkSupervisor | undefined, deps: HandoffDeps): Promise<HandoffResult> {
    if (source.state !== "exited" || supervisor?.handleFor(source.id)) return { ok: false, error: "The original agent is still running" };
    if (source.runtime === "sdk") {
      const row = getSdkSession(source.id);
      if (!row || (row.status !== "exited" && row.status !== "failed")) return { ok: false, error: "The original embedded agent's exit is not yet confirmed" };
    }
    return this.run(source, null, deps);
  }

  private lease(transfer: SessionTransfer) {
    const lease = readResumeLease(transfer.facts.leaseRoot, transfer.facts.leaseId);
    if (lease.sourceSessionId !== transfer.sourceSessionId || lease.conversation !== `${transfer.facts.agent}:${transfer.facts.nativeId}`) {
      throw new Error("Transfer lease identity changed");
    }
    return lease;
  }

  private change(current: SessionTransfer, patch: Parameters<typeof updateSessionTransfer>[1]): SessionTransfer {
    const next = updateSessionTransfer(current, patch);
    this.registry.publishSessionTransfers(next);
    return next;
  }

  private recovery(current: SessionTransfer, reason: string): SessionTransfer {
    if (current.state === "recovery_required" && current.reason === reason) return current;
    return this.change(current, { state: "recovery_required", reason });
  }

  private ownershipChanged(transfer: SessionTransfer, unbound = true): string | null {
    const { facts } = transfer;
    if (sessionWorkEpisodeFor(transfer.sourceSessionId)?.episodeId !== (facts.sourceEpisodeId ?? undefined)) return "Source work episode changed";
    const source = this.registry.getSession(transfer.sourceSessionId);
    if (source && !transferScopeMatches(facts, source)) return "Source conversation or checkout changed";
    if (!this.store.runtimeTransferBindingsMatch(transfer.noteKey, facts.bindings)) return "Pinned workflow ownership changed";
    if (transfer.taskId) {
      const task = getTask(transfer.taskId);
      if (!task || transferTaskIdentity(task) !== facts.taskIdentity
        || task.sessionId !== (unbound ? null : transfer.sourceSessionId)
        || (taskWorkEpisodeForTask(task.id)?.episodeId ?? null) !== facts.taskEpisodeId) return "Task ownership or work attempt changed";
    }
    return null;
  }

  /** A durable false stop marker proves detachment never crossed into the external stop. */
  private recoverBeforeStop(transfer: SessionTransfer): SessionTransfer | null {
    const { facts } = transfer;
    if (!["prepared", "stopping", "recovery_required"].includes(transfer.state) || facts.stopStarted
      || facts.launchAt !== null || facts.launchOutcome !== "not_started" || facts.home !== null) return null;
    const task = transfer.taskId ? getTask(transfer.taskId) : null;
    const sdk = facts.sourceRuntime === "sdk" ? getSdkSession(transfer.sourceSessionId) : null;
    // Either pointer may have been cleared before the daemon stopped. A foreign owner,
    // changed attempt, conversation, episode or binding still refuses rollback.
    if (this.ownershipChanged(transfer, task?.sessionId !== transfer.sourceSessionId)
      || (facts.sourceRuntime === "sdk" && (!sdk || sdk.agent !== facts.agent || sdk.agentSessionId !== facts.nativeId
        || canonicalWorktreePath(sdk.cwd) !== facts.cwd || (sdk.taskId !== null && sdk.taskId !== transfer.taskId)))) {
      return this.recovery(transfer, "Source ownership changed before terminal preparation completed");
    }
    if (!revokeResumeLease(this.lease(transfer))) {
      return this.recovery(transfer, "Could not revoke the unused terminal preparation; ownership is retained");
    }
    const restored = inTransaction(() => {
      const nextTask = task && task.sessionId !== transfer.sourceSessionId
        ? { ...task, sessionId: transfer.sourceSessionId, updatedAt: Date.now() } : null;
      if (task && sdk) restoreSdkSessionTask(transfer.sourceSessionId, task.id);
      const displaced = nextTask ? upsertTask(nextTask) : [];
      const next = updateSessionTransfer(transfer, { state: "aborted",
        reason: "Terminal preparation was interrupted before source shutdown; the original conversation is retained" });
      return { transfer: next, task: nextTask, displaced };
    });
    if (restored.task) this.registry.publishPersistedTask(restored.task, restored.displaced);
    this.registry.publishSessionTransfers(restored.transfer);
    return restored.transfer;
  }

  /** Prepare while the source is usable, then persist each boundary before its side effect. */
  async run(source: Session, supervisor: SdkSupervisor | null, deps: HandoffDeps): Promise<HandoffResult> {
    const prior = transferForNote(noteKeyFor(source));
    if (prior) return this.result(prior);
    if (!source.cwd || !source.agentSessionId) return { ok: false, error: "This conversation has no checkout or native identity to resume" };
    if (this.registry.sessionResetInProgress(source.id)) return { ok: false, error: "This session is being reset" };
    const task = this.registry.listTasks().find((t) => t.sessionId === source.id && isActiveTask(t.status)) ?? null;
    if (task && (transferForTask(task.id) || this.options.taskBlocked?.(task.id))) return { ok: false, error: "This task already has an ownership operation in progress" };
    const bindings = this.store.activeBindingsForNote(noteKeyFor(source)).map(transferBinding);
    if (bindings.some((b) => b.sessionId !== source.id)) return { ok: false, error: "The pinned workflow belongs to another session; resolve its ownership first" };
    const expectedTask = task ? transferTaskIdentity(task) : null;
    const sourceEpisodeId = this.registry.workEpisodeForSession(source.id)?.episodeId ?? null;
    const inventory = await (this.options.processes ?? listProcesses)();
    const sourceProcess = supervisor ? inventory.find((p) => p.pid === source.pid)
      : source.runtime === "sdk" ? getSdkSessionProcess(source.id)
        : source.startedAt !== null && source.startedAt > 0 ? { pid: source.pid, startMs: source.startedAt } : null;
    let prepared: PreparedResume;
    try {
      prepared = await (deps.prepare ?? ((session) => prepareTerminalResume(session, resumeContext(session, task, bindings.length > 0, false))))(source);
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Could not prepare terminal" }; }
    let transfer: SessionTransfer;
    try {
      transfer = inTransaction(() => {
        const current = this.registry.getSession(source.id);
        if (!current || current.agentSessionId !== source.agentSessionId || current.cwd !== source.cwd
          || this.registry.sessionResetInProgress(source.id)
          || sessionWorkEpisodeFor(source.id)?.episodeId !== (sourceEpisodeId ?? undefined)
          || !this.store.runtimeTransferBindingsMatch(noteKeyFor(source), bindings)
          || (task && (getTask(task.id)?.sessionId !== source.id || transferTaskIdentity(getTask(task.id)!) !== expectedTask || this.options.taskBlocked?.(task.id)))) {
          throw new Error("Ownership changed during preparation; try Continue in terminal again");
        }
        const db = openDb();
        if (db.prepare("SELECT id FROM pending_turns WHERE note_key = ? AND state = 'sending'").get(noteKeyFor(source))
          || db.prepare("SELECT id FROM workflow_deliveries WHERE note_key = ? AND state = 'sending'").get(noteKeyFor(source))) {
          throw new Error("A message is being delivered. Wait for its outcome before continuing in terminal");
        }
        return reserveSessionTransfer({ sourceSessionId: source.id, noteKey: noteKeyFor(source), taskId: task?.id ?? null,
          facts: { agent: source.agent, nativeId: source.agentSessionId!, sourceName: source.name, sourceRuntime: source.runtime,
            sourceEpisodeId, cwd: canonicalWorktreePath(source.cwd!), repoRoot: source.repoRoot === null ? null : canonicalWorktreePath(source.repoRoot),
            taskIdentity: expectedTask, taskEpisodeId: task ? taskWorkEpisodeForTask(task.id)?.episodeId ?? null : null,
            bindings, leaseRoot: prepared.lease.root, leaseId: prepared.lease.id, backend: deps.backend ?? null,
            home: null, sourceStopped: false, stopStarted: false,
            sourceProcess: sourceProcess ? { pid: sourceProcess.pid, startMs: sourceProcess.startMs } : null, launchAt: null, launchOutcome: "not_started", canEnd: false } });
      });
    } catch (error) {
      prepared.dispose();
      return { ok: false, error: error instanceof Error ? error.message : "Could not reserve terminal transfer" };
    }
    this.executing.add(transfer.id);
    const capturedBoundary = this.options.workflows?.runtimeTransferCaptureBoundary(transfer.noteKey);
    this.registry.publishSessionTransfers(transfer);
    let cancelTelemetry = () => {};
    let unbound = false;
    try {
      await capturedBoundary;
      const changed = this.ownershipChanged(transfer, false);
      if (changed) throw new Error(changed);
      transfer = this.change(transfer, { state: "stopping", reason: "Preparing source shutdown before terminal launch" });
      if (task) {
        if (source.runtime === "sdk") clearSdkSessionTask(source.id);
        this.registry.upsertTask({ ...getTask(task.id)!, sessionId: null, updatedAt: Date.now() });
      }
      unbound = true;
      cancelTelemetry = noteSessionHandoff(source.id);
      const driver = supervisor?.handleFor(source.id);
      let sourceProcess = transfer.facts.sourceProcess;
      if (supervisor) {
        const pid = driver?.recoveryProcessId;
        const observed = await (this.options.processSnapshot ?? listProcessesSnapshot)();
        const process = observed.processes.find((p) => p.pid === pid && p.startMs > 0);
        if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || observed.unknownReason || !process
          || supervisor.handleFor(source.id)?.recoveryProcessId !== pid) {
          throw new Error("Could not record the embedded driver's process lifetime; try Continue in terminal again");
        }
        sourceProcess = { pid: process.pid, startMs: process.startMs };
      }
      // Persist intent immediately before the external stop. Until this boundary, startup
      // can roll back either partially cleared task pointer without replaying a stop.
      transfer = this.change(transfer, { facts: { ...transfer.facts, sourceProcess, stopStarted: true },
        reason: "Stopping the embedded conversation before terminal launch" });
      if (supervisor) await supervisor.stop(source.id);
      else if (!await this.sourceExitProven(transfer)) throw new Error("The original agent's process exit is not yet confirmed");
      transfer = this.change(transfer, { state: "launching", reason: "Opening the terminal; launch outcome is not yet known",
        facts: { ...transfer.facts, sourceStopped: true, launchAt: Date.now(), launchOutcome: "unknown" } });
    } catch (error) {
      const revoked = prepared.dispose();
      const surviving = Boolean(supervisor?.handleFor(source.id));
      const lifetime = transfer.facts.stopStarted ? await this.sourceLifetime(transfer) : "unknown";
      const sourceSurvives = surviving && (!transfer.facts.stopStarted || (lifetime === "live"
        && supervisor?.handleFor(source.id)?.recoveryProcessId === transfer.facts.sourceProcess?.pid));
      if (sourceSurvives && revoked && !this.ownershipChanged(transfer, unbound)) {
        cancelTelemetry();
        let restored: Task | null = null;
        let displaced: string[] = [];
        transfer = inTransaction(() => {
          if (task) {
            restoreSdkSessionTask(source.id, task.id);
            restored = { ...getTask(task.id)!, sessionId: source.id, updatedAt: Date.now() };
            displaced = upsertTask(restored);
          }
          return updateSessionTransfer(transfer, { state: "aborted", reason: "Source still running; nothing transferred" });
        });
        if (restored) this.registry.publishPersistedTask(restored, displaced);
        this.registry.publishSessionTransfers(transfer);
      } else if (!surviving && revoked && lifetime === "gone"
        && !supervisor?.handleFor(source.id) && !this.ownershipChanged(transfer, unbound)) {
        transfer = this.change(transfer, { facts: { ...transfer.facts, sourceStopped: true } });
        transfer = this.fail(transfer, "The embedded driver stopped without a replacement; its checkout was kept");
      } else transfer = this.recovery(transfer, "Could not verify that the source stopped; no replacement launch was attempted");
      this.executing.delete(transfer.id);
      return { ok: false, error: `${transfer.reason}: ${error instanceof Error ? error.message : "stop failed"}`, transfer: transferSummary(transfer) };
    }

    try {
      const home = await deps.spawn({ name: sessionLabel(task?.title?.trim() || source.name || source.agent), shortId: source.id.slice(-6), prepared });
      transfer = getSessionTransfer(transfer.id)!;
      transfer = this.change(transfer, { state: "awaiting_successor", reason: "Terminal opened; waiting for discovery",
        facts: { ...transfer.facts, home, launchOutcome: home.launchOutcome ?? "launched" } });
      if (task) this.registry.upsertTask({ ...getTask(task.id)!, ...homeRecord(home), updatedAt: Date.now() });
    } catch (error) {
      if (error instanceof TerminalLaunchError && !error.outcomeUnknown && resumeLeaseStatus(prepared.lease).state === "revoked") {
        transfer = this.fail(transfer, `The embedded session stopped but no terminal could be opened (${error.message}); its worktree was kept`);
      } else transfer = this.recovery(transfer, "Could not verify the terminal launch. Check again to observe this attempt; no additional agent will be launched");
      this.executing.delete(transfer.id);
      return this.result(transfer);
    }
    this.executing.delete(transfer.id);
    // The compatibility waiter is a response budget only. Its cwd answer is never authority.
    await this.recheck(transfer.id);
    const current = getSessionTransfer(transfer.id)!;
    if (sessionTransferUnresolved(current.state)) {
      await deps.waitForSessionAtCwd(source.cwd, 30_000);
      await this.recheck(transfer.id);
    }
    return this.result(getSessionTransfer(transfer.id)!);
  }

  private result(transfer: SessionTransfer): HandoffResult {
    if (transfer.state === "failed" || transfer.state === "aborted") return { ok: false, error: transfer.reason, transfer: transferSummary(transfer) };
    return { ok: true, homeName: transfer.facts.home?.homeName ?? transfer.facts.sourceName,
      sessionId: transfer.successorSessionId, launchOutcome: transfer.facts.launchOutcome === "launched" ? "launched" : "unknown",
      resumeLeaseId: transfer.facts.leaseId, transfer: transferSummary(transfer) };
  }

  private fail(transfer: SessionTransfer, reason: string): SessionTransfer {
    const changed = this.change(transfer, { state: "failed", reason, facts: { ...transfer.facts, canEnd: false, launchOutcome: "refused" } });
    this.settleFailedOwners(changed);
    return changed;
  }

  private settleFailedOwners(transfer: SessionTransfer): void {
    const task = transfer.taskId ? getTask(transfer.taskId) : null;
    if (task && task.sessionId === null && transferTaskIdentity(task) === transfer.facts.taskIdentity) this.options.settleTask(task.id);
    const bindings = transfer.facts.bindings.filter((expected) => {
      const current = this.store.getBinding(expected.id);
      return current?.state === "active" && JSON.stringify(transferBinding(current)) === JSON.stringify(expected);
    });
    this.options.workflows?.settleRuntimeTransfer(bindings.map((binding) => binding.id));
    if ((sessionWorkEpisodeFor(transfer.sourceSessionId)?.episodeId ?? null) === transfer.facts.sourceEpisodeId) {
      this.options.reviews?.settleRuntimeTransfer?.(transfer.sourceSessionId);
    }
  }

  async recheckAll(): Promise<void> {
    for (const transfer of unresolvedSessionTransfers()) {
      try { await this.recheck(transfer.id); } catch { /* An individual damaged record cannot hide other recoveries. */ }
    }
  }

  recheck(id: string): Promise<SessionTransfer> {
    const active = this.checking.get(id);
    if (active) { this.dirtyChecks.add(id); return active; }
    const work = (async () => {
      let result: SessionTransfer;
      do {
        this.dirtyChecks.delete(id);
        result = await this.observe(id);
      } while (this.dirtyChecks.has(id));
      return result;
    })().finally(() => { this.checking.delete(id); });
    this.checking.set(id, work);
    return work;
  }

  private async sourceExitProven(transfer: SessionTransfer): Promise<boolean> {
    return await this.sourceLifetime(transfer) === "gone";
  }

  private async sourceLifetime(transfer: SessionTransfer): Promise<"live" | "gone" | "unknown"> {
    const expected = transfer.facts.sourceProcess;
    if (!expected || expected.pid <= 0 || expected.startMs <= 0) return "unknown";
    try {
      // The pump can drop its handle and persist a failed/exited row while its child
      // remains alive. Only a complete inventory can prove this saved lifetime ended.
      const observed = await (this.options.processSnapshot ?? listProcessesSnapshot)();
      const source = observed.processes.find((p) => p.pid === expected.pid);
      if (observed.unknownReason || (source && source.startMs <= 0)) return "unknown";
      return source?.startMs === expected.startMs ? "live" : "gone";
    } catch { return "unknown"; }
  }

  private async observe(id: string): Promise<SessionTransfer> {
    let transfer = getSessionTransfer(id);
    if (!transfer) throw new Error("No such terminal transfer");
    if (!sessionTransferUnresolved(transfer.state) || this.executing.has(id)) return transfer;
    if (!(SESSION_TRANSFER_STATES as readonly string[]).includes(transfer.state)) return transfer;
    try {
      const restored = this.recoverBeforeStop(transfer);
      if (restored) return restored;
      if (transfer.state === "prepared") return transfer;
      recheckManagedResumes();
      const lease = this.lease(transfer);
      const status = resumeLeaseStatus(lease);
      if (!transfer.facts.sourceStopped) {
        if (!await this.sourceExitProven(transfer)) {
          const canEnd = !transfer.facts.stopStarted && (status.state === "revoked" || status.state === "completed");
          if (transfer.facts.canEnd !== canEnd) transfer = this.change(transfer, { facts: { ...transfer.facts, canEnd } });
          return this.recovery(transfer, "Source shutdown was interrupted; its outcome is unknown. No replacement was launched automatically");
        }
        transfer = this.change(transfer, { facts: { ...transfer.facts, sourceStopped: true } });
      }
      const conflict = this.ownershipChanged(transfer);
      if (conflict) {
        const canEnd = status.state === "revoked" || status.state === "completed";
        if (transfer.facts.canEnd !== canEnd) transfer = this.change(transfer, { facts: { ...transfer.facts, canEnd } });
        return this.recovery(transfer, `${conflict}; automatic adoption is held`);
      }
      if (status.state === "revoked" || status.state === "completed") {
        return this.fail(transfer, "The source stopped and this terminal attempt cannot run; the task's checkout was kept");
      }
      if (this.registry.sessionsObserved()) {
        const candidates = this.registry.snapshot().sessions.filter((candidate) => candidate.id !== transfer!.sourceSessionId
          && candidate.runtime === "terminal" && candidate.state !== "exited" && candidate.state !== "stopping"
          && transferScopeMatches(transfer!.facts, candidate.agentSessionId === null && transfer!.facts.resumeHookAt
            ? { ...candidate, agentSessionId: transfer!.facts.nativeId } : candidate));
        for (const candidate of candidates) {
          const home = await this.provenHome(transfer, candidate);
          if (!home) continue;
          const current = getSessionTransfer(id)!;
          if (current.revision !== transfer.revision) return current;
          let live = this.registry.getSession(candidate.id);
          if (live && live.agentSessionId === null && transfer.facts.resumeHookAt && live.pid === candidate.pid && live.startedAt === candidate.startedAt) {
            live = this.registry.bindLaunchedAgentSession(live.id, transfer.facts.agent, transfer.facts.nativeId) ?? undefined;
          }
          if (!live || live.state === "exited" || live.runtime !== "terminal" || !transferScopeMatches(transfer.facts, live)
            || live.pid !== candidate.pid || live.startedAt !== candidate.startedAt) continue;
          if (this.registry.listTasks().some((t) => isActiveTask(t.status) && t.sessionId === live.id && t.id !== transfer!.taskId)) {
            return this.recovery(transfer, "The terminal already owns another task; automatic adoption is held");
          }
          this.registry.workEpisodeForSession(live.id);
          let persisted: { task: Task; displaced: string[] } | null = null;
          let requests: ReviewItem[] = [];
          const adopted = inTransaction(() => {
            const latest = getSessionTransfer(id)!;
            const changed = this.ownershipChanged(latest);
            if (latest.revision !== transfer!.revision || changed) throw new Error(changed ?? "Transfer changed");
            if (latest.taskId) persisted = this.registry.persistRuntimeTransferTask(getTask(latest.taskId)!, live, home);
            this.store.transferRuntimeBindings(latest.noteKey, latest.sourceSessionId, live.id, latest.facts.bindings);
            requests = this.options.reviews?.persistRuntimeTransfer?.(latest.sourceSessionId, live.id) ?? [];
            return updateSessionTransfer(latest, { state: "adopted", successorSessionId: live.id,
              reason: "Conversation, task and pinned workflows continued in terminal",
              facts: { ...latest.facts, home, canEnd: false } });
          });
          this.options.reviews?.publishRuntimeTransfer?.(requests);
          this.options.workflows?.publishRuntimeTransfer(adopted.facts.bindings.map((b) => b.id));
          if (persisted) {
            const { task, displaced } = persisted as { task: Task; displaced: string[] };
            this.registry.publishRuntimeTransferTask(task, displaced);
          }
          this.registry.publishRuntimeTransferSession(live.id, home);
          this.registry.publishSessionTransfers(adopted);
          return adopted;
        }
      }
      if (Date.now() - (transfer.facts.launchAt ?? transfer.createdAt) >= 120_000 || transfer.state === "stopping" || transfer.state === "launching") {
        return this.recovery(transfer, "Could not verify the terminal. Check again after it appears; this attempt will not launch another agent");
      }
      return transfer;
    } catch {
      const current = getSessionTransfer(id)!;
      return sessionTransferUnresolved(current.state)
        ? this.recovery(current, "Could not verify terminal ownership. The task, workflows and launch environment are retained") : current;
    }
  }

  private async provenHome(transfer: SessionTransfer, candidate: Session): Promise<SpawnedHome | null> {
    const { home, backend } = transfer.facts;
    const expectedBackend = home?.homeBackend ?? backend;
    if (expectedBackend && candidate.terminals.length && !candidate.terminals.some((handle) => handle.backend === expectedBackend)) return null;
    const resourceMatches = Boolean(home?.terminalResourceId && terminalResourceIds(candidate).has(home.terminalResourceId));
    if (home?.terminalResourceId && candidate.terminals.length && !resourceMatches) return null;
    // Emulator targets are exact inventory IDs. Multiplexer resource IDs contain a
    // reusable session name, so they additionally need the claimed wrapper's lifetime.
    if (resourceMatches && home?.terminalResourceId?.startsWith("emulator:")) return home;
    const owner = resumeLeaseStatus(this.lease(transfer)).owner;
    if (!owner || !belongsToLaunch(candidate, owner, await (this.options.processes ?? listProcesses)())) return null;
    if (home?.terminalResourceId) return home;
    // Crash before the launch acknowledgement: the claimed wrapper's exact lifetime is
    // stronger than a mutable home name. Derive its observed resource only after ancestry.
    const handle = candidate.terminals.find((h) => h.kind === "multiplexer") ?? candidate.terminals[0];
    if (!handle) return null;
    const resource = [...terminalResourceIds(candidate)].find((r) => r.startsWith(`${handle.kind}:${handle.backend}:`));
    if (!resource) return null;
    return { homeName: home?.homeName ?? transfer.facts.sourceName, homeBackend: handle.backend,
      terminalResourceId: resource, launchProcess: owner, resumeLeaseId: transfer.facts.leaseId };
  }

  /** Resolution is fenced by the same positive absence proof; the browser cannot pick an owner. */
  async resolve(id: string, revision: number): Promise<SessionTransfer> {
    const current = getSessionTransfer(id);
    if (!current) throw new Error("No such terminal transfer");
    if (current.revision !== revision) throw new Error("Terminal transfer changed; check again");
    if (!(SESSION_TRANSFER_STATES as readonly string[]).includes(current.state)) {
      throw new Error("Cannot end an unrecognized transfer state; its ownership is retained");
    }
    const checked = await this.recheck(id);
    if (!(SESSION_TRANSFER_STATES as readonly string[]).includes(checked.state)) {
      throw new Error("Cannot end an unrecognized transfer state; its ownership is retained");
    }
    if (!sessionTransferUnresolved(checked.state)) return checked;
    const status = resumeLeaseStatus(this.lease(checked));
    if (checked.facts.canEnd && (status.state === "revoked" || status.state === "completed")) {
      if (!checked.facts.stopStarted) return this.change(checked, { state: "aborted", reason: "Unused terminal transfer ended; existing ownership was retained" });
      const ended = this.change(checked, { state: "failed", reason: "Terminal transfer ended; the checkout was retained" });
      this.settleFailedOwners(ended);
      return ended;
    }
    throw new Error("The terminal or source may still be running. Check again; ending this transfer is not yet safe");
  }
}
