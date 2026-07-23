import { randomUUID } from "node:crypto";
import type { CreateWorkflow, UpdateWorkflow } from "@shared/protocol.ts";
import type {
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowDiagnostic,
  WorkflowSummary,
  WorkflowValidationResult,
  WorkflowVersion,
} from "@shared/workflow.ts";
import { normalizeWorkflowName } from "@shared/workflow.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";
import type { Registry } from "../registry.ts";
import {
  WorkflowStore,
  type WorkflowPublishWrite,
  type WorkflowStoreWrite,
} from "./store.ts";

export type WorkflowMutation =
  | { ok: true; workflow: WorkflowDefinition; summary: WorkflowSummary }
  | Exclude<WorkflowStoreWrite, { ok: true }>;

export type WorkflowPublishMutation =
  | {
      ok: true;
      workflow: WorkflowDefinition;
      summary: WorkflowSummary;
      version: WorkflowVersion;
      idempotent: boolean;
    }
  | Exclude<WorkflowPublishWrite, { ok: true }>;

export type WorkflowValidationMutation =
  | ({ ok: true; workflow: WorkflowDefinition } & WorkflowValidationResult)
  | {
      ok: false;
      reason: "not_found" | "revision_conflict";
      current: WorkflowDefinition | null;
    };

/** Definition policy and catalog SSE. Execution policy joins this manager in Phase 3. */
export class WorkflowManager {
  constructor(
    private readonly registry: Registry,
    readonly store = new WorkflowStore(),
  ) {
    this.registry.initializeWorkflows(this.list(true));
  }

  list(includeArchived = false): WorkflowSummary[] {
    return this.store.listWorkflows(includeArchived).map((workflow) => this.store.summary(workflow));
  }

  get(id: string): WorkflowDetail | null {
    const workflow = this.store.getWorkflow(id);
    return workflow ? { workflow, versions: this.store.listWorkflowVersions(id) } : null;
  }

  create(input: CreateWorkflow, now = Date.now()): WorkflowMutation {
    const result = this.store.insertWorkflow({
      ...input,
      id: randomUUID(),
      normalizedName: normalizeWorkflowName(input.name),
      createdAt: now,
      updatedAt: now,
    });
    return this.finish(result);
  }

  update(id: string, input: UpdateWorkflow, now = Date.now()): WorkflowMutation {
    const { expectedDraftRevision, ...editable } = input;
    const result = this.store.updateWorkflowCas(id, expectedDraftRevision, {
      ...editable,
      ...(editable.name === undefined ? {} : { normalizedName: normalizeWorkflowName(editable.name) }),
    }, now);
    return this.finish(result);
  }

  archive(id: string, expectedDraftRevision: number, now = Date.now()): WorkflowMutation {
    return this.finish(this.store.archiveWorkflowCas(id, expectedDraftRevision, now));
  }

  validate(id: string, expectedDraftRevision: number): WorkflowValidationMutation {
    const workflow = this.store.getWorkflow(id);
    if (!workflow) return { ok: false, reason: "not_found", current: null };
    if (workflow.draftRevision !== expectedDraftRevision) {
      return { ok: false, reason: "revision_conflict", current: workflow };
    }
    const result = validateWorkflowGraph({
      graph: workflow.draft,
      personas: this.store.listPersonas(true),
      completionPolicy: workflow.completionPolicy,
    });
    return { ok: true, workflow, ...result };
  }

  publish(id: string, expectedDraftRevision: number, now = Date.now()): WorkflowPublishMutation {
    const result = this.store.publishWorkflow(id, expectedDraftRevision, randomUUID(), now);
    if (!result.ok) return result;
    const summary = this.store.summary(result.workflow);
    this.registry.upsertWorkflow(summary);
    return { ...result, summary };
  }

  versions(id: string): WorkflowVersion[] | null {
    return this.store.getWorkflow(id) ? this.store.listWorkflowVersions(id) : null;
  }

  version(id: string, version: number): WorkflowVersion | null {
    return this.store.getWorkflowVersion(id, version);
  }

  /** Persona edits can change draft diagnostics and version-history staleness. */
  refreshSummaries(): void {
    for (const summary of this.list(true)) this.registry.upsertWorkflow(summary);
  }

  diagnostics(id: string): WorkflowDiagnostic[] | null {
    const workflow = this.store.getWorkflow(id);
    if (!workflow) return null;
    return validateWorkflowGraph({
      graph: workflow.draft,
      personas: this.store.listPersonas(true),
      completionPolicy: workflow.completionPolicy,
    }).diagnostics;
  }

  private finish(result: WorkflowStoreWrite): WorkflowMutation {
    if (!result.ok) return result;
    const summary = this.store.summary(result.workflow);
    this.registry.upsertWorkflow(summary);
    return { ok: true, workflow: result.workflow, summary };
  }
}
