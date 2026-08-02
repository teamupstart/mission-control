import { useEffect, useMemo, useRef, useState } from "react";
import type { LlmProviderView } from "@shared/types.ts";
import { personasForDisplay, WORKFLOW_LIMITS } from "@shared/workflow.ts";
import type { PersonaDefaultsView, PersonaView } from "@shared/workflow.ts";
import { PersonaEditor } from "./PersonaEditor.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import type { PersonaDraftSeed } from "./PersonaEditor.tsx";
import { deriveImportedPersonaName, personaRequest } from "./personaApi.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "./WorkflowConfirmModal.tsx";

const EMPTY_SEED: PersonaDraftSeed = {
  name: "",
  description: "",
  guidanceMarkdown: "",
  runner: null,
  model: null,
};

export async function readPersonaImport(
  file: Pick<File, "size" | "text">,
): Promise<string> {
  if (file.size > WORKFLOW_LIMITS.personaGuidanceBytes) {
    throw new Error(`Persona guidance exceeds ${WORKFLOW_LIMITS.personaGuidanceBytes} UTF-8 bytes`);
  }
  const markdown = await file.text();
  if (new TextEncoder().encode(markdown).byteLength > WORKFLOW_LIMITS.personaGuidanceBytes) {
    throw new Error(`Persona guidance exceeds ${WORKFLOW_LIMITS.personaGuidanceBytes} UTF-8 bytes`);
  }
  return markdown;
}

export function importMayReplaceEditor(
  startedAtGeneration: number,
  currentGeneration: number,
): boolean {
  return startedAtGeneration === currentGeneration;
}

export function filterPersonas(
  personas: readonly PersonaView[],
  state: "active" | "archived",
  search: string,
): PersonaView[] {
  const needle = search.trim().toLocaleLowerCase("en-US");
  return personas.filter((persona) => {
    const stateMatches = state === "active"
      ? persona.archivedAt === null
      : persona.archivedAt !== null;
    return stateMatches && (
      needle.length === 0
      || persona.name.toLocaleLowerCase("en-US").includes(needle)
      || persona.description.toLocaleLowerCase("en-US").includes(needle)
    );
  });
}

