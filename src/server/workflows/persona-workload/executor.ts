import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PersonaWorkloadEvent,
  PersonaWorkloadReconciliation,
  PersonaWorkloadRequest,
  PersonaWorkloadResult,
  RepositoryMaterializationRequest,
  RepositoryQueryAuditMetadata,
  RepositoryViewDescriptor,
} from "@shared/repository-access.ts";
import {
  PersonaWorkloadRequestSchema,
  repositoryMcpToolName,
  RepositoryQueryAuditMetadataSchema,
  RepositoryViewDescriptorSchema,
} from "@shared/repository-access.ts";
import { PersonaVerdictProviderWireSchema, PersonaVerdictSchema } from "@shared/protocol.ts";
import { llmRunInputBytes } from "@shared/llm.ts";
import { providerJsonSchema } from "../../llm/json-schema.ts";
import { REPOSITORY_MCP_CONFIG_ENV } from "../../../repository-mcp/config.ts";
import {
  PERSONA_WORKLOAD_ALLOWED_TOOLS,
  type PersonaProviderLaunch,
  type PersonaWorkloadProviderAdapter,
} from "./provider.ts";

export interface RepositoryViewLease {
  descriptor: RepositoryViewDescriptor;
  release(): Promise<void>;
}

export interface RepositoryArtifactMaterializer {
  materialize(request: RepositoryMaterializationRequest, signal: AbortSignal): Promise<RepositoryViewLease>;
}

export interface PersonaWorkloadExecutor {
  dispatch(request: PersonaWorkloadRequest, signal: AbortSignal): AsyncIterable<PersonaWorkloadEvent>;
  reconcile(workloadId: string, afterSequence: number): Promise<PersonaWorkloadReconciliation>;
  cancel(workloadId: string, generation: number): Promise<void>;
}

interface WorkloadState {
  workloadId: string;
  idempotencyKey: string;
  controller: AbortController;
  events: PersonaWorkloadEvent[];
  waiters: Set<() => void>;
  terminal: PersonaWorkloadResult | null;
  cancellationGeneration: number;
}

type EventPayload = PersonaWorkloadEvent extends infer Event
  ? Event extends PersonaWorkloadEvent
    ? Omit<Event, "workloadId" | "sequence" | "timestamp">
    : never
  : never;

export interface LocalPersonaWorkloadExecutorOptions {
  materializer: RepositoryArtifactMaterializer;
  providers: Record<"claude" | "codex", PersonaWorkloadProviderAdapter>;
  repositoryMcpEntrypoint: string;
  nodeCommand?: string;
  now?: () => number;
  maxRetainedTerminalWorkloads?: number;
}

function materializationRequest(request: PersonaWorkloadRequest): RepositoryMaterializationRequest {
  return {
    submissionId: request.submissionId,
    workloadId: request.workloadId,
    workflowAttemptId: request.workflowAttemptId,
    artifactLocator: request.artifactLocator,
    artifactDigest: request.artifactDigest,
  };
}

function workloadPrompt(request: PersonaWorkloadRequest): string {
  if (request.textEvidence.length === 0) return request.prompt;
  const blocks = request.textEvidence.map((evidence) =>
    `<submission-evidence id=${JSON.stringify(evidence.id)} kind=${JSON.stringify(evidence.kind)} sha256=${JSON.stringify(evidence.sha256)}>\n${evidence.text}\n</submission-evidence>`,
  );
  return `${request.prompt}\n\n${blocks.join("\n\n")}`;
}

type PersonaLlmCall = Extract<PersonaWorkloadResult, { kind: "succeeded" }>["llmCall"];

class PersonaWorkloadDeadlineError extends Error {
  constructor() {
    super("Persona workload deadline exceeded");
    this.name = "PersonaWorkloadDeadlineError";
  }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_RETAINED_TERMINAL_WORKLOADS = 32;

function failureResult(
  error: unknown,
  signal: AbortSignal,
  llmCall: PersonaLlmCall | null,
): PersonaWorkloadResult {
  const deadlineExceeded = signal.reason instanceof PersonaWorkloadDeadlineError;
  const failure = deadlineExceeded ? signal.reason : error;
  const message = failure instanceof Error ? failure.message : String(failure);
  return {
    kind: "failed",
    code: deadlineExceeded ? "deadline_exceeded" : signal.aborted ? "cancelled" : "provider_unavailable",
    message: message.slice(0, 4_000) || "Persona workload failed",
    retryable: true,
    llmCall,
  };
}

export class LocalPersonaWorkloadExecutor implements PersonaWorkloadExecutor {
  private readonly workloads = new Map<string, WorkloadState>();
  private readonly completedWorkloadIds: string[] = [];
  private readonly now: () => number;
  private readonly maxRetainedTerminalWorkloads: number;

