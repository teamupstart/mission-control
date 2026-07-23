import { randomUUID } from "node:crypto";
import { PersonaVerdictSchema, WorkflowContextSnapshotSchema } from "@shared/protocol.ts";
import type { LlmRunner } from "@shared/llm.ts";
import type {
  PersonaFeedbackSummary,
  PersonaVerdict,
  PublishedWorkflowGraph,
  PublishedWorkflowNode,
  WorkflowContextSnapshot,
  WorkflowEdge,
  WorkflowJson,
  WorkflowNodeAttempt,
  WorkflowSubmission,
  WorkflowVersion,
  PersonaExecutionView,
} from "@shared/workflow.ts";
import { llmRunner } from "../llm/index.ts";
import { createLimiter, runStructured } from "../llm/structured.ts";
import type { StructuredAttemptObserver } from "../llm/structured.ts";
import { buildPersonaPrompt } from "./prompt.ts";
import { resolvePersonaExecution } from "./personas.ts";
import { type WorkflowStore, workflowJson } from "./store.ts";
import { parsePersonaVerdict, verdictRequestedChanges } from "./verdict.ts";

const MAX_INFRA_ATTEMPTS = 3;
const PERSONA_TIMEOUT_MS = 120_000;
const RETRY_BASE_MS = 1_000;

export interface WorkflowEngineOptions {
  concurrency?: number;
  now?: () => number;
  retryBaseMs?: number;
  runnerFor?: (id: LlmRunner["id"]) => LlmRunner;
  resolveExecution?: (persona: Extract<PublishedWorkflowNode, { kind: "persona" }>["persona"]) => PersonaExecutionView;
}

function isPersona(node: PublishedWorkflowNode): node is Extract<PublishedWorkflowNode, { kind: "persona" }> {
  return node.kind === "persona";
}

function jsonValue(value: unknown): WorkflowJson {
  return workflowJson(value);
}

function outcome(payload: WorkflowJson): "pass" | "fail" | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  return payload.outcome === "pass" || payload.outcome === "fail" ? payload.outcome : null;
}

function requestedChangePacket(
  verdict: PersonaVerdict,
  personaName: string,
): PersonaFeedbackSummary {
  return {
    personaName,
    summary: verdict.summary,
    requestedChanges: verdictRequestedChanges(verdict).map((item) => item.title),
  };
}

function edgesFrom(graph: PublishedWorkflowGraph, nodeId: string, port: "submitted" | "pass" | "fail"): WorkflowEdge[] {
  return graph.edges.filter((edge) => edge.source === nodeId && edge.sourcePort === port);
}

export class WorkflowEngine {
  private readonly limit: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly runnerFor: (id: LlmRunner["id"]) => LlmRunner;
  private readonly resolveExecution: NonNullable<WorkflowEngineOptions["resolveExecution"]>;
  private stopped = true;
  private pumping = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = new Set<Promise<void>>();
  private scheduledAttempts = new Set<string>();

