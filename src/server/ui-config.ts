import { UI_CONFIG_DEFAULTS, UiConfigSchema } from "@shared/protocol.ts";
import type { UiConfig, UiConfigPatch, UiConfigView } from "@shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

// The dashboard's own preferences - layout, keybindings, alert delivery, rich text -
// mirroring harnesses.ts/foreman/config.ts/skills/config.ts: a schema-validated blob over
// the `app_config` KV, so a new key needs no migration.
//
// The daemon stores these and does nothing else with them; no other module reads this
// file. That is the point. They were per-origin `localStorage` until the Mission Control
// rename reset all four (docs/plans/ui-settings-to-daemon/plan.md), and the fix is simply
// to keep them somewhere that is actually per-machine - which the daemon already is.

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.ui;

/**
 * Cards was persisted as `grid` before that layout was retired. Keep the compatibility
 * seam here, at the durable store boundary: the public schema rejects new `grid` writes,
 * while a machine upgrading from an older build is rewritten to the supported Console
 * layout the first time its config is read.
 */
function migrateRetiredLayout(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const stored = raw as Record<string, unknown>;
  return stored.layout === "grid"
    ? { ...stored, layout: UI_CONFIG_DEFAULTS.layout }
    : raw;
}

/**
 * Guided-tour onboarding is for a profile with no UI config yet, not every profile upgraded
 * from a build before this key existed. A missing key on an existing record is therefore an
 * explicit off migration, while `undefined` still reaches the schema's shipped true default.
 */
function migrateGuidedTour(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const stored = raw as Record<string, unknown>;
  return "guidedTour" in stored ? raw : { ...stored, guidedTour: false };
}

/** The current config, with schema defaults applied over whatever was stored. */
export function getUiConfig(persistMigration = true): UiConfig {
  const stored = getAppConfig(CONFIG_ENTRY);
  const migrated = stored === undefined
    ? {}
    : migrateGuidedTour(migrateRetiredLayout(stored));
  const config = UiConfigSchema.parse(migrated);
  if (persistMigration && migrated !== stored && stored !== undefined) {
    setAppConfig(CONFIG_ENTRY, config);
  }
  return config;
}

/**
 * The config plus whether one was ever saved.
 *
 * Read from the KV directly rather than comparing `getUiConfig()` to the defaults: an
 * operator who saves the defaults on purpose HAS configured this, and a value-compare
 * would call that unset and let the dashboard adopt stale `localStorage` over it.
 */
export function uiConfigView(): UiConfigView {
  return { configured: getAppConfig(CONFIG_ENTRY) !== undefined, config: getUiConfig() };
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
  setAppConfig(CONFIG_ENTRY, next);
  return next;
}
