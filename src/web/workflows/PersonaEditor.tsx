import { useEffect, useMemo, useRef, useState } from "react";
import { isLlmRunnerId } from "@shared/llm.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import type { ResolvedModel } from "@shared/model-choice.ts";
import type { LlmProviderView } from "@shared/types.ts";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_PERSONA_MODEL_SPEC,
  normalizePersonaName,
} from "@shared/workflow.ts";
import type { PersonaDefaultsView, PersonaView } from "@shared/workflow.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ModelField, ModelSuggestions } from "../components/ModelField.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { personaMarkdownBlob, personaRequest } from "./personaApi.ts";

export interface PersonaDraftSeed {
  name: string;
  description: string;
  guidanceMarkdown: string;
  /** May carry a newer build's stored id until the operator deliberately changes it. */
  runner: string | null;
  model: string | null;
}

function fromPersona(persona: PersonaView): PersonaDraftSeed {
  return {
    name: persona.name,
    description: persona.description,
    guidanceMarkdown: persona.guidanceMarkdown,
    runner: persona.runner,
    model: persona.model,
  };
}

const PERSONA_DRAFT_FIELDS = ["name", "description", "guidanceMarkdown", "runner", "model"] as const;

export function reconcilePersonaSave(
  saved: PersonaView,
  submitted: PersonaDraftSeed,
  current: PersonaDraftSeed,
  submittedGeneration: number,
  currentGeneration: number,
): { draft: PersonaDraftSeed; dirty: boolean } {
  const savedDraft = fromPersona(saved);
  if (submittedGeneration === currentGeneration) return { draft: savedDraft, dirty: false };
  const draft: PersonaDraftSeed = {
    name: current.name !== submitted.name ? current.name : savedDraft.name,
    description: current.description !== submitted.description
      ? current.description
      : savedDraft.description,
    guidanceMarkdown: current.guidanceMarkdown !== submitted.guidanceMarkdown
      ? current.guidanceMarkdown
      : savedDraft.guidanceMarkdown,
    runner: current.runner !== submitted.runner ? current.runner : savedDraft.runner,
    model: current.model !== submitted.model ? current.model : savedDraft.model,
  };
  return {
    draft,
    dirty: PERSONA_DRAFT_FIELDS.some((field) => draft[field] !== savedDraft[field]),
  };
}

export function personaUpdatePatch(
  persona: PersonaView,
  draft: PersonaDraftSeed,
  expectedRevision: number,
): Record<string, unknown> {
  const original = fromPersona(persona);
  const patch: Record<string, unknown> = { expectedRevision };
  for (const field of PERSONA_DRAFT_FIELDS) {
    if (draft[field] !== original[field]) patch[field] = draft[field];
  }
  return patch;
}

function markdownPath(name: string): string {
  const slug = normalizePersonaName(name)
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]/gu, "");
  return `${slug || "persona"}.md`;
}

export function isPersonaSaveShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">,
  overlayOpen: boolean,
): boolean {
  return !overlayOpen && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
}

export function personaLineSeparator(markdown: string): "\r\n" | "\r" | "\n" {
  return (markdown.match(/\r\n|\r|\n/)?.[0] ?? "\n") as "\r\n" | "\r" | "\n";
}

function knownRunner(value: string | null): LlmRunnerId | null {
  return value !== null && isLlmRunnerId(value) ? value : null;
}

function providerLabel(providers: readonly LlmProviderView[], id: LlmRunnerId): string {
  return providers.find((provider) => provider.id === id)?.label ?? id;
}

export function projectPersonaDraftExecution(
  persona: PersonaView | null,
  draft: PersonaDraftSeed,
  defaults: PersonaDefaultsView | null,
): { runner: LlmRunnerId | null; model: ResolvedModel | undefined } {
  const selectedRunner = knownRunner(draft.runner);
  const unchanged = persona !== null && draft.runner === persona.runner && draft.model === persona.model;
  if (unchanged) {
    return { runner: persona.execution.runner.id, model: persona.execution.model };
  }
  const retainedUnknownRunner = persona !== null &&
      draft.runner === persona.runner &&
      persona.execution.runner.unknown !== null
    ? persona.execution.runner.id
    : null;
  const runner = selectedRunner ?? retainedUnknownRunner ?? defaults?.runner.id ??
    persona?.execution.runner.id ?? null;
  const model = draft.model !== null
    ? { id: draft.model, source: "config" as const }
    : runner === null
      ? undefined
      : defaults?.models[runner];
  return { runner, model };
}

