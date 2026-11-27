import { codexTokenSplit } from "../harness/codex/usage.ts";
import { reportLlmSpend, spendReportIsRecordable } from "../llm/spend.ts";
import type { LlmSpendReport } from "@shared/llm-spend.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { LOCAL_INSPECTOR_FLAG_ID, PERSONA_REPOSITORY_ACCESS_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { locateExecutable } from "../executables/locator.ts";
import { repositoryMcpServerPath } from "../config.ts";
import { ProviderFailure } from "../llm/provider-failure.ts";
import { canonicalJson } from "@shared/shaping.ts";
import { checkBlockedReason } from "@shared/workflow.ts";
import {
  PersonaWorkloadEventSchema, PersonaWorkloadRequestSchema, REPOSITORY_DEFAULT_BUDGETS,
  REPOSITORY_EVIDENCE_CAPABILITY, REPOSITORY_OPERATION_IDS,
  type PersonaWorkloadEvent, type PersonaWorkloadRequest,
} from "@shared/repository-access.ts";
import type { WorkflowStore } from "./store.ts";
import { WorkflowRepositoryArtifactService } from "./repository-artifact/service.ts";
import { LocalPersonaWorkloadExecutor } from "./persona-workload/executor.ts";
import type { PersonaWorkloadExecutor } from "./persona-workload/contracts.ts";
import { LocalRepositoryWorkloadOwnership } from "./persona-workload/local-ownership.ts";
import { workflowLog } from "./log.ts";
import { getWorkflowPolicy } from "./config.ts";

// A transport may ignore abort while reading or closing its iterator. Its deadline
// releases the scheduler slot; the durable cancellation row still gates any retry.
const cleanupTimeoutMs = 5_000;

function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function binary(id: "node" | "git" | "claude" | "codex") {
  const resolved = await locateExecutable(id);
  if (!resolved) throw new Error(`Repository reviewer requires ${id}`);
  return resolved.path;
}

type ReviewInput = Pick<PersonaWorkloadRequest, "attemptId" | "submissionId" | "accounting" | "prompt" | "images" | "deadline" | "execution">
  & { persona?: import("@shared/workflow.ts").PersonaSnapshot; offDiffFindings?: ReadonlyMap<string, string> };

export class RepositoryReview {
  private readonly dispatching = new Set<string>();
  private readonly recoveringLocal = new Map<string, Promise<void>>();
  private readonly local: LocalRepositoryWorkloadOwnership;
  constructor(private readonly store: WorkflowStore, private readonly injected?: PersonaWorkloadExecutor,
    private readonly workflowPolicy = getWorkflowPolicy) {
    this.local = new LocalRepositoryWorkloadOwnership(store, id => Boolean(this.current(id)));
  }

  pendingCancellations(runId: string, nodeId: string) {
    return this.store.pendingRepositoryCancellations(runId, nodeId);
  }

  async confirmCancellations(runId: string, nodeId: string): Promise<void> {
    for (const { id, generation } of this.pendingCancellations(runId, nodeId)) {
      await this.confirmCancellation(id, generation);
    }
  }

  reconcileTerminalRuns(): Promise<void> | undefined {
    // The dispatch that requested cancellation gets the first chance to release its
    // resources. Once it returns, maintenance owns any remaining durable cleanup.
    const pending = this.store.terminalRunRepositoryCancellations().filter(row => !this.dispatching.has(row.id));
    if (pending.length) return this.reconcileCancellations(pending);
  }

  private async reconcileCancellations(pending: { id: string; generation: number }[]) {
    for (const { id, generation } of pending) {
      try {
        await this.confirmCancellation(id, generation);
      } catch {
        workflowLog("warn", { event: "repository_workload_cleanup_pending", call: id });
      }
    }
  }

  private requireTerminal(id: string, status: Awaited<ReturnType<PersonaWorkloadExecutor["reconcile"]>>) {
    if (status.workloadId !== id || status.state !== "terminal")
      throw new Error(`Repository workload ${id} has not confirmed cleanup`);
  }

