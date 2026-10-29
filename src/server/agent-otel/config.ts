import {
  AGENT_OTEL_SIGNALS,
  AgentTelemetryConfigSchema,
  agentOtelOrigin,
  agentTelemetryConfigProblem,
  type AgentOtelManagedSummary,
  type AgentOtelSignal,
  type AgentTelemetryConfig,
  type AgentTelemetryPatch,
  type AgentTelemetryStatus,
} from "@shared/agent-telemetry.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import type { AgentType } from "@shared/types.ts";
import { ensureToken } from "../auth.ts";
import { PORT } from "../config.ts";
import { getAppConfig, inTransaction, openDb, setAppConfig } from "../db.ts";
import { currentOrganization } from "../environment/organization.ts";
import { targetsThisDaemon } from "../telemetry/config.ts";
import {
  claudeAgentOtelEnv,
  codexAgentOtelArgs,
  harnessStatuses,
  type RelayAddress,
} from "./launch.ts";
import {
  cachedManagedAgentOtel,
  managedAgentOtel,
  type ManagedAgentOtel,
  type ManagedAgentOtelState,
} from "./managed.ts";
import { hostOf, isManaged, resolveAgentOtelPolicy, type AgentOtelPolicy } from "./policy.ts";
import { OtlpForwarder, type RelayUpstream } from "./relay.ts";
import { agentOtelRelayToken } from "./relay-token.ts";

// The daemon side of Settings > Agent telemetry: persisted intent, stored headers, the
// resolved policy, and the one relay instance every OTLP route feeds.

const ENTRY = APP_CONFIG_ENTRIES.agentTelemetry;

export function getAgentTelemetryConfig(): AgentTelemetryConfig {
  const parsed = AgentTelemetryConfigSchema.safeParse(getAppConfig(ENTRY) ?? {});
  return parsed.success ? parsed.data : AgentTelemetryConfigSchema.parse({});
}

// ---- headers: credentials, read only at send time ----

