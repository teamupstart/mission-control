import { COST_EXPORT_INTERVAL_MAX_MS, COST_EXPORT_INTERVAL_MIN_MS } from "@shared/protocol.ts";
import type { CostState } from "../useCost.ts";
import { Tooltip } from "./Tooltip.tsx";

// The Cost settings section: whether we ask Claude Code for its API-equivalent estimate,
// how often, and how that joins automatic Codex estimates in one fleet total.
//
// The master toggle here is unlike the other panels' toggles in one way worth being
// careful about: it does not change what the daemon does with data it already has, it
// EDITS `~/.claude/settings.json` - adding an `env` block that makes every Claude Code
// session on the machine export usage to the daemon. Hence the file path is named on
// screen, the blurb says what gets written, and the panel reports what is actually in the
// file rather than what the config wishes were there.

/** Intervals offered, in ms. Anything the schema would refuse never reaches the daemon. */
const INTERVALS = [5_000, 10_000, 15_000, 30_000, 60_000].filter(
  (ms) => ms >= COST_EXPORT_INTERVAL_MIN_MS && ms <= COST_EXPORT_INTERVAL_MAX_MS,
);

export function CostSettingsPanel({ state }: { state: CostState }): React.JSX.Element {
  const { status, update, error } = state;
  const config = status?.config ?? null;
  // `status` is null only in the pre-poll instant; the switch reads off (its shipped
  // default) and disables until the first read lands, so a toggle can't race the fetch.
  const enabled = config?.enabled ?? false;

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Cost</h3>
      </div>

      <p className="settings-hint settings-blurb">
        Claude Code calculates an estimated API cost from its request usage and reports it
        over OpenTelemetry. Mission Control applies versioned OpenAI Standard API rates to
        Codex rollout usage. Both feed one <strong>API-equivalent estimate</strong>:
        it is not Pro, Max, or ChatGPT plan spend, credits consumed, or an invoice.
      </p>

      {error && <p className="settings-error">{error}</p>}

      {status?.config.enabled && status.installed && !status.receiving && (
        // The ordinary first-run state, and the one a switch alone cannot explain: the env
        // block only reaches sessions started AFTER it was written, so everything is
        // correctly configured and the dashboard still has no numbers on it. Saying so
        // beats leaving someone to conclude the feature is broken.
        <p className="settings-hint">
          No Claude telemetry has reported yet. The <code>env</code> block only applies to
          sessions started after it was written. Codex estimates do not depend on this toggle.
        </p>
      )}

      {status?.sessionIdDisabled && (
        <p className="settings-error">
          <code>OTEL_METRICS_INCLUDE_SESSION_ID</code> is set to <code>false</code>, so Claude
          Code exports usage with no session id and none of it can be attributed to a session.
          Unset it - it defaults to true.
        </p>
      )}

      <div className="kb-row">
        <div className="kb-row-text">
          <span className="kb-row-label">Track Claude estimated cost</span>
          <span className="kb-row-desc">
            Writes an <code>env</code> block into{" "}
            <code>{status?.settingsPath ?? "~/.claude/settings.json"}</code> so every Claude
            Code session on this machine exports usage to the daemon on loopback. Your other
            settings are left untouched, and switching this off removes only the keys it added.
            {status && status.installed !== enabled && (
              <>
                {" "}
                <strong>
                  {status.installed
                    ? "The env block is present in that file even though this is off."
                    : "The env block is not in that file yet."}
                </strong>
              </>
            )}
          </span>
        </div>
        <div className="kb-row-controls">
          <label className="skill-switch">
            <Tooltip label="Let sessions report their token usage, so the topbar can cost the fleet">
              <input
                type="checkbox"
                checked={enabled}
                disabled={!config}
                onChange={(e) => void update({ enabled: e.target.checked })}
                aria-label="Export Claude Code usage telemetry to Mission Control"
              />
            </Tooltip>
          </label>
        </div>
      </div>

      <div className="kb-row">
        <div className="kb-row-text">
          <span className="kb-row-label">Export interval</span>
          <span className="kb-row-desc">
            How often each session reports. Shorter keeps the badge in step with the context
            meter beside it; longer means fewer loopback requests from every session at once.
          </span>
        </div>
        <div className="kb-row-controls">
          <Tooltip label="How often each session reports its usage back to Mission Control">
            <select
              className="settings-select"
              value={config?.exportIntervalMs ?? 15_000}
              disabled={!config}
              aria-label="Telemetry export interval"
              onChange={(e) => void update({ exportIntervalMs: Number(e.target.value) })}
            >
              {INTERVALS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000}s
                </option>
              ))}
            </select>
          </Tooltip>
        </div>
      </div>

      <div className="kb-row">
        <div className="kb-row-text">
          <span className="kb-row-label">Lead with</span>
          <span className="kb-row-desc">
            Which group comes first in the topbar. The estimate combines Claude and Codex;
            plan meters remain separate because they measure subscription quota instead.
          </span>
        </div>
        <div className="kb-row-controls">
          <Tooltip label="Which figure the topbar's usage strip leads with">
            <select
              className="settings-select"
              value={config?.view ?? "usd"}
              disabled={!config}
              aria-label="Which cost figure the topbar leads with"
              onChange={(e) => void update({ view: e.target.value === "plan" ? "plan" : "usd" })}
            >
              <option value="usd">Estimated cost</option>
              <option value="plan">Plan usage</option>
            </select>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
