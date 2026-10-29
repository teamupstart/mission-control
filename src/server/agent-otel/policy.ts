import {
  AGENT_OTEL_CAPTURE_KEYS,
  AGENT_OTEL_SIGNALS,
  type AgentOtelCapture,
  type AgentOtelSignal,
  type AgentOtelSignals,
  type AgentOtelSource,
  type AgentTelemetryConfig,
  agentOtelDestinationProblem,
} from "@shared/agent-telemetry.ts";
import type { ManagedAgentOtel, ManagedAgentOtelState } from "./managed.ts";

// Who decides where agent telemetry goes, and what may be in it.
//
//   1. Device management. A managed Claude or Codex policy that configures telemetry makes
//      the whole feature managed: its routing and capture switches are the effective policy,
//      and Settings is read-only.
//   2. The operator's Settings, when enabled with a valid endpoint.
//   3. Off.
//
// Pure: inputs in, one answer out. Reading the inputs is `config.ts`'s job.

export interface AgentOtelPolicy {
  source: AgentOtelSource;
  signals: AgentOtelSignals;
  capture: AgentOtelCapture;
  /** The full per-signal URL the relay forwards to, or null for a signal it drops. */
  upstream: Record<AgentOtelSignal, string | null>;
  /** True when the relay should attach the operator's stored headers (Settings only). */
  useStoredHeaders: boolean;
  managed: ManagedAgentOtelState;
}

const allSignals = (on: boolean): AgentOtelSignals => ({ logs: on, metrics: on, traces: on });
const noCapture = (): AgentOtelCapture =>
  Object.fromEntries(AGENT_OTEL_CAPTURE_KEYS.map((k) => [k, false])) as AgentOtelCapture;

/** Whether a managed policy says anything this feature has to defer to. */
export function isManaged(managed: ManagedAgentOtelState): boolean {
  return managed.claude !== null || managed.codex !== null;
}

export function resolveAgentOtelPolicy(input: {
  config: AgentTelemetryConfig;
  hasHeaders: boolean;
  managed: ManagedAgentOtelState;
}): AgentOtelPolicy {
  const { config, managed } = input;
  if (isManaged(managed)) return managedPolicy(managed);
  const valid = agentOtelDestinationProblem(config.endpoint, input.hasHeaders) === null;
  if (!config.enabled || !valid) {
    return {
      source: "off",
      signals: allSignals(false),
      capture: noCapture(),
      upstream: { logs: null, metrics: null, traces: null },
      useStoredHeaders: false,
      managed,
    };
  }
  const upstream = { logs: null, metrics: null, traces: null } as Record<AgentOtelSignal, string | null>;
  for (const signal of AGENT_OTEL_SIGNALS) {
    if (config.signals[signal]) upstream[signal] = agentOtelSignalUrl(config.endpoint, signal);
  }
  return {
    source: "settings",
    signals: { ...config.signals },
    capture: { ...config.capture },
    upstream,
    useStoredHeaders: true,
    managed,
  };
}

/**
 * The managed policy, merged. Claude's policy carries the full capture vocabulary, so it
 * speaks for capture when present; Codex's fills any signal Claude's does not route.
 */
function managedPolicy(managed: ManagedAgentOtelState): AgentOtelPolicy {
  const sources = [managed.claude, managed.codex].filter(
    (m): m is ManagedAgentOtel => m !== null && !m.disabled,
  );
  const upstream = { logs: null, metrics: null, traces: null } as Record<AgentOtelSignal, string | null>;
  for (const signal of AGENT_OTEL_SIGNALS) {
    // A managed agent exports to its own route directly; the relay only copies other agents'
    // telemetry there when the route meets the relay's own destination rule.
    upstream[signal] = sources.find((m) => {
      const endpoint = m.endpoints[signal];
      return m.transports[signal] === "http" && endpoint !== null && agentOtelDestinationProblem(endpoint, false) === null;
    })?.endpoints[signal] ?? null;
  }
  const signals = {} as AgentOtelSignals;
  for (const signal of AGENT_OTEL_SIGNALS) signals[signal] = upstream[signal] !== null;
  const capture = sources[0]?.capture ?? noCapture();
  return {
    source: "mdm",
    signals,
    capture: { ...capture },
    upstream,
    // A managed destination gets no operator-supplied credential: those were configured for
    // the operator's own endpoint, not for the one device management names.
    useStoredHeaders: false,
    managed,
  };
}

/** Append the signal path to a validated base URL, not to its query or fragment. */
export function agentOtelSignalUrl(endpoint: string, signal: AgentOtelSignal): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/${signal}`;
  url.hash = "";
  return url.href;
}

/** A hostname, or null. The only part of a URL that Settings is ever sent. */
export function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
