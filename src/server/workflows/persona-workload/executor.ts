import { ProviderFailure } from "../../llm/provider-failure.ts";
import { FIXED_OS_EXECUTABLES } from "../../executables/catalog.ts";
import { openRepositoryAuditJournal } from "./audit-journal.ts";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  REPOSITORY_EVIDENCE_CAPABILITY,
  PersonaWorkloadRequestSchema,
  PersonaWorkloadResultSchema,
  PersonaWorkloadVerdictSchema,
  RepositoryViewDescriptorSchema,
  type PersonaWorkloadEvent,
  type PersonaWorkloadRequest,
  type PersonaWorkloadResult,
  type PersonaWorkloadReconciliation,
} from "@shared/repository-access.ts";
import type {
  PersonaWorkloadExecutor,
  RepositoryArtifactMaterializer,
  RepositoryViewLease,
} from "./contracts.ts";
import { REPOSITORY_PROVIDERS, RepositoryCapabilityError, type RepositoryProvider } from "./providers.ts";

interface Job {
  request: PersonaWorkloadRequest;
  controller: AbortController;
  generation: number;
  events: PersonaWorkloadEvent[];
  done: Promise<void>;
  terminal: boolean;
}
export interface LocalPersonaWorkloadExecutorOptions {
  materializer: RepositoryArtifactMaterializer;
  repositoryMcpBundle: string;
  nodeBinary: string;
  gitBinary: string;
  providerBinary: (provider: "claude" | "codex") => Promise<string>;
  /** After registration the durable owner removes this home once its process group is empty. */
  ownWorkspace?: (workloadId: string, path: string) => void;
  /** Explicit provider authentication only. Never pass the daemon environment or Mission credentials. */
  providerEnvironment: (
    provider: "claude" | "codex",
  ) => Promise<Record<string, string>>;
  providers?: Record<"claude" | "codex", RepositoryProvider>;
}
/** Unwired reference executor. Durable dispatch and reconciliation belong to Phase 3. */
export class LocalPersonaWorkloadExecutor implements PersonaWorkloadExecutor {
  readonly repositoryEvidenceCapability = REPOSITORY_EVIDENCE_CAPABILITY;
  private readonly jobs = new Map<string, Job>();
  private readonly cancelled = new Map<string, number>();
  constructor(private readonly options: LocalPersonaWorkloadExecutorOptions) {}
  async *dispatch(
    raw: PersonaWorkloadRequest,
    signal: AbortSignal,
  ): AsyncIterable<PersonaWorkloadEvent> {
    const request = PersonaWorkloadRequestSchema.parse(raw);
    let job = this.jobs.get(request.workloadId);
    const ownsJob = job === undefined;
    if (job && JSON.stringify(job.request) !== JSON.stringify(request))
      throw Error("Conflicting workload replay");
    if (!job) {
      job = {
        request,
        controller: new AbortController(),
        generation: request.cancellationGeneration,
        events: [],
        done: Promise.resolve(),
        terminal: false,
      };
      this.jobs.set(request.workloadId, job);
      const abort = () => job!.controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (
        signal.aborted ||
        (this.cancelled.get(request.workloadId) ?? -1) >=
          request.cancellationGeneration
      )
        abort();
      job.done = this.run(job).finally(() =>
        signal.removeEventListener("abort", abort),
      );
    }
    // Only the creator owns cancellation. An observer can leave a live or completed replay.
    let position = 0;
    try {
      while (ownsJob || !signal.aborted) {
        if (position < job.events.length)
          yield structuredClone(job.events[position++]!);
        else if (job.terminal) return;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      if (ownsJob && !job.terminal) {
        job.controller.abort();
        await job.done;
      }
    }
  }
  async reconcile(
    workloadId: string,
    afterSequence: number,
  ): Promise<PersonaWorkloadReconciliation> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw Error("Invalid replay cursor");
    const job = this.jobs.get(workloadId);
    return {
      workloadId,
      state: !job ? "unknown" : job.terminal ? "terminal" : "running",
      events:
        job?.events
          .filter((e) => e.sequence > afterSequence)
          .map((e) => structuredClone(e)) ?? [],
    };
  }
  async cancel(workloadId: string, generation: number): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw Error("Invalid cancellation generation");
    const job = this.jobs.get(workloadId);
    if (
      generation < (this.cancelled.get(workloadId) ?? -1) ||
      (job && generation < job.generation)
    )
      return;
    this.cancelled.set(workloadId, generation);
    if (job) {
      job.generation = generation;
      job.controller.abort();
      await job.done;
    }
  }
  private async run(job: Job): Promise<void> {
    const { request } = job;
    let root: string | undefined;
    let registeredHome = false;
    let lease: RepositoryViewLease | undefined;
    const emit = (payload: Record<string, unknown>) =>
      job.events.push({
        ...payload,
        eventId: randomUUID(),
        workloadId: request.workloadId,
        attemptId: request.attemptId,
        sequence: job.events.length + 1,
        timestamp: Date.now(),
      } as PersonaWorkloadEvent);
    const remaining = Math.min(
      request.deadline - Date.now(),
      request.budgets.attemptMs,
    );
    let deadlineExpired = false;
    const timer = setTimeout(
      () => {
        deadlineExpired = true;
        job.controller.abort();
      },
      Math.max(0, remaining),
    );
    let journal:
      | Awaited<ReturnType<typeof openRepositoryAuditJournal>>
      | undefined;
    let auditTimer: ReturnType<typeof setInterval> | undefined;
    let auditFailed = false;
    let usage: Record<string, number> | undefined;
    let result: PersonaWorkloadResult = {
      status: "failed",
      code: "artifact_unavailable",
    };
    try {
      emit({ type: "accepted" });
      if (remaining <= 0) throw Error("deadline");
      job.controller.signal.throwIfAborted();
      const identity = {
        submissionId: request.submissionId,
        workloadId: request.workloadId,
        attemptId: request.attemptId,
        locator: request.artifact.locator,
        digest: request.artifact.digest,
      };
      lease = await this.options.materializer.materialize(
        identity,
        job.controller.signal,
      );
      RepositoryViewDescriptorSchema.parse(lease.descriptor);
      if (
        Object.entries(identity).some(
          ([key, value]) =>
            lease!.identity[key as keyof typeof identity] !== value,
        ) ||
        lease.descriptor.snapshotDigest !== identity.digest
      )
        throw Error("artifact identity mismatch");
      job.controller.signal.throwIfAborted();
      emit({ type: "repository_verified" });
      root = await mkdtemp(join(tmpdir(), "mission-repository-workload-"));
      if (this.options.ownWorkspace) {
        this.options.ownWorkspace(request.workloadId, root);
        registeredHome = true;
      }
      const cwd = join(root, "provider");
      await mkdir(cwd);
      const auditPath = join(root, "audit.jsonl"),
        descriptor = join(root, "descriptor.json");
      await writeFile(auditPath, "", { mode: 0o600 });
      await writeFile(
        descriptor,
        JSON.stringify({
          view: lease.descriptor,
          objectDirectory: lease.objectDirectory,
          gitBinary: this.options.gitBinary,
          workloadId: request.workloadId,
          attemptId: request.attemptId,
          budgets: request.budgets,
          auditPath,
          deadline: request.deadline,
        }),
        { mode: 0o600 },
      );
      journal = await openRepositoryAuditJournal(auditPath, request, (audit) =>
        emit({ type: "repository_query", audit }),
      );
      auditTimer = setInterval(() => {
        void journal!.drain().catch(() => {
          auditFailed = true;
          job.controller.abort();
        });
      }, 50);
      const auth = await this.options.providerEnvironment(
        request.execution.provider,
      );
      const allowed = new Set([
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
      ]);
      if (Object.keys(auth).some((k) => !allowed.has(k)))
        throw Error("Unexpected provider credential family");
      let providerPath = "/usr/bin:/bin";
      if (isAbsolute(this.options.nodeBinary)) {
        // Resolve env-node launchers without exposing every executable next to the host's Node.
        const bin = join(root, "bin");
        await mkdir(bin);
        await symlink(this.options.nodeBinary, join(bin, "node"));
        providerPath = bin + ":" + providerPath;
      }
      const env = {
        ...auth,
        HOME: cwd,
        CODEX_HOME: cwd,
        CLAUDE_CONFIG_DIR: cwd,
        PATH: providerPath,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      };
      result = { status: "failed", code: "provider_unavailable" };
      emit({ type: "persona_started" });
      const output = await (this.options.providers ?? REPOSITORY_PROVIDERS)[
        request.execution.provider
      ]({
        request,
        binary: await this.options.providerBinary(request.execution.provider),
        cwd,
        env,
        mcp: {
          command: FIXED_OS_EXECUTABLES.env,
          args: [
            "-i",
            "PATH=/usr/bin:/bin",
            `REPOSITORY_MCP_DESCRIPTOR=${descriptor}`,
            this.options.nodeBinary,
            this.options.repositoryMcpBundle,
          ],
          env: {},
        },
        signal: job.controller.signal,
      });
      usage = PersonaWorkloadResultSchema.options[0].shape.usage.parse(
        output.usage,
      );
      // The provider owns the MCP child and closes it before returning. Drain only complete records.
      result = { status: "failed", code: "audit_unavailable" };
      clearInterval(auditTimer);
      auditTimer = undefined;
      await journal.finish(job.controller.signal);
      result = { status: "failed", code: "invalid_verdict" };
      const verdict = PersonaWorkloadVerdictSchema.parse(output.verdict);
      const evidence =
        verdict.verdict === "pass"
          ? verdict.approvalDetails.evidence
          : verdict.requestedChanges.flatMap((c) => c.evidence);
      const handles = journal.handles;
      for (const reference of evidence)
        if (
          reference.kind === "repository" &&
          !handles.some(
            (h) =>
              h.operationId === reference.operationId &&
              h.evidenceHandleId === reference.evidenceHandleId,
          )
        )
          throw Error("Invalid repository evidence reference");
      result = PersonaWorkloadResultSchema.parse({
        status: "completed",
        result: {
          kind: "persona_verdict",
          verdict: PersonaWorkloadVerdictSchema.parse(output.verdict),
        },
        usage: output.usage,
      });
    } catch (error) {
      if (error instanceof ProviderFailure) result = { status: "failed", code: "provider_unavailable", providerFailure: error.kind };
      if (error instanceof RepositoryCapabilityError)
        result = { status: "failed", code: "capability_mismatch", capabilityReason: error.reason };
    } finally {
      clearTimeout(timer);
      clearInterval(auditTimer);
      await journal?.drain().catch(() => {
        auditFailed = true;
      });
      await journal?.close().catch(() => {
        auditFailed = true;
      });
      try {
        await lease?.release();
      } catch {
        result = { status: "failed", code: "artifact_unavailable" };
      }
      if (root && !registeredHome)
        await rm(root, { recursive: true, force: true }).catch(() => {
          result = { status: "failed", code: "artifact_unavailable" };
        });
      if (
        job.controller.signal.aborted ||
        deadlineExpired ||
        Date.now() >= request.deadline
      ) {
        emit({ type: "cancelled" });
        result = {
          status: "failed",
          code:
            deadlineExpired || Date.now() >= request.deadline
              ? "deadline"
              : "cancelled",
        };
      }
      if (auditFailed) result = { status: "failed", code: "audit_unavailable" };
      if (result.status === "failed" && usage) result = { ...result, usage };
      emit({ type: "terminal", capability: request.requiredCapability, result });
      job.terminal = true;
    }
  }
}
