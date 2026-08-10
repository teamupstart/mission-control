import { CONVERSATION_VIEWS, LAYOUT_MODES, UI_CONFIG_DEFAULTS } from "@shared/protocol.ts";
import type { ConversationView, LayoutMode, UiConfig } from "@shared/protocol.ts";

/**
 * The synchronous first-paint cache for the dashboard's preferences, and the ONLY module
 * that touches `localStorage`.
 *
 * The daemon owns these settings (`app_config.ui`); this is a guess about what it holds,
 * read at module load so `layout` and the keybinding chords are on screen in the first
 * frame instead of a frame of defaults. The moment the fetch lands, the daemon's copy
 * replaces whatever was here.
 *
 * WHICH IS WHY A MISS IS FINE. This store is keyed by ORIGIN and, in the desktop app, by
 * Electron profile - and both have moved: `productName` changed in `52f220f`, minting a
 * fresh profile, and every Vite port is its own bucket. That used to mean a silent reset,
 * because this was the durable copy. Now it means one extra fetch. The failure mode was
 * designed out rather than guarded against; see docs/plans/ui-settings-to-daemon/plan.md.
 */

/** Where the whole blob is cached now. One key, mirroring the one `app_config` key. */
const CACHE_KEY = "mission-control.ui";

/**
 * The per-setting keys this app used before the blob, newest prefix first.
 *
 * Read once, to adopt an existing install's settings into the daemon, and then never
 * again. It is a list rather than a constant because the product has been renamed twice
 * (`ai-harness` -> `fleet-control` in `6862653`, -> `mission-control` in `52f220f`), and
 * each rename stranded the previous generation. The pre-existing fallback only knew about
 * the FIRST of those, so it could never fire; walking every generation is what makes it
 * correct, and this is the last time it has to be.
 */
const LEGACY_PREFIXES = ["mission-control.", "fleet-control.", "ai-harness."] as const;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage disabled or unavailable - run from defaults
  }
}

/** The newest generation that has this suffix, or null if no generation does. */
function readLegacy(suffix: string): string | null {
  for (const prefix of LEGACY_PREFIXES) {
    const v = read(prefix + suffix);
    if (v !== null) return v;
  }
  return null;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // a half-written or hand-edited value is a miss, not a crash
  }
}

/**
 * Field-by-field, never a spread. A blob written by an older or newer build can carry
 * keys that no longer mean anything - `alerts` in particular still holds `afk` and
 * `digestMinutes` on installs that predate away mode moving server-side - and picking
 * fields drops them instead of forwarding them to the daemon to be stored forever.
 */
/**
 * A stored layout is only trusted if it is still a mode we ship. Anything else - a
 * hand-edit, a mode from a future build, a half-written string - is the grid. Checked
 * here rather than only at the render switch because an unrecognised mode read from an
 * old generation would otherwise be adopted and PUT to the daemon as if it were real.
 */
function parseLayout(raw: string | undefined): LayoutMode {
  return (LAYOUT_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as LayoutMode)
    : UI_CONFIG_DEFAULTS.layout;
}

/** Same rule as the layout above, for the same reason: an unrecognised rendering is the
 *  shipped one, never a string adopted from this cache and PUT to the daemon as real. */
function parseConversationView(raw: string | undefined): ConversationView {
  return (CONVERSATION_VIEWS as readonly string[]).includes(raw ?? "")
    ? (raw as ConversationView)
    : UI_CONFIG_DEFAULTS.conversationView;
}

function coerce(raw: Partial<UiConfig> | null): UiConfig {
  return {
    layout: parseLayout(raw?.layout),
    conversationView: parseConversationView(raw?.conversationView),
    keybindings: raw?.keybindings ?? UI_CONFIG_DEFAULTS.keybindings,
    alerts: {
      notifications: raw?.alerts?.notifications ?? UI_CONFIG_DEFAULTS.alerts.notifications,
      sound: raw?.alerts?.sound ?? UI_CONFIG_DEFAULTS.alerts.sound,
    },
    richText: raw?.richText ?? UI_CONFIG_DEFAULTS.richText,
    keybindingHints: raw?.keybindingHints ?? UI_CONFIG_DEFAULTS.keybindingHints,
    // A fresh array either way: the default is a shared frozen literal, and the cache must
    // hand back something the Trust panel can build its next patch from without mutating it.
    trustStaged: raw?.trustStaged ? [...raw.trustStaged] : [],
  };
}

/**
 * Settings left by a build that stored each one under its own key.
 *
 * Returns null when this origin has nothing from any generation, which is the ordinary
 * case and must stay distinguishable from "found, and it says use the defaults" - the
 * caller only pushes a real find up to the daemon.
 */
export function readLegacySettings(): UiConfig | null {
  const layout = readLegacy("layout");
  const keybindings = parseJson<UiConfig["keybindings"]>(readLegacy("keybindings"));
  const alerts = parseJson<Partial<UiConfig["alerts"]>>(readLegacy("alerts"));
  const richText = readLegacy("rich-text");
  if (layout === null && keybindings === null && alerts === null && richText === null) {
    return null;
  }
  return coerce({
    // Unparseable or unknown values fall through to the defaults in `coerce`.
    layout: (layout ?? undefined) as LayoutMode | undefined,
    keybindings: keybindings ?? undefined,
    alerts: alerts as UiConfig["alerts"] | undefined,
    // Only the exact string the old build wrote counts as "off"; anything else is unset.
    richText: richText === null ? undefined : richText === "1",
  });
}

/** The cached config, or the shipped defaults. Safe to call at module load. */
export function readCache(): UiConfig {
  return coerce(parseJson<Partial<UiConfig>>(read(CACHE_KEY)));
}

/** Mirror the daemon's copy locally, so the next load paints it without waiting. */
export function writeCache(config: UiConfig): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(config));
  } catch {
    /* storage unavailable - the daemon still has it; we just repaint from defaults */
  }
}
