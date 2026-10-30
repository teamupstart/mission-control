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
  residentMcpRefKey,
  type ResidentAgent,
  type ResidentMcpServerRef,
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
import { residentMcpRefTarget, residentMcpSelectable, useResidentMcpCatalog } from "./mcp-catalog.ts";

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
        placeholder="No repository"
        id="resident-default-repo"
        repos={repos}
        value={draft.workspace.defaultRepoRoot ?? ""}
        disabled={disabled}
        onChange={(value) => update("workspace", { defaultRepoRoot: value.trim() ? value : null })}
      />
      <Tooltip label="Clear the default repository for this resident profile">
        <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => update("workspace", { defaultRepoRoot: null })}>No repository</button>
      </Tooltip>
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

function AuthoritySection({ draft, update, disabled }: ResidentEditorSectionProps): React.JSX.Element {
  return (
    <div className="resident-fields">
      <label className="alert-row resident-authority">
        <Tooltip label="Let this resident's run read and steer your other live sessions, when you launch it with a click in the desktop app">
          <input
            type="checkbox"
            checked={draft.authority.controlOtherSessions}
            disabled={disabled}
            onChange={(event) => update("authority", { controlOtherSessions: event.target.checked })}
          />
        </Tooltip>
        <span>Control other sessions</span>
      </label>
      <p className="field-hint">
        Off by default. Only your Launch click in the Mission Control desktop app grants it, to that
        run: it lasts through a restart until the resident's conversation changes or you turn it off
        from its session control menu. A launch from the browser, or from anywhere else, starts
        without session control and says so.
      </p>
    </div>
  );
}

function McpSection({ draft, update, disabled }: ResidentEditorSectionProps): React.JSX.Element {
  const { catalog, error } = useResidentMcpCatalog();
  const [choice, setChoice] = useState("");
  const agent = draft.execution.agent;
  const label = AGENT_IDENTITY[agent].label;
  const mcp = draft.mcp;
  const selectable = residentMcpSelectable(catalog, agent);
  const chosen = new Set(mcp.selected.map(residentMcpRefKey));
  const harness = catalog?.harnesses.find((row) => row.agent === agent) ?? null;
  const options: Array<{ key: string; label: string; ref: ResidentMcpServerRef; group: "global" | "custom"; unavailable: string | null }> = [
    ...(harness?.servers ?? []).map((server) => ({
      ref: { source: "global" as const, agent, name: server.name },
      label: server.name,
      group: "global" as const,
      unavailable: server.unavailable,
    })),
    ...(catalog?.custom ?? [])
      .filter((server) => server.harnesses.includes(agent))
      .map((server) => ({ ref: { source: "custom" as const, id: server.id }, label: server.name, group: "custom" as const, unavailable: null })),
  ]
    .map((option) => ({ ...option, key: residentMcpRefKey(option.ref) }))
    .filter((option) => !chosen.has(option.key));
  const set = (next: typeof mcp): void => update("mcp", next);
  const add = (): void => {
    const option = options.find((candidate) => candidate.key === choice);
    if (!option) return;
    set({ ...mcp, selected: [...mcp.selected, option.ref] });
    setChoice("");
  };
  const locked = disabled || selectable === false;
  return (
    <div className="resident-fields">
      {error && <p role="alert" className="resident-error">{error}</p>}
      {selectable === false && (
        <p className="resident-skill-notice">
          Residents on {label} cannot choose MCP servers: no measured launch control pins the set.
          They start with the harness's own servers.
        </p>
      )}
      <label className="alert-row resident-mcp-inherit">
        <Tooltip label={`Start with every global MCP server ${label} configures at launch, plus the selection below`}>
          <input
            type="checkbox"
            checked={mcp.inheritDefaults}
            disabled={locked}
            onChange={(event) => set({ ...mcp, inheritDefaults: event.target.checked })}
          />
        </Tooltip>
        <span>Inherit harness defaults</span>
      </label>
      <p className="field-hint">
        {mcp.inheritDefaults
          ? `Every global server ${label} has when the resident launches, plus the selection.`
          : "Only the selection."}{" "}
        Mission Control's own server is always attached. A running resident keeps the set it
        launched with.
      </p>
      <ul className="resident-mcp-selected" aria-label="Selected MCP servers">
        {mcp.selected.map((ref, index) => {
          const target = residentMcpRefTarget(catalog, ref);
          const problem = ref.source === "global" && ref.agent !== agent
            ? `belongs to ${AGENT_IDENTITY[ref.agent].label}`
            : catalog && !target
              ? "no longer exists"
              : target?.kind === "global"
                ? target.server.unavailable
                : target?.kind === "custom" && !target.server.harnesses.includes(agent)
                  ? `does not apply to ${label}`
                  : null;
          const name = target?.server.name ?? (ref.source === "global" ? ref.name : "Custom server");
          return (
            <li key={residentMcpRefKey(ref)}>
              <span className="resident-mcp-name">{name}</span>
              <span className="resident-editor-meta">{ref.source === "global" ? "global" : "custom"}</span>
              {problem && <span className="resident-mcp-unavailable">{problem}</span>}
              <Tooltip label={`Remove ${name} from this profile`}>
                <button
                  type="button"
                  className="btn btn-quiet"
                  aria-label={`Remove MCP server ${name}`}
                  disabled={disabled}
                  onClick={() => set({ ...mcp, selected: mcp.selected.filter((_, at) => at !== index) })}
                >
                  Remove
                </button>
              </Tooltip>
            </li>
          );
        })}
        {mcp.selected.length === 0 && <li className="resident-section-blurb">None selected.</li>}
      </ul>
      <div className="resident-mcp-add">
        <label className="field">
          <span className="field-label">Add an MCP server</span>
          <Tooltip label={`A global server ${label} configures, or a custom server that applies to ${label}`}>
            <select className="field-input" value={choice} disabled={locked || options.length === 0} onChange={(event) => setChoice(event.target.value)}>
              <option value="">{catalog ? (options.length ? "Choose a server…" : "No more servers") : "Loading…"}</option>
              <optgroup label={`${label} global`}>
                {options.filter((option) => option.group === "global").map((option) => (
                  <option key={option.key} value={option.key} disabled={option.unavailable !== null}>
                    {option.label}{option.unavailable ? " (unavailable)" : ""}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Custom">
                {options.filter((option) => option.group === "custom").map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </optgroup>
            </select>
          </Tooltip>
        </label>
        <Tooltip label="Add the chosen server to this profile">
          <button type="button" className="btn" disabled={locked || !choice} onClick={add}>Add</button>
        </Tooltip>
      </div>
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
    blurb: "Choose a repository for a task worktree, or no repository for a private directory removed when the run ends.",
    Body: WorkspaceSection,
  },
  {
    id: "board",
    title: "Board presence",
    blurb: "How this resident is found: a glowing outline and label chip, and whether it sorts first in its column.",
    Body: BoardSection,
  },
  {
    id: "authority",
    title: "Authority",
    blurb: "What this resident may do beyond its own session.",
    Body: AuthoritySection,
  },
  {
    id: "mcp",
    title: "MCP servers",
    blurb: "Which MCP servers the resident starts with, from its harness's global servers and your custom ones.",
    Body: McpSection,
  },
];
