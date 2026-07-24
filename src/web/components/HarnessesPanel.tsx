import { AGENT_TYPES, type AgentType, type ThinkingLevel } from "@shared/types.ts";
import { AGENT_IDENTITY, agentList } from "@shared/agent.ts";
import { autoModeAgents, autoModeUnsupportedWhy, capabilitiesFor } from "@shared/harness-capabilities.ts";
import { modelChoicesFor } from "@shared/model.ts";
import { permissionModeDisplay } from "../lib/format.ts";
import type { HarnessesState } from "../useHarnesses.ts";
import { AgentDot, agentAccentStyle } from "./session-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The Harnesses settings section: defaults the app applies to the sessions IT
// launches - the auto-mode master toggle, then ONE CARD PER HARNESS carrying that
// harness's model and effort together, its accent, a capability-derived badge, and a
// sentence restating what a dispatch will actually do.
//
// Cards, not two parallel per-setting lists: a harness's model and its effort are one
// harness's defaults, and the old layout drew each harness twice - once under "Default
// model", once under "Default effort" - so reading "what will a dispatched Codex do"
// meant scanning two lists and joining them by eye. A card is that join, drawn. The
// master-toggle shape above them stays the skills/Foreman pattern - an `.alert-row`
// checkbox styled as a switch - because that is what it is: a durable on/off that
// changes what happens to every future dispatch.

/**
 * One card per harness, derived from the union rather than listed here.
 *
 * A hand-kept list is how a harness ends up dispatchable but missing its settings card,
 * with nothing failing to compile to say so. Order is `AGENT_TYPES`' order, which is
 * the order this section has always shown.
 */
const HARNESS_CARDS: { agent: AgentType; label: string }[] = AGENT_TYPES.map((agent) => ({
  agent,
  label: AGENT_IDENTITY[agent].label,
}));

/**
 * Who the auto-mode switch reaches through a permission-mode launch flag, and who it
 * does not - read off `permissionModes.onDispatch` plus its launch renderer rather than
 * off the word "claude". Other harness-specific launch postures are outside this list.
 *
 * Every sentence on that row named an agent, and each was its own literal ("claude
 * only", "Every Claude session…", "Codex support comes later"). Pi would have left all
 * three describing a grid that no longer matched, with nothing failing to compile to say
 * so - and "Codex support comes later" is a promise this panel is in no position to make
 * on the harness's behalf.
 */
const AUTO_AGENTS = autoModeAgents();
const AUTO_LABEL = agentList(AUTO_AGENTS, "and");
const AUTO_EXCLUDED = AGENT_TYPES.filter((a) => !AUTO_AGENTS.includes(a));

/**
 * What "auto mode" is called, when every harness it reaches calls it the same thing.
 *
 * Null when they disagree, and the sentence then falls back to "its most autonomous"
 * rather than naming one harness's spelling over another's - the alternative being a
 * settings row that promises a mode half the grid does not have.
 */
const AUTO_MODE_LABEL = ((): string | null => {
  const labels = new Set(
    AUTO_AGENTS.map((a) => permissionModeDisplay(capabilitiesFor(a).permissionModes!.onDispatch)?.label),
  );
  return labels.size === 1 ? ([...labels][0] ?? null) : null;
})();

/**
 * The badge on a harness's card, capability-derived and never a literal harness name.
 *
 * Two mutually exclusive states, both read off the same permission-mode launch
 * capability:
 *  - a harness this capability REACHES wears "auto mode on" only while the switch is on,
 *    so the card says what a dispatch will do right now rather than what it could;
 *  - a harness this capability DOES NOT REACH wears "no auto mode", carrying
 *    `autoModeUnsupportedWhy` as its title - the sentence saying which of the two
 *    absences this is - so the reason is on the card, not just in the master row.
 */
function CardBadge({
  agent,
  label,
  autoMode,
}: {
  agent: AgentType;
  label: string;
  autoMode: boolean;
}): React.JSX.Element | null {
  const why = autoModeUnsupportedWhy(agent);
  if (why) {
    return (
      <Tooltip label={why}>
        <span className="skill-badge skill-badge-agent">no auto mode</span>
      </Tooltip>
    );
  }
  if (!autoMode) return null;
  return (
    <Tooltip
      label={`Dispatched ${label} sessions launch in ${AUTO_MODE_LABEL ?? "their most autonomous"} permission mode via a launch flag, even while a folder-trust dialog hides the mode footer.`}
    >
      <span className="skill-badge skill-badge-always-on">auto mode on</span>
    </Tooltip>
  );
}

/**
 * One harness's card: its default model and effort together, and a sentence composed
 * from the current values restating what a dispatch will do.
 *
 * The empty model value is a real choice, not a placeholder: it means Mission Control
 * passes no `--model` at all, leaving the CLI on whatever the operator configured in the
 * harness itself - so the card can always be put back to "don't interfere", which is how
 * it ships. Same for effort: blank keeps whatever the harness has.
 */
