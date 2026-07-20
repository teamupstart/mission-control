import type { AgentType } from "@shared/types.ts";
import { modelChoicesFor } from "@shared/model.ts";
import type { HarnessesState } from "../useHarnesses.ts";

// The Harnesses settings section: defaults the app applies to the sessions IT
// launches - the auto-mode master toggle, then one default-model row per harness.
// The master-toggle shape is the skills/Foreman pattern - an `.alert-row` checkbox
// styled as a switch - because that is what this is: a durable on/off that changes
// what happens to every future dispatch.

/** The label and blurb for one harness's default-model row. */
const MODEL_ROWS: { agent: AgentType; label: string }[] = [
  { agent: "claude", label: "Claude Code" },
  { agent: "codex", label: "Codex" },
];

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
            <span
              className="skill-badge skill-badge-agent"
              title="Codex has no permission mode, so codex dispatches are unaffected for now."
            >
              claude only
            </span>
          </span>
          <span className="kb-row-desc">
            Every Claude session dispatched from Mission Control is switched to{" "}
            <strong>auto</strong> permission mode once it's ready, so it works through its task
            without stopping for permission prompts. Codex support comes later.
          </span>
        </div>
        <div className="kb-row-controls">
          <label className="skill-switch">
            <input
              type="checkbox"
              checked={autoMode}
              disabled={!config}
              onChange={(e) => void update({ autoModeOnDispatch: e.target.checked })}
              aria-label="Put every dispatched Claude session into auto mode"
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
    </section>
  );
}
