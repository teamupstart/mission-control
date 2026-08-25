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
  /**
   * Leave the product's automatic tour default intact for a fresh-profile assertion.
   * Ordinary browser specs turn it off before any page can load, so their setup does not
   * become a test of onboarding.
   */
  guidedTour: boolean;
  daemon: DaemonHandle;
  dashboard: Page;
}>({
  daemonEnv: [{}, { option: true }],
  guidedTour: [false, { option: true }],

  daemon: async ({ daemonEnv, guidedTour }, use) => {
    const daemon = await startDaemon(daemonEnv);
    try {
      if (!guidedTour) {
        const pinned = await fetch(`${daemon.baseURL}/api/ui/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ guidedTour: false }),
        });
        if (!pinned.ok) throw new Error("the daemon should accept the guided-tour pin");
      }
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
   *
   * `guidedDispatch` and the one-time `guidedTour` are then pinned OFF, and
   * `conversationView` to Chat, explicitly, and
   * neither is the same statement as "it ships that way". Roughly fifty specs drive the
   * dispatch modal, and every one of them
   * expects the ordinary form with the caret in the task box; the preference decides which
   * of two forms they get. Left to the shipped default, all of them would silently depend on
   * it, and a default flip would turn the whole suite red for a reason
   * that has nothing to do with the change being made. Pinned here, that flip is one line in
   * `UI_CONFIG_DEFAULTS` and this fixture goes on saying what it always said. The specs that
   * want the pass turn it on for themselves - see `specs/guided-dispatch.spec.ts`.
   * Conversation-facing specs likewise keep their original Chat precondition; the default
   * itself is covered through the raw page fixture in `settings-conversation-picker.spec.ts`.
   *
   * Both halves are needed. The PUT is what `hydrateUiConfig()` adopts as the truth on the
   * next load; the cache write is what the FIRST PAINT reads, synchronously, before that
   * fetch has landed - and the first paint is early enough for a modal to be opened in it.
   */
  dashboard: async ({ page, daemon }, use) => {
    const pinned = await fetch(`${daemon.baseURL}/api/ui/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guidedDispatch: false,
        guidedTour: false,
        conversationView: "chat",
      }),
    });
    expect(pinned.ok, "the daemon should accept the dashboard preference pins").toBe(true);
    await page.goto(`${daemon.baseURL}/#/fleet`);
    await page.evaluate(() => window.localStorage.clear());
    await page.evaluate(() =>
      window.localStorage.setItem(
        "mission-control.ui",
        JSON.stringify({ guidedDispatch: false, guidedTour: false, conversationView: "chat" }),
      ),
    );
    await page.reload();
    await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
    await use(page);
  },
});

export { expect };
