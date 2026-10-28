import { join } from "node:path";

import {
  AGENT_OTEL_CAPTURE_KEYS,
  AGENT_OTEL_SIGNALS,
  type AgentOtelCapture,
  type AgentOtelSignal,
} from "@shared/agent-telemetry.ts";
import type { ManagedClaudeSettingsSource } from "@shared/protocol.ts";
import {
  defaultClaudeManagedDeps,
  readManagedClaudeEnvKeys,
  type ClaudeManagedDeps,
  type ManagedFileStat,
} from "../environment/claude-managed.ts";
import { readPlistValue } from "../environment/macos.ts";
import { agentOtelSignalUrl } from "./policy.ts";

// What device management says about the agents' OWN telemetry.
//
// Two readers, one per managed agent, and both FAIL OPEN: any read or parse failure is "no
// managed policy", never a reason to block or alter a launch. That is the opposite direction
// from the Cost warning in `claude-managed.ts`, which fails closed because a wrong claim there
// is a wrong sentence on screen. Here a wrong "none" costs nothing that matters: the agent
// reads its managed policy itself, and that policy wins over whatever Mission Control passes
// (see docs/agent-telemetry.md), so the worst case is an override the agent ignores.
//
// macOS only. Anywhere else both readers answer null without spawning anything, unless a test
// names a fixture root through `MISSION_MANAGED_SETTINGS_ROOT`.
//
// Only routing and capture switches are kept. Header values, workspace identifiers and every
// other key a policy carries are never read out of it.

/** The Claude Code managed `env` keys agent telemetry reads. Never a `*_HEADERS` key. */
export const CLAUDE_OTEL_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_TRACES_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_RAW_API_BODIES",
] as const;
type ClaudeOtelKey = (typeof CLAUDE_OTEL_KEYS)[number];

const CLAUDE_CAPTURE_ENV: Record<keyof AgentOtelCapture, ClaudeOtelKey> = {
  userPrompts: "OTEL_LOG_USER_PROMPTS",
  toolDetails: "OTEL_LOG_TOOL_DETAILS",
  toolContent: "OTEL_LOG_TOOL_CONTENT",
  assistantResponses: "OTEL_LOG_ASSISTANT_RESPONSES",
  rawApiBodies: "OTEL_LOG_RAW_API_BODIES",
};

/** One agent's managed telemetry, as resolution and Settings need it. */
export interface ManagedAgentOtel {
  source: ManagedClaudeSettingsSource;
  /** The policy switches the agent's telemetry off. Nothing routes, nothing is injected. */
  disabled: boolean;
  /** Full per-signal URL the policy sends to, or null when it does not route that signal. */
  endpoints: Record<AgentOtelSignal, string | null>;
  /** Only HTTP destinations can receive the relay's unchanged HTTP bodies. */
  transports: Partial<Record<AgentOtelSignal, "http" | "grpc">>;
  capture: AgentOtelCapture;
}

export interface ManagedAgentOtelState {
  claude: ManagedAgentOtel | null;
  codex: ManagedAgentOtel | null;
}

export const NO_MANAGED_AGENT_OTEL: ManagedAgentOtelState = { claude: null, codex: null };

const truthy = (v: string | undefined): boolean =>
  v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
const falsy = (v: string | undefined): boolean =>
  v !== undefined && ["0", "false", "no", "off"].includes(v.trim().toLowerCase());

const noCapture = (): AgentOtelCapture =>
  Object.fromEntries(AGENT_OTEL_CAPTURE_KEYS.map((k) => [k, false])) as AgentOtelCapture;
const noEndpoints = (): Record<AgentOtelSignal, string | null> =>
  ({ logs: null, metrics: null, traces: null });

/** An http(s) URL with a host, or null. Anything else is not a route. */
function httpUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Claude Code's managed `env`, read as Claude Code would: per-signal endpoint first, then the
 * generic base with OTLP's default path. A signal whose exporter is `none` does not route.
 *
 * Null when the policy says nothing about telemetry at all, so a managed policy that only sets
 * unrelated keys does not make agent telemetry "managed".
 */
