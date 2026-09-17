import type { DatabaseSync } from "node:sqlite";
import type {
  WorkflowBinding, WorkflowDefinition, WorkflowDelivery, WorkflowEvent, WorkflowLlmCall,
  WorkflowNodeAttempt, WorkflowRun, WorkflowSubmission, WorkflowVersion,
} from "@shared/workflow.ts";

/** Domain write notices, independent of any observer's event or metric model. */
export type WorkflowMutation = { now: number } & (
  | { kind: "definition" | "version" | "binding" | "run" | "submission" | "attempt" | "delivery" | "call"; id: string }
  | { kind: "calls_settled" | "run_cancelled"; runId: string }
  | { kind: "event"; event: WorkflowEvent }
);

/** Observers can inspect the owner's current state, but cannot drive its lifecycle. */
export interface WorkflowMutationView {
  getWorkflow(id: string): WorkflowDefinition | null;
  getWorkflowVersionById(id: string): WorkflowVersion | null;
  getBinding(id: string): WorkflowBinding | null;
  getRun(id: string): WorkflowRun | null;
  getSubmission(id: string): WorkflowSubmission | null;
  latestSubmissionForRun(runId: string): WorkflowSubmission | null;
  getAttempt(id: string): WorkflowNodeAttempt | null;
  listAttempts(submissionId: string): WorkflowNodeAttempt[];
  listAttemptsForRun(runId: string): WorkflowNodeAttempt[];
  getDelivery(id: string): WorkflowDelivery | null;
  listDeliveries(runId: string): WorkflowDelivery[];
  getLlmCall(id: string): WorkflowLlmCall | null;
  listLlmCallsFinishedAt(runId: string, now: number): WorkflowLlmCall[];
}

export interface WorkflowMutationObserver {
  /** Synchronous: accepted observations must commit with the owner's write. */
  observe(db: DatabaseSync, view: WorkflowMutationView, mutation: WorkflowMutation): void;
  failed?(db: DatabaseSync): void;
}

const observers = new Set<WorkflowMutationObserver>();

/** Bootstrap registration is idempotent and applies to existing and future stores. */
export function registerWorkflowMutationObserver(observer: WorkflowMutationObserver): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/** Called only inside the store's mutation transaction. An observer cannot veto a write. */
export function publishWorkflowMutation(
  db: DatabaseSync,
  view: WorkflowMutationView,
  notice: () => WorkflowMutation | readonly WorkflowMutation[] | null,
): void {
  for (const observer of observers) {
    let savepoint = false;
    try {
      db.exec("SAVEPOINT workflow_observer");
      savepoint = true;
      const mutation = notice();
      if (mutation) {
        for (const item of Array.isArray(mutation) ? mutation : [mutation]) observer.observe(db, view, item);
      }
      db.exec("RELEASE workflow_observer");
    } catch {
      if (savepoint) {
        try {
          db.exec("ROLLBACK TO workflow_observer");
          db.exec("RELEASE workflow_observer");
        } catch { /* A released savepoint must not turn observer failure into owner failure. */ }
      }
      try { observer.failed?.(db); } catch { /* Diagnostics cannot veto the write either. */ }
    }
  }
}
