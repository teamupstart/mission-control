import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isLlmRunnerId } from "@shared/llm.ts";
import type { LlmRunnerId } from "@shared/llm.ts";
import type { ResolvedModel } from "@shared/model-choice.ts";
import type { LlmProviderView } from "@shared/types.ts";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_PERSONA_MODEL_SPEC,
  normalizePersonaName,
} from "@shared/workflow.ts";
import type {
  PersonaDefaultsView,
  PersonaProvenance,
  PersonaUpstreamState,
  PersonaView,
} from "@shared/workflow.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ModelField, ModelSuggestions } from "../components/ModelField.tsx";
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

/**
 * When this Persona was imported and from where, as one readable line.
 *
 * The absolute path in full rather than a basename: it is the whole point of provenance, it is
 * what a re-import will read, and two `reviewer.md` files under two plugins are the case this
 * has to tell apart. The plugin version rides along when the source sat under one, because
 * "agent-team 0.2.0" is how an operator recognises what changed upstream.
 */
export function personaSourceLine(provenance: PersonaProvenance): string {
  const version = provenance.pluginVersion === null ? "" : ` (plugin ${provenance.pluginVersion})`;
  const when = new Date(provenance.importedAt).toLocaleString();
  return `Imported from ${provenance.sourcePath}${version} on ${when}`;
}

/**
 * Where the routing this Persona will run with was decided.
 *
 * The read-only third chip, and the one that makes the other two legible: `provider` and
 * `model` show a resolved value either way, so without this the row cannot distinguish
 * "Codex, because this Persona says so" from "Codex, because that is what the app is set
 * to". The block this replaced said it in a whole labelled box.
 */
export function personaRoutingSource(
  draft: Pick<PersonaDraftSeed, "runner" | "model">,
  model: ResolvedModel | undefined,
): string {
  if (draft.runner !== null || draft.model !== null) return "this Persona";
  if (model === undefined) return "resolves after save";
  if (model.source === "env") return "the daemon's environment";
  return model.source === "config" ? "app settings" : "app defaults";
}

/**
 * Everything the header does NOT promote, as data.
 *
 * A list rather than markup because that is the part worth pinning: which verbs a built-in,
 * an archived row and an unsaved draft each offer is behaviour, and it survived four
 * rearrangements of this header by being asserted about the buttons rather than about the
 * row they sat in. Their labels are unchanged - a menu is where they live now, not what
 * they are called.
 */
export function personaOverflowActions({
  persona,
  builtin,
  archived,
  canReimport,
  copyLabel,
  sourcePath,
  onCopy,
  onDownload,
  onDuplicate,
  onReimport,
  onArchive,
}: {
  persona: boolean;
  builtin: boolean;
  archived: boolean;
  canReimport: boolean;
  /** `Copy Markdown`, or the confirmation it flips to for a few seconds after a copy. */
  copyLabel: string;
  sourcePath: string | null;
  onCopy: () => void;
  onDownload: () => void;
  onDuplicate: () => void;
  onReimport: () => void;
  onArchive: () => void;
}): LibraryMenuAction[] {
  const readOnly = archived || builtin;
  const actions: LibraryMenuAction[] = [
    {
      id: "copy",
      label: copyLabel,
      hint: "Copy this Persona's guidance markdown to the clipboard",
      // The confirmation is the row's own label, so closing the menu would throw it away.
      keepOpen: true,
      onSelect: onCopy,
    },
    {
      id: "download",
      label: "Download .md",
      hint: "Save this Persona's guidance to a markdown file",
      onSelect: onDownload,
    },
  ];
  // Not on a read-only Persona, where Duplicate is the promoted verb: offering it twice
  // makes the more prominent one the one nobody can find again later.
  if (persona && !readOnly) {
    actions.push({
      id: "duplicate",
      label: "Duplicate",
      hint: "Copy this Persona into a new one",
      onSelect: onDuplicate,
    });
  }
  if (canReimport) {
    actions.push({
      id: "reimport",
      label: "Re-import from source",
      hint: `Re-read ${sourcePath ?? "the source file"} and save it as a new revision`,
      onSelect: onReimport,
    });
  }
  if (persona && !archived && !builtin) {
    actions.push({
      id: "archive",
      label: "Archive",
      hint: "Archive this Persona - workflows already published keep their copy",
      danger: true,
      onSelect: onArchive,
    });
  }
  return actions;
}

/**
 * The provider `select`, lifted out of the metadata block into the chip's popover.
 *
 * Exported because a closed popover renders nothing, and `renderToStaticMarkup` cannot open
 * one - so the rules worth asserting (every provider comes from the catalog, a stored id
 * this build does not know stays listed and disabled rather than vanishing) would otherwise
 * have no test at all. Same split, for the same reason, as `OpenInList` under `OpenInMenu`.
 */