export function PersonaLibrary({
  personas,
  providers,
  defaults,
  initialPersonaId = null,
  startNew = false,
  isOverlayOpen,
  onDirtyChange,
  onSelectionChange,
}: {
  personas: PersonaView[];
  providers: readonly LlmProviderView[];
  defaults: PersonaDefaultsView | null;
  /**
   * The Persona the ROUTE asked for, read once as this surface mounts.
   *
   * Only the entry point is the route's business. Selection itself stays here, because the
   * discard question a switch has to ask belongs to the editor that owns the draft - and
   * routing every sidebar click would raise the router's "leave anyway?" dialog on top of it.
   * `onSelectionChange` closes the loop the other way: what is open is reported back so the
   * address bar names it.
   */
  initialPersonaId?: string | null;
  /** Mount straight into a blank draft, for the Library's "＋ New Persona" card. */
  startNew?: boolean;
  isOverlayOpen: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSelectionChange?: (personaId: string | null) => void;
}): React.JSX.Element {
  const ordered = useMemo(
    () => personasForDisplay(personas)
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "en-US")),
    [personas],
  );
  const active = useMemo(() => ordered.filter((persona) => persona.archivedAt === null), [ordered]);
  const [personaState, setPersonaState] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => (startNew ? null : initialPersonaId ?? active[0]?.id ?? null),
  );
  const [seed, setSeed] = useState<PersonaDraftSeed | null>(() => (startNew ? EMPTY_SEED : null));
  const [localPersona, setLocalPersona] = useState<PersonaView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Destructive confirmations, hosted by the overlay registry rather than `window.confirm`. */
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const editorGeneration = useRef(0);
  const importRef = useRef<HTMLInputElement>(null);

  const listed = useMemo(
    () => filterPersonas(ordered, personaState, search),
    [ordered, personaState, search],
  );
  const streamedPersona = ordered.find((persona) => persona.id === selectedId) ?? null;
  // The route response can beat its SSE event. Keep the acknowledged revision visible until
  // the stream catches up, especially for archive where falling back would briefly re-enable edits.
  const selected = localPersona?.id === selectedId &&
      (streamedPersona === null || localPersona.revision > streamedPersona.revision)
    ? localPersona
    : streamedPersona;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  // Report what is open, however it came to be open - a click, a save, an import, or the
  // adopt-the-first-row effect below. One effect on the id rather than a call at each of
  // those sites, because the invariant is about the id and not about the path to it.
  useEffect(() => onSelectionChange?.(selectedId), [onSelectionChange, selectedId]);
  // `startNew` seeds the first paint (above) and is watched after it, on the EDGE of the
  // request: a route that asks for a blank draft while this surface is already up - a `/new`
  // link pasted into the address bar, a Back step onto one - is honoured too, and through
  // `start`, so it still asks before discarding an unsaved draft. `start` is hoisted and
  // deliberately not a dependency; the edge is the control.
  const newDraftAsked = useRef(startNew);
  useEffect(() => {
    const asked = startNew && !newDraftAsked.current;
    newDraftAsked.current = startNew;
    if (asked) start(EMPTY_SEED);
  }, [startNew]);
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

  /**
   * Run `action`, asking first when it would throw away unsaved editor changes.
   *
   * Through the overlay registry rather than `window.confirm` for that component's reason:
   * a native dialog is invisible to the registry, so `anyOpen` stays false and the fleet's
   * global key handler is live behind it - and this one is raised by a plain click on
   * another Persona, so it is the easiest of the three to hit by accident.
   *
   * The action is closed over and deferred rather than returning a boolean, which is what
   * the browser dialog's synchronous answer allowed. Everything after the question moves
   * inside it.
   */
  function guardDiscard(what: string, action: () => void): void {
    if (!dirty) {
      action();
      return;
    }
    setConfirm({
      title: "Discard unsaved Persona changes",
      body: `The editor has changes that have not been saved. ${what} discards them.`,
      confirmLabel: "Discard changes",
      confirmHint: "Throw the unsaved edits away and continue",
      danger: true,
      onConfirm: action,
    });
  }

  function select(id: string): void {
    const persona = ordered.find((candidate) => candidate.id === id);
    guardDiscard(`Opening ${persona?.name ?? "another Persona"}`, () => {
      editorGeneration.current += 1;
      setSeed(null);
      setSelectedId(id);
      setEditorKey((key) => key + 1);
      setDirty(false);
      setError(null);
    });
  }

  function start(seedValue: PersonaDraftSeed): void {
    guardDiscard(seedValue.name ? `Duplicating ${seedValue.name}` : "Starting a new Persona", () => {
      editorGeneration.current += 1;
      setSelectedId(null);
      setSeed(seedValue);
      setEditorKey((key) => key + 1);
      setDirty(false);
      setError(null);
    });
  }

  function importMarkdown(file: File): void {
    guardDiscard(`Importing ${file.name}`, () => void readImport(file));
  }

  async function archive(persona: PersonaView): Promise<void> {
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
  }

  async function readImport(file: File): Promise<void> {
    const startedAtGeneration = editorGeneration.current;
    try {
      const guidanceMarkdown = await readPersonaImport(file);
      const persona = await personaRequest<PersonaView>("/api/personas", {
        method: "POST",
        body: JSON.stringify({
          name: deriveImportedPersonaName(file.name, guidanceMarkdown),
          guidanceMarkdown,
          runner: null,
          model: null,
        }),
      });
      if (!importMayReplaceEditor(startedAtGeneration, editorGeneration.current)) return;
      editorGeneration.current += 1;
      setLocalPersona(persona);
      setSelectedId(persona.id);
      setSeed(null);
      setEditorKey((key) => key + 1);
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
          <Tooltip label="Author a new reviewer Persona">
            <button className="btn" onClick={() => start(EMPTY_SEED)}>New</button>
          </Tooltip>
        </div>
        <div className="persona-import-row">
          <Tooltip label="Create a Persona from a markdown file on disk">
            <button className="btn btn-ghost" onClick={() => importRef.current?.click()}>Import .md</button>
          </Tooltip>
          <label>
            State
            <Tooltip label="Choose whether to browse active or archived Personas">
              <select
                value={personaState}
                onChange={(event) => setPersonaState(event.target.value as "active" | "archived")}
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </Tooltip>
          </label>
          <input
            ref={importRef}
            className="persona-file-input"
            type="file"
            accept=".md,text/markdown,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) importMarkdown(file);
            }}
          />
        </div>
        <label className="persona-search">
          <span className="sr-only">Search Personas by name or description</span>
          <input
            type="search"
            value={search}
            placeholder="Search Personas"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="persona-list">
          {listed.length === 0 && (
            <p className="persona-list-empty">
              {search.trim()
                ? "No Personas match this search."
                : personaState === "archived"
                  ? "No archived Personas."
                  : "No saved Personas yet."}
            </p>
          )}
          {listed.map((persona) => (
            <Tooltip
              key={persona.id}
              label={persona.builtin
                ? `Open the built-in ${persona.name} - read-only, Duplicate to customize`
                : `Open ${persona.name} in the editor`}
            >
              <button
                className={`persona-list-item${selectedId === persona.id ? " active" : ""}`}
                onClick={() => select(persona.id)}
              >
                <span className="persona-list-name">
                  <span>{persona.name}</span>
                  {persona.builtin && <em className="persona-list-tag">Built-in</em>}
                </span>
                <small>{persona.archivedAt === null ? persona.description || "No description" : "Archived"}</small>
              </button>
            </Tooltip>
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
            key={editorKey}
            persona={selected}
            seed={seed ?? undefined}
            providers={providers}
            defaults={defaults}
            isOverlayOpen={isOverlayOpen}
            onDirtyChange={setDirty}
            onDraftEdit={() => {
              editorGeneration.current += 1;
            }}
            onSaved={(persona) => {
              setLocalPersona(persona);
              setSelectedId(persona.id);
              setSeed(null);
              setError(null);
            }}
            onDuplicate={(draft) => start(draft)}
            onArchive={(persona) => {
              // One dialog, not the two stacked native prompts this replaced: the unsaved
              // changes and the archive are a single decision, and asking twice for it
              // trains the second answer rather than reading it.
              setConfirm({
                title: `Archive ${persona.name}`,
                body: dirty
                  ? `Unsaved changes in the editor are discarded. ${persona.name} moves to the `
                    + "Archived list and stops being offered to new workflow stages; every "
                    + "published version keeps the guidance it was published with."
                  : `${persona.name} moves to the Archived list and stops being offered to new `
                    + "workflow stages. Every published version keeps the guidance it was "
                    + "published with.",
                confirmLabel: "Archive Persona",
                confirmHint: "Retire this Persona from new workflows, keeping published history",
                danger: true,
                onConfirm: () => void archive(persona),
              });
            }}
          />
        )}
      </div>

      {confirm && <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />}
    </section>
  );
}
