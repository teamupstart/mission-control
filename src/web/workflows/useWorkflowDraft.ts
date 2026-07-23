import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowSummary,
  WorkflowVersion,
} from "@shared/workflow.ts";
import { WorkflowApiError, workflowRequest } from "./workflowApi.ts";

interface WorkflowWriteResponse {
  workflow: WorkflowDefinition;
  summary: WorkflowSummary;
}

interface WorkflowPublishResponse extends WorkflowWriteResponse {
  version: WorkflowVersion;
  idempotent: boolean;
}

export function editableFingerprint(workflow: WorkflowDefinition): string {
  return JSON.stringify({
    name: workflow.name,
    description: workflow.description,
    draft: workflow.draft,
    completionPolicy: workflow.completionPolicy,
    bindingDefaults: workflow.bindingDefaults,
  });
}

export function reconcileWorkflowSave(
  current: WorkflowDefinition,
  submittedFingerprint: string,
  stored: WorkflowDefinition,
): WorkflowDefinition {
  return editableFingerprint(current) === submittedFingerprint
    ? stored
    : { ...current, draftRevision: stored.draftRevision, updatedAt: stored.updatedAt };
}

export function workflowPublishBlocked(input: {
  dirty: boolean;
  saving: boolean;
  conflicted: boolean;
  valid: boolean;
  alreadyPublished: boolean;
  archived: boolean;
}): boolean {
  return input.dirty || input.saving || input.conflicted || !input.valid || input.alreadyPublished || input.archived;
}

export interface WorkflowDraftState {
  workflow: WorkflowDefinition | null;
  versions: WorkflowVersion[];
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  conflict: WorkflowSummary | null;
  error: string | null;
  update: (patch: Partial<Pick<WorkflowDefinition, "name" | "description" | "draft" | "completionPolicy" | "bindingDefaults">>) => void;
  saveNow: () => Promise<boolean>;
  reload: () => Promise<void>;
  publish: () => Promise<WorkflowVersion | null>;
  duplicate: () => Promise<WorkflowSummary | null>;
  clearConflict: () => void;
}

/** One-workflow CAS autosave state machine. No second save starts while one is in flight. */
export function useWorkflowDraft(
  workflowId: string | null,
  streamedSummary: WorkflowSummary | null,
  onDirtyChange: (dirty: boolean) => void,
): WorkflowDraftState {
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [conflict, setConflict] = useState<WorkflowSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workflowRef = useRef(workflow);
  const inFlight = useRef<Promise<boolean> | null>(null);
  workflowRef.current = workflow;

  const fingerprint = workflow ? editableFingerprint(workflow) : null;
  const dirty = fingerprint !== null && savedFingerprint !== null && fingerprint !== savedFingerprint;
  useEffect(() => onDirtyChange(dirty || saving), [dirty, onDirtyChange, saving]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const reload = useCallback(async (): Promise<void> => {
    if (!workflowId) {
      setWorkflow(null);
      setVersions([]);
      setSavedFingerprint(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const detail = await workflowRequest<WorkflowDetail>(`/api/workflows/${workflowId}`);
      setWorkflow(detail.workflow);
      setVersions(detail.versions);
      setSavedFingerprint(editableFingerprint(detail.workflow));
      setConflict(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load workflow");
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const local = workflowRef.current;
    if (!streamedSummary || !local || streamedSummary.id !== local.id || streamedSummary.draftRevision <= local.draftRevision) return;
    if (dirty || saving) setConflict(streamedSummary);
    else void reload();
  }, [dirty, reload, saving, streamedSummary]);

  const update = useCallback((patch: Partial<Pick<WorkflowDefinition, "name" | "description" | "draft" | "completionPolicy" | "bindingDefaults">>): void => {
    setWorkflow((current) => current ? { ...current, ...patch } : current);
  }, []);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const submitted = workflowRef.current;
    if (!submitted || conflict || editableFingerprint(submitted) === savedFingerprint) return true;
    const submittedFingerprint = editableFingerprint(submitted);
    const request = (async (): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const response = await workflowRequest<WorkflowWriteResponse>(`/api/workflows/${submitted.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            expectedDraftRevision: submitted.draftRevision,
            name: submitted.name,
            description: submitted.description,
            draft: submitted.draft,
            completionPolicy: submitted.completionPolicy,
            bindingDefaults: submitted.bindingDefaults,
          }),
        });
        setSavedFingerprint(submittedFingerprint);
        setWorkflow((current) => {
          if (!current || current.id !== submitted.id) return current;
          return reconcileWorkflowSave(current, submittedFingerprint, response.workflow);
        });
        return true;
      } catch (caught) {
        if (caught instanceof WorkflowApiError && caught.status === 409) {
          const current = caught.body?.current as WorkflowSummary | undefined;
          setConflict(current ?? streamedSummary ?? null);
        }
        setError(caught instanceof Error ? caught.message : "Could not save workflow");
        return false;
      } finally {
        setSaving(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = request;
    return request;
  }, [conflict, savedFingerprint, streamedSummary]);

  useEffect(() => {
    if (!dirty || saving || conflict) return;
    const timer = window.setTimeout(() => void saveNow(), 500);
    return () => window.clearTimeout(timer);
  }, [conflict, dirty, saveNow, saving]);

  const publish = useCallback(async (): Promise<WorkflowVersion | null> => {
    const current = workflowRef.current;
    if (!current || dirty || saving || conflict) return null;
    setError(null);
    try {
      const response = await workflowRequest<WorkflowPublishResponse>(`/api/workflows/${current.id}/publish`, {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision: current.draftRevision }),
      });
      setWorkflow(response.workflow);
      setSavedFingerprint(editableFingerprint(response.workflow));
      setVersions((items) => items.some((item) => item.id === response.version.id)
        ? items
        : [response.version, ...items]);
      return response.version;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not publish workflow");
      return null;
    }
  }, [conflict, dirty, saving]);

  const duplicate = useCallback(async (): Promise<WorkflowSummary | null> => {
    const current = workflowRef.current;
    if (!current) return null;
    try {
      const response = await workflowRequest<WorkflowWriteResponse>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          name: `${current.name} copy`,
          description: current.description,
          draft: current.draft,
          completionPolicy: current.completionPolicy,
          bindingDefaults: current.bindingDefaults,
        }),
      });
      return response.summary;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not duplicate workflow");
      return null;
    }
  }, []);

  return useMemo(() => ({
    workflow,
    versions,
    dirty,
    saving,
    loading,
    conflict,
    error,
    update,
    saveNow,
    reload,
    publish,
    duplicate,
    clearConflict: () => setConflict(null),
  }), [conflict, dirty, duplicate, error, loading, publish, reload, saveNow, saving, update, versions, workflow]);
}