export function claudeManagedOtelFromEnv(
  source: ManagedClaudeSettingsSource,
  env: Partial<Record<ClaudeOtelKey, string>>,
): ManagedAgentOtel | null {
  if (Object.keys(env).length === 0) return null;
  if (falsy(env.CLAUDE_CODE_ENABLE_TELEMETRY)) {
    return { source, disabled: true, endpoints: noEndpoints(), transports: {}, capture: noCapture() };
  }
  const generic = httpUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const exporter: Record<AgentOtelSignal, string | undefined> = {
    logs: env.OTEL_LOGS_EXPORTER,
    metrics: env.OTEL_METRICS_EXPORTER,
    traces: env.OTEL_TRACES_EXPORTER,
  };
  const perSignal: Record<AgentOtelSignal, string | undefined> = {
    logs: env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    metrics: env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    traces: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  };
  const protocols: Record<AgentOtelSignal, string | undefined> = {
    logs: env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL,
    metrics: env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL,
    traces: env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL,
  };
  const endpoints = noEndpoints();
  const transports: ManagedAgentOtel["transports"] = {};
  for (const signal of AGENT_OTEL_SIGNALS) {
    const kinds = exporter[signal]?.split(",").map((kind) => kind.trim().toLowerCase()) ?? [];
    if (!kinds.includes("otlp")) continue;
    const protocol = protocols[signal] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL;
    const transport = protocol?.trim().toLowerCase() === "grpc" ? "grpc" : "http";
    endpoints[signal] = httpUrl(perSignal[signal]) ?? (generic === null
      ? null
      : transport === "grpc" ? generic : agentOtelSignalUrl(generic, signal));
    transports[signal] = transport;
  }
  const capture = noCapture();
  for (const key of AGENT_OTEL_CAPTURE_KEYS) capture[key] = truthy(env[CLAUDE_CAPTURE_ENV[key]]);
  const routes = AGENT_OTEL_SIGNALS.some((s) => endpoints[s] !== null);
  // Telemetry switched on with nowhere managed to send it is still a managed decision about
  // telemetry; telemetry neither enabled nor routed is a policy about something else.
  if (!routes && !truthy(env.CLAUDE_CODE_ENABLE_TELEMETRY)) return null;
  return { source, disabled: false, endpoints, transports, capture };
}

// ---- Codex: `config_toml_base64`, a whole config.toml in a preference key ----

/** Decoded config bigger than this is not a policy anyone wrote by hand. */
const MAX_CODEX_TOML_BYTES = 256 * 1024;

type TomlScalar = string | boolean | number;

/**
 * The `[otel]` part of a Codex config.toml, and nothing else.
 *
 * Deliberately NOT a TOML parser. It reads table headers and `key = scalar` lines, and only
 * looks at the values of lines inside an `otel` table (or dotted `otel.` keys at the root):
 * every other line - including whatever a policy keeps outside `[otel]` - is skipped unread.
 * A line inside an `otel` table it cannot read (an inline table, an array, a multi-line
 * string) makes the whole answer null. Fail open: null is "no managed policy", and Codex,
 * which reads the real file, still applies it.
 */
export function parseCodexOtelToml(text: string): Map<string, TomlScalar> | null {
  const values = new Map<string, TomlScalar>();
  let table: string[] = [];
  let inMultiline: '"""' | "'''" | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inMultiline !== null) {
      if (line.includes(inMultiline)) inMultiline = null;
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
      if (!header) return null;
      table = splitKey(header[1] ?? "");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = [...table, ...splitKey(line.slice(0, eq).trim())];
    const valueText = line.slice(eq + 1).trim();
    if (key[0] !== "otel") {
      // Not ours. Still tracked for multi-line strings, so a value that happens to contain a
      // line starting with `[` is not mistaken for a table header.
      for (const quote of ['"""', "'''"] as const) {
        if (valueText.startsWith(quote) && !valueText.slice(3).includes(quote)) inMultiline = quote;
      }
      continue;
    }
    const value = parseScalar(valueText);
    if (value === undefined) return null;
    values.set(key.join("."), value);
  }
  return values;
}

