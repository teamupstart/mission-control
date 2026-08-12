/**
 * The Electron shell, as the dashboard is allowed to see it.
 *
 * `window.missionDesktop` is undefined in a browser tab, so every reader has to guard - and
 * the guard is the thing worth writing once. See `mission-desktop.d.ts` for the bridge's shape
 * and `src/preload/index.ts` for what actually backs it.
 */

/**
 * What `openExternalUrl` reaches for, injectable the way `copyText` takes its environment.
 *
 * Read at call time from the real `window` by default. A parameter rather than a module-level
 * capture because `window.missionDesktop` is installed by the preload before the bundle runs
 * in one build and never in the other, and because the browser arm is otherwise unreachable
 * from a test.
 */
export interface ExternalOpenEnvironment {
  desktop?: { openExternal(url: string): Promise<void> } | null;
  open?: ((url: string, target: string, features: string) => unknown) | null;
}

function browserEnvironment(): ExternalOpenEnvironment {
  const win = globalThis.window;
  return {
    desktop: win?.missionDesktop ?? null,
    open: win ? (url, target, features) => win.open(url, target, features) : null,
  };
}

/**
 * Hand a URL to the operator's browser without navigating the app window.
 *
 * The desktop path is `missionDesktop.openExternal`, which has been exposed in the preload,
 * handled in main and typed in `mission-desktop.d.ts` since the shell was written WITH NO
 * RENDERER CALLER. Until the context menu, an external link in a transcript worked only by
 * accident: the click started a real navigation away from the dashboard and
 * `src/main/window.ts`'s `will-navigate` hook caught it on the way out and bounced it to
 * `shell.openExternal`. That is a recovery, not a route, and it means the app window begins
 * tearing down its own document on every external link.
 *
 * REJECTS rather than reporting success blindly. `shell.openExternal` can refuse - a malformed
 * URL, a scheme with no registered handler - and that rejection travels back over the IPC
 * invoke, so a caller that fires and forgets both loses the error and leaves an unhandled
 * rejection behind. Callers await this and route the failure the way they route any other.
 *
 * The browser arm cannot report, and says so rather than pretending: `noopener` makes
 * `window.open` return `null` on SUCCESS as well as when a popup blocker refuses, so there is
 * nothing to test. Dropping `noopener` to get a testable handle back would hand the opened
 * page a reference to the dashboard, which is a worse trade than an unreported blocked popup.
 */
export async function openExternalUrl(
  url: string,
  environment: ExternalOpenEnvironment = browserEnvironment(),
): Promise<void> {
  if (environment.desktop) {
    await environment.desktop.openExternal(url);
    return;
  }
  if (!environment.open) throw new Error("There is nowhere to open a link from here");
  environment.open(url, "_blank", "noopener");
}
