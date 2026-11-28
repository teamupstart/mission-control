import { FEATURE_FLAGS } from "@shared/feature-flag-registry.ts";
import { resolveFeatureFlag, type FeatureFlagDefinition } from "@shared/feature-flags.ts";
import type { FeatureFlagsSettings } from "../useFeatureFlagsSettings.ts";
export * from "@shared/settings-controls.ts";

/** A runtime get/set pair for one boolean control, supplied by the page. */
export interface ToggleBinding {
  get: () => boolean;
  set: (on: boolean) => void;
}

/** The bindings the page hands the palette, keyed by control id. */
export type SettingsBindings = Map<string, ToggleBinding>;

/**
 * One boolean control's current value and setter, or `null` when its backing state has not
 * loaded yet - a daemon config still in flight. A null source gets NO binding, so the
 * control degrades to a jump.
 */
export type ToggleSource = { value: boolean; set: (on: boolean) => void } | null;

/**
 * Assemble the palette's toggle bindings from the page's current state.
 *
 * A daemon-backed control (auto mode, skills, cost) passes `null` until its config has
 * landed, and gets no binding until then. The reason is the panels' own: they DISABLE the
 * control until the first read, because a flip against an assumed default would either
 * write a guessed value or silently no-op on a refused update. A missing binding makes the
 * palette render that control as a jump (open the panel), which is the honest pre-poll
 * affordance rather than a switch that lies. The browser-local formatting toggle has
 * shipped defaults, so it is always bindable - there is no pre-poll interval to guard.
 *
 * Kept here, beside the index, so the "loaded before bindable" rule is one testable pure
 * function rather than a conditional buried in the page.
 */
export function buildSettingsBindings(sources: {
  formatMessages: { value: boolean; set: (on: boolean) => void };
  guidedDispatch: { value: boolean; set: (on: boolean) => void };
  autoMode: ToggleSource;
  skillsEnabled: ToggleSource;
  costTrack: ToggleSource;
  featureFlags?: FeatureFlagsSettings;
}): SettingsBindings {
  const map: SettingsBindings = new Map();
  map.set("format-messages", {
    get: () => sources.formatMessages.value,
    set: sources.formatMessages.set,
  });
  // Not a `ToggleSource`, for the same reason formatting is not: both are browser-local
  // `UiConfig` booleans with shipped defaults, so there is no pre-poll interval in which
  // their value is unknown and no honest reason to degrade either to a jump.
  map.set("guided-dispatch", {
    get: () => sources.guidedDispatch.value,
    set: sources.guidedDispatch.set,
  });
  const put = (id: string, source: ToggleSource): void => {
    if (source) map.set(id, { get: () => source.value, set: source.set });
  };
  put("auto-mode", sources.autoMode);
  put("skills-enabled", sources.skillsEnabled);
  put("cost-track", sources.costTrack);
  if (sources.featureFlags?.ready && !sources.featureFlags.pending) {
    const state = sources.featureFlags;
    for (const flag of FEATURE_FLAGS as readonly FeatureFlagDefinition[]) {
      map.set(`feature-flag-${flag.id}`, { get: () => resolveFeatureFlag(flag.id, state.config),
        set: enabled => { void state.set({ kind: "flag", id: flag.id, enabled }); } });
    }
  }
  return map;
}
