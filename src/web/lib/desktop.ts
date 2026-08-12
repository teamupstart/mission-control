/**
 * The Electron shell, as the dashboard is allowed to see it.
 *
 * `window.missionDesktop` is undefined in a browser tab, so every reader has to guard - and
 * the guard is the thing worth writing once. See `mission-desktop.d.ts` for the bridge's shape
 * and `src/preload/index.ts` for what actually backs it.
 */

/**
 * Hand a URL to the operator's browser without navigating the app window.
 *
 * The desktop path is `missionDesktop.openExternal`, which has been exposed in the preload,
 * handled in main and typed in `mission-desktop.d.ts` since the shell was written WITH NO
 * RENDERER CALLER. Until now an external link in a transcript worked only by accident: the
 * click started a real navigation away from the dashboard and `src/main/window.ts`'s
 * `will-navigate` hook caught it on the way out and bounced it to `shell.openExternal`. That
 * is a recovery, not a route, and it means the app window begins tearing down its own document
 * on every external link.
 *
 * `noopener` on the browser path because the opened page must not get a handle on this one.
 */
export function openExternalUrl(url: string): void {
  const desktop = globalThis.window?.missionDesktop;
  if (desktop) {
    void desktop.openExternal(url);
    return;
  }
  globalThis.window?.open(url, "_blank", "noopener");
}
