import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import { parse, type ParseError } from "jsonc-parser";

import type { ManagedClaudeSettingsSource } from "@shared/protocol.ts";
import { envVar } from "../config.ts";
import { targetsThisDaemon } from "../telemetry/config.ts";
import { run } from "../util/exec.ts";
import { defaultEnvironmentDeps } from "./index.ts";
import { readPlistValue } from "./macos.ts";
import type { FileRead } from "./types.ts";

// What an organization's managed Claude Code policy does with Claude Code's metrics.
//
// A managed policy outranks `~/.claude/settings.json`, so the Cost switch's `env` block can be
// in place and still lose: a policy that sets `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` beats the
// generic endpoint the switch writes, and every session Mission Control merely discovered then
// reports to the policy's host instead of to this daemon. Mission Control never overrides
// managed settings. It reads them only to name that cause in Settings > Cost.
//
// The read is narrow on purpose. A managed `env` block carries other keys that are none of
// Mission Control's business, so only the four below are ever kept, and only a hostname ever
// leaves this module. Nothing here logs.
//
// Precedence decides what Claude Code obeys, so a location that exists but cannot be read stops
// the read with no claim, rather than letting a lower-priority file speak for it: a `plutil`
// timeout on the per-user profile says nothing about what that profile sets, and naming the
// machine profile's host instead could be wrong. Only a location that is not there at all, or a
// JSON file that parses and has no `env` key, gives way to the next. Every other failure - a
// `plutil` timeout or overflow, a malformed plist, an oversized or unparseable JSON file, a file
// that cannot be stat'ed - is no policy: fail closed, claim nothing.

/** The only `env` keys ever kept from a managed policy. */
export const MANAGED_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_METRICS_EXPORTER",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
] as const;

export type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

export interface ManagedClaudeEnv {
  source: ManagedClaudeSettingsSource;
  env: Partial<Record<ManagedEnvKey, string>>;
}

/** What the policy does with metrics. Each kind carries only the host shape valid for it. */
export type ManagedMetricsPolicy =
  | { kind: "redirect"; /** The hostname alone. */ host: string; source: ManagedClaudeSettingsSource }
  | { kind: "disabled"; host: null; source: ManagedClaudeSettingsSource };

/** A location's modification time and size, or why there is none. */
export type ManagedFileStat = { mtimeMs: number; size: number } | "missing" | "unreadable";

export interface ClaudeManagedDeps {
  /** Prefixes every managed path. `/` in production; a fixture directory in tests. */
  root: string;
  /** The login name, for the per-user MDM profile. Null when it cannot be read. */
  user: string | null;
  run: typeof run;
  /** The environment checks' bounded reader, which stops at 64 KiB. */
  readText: (path: string) => Promise<FileRead>;
  /**
   * A path's modification time and size. `missing` only when nothing is there; anything else
   * that cannot be stat'ed as a file - a permission error, a directory - is `unreadable`.
   */
  stat: (path: string) => Promise<ManagedFileStat>;
}

interface ManagedLocation {
  source: ManagedClaudeSettingsSource;
  path: string;
  format: "plist" | "json";
}

/** Claude Code's macOS managed settings locations, highest precedence first. */
export function managedSettingsLocations(root: string, user: string | null): ManagedLocation[] {
  const preferences = join(root, "Library", "Managed Preferences");
  const locations: ManagedLocation[] = [];
  // A name that could leave the directory is no user's profile.
  if (user !== null && user.length > 0 && !user.includes("/") && user !== "." && user !== "..") {
    locations.push({
      source: "mdm-user",
      path: join(preferences, user, "com.anthropic.claudecode.plist"),
      format: "plist",
    });
  }
  locations.push(
    { source: "mdm", path: join(preferences, "com.anthropic.claudecode.plist"), format: "plist" },
    {
      source: "managed-settings",
      path: join(root, "Library", "Application Support", "ClaudeCode", "managed-settings.json"),
      format: "json",
    },
  );
  return locations;
}

