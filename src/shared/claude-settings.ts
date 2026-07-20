import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";

// Surgical edits to `~/.claude/settings.json`'s `env` block - the one switch that makes
// every Claude Code session on the machine export cost telemetry to the daemon.
//
// Shared, and shared for a specific reason: THREE installers write this same block. The
// CLI (`hooks/install.mjs`), the packaged app's "Install Claude integrations"
// (`src/main/integrations.ts`), and the dashboard's Cost settings panel (through
// `src/server/cost.ts`) must produce byte-identical keys, or an install from one and an
// uninstall from another leaves half a block behind that nothing owns. `hooks/install.mjs`
// and `integrations.ts` already keep hand-mirrored copies of the hook-event list and pay
// for it (see CLAUDE.md); this is that lesson applied ahead of time rather than after.
//
// Kept dependency-free on purpose - node builtins and jsonc-parser, nothing else. It is
// imported by the Electron main bundle, which must not pull the daemon (and `node:sqlite`
// with it) in through a transitive edge.
//
// The edit is merge-only and key-scoped, like the hook installer's: keys the user set
// themselves are read, never rewritten, and an uninstall removes only the keys we added.
// This is their file.

/** The env keys we own. APPEND-ONLY - see the note on `uninstall` below. */
const OTEL_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_METRIC_EXPORT_INTERVAL",
] as const;

/**
 * The attribution switch, named but deliberately NOT written.
 *
 * It defaults to true, and true is what we need: false makes Claude Code export every
 * datapoint without a `session.id`, which the ingest can only drop. Writing `"true"`
 * would be writing a default, and would then have to be un-written on uninstall - so it
 * is only ever READ, to warn when someone else has turned it off.
 */
const SESSION_ID_KEY = "OTEL_METRICS_INCLUDE_SESSION_ID";

/** What the OTel env block should say. `null` means "remove ours". */
export interface OtelEnvSpec {
  /** Daemon base URL; the exporter appends `/v1/metrics`. */
  endpoint: string;
  /** The daemon auth token, sent as a header the OTLP route checks. */
  token: string;
  /** `OTEL_METRIC_EXPORT_INTERVAL` in ms. */
  intervalMs: number;
}

/** Path we edit. Overridable by the same env var `hooks/install.mjs` honours, for tests. */
export function claudeSettingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), ".claude", "settings.json");
}

/** The exact key/value pairs an install writes. One definition, three installers. */
export function otelEnvBlock(spec: OtelEnvSpec): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    // http/json rather than the default protobuf, so the daemon parses the export with
    // `JSON.parse` and the app takes no protobuf dependency for one route.
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: spec.endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: `x-harness-token=${spec.token}`,
    OTEL_METRIC_EXPORT_INTERVAL: String(spec.intervalMs),
  };
}

/** Read + parse the settings file, or `{}`. Throws only when the file is genuinely broken. */
function readSettings(path: string): { text: string; parsed: Record<string, unknown> } {
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const errors: unknown[] = [];
  const parsed = parse(original || "{}", errors as never[], { allowTrailingComma: true }) as
    | Record<string, unknown>
    | undefined;
  if (original.trim() && errors.length > 0) {
    throw new Error(`${path} is not valid JSON/JSONC - fix it and retry.`);
  }
  return { text: original, parsed: parsed && typeof parsed === "object" ? parsed : {} };
}

/** The `env` object as it stands, or `{}` when absent or malformed. */
function currentEnv(parsed: Record<string, unknown>): Record<string, unknown> {
  const env = parsed.env;
  return env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : {};
}

/**
 * Install or remove the OTel env block, writing only if something actually changed.
 *
 * Returns what happened, so an installer can say so instead of claiming an edit it
 * didn't make. `spec === null` uninstalls: it deletes exactly `OTEL_KEYS` and drops an
 * `env` object left empty by that removal, so a user who had no `env` before us gets
 * their file back as it was.
 *
 * Values are compared before writing because these installers are idempotent by contract
 * and get re-run constantly - a rewrite that changed nothing would still restamp the
 * file's mtime and, worse, would make "nothing to do" indistinguishable from "done".
 */
export function writeOtelEnv(spec: OtelEnvSpec | null): "installed" | "updated" | "removed" | "unchanged" {
  const path = claudeSettingsPath();
  const { text: original, parsed } = readSettings(path);
  const env = currentEnv(parsed);
  const had = OTEL_KEYS.some((k) => env[k] !== undefined);

  const desired: Record<string, unknown> = { ...env };
  if (spec) {
    for (const [k, v] of Object.entries(otelEnvBlock(spec))) desired[k] = v;
  } else {
    for (const k of OTEL_KEYS) delete desired[k];
  }
  if (JSON.stringify(desired) === JSON.stringify(env)) return "unchanged";

  // Match the file's own formatting so anything we insert blends in - same as the hook
  // installer, which is what keeps a settings.json from churning across installers.
  const formattingOptions = {
    insertSpaces: !/^\t/m.test(original),
    tabSize: (original.match(/\n( +)\S/) ?? [, "  "])[1]?.length ?? 2,
    eol: (original.includes("\r\n") ? "\r\n" : "\n") as "\n" | "\r\n",
  };
  let text = original.trim() ? original : "{}";
  const empty = Object.keys(desired).length === 0;
  text = applyEdits(
    text,
    modify(text, ["env"], empty ? undefined : desired, { formattingOptions }),
  );
  if (!original && !text.endsWith(formattingOptions.eol)) text += formattingOptions.eol;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (!spec) return "removed";
  return had ? "updated" : "installed";
}

/** What one look at the settings file can tell us about the telemetry env block. */
export interface OtelEnvFlags {
  /** Our telemetry keys are present in the settings file right now. */
  installed: boolean;
  /**
   * `OTEL_METRICS_INCLUDE_SESSION_ID` is switched off somewhere we can see.
   *
   * Both places it can be: the process environment the daemon inherited, and the settings
   * file every Claude session inherits. Neither is authoritative over the other - a session
   * gets the settings value, this process got the env one - so a false in either is worth
   * warning about, and neither is worth silently correcting in someone else's file.
   */
  sessionIdDisabled: boolean;
}

/**
 * Both facts off ONE read and parse of the settings file.
 *
 * Combined rather than derived separately because the status route behind them is polled
 * by every open dashboard tab, and two callers each re-reading and re-JSONC-parsing the
 * user's settings file on the daemon's main thread is a synchronous cost paid per poll
 * for an answer a single parse already holds.
 */
export function otelEnvFlags(): OtelEnvFlags {
  let env: Record<string, unknown> = {};
  try {
    env = currentEnv(readSettings(claudeSettingsPath()).parsed);
  } catch {
    // An unparseable settings.json is a real problem, but not this function's to report:
    // "we cannot see our keys" is the honest answer, and the write path throws properly.
  }
  const off = (v: unknown): boolean => typeof v === "string" && v.trim().toLowerCase() === "false";
  return {
    installed:
      env.CLAUDE_CODE_ENABLE_TELEMETRY !== undefined && env.OTEL_METRICS_EXPORTER !== undefined,
    sessionIdDisabled: off(process.env[SESSION_ID_KEY]) || off(env[SESSION_ID_KEY]),
  };
}

/** True when our telemetry keys are present in the settings file right now. */
export function otelEnvInstalled(): boolean {
  return otelEnvFlags().installed;
}

/** True when `OTEL_METRICS_INCLUDE_SESSION_ID` is switched off anywhere we can see. */
export function sessionIdAttributionDisabled(): boolean {
  return otelEnvFlags().sessionIdDisabled;
}