  private async confirmCancellation(id: string, generation: number) {
    if (this.store.repositoryLocalOwner(id)) {
      await this.recoverLocal(id);
      return;
    }
    const executor = this.injected;
    if (!executor) throw new Error(`Repository workload ${id} has not confirmed cleanup`);
    const timeout = AbortSignal.timeout(cleanupTimeoutMs);
    let status = await untilAbort(executor.reconcile(id, 0), timeout);
    if (status.workloadId === id && status.state === "running") {
      await untilAbort(executor.cancel(id, generation), timeout);
      status = await untilAbort(executor.reconcile(id, 0), timeout);
    }
    this.requireTerminal(id, status);
    this.store.confirmRepositoryCancellation(id, generation);
  }

  private recoverLocal(id: string): Promise<void> {
    const active = this.recoveringLocal.get(id);
    if (active) return active;
    const recovery = this.local.confirmClosed(id, WorkflowRepositoryArtifactService.forRoot(this.store)).then(() => {
      this.store.confirmLocalRepositoryCleanup(id);
    }).finally(() => this.recoveringLocal.delete(id));
    this.recoveringLocal.set(id, recovery);
    return recovery;
  }

  private current(id: string) {
    // The materializer calls this before opening the checkout and before returning its lease.
    const owner = this.store.currentRepositoryWorkload(id);
    if (!owner || !featureEnabled(repositoryReviewFlag(owner.purpose))) return undefined;
    if (owner.purpose === "inspector_review" && this.inspectorCommandsDenial(owner.runId)) return undefined;
    return owner;
  }

  private inspectorCommandsDenial(runId: string) {
    const run = this.store.getRun(runId);
    const binding = run && this.store.getBinding(run.bindingId);
    return binding ? checkBlockedReason(this.workflowPolicy(), binding.sessionCwd, binding.sessionRepoRoot)
      : "The Local Inspector workflow no longer has a repository binding.";
  }

  interrupt() {
    const local = this.store.interruptRepositoryWorkloads();
    for (const row of local) void this.recoverLocal(String(row.id)).catch(() => {
      workflowLog("warn", { event: "repository_workload_cleanup_pending", call: String(row.id) });
    });
  }

  private async localExecutor(service: WorkflowRepositoryArtifactService) {
    const [node, git] = await Promise.all([binary("node"), binary("git")]);
    const worker = join(dirname(repositoryMcpServerPath()), "provider.mjs");
    const runProvider: import("./persona-workload/providers.ts").RepositoryProvider = launch => this.local.runProvider(launch, node, worker);
    return new LocalPersonaWorkloadExecutor({
      materializer: service, repositoryMcpBundle: repositoryMcpServerPath(),
      nodeBinary: node, gitBinary: git, providerBinary: binary,
      providers: { claude: runProvider, codex: runProvider },
      ownWorkspace: (id, path) => this.local.recordHome(id, path),
      providerEnvironment: async provider => {
        const env: Record<string, string> = {};
        const keys = provider === "codex" ? ["OPENAI_API_KEY"] : ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
        for (const key of keys) if (process.env[key]) env[key] = process.env[key]!;
        return env;
      },
    });
  }

  async run(input: ReviewInput, shutdown: AbortSignal): Promise<string> {
    const id = input.accounting.callId;
    if (this.dispatching.has(id)) throw new Error("Repository workload is already dispatching");
    this.dispatching.add(id);
    try { return await this.dispatch(input, shutdown); }
    finally { this.dispatching.delete(id); }
  }