function HarnessCard({
  agent,
  label,
  model,
  effort,
  autoMode,
  disabled,
  onModel,
  onEffort,
}: {
  agent: AgentType;
  label: string;
  model: string | null;
  effort: ThinkingLevel | null;
  autoMode: boolean;
  disabled: boolean;
  onModel: (id: string | null) => void;
  onEffort: (level: ThinkingLevel | null) => void;
}): React.JSX.Element {
  const modelId = `harness-model-${agent}`;
  const effortId = `harness-effort-${agent}`;
  return (
    <div className="harness-card" data-anchor={`harnesses/${agent}`} style={agentAccentStyle(agent)}>
      <div className="harness-card-head">
        <AgentDot agent={agent} />
        <b className="harness-card-name">{label}</b>
        <span className="harness-card-spacer" />
        <CardBadge agent={agent} label={label} autoMode={autoMode} />
      </div>
      <div className="harness-card-grid">
        <label className="harness-card-field-label" htmlFor={modelId}>
          Model
        </label>
        <Tooltip label={`Which model every dispatched ${label} session launches with`}>
          <select
            id={modelId}
            className="harnesses-select"
            value={model ?? ""}
            disabled={disabled}
            onChange={(e) => onModel(e.target.value || null)}
            aria-label={`Default model for dispatched ${label} sessions`}
          >
            <option value="">Harness default</option>
            {/* `model` is passed as `extra` so a default set by another build stays
                selectable here instead of reading as "no model chosen" - and so
                picking a different row can't silently drop it. */}
            {modelChoicesFor(agent, model).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} - {m.hint}
              </option>
            ))}
          </select>
        </Tooltip>
        <label className="harness-card-field-label" htmlFor={effortId}>
          Effort
        </label>
        <Tooltip label={`How much reasoning effort every dispatched ${label} session starts with`}>
          <select
            id={effortId}
            className="harnesses-select"
            value={effort ?? ""}
            disabled={disabled}
            onChange={(e) => onEffort((e.target.value || null) as ThinkingLevel | null)}
            aria-label={`Default effort for dispatched ${label} sessions`}
          >
            <option value="">Harness default</option>
            {capabilitiesFor(agent).effort?.levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Tooltip>
      </div>
      <p className="harness-card-note">
        {model
          ? `Dispatched ${label} sessions are launched with --model ${model}.`
          : `Dispatched ${label} sessions are launched with no --model flag, so ${label} uses its own configured model.`}{" "}
        {effort
          ? `They start with ${effort} reasoning effort.`
          : `Effort stays whatever ${label} has configured.`}
      </p>
    </div>
  );
}

export function HarnessesPanel({ state }: { state: HarnessesState }): React.JSX.Element {
  const { config, update, error } = state;
  // `config` is null only in the pre-poll instant; the switch reads off (its shipped
  // default) and disables until the first read lands, so a toggle can't race the fetch.
  const autoMode = config?.autoModeOnDispatch ?? false;

  return (
    <section className="settings-section">
      <p className="settings-hint settings-blurb">
        Defaults for the agents Mission Control <strong>dispatches</strong>. These never touch
        sessions you started yourself and the app merely discovered - only the ones it launches.
      </p>

      {error && <p className="settings-error">{error}</p>}

      <div className="kb-row harnesses-row" data-anchor="harnesses/auto-mode">
        <div className="kb-row-text">
          <span className="kb-row-label">
            Auto mode on dispatch
            {AUTO_EXCLUDED.length > 0 && (
              <Tooltip label={AUTO_EXCLUDED.map((a) => autoModeUnsupportedWhy(a)).join(" ")}>
                <span className="skill-badge skill-badge-agent">
                  {AUTO_AGENTS.join(" / ")} only
                </span>
              </Tooltip>
            )}
          </span>
          <span className="kb-row-desc">
            Every {AUTO_LABEL} session dispatched from Mission Control launches directly in{" "}
            <strong>{AUTO_MODE_LABEL ?? "its most autonomous"}</strong> permission mode via a
            launch flag, so the mode is set even while a folder-trust dialog hides the mode
            footer.
          </span>
        </div>
        <div className="kb-row-controls">
          <Tooltip
            label={`Launch every dispatched ${AUTO_LABEL} session directly in ${AUTO_MODE_LABEL ?? "its most autonomous"} mode via a launch flag`}
          >
            <label className="skill-switch">
              <input
                type="checkbox"
                checked={autoMode}
                disabled={!config}
                onChange={(e) => void update({ autoModeOnDispatch: e.target.checked })}
                aria-label={`Put every dispatched ${AUTO_LABEL} session into ${AUTO_MODE_LABEL ?? "its most autonomous"} mode`}
              />
            </label>
          </Tooltip>
        </div>
      </div>

      <div className="settings-section-head harnesses-subhead">
        <h4>Per harness</h4>
      </div>
      <div className="harness-cards">
        {HARNESS_CARDS.map((card) => (
          <HarnessCard
            key={card.agent}
            agent={card.agent}
            label={card.label}
            model={config?.defaultModel[card.agent] ?? null}
            effort={config?.defaultEffort[card.agent] ?? null}
            autoMode={autoMode}
            disabled={!config}
            onModel={(id) => void update({ defaultModel: { [card.agent]: id } })}
            onEffort={(level) => void update({ defaultEffort: { [card.agent]: level } })}
          />
        ))}
      </div>
      <p className="settings-hint harnesses-cards-hint">
        The dispatch form starts on these values and lets you pick a different model and
        effort per task, so a one-off that needs more (or less) horsepower doesn't mean
        changing the default.
      </p>
    </section>
  );
}