export function PersonaEditorStatus({
  dirty,
  conflict,
  archived,
  builtin = false,
  onReload,
  onDuplicate,
  onDownload = () => {},
}: {
  dirty: boolean;
  conflict: PersonaView | null;
  archived: boolean;
  builtin?: boolean;
  onReload: () => void;
  onDuplicate: () => void;
  onDownload?: () => void;
}): React.JSX.Element | null {
  // Built-in first: it is the reason this editor is read-only, and an operator reading
  // "Archived" about a Persona they never archived would go looking for the wrong control.
  if (builtin) {
    return (
      <p className="persona-state builtin">
        Built-in - this Persona ships with Mission Control and always carries the guidance this
        build was made from. Duplicate it to make a copy you own and can edit.
      </p>
    );
  }
  if (archived) return <p className="persona-state archived">Archived - this Persona is read-only.</p>;
  if (conflict) {
    return (
      <div className="persona-state conflict" role="alert">
        <span>A newer revision exists. Your local Markdown has not been changed.</span>
        <Tooltip label="Download the exact local Markdown before resolving this conflict">
          <button className="btn" onClick={onDownload}>Download local draft</button>
        </Tooltip>
        <Tooltip label="Discard your unsaved edits and load the newer revision">
          <button className="btn" onClick={onReload}>Reload latest</button>
        </Tooltip>
        <Tooltip label="Keep your edits by saving them as a new Persona">
          <button className="btn" onClick={onDuplicate}>Save as duplicate</button>
        </Tooltip>
      </div>
    );
  }
  return dirty ? <p className="persona-state dirty">Unsaved changes</p> : null;
}