  private async dispatch(input: ReviewInput, shutdown: AbortSignal): Promise<string> {
    const { offDiffFindings, ...workload } = input;
    const service = WorkflowRepositoryArtifactService.forRoot(this.store);
    const snapshot = service.activeSnapshot(input.submissionId);
    if (!snapshot) throw new Error("The submitted repository artifact is unavailable");
    const id = input.accounting.callId;
    const request = PersonaWorkloadRequestSchema.parse({
      ...workload, version: 1, workloadId: id, idempotencyKey: id,
      requiredCapability: REPOSITORY_EVIDENCE_CAPABILITY, cancellationGeneration: 0,
      artifact: { locator: snapshot.locator, digest: snapshot.digest },
      policy: { version: 1, operations: REPOSITORY_OPERATION_IDS }, budgets: REPOSITORY_DEFAULT_BUDGETS,
    });
    service.setActiveRequestLookup(key => this.current(key) ?? null);
    const executor = this.injected ?? await this.localExecutor(service);
    if (executor.repositoryEvidenceCapability !== request.requiredCapability) throw new Error("Repository executor capability mismatch");
    // Scheduling and executable lookup can yield after the engine's check. Recheck before
    // dispatch, and keep enforcing the grant through materialization and the provider gate.
    if (!featureEnabled(repositoryReviewFlag(request.accounting.purpose))) throw new Error("Repository review preview is off");
    if (request.accounting.purpose === "inspector_review") {
      const denied = this.inspectorCommandsDenial(request.accounting.runId);
      if (denied) throw new Error(`Local Inspector requires permission to read the submitted worktree. ${denied}`);
    }
    this.store.startRepositoryWorkload(request, !this.injected);
    const cancel = new AbortController();
    const signal = AbortSignal.any([shutdown, cancel.signal, AbortSignal.timeout(Math.max(1, input.deadline - Date.now()))]);
    const timer = setInterval(() => {
      try {
        if (!this.current(id)) cancel.abort();
      } catch {
        cancel.abort();
      }
    }, 250);
    const generation = request.cancellationGeneration + 1;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = (async () => {
        this.store.markRepositoryCancellationPending(id, generation);
        try {
          await untilAbort(executor.cancel(id, generation), AbortSignal.timeout(cleanupTimeoutMs));
        } catch (error) {
          throw new Error(`Repository executor failed to confirm cancellation of ${id}: ${String(error)}`, { cause: error });
        }
      })();
      // Observe rejection while the iterator is unwinding. closeDispatch handles the original result.
      void stopping.catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    let errorCode = "workload_interrupted";
    let verdictJson: string | undefined;
    let terminal: Extract<PersonaWorkloadEvent, { type: "terminal" }> | undefined;
    let events: AsyncIterator<PersonaWorkloadEvent> | undefined;
    let streamFinished = false;
    const cursor = new WorkloadCursor(this.store, request);
    // The cursor as of the last recorded event, where a replayed return witness must resume,
    // and whether a provider return is among the recorded events.
    let recorded = cursor.fork();
    let returnRecorded = false;
    let queriedRepository = false;
    const inspectedPaths = new Set<string>();
    try {
      signal.throwIfAborted();
      events = executor.dispatch(request, signal, {
        // Synchronous and durable: an in-process executor's return survives this process.
        // The store refuses an event naming another workload or attempt.
        returned: (event, history) => {
          const parsed = this.orderedSinkReturn(request, event, history);
          this.store.recordRepositoryReturn(request, parsed, eventHash(parsed));
        },
      })[Symbol.asyncIterator]();
      while (true) {
        const next = await untilAbort(events.next(), signal);
        if (next.done) {
          streamFinished = true;
          break;
        }
        const event = PersonaWorkloadEventSchema.parse(next.value);
        if (cursor.accept(event) === "duplicate") continue;
        signal.throwIfAborted();
        this.store.recordRepositoryEvent(request, event, eventHash(event), () => Boolean(this.current(id)));
        recorded = cursor.fork();
        if (event.type === "persona_returned") returnRecorded = true;
        if (event.type === "repository_query" && ["unavailable","audit_unavailable","budget_exhausted","timeout","cancelled"].includes(event.audit.code ?? ""))
          throw new Error(`Repository query failed: ${event.audit.code}`);
        if (event.type === "repository_query" && event.audit.status === "ok" && event.audit.items > 0) {
          queriedRepository = true;
          if (offDiffFindings?.size && event.audit.operation === "read" && event.audit.readLayer === "worktree") {
            for (const handle of event.audit.handles) inspectedPaths.add(handle.path);
            if (event.audit.absentWorktreePath) inspectedPaths.add(event.audit.absentWorktreePath);
          }
        }
        if (event.type === "terminal") terminal = event;
      }
      signal.throwIfAborted();
      if (!terminal || !this.current(id)) throw new Error("No current terminal repository verdict");
      if (request.accounting.purpose === "inspector_review") reportInspectorSpend(request.execution, terminal.result);
      if (terminal.result.status === "failed") {
        errorCode = terminal.result.code;
        if (terminal.result.providerFailure) throw new ProviderFailure(errorCode, null, terminal.result.providerFailure);
        throw new Error(`Repository workload failed: ${errorCode}`);
      }
      const result = terminal.result.result;
      if (request.accounting.purpose === "inspector_review") {
        if (result.kind !== "inspector_verdict" || !queriedRepository) {
          errorCode = "invalid_verdict";
          throw new Error("Local Inspector did not complete a verified repository query");
        }
        verdictJson = JSON.stringify({ ...result.verdict, resolved: result.verdict.resolved.filter(fingerprint => {
          const path = offDiffFindings?.get(fingerprint);
          return path === undefined || inspectedPaths.has(path);
        }) });
      } else {
        if (result.kind !== "persona_verdict") throw new Error("Unexpected repository verdict kind");
        const verdict = result.verdict;
        const refs = verdict.verdict === "pass" ? verdict.approvalDetails.evidence : verdict.requestedChanges.flatMap(c => c.evidence);
        this.store.verifyRepositoryCitations(id, refs);
        verdictJson = JSON.stringify(verdict);
      }
    } finally {
      clearInterval(timer);
      // Iterator teardown may itself wait for the provider. Request cancellation before closing it.
      if (!streamFinished || !terminal) cancel.abort();
      signal.removeEventListener("abort", stop);
      try {
        await this.closeDispatch(streamFinished ? undefined : events, stopping);
      } finally {
        // An abort, a rejected event, an expired grant or a stream that closed before its terminal
        // result can leave a provider return unrecorded. Its execution was still spent, so replay
        // is asked whenever neither a return nor a terminal result was recorded.
        if (!returnRecorded && !terminal) await this.keepReturnWitness(executor, request, recorded);
      }
      if (!this.injected) await this.finishLocal(id, service);
      else if (stopping) {
        const status = await untilAbort(executor.reconcile(id, 0), AbortSignal.timeout(cleanupTimeoutMs));
        this.requireTerminal(id, status);
      }
      const accepted = this.store.finishRepositoryWorkload(id, generation, errorCode, !this.injected, () =>
        verdictJson !== undefined && !signal.aborted && Date.now() < input.deadline && Boolean(this.current(id)));
      if (!accepted) verdictJson = undefined;
    }
    if (verdictJson === undefined) throw new Error("Repository workload ownership expired before verdict acceptance");
    return verdictJson;
  }

