import { useEffect, useState } from "react";
import { ResidentDrawerInertNote } from "../components/ResidentPlacementPanel.tsx";
import { residentModelSpendAvailable } from "@shared/resident-spend.ts";
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
import { McpAllSourcesConfirm } from "./McpAllSourcesConfirm.tsx";
import { residentMcpRefTarget, residentMcpSelectable, useResidentMcpCatalog } from "./mcp-catalog.ts";

/** What every section editor is handed. Each writes only its own slice of the draft. */
export interface ResidentEditorSectionProps {
  draft: ResidentProfileRevision;
  update: <K extends ResidentProfileSectionId>(id: K, value: ResidentProfileRevision[K]) => void;
  personas: readonly PersonaView[];
  disabled: boolean;
  /** Resolved by the editor using the same default ladder as launch. */
  spendUnavailable?: string | null;
  /** Open the Library's blank Persona editor. Absent where the editor cannot navigate. */
  onCreatePersona?: () => void;
}

/**
 * The Persona picker's last option. A `<select>` cannot hold a link, so choosing this option
 * navigates instead of writing the draft; the draft keeps the Persona it already had.
 */
const CREATE_PERSONA_OPTION = "__create-persona__";

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

function PersonaSection({ draft, update, personas, disabled, onCreatePersona }: ResidentEditorSectionProps): React.JSX.Element {
  const live = personasForDisplay(personas).filter((persona) => persona.archivedAt === null);
  const selected = personas.find((persona) => persona.id === draft.persona.personaId) ?? null;
  const stranded = draft.persona.personaId && !live.some((persona) => persona.id === draft.persona.personaId);
  return (
    <div className="resident-fields">
      <label className="field">
        <span className="field-label">
          Persona <span className="field-hint">optional</span>
        </span>
        <Tooltip label="The Library Persona whose guidance becomes this resident's standing role, or none to run on the profile instructions alone">
          <select
            className="field-input"
            value={draft.persona.personaId}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value === CREATE_PERSONA_OPTION) onCreatePersona?.();
              else update("persona", { personaId: event.target.value });
            }}
          >
            <option value="">No Persona</option>
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
            {onCreatePersona && <option value={CREATE_PERSONA_OPTION}>＋ Create a new Persona…</option>}
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
        Profile instructions <span className="field-hint">Markdown, after any Persona</span>
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

