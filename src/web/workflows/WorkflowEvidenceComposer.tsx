import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import {
  WORKFLOW_EVIDENCE_PROOF_CLASSES,
  WORKFLOW_IMAGE_LIMITS,
  workflowEvidenceMissingRoleGaps,
  workflowEvidenceRequiredRoleGroups,
  type WorkflowEvidenceCoverageClaim,
  type WorkflowEvidenceCoverageLink,
  type WorkflowEvidenceProofClass,
  type WorkflowEvidenceProofRole,
  type WorkflowEvidenceRepositoryScope,
  type WorkflowStagedEvidenceList,
  type WorkflowUploadEvidenceLocator,
} from "@shared/workflow.ts";
import {
  AttachmentStrip,
  revokeAttachments,
  useImageDrop,
  type PendingAttachment,
} from "../components/ImageDrop.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { repoLeaf } from "../lib/format.ts";
import { workflowRequest } from "./workflowApi.ts";

export interface WorkflowEvidenceScopeOption {
  value: WorkflowEvidenceRepositoryScope;
  label: string;
}

/**
 * The repository slots are issued by the session projection in the same primary-first order
 * the daemon uses while capturing evidence. The browser labels them; it never manufactures a
 * path-bearing locator.
 */
export function workflowEvidenceScopes(
  session: Session | null | undefined,
  selectedRepoRoot?: string | null,
): { options: WorkflowEvidenceScopeOption[]; defaultScope: WorkflowEvidenceRepositoryScope } {
  const repos = session?.task?.repoPrs.length
    ? session.task.repoPrs
    : session?.repoRoot
      ? [{ repoRoot: session.repoRoot, primary: true }]
      : session?.gitRoot
        ? [{ repoRoot: session.gitRoot, primary: true }]
        : [];
  const options = repos.map((repo, index) => ({
    value: `repo-${String(index + 1).padStart(2, "0")}` as const,
    label: `${repoLeaf(repo.repoRoot)}${repo.primary ? " (primary)" : ""}`,
  }));
  const selectedIndex = selectedRepoRoot
    ? repos.findIndex((repo) => repo.repoRoot === selectedRepoRoot)
    : -1;
  const defaultScope = options[selectedIndex >= 0 ? selectedIndex : 0]?.value ?? "repo-01";
  return {
    options: options.length > 1
      ? [{ value: "all", label: "All repositories" }, ...options]
      : options.length === 1
        ? options
        : [{ value: "repo-01", label: "Primary repository" }],
    defaultScope,
  };
}

export interface WorkflowEvidenceDraft {
  attachments: PendingAttachment[];
  metadata: Record<string, {
    caption: string;
    repositoryScope: WorkflowEvidenceRepositoryScope;
  }>;
}

export interface WorkflowEvidenceDraftController {
  draft: WorkflowEvidenceDraft;
  setAttachments: (attachments: PendingAttachment[]) => void;
  update: (
    id: string,
    patch: Partial<WorkflowEvidenceDraft["metadata"][string]>,
  ) => void;
  staged: WorkflowStagedEvidenceList;
  stagedLoading: boolean;
  stagedError: string | null;
  coverageError: string | null;
  removingStaged: ReadonlySet<string>;
  refreshStaged: () => void;
  removeStaged: (clientItemId: string) => void;
  saveCoverage: (claim: WorkflowEvidenceCoverageClaim) => Promise<void>;
  removeCoverage: (clientCriterionId: string) => Promise<void>;
  clear: () => void;
}

const EMPTY_DRAFT: WorkflowEvidenceDraft = { attachments: [], metadata: {} };
const EMPTY_STAGED: WorkflowStagedEvidenceList = {
  generation: 0,
  images: [],
  artifacts: [],
  coverage: [],
};
const EMPTY_REMOVING = new Set<string>();

export interface WorkflowEvidenceOwner {
  key: string;
  requestPath: string;
}

