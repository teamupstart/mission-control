import { featureEnabled } from "../feature-flags/index.ts";
import { PERSONA_REPOSITORY_ACCESS_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { createHash } from "node:crypto";
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

async function binary(id: "node" | "git" | "claude" | "codex") {
  const resolved = await locateExecutable(id);
  if (!resolved) throw new Error(`Repository reviewer requires ${id}`);
  return resolved.path;
}

type ReviewInput = Pick<PersonaWorkloadRequest, "attemptId" | "submissionId" | "accounting" | "prompt" | "images" | "deadline" | "execution">
  & { persona: import("@shared/workflow.ts").PersonaSnapshot };

export class RepositoryReview {
  constructor(private readonly store: WorkflowStore, private readonly injected?: PersonaWorkloadExecutor) {}

  private current(id: string) {
    return this.store.transact(db => db.prepare(`SELECT w.id AS workloadId, w.attempt_id AS attemptId,
      s.id AS submissionId, w.digest, a.locator FROM workflow_repository_workloads w
      JOIN workflow_node_attempts n ON n.id=w.attempt_id AND n.state='running'
      JOIN workflow_submissions s ON s.id=n.submission_id AND s.status='running'
      JOIN workflow_runs r ON r.id=s.run_id AND r.status='running'
      JOIN workflow_repository_snapshot_claims c ON c.submission_id=s.id AND c.digest=w.digest AND c.state='active'
      JOIN workflow_repository_artifacts a ON a.digest=c.digest AND a.state='ready'
      WHERE w.id=? AND w.state='running'`).get(id)) as
      { workloadId: string; attemptId: string; submissionId: string; digest: string; locator: string } | undefined;
  }

  interrupt() {
    this.store.transact(db => db.prepare(`UPDATE workflow_repository_workloads SET state='interrupted',
      cancellation_generation=cancellation_generation+1 WHERE state='running'`).run());
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
    const executor = this.injected ?? new LocalPersonaWorkloadExecutor({
      materializer: service, repositoryMcpBundle: repositoryMcpServerPath(),
      nodeBinary: await binary("node"), gitBinary: await binary("git"), providerBinary: binary,
      providerEnvironment: async provider => {
        const env: Record<string, string> = {};
        const keys = provider === "codex" ? ["OPENAI_API_KEY"] : ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
        for (const key of keys) if (process.env[key]) env[key] = process.env[key]!;
        return env;
      },
    });
    if (executor.repositoryEvidenceCapability !== request.requiredCapability) throw new Error("Repository executor capability mismatch");
    // Executable lookup can yield after the engine's check. Recheck before granting workload ownership.
    if (!featureEnabled(PERSONA_REPOSITORY_ACCESS_FLAG_ID)) throw new Error("Persona repository access preview is off");
    this.store.transact(db => db.prepare(`INSERT INTO workflow_repository_workloads
      (id,attempt_id,digest,state,deadline) VALUES(?,?,?,'running',?)`)
      .run(id, input.attemptId, snapshot.digest, input.deadline));
    const cancel = new AbortController();
    const signal = AbortSignal.any([shutdown, cancel.signal, AbortSignal.timeout(Math.max(1, input.deadline - Date.now()))]);
    const timer = setInterval(() => {
      try {
        if (!featureEnabled(PERSONA_REPOSITORY_ACCESS_FLAG_ID) || !this.current(id)) cancel.abort();
      } catch {
        cancel.abort();
      }
    }, 250);
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= executor.cancel(id, request.cancellationGeneration + 1).catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    let errorCode = "workload_interrupted";
    let terminal: Extract<PersonaWorkloadEvent, { type: "terminal" }> | undefined;
    let events: AsyncIterator<PersonaWorkloadEvent> | undefined;
    let streamFinished = false;
    let sequence = 0;
    let stage: "new" | "accepted" | "repository_verified" | "persona_started" | "cancelled" = "new";
    try {
      signal.throwIfAborted();
      events = executor.dispatch(request, signal)[Symbol.asyncIterator]();
      while (true) {
        const next = await events.next();
        if (next.done) {
          streamFinished = true;
          break;
        }
        const event = PersonaWorkloadEventSchema.parse(next.value);
        if (event.workloadId !== id || event.attemptId !== input.attemptId) throw new Error("Repository event identity mismatch");
        const hash = createHash("sha256").update(canonicalJson(event)).digest("hex");
        if (event.sequence <= sequence) {
          const prior = this.store.transact(db => db.prepare("SELECT hash FROM workflow_repository_events WHERE workload_id=? AND sequence=?").get(id, event.sequence));
          if (prior?.hash === hash) continue;
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
        this.store.transact(db => {
          if (!this.current(id)) throw new Error("Repository workload ownership expired");
          db.prepare(`INSERT INTO workflow_repository_events(workload_id,sequence,event_id,hash,kind,received_at)
            VALUES(?,?,?,?,?,?)`).run(id, event.sequence, event.eventId, hash, event.type, Date.now());
          if (event.type === "terminal" && event.result.usage) {
            db.prepare("UPDATE workflow_repository_workloads SET usage_json=? WHERE id=?").run(JSON.stringify(event.result.usage), id);
            const cost = event.result.usage.total_cost_usd;
            if (cost !== undefined && cost >= 0) db.prepare("UPDATE workflow_llm_calls SET cost_usd=? WHERE id=?").run(cost, id);
          }
          if (event.type === "repository_query") {
            const audit = event.audit;
            if (audit.workloadId !== id || audit.attemptId !== input.attemptId || audit.snapshotDigest !== snapshot.digest)
              throw new Error("Repository query ownership mismatch");
            db.prepare(`INSERT INTO workflow_repository_queries(workload_id,operation_id,audit_json) VALUES(?,?,?)`)
              .run(id, audit.operationId, JSON.stringify(audit));
            const insert = db.prepare("INSERT INTO workflow_repository_handles(id,operation_id,audit_index) VALUES(?,?,?)");
            for (const [index, handle] of audit.handles.entries()) insert.run(handle.evidenceHandleId, audit.operationId, index);
          }
        });
        if (event.type === "repository_query" && ["unavailable","audit_unavailable","budget_exhausted","timeout","cancelled"].includes(event.audit.code ?? ""))
          throw new Error(`Repository query failed: ${event.audit.code}`);
        if (event.type === "terminal") terminal = event;
      }
      signal.throwIfAborted();
      if (!featureEnabled(PERSONA_REPOSITORY_ACCESS_FLAG_ID) || !terminal || !this.current(id)) throw new Error("No current terminal repository verdict");
      if (terminal.result.status === "failed") {
        errorCode = terminal.result.code;
        if (terminal.result.providerFailure) throw new ProviderFailure(errorCode, null, terminal.result.providerFailure);
        throw new Error(`Repository workload failed: ${errorCode}`);
      }
      const verdict = terminal.result.result.verdict;
      const refs = verdict.verdict === "pass" ? verdict.approvalDetails.evidence : verdict.requestedChanges.flatMap(c => c.evidence);
      this.store.transact(db => {
        const find = db.prepare(`SELECT 1 FROM workflow_repository_queries q
          JOIN workflow_repository_handles h ON h.operation_id=q.operation_id
          WHERE q.workload_id=? AND q.operation_id=? AND h.id=?`);
        for (const ref of refs) if (ref.kind === "repository" && !find.get(id, ref.operationId, ref.evidenceHandleId))
          throw new Error("Repository citation does not belong to this review");
        db.prepare("UPDATE workflow_repository_workloads SET state='completed' WHERE id=?").run(id);
      });
      return JSON.stringify(verdict);
    } finally {
      clearInterval(timer);
      // Iterator teardown may itself wait for the provider. Request cancellation before closing it.
      if (!streamFinished || !terminal) cancel.abort();
      signal.removeEventListener("abort", stop);
      try {
        if (!streamFinished) await events?.return?.();
      } finally {
        await stopping;
        this.store.transact(db => db.prepare(`UPDATE workflow_repository_workloads SET state='failed',
          error_code=?, cancellation_generation=cancellation_generation+1 WHERE id=? AND state='running'`).run(errorCode,id));
      }
    }
  }
}