function splitKey(key: string): string[] {
  const parts: string[] = [];
  for (const segment of key.match(/"[^"]*"|'[^']*'|[^.]+/g) ?? []) {
    const s = segment.trim();
    parts.push(s.startsWith('"') || s.startsWith("'") ? s.slice(1, -1) : s);
  }
  return parts;
}

function parseScalar(text: string): TomlScalar | undefined {
  const value = text.replace(/\s+#.*$/, "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  const basic = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
  if (basic) {
    try {
      return JSON.parse(`"${basic[1]}"`) as string;
    } catch {
      return undefined;
    }
  }
  const literal = /^'([^']*)'$/.exec(value);
  if (literal) return literal[1];
  return undefined;
}

const CODEX_EXPORTER_KEY: Record<AgentOtelSignal, string> = {
  logs: "otel.exporter",
  metrics: "otel.metrics_exporter",
  traces: "otel.trace_exporter",
};

/** A Codex `[otel]` section as the shared shape. Null when the config sets no `otel` key. */
export function codexManagedOtelFromToml(
  source: ManagedClaudeSettingsSource,
  values: Map<string, TomlScalar>,
): ManagedAgentOtel | null {
  if (values.size === 0) return null;
  const endpoints = noEndpoints();
  const transports: ManagedAgentOtel["transports"] = {};
  let explicitNone = 0;
  for (const signal of AGENT_OTEL_SIGNALS) {
    const base = CODEX_EXPORTER_KEY[signal];
    if (values.get(base) === "none") {
      explicitNone += 1;
      continue;
    }
    for (const transport of ["otlp-http", "otlp-grpc"]) {
      const endpoint = values.get(`${base}.${transport}.endpoint`);
      if (typeof endpoint === "string" && httpUrl(endpoint) !== null) {
        endpoints[signal] = endpoint;
        transports[signal] = transport === "otlp-http" ? "http" : "grpc";
      }
    }
  }
  const capture = noCapture();
  capture.userPrompts = values.get("otel.log_user_prompt") === true;
  capture.assistantResponses = values.get("otel.log_agent_responses") === true;
  const routes = AGENT_OTEL_SIGNALS.some((s) => endpoints[s] !== null);
  return {
    source,
    disabled: !routes && explicitNone === AGENT_OTEL_SIGNALS.length,
    endpoints,
    transports,
    capture,
  };
}

/** Codex's macOS managed preference locations, highest precedence first. */
export function codexManagedLocations(
  root: string,
  user: string | null,
): Array<{ source: ManagedClaudeSettingsSource; path: string }> {
  const preferences = join(root, "Library", "Managed Preferences");
  const locations: Array<{ source: ManagedClaudeSettingsSource; path: string }> = [];
  if (user !== null && user.length > 0 && !user.includes("/") && user !== "." && user !== "..") {
    locations.push({ source: "mdm-user", path: join(preferences, user, "com.openai.codex.plist") });
  }
  locations.push({ source: "mdm", path: join(preferences, "com.openai.codex.plist") });
  return locations;
}

export interface AgentOtelManagedDeps extends ClaudeManagedDeps {
  platform: NodeJS.Platform;
  /** True when `root` is a test fixture, which is the only way off macOS reads anything. */
  fixture: boolean;
}

/** Read both agents' managed telemetry. Never throws; every failure is null for that agent. */
export async function readManagedAgentOtel(
  deps: AgentOtelManagedDeps | null,
): Promise<ManagedAgentOtelState> {
  if (deps === null) return NO_MANAGED_AGENT_OTEL;
  if (deps.platform !== "darwin" && !deps.fixture) return NO_MANAGED_AGENT_OTEL;
  const [claude, codex] = await Promise.all([
    readClaude(deps).catch(() => null),
    readCodex(deps).catch(() => null),
  ]);
  return { claude, codex };
}

async function readClaude(deps: AgentOtelManagedDeps): Promise<ManagedAgentOtel | null> {
  const read = await readManagedClaudeEnvKeys(deps, CLAUDE_OTEL_KEYS);
  return read === null ? null : claudeManagedOtelFromEnv(read.source, read.env);
}

