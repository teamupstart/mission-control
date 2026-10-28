import { AGENT_IDENTITY } from "@shared/agent.ts";
import {
  AGENT_OTEL_SIGNALS,
  type AgentOtelHarnessMode,
  type AgentOtelHarnessStatus,
  type AgentOtelSignal,
} from "@shared/agent-telemetry.ts";
import { AGENT_TYPES, type AgentType } from "@shared/types.ts";
import type { ManagedAgentOtel } from "./managed.ts";
import { hostOf, type AgentOtelPolicy } from "./policy.ts";
import { AGENT_OTEL_RELAY_HEADER } from "./relay-token.ts";

// What each harness's SDK launch carries for agent telemetry.
//
// Pure builders over a resolved policy and the relay's address. Nothing here reads the
// environment, the database or a managed policy; `config.ts` assembles the inputs and the
// harness drivers call the one accessor for their own agent.
//
// The one rule every builder keeps: when the agent's OWN managed policy configures its
// telemetry, it injects nothing. Both agents apply their managed policy above anything a
// launcher passes (Claude Code applies managed `env` last and drops lower-precedence OTEL
// keys in the same family; Codex layers MDM `config_toml_base64` above `-c`), so an injected
// value would at best be ignored. The agent exports straight to its managed destination, and
// this daemon's local copy of that agent's data is given up. See docs/agent-telemetry.md.

/** Where the relay listens and how a session proves it may post to it. */
export interface RelayAddress {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  baseUrl: string;
  /** The daemon token. Env-only: never placed on a command line. */
  harnessToken: string;
  /** The relay-only capability, which may appear in argv because it can do nothing else. */
  relayToken: string;
}

const SIGNAL_ENV: Record<AgentOtelSignal, string> = {
  logs: "LOGS",
  metrics: "METRICS",
  traces: "TRACES",
};

/**
 * Claude Code's env for one SDK session, or an empty object.
 *
 * Per-signal endpoint, protocol and headers rather than the generic keys, on purpose:
 *
 *   - OTLP's per-signal variables beat the generic ones, and the generic ones are exactly what
 *     the Cost switch writes into `~/.claude/settings.json` - which Claude Code applies OVER
 *     the env it was launched with. Per-signal keys are the only ones that are not overwritten
 *     by it, and they point at the same daemon, so the two agree rather than fight.
 *   - `http/json`, because the daemon's metrics ledger parses JSON and has no protobuf
 *     decoder. The relay forwards the bytes as they arrived; the gateway accepts JSON.
 *   - The header is the daemon token Cost already uses, so metrics arriving this way reach the
 *     same ledger. It travels in env, never argv.
 *
 * Capture switches are only ever turned ON. An operator's own `OTEL_LOG_*=1` is not turned off
 * because Settings left a box unticked.
 */
export function claudeAgentOtelEnv(
  policy: AgentOtelPolicy,
  relay: RelayAddress,
): Record<string, string> {
  if (harnessMode("claude", policy) !== "relay") return {};
  const env: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: "1" };
  for (const signal of AGENT_OTEL_SIGNALS) {
    if (!policy.signals[signal] || policy.upstream[signal] === null) continue;
    const name = SIGNAL_ENV[signal];
    env[`OTEL_${name}_EXPORTER`] = "otlp";
    env[`OTEL_EXPORTER_OTLP_${name}_ENDPOINT`] = `${relay.baseUrl}/v1/${signal}`;
    env[`OTEL_EXPORTER_OTLP_${name}_PROTOCOL`] = "http/json";
    env[`OTEL_EXPORTER_OTLP_${name}_HEADERS`] = `x-harness-token=${relay.harnessToken}`;
  }
  // Claude Code's traces are behind its enhanced telemetry beta.
  if (env.OTEL_TRACES_EXPORTER === "otlp") env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = "1";
  if (Object.keys(env).length === 1) return {};
  const capture = policy.capture;
  if (capture.userPrompts) env.OTEL_LOG_USER_PROMPTS = "1";
  if (capture.toolDetails) env.OTEL_LOG_TOOL_DETAILS = "1";
  if (capture.toolContent) env.OTEL_LOG_TOOL_CONTENT = "1";
  if (capture.assistantResponses) env.OTEL_LOG_ASSISTANT_RESPONSES = "1";
  if (capture.rawApiBodies) env.OTEL_LOG_RAW_API_BODIES = "1";
  return env;
}

const CODEX_EXPORTER_KEY: Record<AgentOtelSignal, string> = {
  logs: "otel.exporter",
  metrics: "otel.metrics_exporter",
  traces: "otel.trace_exporter",
};

/** A TOML basic string. JSON's escapes are TOML's for every character a URL can carry. */
const tomlString = (value: string): string => JSON.stringify(value);

