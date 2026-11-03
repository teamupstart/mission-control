/**
 * The app's `before-quit` handler: hold every quit until the background stack has drained.
 *
 * Electron reaps utility processes when the main process exits, and `UtilityProcess.kill()`
 * force-kills one about two seconds after asking it to leave, so the daemon's shutdown was cut
 * short either way - and that shutdown is where workflow-check process groups are cancelled
 * through the lease teardown. The checks run detached from the bundle's own executable, so they
 * survived the quit and held the bundle until the update helper's bundle-exit wait gave up and
 * rolled the update back. `test/quit-drain-electron.test.ts` runs this exact handler.
 *
 * Its own module, with no Electron import, so that test can load the shipped handler rather than
 * a copy of it.
 */
export interface QuitDrainApp {
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

export function holdQuitUntilDrained(
  app: QuitDrainApp,
  options: {
    /** Synchronous shell cleanup that runs on every quit request. */
    beforeQuit: () => void;
    /** Whether there is a background stack to wait for at all. */
    owned: () => boolean;
    /** Stop and wait for the background stack. Must settle; callers bound it. */
    drain: () => Promise<void>;
  },
): void {
  let drained = false;
  let draining: Promise<void> | null = null;
  app.on("before-quit", (event) => {
    options.beforeQuit();
    if (drained || !options.owned()) return;
    // Hold the quit until the background stack has drained, then quit again. A second quit
    // request in the meantime lands here too and joins the same drain.
    event.preventDefault();
    draining ??= options.drain().catch(() => {}).finally(() => {
      drained = true;
      app.quit();
    });
  });
}