export function PersonaProviderControl({
  providers,
  value,
  disabled,
  onChange,
}: {
  providers: readonly LlmProviderView[];
  /** The STORED override, `null` for "inherit the app default" - not the resolved runner. */
  value: string | null;
  disabled: boolean;
  onChange: (runner: string | null) => void;
}): React.JSX.Element {
  return (
    <label className="persona-chip-field">
      <span>Provider override</span>
      <Tooltip label="Which model provider runs this Persona, overriding the app default">
        <select
          value={value ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">App default</option>
          {value !== null && knownRunner(value) === null && (
            <option value={value} disabled>Unavailable: {value}</option>
          )}
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>{provider.label}</option>
          ))}
        </select>
      </Tooltip>
    </label>
  );
}

/** The model picker and its catalog hint, in the model chip's popover. See above. */
export function PersonaModelControl({
  id,
  provider,
  value,
  resolved,
  runner,
  disabled,
  onCommit,
}: {
  id: string;
  /** The provider whose catalog the picker lists, as a label a person reads. */
  provider: string;
  value: string;
  resolved: ResolvedModel | undefined;
  runner: LlmRunnerId;
  disabled: boolean;
  onCommit: (model: string) => void;
}): React.JSX.Element {
  return (
    <div className="persona-model-field">
      <ModelSuggestions providerLabel={provider} />
      {/* `anchor` is null: this field is on the Library page, not in Settings, so there is
          no settings anchor for search to jump to. */}
      <ModelField
        id={id}
        anchor={null}
        spec={WORKFLOW_PERSONA_MODEL_SPEC}
        value={value}
        resolved={resolved}
        runner={runner}
        disabled={disabled}
        onCommit={onCommit}
      />
    </div>
  );
}