/**
 * Codex's launch-scoped `-c` overrides for one `codex app-server`, or none.
 *
 * Headers use the relay-only token rather than the daemon token, because `-c` is argv and
 * argv is visible to every process on the machine: the relay token can post OTLP to the relay
 * and nothing else, and metrics it carries are forwarded without being written to the ledger.
 * `json`, for the daemon's parser and because it is what Codex's own managed profile uses.
 */
export function codexAgentOtelArgs(policy: AgentOtelPolicy, relay: RelayAddress): string[] {
  if (harnessMode("codex", policy) !== "relay") return [];
  const args: string[] = [];
  const headers = `{${tomlString(AGENT_OTEL_RELAY_HEADER)}=${tomlString(relay.relayToken)}}`;
  for (const signal of AGENT_OTEL_SIGNALS) {
    if (!policy.signals[signal] || policy.upstream[signal] === null) continue;
    const endpoint = tomlString(`${relay.baseUrl}/v1/${signal}`);
    args.push(
      "-c",
      `${CODEX_EXPORTER_KEY[signal]}={otlp-http={endpoint=${endpoint},protocol="json",headers=${headers}}}`,
    );
  }
  if (args.length === 0) return [];
  if (policy.capture.userPrompts) args.push("-c", "otel.log_user_prompt=true");
  if (policy.capture.assistantResponses) args.push("-c", "otel.log_agent_responses=true");
  return args;
}

// ---- per-harness modes ----

interface HarnessOtelRule {
  /** The agent's own managed policy, when it has one this feature defers to. */
  managed: (policy: AgentOtelPolicy) => ManagedAgentOtel | null;
  /** Whether Mission Control can plumb this harness's SDK sessions at all. */
  plumbed: boolean;
  /** Why not, when it cannot. */
  extensionDetail?: string;
}

/**
 * Exhaustive over `AGENT_TYPES`, so a new harness has to say what it does here.
 *
 * Pi is `extension`: its SDK runs inside this daemon's process, and the Pi OTel extension
 * resolves its configuration from `~/.pi/agent/settings.json`, the project's
 * `.pi/settings.json` and the daemon's own `process.env`, and keeps one OTel runtime per
 * process. There is no per-session input to pass, and mutating the daemon's environment or
 * the operator's settings file would change every Pi session at once, so it is left alone.
 */
const HARNESS_OTEL_RULES: Record<AgentType, HarnessOtelRule> = {
  claude: { managed: (p) => p.managed.claude, plumbed: true },
  codex: { managed: (p) => p.managed.codex, plumbed: true },
  pi: {
    managed: () => null,
    plumbed: false,
    extensionDetail:
      "Runs inside Mission Control and keeps its telemetry in its own OpenTelemetry extension, configured in ~/.pi/agent/settings.json. Mission Control does not change it per session.",
  },
};

export function harnessMode(agent: AgentType, policy: AgentOtelPolicy): AgentOtelHarnessMode {
  const rule = HARNESS_OTEL_RULES[agent];
  if (!rule.plumbed) return "extension";
  if (rule.managed(policy) !== null) return "managed";
  return policy.source === "off" ? "off" : "relay";
}

export function harnessStatuses(policy: AgentOtelPolicy): AgentOtelHarnessStatus[] {
  return AGENT_TYPES.map((agent) => {
    const rule = HARNESS_OTEL_RULES[agent];
    const mode = harnessMode(agent, policy);
    const label = AGENT_IDENTITY[agent].label;
    return { agent, label, mode, detail: describe(mode, rule, policy, label) };
  });
}

function describe(
  mode: AgentOtelHarnessMode,
  rule: HarnessOtelRule,
  policy: AgentOtelPolicy,
  label: string,
): string {
  switch (mode) {
    case "extension":
      return rule.extensionDetail ?? "Not plumbed by Mission Control.";
    case "off":
      return `Nothing is injected; ${label} uses its own configuration.`;
    case "relay": {
      const hosts = [...new Set(AGENT_OTEL_SIGNALS.map((s) => hostOf(policy.upstream[s])).filter(Boolean))];
      return `Exports to Mission Control, which keeps its local copy and forwards to ${hosts.join(", ") || "nothing"}.`;
    }
    case "managed": {
      const managed = rule.managed(policy);
      if (managed?.disabled) return `Your organization's managed policy turns ${label}'s telemetry off.`;
      const hosts = [...new Set(AGENT_OTEL_SIGNALS.map((s) => hostOf(managed?.endpoints[s] ?? null)).filter(Boolean))];
      return `Your organization's managed policy wins over anything Mission Control passes, so ${label} exports directly to ${hosts.join(", ") || "its managed destination"} and Mission Control receives no local copy.`;
    }
  }
}
