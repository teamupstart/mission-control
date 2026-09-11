import { test as base, expect, type Page } from "@playwright/test";

import { startBrowserCoverage } from "./coverage.ts";
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
  /**
   * Leave the first-launch Setup reminder intact for the spec that owns onboarding.
   * Ordinary browser specs acknowledge it before the first page load so their layout and
   * role selectors remain about the surface they were written to exercise.
   */
  setupReminder: boolean;
  daemon: DaemonHandle;
  dashboard: Page;
}>({
  daemonEnv: [{}, { option: true }],
  guidedTour: [false, { option: true }],
  setupReminder: [false, { option: true }],

  daemon: async ({ daemonEnv, guidedTour, setupReminder }, use) => {
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
      if (!setupReminder) {
        const checks = await fetch(`${daemon.baseURL}/api/setup/checks`);
        if (!checks.ok) throw new Error("the daemon should expose the first-launch Setup snapshot");
        const snapshot = await checks.json() as {
          snapshotToken: string;
          banner: { attentionRowIds: unknown[] };
        };
        const acknowledged = await fetch(`${daemon.baseURL}/api/setup/checks`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            snapshotToken: snapshot.snapshotToken,
            acknowledged: snapshot.banner.attentionRowIds,
          }),
        });
        if (!acknowledged.ok) {
          throw new Error("the daemon should accept the first-launch Setup acknowledgement");
        }
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
   * `conversationView` to Chat and `lineDensity` to Expanded, explicitly, and
   * none is the same statement as "it ships that way". Roughly fifty specs drive the
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
   * `lineDensity` is the same story and the newest instance of it. The strip SHIPS
   * condensed, which drops each stage's sentence from the row - and `line-strip.spec.ts`
   * asserts those sentences as its proof that the daemon's fold arrived over SSE at all.
   * Pinned Expanded, that proof goes on saying what it always said, and the shipped default
   * is covered where it belongs: `line-density.spec.ts` sets its own density both ways
   * through the raw page fixture.
   *
   * Both halves are needed. The PUT is what `hydrateUiConfig()` adopts as the truth on the
   * next load; the cache write is what the FIRST PAINT reads, synchronously, before that
   * fetch has landed - and the first paint is early enough for a modal to be opened in it.
   */
  dashboard: async ({ page, daemon }, use) => {
    // Off by default, so an ordinary suite pays nothing for it, and started before the first
    // navigation because V8 counts calls only in functions it compiled with counters in them.
    const stopCoverage = process.env.MC_COVERAGE ? await startBrowserCoverage(page) : null;
    /*
     * Everything after the collector starts is inside the `try`, not only the test body.
     *
     * `use` runs the test, so an assertion that throws would otherwise skip the final drain and
     * the write, and the coverage file would silently be missing every handler that test pressed
     * - a lower number with no error to explain it. The SETUP below belongs in here for the same
     * reason and one more: a preference pin or a navigation that throws leaves the sampling timer
     * and the CDP session running with nothing to stop them.
     */
    try {
      const pinned = await fetch(`${daemon.baseURL}/api/ui/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guidedDispatch: false,
          guidedTour: false,
          conversationView: "chat",
          lineDensity: "expanded",
        }),
      });
      expect(pinned.ok, "the daemon should accept the dashboard preference pins").toBe(true);
      await page.goto(`${daemon.baseURL}/#/fleet`);
      await page.evaluate(() => window.localStorage.clear());
      await page.evaluate(() =>
        window.localStorage.setItem(
          "mission-control.ui",
          JSON.stringify({
            guidedDispatch: false,
            guidedTour: false,
            conversationView: "chat",
            lineDensity: "expanded",
          }),
        ),
      );
      await page.reload();
      await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
      await use(page);
    } finally {
      if (stopCoverage) await stopCoverage();
    }
  },
});

export { expect };
