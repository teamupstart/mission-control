/**
 * The one owner of the headless-mode flag's id. The registry entry, the `/dispatch` route gate,
 * the health capability and the shared contracts all import it, so the Settings switch can
 * never control a different flag from the one the daemon reads. Browser safe.
 */
export const HEADLESS_MODE_FLAG_ID = "headless-mode" as const;
