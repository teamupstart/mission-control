import { useEffect, useState } from "react";
import {
  AGENT_OTEL_CAPTURE_KEYS,
  AGENT_OTEL_SIGNALS,
  agentOtelDestinationProblem,
  agentOtelHeaderNameProblem,
  agentOtelOrigin,
  type AgentOtelCapture,
  type AgentOtelCaptureKey,
  type AgentOtelHarnessMode,
  type AgentOtelSignal,
  type AgentOtelSignals,
  type AgentTelemetryPatch,
} from "@shared/agent-telemetry.ts";
import type { AgentTelemetryState } from "../useAgentTelemetry.ts";
import { Tooltip } from "./Tooltip.tsx";

// Settings > Agent telemetry: the agents' own OpenTelemetry for SDK sessions.
//
// Two states. When device management configures Claude Code's or Codex's telemetry, every
// value here is the organization's and the panel is read-only. Otherwise the operator decides,
// and nothing is sent anywhere until they switch it on with an endpoint.

const SIGNAL_LABEL: Record<AgentOtelSignal, string> = {
  logs: "Logs",
  metrics: "Metrics",
  traces: "Traces",
};

const CAPTURE_COPY: Record<AgentOtelCaptureKey, { label: string; desc: string }> = {
  userPrompts: { label: "User prompts", desc: "The text of every prompt." },
  toolDetails: { label: "Tool details", desc: "Tool names, parameters and commands." },
  toolContent: { label: "Tool content", desc: "Tool inputs and outputs in full." },
  assistantResponses: { label: "Assistant responses", desc: "The text the agent writes back." },
  rawApiBodies: { label: "Raw API bodies", desc: "Model request and response bodies (Claude Code only)." },
};

const MODE_LABEL: Record<AgentOtelHarnessMode, string> = {
  managed: "Managed",
  relay: "Relayed",
  off: "Off",
  extension: "Own extension",
};

const SOURCE_LABEL = {
  "mdm-user": "a per-user device management profile",
  mdm: "a device management profile",
  "managed-settings": "a managed settings file",
} as const;

