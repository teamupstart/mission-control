import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FOREMAN_MODEL_ROLES, FOREMAN_MODEL_SPECS } from "@shared/foreman-models.ts";
import {
  FOREMAN_INSTRUCTIONS_MAX_LENGTH,
} from "@shared/protocol.ts";
import type { ForemanInstructionsView } from "@shared/protocol.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  LibraryPropertyChip,
  LibraryPropertyChips,
} from "../library/LibraryPropertyChip.tsx";
import {
  LibraryWorkspaceHeader,
  type LibraryMenuAction,
  type LibraryPrimaryAction,
} from "../library/LibraryWorkspaceHeader.tsx";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import {
  FOREMAN_PROFILE_DESCRIPTION,
  foremanInstructionsSourceLabel,
  foremanProviderLabel,
  type ForemanProfileSummary,
} from "../lib/foreman-profile.ts";
import { WorkflowConfirmModal, type WorkflowConfirmRequest } from "./WorkflowConfirmModal.tsx";
import {
  fetchForemanProfile,
  ForemanProfileRequestError,
  foremanMarkdownBlob,
  updateForemanProfile,
} from "./foremanProfileApi.ts";

export interface ForemanProfileDraftState {
  loaded: ForemanInstructionsView;
  draft: string;
  dirty: boolean;
  conflict: ForemanInstructionsView | null;
}

/** Reconcile a completed CAS mutation without dropping edits made while it was in flight. */
export function reconcileForemanProfileMutation(
  saved: ForemanInstructionsView,
  currentDraft: string,
  submittedGeneration: number,
  currentGeneration: number,
): ForemanProfileDraftState {
  if (submittedGeneration === currentGeneration) {
    return { loaded: saved, draft: saved.text, dirty: false, conflict: null };
  }
  return { loaded: saved, draft: currentDraft, dirty: true, conflict: null };
}

/** Apply a focus refresh using the exact loaded ETag as the clean/dirty boundary. */
export function reconcileForemanProfileRefresh(
  state: ForemanProfileDraftState,
  current: ForemanInstructionsView,
): ForemanProfileDraftState {
  if (current.etag === state.loaded.etag) {
    return { ...state, loaded: current };
  }
  if (state.dirty) return { ...state, conflict: current };
  return { loaded: current, draft: current.text, dirty: false, conflict: null };
}

export function keepEditingForemanProfile(
  state: ForemanProfileDraftState,
): ForemanProfileDraftState {
  return state.conflict
    ? { loaded: state.conflict, draft: state.draft, dirty: true, conflict: null }
    : state;
}

export function reloadForemanProfile(
  state: ForemanProfileDraftState,
): ForemanProfileDraftState {
  return state.conflict
    ? { loaded: state.conflict, draft: state.conflict.text, dirty: false, conflict: null }
    : state;
}

export function isForemanProfileSaveShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">,
  overlayOpen: boolean,
): boolean {
  return !overlayOpen && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
}

export function foremanProfileLineSeparator(markdown: string): "\r\n" | "\r" | "\n" {
  return (markdown.match(/\r\n|\r|\n/)?.[0] ?? "\n") as "\r\n" | "\r" | "\n";
}

export function foremanProfileOverflowActions({
  loaded,
  dirty,
  conflicted,
  copyLabel,
  onCopy,
  onDownload,
  onReset,
}: {
  loaded: ForemanInstructionsView | null;
  dirty: boolean;
  conflicted: boolean;
  copyLabel: string;
  onCopy: () => void;
  onDownload: () => void;
  onReset: () => void;
}): LibraryMenuAction[] {
  const unavailable = loaded === null;
  const resetDisabled = loaded === null
    || conflicted
    || (loaded.source === "builtin" && !dirty);
  return [
    {
      id: "copy",
      label: copyLabel,
      hint: "Copy the exact local standing-guidance Markdown",
      disabled: unavailable,
      keepOpen: true,
      onSelect: onCopy,
    },
    {
      id: "download",
      label: "Download FOREMAN.md",
      hint: "Download the exact local standing-guidance Markdown as FOREMAN.md",
      disabled: unavailable,
      onSelect: onDownload,
    },
    {
      id: "reset",
      label: "Reset to built-in default",
      hint: unavailable
        ? "Wait for the standing guidance to load"
        : conflicted
          ? "Resolve the newer standing guidance before resetting"
          : loaded.source === "builtin" && !dirty
            ? "Already using the built-in default"
            : "Discard the current saved state and restore the shipped FOREMAN.md",
      disabled: resetDisabled,
      danger: true,
      onSelect: onReset,
    },
  ];
}