export function PersonaEditor({
  persona,
  seed,
  providers,
  defaults,
  isOverlayOpen,
  onDirtyChange,
  onDraftEdit,
  onSaved,
  onDuplicate,
  onArchive,
}: {
  persona: PersonaView | null;
  seed?: PersonaDraftSeed;
  providers: readonly LlmProviderView[];
  defaults: PersonaDefaultsView | null;
  isOverlayOpen: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDraftEdit: () => void;
  onSaved: (persona: PersonaView) => void;
  onDuplicate: (seed: PersonaDraftSeed) => void;
  onArchive: (persona: PersonaView) => void | Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState<PersonaDraftSeed>(() => persona ? fromPersona(persona) : seed ?? {
    name: "",
    description: "",
    guidanceMarkdown: "",
    runner: null,
    model: null,
  });
  const draftRef = useRef(draft);
  const editGeneration = useRef(0);
  const [loadedRevision, setLoadedRevision] = useState(persona?.revision ?? null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<PersonaView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [narrowPane, setNarrowPane] = useState<"edit" | "preview">("edit");
  const archived = persona?.archivedAt != null;
  const builtin = persona?.builtin === true;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // An SSE update for this Persona may arrive while the editor owns typed text. Clean drafts
  // follow it; dirty drafts freeze and surface an explicit conflict without replacing one byte.
  useEffect(() => {
    if (!persona || persona.revision === loadedRevision) return;
    if (dirty) {
      setConflict(persona);
      return;
    }
    const nextDraft = fromPersona(persona);
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setLoadedRevision(persona.revision);
    setConflict(null);
  }, [dirty, loadedRevision, persona]);

  const selectedRunner = knownRunner(draft.runner);
  const draftExecution = projectPersonaDraftExecution(persona, draft, defaults);
  const effectiveRunner = draftExecution.runner;
  const runnerForControls = selectedRunner ?? effectiveRunner ?? "claude";
  const effectiveModel = draftExecution.model;
  const exactBytes = useMemo(() => new TextEncoder().encode(draft.guidanceMarkdown).byteLength, [draft.guidanceMarkdown]);
  const lineSeparator = useMemo(
    () => personaLineSeparator(draft.guidanceMarkdown),
    [draft.guidanceMarkdown],
  );

  function edit(patch: Partial<PersonaDraftSeed>): void {
    const nextDraft = { ...draftRef.current, ...patch };
    editGeneration.current += 1;
    onDraftEdit();
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(true);
    setConflict(null);
    setError(null);
  }

  async function save(asDuplicate = false): Promise<void> {
    // A built-in has nothing to save: the daemon refuses the write, so stopping here keeps
    // Cmd+S from turning a read-only Persona into an error banner.
    if (archived || builtin || saving || (persona !== null && !dirty && !asDuplicate)) return;
    if (exactBytes > WORKFLOW_LIMITS.personaGuidanceBytes) {
      setError(`Persona guidance exceeds ${WORKFLOW_LIMITS.personaGuidanceBytes} UTF-8 bytes`);
      return;
    }
    const submittedDraft = draftRef.current;
    const submittedGeneration = editGeneration.current;
    const updateBody = persona ? personaUpdatePatch(persona, submittedDraft, loadedRevision!) : null;
    if (!asDuplicate && updateBody && Object.keys(updateBody).length === 1) {
      setDirty(false);
      setConflict(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const create = persona === null || asDuplicate;
      const name = asDuplicate ? `${submittedDraft.name || "Persona"} copy` : submittedDraft.name;
      const body = create
        ? { ...submittedDraft, name, runner: knownRunner(submittedDraft.runner) }
        : updateBody!;
      const saved = await personaRequest<PersonaView>(
        create ? "/api/personas" : `/api/personas/${persona.id}`,
        {
          method: create ? "POST" : "PATCH",
          body: JSON.stringify(body),
        },
      );
      const reconciled = reconcilePersonaSave(
        saved,
        submittedDraft,
        draftRef.current,
        submittedGeneration,
        editGeneration.current,
      );
      draftRef.current = reconciled.draft;
      setDraft(reconciled.draft);
      setLoadedRevision(saved.revision);
      setDirty(reconciled.dirty);
      setConflict(null);
      onSaved(saved);
    } catch (cause) {
      const known = cause as Error & {
        status?: number;
        body?: { code?: string; current?: PersonaView | null };
      };
      if (
        known.status === 409 &&
        known.body?.code === "persona_revision_conflict" &&
        known.body.current
      ) {
        setConflict(known.body.current);
      }
      setError(known.message || "Could not save Persona");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isPersonaSaveShortcut(event, isOverlayOpen())) {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function copyMarkdown(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draft.guidanceMarkdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Clipboard access was blocked. The Markdown remains in the editor.");
    }
  }

  function downloadMarkdown(): void {
    const url = URL.createObjectURL(personaMarkdownBlob(draft.guidanceMarkdown));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = markdownPath(draft.name);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function reload(): void {
    if (!conflict) return;
    const nextDraft = fromPersona(conflict);
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setLoadedRevision(conflict.revision);
    setDirty(false);
    setConflict(null);
    setError(null);
  }

  const readOnly = archived || builtin;
  const saveHint = builtin
    ? "Built-in Personas cannot be edited - use Duplicate"
    : archived
      ? "This Persona is archived and cannot be edited"
      : exactBytes > WORKFLOW_LIMITS.personaGuidanceBytes
        ? "Guidance is over the UTF-8 byte limit"
        : persona !== null && !dirty
          ? "No unsaved changes"
          : "Save this Persona as a new revision";
  return (
    <article className={`persona-editor${archived ? " is-archived" : ""}${builtin ? " is-builtin" : ""}`}>
      <header className="persona-editor-head">
        <div>
          <p className="workflow-eyebrow">
            {persona ? (builtin ? "Built-in Persona" : `Revision ${loadedRevision}`) : "New Persona"}
          </p>
          <h3>{draft.name || "Untitled Persona"}</h3>
        </div>
        <div className="persona-actions">
          <Tooltip label={saveHint}>
            <button className="btn" disabled={readOnly || saving || exactBytes > WORKFLOW_LIMITS.personaGuidanceBytes || (persona !== null && !dirty)} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
          </Tooltip>
          <Tooltip label="Copy this Persona's guidance markdown to the clipboard">
            <button className="btn btn-ghost" onClick={() => void copyMarkdown()}>{copied ? "Copied ✓" : "Copy Markdown"}</button>
          </Tooltip>
          <Tooltip label="Save this Persona's guidance to a markdown file">
            <button className="btn btn-ghost" onClick={downloadMarkdown}>Download .md</button>
          </Tooltip>
          {persona && (
            <Tooltip label={builtin ? "Start an editable copy of this built-in Persona" : "Copy this Persona into a new one"}>
              <button className="btn btn-ghost" onClick={() => onDuplicate({ ...draft, name: `${draft.name} copy` })}>Duplicate</button>
            </Tooltip>
          )}
          {persona && !archived && !builtin && (
            <Tooltip label="Archive this Persona - workflows already published keep their copy">
              <button className="btn btn-danger" onClick={() => void onArchive(persona)}>Archive</button>
            </Tooltip>
          )}
        </div>
      </header>

      <PersonaEditorStatus
        dirty={dirty}
        conflict={conflict}
        archived={archived}
        builtin={builtin}
        onReload={reload}
        onDuplicate={() => void save(true)}
        onDownload={downloadMarkdown}
      />
      {error && <p className="persona-error" role="alert">{error}</p>}

      <section className="persona-fields">
        <label>
          <span>Name</span>
          <input value={draft.name} readOnly={readOnly} maxLength={100} onChange={(event) => edit({ name: event.target.value })} />
        </label>
        <label>
          <span>Description</span>
          <input value={draft.description} readOnly={readOnly} maxLength={500} onChange={(event) => edit({ description: event.target.value })} />
        </label>
        <label>
          <span>Provider override</span>
          <Tooltip label="Which model provider runs this Persona, overriding the app default">
            <select
              value={draft.runner ?? ""}
              disabled={readOnly}
              onChange={(event) => edit({ runner: event.target.value || null, model: null })}
            >
            <option value="">App default</option>
            {draft.runner !== null && selectedRunner === null && (
              <option value={draft.runner} disabled>Unavailable: {draft.runner}</option>
            )}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </Tooltip>
        </label>
        <div className="persona-effective" aria-label="Effective Persona model">
          <span>{draft.runner || draft.model ? "Effective after overrides" : "Effective from app defaults"}</span>
          <strong>{effectiveRunner ? providerLabel(providers, effectiveRunner) : "App default after save"}</strong>
          <code>{effectiveModel?.id ?? "resolves after save"}</code>
          {persona?.execution.runner.unknown && <small>Unknown stored provider “{persona.execution.runner.unknown}” fell back.</small>}
        </div>
        <div className="persona-model-field">
          <ModelSuggestions providerLabel={providerLabel(providers, runnerForControls)} />
          {/* `anchor` is null: this field is on the Workflows page, not in Settings, so
              there is no settings anchor for search to jump to. */}
          <ModelField
            id={`persona-model-${persona?.id ?? "new"}`}
            anchor={null}
            spec={WORKFLOW_PERSONA_MODEL_SPEC}
            value={draft.model ?? ""}
            resolved={effectiveModel}
            runner={runnerForControls}
            disabled={readOnly}
            onCommit={(model) => edit({ model: model || null })}
          />
        </div>
      </section>

      <div className="persona-narrow-toggle" role="group" aria-label="Persona guidance view">
        <Tooltip label="Edit the guidance markdown">
          <button className={narrowPane === "edit" ? "active" : ""} onClick={() => setNarrowPane("edit")}>Edit</button>
        </Tooltip>
        <Tooltip label="Preview the guidance as the reviewer will read it">
          <button className={narrowPane === "preview" ? "active" : ""} onClick={() => setNarrowPane("preview")}>Preview</button>
        </Tooltip>
      </div>
      <section className="persona-split">
        <div className="persona-pane persona-edit-pane" data-mobile-active={narrowPane === "edit"}>
          <header>
            <span>Markdown</span>
            <small className={exactBytes > WORKFLOW_LIMITS.personaGuidanceBytes ? "is-over-limit" : ""}>
              {exactBytes.toLocaleString()} / {WORKFLOW_LIMITS.personaGuidanceBytes.toLocaleString()} UTF-8 bytes
            </small>
          </header>
          <div aria-label={`Editor for ${markdownPath(draft.name)}`}>
            <FileEditor
              path={markdownPath(draft.name)}
              value={draft.guidanceMarkdown}
              readOnly={readOnly}
              lineSeparator={lineSeparator}
              onChange={(guidanceMarkdown) => edit({ guidanceMarkdown })}
              onBlur={() => {}}
            />
          </div>
        </div>
        <div className="persona-pane persona-preview-pane" data-mobile-active={narrowPane === "preview"}>
          <header><span>Preview</span></header>
          <article className="persona-markdown markdown">
            {draft.guidanceMarkdown ? <Markdown>{draft.guidanceMarkdown}</Markdown> : <p>Markdown preview appears here.</p>}
          </article>
        </div>
      </section>
    </article>
  );
}