  /**
   * Record a provider return the supervisor did not record in order: it stopped reading, or the
   * stream closed before delivering the return.
   * Best effort against the executor's replay, which a closed local stream already holds in full.
   * The replay resumes the live stream's own cursor at the last recorded event, so it is held to
   * the same identity, sequence, hash and stage rule, and it ends at a terminal result: a return
   * the supervisor would have refused (reported before the provider started, or after the
   * terminal result) is never charged. The witness only ever spends an execution; it never
   * accepts a verdict or evidence.
   */
  private async keepReturnWitness(executor: PersonaWorkloadExecutor, request: PersonaWorkloadRequest, from: WorkloadCursor) {
    try {
      const replay = await untilAbort(executor.reconcile(request.workloadId, from.sequence), AbortSignal.timeout(cleanupTimeoutMs));
      if (replay.workloadId !== request.workloadId) return;
      const cursor = from.fork();
      for (const raw of replay.events) {
        const event = PersonaWorkloadEventSchema.parse(raw);
        if (cursor.accept(event) === "duplicate") continue;
        if (cursor.terminal) return;
        if (event.type === "persona_returned") {
          this.store.recordRepositoryReturn(request, event, eventHash(event));
          return;
        }
      }
    } catch {
      workflowLog("warn", { event: "repository_return_witness_unavailable", call: request.workloadId });
    }
  }

  /**
   * Hold a sink return to the live stream's rule before it can charge anything. The sink runs
   * in the executor's tick, ahead of the stream, so the live cursor cannot vouch for it: a fresh
   * cursor walks the executor's history from the first event, then must accept the return.
   */
  private orderedSinkReturn(request: PersonaWorkloadRequest, event: unknown, history: readonly unknown[] | undefined) {
    const parsed = PersonaWorkloadEventSchema.parse(event);
    if (parsed.type !== "persona_returned") throw new Error("Repository return sink received another event");
    if (!Array.isArray(history)) throw new Error("Repository return sink received no event history");
    const cursor = new WorkloadCursor(this.store, request);
    for (const raw of history) {
      if (cursor.accept(PersonaWorkloadEventSchema.parse(raw)) !== "next") throw new Error("Repository event sequence mismatch");
    }
    cursor.accept(parsed);
    return parsed;
  }

  private async closeDispatch(events: AsyncIterator<PersonaWorkloadEvent> | undefined, stopping: Promise<void> | undefined) {
    const close = async () => {
      if (events?.return) await untilAbort(events.return(), AbortSignal.timeout(cleanupTimeoutMs));
    };
    const cleanup = await Promise.allSettled([stopping, close()]);
    for (const result of cleanup) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  }