/**
 * The managed policy's `env` block, reduced to `MANAGED_ENV_KEYS`, from the highest-precedence
 * location that is present. Null when none is, or when that location cannot be read. Never
 * throws.
 */
export async function readManagedClaudeEnv(
  deps: ClaudeManagedDeps,
): Promise<ManagedClaudeEnv | null> {
  for (const location of managedSettingsLocations(deps.root, deps.user)) {
    // Stat first, so a Mac with no policy at a location never spawns `plutil` for it.
    const info = await deps.stat(location.path);
    if (info === "missing") continue;
    if (info === "unreadable") return null;
    const read = await readLocationEnv(location, deps);
    if (read.kind === "absent") continue;
    if (read.kind === "unreadable") return null;
    return { source: location.source, env: read.env };
  }
  return null;
}

/**
 * One present location's answer.
 *
 * `absent` is a definite "this file sets no env block", and only JSON can say it. A profile
 * cannot: Phase 3's `readPlistValue` answers the same null for a missing `env` key as for a
 * timeout, an overflow or a malformed file, so a profile that does not hand back an `env`
 * dictionary is unreadable. Claiming nothing there is the fail-closed direction.
 */
type LocationRead =
  | { kind: "env"; env: Partial<Record<ManagedEnvKey, string>> }
  | { kind: "absent" }
  | { kind: "unreadable" };

async function readLocationEnv(
  location: ManagedLocation,
  deps: ClaudeManagedDeps,
): Promise<LocationRead> {
  let value: unknown;
  if (location.format === "plist") {
    value = await readPlistValue(location.path, "env", { run: deps.run });
  } else {
    const read = await deps.readText(location.path);
    // A file at the bound may have more after it, and half a JSON document is not a policy.
    if (!read.ok || read.truncated) return { kind: "unreadable" };
    const errors: ParseError[] = [];
    const parsed: unknown = parse(read.text, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !isRecord(parsed)) return { kind: "unreadable" };
    if (!("env" in parsed)) return { kind: "absent" };
    value = parsed.env;
  }
  return isRecord(value) ? { kind: "env", env: pickManagedEnv(value) } : { kind: "unreadable" };
}

/** Only the four keys, as strings. Every other key is dropped unread. */
function pickManagedEnv(env: Record<string, unknown>): Partial<Record<ManagedEnvKey, string>> {
  const picked: Partial<Record<ManagedEnvKey, string>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    const value = env[key];
    // A plist can carry an integer or boolean where Claude Code expects a string. Claude Code
    // sees it as the process environment would, so it is read the same way.
    if (typeof value === "string") picked[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") picked[key] = String(value);
  }
  return picked;
}

/**
 * What the policy does with metrics, or null when it does neither of the two things the panel
 * names. `isThisDaemon` decides whether an endpoint is this daemon's own receiver.
 */
export function classifyManagedMetrics(
  managed: ManagedClaudeEnv | null,
  isThisDaemon: (endpoint: string) => boolean = targetsThisDaemon,
): ManagedMetricsPolicy | null {
  if (managed === null) return null;
  const { env, source } = managed;
  const enable = env.CLAUDE_CODE_ENABLE_TELEMETRY?.trim().toLowerCase();
  if (enable === "0" || enable === "false") return { kind: "disabled", host: null, source };
  if (env.OTEL_METRICS_EXPORTER?.trim().toLowerCase() === "none") {
    return { kind: "disabled", host: null, source };
  }
  const endpoint = (env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT)?.trim();
  if (endpoint === undefined || endpoint.length === 0) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname.length === 0 || isThisDaemon(endpoint)) return null;
  return { kind: "redirect", host: url.hostname, source };
}

// ---- the cached answer ----
//
// `costTelemetryStatus` is synchronous and the dashboard polls it every four seconds, while a
// read can spawn `plutil`. So the poll only ever reads what the last refresh found, and asks
// for another without waiting on it: when any location's modification time or size has
// changed, or a minute has passed. The next poll sees the result.

const REFRESH_AFTER_MS = 60_000;

