import { CostConfigSchema } from "@shared/protocol.ts";
import type { CostConfig, CostConfigPatch, CostTelemetryStatus } from "@shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  getAppConfig,
  hasClaudeSessionUsageSince,
  lastOtelExportSeenAt,
  reportedUsageLedgerHasRows,
  setAppConfig,
} from "./db.ts";
import {
  claudeSettingsPath,
  otelEnvFlags,
  preflightOtelEnvWrite,
  sessionIdAttributionDisabled,
  writeOtelEnv,
} from "@shared/claude-settings.ts";
import { PORT } from "./config.ts";
import { ensureToken } from "./auth.ts";

// The "Cost" settings section, mirroring foreman/config.ts, skills/config.ts and
// harnesses.ts: a schema-validated blob over the `app_config` KV, so a new key needs no
// migration.
//
// One thing here is unlike its three siblings, and it is the thing to be careful about:
// `enabled` does not merely change what the daemon does with data it already has - it
// EDITS THE USER'S `~/.claude/settings.json`, adding (or removing) the `env` block that
// makes every Claude Code session on the machine export telemetry to us. That is why the
// default is off, why the write is surgical and merge-only, and why the panel reports what
// is actually in the file rather than what this config says should be.
//
// The env block rather than a per-spawn variable is deliberate: Mission Control's premise
// is passive discovery - it sees sessions it did not start - and only a settings-level
// `env` reaches those.

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.cost;

/**
 * When the grace period before exporter silence counts as a fault last started.
 *
 * "Started", not "the user clicked the toggle" - the UI is one of two ways this gets set, and
 * treating it as the only one would reintroduce the exact bug this stamp exists to prevent for
 * anyone who reached `installed` a different way. `npm run install-telemetry` writes the `env`
 * block directly and never calls `setCostConfig`; so does an operator hand-editing
 * `~/.claude/settings.json`; so does upgrading a daemon that already had the block installed
 * before this stamp existed. All three leave this key unset with `installed` true, and a
 * grace period that only the UI can start would stay unset - and therefore silent - forever
 * for every one of them. See the self-healing backfill in `costTelemetryStatus`.
 */
const ENABLED_AT_ENTRY = APP_CONFIG_ENTRIES.costTelemetryEnabledAt;

