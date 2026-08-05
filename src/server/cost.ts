import { CostConfigSchema } from "@shared/protocol.ts";
import type { CostConfig, CostConfigPatch, CostTelemetryStatus } from "@shared/protocol.ts";
import { getAppConfig, otelUsageHasRows, reportedUsageLedgerHasRows, setAppConfig } from "./db.ts";
import {
  claudeSettingsPath,
  otelEnvFlags,
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

const CONFIG_KEY = "cost";

/** The current config, with schema defaults applied over whatever was stored. */
export function getCostConfig(): CostConfig {
  return CostConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/**
 * Merge a patch over the current config, reconcile `~/.claude/settings.json`, persist.
 *
 * The file write happens BEFORE the store, so a refusal (an unparseable settings.json, a
 * read-only home) leaves the recorded intent matching reality rather than claiming a
 * telemetry block that was never written. A config that lies about the user's file is
 * worse than an edit that failed loudly.
 */
export function setCostConfig(patch: CostConfigPatch): CostConfig {
  const next = CostConfigSchema.parse({ ...getCostConfig(), ...patch });
  writeOtelEnv(
    next.enabled
      ? {
          endpoint: `http://127.0.0.1:${PORT}`,
          token: ensureToken(),
          intervalMs: next.exportIntervalMs,
        }
      : null,
  );
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/**
 * Config plus what is actually true of the user's settings file right now.
 *
 * One `otelEnvFlags()` for both facts, not one call each: the dashboard polls this while
 * it is open, and the settings file is read and JSONC-parsed synchronously on the
 * daemon's own thread.
 */
export function costTelemetryStatus(): CostTelemetryStatus {
  const flags = otelEnvFlags();
  return {
    config: getCostConfig(),
    installed: flags.installed,
    receiving: reportedUsageLedgerHasRows(),
    otelExporting: otelUsageHasRows(),
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
