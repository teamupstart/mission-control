import { test as base, expect, type Page } from "@playwright/test";

import { startDaemon, type DaemonHandle } from "./daemon.ts";

/**
 * The suite's own `test`, with a daemon attached.
 *
 * The daemon is TEST-scoped, not worker-scoped, and that costs about a second and a half
 * per test on purpose. Sharing one daemon across a file makes every test a function of the
 * ones before it: a spec that asserts "exactly one session on the fleet" silently depends on
 * running before the spec that dispatches a second, and reordering or `-g`-filtering the
 * file breaks it in a way that reads as a product bug. A fresh daemon per test means each
 * one states its own preconditions.
 */
export const test = base.extend<{
  /**
   * Extra environment for THIS file's daemon, through `test.use({ daemonEnv: … })`.
   *
   * An option rather than an argument because the daemon boots before a test body runs, so a
   * spec that needs a different cadence has no other moment to say so. Per file rather than
   * in the shared list in `daemon.ts` deliberately: every override there runs in all four
   * workers' daemons for every spec in the suite, and a poller sped up for one spec is
   * background work the other fifty pay for.
   */
  daemonEnv: Record<string, string>;
  daemon: DaemonHandle;
  dashboard: Page;
}>({
  daemonEnv: [{}, { option: true }],

  daemon: async ({ daemonEnv }, use) => {
    const daemon = await startDaemon(daemonEnv);
    try {
      await use(daemon);
    } finally {
      await daemon.stop();
    }
  },

  /**
   * The dashboard, loaded on the fleet page with a clean slate.
   *
   * `localStorage` is cleared because the dispatch modal pre-seeds its repo field from
   * `mission-control.dispatch.repo`. A fresh browser context starts empty, but a reused
   * profile - or a second test in the same context - would open the modal pointed at a repo
   * this daemon has never heard of.
   */
  dashboard: async ({ page, daemon }, use) => {
    await page.goto(`${daemon.baseURL}/#/fleet`);
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
    await use(page);
  },
});

export { expect };