export function workflowBindingEvidenceOwner(
  bindingId: string | null | undefined,
): WorkflowEvidenceOwner | null {
  return bindingId
    ? {
        key: `binding:${bindingId}`,
        requestPath: `/api/workflow-bindings/${encodeURIComponent(bindingId)}/evidence`,
      }
    : null;
}

export function workflowSessionEvidenceOwner(
  sessionId: string | null | undefined,
): WorkflowEvidenceOwner | null {
  return sessionId
    ? {
        key: `session:${sessionId}`,
        requestPath: `/api/sessions/${encodeURIComponent(sessionId)}/workflow-evidence`,
      }
    : null;
}

export interface OwnedWorkflowEvidenceDraft {
  ownerKey: string | null;
  draft: WorkflowEvidenceDraft;
}

/** A new evidence owner sees an empty draft on its first render, before effects can run. */
export function workflowEvidenceDraftForOwner(
  state: OwnedWorkflowEvidenceDraft,
  ownerKey: string | null | undefined,
): WorkflowEvidenceDraft {
  return state.ownerKey === (ownerKey ?? null) ? state.draft : EMPTY_DRAFT;
}

/**
 * Own one capture draft outside any transient dialog. Closing a confirmation therefore keeps
 * thumbnails, captions, scopes, and the request's opaque upload ids ready for the next click.
 */
