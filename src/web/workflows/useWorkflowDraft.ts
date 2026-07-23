import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowSummary,
  WorkflowVersion,
  WorkflowVersionMetadata,
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
    : {
        ...current,
        draftRevision: stored.draftRevision,
        currentVersionId: stored.currentVersionId,
        archivedAt: stored.archivedAt,
        updatedAt: stored.updatedAt,
      };
}

export function workflowPublishMetadataChanged(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): boolean {
  return before.currentVersionId !== after.currentVersionId;
}

export function workflowDraftLoading(input: {
  workflowId: string | null;
  workflow: WorkflowDefinition | null;
  error: string | null;
  loading: boolean;
}): boolean {
  return input.loading || Boolean(input.workflowId && !input.workflow && !input.error);
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

export type WorkflowSummaryAction = "ignore" | "reload" | "conflict";

export function workflowSummaryAction(input: {
  local: WorkflowDefinition;
  summary: WorkflowSummary;
  dirty: boolean;
  saving: boolean;
}): WorkflowSummaryAction {
  const { local, summary, dirty, saving } = input;
  if (summary.id !== local.id || saving || summary.draftRevision < local.draftRevision) return "ignore";
  if (summary.draftRevision > local.draftRevision) return dirty ? "conflict" : "reload";
  const metadataChanged = summary.currentVersionId !== local.currentVersionId
    || summary.archivedAt !== local.archivedAt
    || summary.updatedAt > local.updatedAt;
  return metadataChanged && !dirty ? "reload" : "ignore";
}

export function versionMetadata(version: WorkflowVersion): WorkflowVersionMetadata {
  const { graph: _graph, ...metadata } = version;
  return metadata;
}

export function workflowSavePreflight(
  workflow: WorkflowDefinition | null,
  conflict: WorkflowSummary | null,
  savedFingerprint: string | null,
): "blocked" | "clean" | "save" {
  if (conflict) return "blocked";
  if (!workflow || editableFingerprint(workflow) === savedFingerprint) return "clean";
  return "save";
}

export interface WorkflowDraftState {
  workflow: WorkflowDefinition | null;
  versions: WorkflowVersionMetadata[];
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  conflict: WorkflowSummary | null;
  error: string | null;
  current: () => WorkflowDefinition | null;
  update: (patch: Partial<Pick<WorkflowDefinition, "name" | "description" | "draft" | "completionPolicy" | "bindingDefaults">>) => void;
  saveNow: () => Promise<boolean>;
  reload: () => Promise<void>;
  publish: () => Promise<WorkflowVersion | null>;
  duplicate: (name: string) => Promise<WorkflowSummary | null>;
  clearConflict: () => void;
}

/** One-workflow CAS autosave state machine. No second save starts while one is in flight. */
export function useWorkflowDraft(
  workflowId: string | null,
  streamedSummary: WorkflowSummary | null,
  onDirtyChange: (dirty: boolean) => void,
): WorkflowDraftState {
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [versions, setVersions] = useState<WorkflowVersionMetadata[]>([]);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [conflict, setConflict] = useState<WorkflowSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workflowIdRef = useRef(workflowId);
  const loadGeneration = useRef(0);
  workflowIdRef.current = workflowId;
  const currentWorkflow = workflow?.id === workflowId ? workflow : null;
  const currentConflict = conflict?.id === workflowId ? conflict : null;
  const workflowRef = useRef(currentWorkflow);
  const savedFingerprintRef = useRef(savedFingerprint);
  const conflictRef = useRef(currentConflict);
  const versionRefreshRef = useRef<string | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  workflowRef.current = currentWorkflow;
  savedFingerprintRef.current = savedFingerprint;
  conflictRef.current = currentConflict;

  const fingerprint = currentWorkflow ? editableFingerprint(currentWorkflow) : null;
  const dirty = fingerprint !== null && savedFingerprint !== null && fingerprint !== savedFingerprint;
  useEffect(() => onDirtyChange(dirty || saving), [dirty, onDirtyChange, saving]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const refreshVersions = useCallback(async (requestedId: string): Promise<void> => {
    const next = await workflowRequest<WorkflowVersionMetadata[]>(`/api/workflows/${requestedId}/versions`);
    if (workflowIdRef.current === requestedId) setVersions(next);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const requestedId = workflowId;
    const generation = ++loadGeneration.current;
    if (!requestedId) {
      setWorkflow(null);
      workflowRef.current = null;
      setVersions([]);
      setSavedFingerprint(null);
      savedFingerprintRef.current = null;
      setConflict(null);
      conflictRef.current = null;
      versionRefreshRef.current = null;
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const detail = await workflowRequest<WorkflowDetail>(`/api/workflows/${requestedId}`);
      if (loadGeneration.current !== generation || workflowIdRef.current !== requestedId) return;
      setWorkflow(detail.workflow);
      workflowRef.current = detail.workflow;
      setVersions(detail.versions);
      const loadedFingerprint = editableFingerprint(detail.workflow);
      setSavedFingerprint(loadedFingerprint);
      savedFingerprintRef.current = loadedFingerprint;
      setConflict(null);
      conflictRef.current = null;
      versionRefreshRef.current = null;
    } catch (caught) {
      if (loadGeneration.current !== generation || workflowIdRef.current !== requestedId) return;
      setError(caught instanceof Error ? caught.message : "Could not load workflow");
    } finally {
      if (loadGeneration.current === generation && workflowIdRef.current === requestedId) setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const local = workflowRef.current;
    if (!streamedSummary || !local) return;
    const action = workflowSummaryAction({ local, summary: streamedSummary, dirty, saving });
    if (action === "conflict") {
      conflictRef.current = streamedSummary;
      setConflict(streamedSummary);
    }
    if (action === "reload") void reload();
  }, [dirty, reload, saving, streamedSummary]);

  const update = useCallback((patch: Partial<Pick<WorkflowDefinition, "name" | "description" | "draft" | "completionPolicy" | "bindingDefaults">>): void => {
    setWorkflow((current) => {
      const next = current ? { ...current, ...patch } : current;
      if (next?.id === workflowIdRef.current) workflowRef.current = next;
      return next;
    });
  }, []);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const preflight = workflowSavePreflight(
      workflowRef.current,
      conflictRef.current,
      savedFingerprintRef.current,
    );
    if (preflight === "blocked") return false;
    if (preflight === "clean" && versionRefreshRef.current !== workflowRef.current?.id) return true;
    const request = (async (): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        while (true) {
          const submitted = workflowRef.current;
          const next = workflowSavePreflight(
            submitted,
            conflictRef.current,
            savedFingerprintRef.current,
          );
          if (next === "blocked") return false;
          if (submitted && versionRefreshRef.current === submitted.id) {
            await refreshVersions(submitted.id);
            versionRefreshRef.current = null;
          }
          if (next === "clean") return true;
          if (!submitted) return true;
          const submittedFingerprint = editableFingerprint(submitted);
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
          const refreshHistory = workflowPublishMetadataChanged(submitted, response.workflow);
          if (workflowIdRef.current === submitted.id) {
            setSavedFingerprint(submittedFingerprint);
            savedFingerprintRef.current = submittedFingerprint;
          }
          if (workflowRef.current?.id === submitted.id) {
            workflowRef.current = reconcileWorkflowSave(workflowRef.current, submittedFingerprint, response.workflow);
          }
          setWorkflow((current) => {
            if (!current || current.id !== submitted.id) return current;
            const reconciled = reconcileWorkflowSave(current, submittedFingerprint, response.workflow);
            if (workflowIdRef.current === submitted.id) workflowRef.current = reconciled;
            return reconciled;
          });
          conflictRef.current = null;
          setConflict(null);
          if (refreshHistory) {
            versionRefreshRef.current = submitted.id;
            await refreshVersions(submitted.id);
            versionRefreshRef.current = null;
          }
        }
      } catch (caught) {
        if (caught instanceof WorkflowApiError && caught.status === 409) {
          const current = caught.body?.current as WorkflowSummary | undefined;
          const nextConflict = current ?? streamedSummary ?? null;
          conflictRef.current = nextConflict;
          setConflict(nextConflict);
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
  }, [refreshVersions, streamedSummary]);

  useEffect(() => {
    if (!dirty || saving || currentConflict) return;
    const timer = window.setTimeout(() => void saveNow(), 500);
    return () => window.clearTimeout(timer);
  }, [currentConflict, dirty, saveNow, saving]);

  const publish = useCallback(async (): Promise<WorkflowVersion | null> => {
    const current = workflowRef.current;
    if (!current || dirty || saving || currentConflict) return null;
    setError(null);
    try {
      const response = await workflowRequest<WorkflowPublishResponse>(`/api/workflows/${current.id}/publish`, {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision: current.draftRevision }),
      });
      setWorkflow(response.workflow);
      workflowRef.current = response.workflow;
      const publishedFingerprint = editableFingerprint(response.workflow);
      setSavedFingerprint(publishedFingerprint);
      savedFingerprintRef.current = publishedFingerprint;
      setVersions((items) => items.some((item) => item.id === response.version.id)
        ? items
        : [versionMetadata(response.version), ...items]);
      return response.version;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not publish workflow");
      return null;
    }
  }, [currentConflict, dirty, saving]);

  const duplicate = useCallback(async (name: string): Promise<WorkflowSummary | null> => {
    const current = workflowRef.current;
    if (!current) return null;
    try {
      const response = await workflowRequest<WorkflowWriteResponse>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          name,
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
    workflow: currentWorkflow,
    versions,
    dirty,
    saving,
    loading: workflowDraftLoading({
      workflowId,
      workflow: currentWorkflow,
      error,
      loading,
    }),
    conflict: currentConflict,
    error,
    current: () => workflowRef.current,
    update,
    saveNow,
    reload,
    publish,
    duplicate,
    clearConflict: () => {
      conflictRef.current = null;
      setConflict(null);
    },
  }), [currentConflict, currentWorkflow, dirty, duplicate, error, loading, publish, reload, saveNow, saving, update, versions, workflowId]);
}