  constructor(
    readonly store: WorkflowStore,
    private readonly onRunChanged: (runId: string) => void = () => {},
    options: WorkflowEngineOptions = {},
  ) {
    this.limit = createLimiter(options.concurrency ?? 3);
    this.now = options.now ?? Date.now;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.runnerFor = options.runnerFor ?? llmRunner;
    this.resolveExecution = options.resolveExecution ?? resolvePersonaExecution;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.recover();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  wake(): void {
    if (this.stopped || this.pumping) return;
    queueMicrotask(() => void this.pump());
  }

  /** Activate all structurally ready nodes from durable receipts before any provider call. */
  activateSubmission(submissionId: string): void {
    const submission = this.store.getSubmission(submissionId);
    if (!submission) return;
    const run = this.store.getRun(submission.runId);
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    if (!run || !version) {
      if (run) {
        this.store.setRunState(run.id, "failed", "missing_workflow_version", {
          error: "The immutable workflow version is missing or corrupt",
        });
        this.onRunChanged(run.id);
      }
      return;
    }
    this.store.setSubmissionState(submission.id, "running", this.now());
    this.store.setRunState(run.id, "running", "persona_review", null, this.now());
    this.advanceStructure(submission, version);
    this.onRunChanged(run.id);
    this.wake();
  }

  private advanceStructure(submission: WorkflowSubmission, version: WorkflowVersion): void {
    const graph = version.graph;
    const sessionNode = graph.nodes.find((node) => node.kind === "session");
    if (!sessionNode) {
      this.blockSubmission(submission, "invalid_version", "Published workflow has no Session node");
      return;
    }
    let changed = true;
    while (changed) {
      changed = false;
      const latestSubmission = this.store.getSubmission(submission.id);
      const run = this.store.getRun(submission.runId);
      if (!latestSubmission || !run || latestSubmission.status !== "running" || run.status !== "running") return;
      const receipts = this.store.listReceipts(submission.id);

      let sessionAttempt = this.store.latestAttemptForNode(submission.id, sessionNode.id);
      if (!sessionAttempt) {
        sessionAttempt = this.store.insertAttempt({
          id: randomUUID(),
          submissionId: submission.id,
          nodeId: sessionNode.id,
          attempt: 1,
          state: "completed",
          persona: null,
          inputFingerprint: submission.evidenceFingerprint,
          now: this.now(),
        });
        this.store.finishAttempt(sessionAttempt.id, {
          state: "completed",
          output: { outcome: "submitted" },
        }, this.now());
      }
      for (const edge of edgesFrom(graph, sessionNode.id, "submitted")) {
        if (this.store.addReceipt(submission.id, edge.id, sessionAttempt.id, {
          outcome: "submitted",
        }, this.now())) changed = true;
      }

      // A completed Persona verdict and its matching receipts normally commit together.
      // Reasserting the receipts makes recovery safe for databases stopped between older
      // Phase 3 development builds that did not yet make that transaction atomic.
      for (const personaNode of graph.nodes.filter(isPersona)) {
        const completed = this.store.latestAttemptForNode(submission.id, personaNode.id);
        const parsed = PersonaVerdictSchema.safeParse(completed?.verdict);
        if (!completed || completed.state !== "completed" || !parsed.success) continue;
        const verdict: PersonaVerdict = parsed.data;
        const packet = jsonValue({
          outcome: verdict.verdict,
          persona: personaNode.persona.name,
          verdict,
          requestedChanges: verdictRequestedChanges(verdict).map((item) => item.title),
        });
        for (const edge of edgesFrom(graph, personaNode.id, verdict.verdict)) {
          if (this.store.addReceipt(submission.id, edge.id, completed.id, packet, this.now())) {
            changed = true;
          }
        }
      }

      const currentReceipts = this.store.listReceipts(submission.id);
      for (const edge of graph.edges) {
        const receipt = currentReceipts.find((item) => item.edgeId === edge.id);
        if (!receipt) continue;
        const target = graph.nodes.find((node) => node.id === edge.target);
        if (!target) continue;
        if (target.kind === "persona") {
          const latest = this.store.latestAttemptForNode(submission.id, target.id);
          if (!latest || latest.state === "cancelled") {
            this.store.insertAttempt({
              id: randomUUID(),
              submissionId: submission.id,
              nodeId: target.id,
              attempt: (latest?.attempt ?? 0) + 1,
              state: "queued",
              persona: target.persona,
              inputFingerprint: `${submission.evidenceFingerprint}:${target.id}`,
              now: this.now(),
            });
            changed = true;
          }
          continue;
        }
        if (target.kind === "session" && edge.targetPort === "return_for_changes") {
          const packet = outcome(receipt.payload) === "fail" ? receipt.payload : {
            outcome: "fail",
            requestedChanges: [],
          };
          this.store.setSubmissionState(submission.id, "waiting_for_session", this.now());
          this.store.setRunState(submission.runId, "waiting_for_session", "persona_feedback", packet, this.now());
          for (const attempt of this.store.listAttempts(submission.id)) {
            if (attempt.state === "queued" || attempt.state === "retry_wait") {
              this.store.finishAttempt(attempt.id, {
                state: "cancelled",
                error: "Submission is waiting for a fresh human resubmission",
              }, this.now());
            }
          }
          this.store.appendEvent(submission.runId, "submission_waiting_for_session", {
            submissionId: submission.id,
            edgeId: edge.id,
            receiptId: receipt.id,
          }, this.now());
          this.onRunChanged(submission.runId);
          return;
        }
      }

      for (const join of graph.nodes.filter((node) => node.kind === "all_pass")) {
        const existingJoin = this.store.latestAttemptForNode(submission.id, join.id);
        if (existingJoin?.state === "completed") {
          const existingOutcome = outcome(existingJoin.output);
          if (existingOutcome) {
            for (const outgoing of edgesFrom(graph, join.id, existingOutcome)) {
              if (this.store.addReceipt(
                submission.id,
                outgoing.id,
                existingJoin.id,
                existingJoin.output ?? { outcome: existingOutcome },
                this.now(),
              )) changed = true;
            }
          }
          continue;
        }
        if (existingJoin) continue;
        const incoming = graph.edges.filter((edge) => edge.target === join.id);
        const predecessors = [...new Set(incoming.map((edge) => edge.source))];
        const grouped = predecessors.map((source) => {
          const sourceEdges = incoming.filter((edge) => edge.source === source);
          const sourceReceipt = currentReceipts.find((receipt) =>
            sourceEdges.some((edge) => edge.id === receipt.edgeId));
          return { source, receipt: sourceReceipt };
        });
        if (grouped.length === 0 || grouped.some((item) => !item.receipt)) continue;
        const failed = grouped
          .map((item) => item.receipt!)
          .filter((receipt) => outcome(receipt.payload) === "fail");
        const joinOutcome = failed.length === 0 ? "pass" : "fail";
        const packet = joinOutcome === "pass"
          ? { outcome: "pass" as const }
          : {
              outcome: "fail" as const,
              requestedChanges: failed.map((receipt) => receipt.payload),
            };
        const attempt = this.store.insertAttempt({
          id: randomUUID(),
          submissionId: submission.id,
          nodeId: join.id,
          attempt: 1,
          state: "completed",
          persona: null,
          inputFingerprint: `${submission.evidenceFingerprint}:${join.id}`,
          now: this.now(),
        });
        this.store.finishAttempt(attempt.id, {
          state: "completed",
          output: jsonValue(packet),
        }, this.now());
        for (const outgoing of edgesFrom(graph, join.id, joinOutcome)) {
          if (this.store.addReceipt(
            submission.id,
            outgoing.id,
            attempt.id,
            jsonValue(packet),
            this.now(),
          )) changed = true;
        }
      }

      const afterJoinReceipts = this.store.listReceipts(submission.id);
      for (const end of graph.nodes.filter((node) => node.kind === "end")) {
        const existingEnd = this.store.latestAttemptForNode(submission.id, end.id);
        if (existingEnd?.state === "completed") {
          const existingOutcome = outcome(existingEnd.output);
          if (existingOutcome) {
            this.store.setSubmissionState(
              submission.id,
              existingOutcome === "pass" ? "completed" : "failed",
              this.now(),
            );
            this.store.setRunState(
              submission.runId,
              existingOutcome === "pass" ? "completed" : "failed",
              existingOutcome === "pass" ? "complete" : "failed_outcome",
              existingEnd.output,
              this.now(),
            );
            this.onRunChanged(submission.runId);
            return;
          }
          continue;
        }
        if (existingEnd) continue;
        const incoming = graph.edges.filter((edge) => edge.target === end.id);
        const receipt = afterJoinReceipts.find((item) => incoming.some((edge) => edge.id === item.edgeId));
        if (!receipt) continue;
        const edge = incoming.find((item) => item.id === receipt.edgeId)!;
        const endOutcome = edge.sourcePort === "fail" ? "fail" : "pass";
        const attempt = this.store.insertAttempt({
          id: randomUUID(),
          submissionId: submission.id,
          nodeId: end.id,
          attempt: 1,
          state: "completed",
          persona: null,
          inputFingerprint: `${submission.evidenceFingerprint}:${end.id}`,
          now: this.now(),
        });
        const packet = { outcome: endOutcome, label: end.outcome };
        this.store.finishAttempt(attempt.id, {
          state: "completed",
          output: packet,
        }, this.now());
        this.store.setSubmissionState(submission.id, endOutcome === "pass" ? "completed" : "failed", this.now());
        this.store.setRunState(
          submission.runId,
          endOutcome === "pass" ? "completed" : "failed",
          endOutcome === "pass" ? "complete" : "failed_outcome",
          {
            ...packet,
            completionPolicy: version.completionPolicy.kind === "inspector"
              ? "not active until Phase 5"
              : "none",
          },
          this.now(),
        );
        this.store.appendEvent(submission.runId, "workflow_end", packet, this.now());
        this.onRunChanged(submission.runId);
        return;
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      const ready = this.store.listRunnableAttempts(this.now());
      for (const attempt of ready) {
        if (this.scheduledAttempts.has(attempt.id)) continue;
        this.scheduledAttempts.add(attempt.id);
        const promise = this.limit(() => this.runAttempt(attempt))
          .catch((error) => console.error(`[workflow] attempt ${attempt.id}: ${String(error)}`))
          .finally(() => {
            this.inFlight.delete(promise);
            this.scheduledAttempts.delete(attempt.id);
            this.wake();
          });
        this.inFlight.add(promise);
      }
      const next = this.store.listAttemptsDueAfter(this.now());
      if (next !== null && !this.stopped) {
        if (this.wakeTimer) clearTimeout(this.wakeTimer);
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = null;
          this.wake();
        }, Math.max(1, next - this.now()));
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runAttempt(initial: WorkflowNodeAttempt): Promise<void> {
    const submission = this.store.getSubmission(initial.submissionId);
    const run = submission ? this.store.getRun(submission.runId) : null;
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    const node = version?.graph.nodes.find((candidate) => candidate.id === initial.nodeId);
    if (!submission || !run || !version || !node || !isPersona(node)) return;
    const execution = this.resolveExecution(node.persona);
    const claimed = this.store.claimAttempt(initial.id, execution.runner.id, execution.model.id, this.now());
    if (!claimed) return;
    const context = WorkflowContextSnapshotSchema.safeParse(submission.context);
    if (!context.success) {
      this.handleInfrastructureFailure(claimed, run.id, "The persisted workflow context is invalid");
      return;
    }
    const prompt = buildPersonaPrompt(node.persona, context.data);
    let runner: LlmRunner;
    try {
      runner = this.runnerFor(execution.runner.id);
    } catch (error) {
      this.handleInfrastructureFailure(claimed, run.id, String(error));
      return;
    }
    const callIds = new Map<number, string>();
    const observer: StructuredAttemptObserver = {
      start: (attempt, request) => {
        if (
          this.store.getRun(run.id)?.status !== "running"
          || this.store.getSubmission(submission.id)?.status !== "running"
        ) {
          return false;
        }
        const id = randomUUID();
        callIds.set(attempt, id);
        this.store.insertLlmCall({
          id,
          runId: run.id,
          submissionId: submission.id,
          nodeAttemptId: claimed.id,
          purpose: "persona_review",
          runner: execution.runner.id,
          model: execution.model.id,
          attempt,
          state: "running",
          startedAt: this.now(),
          finishedAt: null,
          durationMs: null,
          inputBytes: Buffer.byteLength(request),
          outputBytes: 0,
          costUsd: null,
          errorCode: null,
        });
      },
      finish: (attempt, callResult) => {
        const id = callIds.get(attempt);
        if (!id) return;
        this.store.finishLlmCall(
          id,
          callResult.parsed ? "succeeded" : "failed",
          callResult.raw ? Buffer.byteLength(callResult.raw) : 0,
          callResult.error
            ? "persona_infrastructure"
            : callResult.parsed
              ? null
              : "persona_parse",
          this.now(),
        );
      },
    };
    const result = await runStructured(
      (request) => runner.run(request, {
        model: execution.model.id,
        timeoutMs: PERSONA_TIMEOUT_MS,
      }),
      prompt,
      parsePersonaVerdict,
      `${node.persona.name} Persona`,
      observer,
    );
    if (result.kind === "failed") {
      this.handleInfrastructureFailure(claimed, run.id, result.reason);
      return;
    }
    const verdict = result.value;
    const latestRun = this.store.getRun(run.id);
    const latestSubmission = this.store.getSubmission(submission.id);
    const packet = requestedChangePacket(verdict, node.persona.name);
    const canEmit = latestRun?.status === "running" && latestSubmission?.status === "running";
    if (!canEmit) {
      this.store.finishAttempt(claimed.id, {
        state: "cancelled",
        verdict: jsonValue(verdict),
        output: jsonValue(packet),
        error: "Audit-only result after the submission stopped",
      }, this.now());
      return;
    }
    const receiptPayload = jsonValue({
        outcome: verdict.verdict,
        persona: node.persona.name,
        verdict,
      });
    this.store.finishAttemptWithReceipts(claimed.id, {
      verdict: jsonValue(verdict),
      output: jsonValue(packet),
      receipts: edgesFrom(version.graph, node.id, verdict.verdict).map((edge) => ({
        edgeId: edge.id,
        payload: receiptPayload,
      })),
    }, this.now());
    this.store.appendEvent(run.id, "persona_verdict", {
      nodeId: node.id,
      persona: node.persona.name,
      verdict: verdict.verdict,
    }, this.now());
    this.advanceStructure(submission, version);
    this.onRunChanged(run.id);
  }

  private handleInfrastructureFailure(
    attempt: WorkflowNodeAttempt,
    runId: string,
    reason: string,
  ): void {
    const currentRun = this.store.getRun(runId);
    const currentSubmission = this.store.getSubmission(attempt.submissionId);
    if (currentRun?.status !== "running" || currentSubmission?.status !== "running") {
      this.store.finishAttempt(attempt.id, {
        state: "cancelled",
        error: `Audit-only infrastructure result after the submission stopped: ${reason}`,
      }, this.now());
      return;
    }
    this.store.finishAttempt(attempt.id, {
      state: "error",
      error: reason,
    }, this.now());
    if (attempt.attempt < MAX_INFRA_ATTEMPTS) {
      const retryAt = this.now() + this.retryBaseMs * 4 ** (attempt.attempt - 1);
      this.store.insertAttempt({
        id: randomUUID(),
        submissionId: attempt.submissionId,
        nodeId: attempt.nodeId,
        attempt: attempt.attempt + 1,
        state: "retry_wait",
        persona: attempt.persona,
        inputFingerprint: attempt.inputFingerprint,
        retryAt,
        error: `Retry scheduled after infrastructure failure: ${reason}`,
        now: this.now(),
      });
      this.store.appendEvent(runId, "persona_retry_scheduled", {
        nodeId: attempt.nodeId,
        attempt: attempt.attempt + 1,
        retryAt,
        error: reason,
      }, this.now());
      this.onRunChanged(runId);
      this.wake();
      return;
    }
    const submission = this.store.getSubmission(attempt.submissionId);
    if (submission) this.store.setSubmissionState(submission.id, "failed", this.now());
    this.store.setRunState(runId, "blocked", "infrastructure_error", {
      nodeId: attempt.nodeId,
      attempts: attempt.attempt,
      error: reason,
    }, this.now());
    this.store.appendEvent(runId, "persona_infrastructure_exhausted", {
      nodeId: attempt.nodeId,
      attempts: attempt.attempt,
      error: reason,
    }, this.now());
    this.onRunChanged(runId);
  }

  private blockSubmission(submission: WorkflowSubmission, phase: string, error: string): void {
    this.store.setSubmissionState(submission.id, "failed", this.now());
    this.store.setRunState(submission.runId, "failed", phase, { error }, this.now());
    this.store.appendEvent(submission.runId, "workflow_failed", { phase, error }, this.now());
    this.onRunChanged(submission.runId);
  }

  private recover(): void {
    for (const run of this.store.listRuns()) {
      if (["completed", "cancelled", "failed"].includes(run.status)) continue;
      this.store.interruptRunningLlmCalls(run.id, this.now());
      if (run.status === "capturing") {
        const submission = this.store.latestSubmission(run.id);
        if (submission?.status === "capturing") {
          this.store.setSubmissionState(submission.id, "failed", this.now());
        }
        this.store.setRunState(run.id, "blocked", "capture_interrupted", {
          error: "Evidence capture was interrupted by daemon restart; submit again",
        }, this.now());
        this.store.appendEvent(run.id, "capture_interrupted", {
          submissionId: submission?.id ?? null,
        }, this.now());
        this.onRunChanged(run.id);
        continue;
      }
      const version = this.store.getWorkflowVersionById(run.workflowVersionId);
      if (!version) {
        this.store.setRunState(run.id, "failed", "missing_workflow_version", {
          error: "The immutable workflow version is missing or corrupt",
        }, this.now());
        this.onRunChanged(run.id);
        continue;
      }
      for (const submission of this.store.listSubmissions(run.id)) {
        for (const attempt of this.store.listAttempts(submission.id)) {
          if (attempt.state !== "running") continue;
          this.store.finishAttempt(attempt.id, {
            state: "error",
            error: "Interrupted by daemon restart",
          }, this.now());
          if (attempt.attempt < MAX_INFRA_ATTEMPTS) {
            this.store.insertAttempt({
              id: randomUUID(),
              submissionId: attempt.submissionId,
              nodeId: attempt.nodeId,
              attempt: attempt.attempt + 1,
              state: "retry_wait",
              persona: attempt.persona,
              inputFingerprint: attempt.inputFingerprint,
              retryAt: this.now(),
              error: "Retrying interrupted tool-less call",
              now: this.now(),
            });
          } else {
            this.store.setSubmissionState(submission.id, "failed", this.now());
            this.store.setRunState(run.id, "blocked", "infrastructure_error", {
              nodeId: attempt.nodeId,
              error: "Interrupted call exhausted its retry budget",
            }, this.now());
          }
        }
        if (submission.status === "running" && this.store.getRun(run.id)?.status === "running") {
          this.advanceStructure(submission, version);
        }
      }
      this.onRunChanged(run.id);
    }
  }
}