  private async finishLocal(id: string, service: WorkflowRepositoryArtifactService) {
    try {
      await this.local.confirmClosed(id, service);
    } catch (error) {
      this.store.markRepositoryCancellationPending(id, 1);
      throw error;
    }
  }
}

function eventHash(event: PersonaWorkloadEvent) {
  return createHash("sha256").update(canonicalJson(event)).digest("hex");
}

type WorkloadStage = "new" | "accepted" | "repository_verified" | "persona_started" | "persona_returned" | "cancelled";

/**
 * The one rule for where a workload event may sit, shared by the live stream, the return sink
 * and replay recovery: this request's workload and attempt, agreement with any event already
 * recorded at that sequence, a contiguous sequence, nothing after a terminal result, and the
 * stage order of `advanceWorkloadStage`. An already recorded event is a duplicate, not a step.
 */
class WorkloadCursor {
  constructor(
    private readonly store: WorkflowStore,
    private readonly request: Pick<PersonaWorkloadRequest, "workloadId" | "attemptId">,
    public sequence = 0,
    private stage: WorkloadStage = "new",
    public terminal = false,
  ) {}

  fork() {
    return new WorkloadCursor(this.store, this.request, this.sequence, this.stage, this.terminal);
  }

  accept(event: PersonaWorkloadEvent): "next" | "duplicate" {
    if (event.workloadId !== this.request.workloadId || event.attemptId !== this.request.attemptId)
      throw new Error("Repository event identity mismatch");
    const recorded = this.store.repositoryEventHash(this.request.workloadId, event.sequence);
    if (recorded !== undefined && recorded !== eventHash(event)) throw new Error("Conflicting repository event");
    if (event.sequence <= this.sequence) {
      if (recorded === undefined) throw new Error("Conflicting repository event");
      return "duplicate";
    }
    if (this.terminal || event.sequence !== this.sequence + 1) throw new Error("Repository event sequence mismatch");
    this.stage = advanceWorkloadStage(this.stage, event);
    this.sequence = event.sequence;
    if (event.type === "terminal") this.terminal = true;
    return "next";
  }
}

/** The one ordering rule for workload events, applied to the live stream and to replay alike. */
function advanceWorkloadStage(stage: WorkloadStage, event: PersonaWorkloadEvent): WorkloadStage {
  switch (event.type) {
    case "accepted":
      if (stage !== "new") throw new Error("Unexpected repository acceptance");
      return event.type;
    case "repository_verified":
      if (stage !== "accepted") throw new Error("Unexpected repository verification");
      return event.type;
    case "persona_started":
      if (stage !== "repository_verified") throw new Error("Repository reviewer started before verification");
      return event.type;
    case "persona_returned":
      if (stage !== "persona_started") throw new Error("Repository reviewer returned before it started");
      return event.type;
    case "repository_query":
      // The audit journal drains its last records after the provider returns.
      if (stage !== "persona_started" && stage !== "persona_returned") throw new Error("Repository query outside provider execution");
      return stage;
    case "cancelled":
      return event.type;
    case "terminal":
      // A completed verdict without a recorded return could never be charged.
      if (event.result.status === "completed" && stage !== "persona_returned") throw new Error("No verified repository execution");
      return stage;
  }
}

function repositoryReviewFlag(purpose: string) {
  return purpose === "inspector_review" ? LOCAL_INSPECTOR_FLAG_ID : PERSONA_REPOSITORY_ACCESS_FLAG_ID;
}

function reportInspectorSpend(
  execution: PersonaWorkloadRequest["execution"],
  result: Extract<PersonaWorkloadEvent, { type: "terminal" }>["result"],
) {
  const { usage, providerRunId } = result;
  if (!usage || !providerRunId) return;
  const tokens = execution.provider === "codex" ? codexTokenSplit(usage) : {
    input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, reasoningOutput: 0,
    cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
  if (!tokens) return;
  const report: LlmSpendReport = {
    role: "inspector:review", runner: execution.provider, runId: providerRunId, ts: Date.now(),
    models: [{
      modelId: execution.model,
      ...tokens,
      reportedCostUsd: usage.total_cost_usd ?? null,
    }],
  };
  if (spendReportIsRecordable(report)) reportLlmSpend(report);
}
