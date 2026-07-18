import type { HarnessesState } from "../useHarnesses.ts";

// The Harnesses settings section: defaults the app applies to the sessions IT
// launches. The master-toggle shape is the skills/Foreman pattern - an `.alert-row`
// checkbox styled as a switch - because that is what this is: a durable on/off that
// changes what happens to every future dispatch.

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

      <p className="settings-hint harnesses-blurb">
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
    </section>
  );
}
