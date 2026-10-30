import { useEffect, useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import {
  RESIDENT_AGENTS,
  RESIDENT_LIMITS,
  RESIDENT_MARKER_COLORS,
  RESIDENT_MARKER_LABEL_MAX,
  defaultResidentMarkerLabel,
  residentMarkerColor,
  type ResidentAgent,
  type ResidentProfileRevision,
  type ResidentProfileSectionId,
} from "@shared/residents.ts";
import type { ThinkingLevel } from "@shared/types.ts";
import { personasForDisplay, type PersonaView } from "@shared/workflow.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { RepoCombobox } from "../components/RepoCombobox.tsx";
import { fetchRepos } from "../lib/api.ts";
import { ModelCatalogNotice, ModelCatalogOptions, useHarnessModelCatalogs } from "../model-catalog.tsx";
import { residentAccentStyle } from "./marker.ts";

/** What every section editor is handed. Each writes only its own slice of the draft. */
export interface ResidentEditorSectionProps {
  draft: ResidentProfileRevision;
  update: <K extends ResidentProfileSectionId>(id: K, value: ResidentProfileRevision[K]) => void;
  personas: readonly PersonaView[];
  disabled: boolean;
}

/**
 * One section of the resident profile editor.
 *
 * `id` is the `RESIDENT_PROFILE_SECTIONS` key it edits, so the editor and the schema name the
 * same sections. Later phases append an entry here beside the section they add to the schema;
 * none edits another's entry.
 */
export interface ResidentEditorSection {
  id: ResidentProfileSectionId;
  title: string;
  /** One line under the heading saying what the section decides. */
  blurb: string;
  Body: (props: ResidentEditorSectionProps) => React.JSX.Element;
}

function IdentitySection({ draft, update, disabled }: ResidentEditorSectionProps): React.JSX.Element {
  return (
    <div className="resident-fields">
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="field-input"
          value={draft.identity.name}
          maxLength={RESIDENT_LIMITS.nameLength}
          disabled={disabled}
          placeholder="Triage Bot"
          onChange={(event) => update("identity", { ...draft.identity, name: event.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">
          Description <span className="field-hint">optional</span>
        </span>
        <input
          className="field-input"
          value={draft.identity.description}
          maxLength={RESIDENT_LIMITS.descriptionLength}
          disabled={disabled}
          placeholder="What this resident is for"
          onChange={(event) => update("identity", { ...draft.identity, description: event.target.value })}
        />
      </label>
    </div>
  );
}

function PersonaSection({ draft, update, personas, disabled }: ResidentEditorSectionProps): React.JSX.Element {
  const live = personasForDisplay(personas).filter((persona) => persona.archivedAt === null);
  const selected = personas.find((persona) => persona.id === draft.persona.personaId) ?? null;
  const stranded = draft.persona.personaId && !live.some((persona) => persona.id === draft.persona.personaId);
  return (
    <div className="resident-fields">
      <label className="field">
        <span className="field-label">Persona</span>
        <Tooltip label="The Library Persona whose guidance becomes this resident's standing role">
          <select
            className="field-input"
            value={draft.persona.personaId}
            disabled={disabled}
            onChange={(event) => update("persona", { personaId: event.target.value })}
          >
            <option value="">Choose a Persona…</option>
            {stranded && (
              <option value={draft.persona.personaId} disabled>
                {selected ? `${selected.name} (archived)` : "A Persona that no longer exists"}
              </option>
            )}
            {live.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}{persona.builtin ? " · built-in" : ""}
              </option>
            ))}
          </select>
        </Tooltip>
      </label>
      {selected?.description && <p className="field-hint resident-persona-blurb">{selected.description}</p>}
    </div>
  );
}

function InstructionsSection({ draft, update, disabled }: ResidentEditorSectionProps): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">
        Profile instructions <span className="field-hint">Markdown, after the persona</span>
      </span>
      <textarea
        className="field-input field-textarea resident-instructions"
        value={draft.instructions.markdown}
        maxLength={RESIDENT_LIMITS.instructionsLength}
        disabled={disabled}
        placeholder="Watch the fleet and summarize blockers…"
        onChange={(event) => update("instructions", { markdown: event.target.value })}
      />
    </label>
  );
}