export function PersonaEditorStatus({
  dirty,
  conflict,
  archived,
  builtin = false,
  upstream,
  canReimport = false,
  onReload,
  onDuplicate,
  onDownload = () => {},
}: {
  dirty: boolean;
  conflict: PersonaView | null;
  archived: boolean;
  builtin?: boolean;
  /** What the last upstream check found for this Persona, if it has a source file. */
  upstream?: PersonaUpstreamState;
  /**
   * False for a built-in, an archived row, or a Persona that was never imported.
   *
   * Decides only whether this sentence NAMES the header's action. The drift line deliberately
   * carries no button of its own: the conflict banner above owns controls that exist nowhere
   * else, while re-import is a header action beside Save and Archive - rendering it twice put
   * two identical buttons on screen at once and made the more prominent one the one that is
   * harder to find again later.
   */
  canReimport?: boolean;
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
  if (dirty) return <p className="persona-state dirty">Unsaved changes</p>;
  // Last in the precedence line on purpose. Built-in, archived and conflict all describe what
  // this editor can do right now; drift describes a file somewhere else, and it is the only one
  // of the five that is not urgent - the stored guidance is intact and still what runs.
  if (upstream === "changed") {
    return (
      <p className="persona-state drift">
        The source file has changed since this Persona was imported. Its stored guidance is
        unchanged, and every published workflow version keeps what it was published with.
        {canReimport && " Re-import from source adopts the file's current text as a new revision."}
      </p>
    );
  }
  if (upstream === "missing") {
    return (
      <p className="persona-state drift">
        The source file this Persona was imported from cannot be read right now. Its stored
        guidance is unchanged; re-import once the file is back.
      </p>
    );
  }
  return null;
}

export function PersonaEditor({
  persona,
  seed,
  providers,
  defaults,
  upstream,
  isOverlayOpen,
  onDirtyChange,
  onDraftEdit,
  onSaved,
  onDuplicate,
  onReimport = () => {},
  onArchive,
  footer,
}: {
  persona: PersonaView | null;
  seed?: PersonaDraftSeed;
  providers: readonly LlmProviderView[];
  defaults: PersonaDefaultsView | null;
  /** What the last upstream check found for this Persona's source file, if it has one. */
  upstream?: PersonaUpstreamState;
  isOverlayOpen: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDraftEdit: () => void;
  onSaved: (persona: PersonaView) => void;
  onDuplicate: (seed: PersonaDraftSeed) => void;
  /** Raised for the library to confirm and perform: it owns the request and the error line. */
  onReimport?: (persona: PersonaView) => void;
  onArchive: (persona: PersonaView) => void | Promise<void>;
  /** The Library's shared usage footer; absent on a new draft and on older daemon state. */
  footer?: ReactNode;
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
  const copy = useCopyFeedback();
  const [guidanceMode, setGuidanceMode] = useState<"editor" | "preview">("editor");
  const archived = persona?.archivedAt != null;
  const builtin = persona?.builtin === true;
  const provenance = persona?.provenance ?? null;
  // A built-in has no source path, and an archived Persona is read-only - re-import is a write.
  const canReimport = persona !== null && provenance !== null && !archived && !builtin;

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

  /*
   * Through `useCopyFeedback`, and so through `copyText`, which is the whole point of the
   * change: this called `navigator.clipboard.writeText` directly, so it never reached the
   * selected-textarea fallback and copied nothing in the Electron renderer - where the async
   * Clipboard API can be permission-blocked even after a direct click.
   *
   * It clears the editor's error line before attempting, which is what `save` and `reload` here
   * already do and what the two other migrated copy sites do. Writing only on failure left a
   * refusal standing underneath a later `Copied` - a confirmation and a contradiction for the
   * same button.
   */
  function copyMarkdown(): void {
    setError(null);
    void copy.copy(() => draft.guidanceMarkdown).then(({ error: caught }) => {
      if (caught !== null) {
        setError(`Clipboard access was blocked, and the Markdown remains in the editor. ${caught}`);
      }
    });
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
  const overLimit = exactBytes > WORKFLOW_LIMITS.personaGuidanceBytes;
  const duplicate = (): void => onDuplicate({ ...draft, name: `${draft.name} copy` });
  /*
   * ONE promoted verb, and on a read-only Persona it is Duplicate rather than a disabled
   * Save. Save sat first here permanently greyed out on all four built-ins, which reads as
   * "the thing you want, unavailable" - when the thing you want is two controls to its
   * right and perfectly available. Nothing is hidden by this: Save is not offered because
   * there is no revision this editor could write.
   */
  const primary: LibraryPrimaryAction = readOnly && persona
    ? {
      label: "Duplicate to edit",
      hint: builtin
        ? "Start an editable copy of this built-in Persona"
        : "Start an editable copy of this archived Persona",
      onClick: duplicate,
    }
    : {
      label: saving ? "Saving…" : "Save",
      hint: overLimit
        ? "Guidance is over the UTF-8 byte limit"
        : persona !== null && !dirty
          ? "No unsaved changes"
          : "Save this Persona as a new revision",
      disabled: saving || overLimit || (persona !== null && !dirty),
      onClick: () => void save(),
    };
  const overflow = personaOverflowActions({
    persona: persona !== null,
    builtin,
    archived,
    canReimport,
    copyLabel: copy.copied ? COPY_FEEDBACK_LABEL : "Copy Markdown",
    sourcePath: provenance?.sourcePath ?? null,
    onCopy: copyMarkdown,
    onDownload: downloadMarkdown,
    onDuplicate: duplicate,
    onReimport: () => {
      if (persona) onReimport(persona);
    },
    onArchive: () => {
      if (persona) void onArchive(persona);
    },
  });
  return (
    <article className={`persona-editor${archived ? " is-archived" : ""}${builtin ? " is-builtin" : ""}`}>
      <LibraryWorkspaceHeader
        className="persona-editor-head"
        // `persona-fields` still names exactly what it holds - the Persona's own scalar
        // fields - now that provider and model have become chips. It is also what four
        // Playwright specs reach the Name and Description inputs through, and those
        // accessible names are unchanged.
        titleClassName="persona-fields"
        title={
          <>
            {/* The visible title IS the Name field now, rather than a heading printing the
                same string a labelled input three rows below also held. The document still
                needs a heading for that, so it keeps one that only a screen reader reads. */}
            <h2 className="sr-only">{draft.name || "Untitled Persona"}</h2>
            <div className="lib-work-name">
              <label className="lib-work-name-field">
                <span className="sr-only">Name</span>
                <input
                  value={draft.name}
                  readOnly={readOnly}
                  maxLength={100}
                  placeholder="Untitled Persona"
                  onChange={(event) => edit({ name: event.target.value })}
                />
              </label>
              {builtin && <span className="lib-tag lib-tag-builtin">built-in</span>}
            </div>
          </>
        }
        subtitle={
          <label className="lib-work-subtitle">
            <span className="sr-only">Description</span>
            <input
              value={draft.description}
              readOnly={readOnly}
              maxLength={500}
              placeholder="One line on what this reviewer judges"
              onChange={(event) => edit({ description: event.target.value })}
            />
          </label>
        }
        meta={
          <div className="lib-work-meta">
            <p className="workflow-eyebrow">
              {persona ? (builtin ? "Built-in Persona" : `Revision ${loadedRevision}`) : "New Persona"}
            </p>
            {provenance && <p className="persona-source mono">{personaSourceLine(provenance)}</p>}
          </div>
        }
        primary={primary}
        menuLabel="More Persona actions"
        actions={overflow}
      />

      <PersonaEditorStatus
        dirty={dirty}
        conflict={conflict}
        archived={archived}
        builtin={builtin}
        upstream={upstream}
        canReimport={canReimport}
        onReload={reload}
        onDuplicate={() => void save(true)}
        onDownload={downloadMarkdown}
      />
      {error && <p className="persona-error" role="alert">{error}</p>}

      <LibraryPropertyChips>
        <LibraryPropertyChip
          name="provider"
          value={effectiveRunner ? providerLabel(providers, effectiveRunner) : "App default after save"}
          state={draft.runner === null ? "inherited" : "overridden"}
          tooltip={draft.runner === null
            ? "Inherited from the app default provider - open to override it for this Persona"
            : "This Persona overrides the app default provider"}
          controlLabel="Provider override"
        >
          <PersonaProviderControl
            providers={providers}
            value={draft.runner}
            disabled={readOnly}
            onChange={(runner) => edit({ runner, model: null })}
          />
        </LibraryPropertyChip>
        <LibraryPropertyChip
          name="model"
          value={effectiveModel?.id ?? "resolves after save"}
          mono
          state={draft.model === null ? "inherited" : "overridden"}
          tooltip={draft.model === null
            ? "Inherited from the app default model - open to override it for this Persona"
            : "This Persona overrides the app default model"}
          controlLabel="Model override"
        >
          <PersonaModelControl
            id={`persona-model-${persona?.id ?? "new"}`}
            provider={providerLabel(providers, runnerForControls)}
            value={draft.model ?? ""}
            resolved={effectiveModel}
            runner={runnerForControls}
            disabled={readOnly}
            onCommit={(model) => edit({ model: model || null })}
          />
        </LibraryPropertyChip>
        <LibraryPropertyChip
          name="source"
          value={personaRoutingSource(draft, effectiveModel)}
          tooltip="Where the provider and model above were decided"
        />
        <LibraryPropertyChip
          name="utf-8 bytes"
          value={`${exactBytes.toLocaleString()} / ${WORKFLOW_LIMITS.personaGuidanceBytes.toLocaleString()}`}
          mono
          align="end"
          tone={overLimit ? "danger" : undefined}
          tooltip={overLimit
            ? "The guidance is over the byte limit and cannot be saved until it is shorter"
            : "Exact UTF-8 size of the guidance markdown, against the limit a save is checked against"}
        />
      </LibraryPropertyChips>
      {/* Kept on the face rather than inside the provider chip's popover: a stored provider
          this build cannot resolve is something to act on, and a closed chip that reads
          "Claude Code" would report the fallback as if it were the setting. */}
      {persona?.execution.runner.unknown && (
        <p className="lib-props-note">
          Unknown stored provider “{persona.execution.runner.unknown}” fell back.
        </p>
      )}

      <section className="persona-guidance" aria-label="Persona guidance">
        <header className="file-toolbar persona-guidance-toolbar">
          <span className="file-path mono">{markdownPath(draft.name)}</span>
          <span className="file-language">Markdown</span>
          {/* The byte count is a property of the asset, so it is a property chip above with
              the other three. It was here and in no other file toolbar in the app, which is
              what made this one 40px of chrome wider than it needed to be. */}
          <span className="file-toolbar-spacer" />
          <div className="file-mode" role="group" aria-label="Persona guidance view">
            <Tooltip label="Render the guidance as the reviewer will read it">
              <button
                className={guidanceMode === "preview" ? "on" : ""}
                aria-pressed={guidanceMode === "preview"}
                onClick={() => setGuidanceMode("preview")}
              >
                Preview
              </button>
            </Tooltip>
            <Tooltip label="Edit the guidance Markdown source">
              <button
                className={guidanceMode === "editor" ? "on" : ""}
                aria-pressed={guidanceMode === "editor"}
                onClick={() => setGuidanceMode("editor")}
              >
                Editor
              </button>
            </Tooltip>
          </div>
        </header>
        <div className="persona-guidance-content file-content">
          {guidanceMode === "editor" && (
            <div className="persona-editor-host" aria-label={`Editor for ${markdownPath(draft.name)}`}>
              <FileEditor
                path={markdownPath(draft.name)}
                value={draft.guidanceMarkdown}
                readOnly={readOnly}
                lineSeparator={lineSeparator}
                onChange={(guidanceMarkdown) => edit({ guidanceMarkdown })}
                onBlur={() => {}}
              />
            </div>
          )}
          {guidanceMode === "preview" && (
            <article className="persona-markdown file-markdown-preview markdown">
              {draft.guidanceMarkdown ? <Markdown>{draft.guidanceMarkdown}</Markdown> : <p>Markdown preview appears here.</p>}
            </article>
          )}
        </div>
      </section>
      {footer}
    </article>
  );
}
