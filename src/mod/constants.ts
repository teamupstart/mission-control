/** The mod's plugin name and marketplace name (spec 7.10: `mission-control@mission-control`). */
export const MOD_NAME = "mission-control";

/**
 * `modApi` in `plugin.json` (spec 7.10a). It changes whenever a daemon route or registration
 * field the mod reads changes in a way an older mod cannot use. Version 8's routes are 1.
 */
export const MOD_API = 1;

/** The pane's id for `$.ui.open` and the `ui.render` matcher (spec 7.10). */
export const PANE_REQUEST_ID = "mission";

/** How often the mod asks the daemon for the inbox (and, while not connected, for health), in ms. */
export const POLL_INTERVAL_MS = 5000;

declare const __MOD_VERSION__: string | undefined;

/**
 * The mod's own version, written into the bundle by `build:mod` (`define`). The registration
 * sends it as `clientVersion` so the daemon's banner can say the two differ. A source run
 * (tests) has no definition and reads `0.0.0-dev`.
 */
export const MOD_VERSION: string = typeof __MOD_VERSION__ === "string" ? __MOD_VERSION__ : "0.0.0-dev";

/** What the pane shows until P12 draws its tabs. */
export const PANE_PLACEHOLDER_TEXT = "The Mission Control pane is not available in this build yet.";