function ExecutionSection({ draft, update, disabled }: ResidentEditorSectionProps): React.JSX.Element {
  const { agent, model, effort } = draft.execution;
  const { resolve: resolveModels } = useHarnessModelCatalogs();
  const levels = capabilitiesFor(agent).effort?.levels ?? [];
  return (
    <div className="resident-fields resident-fields-row">
      <label className="field">
        <span className="field-label">Harness</span>
        <Tooltip label="Which harness runs this resident, always in the Agent SDK">
          <select
            className="field-input"
            value={agent}
            disabled={disabled}
            onChange={(event) =>
              update("execution", { agent: event.target.value as ResidentAgent, model: null, effort: null })}
          >
            {RESIDENT_AGENTS.map((id) => (
              <option key={id} value={id}>{AGENT_IDENTITY[id].label}</option>
            ))}
          </select>
        </Tooltip>
      </label>
      <label className="field">
        <span className="field-label">Model</span>
        <Tooltip label="The model this resident launches with; the harness default when unset">
          <select
            className="field-input"
            value={model ?? ""}
            disabled={disabled}
            onChange={(event) => update("execution", { ...draft.execution, model: event.target.value || null })}
          >
            <option value="">harness default</option>
            <ModelCatalogOptions catalog={resolveModels(agent, model ?? "")} />
          </select>
        </Tooltip>
      </label>
      <label className="field">
        <span className="field-label">Effort</span>
        <Tooltip label="How much reasoning effort each turn spends; the harness default when unset">
          <select
            className="field-input"
            value={effort ?? ""}
            disabled={disabled || levels.length === 0}
            onChange={(event) =>
              update("execution", { ...draft.execution, effort: (event.target.value || null) as ThinkingLevel | null })}
          >
            <option value="">harness default</option>
            {levels.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </Tooltip>
      </label>
      <ModelCatalogNotice agent={agent} />
    </div>
  );
}

function WorkspaceSection({ draft, update, disabled }: ResidentEditorSectionProps): React.JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void fetchRepos().then((list) => {
      if (live) setRepos(list);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="field">
      <label className="field-label" htmlFor="resident-default-repo">
        Default repository <span className="field-hint">pre-filled at launch</span>
      </label>
      <RepoCombobox
        id="resident-default-repo"
        repos={repos}
        value={draft.workspace.defaultRepoRoot ?? ""}
        disabled={disabled}
        onChange={(value) => update("workspace", { defaultRepoRoot: value.trim() ? value : null })}
      />
    </div>
  );
}

function BoardSection({ draft, update, disabled }: ResidentEditorSectionProps): React.JSX.Element {
  const board = draft.board;
  const colorId = residentMarkerColor(board.colorId);
  const derived = defaultResidentMarkerLabel(draft.identity.name);
  return (
    <div className="resident-fields">
      <div className="field">
        <span className="field-label" id="resident-marker-color-label">Marker color</span>
        <div className="resident-swatches" role="radiogroup" aria-labelledby="resident-marker-color-label">
          {RESIDENT_MARKER_COLORS.map((color) => (
            <Tooltip key={color.id} label={`${color.label} border glow`}>
              <button
                type="button"
                role="radio"
                aria-checked={color.id === colorId}
                aria-label={color.label}
                className={`resident-swatch${color.id === colorId ? " active" : ""}`}
                style={residentAccentStyle(color.id)}
                disabled={disabled}
                onClick={() => update("board", { ...board, colorId: color.id })}
              />
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="resident-fields-row">
        <label className="field">
          <span className="field-label">
            Marker label <span className="field-hint">up to {RESIDENT_MARKER_LABEL_MAX} characters</span>
          </span>
          <input
            className="field-input resident-marker-label"
            value={board.label ?? ""}
            maxLength={RESIDENT_MARKER_LABEL_MAX}
            disabled={disabled}
            placeholder={derived}
            onChange={(event) => update("board", { ...board, label: event.target.value.trim() ? event.target.value : null })}
          />
        </label>
        <label className="alert-row resident-pin">
          <Tooltip label="Sort this resident's sessions first in their board column and Console rail group">
            <input
              type="checkbox"
              checked={board.pin}
              disabled={disabled}
              onChange={(event) => update("board", { ...board, pin: event.target.checked })}
            />
          </Tooltip>
          <span>Pin to top of column</span>
        </label>
      </div>
      <p className="field-hint">
        Preview: <span className="resident-chip" style={residentAccentStyle(colorId)} aria-hidden>
          {board.pin && <span className="resident-chip-pin">⤒</span>}
          {board.label?.trim() || derived}
        </span>{" "}
        Running residents keep the marker they launched with.
      </p>
    </div>
  );
}

/**
 * The editor's sections, in order. Phase 1 registers the core five; later phases append
 * theirs (marker, loop, skills, MCP servers, authority) beside the schema section they add.
 */
export const RESIDENT_EDITOR_SECTIONS: readonly ResidentEditorSection[] = [
  {
    id: "identity",
    title: "Identity",
    blurb: "What this resident is called on the board and in Dispatch.",
    Body: IdentitySection,
  },
  {
    id: "persona",
    title: "Persona",
    blurb: "Who the agent is. Its guidance arrives as standing instructions, never as a message.",
    Body: PersonaSection,
  },
  {
    id: "instructions",
    title: "Instructions",
    blurb: "How this profile wants the persona to work, added after its guidance.",
    Body: InstructionsSection,
  },
  {
    id: "execution",
    title: "Harness, model and effort",
    blurb: "Claude Code or Codex, launched in the Agent SDK.",
    Body: ExecutionSection,
  },
  {
    id: "workspace",
    title: "Workspace",
    blurb: "The repository Dispatch suggests. Each launch runs in its own task worktree.",
    Body: WorkspaceSection,
  },
  {
    id: "board",
    title: "Board presence",
    blurb: "How this resident is found: a glowing outline and label chip, and whether it sorts first in its column.",
    Body: BoardSection,
  },
];