function headerNames(): string[] {
  const rows = openDb()
    .prepare(`SELECT name FROM agent_telemetry_headers ORDER BY name`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function storedHeaders(): Record<string, string> {
  const rows = openDb()
    .prepare(`SELECT name, value FROM agent_telemetry_headers`)
    .all() as Array<{ name: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

/** Replace every stored header. The caller owns the transaction. */
function replaceHeaders(headers: Array<{ name: string; value: string }>, now: number): void {
  const d = openDb();
  d.prepare(`DELETE FROM agent_telemetry_headers`).run();
  const insert = d.prepare(
    `INSERT INTO agent_telemetry_headers (name, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  for (const h of headers) insert.run(h.name, h.value, now);
}

export class AgentTelemetryManagedError extends Error {}
export class AgentTelemetryInvalidError extends Error {}

/**
 * Apply a patch. Refused while device management decides, and refused when the result would
 * be an enabled config with no usable endpoint, or a credential bound for plain HTTP.
 */
export async function setAgentTelemetryConfig(
  patch: AgentTelemetryPatch,
  now = Date.now(),
): Promise<AgentTelemetryConfig> {
  if (isManaged(await managedAgentOtel(now))) {
    throw new AgentTelemetryManagedError(
      "Agent telemetry is managed by your organization's device management.",
    );
  }
  const previous = getAgentTelemetryConfig();
  const next = AgentTelemetryConfigSchema.parse({
    ...previous,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.endpoint !== undefined ? { endpoint: patch.endpoint.trim() } : {}),
    signals: { ...previous.signals, ...patch.signals },
    capture: { ...previous.capture, ...patch.capture },
  });
  // A credential was entered for one gateway. Moving to another origin without supplying
  // headers drops it rather than sending it to a host it was never meant for.
  const headers = patch.headers ?? (agentOtelOrigin(next.endpoint) === agentOtelOrigin(previous.endpoint) ? undefined : []);
  const hasHeaders = headers !== undefined ? headers.length > 0 : headerNames().length > 0;
  const problem = agentTelemetryConfigProblem(next, hasHeaders);
  if (problem) throw new AgentTelemetryInvalidError(problem);
  if (next.endpoint !== "" && targetsThisDaemon(next.endpoint)) {
    throw new AgentTelemetryInvalidError("The endpoint is this daemon, which would forward to itself.");
  }
  // One transaction: a credential must never be committed beside an endpoint it was not for.
  inTransaction(() => {
    if (headers !== undefined) replaceHeaders(headers, now);
    setAppConfig(ENTRY, next);
  });
  return next;
}

// ---- resolution ----

function policyFrom(managed: ManagedAgentOtelState): AgentOtelPolicy {
  return resolveAgentOtelPolicy({
    config: getAgentTelemetryConfig(),
    hasHeaders: headerNames().length > 0,
    managed,
  });
}

/** The policy with a fresh-enough managed read. Never throws: any failure is "off". */
export async function agentOtelPolicy(): Promise<AgentOtelPolicy | null> {
  try {
    return policyFrom(await managedAgentOtel());
  } catch {
    return null;
  }
}

function relayAddress(): RelayAddress {
  return {
    baseUrl: `http://127.0.0.1:${PORT}`,
    harnessToken: ensureToken(),
    relayToken: agentOtelRelayToken(),
  };
}

/**
 * What one harness's SDK launch adds for agent telemetry. Fail-open: a failure to resolve
 * anything is an empty answer, and the launch proceeds exactly as it would have without this
 * feature.
 */
export async function agentOtelLaunch(
  agent: AgentType,
): Promise<{ env: Record<string, string>; args: string[] }> {
  try {
    const policy = await agentOtelPolicy();
    if (policy === null) return { env: {}, args: [] };
    const relay = relayAddress();
    return HARNESS_LAUNCH[agent](policy, relay);
  } catch {
    return { env: {}, args: [] };
  }
}

/** Exhaustive: what each harness's launch is handed. Pi gets nothing; see `launch.ts`. */
const HARNESS_LAUNCH: Record<
  AgentType,
  (policy: AgentOtelPolicy, relay: RelayAddress) => { env: Record<string, string>; args: string[] }
> = {
  claude: (policy, relay) => ({ env: claudeAgentOtelEnv(policy, relay), args: [] }),
  codex: (policy, relay) => ({ env: {}, args: codexAgentOtelArgs(policy, relay) }),
  pi: () => ({ env: {}, args: [] }),
};

// ---- the relay ----

/** Where one signal's copy goes right now, or null. Read per send. */
function currentUpstream(signal: AgentOtelSignal): RelayUpstream | null {
  // Existing sessions keep exporting without opening Settings or launching another agent.
  // Refresh in the background so managed changes cannot leave their routing stale forever.
  void managedAgentOtel();
  const policy = policyFrom(cachedManagedAgentOtel());
  const url = policy.upstream[signal];
  if (url === null || !policy.signals[signal]) return null;
  // Forwarding to ourselves would feed every export back into this route forever.
  if (targetsThisDaemon(url)) return null;
  return { url, headers: policy.useStoredHeaders ? storedHeaders() : {} };
}

let forwarder: OtlpForwarder | null = null;

export function agentOtelForwarder(): OtlpForwarder {
  forwarder ??= new OtlpForwarder({
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
    upstream: (signal) => {
      try {
        return currentUpstream(signal);
      } catch {
        return null;
      }
    },
  });
  return forwarder;
}

/** Tests install a forwarder with scripted deps; null restores the default. */
export function setAgentOtelForwarderForTest(next: OtlpForwarder | null): void {
  forwarder = next;
}

// ---- status ----

function summarize(managed: ManagedAgentOtel | null): AgentOtelManagedSummary | null {
  if (managed === null) return null;
  const hosts = { logs: null, metrics: null, traces: null } as Record<AgentOtelSignal, string | null>;
  for (const signal of AGENT_OTEL_SIGNALS) hosts[signal] = hostOf(managed.endpoints[signal]);
  return { source: managed.source, disabled: managed.disabled, hosts, capture: { ...managed.capture } };
}

export async function agentTelemetryStatus(): Promise<AgentTelemetryStatus> {
  const managed = await managedAgentOtel();
  const policy = policyFrom(managed);
  const hosts = { logs: null, metrics: null, traces: null } as Record<AgentOtelSignal, string | null>;
  for (const signal of AGENT_OTEL_SIGNALS) hosts[signal] = hostOf(policy.upstream[signal]);
  const organization = currentOrganization();
  return {
    config: getAgentTelemetryConfig(),
    headerNames: headerNames(),
    managed: isManaged(managed),
    managedClaude: summarize(managed.claude),
    managedCodex: summarize(managed.codex),
    effective: {
      source: policy.source,
      signals: { ...policy.signals },
      capture: { ...policy.capture },
      hosts,
    },
    harnesses: harnessStatuses(policy),
    inheritedOtelEnv: Object.keys(process.env)
      .filter((k) => k.startsWith("OTEL_"))
      .sort(),
    suggestedEndpoint:
      organization === null
        ? null
        : { label: organization.entry.label, endpoint: organization.entry.preset.endpoint },
    relay: agentOtelForwarder().snapshot(),
  };
}
