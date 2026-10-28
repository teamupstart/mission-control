/**
 * Agent telemetry: the wire contract for Settings > Agent telemetry.
 *
 * This is the agents' OWN OpenTelemetry - Claude Code's and Codex's logs, metrics and traces,
 * including prompts and tool detail when capture allows it - for the sessions Mission Control
 * runs on the SDK runtime. It is neither of the two telemetry features that already exist:
 *
 *   - Cost (`claude-settings.ts`) asks every Claude Code on the machine to report its usage
 *     metrics INTO this daemon. It stays exactly as it is.
 *   - Telemetry (`telemetry.ts`) is Mission Control exporting facts about ITSELF.
 *
 * Browser-safe: no `node:` imports. The daemon owns resolution, launch plumbing and the relay;
 * see `src/server/agent-otel/` and docs/agent-telemetry.md.
 */
import { z } from "zod";
import { validateEndpoint } from "./telemetry-endpoint.ts";

/** The three OTLP signals, in the order Settings lists them. */
export const AGENT_OTEL_SIGNALS = ["logs", "metrics", "traces"] as const;
export type AgentOtelSignal = (typeof AGENT_OTEL_SIGNALS)[number];

/**
 * What the agents may put INSIDE their telemetry, beyond counts and timings.
 *
 * Each maps to one Claude Code switch (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`,
 * `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_RAW_API_BODIES`); Codex
 * honours the two it has (`otel.log_user_prompt`, `otel.log_agent_responses`).
 */
export const AGENT_OTEL_CAPTURE_KEYS = [
  "userPrompts",
  "toolDetails",
  "toolContent",
  "assistantResponses",
  "rawApiBodies",
] as const;
export type AgentOtelCaptureKey = (typeof AGENT_OTEL_CAPTURE_KEYS)[number];

export type AgentOtelSignals = Record<AgentOtelSignal, boolean>;
export type AgentOtelCapture = Record<AgentOtelCaptureKey, boolean>;

/** At most this many extra headers; a gateway needs one or two. */
export const AGENT_OTEL_MAX_HEADERS = 8;
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
/**
 * Header names Mission Control owns on the relay hop. Accepting one as an upstream header
 * would either be overwritten or, worse, forward this daemon's credential somewhere else.
 */
const RESERVED_HEADER_NAMES = new Set([
  "x-harness-token",
  "x-mission-otel-relay",
  "content-type",
  "content-encoding",
  "content-length",
  "host",
]);

export function agentOtelHeaderNameProblem(name: string): string | null {
  if (!HEADER_NAME.test(name)) return "Header names are letters, digits and - _ . only.";
  if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) return `${name} is set by Mission Control.`;
  return null;
}

const SignalsSchema = z.object({
  logs: z.boolean().default(true),
  metrics: z.boolean().default(true),
  traces: z.boolean().default(true),
});

const CaptureSchema = z.object({
  userPrompts: z.boolean().default(false),
  toolDetails: z.boolean().default(false),
  toolContent: z.boolean().default(false),
  assistantResponses: z.boolean().default(false),
  rawApiBodies: z.boolean().default(false),
});

/**
 * The operator's own choice, used only when no device management policy configures agent
 * telemetry. Off by default. Headers are NOT here: they are credentials and live in the
 * daemon-owned `agent_telemetry_headers` table, so no config read or settings snapshot can
 * carry one.
 */
export const AgentTelemetryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** OTLP/HTTP base URL; `/v1/<signal>` is appended. Empty until someone sets one. */
  endpoint: z.string().max(2048).default(""),
  signals: SignalsSchema.default({}),
  capture: CaptureSchema.default({}),
});
export type AgentTelemetryConfig = z.infer<typeof AgentTelemetryConfigSchema>;