export function useWorkflowEvidenceDraft(
  evidenceOwner: WorkflowEvidenceOwner | null | undefined,
  defaultScope: WorkflowEvidenceRepositoryScope,
): WorkflowEvidenceDraftController {
  const owner = evidenceOwner?.key ?? null;
  const requestPath = evidenceOwner?.requestPath ?? null;
  const [draftState, setDraftState] = useState<OwnedWorkflowEvidenceDraft>(() => ({
    ownerKey: owner,
    draft: EMPTY_DRAFT,
  }));
  const draft = workflowEvidenceDraftForOwner(draftState, owner);
  const [stagedState, setStagedState] = useState<{
    ownerKey: string | null;
    staged: WorkflowStagedEvidenceList;
    loading: boolean;
    error: string | null;
  }>(() => ({
    ownerKey: owner,
    staged: EMPTY_STAGED,
    loading: Boolean(owner),
    error: null,
  }));
  const currentStaged = stagedState.ownerKey === owner
    ? stagedState
    : { ownerKey: owner, staged: EMPTY_STAGED, loading: Boolean(owner), error: null };
  const [removalState, setRemovalState] = useState<{
    ownerKey: string | null;
    ids: Set<string>;
  }>(() => ({ ownerKey: owner, ids: new Set() }));
  const removingStaged = removalState.ownerKey === owner
    ? removalState.ids
    : EMPTY_REMOVING;
  const [coverageErrorState, setCoverageErrorState] = useState<{
    ownerKey: string | null;
    error: string | null;
  }>(() => ({ ownerKey: owner, error: null }));
  const coverageError = coverageErrorState.ownerKey === owner ? coverageErrorState.error : null;
  const generation = useRef(0);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const draftStateRef = useRef(draftState);
  draftStateRef.current = draftState;

  const loadStaged = useCallback(() => {
    const mine = ++generation.current;
    if (!owner || !requestPath) {
      setStagedState({ ownerKey: owner, staged: EMPTY_STAGED, loading: false, error: null });
      return;
    }
    setStagedState((current) => ({
      ownerKey: owner,
      staged: current.ownerKey === owner ? current.staged : EMPTY_STAGED,
      loading: true,
      error: null,
    }));
    void workflowRequest<WorkflowStagedEvidenceList>(requestPath).then(
      (next) => {
        if (generation.current !== mine || ownerRef.current !== owner) return;
        setStagedState({ ownerKey: owner, staged: next, loading: false, error: null });
      },
      (caught) => {
        if (generation.current !== mine || ownerRef.current !== owner) return;
        setStagedState({
          ownerKey: owner,
          staged: EMPTY_STAGED,
          loading: false,
          error: caught instanceof Error ? caught.message : "Could not load staged evidence",
        });
      },
    );
  }, [owner, requestPath]);

  useEffect(() => {
    loadStaged();
    return () => { generation.current++; };
  }, [loadStaged]);
  useEffect(() => {
    setDraftState((current) => {
      if (current.ownerKey === owner) return current;
      revokeAttachments(current.draft.attachments);
      return { ownerKey: owner, draft: EMPTY_DRAFT };
    });
    setRemovalState((current) => current.ownerKey === owner
      ? current
      : { ownerKey: owner, ids: new Set() });
    setCoverageErrorState((current) => current.ownerKey === owner
      ? current
      : { ownerKey: owner, error: null });
  }, [owner]);
  useEffect(() => () => revokeAttachments(draftStateRef.current.draft.attachments), []);

  const setAttachments = useCallback((attachments: PendingAttachment[]) => {
    setDraftState((current) => {
      const currentDraft = workflowEvidenceDraftForOwner(current, owner);
      if (current.ownerKey !== owner) revokeAttachments(current.draft.attachments);
      const ids = new Set(attachments.map((item) => item.id));
      const metadata = Object.fromEntries(
        Object.entries(currentDraft.metadata).filter(([id]) => ids.has(id)),
      );
      for (const attachment of attachments) {
        metadata[attachment.id] ??= { caption: "", repositoryScope: defaultScope };
      }
      return { ownerKey: owner, draft: { attachments, metadata } };
    });
  }, [defaultScope, owner]);

  const update = useCallback((
    id: string,
    patch: Partial<WorkflowEvidenceDraft["metadata"][string]>,
  ) => {
    setDraftState((current) => current.ownerKey !== owner
      ? current
      : ({
          ...current,
          draft: {
            ...current.draft,
            metadata: {
              ...current.draft.metadata,
              [id]: { ...current.draft.metadata[id]!, ...patch },
            },
          },
        }));
  }, [owner]);

  const clear = useCallback(() => {
    setDraftState((current) => {
      revokeAttachments(current.draft.attachments);
      return { ownerKey: owner, draft: EMPTY_DRAFT };
    });
    setCoverageErrorState({ ownerKey: owner, error: null });
    loadStaged();
  }, [loadStaged, owner]);

  const removeStaged = useCallback((clientItemId: string) => {
    if (!owner || !requestPath || removingStaged.has(clientItemId)) return;
    setStagedState((current) => ({
      ownerKey: owner,
      staged: current.ownerKey === owner ? current.staged : EMPTY_STAGED,
      loading: current.ownerKey === owner ? current.loading : false,
      error: null,
    }));
    setRemovalState((current) => {
      const ids = current.ownerKey === owner ? new Set(current.ids) : new Set<string>();
      ids.add(clientItemId);
      return { ownerKey: owner, ids };
    });
    void workflowRequest(
      `${requestPath}/${encodeURIComponent(clientItemId)}`,
      { method: "DELETE" },
    ).then(() => {
      if (ownerRef.current !== owner) return;
      loadStaged();
      setRemovalState((current) => {
        if (current.ownerKey !== owner) return current;
        const ids = new Set(current.ids);
        ids.delete(clientItemId);
        return { ...current, ids };
      });
    }, (caught) => {
      if (ownerRef.current !== owner) return;
      setStagedState((current) => ({
        ownerKey: owner,
        staged: current.ownerKey === owner ? current.staged : EMPTY_STAGED,
        loading: false,
        error: caught instanceof Error ? caught.message : "Could not remove staged evidence",
      }));
      setRemovalState((current) => {
        if (current.ownerKey !== owner) return current;
        const ids = new Set(current.ids);
        ids.delete(clientItemId);
        return { ...current, ids };
      });
    });
  }, [loadStaged, owner, removingStaged, requestPath]);

  const saveCoverage = useCallback(async (claim: WorkflowEvidenceCoverageClaim) => {
    if (!owner || !requestPath) throw new Error("No live workflow evidence owner");
    setCoverageErrorState({ ownerKey: owner, error: null });
    try {
      const next = await workflowRequest<WorkflowStagedEvidenceList>(`${requestPath}/coverage`, {
        method: "POST",
        body: JSON.stringify(claim),
      });
      if (ownerRef.current !== owner) return;
      setStagedState({ ownerKey: owner, staged: next, loading: false, error: null });
    } catch (caught) {
      if (ownerRef.current === owner) {
        setCoverageErrorState({
          ownerKey: owner,
          error: caught instanceof Error ? caught.message : "Could not save criterion coverage",
        });
      }
      throw caught;
    }
  }, [owner, requestPath]);

  const removeCoverage = useCallback(async (clientCriterionId: string) => {
    if (!owner || !requestPath) throw new Error("No live workflow evidence owner");
    setCoverageErrorState({ ownerKey: owner, error: null });
    try {
      const next = await workflowRequest<WorkflowStagedEvidenceList>(
        `${requestPath}/coverage/${encodeURIComponent(clientCriterionId)}`,
        { method: "DELETE" },
      );
      if (ownerRef.current !== owner) return;
      setStagedState({ ownerKey: owner, staged: next, loading: false, error: null });
    } catch (caught) {
      if (ownerRef.current === owner) {
        setCoverageErrorState({
          ownerKey: owner,
          error: caught instanceof Error ? caught.message : "Could not remove criterion coverage",
        });
      }
      throw caught;
    }
  }, [owner, requestPath]);

  return {
    draft,
    setAttachments,
    update,
    staged: currentStaged.staged,
    stagedLoading: currentStaged.loading || removingStaged.size > 0,
    stagedError: currentStaged.error,
    coverageError,
    removingStaged,
    refreshStaged: loadStaged,
    removeStaged,
    saveCoverage,
    removeCoverage,
    clear,
  };
}

