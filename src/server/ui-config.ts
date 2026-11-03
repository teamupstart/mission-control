import {
  seedHiddenDisplayItems,
  SkinIdSchema,
  UI_CONFIG_DEFAULTS,
  UiConfigSchema,
} from "@shared/protocol.ts";
import type { UiConfig, UiConfigPatch, UiConfigView } from "@shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { isSkinId, skinById, type SkinId } from "@shared/skins.ts";
import { STATE_DIR } from "./config.ts";
import { getAppConfig, setAppConfig } from "./db.ts";
import { rememberWindowBackground, windowBackgroundPath } from "./window-background.ts";

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
 * while a machine upgrading from an older build is rewritten to the shipped default
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

/**
 * The stored skin id exactly as written, when it is one this build does not ship - a skin a
 * newer build added, read here after a downgrade. Null for a known id, a missing one, or
 * anything that is not an id.
 */
function unshippedStoredSkin(stored: unknown): string | null {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
  const skin = (stored as { skin?: unknown }).skin;
  return typeof skin === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(skin) && !isSkinId(skin) ? skin : null;
}

/**
 * Write the whole `ui` record without losing a skin this build cannot represent.
 *
 * An unknown stored id READS as Default (`UiConfigSchema`), so a downgrade still opens. But
 * every write here persists the whole parsed record, and writing that Default back would erase
 * the operator's choice for good: changing an unrelated Display setting in an older build, or
 * this module's own migration write, would leave them on Default after upgrading again. So a
 * write that is not about the skin keeps the stored id as it was. Choosing a skin replaces it.
 */
function persistUiConfig(config: UiConfig, stored: unknown, choosesSkin: boolean): void {
  const unshipped = choosesSkin ? null : unshippedStoredSkin(stored);
  setAppConfig(CONFIG_ENTRY, unshipped === null ? config : ({ ...config, skin: unshipped } as unknown as UiConfig));
}

/** The current config, with schema defaults applied over whatever was stored. */
export function getUiConfig(persistMigration = true): UiConfig {
  const stored = getAppConfig(CONFIG_ENTRY);
  // `seedHiddenDisplayItems` is shared rather than written here, for the reason its own
  // comment gives: the browser's `localStorage` copy is what the FIRST PAINT reads, so a
  // migration only the daemon performed would show the item switched on for one frame and
  // then correct itself. Runs on the raw record, like the two above, so the absence of its
  // marker still means "written before this build".
  const migrated = stored === undefined
    ? {}
    : seedHiddenDisplayItems(migrateGuidedTour(migrateRetiredLayout(stored)));
  const config = UiConfigSchema.parse(migrated);
  if (persistMigration && migrated !== stored && stored !== undefined) {
    persistUiConfig(config, stored, false);
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
  // The stored schema reads an unknown skin as Default (a downgrade must still open), so the
  // merged parse below would quietly store Default for a bad id. Refuse it here instead, as
  // the route's patch schema does, so no caller can write a skin by accident.
  if (patch.skin !== undefined) SkinIdSchema.parse(patch.skin);
  const stored = getAppConfig(CONFIG_ENTRY);
  const next = UiConfigSchema.parse({ ...getUiConfig(), ...patch });
  persistUiConfig(next, stored, patch.skin !== undefined);
  if (patch.skin !== undefined) syncWindowBackground(next.skin);
  return next;
}

/**
 * The stored skin on its own, for the two readers that run outside a settings request: daemon
 * startup and serving the dashboard document.
 *
 * Deliberately NOT `getUiConfig(false).skin`. That parses the whole record strictly, so one
 * malformed field elsewhere (a hand-edited `layout`, a record from a newer build) would throw -
 * aborting daemon startup, or failing every page load. Reading only `skin` keeps a valid stored
 * Daylight in force even then. An unknown or unreadable skin is Default, as `UiConfigSchema`
 * reads it, and this never throws.
 */
export function storedSkin(): SkinId {
  try {
    const stored = getAppConfig(CONFIG_ENTRY) as unknown as { skin?: unknown } | null | undefined;
    const skin = typeof stored === "object" && stored !== null ? stored.skin : undefined;
    return isSkinId(skin) ? skin : UI_CONFIG_DEFAULTS.skin;
  } catch (error) {
    console.warn("[ui-config] could not read the stored skin:", error);
    return UI_CONFIG_DEFAULTS.skin;
  }
}

/**
 * Keep the desktop window's launch colour in step with the stored skin.
 *
 * The shell paints its window before the dashboard loads, from a file in the state home
 * (`window-background.ts`), and this is that file's only writer. A page's own reports are
 * never persisted, since a page can be showing a stale skin, so a skin chosen anywhere -
 * a browser tab included - reaches the next desktop launch only through here. Called on every
 * skin write, after a settings restore, and at daemon startup. The colour is the registry's
 * swatch, which `test/skins.test.ts` holds equal to the skin's own `--bg`. Never throws, so it
 * can neither fail the write that prompted it nor abort startup.
 */
export function syncWindowBackground(skin?: SkinId): void {
  try {
    rememberWindowBackground(windowBackgroundPath(STATE_DIR), skinById(skin ?? storedSkin()).swatches.bg);
  } catch (error) {
    console.warn("[ui-config] could not remember the window background:", error);
  }
}