async function readCodex(deps: AgentOtelManagedDeps): Promise<ManagedAgentOtel | null> {
  for (const location of codexManagedLocations(deps.root, deps.user)) {
    const info = await deps.stat(location.path);
    if (info === "missing") continue;
    if (info === "unreadable") return null;
    const encoded = await readPlistValue(location.path, "config_toml_base64", { run: deps.run });
    // A profile without the key configures something else about Codex; the next location
    // may still carry a config.
    if (encoded === null) continue;
    if (typeof encoded !== "string") return null;
    const bytes = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
    if (bytes.length === 0 || bytes.length > MAX_CODEX_TOML_BYTES) return null;
    const values = parseCodexOtelToml(bytes.toString("utf8"));
    if (values === null) return null;
    return codexManagedOtelFromToml(location.source, values);
  }
  return null;
}

/** Production deps: the Cost reader's, plus the platform gate. Null under a test runner. */
export function defaultAgentOtelManagedDeps(): AgentOtelManagedDeps | null {
  const base = defaultClaudeManagedDeps();
  if (base === null) return null;
  return { ...base, platform: process.platform, fixture: base.root !== "/" };
}

// ---- the cached answer ----
//
// Launches and the Settings read both want this, and a read can spawn `plutil` up to four
// times. One refresh at a time, at most once a minute unless a location's stat changes.

const REFRESH_AFTER_MS = 60_000;
let cached: ManagedAgentOtelState = NO_MANAGED_AGENT_OTEL;
let cachedKey: string | null = null;
let readAt: number | null = null;
let inflight: Promise<ManagedAgentOtelState> | null = null;
let depsOverride: (() => AgentOtelManagedDeps | null) | null = null;

/** Tests swap the reader's deps; null restores production. */
export function setAgentOtelManagedDepsForTest(make: (() => AgentOtelManagedDeps | null) | null): void {
  depsOverride = make;
  cached = NO_MANAGED_AGENT_OTEL;
  cachedKey = null;
  readAt = null;
  inflight = null;
}

/** The last answer. Never waits. */
export function cachedManagedAgentOtel(): ManagedAgentOtelState {
  return cached;
}

/** A fresh-enough answer. Never throws; a failed refresh keeps "none". */
export function managedAgentOtel(now = Date.now()): Promise<ManagedAgentOtelState> {
  if (inflight) return inflight;
  const started = refresh(now).finally(() => {
    if (inflight === started) inflight = null;
  });
  inflight = started;
  return started;
}

async function refresh(now: number): Promise<ManagedAgentOtelState> {
  try {
    const deps = (depsOverride ?? defaultAgentOtelManagedDeps)();
    if (deps === null || (deps.platform !== "darwin" && !deps.fixture)) {
      cached = NO_MANAGED_AGENT_OTEL;
      return cached;
    }
    const key = await locationsKey(deps);
    if (key === cachedKey && readAt !== null && now - readAt < REFRESH_AFTER_MS) return cached;
    cached = await readManagedAgentOtel(deps);
    cachedKey = key;
    readAt = now;
    return cached;
  } catch {
    cached = NO_MANAGED_AGENT_OTEL;
    return cached;
  }
}

async function locationsKey(deps: AgentOtelManagedDeps): Promise<string> {
  const paths = [
    join(deps.root, "Library", "Managed Preferences", "com.anthropic.claudecode.plist"),
    join(deps.root, "Library", "Application Support", "ClaudeCode", "managed-settings.json"),
    ...codexManagedLocations(deps.root, deps.user).map((l) => l.path),
  ];
  if (deps.user) {
    paths.push(join(deps.root, "Library", "Managed Preferences", deps.user, "com.anthropic.claudecode.plist"));
  }
  const parts: string[] = [];
  for (const path of paths) {
    const info: ManagedFileStat = await deps.stat(path);
    parts.push(typeof info === "string" ? info : `${info.mtimeMs}:${info.size}`);
  }
  return parts.join("|");
}

