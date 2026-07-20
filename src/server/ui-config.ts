import { UiConfigSchema } from "@shared/protocol.ts";
import type { UiConfig, UiConfigPatch, UiConfigView } from "@shared/protocol.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

// The dashboard's own preferences - layout, keybindings, alert delivery, rich text -
// mirroring harnesses.ts/foreman/config.ts/skills/config.ts: a schema-validated blob over
// the `app_config` KV, so a new key needs no migration.
//
// The daemon stores these and does nothing else with them; no other module reads this
// file. That is the point. They were per-origin `localStorage` until the Mission Control
// rename reset all four (docs/plans/ui-settings-to-daemon/plan.md), and the fix is simply
// to keep them somewhere that is actually per-machine - which the daemon already is.

const CONFIG_KEY = "ui";

/** The current config, with schema defaults applied over whatever was stored. */
export function getUiConfig(): UiConfig {
  return UiConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/**
 * The config plus whether one was ever saved.
 *
 * Read from the KV directly rather than comparing `getUiConfig()` to the defaults: an
 * operator who saves the defaults on purpose HAS configured this, and a value-compare
 * would call that unset and let the dashboard adopt stale `localStorage` over it.
 */
export function uiConfigView(): UiConfigView {
  return { configured: getAppConfig<unknown>(CONFIG_KEY) !== undefined, config: getUiConfig() };
}

/**
 * Merge a patch over the current config, persist, and return the result.
 *
 * A SHALLOW spread is correct here, unlike `setHarnessesConfig`'s per-agent merge: each
 * top-level field is owned whole by one panel, so `{keybindings: {...}}` means "these are
 * now the overrides", not "add these to the ones already there". Merging `keybindings`
 * per-key would make a reset-to-default unexpressible - dropping an override is exactly
 * an absent key - and `resetAll` would silently do nothing.
 */
export function setUiConfig(patch: UiConfigPatch): UiConfig {
  const next = UiConfigSchema.parse({ ...getUiConfig(), ...patch });
  setAppConfig(CONFIG_KEY, next);
  return next;
}