function ExecutionSection({ draft, update, disabled, spendUnavailable }: ResidentEditorSectionProps): React.JSX.Element {
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
            id="resident-model"
            aria-describedby={spendUnavailable ? "resident-model-spend" : undefined}
            aria-invalid={!!spendUnavailable && draft.loop.spendCapUsd !== null}
            value={model ?? ""}
            disabled={disabled}
            onChange={(event) => update("execution", { ...draft.execution, model: event.target.value || null })}
          >
            <option value="">harness default</option>
            <ModelCatalogOptions catalog={resolveModels(agent, model ?? "")}
              optionSuffix={(choice) => residentModelSpendAvailable(agent, choice.id) ? null : "spend cap unavailable"} />
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
      {spendUnavailable && <p id="resident-model-spend" className="field-hint resident-problem" role="status">
        {spendUnavailable}
      </p>}
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

/**
 * The board card this profile's next launch draws: its glow, its chip, and where it sorts. A pinned
 * resident sits above its neighbours, so the preview shows the pin as an order, not only a glyph.
 */
function ResidentBoardPreview({ draft }: { draft: ResidentProfileRevision }): React.JSX.Element {
  const { board, execution } = draft;
  const label = board.label?.trim() || defaultResidentMarkerLabel(draft.identity.name);
  const neighbour = <div className="resident-board-preview-ghost" aria-hidden />;
  return (
    <div className="resident-board-preview" role="group" aria-label="Board card preview">
      {!board.pin && neighbour}
      <div className="resident-board-preview-card" style={residentAccentStyle(residentMarkerColor(board.colorId))}>
        <span className="resident-chip">
          {board.pin && <span className="resident-chip-pin" aria-label="pinned">⤒</span>}
          {label}
        </span>
        <strong className="resident-board-preview-name">{draft.identity.name.trim() || "New resident"}</strong>
        <span className="resident-board-preview-meta">
          {AGENT_IDENTITY[execution.agent].label} · {execution.model ?? "harness default"}
        </span>
      </div>
      {neighbour}
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
      <ResidentDrawerInertNote what="Pin to top of column" />
      <ResidentBoardPreview draft={draft} />
      <p className="field-hint">Running residents keep the marker they launched with.</p>
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
  const [confirmingAll, setConfirmingAll] = useState(false);
  const agent = draft.execution.agent;
  const label = AGENT_IDENTITY[agent].label;
  const mcp = draft.mcp;
  const selectable = residentMcpSelectable(catalog, agent);
  // Whether this harness can start a resident on everything it loads natively. A profile that
  // chose it on another harness still shows the choice, so the operator can see and undo it.
  const allSources = capabilitiesFor(agent).mcpSelection?.allNativeSources ?? null;
  const importsAll = mcp.nativeSources === "all";
  const chosen = new Set(mcp.selected.map(residentMcpRefKey));
  const harness = catalog?.harnesses.find((row) => row.agent === agent) ?? null;
  const options: Array<{ key: string; label: string; ref: ResidentMcpServerRef; group: "global" | "custom"; unavailable: string | null }> = [
    // With all native sources the harness loads its global servers itself: only custom ones add.
    ...(importsAll ? [] : harness?.servers ?? []).map((server) => ({
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
      {(allSources || importsAll) && (
        <fieldset className="resident-mcp-sources">
          <legend className="field-label">Server set</legend>
          <label className="alert-row">
            <Tooltip label="Start on the exact set this profile resolves at launch, which every resume keeps">
              <input
                type="radio"
                name="resident-mcp-native-sources"
                checked={!importsAll}
                disabled={locked}
                onChange={() => set({ ...mcp, nativeSources: "pinned" })}
              />
            </Tooltip>
            <span>Pinned at launch</span>
          </label>
          <label className="alert-row">
            <Tooltip label={allSources ? `Start on everything ${label} loads natively, read again at every start` : `${label} cannot start a resident on all of its native MCP sources`}>
              <input
                type="radio"
                name="resident-mcp-native-sources"
                checked={importsAll}
                disabled={locked || !allSources}
                // Widening an autonomous resident's reach is confirmed first; the radio stays on
                // Pinned until the operator says yes.
                onChange={() => setConfirmingAll(true)}
              />
            </Tooltip>
            <span>All native sources (not pinned)</span>
          </label>
        </fieldset>
      )}
      {importsAll && allSources && (
        <div>
          <label className="alert-row">
            <Tooltip label="Keep plugin MCP servers enabled while disabling all claude.ai connectors for this resident">
              <input
                type="checkbox"
                checked={mcp.disableClaudeAiConnectors === true}
                disabled={locked}
                onChange={(event) => set({ ...mcp, disableClaudeAiConnectors: event.target.checked })}
              />
            </Tooltip>
            <span>Disable claude.ai connectors</span>
          </label>
          <p className="field-hint">
            Use this if plugin MCP tools disappear because they duplicate claude.ai connectors.
            Installed plugin servers still load. All claude.ai connectors are disabled for this
            resident, including Claude Docs. Applies on the next launch.
          </p>
        </div>
      )}
      {importsAll ? (
        allSources ? (
          <p className="field-hint">
            {label} loads its native MCP configuration at every start, with the connector preference above, so
            the global servers it configures need no inheriting or selecting. Mission Control's own
            server and the custom servers below are always attached, and only they must connect
            before the resident starts. The set is not pinned: a native change reaches a running
            resident at its next start or resume.
          </p>
        ) : (
          <p role="alert" className="field-hint resident-problem resident-mcp-unavailable">
            {label} cannot start a resident on all of its native MCP sources. Choose Pinned at launch
            to save this profile.
          </p>
        )
      ) : (
        <>
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
        </>
      )}
      <ul className="resident-mcp-selected" aria-label="Selected MCP servers">
        {mcp.selected.map((ref, index) => {
          const target = residentMcpRefTarget(catalog, ref);
          const problem = ref.source === "global" && ref.agent !== agent
            ? `belongs to ${AGENT_IDENTITY[ref.agent].label}`
            : catalog && !target
              ? "no longer exists"
              : target?.kind === "global"
                ? importsAll ? null : target.server.unavailable
                : target?.kind === "custom" && !target.server.harnesses.includes(agent)
                  ? `does not apply to ${label}`
                  : null;
          const name = target?.server.name ?? (ref.source === "global" ? ref.name : "Custom server");
          return (
            <li key={residentMcpRefKey(ref)}>
              <span className="resident-mcp-name">{name}</span>
              <span className="resident-editor-meta">{ref.source === "global" ? "global" : "custom"}</span>
              {problem && <span className="resident-mcp-unavailable">{problem}</span>}
              {!problem && importsAll && ref.source === "global" && (
                <span className="resident-editor-meta">loads natively</span>
              )}
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
          <Tooltip label={importsAll ? `A custom server that applies to ${label}` : `A global server ${label} configures, or a custom server that applies to ${label}`}>
            <select className="field-input" value={choice} disabled={locked || options.length === 0} onChange={(event) => setChoice(event.target.value)}>
              <option value="">{catalog ? (options.length ? "Choose a server…" : "No more servers") : "Loading…"}</option>
              {!importsAll && (
                <optgroup label={`${label} global`}>
                  {options.filter((option) => option.group === "global").map((option) => (
                    <option key={option.key} value={option.key} disabled={option.unavailable !== null}>
                      {option.label}{option.unavailable ? " (unavailable)" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
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
      {confirmingAll && allSources && (
        <McpAllSourcesConfirm
          harness={label}
          sources={allSources.sources}
          onClose={() => setConfirmingAll(false)}
          onConfirm={() => {
            setConfirmingAll(false);
            set({ ...mcp, nativeSources: "all" });
          }}
        />
      )}
    </div>
  );
}

function ResidentLoopSection({ draft, update, disabled, spendUnavailable }: ResidentEditorSectionProps): React.JSX.Element {
  const loop = draft.loop;
  const numeric = [
    ["delaySeconds", "Wake cadence (seconds)"], ["minDelaySeconds", "Minimum requested delay (seconds)"],
    ["maxDelaySeconds", "Maximum requested delay (seconds)"], ["iterationCap", "Iterations per 24 hours"],
    ["spendCapUsd", "Spend per 24 hours (USD)"], ["contextThreshold", "Compact at context (%)"],
  ] as const;
  return <div className="resident-fields resident-loop">
    <div className="resident-loop-text">
      <label className="field"><span className="field-label">Loop prompt</span>
        <textarea className="field-input" value={loop.prompt} disabled={disabled}
          onChange={(e) => update("loop", { ...loop, prompt: e.target.value })} />
      </label>
      <label className="field"><span className="field-label">Compaction focus</span>
        <input className="field-input" value={loop.compactionFocus} disabled={disabled}
          onChange={(e) => update("loop", { ...loop, compactionFocus: e.target.value })} />
      </label>
      <p className="field-hint">Compaction before wakes is active. Native backstop: {capabilitiesFor(draft.execution.agent).residentCompaction?.nativeBackstop ? "active" : "unavailable on this harness"}.</p>
      <p className="field-hint">Guardrails pause the resident. Clear a cap to disable it. Profile edits apply on the next launch.</p>
    </div>
    <div className="resident-loop-limits">
      {numeric.map(([key, label]) => <label className="field resident-loop-limit" key={key}>
        <span className="field-label">{label}</span>
        <input className="field-input" type="number" min="1" step={key === "spendCapUsd" ? "0.01" : "1"}
          id={key === "spendCapUsd" ? "resident-spend-cap" : undefined}
          aria-describedby={key === "spendCapUsd" && spendUnavailable ? "resident-cap-spend" : undefined}
          aria-invalid={key === "spendCapUsd" && !!spendUnavailable && loop.spendCapUsd !== null}
          value={loop[key] ?? ""} disabled={disabled}
          onChange={(e) => update("loop", { ...loop, [key]: e.target.value === "" && (key === "iterationCap" || key === "spendCapUsd") ? null : Number(e.target.value) })} />
      </label>)}
    </div>
    {spendUnavailable && <div className="field resident-loop-spend">
      <p id="resident-cap-spend" className="field-hint resident-problem" role="status">{spendUnavailable}</p>
      {loop.spendCapUsd !== null && <Tooltip label="Disable the spend guardrail for future launches; keep the selected model">
        <button type="button" className="btn btn-ghost" disabled={disabled}
          onClick={() => update("loop", { ...loop, spendCapUsd: null })}>Clear spend cap</button>
      </Tooltip>}
    </div>}
  </div>;
}

/**
 * The editor's sections, in reading order. Phase 1 registered the core five; later phases append
 * theirs (marker, loop, skills, MCP servers, authority) beside the schema section they add.
 *
 * The editor lays these out as a card grid, and this order is the grid's reading and tab order:
 * each band reads its wide left card before its narrow right one. A section the grid does not
 * place spans the full width after the rest, so appending one needs no layout change.
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
    blurb: "Who the agent is, if a Library Persona says it. Its guidance arrives as standing instructions, never as a message.",
    Body: PersonaSection,
  },
  {
    id: "board",
    title: "Board presence",
    blurb: "How this resident is found: a glowing outline and label chip, and whether it sorts first in its column.",
    Body: BoardSection,
  },
  {
    id: "instructions",
    title: "Instructions",
    blurb: "How this profile wants the resident to work, added after any Persona's guidance. Without a Persona, these are its whole role.",
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
  { id: "loop", title: "Loop and guardrails", blurb: "Cadence, self-pacing and rolling 24-hour limits.", Body: ResidentLoopSection },
  {
    id: "mcp",
    title: "MCP servers",
    blurb: "Which MCP servers the resident starts with: a pinned set from its harness's global servers and your custom ones, or, where the harness offers it, everything it loads natively.",
    Body: McpSection,
  },
  {
    id: "authority",
    title: "Authority",
    blurb: "What this resident may do beyond its own session.",
    Body: AuthoritySection,
  },
];