const HeaderSchema = z.object({
  name: z.string().superRefine((name, ctx) => {
    const problem = agentOtelHeaderNameProblem(name);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
  // No CR or LF: a header value that could end the header is a request smuggled upstream.
  value: z.string().min(1).max(4096).regex(/^[^\r\n]*$/, "Header values cannot span lines."),
});

/**
 * `PUT /api/agent-telemetry`. Every field is optional; `headers` REPLACES the stored set
 * (an empty array clears it) and is the only way a credential enters the daemon.
 */
export const AgentTelemetryPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: z.string().max(2048).optional(),
    signals: SignalsSchema.partial().optional(),
    capture: CaptureSchema.partial().optional(),
    headers: z
      .array(HeaderSchema)
      .max(AGENT_OTEL_MAX_HEADERS)
      // Header names are case-insensitive; two spellings of one name would be stored as two
      // rows and joined into one corrupted value on the wire.
      .refine(
        (headers) => new Set(headers.map((h) => h.name.toLowerCase())).size === headers.length,
        "Each header name may appear only once.",
      )
      .optional(),
  })
  .strict();
export type AgentTelemetryPatch = z.infer<typeof AgentTelemetryPatchSchema>;

/**
 * Why a config cannot be saved, or null. Shared so the form and the route agree.
 *
 * An enabled config needs a usable endpoint; a credential needs HTTPS unless the endpoint is
 * loopback, the same rule Mission Control's own telemetry applies.
 */
export function agentTelemetryConfigProblem(
  config: AgentTelemetryConfig,
  hasHeaders: boolean,
): string | null {
  if (!config.enabled && config.endpoint.trim() === "") return null;
  const checked = validateEndpoint(config.endpoint, { hasCredential: hasHeaders });
  return checked.ok ? null : checked.detail;
}

/** Where the effective policy came from. */
export type AgentOtelSource = "mdm" | "settings" | "off";

/** One managed policy, reduced to what Settings may show: hostnames and switches. */
export interface AgentOtelManagedSummary {
  /** Which managed location supplied it, for the "managed by" sentence. */
  source: "mdm-user" | "mdm" | "managed-settings";
  /** True when the policy turns the agent's telemetry off rather than routing it. */
  disabled: boolean;
  /** The hostname each signal is sent to, or null when the policy does not route it. */
  hosts: Record<AgentOtelSignal, string | null>;
  capture: AgentOtelCapture;
}

/**
 * What one harness's SDK sessions do with their telemetry.
 *
 * - `managed`: the agent's own managed policy configures it and wins over anything Mission
 *   Control could pass, so nothing is injected and the agent exports directly.
 * - `relay`: Mission Control points the agent at this daemon, which keeps its local use of the
 *   data and forwards a copy to the effective destination.
 * - `off`: nothing is injected; the agent does whatever its own configuration says.
 * - `extension`: the harness runs in-process and owns its telemetry through its own extension;
 *   Mission Control does not change it per session.
 */
export type AgentOtelHarnessMode = "managed" | "relay" | "off" | "extension";

export interface AgentOtelHarnessStatus {
  agent: string;
  label: string;
  mode: AgentOtelHarnessMode;
  /** One sentence for Settings. Never a URL beyond a hostname, never a credential. */
  detail: string;
}

export interface AgentOtelRelayStats {
  forwarded: number;
  failed: number;
  dropped: number;
  /** Bounded and payload-free: an HTTP status or an error class. */
  lastError: string | null;
  lastForwardedAt: number | null;
}

/** `GET /api/agent-telemetry`. */
export interface AgentTelemetryStatus {
  /** The operator's saved settings, which apply only while `source` is not `mdm`. */
  config: AgentTelemetryConfig;
  /** Names of the stored headers. Values never leave the daemon. */
  headerNames: string[];
  /** True when device management decides, so Settings is read-only. */
  managed: boolean;
  managedClaude: AgentOtelManagedSummary | null;
  managedCodex: AgentOtelManagedSummary | null;
  effective: {
    source: AgentOtelSource;
    signals: AgentOtelSignals;
    capture: AgentOtelCapture;
    /** Hostname per signal the relay forwards to, or null when it forwards nothing. */
    hosts: Record<AgentOtelSignal, string | null>;
  };
  harnesses: AgentOtelHarnessStatus[];
  /**
   * `OTEL_*` variable NAMES set in the daemon's own environment. SDK sessions inherit them,
   * and while relaying, Mission Control's per-signal values take precedence.
   */
  inheritedOtelEnv: string[];
  /** A recognized organization's gateway, offered as the endpoint. Null when none. */
  suggestedEndpoint: { label: string; endpoint: string } | null;
  relay: AgentOtelRelayStats;
}