/** The current config, with schema defaults applied over whatever was stored. */
export function getCostConfig(): CostConfig {
  return CostConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/**
 * Merge a patch over the current config, reconcile `~/.claude/settings.json`, persist.
 *
 * The file write happens BEFORE the store, so a refusal (an unparseable settings.json, a
 * read-only home) leaves the recorded intent matching reality rather than claiming a
 * telemetry block that was never written. A config that lies about the user's file is
 * worse than an edit that failed loudly.
 */
export function setCostConfig(patch: CostConfigPatch, now = Date.now()): CostConfig {
  const previous = getCostConfig();
  const next = CostConfigSchema.parse({ ...previous, ...patch });
  writeOtelEnv(
    next.enabled
      ? {
          endpoint: `http://127.0.0.1:${PORT}`,
          token: ensureToken(),
          intervalMs: next.exportIntervalMs,
        }
      : null,
  );
  setAppConfig(CONFIG_ENTRY, next);
  // When telemetry is switched ON, start its grace period. The exporter cannot report before it
  // has been asked to, and the `env` block only reaches sessions started AFTER it is written, so
  // there is a stretch where no export has arrived and nothing is wrong. Without this stamp the
  // silence warning fires the moment someone enables the toggle and dispatches one session -
  // seconds in, quoting a week that has not happened.
  //
  // Re-stamped on every off->on transition rather than written once, so switching telemetry off
  // and on again earns a fresh grace period instead of inheriting a stale one. Cleared on the way
  // off, because a stamp for a feature that is not running would silently shorten the next one.
  if (next.enabled && !previous.enabled) setAppConfig(ENABLED_AT_ENTRY, now);
  if (!next.enabled) setAppConfig(ENABLED_AT_ENTRY, null);
  return next;
}

/** Read-only restore preflight for the one external file Cost owns. */
export function preflightCostReconcile(): void {
  preflightOtelEnvWrite();
}

/**
 * Make Claude's telemetry block match persisted intent without changing that intent.
 * Safe on startup and after restore; the underlying editor is idempotent.
 */
export function reconcileCostTelemetry(
  config: CostConfig = getCostConfig(),
): ReturnType<typeof writeOtelEnv> {
  return writeOtelEnv(
    config.enabled
      ? {
          endpoint: `http://127.0.0.1:${PORT}`,
          token: ensureToken(),
          intervalMs: config.exportIntervalMs,
        }
      : null,
  );
}

/** When the grace period started, or null if telemetry is not installed or has none yet. */
function telemetryEnabledAt(): number | null {
  const stored = getAppConfig(ENABLED_AT_ENTRY);
  return typeof stored === "number" ? stored : null;
}

/**
 * Start the grace period NOW, once, for an installation the toggle never stamped.
 *
 * Called only when `flags.installed` is true and no stamp exists - which is `installed` read
 * from the actual file, independent of whether `setCostConfig` was ever the thing that put the
 * `env` block there. A single write per installation, same shape as `noteOtelExportSeen`'s
 * throttle: once this lands, `telemetryEnabledAt()` is non-null on every later read and this
 * is never called again for it.
 */
function backfillEnabledAt(now: number): void {
  setAppConfig(ENABLED_AT_ENTRY, now);
}

/**
 * How long the exporter may stay quiet before its silence counts as a fault.
 *
 * Exports arrive every `exportIntervalMs` while any Claude session is alive, so a working
 * exporter on a machine in use refreshes this many times an hour and never approaches the
 * window. It is measured in days anyway, because the alternative failure is worse than a slow
 * alarm: a tight window turns every quiet weekend into a warning, and a panel that cries wolf
 * is a panel an operator learns to scroll past - which is how the silent failure this change
 * exists to surface would become invisible again for a second time.
 */
const OTEL_SILENCE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the exporter is silent WHILE there is work it should have reported.
 *
 * Three conditions, and each one guards against a real false alarm this change would
 * otherwise have produced:
 *
 *   1. Recent CLAUDE session spend, or silence proves nothing. A machine nobody has touched
 *      since Friday has no exports because it has no sessions.
 *   2. The grace period has elapsed, or the warning fires the moment someone enables telemetry
 *      and dispatches one driven session - the single most common action in the app.
 *      `hasClaudeSessionUsageSince` is satisfied by the DRIVER's rows, not only the exporter's,
 *      so it goes true in seconds while the exporter has not had one export interval yet, let
 *      alone a week.
 *   3. No export in the grace period, or nothing is actually missing.
 *
 * `enabledAt` is backfilled by the caller before this runs, so it reads null here only for an
 * installation with `flags.installed` false - nothing is running to be silent about, and this
 * returns false on that ground before it would matter.
 *
 * Deliberately a derived boolean rather than flags on the wire. The judgement has one reader
 * and one meaning, and computing it here keeps the panel from having to re-derive it - which
 * is how the pieces would eventually disagree.
 */
function exporterSilentWhileActive(now: number, enabledAt: number | null): boolean {
  if (enabledAt === null || now - enabledAt < OTEL_SILENCE_MS) return false;
  if (!hasClaudeSessionUsageSince(now - OTEL_SILENCE_MS)) return false;
  const seen = lastOtelExportSeenAt();
  return seen === null || now - seen > OTEL_SILENCE_MS;
}

/**
 * Config plus what is actually true of the user's settings file and ledger right now.
 *
 * One `otelEnvFlags()` for both file facts, not one call each: the dashboard polls this while
 * it is open, and the settings file is read and JSONC-parsed synchronously on the daemon's
 * own thread.
 *
 * `now` is a parameter so the staleness judgement can be tested without waiting a week for it.
 */
export function costTelemetryStatus(now = Date.now()): CostTelemetryStatus {
  const flags = otelEnvFlags();
  let enabledAt = telemetryEnabledAt();
  // Backfilled here, not in `setCostConfig`, because `installed` can become true without that
  // function ever running - see `ENABLED_AT_ENTRY`'s doc. This is the read path everyone shares.
  if (flags.installed && enabledAt === null) {
    backfillEnabledAt(now);
    enabledAt = now;
  }
  return {
    config: getCostConfig(),
    installed: flags.installed,
    receiving: reportedUsageLedgerHasRows(),
    exporterSilent: exporterSilentWhileActive(now, enabledAt),
    sessionIdDisabled: flags.sessionIdDisabled,
    settingsPath: claudeSettingsPath(),
  };
}

/**
 * Warn at boot when per-session attribution has been switched off.
 *
 * `OTEL_METRICS_INCLUDE_SESSION_ID` defaults true and must stay true: with it false every
 * datapoint arrives without a `session.id`, `applyOtelMetrics` drops it as unattributable,
 * and the ledger stays empty. The symptom is a cost feature that appears installed and
 * silently records nothing - so this asserts it at startup rather than leaving someone to
 * discover empty cardinality days later.
 */
export function warnIfSessionAttributionDisabled(): void {
  if (!sessionIdAttributionDisabled()) return;
  console.warn(
    "[cost] OTEL_METRICS_INCLUDE_SESSION_ID is false - Claude Code will export cost " +
      "metrics with no session.id, so nothing can be attributed to a session and the " +
      "usage ledger will stay empty. Unset it (it defaults to true) to fix.",
  );
}
