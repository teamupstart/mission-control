import { CostConfigSchema } from "@shared/protocol.ts";
import type { CostConfig, CostConfigPatch, CostTelemetryStatus } from "@shared/protocol.ts";
import {
  getAppConfig,
  hasSessionUsageSince,
  lastOtelExportSeenAt,
  reportedUsageLedgerHasRows,
  setAppConfig,
} from "./db.ts";
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
 * Both halves are load-bearing, and the pairing is what makes the warning trustworthy rather
 * than merely correct. Silence alone proves nothing: a machine nobody has touched since Friday
 * has no exports because it has no sessions. Session spend alone proves nothing either, because
 * this change made a driver able to supply all of it on its own. Together they say something an
 * operator can act on - the fleet has been working this week, and the exporter has not spoken
 * in that time, so whatever it was supposed to be counting is missing.
 *
 * Deliberately a derived boolean rather than two flags on the wire. The judgement has one
 * reader and one meaning, and computing it here keeps the panel from having to re-derive it -
 * which is how the two would eventually disagree.
 */
function exporterSilentWhileActive(now: number): boolean {
  if (!hasSessionUsageSince(now - OTEL_SILENCE_MS)) return false;
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
  return {
    config: getCostConfig(),
    installed: flags.installed,
    receiving: reportedUsageLedgerHasRows(),
    exporterSilent: exporterSilentWhileActive(now),
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