export function foremanProfileSaveDisabled({
  loaded,
  saving,
  dirty,
  conflicted,
  draftLength,
}: {
  loaded: boolean;
  saving: boolean;
  dirty: boolean;
  conflicted: boolean;
  draftLength: number;
}): boolean {
  return !loaded
    || saving
    || !dirty
    || conflicted
    || draftLength > FOREMAN_INSTRUCTIONS_MAX_LENGTH;
}

export function foremanProfileResetRequest(
  onConfirm: () => void,
): WorkflowConfirmRequest {
  return {
    title: "Reset Foreman standing guidance",
    body: "This discards the current saved state and any unsaved edits, then restores the shipped FOREMAN.md. Clearing and saving is different: it keeps an intentional No standing guidance state.",
    confirmLabel: "Reset to built-in default",
    confirmHint: "Discard the current state and restore the shipped FOREMAN.md",
    closeHint: "Close and keep the current Foreman standing guidance (Escape)",
    cancelHint: "Keep the current Foreman standing guidance",
    danger: true,
    onConfirm,
  };
}

function ProfileLink({
  children,
  onClick,
}: {
  children: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <Tooltip label={children}>
      <button type="button" className="btn btn-ghost" onClick={onClick}>{children}</button>
    </Tooltip>
  );
}

