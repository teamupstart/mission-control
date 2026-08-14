import { useEffect, useMemo, useRef, useState } from "react";
import type { LlmProviderView } from "@shared/types.ts";
import { personaUpstreamLabel, personasForDisplay, WORKFLOW_LIMITS } from "@shared/workflow.ts";
import type {
  PersonaDefaultsView,
  PersonaUpstreamState,
  PersonaView,
} from "@shared/workflow.ts";
import { PersonaEditor } from "./PersonaEditor.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { LibraryBackRow } from "../library/LibraryBackRow.tsx";
import { useLibraryEscape } from "../library/useLibraryEscape.ts";
import type { PersonaDraftSeed } from "./PersonaEditor.tsx";
import {
  deriveImportedPersonaName,
  importPersonaFromPath,
  personaRequest,
  reimportPersona,
} from "./personaApi.ts";
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

/**
 * The sidebar tag for one upstream state, or null when the row wears none.
 *
 * Through the shared label so the sidebar, the Library card and the editor's status line all
 * say the same words about the same fact. `undefined` - not imported, or not checked yet -
 * reaches the same answer as `current`: nothing.
 */
export function driftTag(state: PersonaUpstreamState | undefined): string | null {
  return state === undefined ? null : personaUpstreamLabel(state);
}

/**
 * The catalog a Persona was supplied by, or null when it was not supplied by one.
 *
 * A function beside `driftTag` rather than an inline conditional, for the same reason: it is a
 * rule about what a row wears, so it is testable without rendering a sidebar. Built-ins are
 * excluded explicitly even though they carry no provenance today - the tag answers "which
 * catalog supplied this", and `Built-in` already answers it for them.
 */
export function catalogTag(
  persona: Pick<PersonaView, "builtin" | "provenance">,
): string | null {
  if (persona.builtin) return null;
  return persona.provenance?.catalogLabel ?? null;
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
  upstream,
  onCheckUpstream,
  initialPersonaId = null,
  startNew = false,
  isOverlayOpen,
  onLeave,
  onDirtyChange,
  onSelectionChange,
}: {
  personas: PersonaView[];
  providers: readonly LlmProviderView[];
  defaults: PersonaDefaultsView | null;
  /**
   * What the last upstream check found, per Persona id. Absent for a Persona with no source
   * file and for one nothing has checked yet, which render identically: no badge.
   */
  upstream?: ReadonlyMap<string, PersonaUpstreamState>;
  /** Ask for a fresh check. Called by the affordance, and after an import or a re-import. */
  onCheckUpstream?: () => void;
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
  /**
   * Leave this surface for the Library index. App points it at the router's `navigate`, so
   * the back row and Escape leave by ONE path and an unsaved draft raises the existing
   * leave-with-unsaved-changes dialog rather than being dropped.
   */
  onLeave: () => void;
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
  const [importPath, setImportPath] = useState("");
  const [importing, setImporting] = useState(false);

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

  // Escape leaves the guidance editor, then leaves the page - the same ladder the back row
  // above the rail is the visible half of.
  useLibraryEscape({ isOverlayOpen, onLeave });

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

  /** Open whatever the daemon just wrote or rewrote, and re-ask about every source file. */
  function adopt(persona: PersonaView): void {
    editorGeneration.current += 1;
    setLocalPersona(persona);
    setSelectedId(persona.id);
    setSeed(null);
    setEditorKey((key) => key + 1);
    setDirty(false);
    setError(null);
    onCheckUpstream?.();
  }

  async function importFromPath(): Promise<void> {
    const path = importPath.trim();
    if (!path || importing) return;
    setImporting(true);
    try {
      adopt(await importPersonaFromPath(path));
      setImportPath("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import that path");
    } finally {
      setImporting(false);
    }
  }

  async function reimport(persona: PersonaView): Promise<void> {
    try {
      // Adopted the same way a save is: the editor's own revision effect takes the new
      // guidance when the draft is clean, and raises its ordinary conflict when it is not.
      adopt(await reimportPersona(persona.id, persona.revision));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not re-import from the source file");
    }
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
      adopt(persona);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import Markdown");
    }
  }

  return (
    <section className="persona-library">
      <aside className="persona-sidebar" aria-label="Persona library">
        <LibraryBackRow onLeave={onLeave} />
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
        {/* Importing BY PATH, which is a different thing from the file picker above and not a
            second way to do it: the daemon reads the file, so the Persona remembers where its
            guidance came from and can be told when that file changes. */}
        <div className="persona-import-source">
          <label className="persona-import-path">
            <span className="sr-only">Absolute path of a Markdown file on this machine</span>
            <input
              type="text"
              value={importPath}
              spellCheck={false}
              placeholder="/path/to/role.md"
              onChange={(event) => setImportPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                guardDiscard(`Importing ${importPath.trim()}`, () => void importFromPath());
              }}
            />
          </label>
          <Tooltip label="Import a Markdown role the daemon can read, recording where it came from">
            <button
              className="btn btn-ghost"
              disabled={importing || importPath.trim().length === 0}
              onClick={() => guardDiscard(`Importing ${importPath.trim()}`, () => void importFromPath())}
            >
              {importing ? "Importing…" : "Import from path"}
            </button>
          </Tooltip>
          <Tooltip label="Re-read every imported Persona's source file and update its badge">
            <button className="btn btn-ghost" onClick={() => onCheckUpstream?.()}>
              Check upstream
            </button>
          </Tooltip>
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
          {listed.map((persona) => {
            const drift = driftTag(upstream?.get(persona.id));
            return (
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
                    {/* The catalog that supplied this reviewer, in the same muted tag as
                        `Built-in` and for the same reason: both answer "where did this come from
                        and may I edit it", and neither is a thing to act on. The label is
                        rendered verbatim from provenance - this component knows that catalogs
                        have names, never which. A supplied Persona IS editable, unlike a
                        built-in, so the tag stays informational and gates nothing. */}
                    {catalogTag(persona) && (
                      <em className="persona-list-tag">{catalogTag(persona)}</em>
                    )}
                    {/* Provenance beside provenance: `Built-in` says this came with the app, this
                        says the file it came from has moved on. Toned rather than muted, because
                        unlike `Built-in` it is something to act on. */}
                    {drift && <em className="persona-list-tag is-attention">{drift}</em>}
                  </span>
                  <small>{persona.archivedAt === null ? persona.description || "No description" : "Archived"}</small>
                </button>
              </Tooltip>
            );
          })}
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
            upstream={selected ? upstream?.get(selected.id) : undefined}
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
            onReimport={(persona) => {
              // Confirm-guarded like Archive, and for the same reason: it replaces text the
              // operator may be reading. The body states the invariant that makes it safe -
              // this is a new revision, and no published version moves.
              setConfirm({
                title: `Re-import ${persona.name}`,
                body: dirty
                  ? "Unsaved changes in the editor are discarded. This Persona's guidance is "
                    + `replaced with the current contents of ${persona.provenance?.sourcePath ?? "its source file"} `
                    + "as a new revision; every published workflow version keeps the guidance it "
                    + "was published with."
                  : "This Persona's guidance is replaced with the current contents of "
                    + `${persona.provenance?.sourcePath ?? "its source file"} as a new revision. `
                    + "Every published workflow version keeps the guidance it was published with.",
                confirmLabel: "Re-import guidance",
                confirmHint: "Adopt the source file's current text as a new revision",
                danger: true,
                onConfirm: () => void reimport(persona),
              });
            }}
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
