import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import {
  WORKFLOW_IMAGE_LIMITS,
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
  removingStaged: ReadonlySet<string>;
  refreshStaged: () => void;
  removeStaged: (clientItemId: string) => void;
  clear: () => void;
}

const EMPTY_DRAFT: WorkflowEvidenceDraft = { attachments: [], metadata: {} };
const EMPTY_STAGED: WorkflowStagedEvidenceList = { generation: 0, images: [], artifacts: [] };
const EMPTY_REMOVING = new Set<string>();

export interface OwnedWorkflowEvidenceDraft {
  bindingId: string | null;
  draft: WorkflowEvidenceDraft;
}

/** A new binding sees an empty draft on its first render, before effects have a chance to run. */
export function workflowEvidenceDraftForBinding(
  state: OwnedWorkflowEvidenceDraft,
  bindingId: string | null | undefined,
): WorkflowEvidenceDraft {
  return state.bindingId === (bindingId ?? null) ? state.draft : EMPTY_DRAFT;
}

/**
 * Own one capture draft outside any transient dialog. Closing a confirmation therefore keeps
 * thumbnails, captions, scopes, and the request's opaque upload ids ready for the next click.
 */
export function useWorkflowEvidenceDraft(
  bindingId: string | null | undefined,
  defaultScope: WorkflowEvidenceRepositoryScope,
): WorkflowEvidenceDraftController {
  const owner = bindingId ?? null;
  const [draftState, setDraftState] = useState<OwnedWorkflowEvidenceDraft>(() => ({
    bindingId: owner,
    draft: EMPTY_DRAFT,
  }));
  const draft = workflowEvidenceDraftForBinding(draftState, owner);
  const [stagedState, setStagedState] = useState<{
    bindingId: string | null;
    staged: WorkflowStagedEvidenceList;
    loading: boolean;
    error: string | null;
  }>(() => ({
    bindingId: owner,
    staged: EMPTY_STAGED,
    loading: Boolean(owner),
    error: null,
  }));
  const currentStaged = stagedState.bindingId === owner
    ? stagedState
    : { bindingId: owner, staged: EMPTY_STAGED, loading: Boolean(owner), error: null };
  const [removalState, setRemovalState] = useState<{
    bindingId: string | null;
    ids: Set<string>;
  }>(() => ({ bindingId: owner, ids: new Set() }));
  const removingStaged = removalState.bindingId === owner
    ? removalState.ids
    : EMPTY_REMOVING;
  const generation = useRef(0);
  const bindingRef = useRef(owner);
  bindingRef.current = owner;
  const draftStateRef = useRef(draftState);
  draftStateRef.current = draftState;

  const loadStaged = useCallback(() => {
    const mine = ++generation.current;
    if (!owner) {
      setStagedState({ bindingId: owner, staged: EMPTY_STAGED, loading: false, error: null });
      return;
    }
    setStagedState((current) => ({
      bindingId: owner,
      staged: current.bindingId === owner ? current.staged : EMPTY_STAGED,
      loading: true,
      error: null,
    }));
    void workflowRequest<WorkflowStagedEvidenceList>(
      `/api/workflow-bindings/${encodeURIComponent(owner)}/evidence`,
    ).then(
      (next) => {
        if (generation.current !== mine || bindingRef.current !== owner) return;
        setStagedState({ bindingId: owner, staged: next, loading: false, error: null });
      },
      (caught) => {
        if (generation.current !== mine || bindingRef.current !== owner) return;
        setStagedState({
          bindingId: owner,
          staged: EMPTY_STAGED,
          loading: false,
          error: caught instanceof Error ? caught.message : "Could not load staged evidence",
        });
      },
    );
  }, [owner]);

  useEffect(() => {
    loadStaged();
    return () => { generation.current++; };
  }, [loadStaged]);
  useEffect(() => {
    setDraftState((current) => {
      if (current.bindingId === owner) return current;
      revokeAttachments(current.draft.attachments);
      return { bindingId: owner, draft: EMPTY_DRAFT };
    });
    setRemovalState((current) => current.bindingId === owner
      ? current
      : { bindingId: owner, ids: new Set() });
  }, [owner]);
  useEffect(() => () => revokeAttachments(draftStateRef.current.draft.attachments), []);

  const setAttachments = useCallback((attachments: PendingAttachment[]) => {
    setDraftState((current) => {
      const currentDraft = workflowEvidenceDraftForBinding(current, owner);
      if (current.bindingId !== owner) revokeAttachments(current.draft.attachments);
      const ids = new Set(attachments.map((item) => item.id));
      const metadata = Object.fromEntries(
        Object.entries(currentDraft.metadata).filter(([id]) => ids.has(id)),
      );
      for (const attachment of attachments) {
        metadata[attachment.id] ??= { caption: "", repositoryScope: defaultScope };
      }
      return { bindingId: owner, draft: { attachments, metadata } };
    });
  }, [defaultScope, owner]);

  const update = useCallback((
    id: string,
    patch: Partial<WorkflowEvidenceDraft["metadata"][string]>,
  ) => {
    setDraftState((current) => current.bindingId !== owner
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
      return { bindingId: owner, draft: EMPTY_DRAFT };
    });
    loadStaged();
  }, [loadStaged, owner]);

  const removeStaged = useCallback((clientItemId: string) => {
    if (!owner || removingStaged.has(clientItemId)) return;
    setStagedState((current) => ({
      bindingId: owner,
      staged: current.bindingId === owner ? current.staged : EMPTY_STAGED,
      loading: current.bindingId === owner ? current.loading : false,
      error: null,
    }));
    setRemovalState((current) => {
      const ids = current.bindingId === owner ? new Set(current.ids) : new Set<string>();
      ids.add(clientItemId);
      return { bindingId: owner, ids };
    });
    void workflowRequest(
      `/api/workflow-bindings/${encodeURIComponent(owner)}/evidence/${encodeURIComponent(clientItemId)}`,
      { method: "DELETE" },
    ).then(() => {
      if (bindingRef.current !== owner) return;
      loadStaged();
      setRemovalState((current) => {
        if (current.bindingId !== owner) return current;
        const ids = new Set(current.ids);
        ids.delete(clientItemId);
        return { ...current, ids };
      });
    }, (caught) => {
      if (bindingRef.current !== owner) return;
      setStagedState((current) => ({
        bindingId: owner,
        staged: current.bindingId === owner ? current.staged : EMPTY_STAGED,
        loading: false,
        error: caught instanceof Error ? caught.message : "Could not remove staged evidence",
      }));
      setRemovalState((current) => {
        if (current.bindingId !== owner) return current;
        const ids = new Set(current.ids);
        ids.delete(clientItemId);
        return { ...current, ids };
      });
    });
  }, [loadStaged, owner, removingStaged]);

  return {
    draft,
    setAttachments,
    update,
    staged: currentStaged.staged,
    stagedLoading: currentStaged.loading || removingStaged.size > 0,
    stagedError: currentStaged.error,
    removingStaged,
    refreshStaged: loadStaged,
    removeStaged,
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
  return (
    <section
      className={`workflow-evidence-composer${drop.dropping ? " is-dropping" : ""}`}
      aria-label="Image evidence"
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
            return (
              <div key={item.clientItemId} className="workflow-evidence-registered-item">
                <span className="workflow-evidence-source">{item.sourceKind}</span>
                <div>
                  <strong>{item.displayName}</strong>
                  <p>{item.caption}</p>
                  <small>{item.repositoryScope} · {item.mimeType} · {formatBytes(item.bytes)}</small>
                </div>
                <Tooltip label={`Remove ${item.displayName} from the next workflow submission`}>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove registered image ${item.displayName}`}
                    disabled={disabled || removing}
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
