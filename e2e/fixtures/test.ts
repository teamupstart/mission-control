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
export const test = base.extend<{ daemon: DaemonHandle; dashboard: Page }>({
  // Playwright resolves a fixture's dependencies by destructuring its first parameter. This
  // fixture depends on none, so the empty pattern IS the API here, and naming a placeholder
  // would declare a dependency that does not exist.
  // oxlint-disable-next-line no-empty-pattern
  daemon: async ({}, use) => {
    const daemon = await startDaemon();
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