export interface WorkflowEvidenceSubmission {
  ready: boolean;
  errors: string[];
  locators: WorkflowUploadEvidenceLocator[];
  imageCount: number;
  aggregateBytes: number;
}

/** Pure so request-body and blocked-state contracts can be pinned without a browser DOM. */
export function workflowEvidenceSubmission(
  controller: Pick<
    WorkflowEvidenceDraftController,
    "draft" | "staged" | "stagedLoading" | "stagedError"
  >,
  scopes: readonly WorkflowEvidenceScopeOption[],
): WorkflowEvidenceSubmission {
  const { draft, staged, stagedLoading, stagedError } = controller;
  const errors: string[] = [];
  const allowedScopes = new Set(scopes.map((scope) => scope.value));
  if (stagedLoading) errors.push("Waiting for registered evidence to load.");
  if (stagedError) errors.push(`Registered evidence is unavailable: ${stagedError}`);
  const uploading = draft.attachments.filter((item) => item.status === "uploading").length;
  if (uploading > 0) errors.push(`${uploading} image upload${uploading === 1 ? " is" : "s are"} still pending.`);
  const failed = draft.attachments.filter((item) => item.status === "error").length;
  if (failed > 0) errors.push(`${failed} image upload${failed === 1 ? " failed" : "s failed"}.`);

  const locators = draft.attachments.flatMap<WorkflowUploadEvidenceLocator>((item) => {
    const metadata = draft.metadata[item.id];
    if (!metadata?.caption.trim()) errors.push(`${item.name} needs a caption.`);
    if ((metadata?.caption.length ?? 0) > WORKFLOW_IMAGE_LIMITS.captionChars) {
      errors.push(`${item.name}'s caption is longer than ${WORKFLOW_IMAGE_LIMITS.captionChars} characters.`);
    }
    if (!metadata || !allowedScopes.has(metadata.repositoryScope)) {
      errors.push(`${item.name} needs a repository scope.`);
    }
    if (item.status !== "ready") return [];
    if (!item.uploadId || !item.bytes) {
      errors.push(`${item.name} has no valid daemon upload locator.`);
      return [];
    }
    if (item.bytes > WORKFLOW_IMAGE_LIMITS.maxBytesPerImage) {
      errors.push(`${item.name} is larger than 5 MiB.`);
    }
    if (
      !metadata?.caption.trim()
      || metadata.caption.length > WORKFLOW_IMAGE_LIMITS.captionChars
      || !allowedScopes.has(metadata.repositoryScope)
    ) return [];
    return [{
      kind: "upload",
      clientItemId: item.id,
      uploadId: item.uploadId,
      caption: metadata.caption.trim(),
      repositoryScope: metadata.repositoryScope,
    }];
  });
  const imageCount = staged.images.length + draft.attachments.length;
  const aggregateBytes = staged.images.reduce((total, item) => total + item.bytes, 0)
    + draft.attachments.reduce((total, item) => total + (item.bytes ?? 0), 0);
  if (imageCount > WORKFLOW_IMAGE_LIMITS.maxCount) {
    errors.push(`At most ${WORKFLOW_IMAGE_LIMITS.maxCount} images can be submitted.`);
  }
  if (aggregateBytes > WORKFLOW_IMAGE_LIMITS.maxAggregateBytes) {
    errors.push("The evidence packet is larger than 20 MiB.");
  }
  return {
    ready: errors.length === 0,
    errors: [...new Set(errors)],
    locators,
    imageCount,
    aggregateBytes,
  };
}