  constructor(private readonly options: LocalPersonaWorkloadExecutorOptions) {
    this.now = options.now ?? Date.now;
    this.maxRetainedTerminalWorkloads = options.maxRetainedTerminalWorkloads ?? DEFAULT_RETAINED_TERMINAL_WORKLOADS;
    if (
      !Number.isSafeInteger(this.maxRetainedTerminalWorkloads)
      || this.maxRetainedTerminalWorkloads < 1
      || this.maxRetainedTerminalWorkloads > DEFAULT_RETAINED_TERMINAL_WORKLOADS
    ) {
      throw new Error(`terminal workload retention must be between 1 and ${DEFAULT_RETAINED_TERMINAL_WORKLOADS}`);
    }
    if (options.providers.claude.id !== "claude" || options.providers.codex.id !== "codex") {
      throw new Error("Persona workload provider registry is not exhaustive");
    }
  }

  dispatch(input: PersonaWorkloadRequest, signal: AbortSignal): AsyncIterable<PersonaWorkloadEvent> {
    const request = PersonaWorkloadRequestSchema.parse(input);
    const prior = this.workloads.get(request.workloadId);
    if (prior) {
      if (prior.idempotencyKey !== request.idempotencyKey) {
        throw new Error("workload id was reused with a different idempotency key");
      }
      return this.stream(prior, 0);
    }
    const state: WorkloadState = {
      workloadId: request.workloadId,
      idempotencyKey: request.idempotencyKey,
      controller: new AbortController(),
      events: [],
      waiters: new Set(),
      terminal: null,
      cancellationGeneration: request.cancellationGeneration,
    };
    const abort = () => state.controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.workloads.set(request.workloadId, state);
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const enforceDeadline = () => {
      if (state.controller.signal.aborted) return;
      const remaining = request.deadline - this.now();
      if (remaining <= 0) {
        state.controller.abort(new PersonaWorkloadDeadlineError());
        return;
      }
      deadlineTimer = setTimeout(enforceDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    enforceDeadline();
    void this.run(state, request)
      .finally(() => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        signal.removeEventListener("abort", abort);
      })
      .catch(() => {});
    return this.stream(state, 0);
  }

  async reconcile(workloadId: string, afterSequence: number): Promise<PersonaWorkloadReconciliation> {
    const state = this.workloads.get(workloadId);
    if (!state) {
      return { workloadId, state: "unknown", lastSequence: 0, cancellationGeneration: 0, terminalResult: null, events: [] };
    }
    return {
      workloadId,
      state: state.terminal
        ? state.terminal.kind === "failed" && state.terminal.code === "cancelled" ? "cancelled" : "completed"
        : "running",
      lastSequence: state.events.length,
      cancellationGeneration: state.cancellationGeneration,
      terminalResult: state.terminal,
      events: state.events.filter((event) => event.sequence > afterSequence),
    };
  }

  async cancel(workloadId: string, generation: number): Promise<void> {
    const state = this.workloads.get(workloadId);
    if (!state || generation <= state.cancellationGeneration) return;
    state.cancellationGeneration = generation;
    this.emit(state, { kind: "cancel_requested", generation });
    state.controller.abort(new Error(`Persona workload cancelled at generation ${generation}`));
  }

  private async run(state: WorkloadState, request: PersonaWorkloadRequest): Promise<void> {
    this.emit(state, { kind: "accepted", cancellationGeneration: state.cancellationGeneration });
    let lease: RepositoryViewLease | null = null;
    let workDir: string | null = null;
    let auditPath: string | null = null;
    let llmCall: PersonaLlmCall | null = null;
    const emittedAuditIds = new Set<string>();
    try {
      if (request.deadline <= this.now()) {
        state.controller.abort(new PersonaWorkloadDeadlineError());
        throw state.controller.signal.reason;
      }
      lease = await this.options.materializer.materialize(
        materializationRequest(request),
        state.controller.signal,
      );
      const descriptor = RepositoryViewDescriptorSchema.parse(lease.descriptor);
      if (
        descriptor.artifactLocator !== request.artifactLocator
        || descriptor.snapshotDigest !== request.artifactDigest
      ) {
        throw new Error("materialized repository identity does not match the active workload");
      }
      this.emit(state, { kind: "materialized", snapshotDigest: descriptor.snapshotDigest });
      workDir = await mkdtemp(join(tmpdir(), "mission-persona-workload-"));
      const providerCwd = join(workDir, "provider");
      await mkdir(providerCwd, { mode: 0o700 });
      auditPath = join(workDir, "repository-audit.jsonl");
      const configPath = join(workDir, "repository-mcp.json");
      await writeFile(auditPath, "", { mode: 0o600, flag: "wx" });
      await writeFile(configPath, JSON.stringify({
        schemaVersion: 1,
        descriptor,
        workloadId: request.workloadId,
        workflowAttemptId: request.workflowAttemptId,
        budgets: request.budgets,
        cursorSecret: randomBytes(32).toString("base64url"),
        auditPath,
      }), { mode: 0o600, flag: "wx" });
      const prompt = workloadPrompt(request);
      const launch: PersonaProviderLaunch = {
        provider: request.provider,
        model: request.model,
        workingDirectory: providerCwd,
        prompt,
        images: request.images,
        outputSchema: providerJsonSchema(PersonaVerdictProviderWireSchema),
        deadline: request.deadline,
        budgets: request.budgets,
        repositoryMcp: {
          serverName: "repository",
          command: this.options.nodeCommand ?? process.execPath,
          args: [this.options.repositoryMcpEntrypoint],
          env: {
            [REPOSITORY_MCP_CONFIG_ENV]: configPath,
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          },
        },
        allowedTools: PERSONA_WORKLOAD_ALLOWED_TOOLS,
        hostedSearchMaximum: request.hostedSearchMaximum,
      };
      this.emit(state, { kind: "provider_started", provider: request.provider, model: request.model });
      const providerResult = await this.options.providers[request.provider].run(
        launch,
        state.controller.signal,
      );
      llmCall = {
        callId: request.llmCall.callId,
        inputBytes: llmRunInputBytes(prompt, request.images),
        outputBytes: Buffer.byteLength(providerResult.rawVerdict),
        providerUsage: providerResult.usage,
      };
      if (state.controller.signal.aborted) {
        throw state.controller.signal.reason instanceof Error
          ? state.controller.signal.reason
          : new Error("Persona workload cancelled");
      }
      const audits = await this.readAudits(auditPath);
      if (providerResult.repositoryToolCalls.length < 2) {
        throw new Error("provider did not complete multiple repository MCP calls in one session");
      }
      if (
        providerResult.repositoryToolCalls.length !== audits.length
        || audits.some((audit, index) => repositoryMcpToolName(audit.operation) !== providerResult.repositoryToolCalls[index])
      ) {
        throw new Error("provider MCP call trace does not match the repository audit journal");
      }
      if (new Set(audits.map((audit) => audit.operationInstanceId)).size !== audits.length) {
        throw new Error("repository audit journal reused an operation-instance id");
      }
      this.emitNewAudits(state, audits, emittedAuditIds);
      const providerVerdict = PersonaVerdictProviderWireSchema.parse(
        JSON.parse(providerResult.rawVerdict),
      );
      const verdict = PersonaVerdictSchema.parse(providerVerdict);
      if (state.controller.signal.aborted) {
        throw state.controller.signal.reason instanceof Error
          ? state.controller.signal.reason
          : new Error("Persona workload cancelled");
      }
      const result: PersonaWorkloadResult = {
        kind: "succeeded",
        verdict,
        llmCall,
      };
      this.complete(state, result);
    } catch (error) {
      if (auditPath) {
        try {
          this.emitNewAudits(state, await this.readAudits(auditPath), emittedAuditIds);
        } catch {
          // A malformed or unavailable journal cannot replace the initiating failure. The
          // workload still fails closed and no unvalidated audit event is emitted.
        }
      }
      const result = failureResult(error, state.controller.signal, llmCall);
      this.complete(state, result);
    } finally {
      await lease?.release().catch(() => {});
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async readAudits(path: string): Promise<RepositoryQueryAuditMetadata[]> {
    const text = await readFile(path, "utf8");
    if (!text) return [];
    return text.trimEnd().split("\n").map((line) => RepositoryQueryAuditMetadataSchema.parse(JSON.parse(line)));
  }

  private emitNewAudits(
    state: WorkloadState,
    audits: readonly RepositoryQueryAuditMetadata[],
    emitted: Set<string>,
  ): void {
    for (const audit of audits) {
      if (emitted.has(audit.operationInstanceId)) continue;
      emitted.add(audit.operationInstanceId);
      this.emit(state, { kind: "repository_query", audit });
    }
  }

  private complete(state: WorkloadState, result: PersonaWorkloadResult): void {
    state.terminal = result;
    this.emit(state, { kind: "completed", result });
    this.completedWorkloadIds.push(state.workloadId);
    while (this.completedWorkloadIds.length > this.maxRetainedTerminalWorkloads) {
      const workloadId = this.completedWorkloadIds.shift()!;
      const retained = this.workloads.get(workloadId);
      if (retained?.terminal) this.workloads.delete(workloadId);
    }
  }

  private emit(
    state: WorkloadState,
    payload: EventPayload,
  ): void {
    const event = {
      ...payload,
      workloadId: state.workloadId,
      sequence: state.events.length + 1,
      timestamp: this.now(),
    } as PersonaWorkloadEvent;
    state.events.push(event);
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
  }

  private stream(state: WorkloadState, afterSequence: number): AsyncIterable<PersonaWorkloadEvent> {
    return {
      async *[Symbol.asyncIterator]() {
        let index = afterSequence;
        for (;;) {
          while (index < state.events.length) yield state.events[index++]!;
          if (state.terminal) return;
          await new Promise<void>((resolve) => state.waiters.add(resolve));
        }
      },
    };
  }
}
