import { featureEnabled } from "../feature-flags/index.ts";
import { PERSONA_REPOSITORY_ACCESS_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { locateExecutable } from "../executables/locator.ts";
import { repositoryMcpServerPath } from "../config.ts";
import { ProviderFailure } from "../llm/provider-failure.ts";
import { canonicalJson } from "@shared/shaping.ts";
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
  & { persona: import("@shared/workflow.ts").PersonaSnapshot };

export class RepositoryReview {
  private readonly cleanupExecutors = new Map<string, PersonaWorkloadExecutor>();
  private readonly recoveringLocal = new Map<string, Promise<void>>();
  private readonly local: LocalRepositoryWorkloadOwnership;
  constructor(private readonly store: WorkflowStore, private readonly injected?: PersonaWorkloadExecutor) {
    this.local = new LocalRepositoryWorkloadOwnership(store, id => Boolean(this.current(id)));
  }

  pendingCancellations(runId: string, nodeId: string) {
    return this.store.pendingRepositoryCancellations(runId, nodeId);
  }

  async confirmCancellations(runId: string, nodeId: string): Promise<void> {
    for (const { id, generation } of this.pendingCancellations(runId, nodeId)) {
      if (this.store.repositoryLocalOwner(id)) {
        await this.recoverLocal(id);
        continue;
      }
      const executor = this.cleanupExecutors.get(id) ?? this.injected;
      if (!executor) throw new Error(`Repository workload ${id} has not confirmed cleanup`);
      const timeout = AbortSignal.timeout(cleanupTimeoutMs);
      let status = await untilAbort(executor.reconcile(id, 0), timeout);
      if (status?.workloadId === id && status.state === "running") {
        await untilAbort(executor.cancel(id, generation), timeout);
        status = await untilAbort(executor.reconcile(id, 0), timeout);
      }
      if (status?.workloadId !== id || status.state !== "terminal")
        throw new Error(`Repository workload ${id} has not confirmed cleanup`);
      this.store.confirmRepositoryCancellation(id, generation);
      this.cleanupExecutors.delete(id);
    }
  }

  private recoverLocal(id: string): Promise<void> {
    const active = this.recoveringLocal.get(id);
    if (active) return active;
    const recovery = this.local.confirmClosed(id, WorkflowRepositoryArtifactService.forRoot(this.store)).then(() => {
      this.store.confirmLocalRepositoryCleanup(id);
      this.cleanupExecutors.delete(id);
    }).finally(() => this.recoveringLocal.delete(id));
    this.recoveringLocal.set(id, recovery);
    return recovery;
  }

  private current(id: string) {
    // The materializer calls this before opening the checkout and before returning its lease.
    if (!featureEnabled(PERSONA_REPOSITORY_ACCESS_FLAG_ID)) return undefined;
    return this.store.currentRepositoryWorkload(id);
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
    const service = WorkflowRepositoryArtifactService.forRoot(this.store);
    const snapshot = service.activeSnapshot(input.submissionId);
    if (!snapshot) throw new Error("The submitted repository artifact is unavailable");
    const id = input.accounting.callId;
    const request = PersonaWorkloadRequestSchema.parse({
      ...input, version: 1, workloadId: id, idempotencyKey: id,
      requiredCapability: REPOSITORY_EVIDENCE_CAPABILITY, cancellationGeneration: 0,
      artifact: { locator: snapshot.locator, digest: snapshot.digest },
      policy: { version: 1, operations: REPOSITORY_OPERATION_IDS }, budgets: REPOSITORY_DEFAULT_BUDGETS,
    });
    service.setActiveRequestLookup(key => this.current(key) ?? null);
    const executor = this.injected ?? await this.localExecutor(service);
    if (executor.repositoryEvidenceCapability !== request.requiredCapability) throw new Error("Repository executor capability mismatch");
    // Executable lookup can yield after the engine's check. Recheck before granting workload ownership.
    if (!featureEnabled(PERSONA_REPOSITORY_ACCESS_FLAG_ID)) throw new Error("Persona repository access preview is off");
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
    let sequence = 0;
    let stage: "new" | "accepted" | "repository_verified" | "persona_started" | "cancelled" = "new";
    try {
      signal.throwIfAborted();
      events = executor.dispatch(request, signal)[Symbol.asyncIterator]();
      while (true) {
        const next = await untilAbort(events.next(), signal);
        if (next.done) {
          streamFinished = true;
          break;
        }
        const event = PersonaWorkloadEventSchema.parse(next.value);
        if (event.workloadId !== id || event.attemptId !== input.attemptId) throw new Error("Repository event identity mismatch");
        const hash = createHash("sha256").update(canonicalJson(event)).digest("hex");
        if (event.sequence <= sequence) {
          const prior = this.store.repositoryEventHash(id, event.sequence);
          if (prior === hash) continue;
          throw new Error("Conflicting repository event");
        }
        if (terminal || event.sequence !== ++sequence) throw new Error("Repository event sequence mismatch");
        switch (event.type) {
          case "accepted":
            if (stage !== "new") throw new Error("Unexpected repository acceptance");
            stage = event.type;
            break;
          case "repository_verified":
            if (stage !== "accepted") throw new Error("Unexpected repository verification");
            stage = event.type;
            break;
          case "persona_started":
            if (stage !== "repository_verified") throw new Error("Repository reviewer started before verification");
            stage = event.type;
            break;
          case "repository_query":
            if (stage !== "persona_started") throw new Error("Repository query outside provider execution");
            break;
          case "cancelled":
            stage = event.type;
            break;
          case "terminal":
            if (event.result.status === "completed" && stage !== "persona_started") throw new Error("No verified repository execution");
            break;
        }
        signal.throwIfAborted();
        this.store.recordRepositoryEvent(request, event, hash, () => Boolean(this.current(id)));
        if (event.type === "repository_query" && ["unavailable","audit_unavailable","budget_exhausted","timeout","cancelled"].includes(event.audit.code ?? ""))
          throw new Error(`Repository query failed: ${event.audit.code}`);
        if (event.type === "terminal") terminal = event;
      }
      signal.throwIfAborted();
      if (!terminal || !this.current(id)) throw new Error("No current terminal repository verdict");
      if (terminal.result.status === "failed") {
        errorCode = terminal.result.code;
        if (terminal.result.providerFailure) throw new ProviderFailure(errorCode, null, terminal.result.providerFailure);
        throw new Error(`Repository workload failed: ${errorCode}`);
      }
      const verdict = terminal.result.result.verdict;
      const refs = verdict.verdict === "pass" ? verdict.approvalDetails.evidence : verdict.requestedChanges.flatMap(c => c.evidence);
      this.store.verifyRepositoryCitations(id, refs);
      verdictJson = JSON.stringify(verdict);
    } finally {
      clearInterval(timer);
      // Iterator teardown may itself wait for the provider. Request cancellation before closing it.
      if (!streamFinished || !terminal) cancel.abort();
      signal.removeEventListener("abort", stop);
      await this.closeDispatch(id, executor, streamFinished ? undefined : events, stopping);
      if (!this.injected) await this.finishLocal(id, service);
      const accepted = this.store.finishRepositoryWorkload(id, generation, errorCode, !this.injected, () =>
        verdictJson !== undefined && !signal.aborted && Date.now() < input.deadline && Boolean(this.current(id)));
      if (!accepted) verdictJson = undefined;
    }
    if (verdictJson === undefined) throw new Error("Repository workload ownership expired before verdict acceptance");
    return verdictJson;
  }

  private async closeDispatch(id: string, executor: PersonaWorkloadExecutor, events: AsyncIterator<PersonaWorkloadEvent> | undefined, stopping: Promise<void> | undefined) {
    const close = async () => {
      if (events?.return) await untilAbort(events.return(), AbortSignal.timeout(cleanupTimeoutMs));
    };
    const cleanup = await Promise.allSettled([stopping, close()]);
    for (const result of cleanup) {
      if (result.status === "rejected") {
        this.cleanupExecutors.set(id, executor);
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
