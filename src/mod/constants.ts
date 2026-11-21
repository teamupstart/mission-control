/** The mod's plugin name and marketplace name (spec 7.10: `mission-control@mission-control`). */
export const MOD_NAME = "mission-control";

/**
 * `modApi` in `plugin.json` (spec 7.10a). It changes whenever a daemon route or registration
 * field the mod reads changes in a way an older mod cannot use. Version 8's routes are 1.
 */
export const MOD_API = 1;

/** The pane's id for `$.ui.open` and the `ui.render` matcher (spec 7.10). */
export const PANE_REQUEST_ID = "mission";
