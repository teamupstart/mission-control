import { useEffect, useMemo, useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import {
  WORKFLOW_PERSONA_MODEL_SPEC,
  normalizePersonaName,
} from "@shared/workflow.ts";
import type { PersonaView } from "@shared/workflow.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ModelField, ModelSuggestions } from "../components/ModelField.tsx";
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

export function personaUpdatePatch(
  persona: PersonaView,
  draft: PersonaDraftSeed,
  expectedRevision: number,
): Record<string, unknown> {
  const original = fromPersona(persona);
  const patch: Record<string, unknown> = { expectedRevision };
  for (const field of ["name", "description", "guidanceMarkdown", "runner", "model"] as const) {
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

export function isPersonaSaveShortcut(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
}

export function personaLineSeparator(markdown: string): "\r\n" | "\r" | "\n" {
  return (markdown.match(/\r\n|\r|\n/)?.[0] ?? "\n") as "\r\n" | "\r" | "\n";
}

function knownRunner(value: string | null): LlmRunnerId | null {
  return value !== null && (LLM_RUNNER_IDS as readonly string[]).includes(value)
    ? value as LlmRunnerId
    : null;
}

export function PersonaEditorStatus({
  dirty,
  conflict,
  archived,
  onReload,
  onDuplicate,
}: {
  dirty: boolean;
  conflict: PersonaView | null;
  archived: boolean;
  onReload: () => void;
  onDuplicate: () => void;
}): React.JSX.Element | null {
  if (archived) return <p className="persona-state archived">Archived - this Persona is read-only.</p>;
  if (conflict) {
    return (
      <div className="persona-state conflict" role="alert">
        <span>A newer revision exists. Your local Markdown has not been changed.</span>
        <button className="btn" onClick={onReload}>Reload latest</button>
        <button className="btn" onClick={onDuplicate}>Save as duplicate</button>
      </div>
    );
  }
  return dirty ? <p className="persona-state dirty">Unsaved changes</p> : null;
}

export function PersonaEditor({
  persona,
  seed,
  onDirtyChange,
  onSaved,
  onDuplicate,
  onArchive,
}: {
  persona: PersonaView | null;
  seed?: PersonaDraftSeed;
  onDirtyChange: (dirty: boolean) => void;
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
  const [loadedRevision, setLoadedRevision] = useState(persona?.revision ?? null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<PersonaView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [narrowPane, setNarrowPane] = useState<"edit" | "preview">("edit");
  const archived = persona?.archivedAt != null;

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
    setDraft(fromPersona(persona));
    setLoadedRevision(persona.revision);
    setConflict(null);
  }, [dirty, loadedRevision, persona]);

  const selectedRunner = knownRunner(draft.runner);
  const effectiveRunner = persona?.execution.runner.id ?? selectedRunner;
  const runnerForControls = selectedRunner ?? effectiveRunner ?? "claude";
  const effectiveModel = persona?.execution.model;
  const exactBytes = useMemo(() => new TextEncoder().encode(draft.guidanceMarkdown).byteLength, [draft.guidanceMarkdown]);
  const lineSeparator = useMemo(
    () => personaLineSeparator(draft.guidanceMarkdown),
    [draft.guidanceMarkdown],
  );

  function edit(patch: Partial<PersonaDraftSeed>): void {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setConflict(null);
    setError(null);
  }

  async function save(asDuplicate = false): Promise<void> {
    if (archived || saving || (persona !== null && !dirty && !asDuplicate)) return;
    const updateBody = persona ? personaUpdatePatch(persona, draft, loadedRevision!) : null;
    if (!asDuplicate && updateBody && Object.keys(updateBody).length === 1) {
      setDirty(false);
      setConflict(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const create = persona === null || asDuplicate;
      const name = asDuplicate ? `${draft.name || "Persona"} copy` : draft.name;
      const body = create
        ? { ...draft, name, runner: knownRunner(draft.runner) }
        : updateBody!;
      const saved = await personaRequest<PersonaView>(
        create ? "/api/personas" : `/api/personas/${persona.id}`,
        {
          method: create ? "POST" : "PATCH",
          body: JSON.stringify(body),
        },
      );
      setDraft(fromPersona(saved));
      setLoadedRevision(saved.revision);
      setDirty(false);
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
      if (isPersonaSaveShortcut(event)) {
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
    setDraft(fromPersona(conflict));
    setLoadedRevision(conflict.revision);
    setDirty(false);
    setConflict(null);
    setError(null);
  }

  const readOnly = archived;
  return (
    <article className={`persona-editor${archived ? " is-archived" : ""}`}>
      <header className="persona-editor-head">
        <div>
          <p className="workflow-eyebrow">{persona ? `Revision ${loadedRevision}` : "New Persona"}</p>
          <h3>{draft.name || "Untitled Persona"}</h3>
        </div>
        <div className="persona-actions">
          <button className="btn" disabled={readOnly || saving || (persona !== null && !dirty)} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
          <button className="btn btn-ghost" onClick={() => void copyMarkdown()}>{copied ? "Copied ✓" : "Copy Markdown"}</button>
          <button className="btn btn-ghost" onClick={downloadMarkdown}>Download .md</button>
          {persona && <button className="btn btn-ghost" onClick={() => onDuplicate({ ...draft, name: `${draft.name} copy` })}>Duplicate</button>}
          {persona && !archived && <button className="btn btn-danger" onClick={() => void onArchive(persona)}>Archive</button>}
        </div>
      </header>

      <PersonaEditorStatus
        dirty={dirty}
        conflict={conflict}
        archived={archived}
        onReload={reload}
        onDuplicate={() => void save(true)}
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
          <select
            value={draft.runner ?? ""}
            disabled={readOnly}
            onChange={(event) => edit({ runner: event.target.value || null, model: null })}
          >
            <option value="">App default</option>
            {draft.runner !== null && selectedRunner === null && (
              <option value={draft.runner} disabled>Unavailable: {draft.runner}</option>
            )}
            {LLM_RUNNER_IDS.map((runner) => <option key={runner} value={runner}>{AGENT_IDENTITY[runner].label}</option>)}
          </select>
        </label>
        <div className="persona-effective" aria-label="Effective Persona model">
          <span>Effective</span>
          <strong>{effectiveRunner ? AGENT_IDENTITY[effectiveRunner].label : "App default after save"}</strong>
          <code>{effectiveModel?.id ?? "resolves after save"}</code>
          {persona?.execution.runner.unknown && <small>Unknown stored provider “{persona.execution.runner.unknown}” fell back.</small>}
        </div>
        <div className="persona-model-field">
          <ModelSuggestions runner={runnerForControls} />
          <ModelField
            id={`persona-model-${persona?.id ?? "new"}`}
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
        <button className={narrowPane === "edit" ? "active" : ""} onClick={() => setNarrowPane("edit")}>Edit</button>
        <button className={narrowPane === "preview" ? "active" : ""} onClick={() => setNarrowPane("preview")}>Preview</button>
      </div>
      <section className="persona-split">
        <div className="persona-pane persona-edit-pane" data-mobile-active={narrowPane === "edit"}>
          <header><span>Markdown</span><small>{exactBytes.toLocaleString()} bytes</small></header>
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
