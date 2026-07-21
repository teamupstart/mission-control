import { AGENT_TYPES, type AgentType, type ThinkingLevel } from "@shared/types.ts";
import { AGENT_IDENTITY, agentList } from "@shared/agent.ts";
import { autoModeAgents, autoModeUnsupportedWhy, capabilitiesFor } from "@shared/harness-capabilities.ts";
import { modelChoicesFor } from "@shared/model.ts";
import { permissionModeDisplay } from "../lib/format.ts";
import type { HarnessesState } from "../useHarnesses.ts";

// The Harnesses settings section: defaults the app applies to the sessions IT
// launches - the auto-mode master toggle, then one default-model row per harness.
// The master-toggle shape is the skills/Foreman pattern - an `.alert-row` checkbox
// styled as a switch - because that is what this is: a durable on/off that changes
// what happens to every future dispatch.

/**
 * One default-model row per harness, derived from the union rather than listed here.
 *
 * A hand-kept list is how a harness ends up dispatchable but unconfigurable: it would
 * launch with whatever `--model` default the code picks and the operator would have no
 * row to change it in, with nothing failing to compile to say so. Order is
 * `AGENT_TYPES`' order, which is the order this section has always shown.
 */
const MODEL_ROWS: { agent: AgentType; label: string }[] = AGENT_TYPES.map((agent) => ({
  agent,
  label: AGENT_IDENTITY[agent].label,
}));

/**
 * Who the auto-mode switch reaches, and who it leaves alone - read off the
 * `permissionModes.onDispatch` capability rather than off the word "claude".
 *
 * Every sentence on that row named an agent, and each was its own literal ("claude
 * only", "Every Claude session…", "Codex support comes later"). A third harness would
 * have left all three describing a grid that no longer matches, with nothing failing to
 * compile to say so - and "Codex support comes later" is a promise this panel is in no
 * position to make on the harness's behalf.
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
 * One harness's default-model picker. The empty value is a real choice, not a
 * placeholder: it means Mission Control passes no `--model` at all, leaving the CLI
 * on whatever the operator configured in the harness itself - so the row can always
 * be put back to "don't interfere", which is how it ships.
 */
function DefaultModelRow({
  agent,
  label,
  value,
  disabled,
  onChange,
}: {
  agent: AgentType;
  label: string;
  value: string | null;
  disabled: boolean;
  onChange: (id: string | null) => void;
}): React.JSX.Element {
  return (
    <div className="kb-row harnesses-row">
      <div className="kb-row-text">
        <span className="kb-row-label">{label}</span>
        <span className="kb-row-desc">
          {value
            ? `Dispatched ${label} sessions are launched with --model ${value}.`
            : `Dispatched ${label} sessions are launched with no --model flag, so ${label} uses its own configured model.`}
        </span>
      </div>
      <div className="kb-row-controls">
        <select
          className="harnesses-select"
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label={`Default model for dispatched ${label} sessions`}
        >
          <option value="">Harness default</option>
          {/* `value` is passed as `extra` so a default set by another build stays
              selectable here instead of reading as "no model chosen" - and so
              picking a different row can't silently drop it. */}
          {modelChoicesFor(agent, value).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} - {m.hint}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DefaultEffortRow({
  agent,
  label,
  value,
  disabled,
  onChange,
}: {
  agent: AgentType;
  label: string;
  value: ThinkingLevel | null;
  disabled: boolean;
  onChange: (level: ThinkingLevel | null) => void;
}): React.JSX.Element {
  return (
    <div className="kb-row harnesses-row">
      <div className="kb-row-text">
        <span className="kb-row-label">{label}</span>
        <span className="kb-row-desc">
          {value
            ? `Dispatched ${label} sessions start with ${value} reasoning effort.`
            : `Dispatched ${label} sessions keep the effort configured by ${label}.`}
        </span>
      </div>
      <div className="kb-row-controls">
        <select
          className="harnesses-select"
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onChange((e.target.value || null) as ThinkingLevel | null)}
          aria-label={`Default effort for dispatched ${label} sessions`}
        >
          <option value="">Harness default</option>
          {capabilitiesFor(agent).effort?.levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
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
      <div className="settings-section-head">
        <h3>Harnesses</h3>
      </div>

      <p className="settings-hint settings-blurb">
        Defaults for the agents Mission Control <strong>dispatches</strong>. These never touch
        sessions you started yourself and the app merely discovered - only the ones it launches.
      </p>

      {error && <p className="settings-error">{error}</p>}

      <div className="kb-row harnesses-row">
        <div className="kb-row-text">
          <span className="kb-row-label">
            Auto mode on dispatch
            {AUTO_EXCLUDED.length > 0 && (
              <span
                className="skill-badge skill-badge-agent"
                title={AUTO_EXCLUDED.map((a) => autoModeUnsupportedWhy(a)).join(" ")}
              >
                {AUTO_AGENTS.join(" / ")} only
              </span>
            )}
          </span>
          <span className="kb-row-desc">
            Every {AUTO_LABEL} session dispatched from Mission Control is switched to{" "}
            <strong>{AUTO_MODE_LABEL ?? "its most autonomous"}</strong> permission mode once it's
            ready, so it works through its task without stopping for permission prompts.
          </span>
        </div>
        <div className="kb-row-controls">
          <label className="skill-switch">
            <input
              type="checkbox"
              checked={autoMode}
              disabled={!config}
              onChange={(e) => void update({ autoModeOnDispatch: e.target.checked })}
              aria-label={`Put every dispatched ${AUTO_LABEL} session into ${AUTO_MODE_LABEL ?? "its most autonomous"} mode`}
            />
          </label>
        </div>
      </div>

      <div className="settings-section-head harnesses-subhead">
        <h4>Default model</h4>
      </div>
      <p className="settings-hint harnesses-blurb">
        The model each harness is launched on when a dispatch doesn't name one. The
        dispatch form starts on this and lets you pick a different model per task, so a
        one-off that needs more (or less) horsepower doesn't mean changing the default.
      </p>
      {MODEL_ROWS.map((row) => (
        <DefaultModelRow
          key={row.agent}
          agent={row.agent}
          label={row.label}
          value={config?.defaultModel[row.agent] ?? null}
          disabled={!config}
          onChange={(id) => void update({ defaultModel: { [row.agent]: id } })}
        />
      ))}

      <div className="settings-section-head harnesses-subhead">
        <h4>Default effort</h4>
      </div>
      <p className="settings-hint harnesses-blurb">
        The reasoning effort each harness starts with when a dispatch doesn't name one.
        Each task can override this immediately after its model selection.
      </p>
      {MODEL_ROWS.map((row) => (
        <DefaultEffortRow
          key={row.agent}
          agent={row.agent}
          label={row.label}
          value={config?.defaultEffort[row.agent] ?? null}
          disabled={!config}
          onChange={(level) => void update({ defaultEffort: { [row.agent]: level } })}
        />
      ))}
    </section>
  );
}
