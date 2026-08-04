// The Settings status dots, derived in one place so the rail and the topbar gear cannot
// disagree about what a category is flagging. Pure - no React, no fetch - so a test drives
// the whole matrix directly and both surfaces read the same answer.
//
// Every fact here comes from `MissionState.settingsStatus` (the live channel) EXCEPT the
// Foreman dot, which reads App's own `ForemanState` - Foreman is deliberately absent from
// the status payload (App already owns it; shipping it twice invites two answers). The
// trust dot's blind-spot input comes from the two allowlists the Settings page already
// holds, so no new server signal is needed for it either.

import type { SettingsStatus } from "@shared/types.ts";
import type { SettingsCategoryId } from "./settings-registry.ts";

/**
 * The four state-ramp tones a dot can carry. Each maps to a `.settings-dot-<tone>` rule
 * that colours it from an existing token (`--idle`/`--attention`/`--danger`/`--foreman`),
 * so no vendor or new token is named - the same discipline the tone badges keep.
 */
export type SettingsDotTone = "live" | "armed" | "failing" | "foreman";

export interface SettingsDotInputs {
  /** The daemon's status tuple, or null before the first snapshot ("unknown", not "off"). */
  status: SettingsStatus | null;
  /** Foreman's master switch, from App-owned state - never from the payload. */
  foremanEnabled: boolean;
  /**
   * YOLO can merge in a repo the Inspector will not review it. Derived client-side from
   * the merge and review allowlists the page holds; only meaningful once YOLO is armed.
   */
  trustBlindSpot: boolean;
  /**
   * A workflow Check node may execute branch-authored code somewhere right now: checks are
   * switched on AND at least one repository holds the Workflows grant.
   *
   * Its own input rather than folded into `trustBlindSpot`, which is a different claim -
   * that one is a contradiction that stops work, this one is a live capability - and
   * folding them would leave the dot meaning "one of two unrelated things". Both raise the
   * same amber because the rail has one job here: say the panel is worth opening.
   *
   * Client-side for `trustBlindSpot`'s reason: the Workflow config is already held by the
   * page, so the dot needs no new server signal and cannot disagree with the footnote it
   * summarizes.
   *
   * The caller is responsible for it SURVIVING a failed config poll - see
   * `checksArmedReading`. This function only sees the boolean, so a caller that derives it
   * with `config?.checksEnabled ?? false` silently retires the dot five seconds after the
   * daemon goes quiet, and nothing here can tell. That was the first cut of this input.
   */
  trustCheckExecution: boolean;
}

/**
 * The rail dot for one category, or null when it has nothing to flag.
 *
 * The `id` type admits `"trust"` before the registry has it: the rail only ever draws
 * categories that ARE in the registry, so this branch is inert until Phase 2 adds the
 * trust category - which is exactly "guard on the category existing, not on a literal".
 */
export function settingsRailDot(
  id: SettingsCategoryId | "trust",
  { status, foremanEnabled, trustBlindSpot, trustCheckExecution }: SettingsDotInputs,
): SettingsDotTone | null {
  // Foreman's dot is knowable even before the snapshot: App holds that state, not the payload.
  if (id === "foreman") return foremanEnabled ? "foreman" : null;
  // Armed check execution is knowable without the tuple - it comes off the Workflow config
  // the page holds - so it is answered BEFORE the null-status return below. Behind that
  // return it would go dark whenever the SSE snapshot lapsed, which is not a reason to stop
  // saying that branch-authored code may run. (The OTHER way it could go dark, the config
  // poll itself failing, is the caller's to prevent; see the field docs above.)
  if (id === "trust" && trustCheckExecution) return "armed";
  // Everything else needs the daemon's tuple; null status is "unknown", so no dot.
  if (!status) return null;
  switch (id) {
    case "inspector":
      return status.inspector.enabled && status.inspector.mode === "live" ? "live" : null;
    case "shipping":
      return status.shipping.autoMerge ? "armed" : null;
    case "task-sources":
      return status.taskSources.failing > 0 ? "failing" : null;
    case "trust":
      // Armed AND a merge-without-review blind spot somewhere: the same trap the Shipping
      // panel warns about, summarized to one rail dot. The panel's other amber - armed check
      // execution - is handled above, since it does not need the tuple.
      return status.shipping.autoMerge && trustBlindSpot ? "armed" : null;
    default:
      return null;
  }
}

/**
 * The single dot the topbar gear inherits: the worst thing the status tuple says, so a
 * subsystem needing attention is visible without opening Settings.
 *
 * Ranked red > amber > green > none, and derived ONLY from `settingsStatus` - Foreman's
 * purple is a rail affordance, not an alarm, so it never colours the gear. A null status
 * ("unknown") renders no dot rather than a false all-clear.
 */
export function settingsGearDot(status: SettingsStatus | null): SettingsDotTone | null {
  if (!status) return null;
  if (status.taskSources.failing > 0) return "failing";
  if (status.shipping.autoMerge) return "armed";
  if (status.inspector.enabled && status.inspector.mode === "live") return "live";
  return null;
}
