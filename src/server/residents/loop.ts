import { RESIDENT_OPERATOR_PAUSE_REASON, ScheduleNextIterationSchema, residentRunSummary, type ResidentPacingRequest, type ResidentRun } from "@shared/residents.ts";
import { residentWakeMarker } from "@shared/resident-turn.ts";
import { reportBucket } from "@shared/session.ts";
import type { Session } from "@shared/types.ts";
import { sessionMessages, type SessionMessages } from "../harness/index.ts";
import { recordInjection, reserveInjection, releaseInjection } from "../injections.ts";
import type { Registry } from "../registry.ts";
import { noteKeyFor } from "../registry.ts";
import type { SdkSupervisor } from "../sdk/supervisor.ts";
import { adoptResidentLaunch, getResidentRun, listOpenResidentRuns, residentRunForTask } from "./store.ts";
import {
  ResidentLoopRefusal, beginResidentCompaction, claimResidentWake, claimedIteration, completeResidentCompaction, completeResidentGeneration,
  humanResidentTurn, liveRun, paceResident, pauseResident, pruneResidentLoop, residentClaims,
  residentGuardrail, resumeResident, settleResidentClaim, type ResidentIteration,
} from "./loop-store.ts";

interface LoopDeps {
  registry: Pick<Registry, "subscribe" | "getTask" | "getSession" | "upsertResidentRun" | "onTurnDelivered">;
  sdk: Pick<SdkSupervisor, "sendWhenIdle" | "compact">;
  refreshSession: (session: Session) => void;
  now?: () => number;
  messages?: (session: Session) => SessionMessages | null;
}