const PROOF_CLASS_LABELS: Record<WorkflowEvidenceProofClass, string> = {
  focused_execution: "Focused execution",
  integration: "Integration",
  visual: "Visual",
  performance: "Performance",
  rendered_artifact: "Rendered artifact",
  state_confirmation: "State confirmation",
};

const PROOF_ROLE_LABELS: Record<WorkflowEvidenceProofRole, string> = {
  execution: "Execution evidence",
  rendered_output: "Rendered output",
  baseline_measurement: "Baseline measurement",
  result_measurement: "Result measurement",
  deliverable: "Deliverable",
  state_snapshot: "State snapshot",
};

interface CoverageDraft {
  clientCriterionId: string;
  criterion: string;
  proofClass: WorkflowEvidenceProofClass;
  repositoryScope: WorkflowEvidenceRepositoryScope;
  selections: Record<number, string>;
  preservedLinks: WorkflowEvidenceCoverageLink[];
}

function blankCoverageDraft(scope: WorkflowEvidenceRepositoryScope): CoverageDraft {
  return {
    clientCriterionId: `criterion-${crypto.randomUUID()}`,
    criterion: "",
    proofClass: "focused_execution",
    repositoryScope: scope,
    selections: {},
    preservedLinks: [],
  };
}

function CoverageComposer({
  controller,
  scopes,
  disabled,
}: {
  controller: WorkflowEvidenceDraftController;
  scopes: readonly WorkflowEvidenceScopeOption[];
  disabled: boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState<CoverageDraft>(() => blankCoverageDraft(scopes[0]?.value ?? "repo-01"));
  const [saving, setSaving] = useState(false);
  const evidence = [
    ...controller.staged.artifacts.map((item) => ({
      clientItemId: item.clientItemId,
      label: `${item.displayName} (${item.sourceKind})`,
    })),
    ...controller.staged.images.map((item) => ({
      clientItemId: item.clientItemId,
      label: `${item.displayName} (${item.sourceKind})`,
    })),
  ];
  const requiredGroups = workflowEvidenceRequiredRoleGroups(draft.proofClass);
  const selectedLinks = requiredGroups.flatMap((roles, index) => {
    const selection = draft.selections[index];
    if (!selection) return [];
    const splitAt = selection.indexOf(":");
    return [{
      role: selection.slice(0, splitAt) as WorkflowEvidenceProofRole,
      clientItemId: selection.slice(splitAt + 1),
    }];
  });
  const seenLinks = new Set<string>();
  const links = [...selectedLinks, ...draft.preservedLinks].filter((link) => {
    const key = `${link.clientItemId}\0${link.role}`;
    if (seenLinks.has(key)) return false;
    seenLinks.add(key);
    return true;
  });
  const gaps = workflowEvidenceMissingRoleGaps(draft.proofClass, links.map((link) => link.role));
  const edit = (claim: WorkflowEvidenceCoverageClaim): void => {
    const groups = workflowEvidenceRequiredRoleGroups(claim.proofClass);
    const selectedKeys = new Set<string>();
    const selections = Object.fromEntries(groups.flatMap((roles, index) => {
      const link = claim.links.find((candidate) => roles.includes(candidate.role));
      if (!link) return [];
      selectedKeys.add(`${link.clientItemId}\0${link.role}`);
      return [[index, `${link.role}:${link.clientItemId}`]];
    }));
    setDraft({
      clientCriterionId: claim.clientCriterionId,
      criterion: claim.criterion,
      proofClass: claim.proofClass,
      repositoryScope: claim.repositoryScope,
      selections,
      preservedLinks: claim.links.filter(
        (link) => !selectedKeys.has(`${link.clientItemId}\0${link.role}`),
      ),
    });
  };
  const save = async (): Promise<void> => {
    if (!draft.criterion.trim() || saving) return;
    setSaving(true);
    try {
      await controller.saveCoverage({
        clientCriterionId: draft.clientCriterionId,
        criterion: draft.criterion.trim(),
        proofClass: draft.proofClass,
        repositoryScope: draft.repositoryScope,
        links,
      });
      setDraft(blankCoverageDraft(scopes[0]?.value ?? "repo-01"));
    } catch {
      // The controller publishes the bounded daemon error beside the composer.
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="workflow-coverage-composer">
      <div className="workflow-evidence-registered-head">
        <strong>Acceptance criteria coverage</strong>
        <span>{controller.staged.coverage?.length ?? 0} saved</span>
      </div>
      {controller.coverageError && <p role="alert">{controller.coverageError}</p>}
      {(controller.staged.coverage ?? []).map((claim) => (
        <article className="workflow-coverage-claim" key={claim.clientCriterionId}>
          <div>
            <strong>{claim.criterion}</strong>
            <small>{PROOF_CLASS_LABELS[claim.proofClass]} · {claim.repositoryScope} · {claim.links.length} link{claim.links.length === 1 ? "" : "s"}</small>
          </div>
          <Tooltip label={`Edit coverage for ${claim.criterion}`}>
            <button type="button" className="text-btn" disabled={disabled || saving} onClick={() => edit(claim)}>Edit</button>
          </Tooltip>
          <Tooltip label={`Remove coverage for ${claim.criterion}`}>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove criterion mapping ${claim.criterion}`}
              disabled={disabled || saving}
              onClick={() => void controller.removeCoverage(claim.clientCriterionId).catch(() => undefined)}
            >
              ✕
            </button>
          </Tooltip>
        </article>
      ))}
      <div className="workflow-coverage-fields">
        <label>
          Acceptance criterion
          <textarea
            value={draft.criterion}
            placeholder="What must be true for this work to be accepted?"
            maxLength={4_000}
            disabled={disabled || saving}
            onChange={(event) => setDraft((current) => ({ ...current, criterion: event.target.value }))}
          />
        </label>
        <label>
          Proof class
          <Tooltip label="Choose the structural proof required for this criterion">
            <select
              aria-label="Proof class for acceptance criterion"
              value={draft.proofClass}
              disabled={disabled || saving}
              onChange={(event) => setDraft((current) => ({
                ...current,
                proofClass: event.target.value as WorkflowEvidenceProofClass,
                selections: {},
              }))}
            >
              {WORKFLOW_EVIDENCE_PROOF_CLASSES.map((proofClass) => (
                <option key={proofClass} value={proofClass}>{PROOF_CLASS_LABELS[proofClass]}</option>
              ))}
            </select>
          </Tooltip>
        </label>
        <label>
          Repository scope
          <Tooltip label="Choose which issued repository this criterion covers">
            <select
              aria-label="Repository scope for acceptance criterion"
              value={draft.repositoryScope}
              disabled={disabled || saving}
              onChange={(event) => setDraft((current) => ({
                ...current,
                repositoryScope: event.target.value as WorkflowEvidenceRepositoryScope,
              }))}
            >
              {scopes.map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}
            </select>
          </Tooltip>
        </label>
        {requiredGroups.map((roles, index) => (
          <label key={roles.join("-")}>
            {roles.map((role) => PROOF_ROLE_LABELS[role]).join(" or ")}
            <Tooltip label="Link registered evidence in the required proof role">
              <select
                aria-label={`${roles.map((role) => PROOF_ROLE_LABELS[role]).join(" or ")} for acceptance criterion`}
                value={draft.selections[index] ?? ""}
                disabled={disabled || saving}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  selections: { ...current.selections, [index]: event.target.value },
                }))}
              >
                <option value="">Not linked yet</option>
                {roles.flatMap((role) => evidence.map((item) => (
                  <option key={`${role}:${item.clientItemId}`} value={`${role}:${item.clientItemId}`}>
                    {roles.length > 1 ? `${PROOF_ROLE_LABELS[role]}: ` : ""}{item.label}
                  </option>
                )))}
              </select>
            </Tooltip>
          </label>
        ))}
      </div>
      {gaps.length > 0 && (
        <p className="workflow-coverage-gaps" role="status">
          Provisional gaps: {gaps.map((gap) => gap.replaceAll("_", " ")).join(", ")}.
        </p>
      )}
      {draft.proofClass === "focused_execution" && (
        <p className="workflow-coverage-hint">Focused execution requires execution evidence only. A screenshot is not requested.</p>
      )}
      <div className="workflow-coverage-actions">
        <Tooltip label="Save this criterion and its current evidence links">
          <button
            type="button"
            className="btn"
            disabled={disabled || saving || !draft.criterion.trim()}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save criterion mapping"}
          </button>
        </Tooltip>
        <small>Incomplete mappings can be saved. Canonical reconciliation happens during capture and remains advisory in this phase.</small>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function WorkflowEvidenceComposer({
  controller,
  scopes,
  disabled = false,
}: {
  controller: WorkflowEvidenceDraftController;
  scopes: readonly WorkflowEvidenceScopeOption[];
  disabled?: boolean;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const submission = useMemo(
    () => workflowEvidenceSubmission(controller, scopes),
    [controller, scopes],
  );
  const drop = useImageDrop({
    attachments: controller.draft.attachments,
    onChange: controller.setAttachments,
    disabled,
  });
  const registeredCount = controller.staged.images.length + controller.staged.artifacts.length;
  const linkedEvidenceIds = new Set(
    (controller.staged.coverage ?? []).flatMap((claim) =>
      claim.links.map((link) => link.clientItemId)),
  );
  return (
    <section
      className={`workflow-evidence-composer${drop.dropping ? " is-dropping" : ""}`}
      aria-label="Workflow evidence"
      {...drop.dropProps}
      onPaste={drop.onPaste}
    >
      <div className="workflow-evidence-heading">
        <div>
          <p className="workflow-eyebrow">Evidence packet</p>
          <h3>Show reviewers what the diff cannot</h3>
        </div>
        <span className="workflow-evidence-freeze">
          {submission.imageCount} / {WORKFLOW_IMAGE_LIMITS.maxCount} images · {formatBytes(submission.aggregateBytes)}
        </span>
      </div>
      <Tooltip label="Add screenshots to this workflow evidence packet">
        <button
          type="button"
          className="workflow-evidence-drop"
          disabled={disabled || submission.imageCount >= WORKFLOW_IMAGE_LIMITS.maxCount}
          onClick={() => inputRef.current?.click()}
        >
          <span aria-hidden="true">＋</span>
          <strong>Drop, paste, or choose screenshots</strong>
          <small>PNG, JPEG, static GIF, or WebP · 5 MiB each · 20 MiB total</small>
        </button>
      </Tooltip>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        aria-label="Choose workflow evidence images"
        onChange={(event) => {
          drop.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      <AttachmentStrip
        attachments={controller.draft.attachments}
        onRemove={drop.remove}
        removeContext="this evidence packet"
      />

      {controller.draft.attachments.length > 0 && (
        <ol className="workflow-evidence-draft-list">
          {controller.draft.attachments.map((item) => {
            const metadata = controller.draft.metadata[item.id];
            return (
              <li key={item.id} className={`workflow-evidence-draft is-${item.status}`}>
                <div className="workflow-evidence-fields">
                  <div className="workflow-evidence-fileline">
                    <strong>{item.name}</strong>
                    <span>{item.status === "uploading" ? "Uploading" : item.status === "error" ? "Failed" : formatBytes(item.bytes ?? 0)}</span>
                  </div>
                  {item.status === "error" && <p role="alert">{item.error}</p>}
                  <label>
                    Caption
                    <input
                      value={metadata?.caption ?? ""}
                      maxLength={WORKFLOW_IMAGE_LIMITS.captionChars}
                      placeholder="What should the reviewer inspect?"
                      aria-label={`Caption for ${item.name}`}
                      onChange={(event) => controller.update(item.id, { caption: event.target.value })}
                    />
                  </label>
                  <Tooltip label={`Choose which repository ${item.name} documents`}>
                    <label>
                      Repository scope
                      <select
                        value={metadata?.repositoryScope ?? scopes[0]?.value ?? "repo-01"}
                        aria-label={`Repository scope for ${item.name}`}
                        onChange={(event) => controller.update(item.id, {
                          repositoryScope: event.target.value as WorkflowEvidenceRepositoryScope,
                        })}
                      >
                        {scopes.map((scope) => (
                          <option key={scope.value} value={scope.value}>{scope.label}</option>
                        ))}
                      </select>
                    </label>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {(controller.stagedLoading || controller.stagedError || registeredCount > 0) && (
        <div className="workflow-evidence-registered">
          <div className="workflow-evidence-registered-head">
            <strong>Registered by the session</strong>
            <span>{controller.stagedLoading ? "Checking…" : `${registeredCount} item${registeredCount === 1 ? "" : "s"}`}</span>
          </div>
          {controller.stagedError && (
            <p role="alert">
              {controller.stagedError}{" "}
              <Tooltip label="Try loading the session's registered evidence again">
                <button type="button" className="text-btn" onClick={controller.refreshStaged}>Retry</button>
              </Tooltip>
            </p>
          )}
          {controller.staged.images.map((item) => {
            const removing = controller.removingStaged.has(item.clientItemId);
            const linked = linkedEvidenceIds.has(item.clientItemId);
            return (
              <div key={item.clientItemId} className="workflow-evidence-registered-item">
                <span className="workflow-evidence-source">{item.sourceKind}</span>
                <div>
                  <strong>{item.displayName}</strong>
                  <p>{item.caption}</p>
                  <small>{item.repositoryScope} · {item.mimeType} · {formatBytes(item.bytes)}</small>
                </div>
                <Tooltip label={linked
                  ? `Remove criterion links before removing ${item.displayName}`
                  : `Remove ${item.displayName} from the next workflow submission`}>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove registered image ${item.displayName}`}
                    disabled={disabled || removing || linked}
                    onClick={() => controller.removeStaged(item.clientItemId)}
                  >
                    {removing ? "…" : "✕"}
                  </button>
                </Tooltip>
              </div>
            );
          })}
          {controller.staged.artifacts.length > 0 && (
            <p className="workflow-evidence-artifacts">
              {controller.staged.artifacts.length} registered text artifact{controller.staged.artifacts.length === 1 ? "" : "s"} will be frozen with this submission.
            </p>
          )}
        </div>
      )}

      <CoverageComposer controller={controller} scopes={scopes} disabled={disabled} />

      {submission.errors.length > 0 && (
        <ul className="workflow-evidence-errors" aria-label="Evidence requirements">
          {submission.errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      )}
      <p className="workflow-evidence-note">
        The count, captions, scopes, and exact bytes are frozen when you submit. They remain attached to that submission's audit history.
      </p>
    </section>
  );
}