export function ForemanProfileEditor({
  summary,
  isOverlayOpen,
  onDirtyChange,
  onOpenModels,
  onOpenPosture,
  onOpenTrust,
  onOpenForemanControl,
}: {
  summary: ForemanProfileSummary;
  isOverlayOpen: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
  onOpenModels: () => void;
  onOpenPosture: () => void;
  onOpenTrust: () => void;
  onOpenForemanControl: () => void;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<ForemanInstructionsView | null>(null);
  const loadedRef = useRef<ForemanInstructionsView | null>(null);
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const editGeneration = useRef(0);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ForemanInstructionsView | null>(null);
  const conflictRef = useRef<ForemanInstructionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"editor" | "preview">("editor");
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const copy = useCopyFeedback({ resetOn: loaded?.etag ?? "loading" });
  const refreshSequence = useRef(0);

  const setLoadedView = useCallback((view: ForemanInstructionsView): void => {
    loadedRef.current = view;
    setLoaded(view);
  }, []);

  const setDraftState = useCallback((text: string, nextDirty: boolean): void => {
    draftRef.current = text;
    dirtyRef.current = nextDirty;
    setDraft(text);
    setDirty(nextDirty);
  }, []);

  const setConflictView = useCallback((view: ForemanInstructionsView | null): void => {
    conflictRef.current = view;
    setConflict(view);
  }, []);

  const adoptState = useCallback((state: ForemanProfileDraftState): void => {
    setLoadedView(state.loaded);
    setDraftState(state.draft, state.dirty);
    setConflictView(state.conflict);
  }, [setConflictView, setDraftState, setLoadedView]);

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++refreshSequence.current;
    try {
      const current = await fetchForemanProfile();
      if (request !== refreshSequence.current) return;
      const base = loadedRef.current;
      if (base === null) {
        adoptState({ loaded: current, draft: current.text, dirty: false, conflict: null });
      } else {
        adoptState(reconcileForemanProfileRefresh({
          loaded: base,
          draft: draftRef.current,
          dirty: dirtyRef.current,
          conflict: conflictRef.current,
        }, current));
      }
      setError(null);
    } catch (cause) {
      if (request !== refreshSequence.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load Foreman standing guidance");
    }
  }, [adoptState]);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  function edit(text: string): void {
    editGeneration.current += 1;
    setDraftState(text, true);
    setError(null);
  }

  async function mutate(kind: "save" | "reset"): Promise<void> {
    const base = loadedRef.current;
    if (!base || saving || conflictRef.current) return;
    const submittedGeneration = editGeneration.current;
    const submittedDraft = draftRef.current;
    setSaving(true);
    setError(null);
    try {
      const saved = await updateForemanProfile(kind === "reset"
        ? { expectedEtag: base.etag, reset: true }
        : { expectedEtag: base.etag, text: submittedDraft });
      adoptState(reconcileForemanProfileMutation(
        saved,
        draftRef.current,
        submittedGeneration,
        editGeneration.current,
      ));
    } catch (cause) {
      if (cause instanceof ForemanProfileRequestError && cause.conflict) {
        setConflictView(cause.conflict.current);
      } else {
        setError(cause instanceof Error ? cause.message : "Could not save Foreman standing guidance");
      }
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isForemanProfileSaveShortcut(event, isOverlayOpen())) return;
      event.preventDefault();
      if (
        loadedRef.current
        && dirtyRef.current
        && !conflictRef.current
        && draftRef.current.length <= FOREMAN_INSTRUCTIONS_MAX_LENGTH
      ) {
        void mutate("save");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function copyMarkdown(): void {
    setError(null);
    void copy.copy(() => draftRef.current).then(({ error: caught }) => {
      if (caught !== null) {
        setError(`Clipboard access was blocked, and the Markdown remains in the editor. ${caught}`);
      }
    });
  }

  function downloadMarkdown(): void {
    const url = URL.createObjectURL(foremanMarkdownBlob(draftRef.current));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "FOREMAN.md";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function reloadLatest(): void {
    const base = loadedRef.current;
    if (!base) return;
    adoptState(reloadForemanProfile({
      loaded: base,
      draft: draftRef.current,
      dirty: dirtyRef.current,
      conflict: conflictRef.current,
    }));
    setError(null);
  }

  function keepEditing(): void {
    const base = loadedRef.current;
    if (!base) return;
    adoptState(keepEditingForemanProfile({
      loaded: base,
      draft: draftRef.current,
      dirty: dirtyRef.current,
      conflict: conflictRef.current,
    }));
    setError(null);
  }

  function askReset(): void {
    if (!loadedRef.current) return;
    setConfirm(foremanProfileResetRequest(() => void mutate("reset")));
  }

  const overLimit = draft.length > FOREMAN_INSTRUCTIONS_MAX_LENGTH;
  const primary: LibraryPrimaryAction = {
    label: saving ? "Saving…" : "Save",
    hint: loaded === null
      ? "Wait for the standing guidance to load"
      : conflict
        ? "Resolve the newer standing guidance before saving"
        : overLimit
          ? "Standing guidance is over the character limit"
          : !dirty
            ? "No unsaved changes"
            : "Save exact standing-guidance Markdown",
    disabled: foremanProfileSaveDisabled({
      loaded: loaded !== null,
      saving,
      dirty,
      conflicted: conflict !== null,
      draftLength: draft.length,
    }),
    onClick: () => void mutate("save"),
  };
  const overflow = foremanProfileOverflowActions({
    loaded,
    dirty,
    conflicted: conflict !== null,
    copyLabel: copy.copied ? COPY_FEEDBACK_LABEL : "Copy Markdown",
    onCopy: copyMarkdown,
    onDownload: downloadMarkdown,
    onReset: askReset,
  });
  const lineSeparator = useMemo(() => foremanProfileLineSeparator(draft), [draft]);
  const source = loaded ? foremanInstructionsSourceLabel(loaded.source) : "Loading";
  const provider = foremanProviderLabel(summary);

  return (
    <article className="persona-editor foreman-profile-editor">
      <LibraryWorkspaceHeader
        className="persona-editor-head foreman-profile-head"
        title={(
          <div className="lib-work-name foreman-profile-name">
            <h2>Foreman</h2>
            <span className="lib-tag lib-tag-system">System profile</span>
            <span className="lib-tag lib-tag-boundary">Not available to workflows or ensembles</span>
          </div>
        )}
        subtitle={<p className="foreman-profile-description">{FOREMAN_PROFILE_DESCRIPTION}</p>}
        meta={(
          <div className="lib-work-meta">
            <p className="workflow-eyebrow">Application-owned identity · operator-owned guidance</p>
          </div>
        )}
        primary={primary}
        menuLabel="More Foreman profile actions"
        actions={overflow}
      />

      <p className="foreman-profile-boundary">
        Edit the exact standing guidance Foreman uses for judgment. Mission Control still owns
        Foreman&apos;s policy, safety checks, output contracts, and authority.
      </p>

      {conflict ? (
        <div className="persona-state conflict foreman-profile-conflict" role="alert">
          <span>
            Standing guidance changed in another window. Your local Markdown has not been changed.
          </span>
          <Tooltip label="Discard local edits and load the latest standing guidance">
            <button type="button" className="btn" onClick={reloadLatest}>Reload latest</button>
          </Tooltip>
          <Tooltip label="Keep every local byte and use the latest ETag for the next explicit Save">
            <button type="button" className="btn" onClick={keepEditing}>Keep editing</button>
          </Tooltip>
        </div>
      ) : dirty ? (
        <p className="persona-state dirty">Unsaved changes</p>
      ) : null}
      {error && <p className="persona-error" role="alert">{error}</p>}

      <LibraryPropertyChips>
        <LibraryPropertyChip
          name="source"
          value={source}
          tooltip="Whether the exact document is the shipped default, customized, or intentionally empty"
        />
        <LibraryPropertyChip
          name="provider"
          value={`${provider} · 4 model roles`}
          state="inherited"
          tooltip="Provider and model roles are configured in Settings, not in standing guidance"
          controlLabel="Foreman model summary"
        >
          {(close) => (
            <div className="foreman-profile-summary">
              <p>All four roles run through {provider}.</p>
              <dl>
                {FOREMAN_MODEL_ROLES.map((role) => (
                  <div key={role}>
                    <dt>{FOREMAN_MODEL_SPECS[role].label}</dt>
                    <dd className="mono">{summary.models?.[role].id ?? "waiting for status"}</dd>
                  </div>
                ))}
              </dl>
              <ProfileLink onClick={() => {
                close();
                onOpenModels();
              }}>
                Open Models settings
              </ProfileLink>
            </div>
          )}
        </LibraryPropertyChip>
        <LibraryPropertyChip
          name="authority"
          value="Top bar · Posture · Trust"
          state="inherited"
          tooltip="Operational posture and repository authority stay with their existing owners"
          controlLabel="Foreman authority owners"
        >
          {(close) => (
            <div className="foreman-profile-links">
              <p>Standing guidance cannot enable Foreman or grant repository access.</p>
              <ProfileLink onClick={() => {
                close();
                onOpenForemanControl();
              }}>
                Open top-bar Foreman control
              </ProfileLink>
              <ProfileLink onClick={() => {
                close();
                onOpenPosture();
              }}>
                Open Foreman posture
              </ProfileLink>
              <ProfileLink onClick={() => {
                close();
                onOpenTrust();
              }}>
                Open Trust
              </ProfileLink>
            </div>
          )}
        </LibraryPropertyChip>
        <LibraryPropertyChip
          name="characters"
          value={`${draft.length.toLocaleString()} / ${FOREMAN_INSTRUCTIONS_MAX_LENGTH.toLocaleString()}`}
          mono
          align="end"
          tone={overLimit ? "danger" : undefined}
          tooltip={overLimit
            ? "Standing guidance is over the character limit and cannot be saved"
            : "Exact JavaScript character count checked by the standing-guidance contract"}
        />
      </LibraryPropertyChips>

      <section className="persona-guidance foreman-profile-guidance" aria-label="Foreman standing guidance">
        <header className="file-toolbar persona-guidance-toolbar">
          <span className="file-path mono">FOREMAN.md</span>
          <span className="file-language">Markdown</span>
          <span className="file-toolbar-spacer" />
          <div className="file-mode" role="group" aria-label="Foreman standing guidance view">
            <Tooltip label="Edit the exact standing-guidance Markdown">
              <button
                className={mode === "editor" ? "on" : ""}
                aria-pressed={mode === "editor"}
                onClick={() => setMode("editor")}
              >
                Edit
              </button>
            </Tooltip>
            <Tooltip label="Render the standing guidance as Foreman reads it">
              <button
                className={mode === "preview" ? "on" : ""}
                aria-pressed={mode === "preview"}
                onClick={() => setMode("preview")}
              >
                Preview
              </button>
            </Tooltip>
          </div>
        </header>
        <div className="persona-guidance-content file-content">
          {loaded === null ? (
            <p className="foreman-profile-loading">Loading standing guidance…</p>
          ) : mode === "editor" ? (
            <div className="persona-editor-host" aria-label="Editor for FOREMAN.md">
              <FileEditor
                path="FOREMAN.md"
                value={draft}
                readOnly={false}
                lineSeparator={lineSeparator}
                onChange={edit}
                onBlur={() => {}}
              />
            </div>
          ) : (
            <article className="persona-markdown file-markdown-preview markdown">
              {draft ? <Markdown>{draft}</Markdown> : (
                <p>No standing guidance. Foreman uses its built-in policy without an operator overlay.</p>
              )}
            </article>
          )}
        </div>
      </section>

      {confirm && <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />}
    </article>
  );
}