/** The daemon's only resident-turn owner. All decisions re-read the durable pinned run. */
export class ResidentLoop {
  private readonly now: () => number;
  private readonly messages: (session: Session) => SessionMessages | null;
  private stopped = true;
  private subscriptions: Array<() => void> = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private pruneTimer: NodeJS.Timeout | null = null;
  private sending = new Map<string, Promise<void>>();
  private queued = new Set<string>();
  constructor(private readonly deps: LoopDeps) {
    this.now = deps.now ?? Date.now;
    this.messages = deps.messages ?? sessionMessages;
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // Resolve even ended runs' claims before retention can touch any of their evidence.
    for (const claim of residentClaims()) {
      const run = getResidentRun(claim.run_id)?.run;
      const session = run && this.session(run);
      const landedAt = session && run ? this.findMarker(session, claim, run) : null;
      settleResidentClaim(claim, landedAt === null ? "unconfirmed" : "sent", landedAt ?? this.now());
      this.publish(claim.run_id);
    }
    pruneResidentLoop(this.now());
    this.pruneTimer = setInterval(() => {
      try { pruneResidentLoop(this.now()); }
      catch (error) { console.error("[residents] delivery retention failed:", error); }
    }, 3_600_000);
    this.pruneTimer.unref();
    this.subscriptions.push(this.deps.registry.subscribe((event) => {
      if (event.type === "session_upsert" && event.session.task?.kind === "resident") {
        const run = residentRunForTask(event.session.task.id)?.run;
        if (run) this.enqueue(run.id);
      } else if (event.type === "resident_run_upsert") this.enqueue(event.run.id);
      else if (event.type === "resident_run_remove") this.cancelTimer(event.id);
    }));
    this.subscriptions.push(this.deps.registry.onTurnDelivered(({ sessionId }) => {
      const session = this.deps.registry.getSession(sessionId);
      const run = session?.task && residentRunForTask(session.task.id)?.run;
      if (run && run.endedAt === null) {
        humanResidentTurn(run.id);
        this.cancelTimer(run.id);
        this.publish(run.id);
        this.enqueue(run.id);
      }
    }));
    for (const { run } of listOpenResidentRuns()) {
      if (run.launchState !== "launched") continue;
      adoptResidentLaunch(run.id, this.now());
      // A compaction interrupted by daemon shutdown is never blindly repeated.
      if (run.loopState === "compacting") pauseResident(run.id, "Compaction interrupted by daemon restart.");
      this.publish(run.id);
      this.enqueue(run.id);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    for (const id of this.timers.keys()) this.cancelTimer(id);
    await Promise.allSettled(this.sending.values());
  }
  private session(run: ResidentRun): Session | undefined {
    const id = this.deps.registry.getTask(run.taskId)?.sessionId;
    return id ? this.deps.registry.getSession(id) : undefined;
  }
  private publish(id: string): void {
    const run = getResidentRun(id)?.run;
    const summary = run && residentRunSummary(run);
    if (summary) this.deps.registry.upsertResidentRun(summary);
  }
  private cancelTimer(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
  private enqueue(id: string): void {
    if (this.stopped || this.queued.has(id)) return;
    this.queued.add(id);
    queueMicrotask(() => {
      this.queued.delete(id);
      if (this.stopped) return;
      try { this.observe(id); }
      catch (error) { console.error(`[residents] could not observe resident run ${id}:`, error); }
    });
  }
  private observe(id: string): void {
    const run = getResidentRun(id)?.run;
    if (!run || run.endedAt !== null || run.launchState !== "launched") { this.cancelTimer(id); return; }
    const session = this.session(run);
    if (!session || session.runtime !== "sdk") return;
    if (run.loopState === "paused") { this.cancelTimer(id); return; }
    if (reportBucket(session) === "needs-you") { this.pause(id, "needs-you"); return; }
    if (session.pendingTurns.length > 0) {
      if (run.nextWakeAt !== null) { humanResidentTurn(id); this.publish(id); }
      this.cancelTimer(id);
      return;
    }
    if (this.sending.has(id) || run.loopState === "compacting") return;
    const cycle = session.workCycle;
    if (cycle?.active || session.state !== "idle") {
      if (run.nextWakeAt !== null) { humanResidentTurn(id); this.cancelTimer(id); this.publish(id); }
      return;
    }
    if (cycle?.completedAt !== null && cycle?.completedAt !== undefined &&
        completeResidentGeneration(id, cycle.generation, cycle.completedAt)) this.publish(id);
    const current = getResidentRun(id)!.run;
    if (current.nextWakeAt === null || this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.wake(id, "loop");
    }, Math.max(0, Math.min(2_147_483_647, current.nextWakeAt - this.now())));
    timer.unref();
    this.timers.set(id, timer);
  }
  pause(id: string, reason = RESIDENT_OPERATOR_PAUSE_REASON): void {
    liveRun(id);
    pauseResident(id, reason);
    this.cancelTimer(id);
    this.publish(id);
  }
  resume(id: string): void {
    const run = liveRun(id);
    const block = residentGuardrail(run, this.now());
    if (block) throw new ResidentLoopRefusal(block);
    const session = this.session(run);
    if (!session) throw new ResidentLoopRefusal("The resident session is unavailable.");
    if (reportBucket(session) === "needs-you") throw new ResidentLoopRefusal("Resolve the resident's request for you before resuming.");
    this.cancelTimer(id);
    const working = session.workCycle?.active || session.state !== "idle";
    resumeResident(id, working, session.workCycle?.generation ?? null, this.now());
    this.publish(id);
    this.enqueue(id);
  }
  schedule(session: Session, request: ResidentPacingRequest) {
    const run = session.task && residentRunForTask(session.task.id)?.run;
    if (!run) throw new ResidentLoopRefusal("Only a resident can schedule its next iteration.");
    const parsed = ScheduleNextIterationSchema.safeParse(request);
    if (!parsed.success) throw new ResidentLoopRefusal(parsed.error.message);
    const receipt = paceResident(run.id, parsed.data, session.workCycle?.generation ?? 0, this.now());
    this.cancelTimer(run.id);
    this.publish(run.id);
    this.enqueue(run.id);
    return receipt;
  }
  async runNow(id: string): Promise<void> {
    const run = liveRun(id);
    if (this.stopped) throw new ResidentLoopRefusal("The resident loop is restoring or shutting down.");
    const session = this.session(run);
    if (!session) throw new ResidentLoopRefusal("The resident session is unavailable.");
    if (session.state !== "idle" || session.workCycle?.active || session.pendingTurns.length) {
      throw new ResidentLoopRefusal("A human message or active turn has priority. Run again when the resident is idle.");
    }
    if (run.loopState === "paused") this.resume(id);
    this.cancelTimer(id);
    await this.wake(id, "run_now");
  }
  private wake(id: string, trigger: "loop" | "run_now"): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const active = this.sending.get(id);
    if (active) return active;
    const operation = this.deliver(id, trigger).catch((error: unknown) => {
      const run = getResidentRun(id)?.run;
      if (run && run.endedAt === null) this.pause(id, error instanceof Error ? error.message : String(error));
    }).finally(() => { this.sending.delete(id); this.enqueue(id); });
    this.sending.set(id, operation);
    return operation;
  }
  private blocker(run: ResidentRun, session: Session): string | null {
    const current = getResidentRun(run.id)?.run;
    const target = current && this.session(current);
    if (this.stopped || !current || current.endedAt !== null || current.loopState === "paused") return "Resident paused or ended.";
    if (!target || target.id !== session.id || target.agentSessionId !== session.agentSessionId) return "Resident conversation changed.";
    if (target.pendingTurns.length || reportBucket(target) === "needs-you" || target.state !== "idle" || target.workCycle?.active) return "A human message or active turn has priority.";
    return null;
  }
  private async deliver(id: string, trigger: "loop" | "run_now"): Promise<void> {
    let run = liveRun(id);
    if (run.loopState === "paused" || claimedIteration(id)) return;
    let session = this.session(run);
    if (!session || this.blocker(run, session)) return;
    // A restored overdue wake or Run now can precede the next passive poll.
    // Reuse that reader before checking context and spend, then re-read its registry result.
    this.deps.refreshSession(session);
    session = this.session(run);
    if (!session || this.blocker(run, session)) return;
    const cap = residentGuardrail(run, this.now());
    if (cap) { this.pause(id, cap); return; }
    const contextPct = session.meta?.contextPct;
    if (contextPct == null || !Number.isFinite(contextPct) || contextPct < 0) {
      this.pause(id, "Context cannot be measured. Resume after the context reading is available."); return;
    }
    if (contextPct >= run.settings.loop.contextThreshold) {
      beginResidentCompaction(id);
      this.publish(id);
      const compactedPct = await this.deps.sdk.compact(session.id, run.settings.loop.compactionFocus, () => this.blocker(run, session));
      run = liveRun(id);
      if (this.blocker(run, session)) {
        if (run.loopState === "compacting") this.pause(id, "Compaction interrupted by a human message or a conversation change.");
        return;
      }
      const current = this.session(run)!;
      if (!Number.isFinite(compactedPct) || compactedPct >= run.settings.loop.contextThreshold) {
        this.pause(id, "Compaction did not establish context below the profile threshold."); return;
      }
      completeResidentCompaction(id, current.workCycle?.generation ?? null);
    }
    if (this.blocker(run, session)) return;
    // Compaction spends tokens too. Recheck the window after every awaited operation.
    const afterCompaction = residentGuardrail(liveRun(id), this.now());
    if (afterCompaction) { this.pause(id, afterCompaction); return; }
    let offset: number | null = null;
    try { const transcript = this.messages(session); offset = transcript?.read.size(transcript.path) ?? null; } catch { /* unknown evidence is explicit */ }
    const claim = claimResidentWake(id, trigger, offset, this.now(), noteKeyFor(session));
    if (!claim) return;
    const text = `${residentWakeMarker(id, claim.seq)}\n${run.settings.loop.prompt}`;
    let crossed = false;
    reserveInjection(session.id, text, "resident");
    try {
      const accepted = await this.deps.sdk.sendWhenIdle(session.id, { text }, () => {
        const blocked = this.blocker(run, session);
        if (!blocked) crossed = true;
        return blocked;
      });
      settleResidentClaim(claim, accepted === null ? "released" : "sent", this.now());
      if (accepted) recordInjection(session.id, text, "resident");
      else releaseInjection(session.id, text);
    } catch {
      settleResidentClaim(claim, crossed ? "unconfirmed" : "released", this.now());
      if (!crossed) releaseInjection(session.id, text);
    }
    this.publish(id);
  }
  private findMarker(session: Session, claim: ResidentIteration, run: ResidentRun): number | null {
    if (claim.transcript_offset === null) return null;
    try {
      const transcript = this.messages(session);
      if (!transcript) return null;
      const expected = `${residentWakeMarker(claim.run_id, claim.seq)}\n${run.settings.loop.prompt}`;
      let offset = claim.transcript_offset;
      for (;;) {
        const page = transcript.read.after(transcript.path, offset, 50);
        const turn = page.messages.find((m) => m.role === "user" && m.text === expected);
        if (turn) return turn.ts || claim.claimed_at;
        if (page.atEnd || page.end <= offset) return null;
        offset = page.end;
      }
    } catch { return null; }
  }
}