let cached: ManagedMetricsPolicy | null = null;
let cachedKey: string | null = null;
let readAt: number | null = null;
let inflight: Promise<void> | null = null;
/**
 * Bumped by `forgetManagedMetricsPolicy`. A refresh records the generation it started in and
 * writes nothing if it has moved on, so a read that was in flight when Cost was switched off
 * cannot put its answer back once that answer has been dropped.
 */
let generation = 0;

/** What the managing policy does with metrics, as last read. Never waits and never throws. */
export function managedMetricsPolicy(now = Date.now()): ManagedMetricsPolicy | null {
  if (inflight === null) startRefresh(now);
  return cached;
}

/**
 * Drop the cached answer, so nothing read earlier outlives Cost being switched off.
 *
 * The policy is only read while Cost is on. Clearing here means switching it back on starts
 * from a fresh read instead of showing whatever the last one found, however long ago. A read
 * still in flight is abandoned rather than awaited: its generation is now stale, so it writes
 * nothing when it lands, and the next poll is free to start a fresh one at once.
 */
export function forgetManagedMetricsPolicy(): void {
  generation += 1;
  cached = null;
  cachedKey = null;
  readAt = null;
  inflight = null;
}

/**
 * Start a refresh now, or join the one already running.
 *
 * Called once at daemon start so the first poll's window without an answer is short. Tests
 * await it to see what the next poll will.
 */
export function refreshManagedMetricsPolicy(now = Date.now()): Promise<void> {
  return inflight ?? startRefresh(now);
}

/**
 * Start one refresh and own its in-flight slot.
 *
 * The slot is released from the promise's own `finally`, which runs only after this
 * assignment - releasing it inside `refresh` could run before the assignment when `refresh`
 * returns without awaiting, leaving a settled promise in the slot for good. It is released
 * only if it still holds this refresh, so an abandoned one cannot clear its successor's.
 */
function startRefresh(now: number): Promise<void> {
  const started: Promise<void> = refresh(now, generation).finally(() => {
    if (inflight === started) inflight = null;
  });
  inflight = started;
  return started;
}

async function refresh(now: number, startedIn: number): Promise<void> {
  const settle = (policy: ManagedMetricsPolicy | null, key: string | null): void => {
    if (startedIn !== generation) return;
    cached = policy;
    cachedKey = key;
    readAt = now;
  };
  try {
    const deps = defaultClaudeManagedDeps();
    if (deps === null) {
      settle(null, null);
      return;
    }
    const key = await locationsKey(deps);
    if (key === cachedKey && readAt !== null && now - readAt < REFRESH_AFTER_MS) return;
    settle(classifyManagedMetrics(await readManagedClaudeEnv(deps)), key);
  } catch {
    settle(null, null);
  }
}

/** Every location's modification time and size, so an edit or a removal is noticed at once. */
async function locationsKey(deps: ClaudeManagedDeps): Promise<string> {
  const parts: string[] = [];
  for (const location of managedSettingsLocations(deps.root, deps.user)) {
    const info = await deps.stat(location.path);
    parts.push(`${location.source}:${typeof info === "string" ? info : `${info.mtimeMs}:${info.size}`}`);
  }
  return `${deps.root}\n${parts.join("\n")}`;
}

/**
 * What the reader reads on this machine, built per refresh so nothing is frozen at import.
 *
 * Null under the test runner unless `MISSION_MANAGED_SETTINGS_ROOT` names a fixture root: a
 * test that never set one would otherwise read the developer's real `/Library` policy, and a
 * test is never the place to read it.
 */
export function defaultClaudeManagedDeps(): ClaudeManagedDeps | null {
  const override = envVar("MANAGED_SETTINGS_ROOT");
  const underTest =
    process.env.NODE_TEST_CONTEXT !== undefined || process.env.MISSION_TEST_STATE !== undefined;
  if ((override === undefined || override.length === 0) && underTest) return null;
  return {
    root: override !== undefined && override.length > 0 ? override : "/",
    user: loginName(),
    run,
    readText: defaultEnvironmentDeps().readText,
    stat: async (path) => {
      try {
        const info = await stat(path);
        return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : "unreadable";
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
      }
    },
  };
}

function loginName(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
