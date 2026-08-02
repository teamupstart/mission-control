import { AwayConfigSchema } from "@shared/protocol.ts";
import type { AwayConfig, AwayConfigPatch } from "@shared/protocol.ts";
import type { StallThresholds } from "@shared/stall.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

// Away mode's durable config, in app_config alongside Foreman's - same storage,
// same shape (a Zod blob parsed with defaults on every read, so a config written
// by an older build gains new fields rather than failing).

const CONFIG_KEY = "away";

/** The current config, with schema defaults applied over whatever was stored. */
export function getAwayConfig(): AwayConfig {
  return AwayConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/**
 * Merge a patch over the current config, persist, and return the result.
 *
 * `awaySince` is DERIVED here and never merged from the patch, whether or not that
 * patch also flips `away`: entering stamps it, leaving clears it, and anything else
 * leaves it exactly where it was. That keeps "when did you leave" owned by the one
 * place that knows the transition happened, so a client can neither set `away`
 * without a timestamp (leaving the digest with no window to summarise) nor backdate
 * one - a backdated stamp reads to the watcher as a NEW away window and would
 * discard the buffer accumulated so far.
 */
export function setAwayConfig(patch: AwayConfigPatch, now = Date.now()): AwayConfig {
  const cur = getAwayConfig();
  const away = patch.away ?? cur.away;
  const awaySince = away === cur.away ? cur.awaySince : away ? now : null;
  const next = AwayConfigSchema.parse({ ...cur, ...patch, away, awaySince });
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/** The stall thresholds, in the ms the detector wants rather than the minutes a human sets. */
export function stallThresholds(cfg: AwayConfig): StallThresholds {
  return {
    workingMs: cfg.stallWorkingMinutes * 60_000,
    unfinishedMs: cfg.stallUnfinishedMinutes * 60_000,
    escalationMs: cfg.stallEscalationMinutes * 60_000,
  };
}
