import { useEffect, useMemo, useRef, useState } from "react";
import type { PersonaView } from "@shared/workflow.ts";
import { PersonaEditor } from "./PersonaEditor.tsx";
import type { PersonaDraftSeed } from "./PersonaEditor.tsx";
import { deriveImportedPersonaName, personaRequest } from "./personaApi.ts";

const EMPTY_SEED: PersonaDraftSeed = {
  name: "",
  description: "",
  guidanceMarkdown: "",
  runner: null,
  model: null,
};

export function PersonaLibrary({
  personas,
  onDirtyChange,
}: {
  personas: PersonaView[];
  onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const ordered = useMemo(
    () => [...personas].sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "en-US")),
    [personas],
  );
  const active = useMemo(() => ordered.filter((persona) => persona.archivedAt === null), [ordered]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => active[0]?.id ?? null);
  const [seed, setSeed] = useState<PersonaDraftSeed | null>(null);
  const [localPersona, setLocalPersona] = useState<PersonaView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const listed = includeArchived ? ordered : active;
  const streamedPersona = ordered.find((persona) => persona.id === selectedId) ?? null;
  // The route response can beat its SSE event. Keep the acknowledged revision visible until
  // the stream catches up, especially for archive where falling back would briefly re-enable edits.
  const selected = localPersona?.id === selectedId &&
      (streamedPersona === null || localPersona.revision > streamedPersona.revision)
    ? localPersona
    : streamedPersona;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    // The first SSE snapshot can arrive after this page mounts. Adopt its first active row only
    // while the workspace is genuinely untouched, never over a New/import draft.
    if (selectedId === null && seed === null && !dirty && active[0]) setSelectedId(active[0].id);
  }, [active, dirty, seed, selectedId]);
  useEffect(() => {
    const streamed = localPersona
      ? personas.find((persona) => persona.id === localPersona.id)
      : null;
    if (localPersona && streamed && streamed.revision >= localPersona.revision) setLocalPersona(null);
  }, [localPersona, personas]);

  function mayDiscard(): boolean {
    return !dirty || window.confirm("Discard unsaved Persona changes?");
  }

  function select(id: string): void {
    if (!mayDiscard()) return;
    setSeed(null);
    setSelectedId(id);
    setDirty(false);
    setError(null);
  }

  function start(seedValue: PersonaDraftSeed): void {
    if (!mayDiscard()) return;
    setSelectedId(null);
    setSeed(seedValue);
    setDirty(false);
    setError(null);
  }

  async function importMarkdown(file: File): Promise<void> {
    if (!mayDiscard()) return;
    try {
      const guidanceMarkdown = await file.text();
      const persona = await personaRequest<PersonaView>("/api/personas", {
        method: "POST",
        body: JSON.stringify({
          name: deriveImportedPersonaName(file.name, guidanceMarkdown),
          guidanceMarkdown,
          runner: null,
          model: null,
        }),
      });
      setLocalPersona(persona);
      setSelectedId(persona.id);
      setSeed(null);
      setDirty(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import Markdown");
    }
  }

  return (
    <section className="persona-library">
      <aside className="persona-sidebar" aria-label="Persona library">
        <div className="persona-sidebar-head">
          <div>
            <h3>Personas</h3>
            <p>{active.length} active</p>
          </div>
          <button className="btn" onClick={() => start(EMPTY_SEED)}>New</button>
        </div>
        <div className="persona-import-row">
          <button className="btn btn-ghost" onClick={() => importRef.current?.click()}>Import .md</button>
          <label>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Archived
          </label>
          <input
            ref={importRef}
            className="persona-file-input"
            type="file"
            accept=".md,text/markdown,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void importMarkdown(file);
            }}
          />
        </div>
        <div className="persona-list">
          {listed.length === 0 && <p className="persona-list-empty">No saved Personas yet.</p>}
          {listed.map((persona) => (
            <button
              key={persona.id}
              className={`persona-list-item${selectedId === persona.id ? " active" : ""}`}
              onClick={() => select(persona.id)}
            >
              <span>{persona.name}</span>
              <small>{persona.archivedAt === null ? persona.description || "No description" : "Archived"}</small>
            </button>
          ))}
        </div>
      </aside>

      <div className="persona-workspace">
        {error && <p className="persona-error" role="alert">{error}</p>}
        {!selected && !seed && (
          <section className="workflow-empty persona-empty">
            <h3>Choose a Persona</h3>
            <p>Select one from the library or create a new Markdown review role.</p>
          </section>
        )}
        {(selected || seed) && (
          <PersonaEditor
            key={selected?.id ?? `new:${seed?.name ?? ""}`}
            persona={selected}
            seed={seed ?? undefined}
            onDirtyChange={setDirty}
            onSaved={(persona) => {
              setLocalPersona(persona);
              setSelectedId(persona.id);
              setSeed(null);
              setError(null);
            }}
            onDuplicate={(draft) => start(draft)}
            onArchive={async (persona) => {
              if (dirty && !window.confirm("Discard unsaved changes and archive this Persona?")) return;
              if (!window.confirm(`Archive ${persona.name}? Published history will keep its guidance.`)) return;
              try {
                const archived = await personaRequest<PersonaView>(`/api/personas/${persona.id}`, {
                  method: "DELETE",
                  body: JSON.stringify({ expectedRevision: persona.revision }),
                });
                setLocalPersona(archived);
                setDirty(false);
                setError(null);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not archive Persona");
              }
            }}
          />
        )}
      </div>
    </section>
  );
}