export function AgentTelemetrySettingsPanel({
  state,
}: {
  state: AgentTelemetryState;
}): React.JSX.Element {
  const { status, loaded, error, saving, save } = state;
  const config = status?.config ?? null;
  const managed = status?.managed ?? false;

  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [signals, setSignals] = useState<AgentOtelSignals>({ logs: true, metrics: true, traces: true });
  const [capture, setCapture] = useState<AgentOtelCapture>({
    userPrompts: false,
    toolDetails: false,
    toolContent: false,
    assistantResponses: false,
    rawApiBodies: false,
  });
  const [headerName, setHeaderName] = useState("");
  const [headerValue, setHeaderValue] = useState("");

  // The form follows the daemon's answer whenever a new one lands.
  useEffect(() => {
    if (!config) return;
    setEnabled(config.enabled);
    setEndpoint(config.endpoint);
    setSignals(config.signals);
    setCapture(config.capture);
    setHeaderName("");
    setHeaderValue("");
  }, [config]);

  const managedRelayEnabled = AGENT_OTEL_SIGNALS.some((signal) => status?.effective.signals[signal]);
  const shownSignals = managed ? (status?.effective.signals ?? signals) : signals;
  const shownCapture = managed ? (status?.effective.capture ?? capture) : capture;
  const editable = config !== null && !managed && !saving;
  const addingHeader = headerName.trim() !== "" || headerValue !== "";
  const headerProblem = addingHeader
    ? headerName.trim() === ""
      ? "Name the header."
      : (agentOtelHeaderNameProblem(headerName.trim()) ?? (headerValue === "" ? "Give the header a value." : null))
    : null;
  const hasHeaders = addingHeader || (status?.headerNames.length ?? 0) > 0;
  const dropsStoredHeaders =
    !addingHeader &&
    (status?.headerNames.length ?? 0) > 0 &&
    config !== null &&
    agentOtelOrigin(endpoint) !== agentOtelOrigin(config.endpoint);
  const endpointProblem =
    endpoint.trim() === ""
      ? enabled ? "Set an endpoint to turn this on." : null
      : agentOtelDestinationProblem(endpoint, hasHeaders);

  const onSave = async (): Promise<void> => {
    const patch: AgentTelemetryPatch = { enabled, endpoint: endpoint.trim(), signals, capture };
    if (addingHeader) patch.headers = [{ name: headerName.trim(), value: headerValue }];
    await save(patch);
  };

  return (
    <section className="settings-section">
      <p className="settings-hint settings-blurb">
        The agents' own OpenTelemetry for sessions Mission Control runs on the SDK runtime: logs,
        metrics and traces from Claude Code and Codex, and, when capture allows, prompts, tool
        detail and responses. Mission Control points them at this daemon, which keeps what it
        uses locally and forwards a copy to the destination below. This is not the{" "}
        <strong>Cost</strong> switch, which is unchanged, and not Mission Control's own{" "}
        <strong>Telemetry</strong>.
      </p>

      {!loaded && <p className="settings-hint">Reading agent telemetry settings…</p>}
      {loaded && status === null && (
        <p className="settings-warn">This daemon did not report agent telemetry, so nothing here is known.</p>
      )}
      {error && <p className="settings-error">{error}</p>}

      {status && managed && (
        <p className="settings-warn" role="status">
          Managed by your organization. Agent telemetry is configured by{" "}
          {SOURCE_LABEL[(status.managedClaude ?? status.managedCodex)?.source ?? "mdm"]}, so these
          settings are read-only here.
        </p>
      )}

      {status && (
        <div className="kb-row" data-anchor="agent-telemetry/harnesses">
          <div className="kb-row-text">
            <span className="kb-row-label">What each agent does</span>
            <ul className="settings-hint" aria-label="Agent telemetry by harness">
              {status.harnesses.map((h) => (
                <li key={h.agent}>
                  <strong>{h.label}</strong>: {MODE_LABEL[h.mode]}. {h.detail}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="kb-row" data-anchor="agent-telemetry/enabled">
        <div className="kb-row-text">
          <span className="kb-row-label">Relay agent telemetry</span>
          <span className="kb-row-desc">
            {managed
              ? managedRelayEnabled
                ? "On, because your organization's managed policy provides an OTLP/HTTP destination."
                : "Off. Your organization's managed policy provides no OTLP/HTTP destination for this relay."
              : "Off by default. While on, new SDK sessions export to Mission Control and a copy goes to the endpoint below. Sessions already running keep what they started with."}
          </span>
        </div>
        <div className="kb-row-controls">
          <Tooltip label="Point new SDK sessions' telemetry at Mission Control and forward a copy">
          <label className="skill-switch">
            <input
              type="checkbox"
              checked={managed ? managedRelayEnabled : enabled}
              disabled={!editable}
              onChange={(e) => setEnabled(e.target.checked)}
              aria-label="Relay SDK agent telemetry"
            />
          </label>
          </Tooltip>
        </div>
      </div>

      <div className="kb-row" data-anchor="agent-telemetry/destination">
        <div className="kb-row-text">
          {managed ? (
            <>
              <span className="kb-row-label">Destination</span>
              <ul className="settings-hint" aria-label="Managed agent telemetry destinations">
                {AGENT_OTEL_SIGNALS.map((s) => (
                  <li key={s}>
                    {SIGNAL_LABEL[s]}: <code>{status?.effective.hosts[s] ?? "not sent"}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <label className="ts-field">
                <span className="ts-field-label">Endpoint</span>
                <input
                  className="field-input mono"
                  type="text"
                  placeholder="https://collector.example.com"
                  value={endpoint}
                  disabled={!editable}
                  aria-label="Agent telemetry endpoint"
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </label>
              <span className="kb-row-desc">
                An OTLP/HTTP base URL. Each signal is sent to <code>/v1/&lt;signal&gt;</code> under it.
              </span>
              {status?.suggestedEndpoint && endpoint.trim() !== status.suggestedEndpoint.endpoint && (
                <Tooltip label="Fill in your organization's OpenTelemetry gateway">
                <button
                  className="btn"
                  type="button"
                  disabled={!editable}
                  onClick={() => setEndpoint(status.suggestedEndpoint!.endpoint)}
                >
                  Use {status.suggestedEndpoint.label}'s gateway
                </button>
                </Tooltip>
              )}
              {endpointProblem && <span className="settings-error">{endpointProblem}</span>}

              <label className="ts-field">
                <span className="ts-field-label">Header name</span>
                <input
                  className="field-input mono"
                  type="text"
                  value={headerName}
                  disabled={!editable}
                  aria-label="Agent telemetry header name"
                  onChange={(e) => setHeaderName(e.target.value)}
                />
              </label>
              <label className="ts-field">
                <span className="ts-field-label">Header value</span>
                <input
                  className="field-input mono"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    (status?.headerNames.length ?? 0) > 0 ? "Type to replace the stored header." : "No header"
                  }
                  value={headerValue}
                  disabled={!editable}
                  aria-label="Agent telemetry header value"
                  onChange={(e) => setHeaderValue(e.target.value)}
                />
              </label>
              <span className="kb-row-desc">
                {(status?.headerNames.length ?? 0) > 0
                  ? `Stored: ${status!.headerNames.join(", ")}. Values are kept by the daemon and never shown.`
                  : "Optional, for a gateway that needs a credential. Stored by the daemon and never shown again."}
              </span>
              {dropsStoredHeaders && (
                <span className="settings-warn">
                  Saving another host removes the stored headers. Re-enter them to keep a credential.
                </span>
              )}
              {headerProblem && <span className="settings-error">{headerProblem}</span>}
            </>
          )}
        </div>
      </div>

      <div className="kb-row" data-anchor="agent-telemetry/signals">
        <div className="kb-row-text">
          <span className="kb-row-label">Signals</span>
        </div>
        <div className="kb-row-controls">
          {AGENT_OTEL_SIGNALS.map((s) => (
            <Tooltip key={s} label="Whether this signal is relayed">
            <label className="settings-hint">
              <input
                type="checkbox"
                checked={shownSignals[s]}
                disabled={!editable}
                aria-label={`Relay agent ${SIGNAL_LABEL[s].toLowerCase()}`}
                onChange={(e) => setSignals({ ...signals, [s]: e.target.checked })}
              />{" "}
              {SIGNAL_LABEL[s]}
            </label>
            </Tooltip>
          ))}
        </div>
      </div>

      <div className="kb-row" data-anchor="agent-telemetry/capture">
        <div className="kb-row-text">
          <span className="kb-row-label">Capture</span>
          <span className="kb-row-desc">
            What the agents may include beyond counts and timings. Each is sensitive. Mission
            Control only turns these on; a switch you set yourself in the agent's own environment
            is left as it is.
          </span>
          {AGENT_OTEL_CAPTURE_KEYS.map((k) => (
            <Tooltip key={k} label="Let the agents include this in their telemetry">
            <label className="settings-hint">
              <input
                type="checkbox"
                checked={shownCapture[k]}
                disabled={!editable}
                aria-label={`Capture ${CAPTURE_COPY[k].label.toLowerCase()}`}
                onChange={(e) => setCapture({ ...capture, [k]: e.target.checked })}
              />{" "}
              <strong>{CAPTURE_COPY[k].label}</strong>: {CAPTURE_COPY[k].desc}
            </label>
            </Tooltip>
          ))}
        </div>
      </div>

      {status && status.inheritedOtelEnv.length > 0 && (
        <p className="settings-hint">
          This daemon's environment sets {status.inheritedOtelEnv.map((k) => <code key={k}>{k} </code>)}
          and SDK sessions inherit it. While relaying, Mission Control's per-signal values take
          precedence over those for Claude Code; nothing else is removed.
        </p>
      )}

      {status && (
        <p className="settings-hint" aria-label="Agent telemetry relay counters">
          Forwarded {status.relay.forwarded}, failed {status.relay.failed}, dropped{" "}
          {status.relay.dropped}
          {status.relay.lastError ? ` (last failure: ${status.relay.lastError})` : ""}.
        </p>
      )}

      {!managed && (
        <div className="tele-actions">
          <Tooltip label="Store these settings; new SDK sessions pick them up">
          <button
            className="btn"
            type="button"
            disabled={!editable || endpointProblem !== null || headerProblem !== null}
            onClick={() => void onSave()}
          >
            Save agent telemetry
          </button>
          </Tooltip>
          {(status?.headerNames.length ?? 0) > 0 && (
            <Tooltip label="Forget the stored header and its value">
            <button
              className="btn"
              type="button"
              disabled={!editable}
              onClick={() => void save({ headers: [] })}
            >
              Remove stored header
            </button>
            </Tooltip>
          )}
        </div>
      )}
    </section>
  );
}
