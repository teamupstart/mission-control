import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectSpotlight } from "../fixtures/tour-spotlight.ts";

/**
 * The engine's own guarantees, as a browser can see them.
 *
 * `see-work-tour.spec.ts` is the regression proof that the one shipped tour still behaves
 * exactly as it did. This file asserts what the engine adds underneath it: entry points drawn
 * from one registry, one active run whichever doorway asks, and a restoration that replays the
 * complete route rather than a per-tour list of fields.
 *
 * The automatic first-launch tour is Set up this machine, so the two fresh-profile cases below
 * read its first stop; `setup-banner-and-tour.spec.ts` walks the whole of it.
 */
const TOUR_COMMAND = /Start See the work tour, command/;
const EVIDENCE = artifactsDir("guided-tour-default");

test.describe.configure({ timeout: 90_000 });
// This file owns the fresh-profile case. The shared browser fixture otherwise turns the
// one-time default off so unrelated specs can state their own visible preconditions.
test.use({ guidedTour: true });

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

function step(page: Page, title: string) {
  return page.getByRole("dialog", { name: title }).or(page.getByRole("status", { name: title }));
}

/** A frame of the automatic first-launch orientation, after its assertions have passed. */
async function shoot(target: Page): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}fresh-profile-tour.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log("CAPTURED e2e/.artifacts/guided-tour-default/fresh-profile-tour.png");
}

const FIRST_RUN_STOP = "Settings live behind the gear";

test("a fresh profile enables and starts the guided tour by default", async ({ page, daemon }) => {
  const initial = await api<{ configured: boolean; config: { guidedTour: boolean } }>(
    daemon,
    "/api/ui/config",
  );
  expect(initial.configured).toBe(false);
  expect(initial.config.guidedTour).toBe(true);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const first = step(page, FIRST_RUN_STOP);
  await expect(first).toBeVisible();
  await expect(first).toContainText("Step 1 of 7");
  // The stop that teaches where Settings is spotlights the gear, and the gear only reads
  // "Settings" from somewhere else - so the automatic tour opens on the fleet.
  await expectSpotlight(page.locator(".gear-btn"));
  await shoot(page);

  // The default is one-time: starting the orientation records it before a later dashboard
  // visit can reopen the overlay over the operator's work.
  await expect.poll(async () => (
    await api<{ config: { guidedTour: boolean } }>(daemon, "/api/ui/config")
  ).config.guidedTour).toBe(false);
  await first.getByRole("button", { name: "Exit tour" }).click();
  await expect(first).toBeHidden({ timeout: 30_000 });
  // Exiting this tour LEAVES the operator on the page it hands over - Trust, its last stop -
  // rather than replaying the route it started from. Introducing a panel and then taking it
  // away would undo the whole point, and the exit route belongs to the tour rather than to
  // the stop it was abandoned at.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/settings/trust");
  // Focus ARRIVES here rather than being here already: the coachmark's teardown leaves the
  // document root focused, and the landing pass puts the keyboard on the rail row naming the
  // category it left the operator on, once the page has committed. `toBeFocused` waits for
  // that, which is the guarantee.
  await expect(page.locator("#settings-tab-trust")).toBeFocused();

  // Having landed, the pass is done rather than lying in wait. It survives the teardown by
  // watching, and the vacuum it watches for is also what an ordinary click on a non-focusable
  // area leaves behind, so a pass still running would answer that click by pulling focus
  // back. Click the Setup heading the way an operator would, then watch every frame - the
  // unit the pass counts its own window in - for longer than that window.
  await page.getByRole("heading", { name: "Trust", exact: true }).click();
  const reclaimed = await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise((settle) => requestAnimationFrame(() => settle(null)));
      if (document.activeElement !== document.body) {
        return (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "unknown";
      }
    }
    return null;
  }, 200);
  expect(reclaimed, "the landing pass took focus back after it had already landed").toBeNull();
  await expectToursCleaned(daemon);
});

test("a rejected tour-consumption write stays consumed after reload", async ({ page, daemon }) => {
  let rejectedWrites = 0;
  await page.route("**/api/ui/config", async (route) => {
    if (route.request().method() === "PUT") {
      rejectedWrites += 1;
      await route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
      return;
    }
    await route.continue();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const first = step(page, FIRST_RUN_STOP);
  await expect(first).toBeVisible();
  await expect.poll(() => rejectedWrites).toBeGreaterThan(0);
  await first.getByRole("button", { name: "Exit tour" }).click();
  await expect(first).toBeHidden({ timeout: 30_000 });
  await expectToursCleaned(daemon);

  await page.reload();
  await expect(step(page, FIRST_RUN_STOP)).toBeHidden();
});

/**
 * Every temporary task the tour created is closed with its own fixed outcome.
 *
 * Two deliberate departures from the obvious `.every(...)` / `.toBe(true)` spelling:
 *
 * - **An explicit timeout.** `expect.poll` defaults to five seconds. Exiting a tour closes its
 *   tasks through a daemon round trip, and on a CI runner sharing four cores between three
 *   Playwright workers that has taken longer than five - which failed this spec on `main`
 *   while the cleanup itself was fine. Thirty seconds matches the `toBeHidden` waits either
 *   side of it. It is a ceiling, not a delay: a clean run still returns on the first poll.
 * - **It returns the offending rows, not a boolean.** `true !== false` names neither the task
 *   that was still open nor what state it was in, so the failure said nothing about whether
 *   cleanup was slow or broken. An empty-array assertion prints the row.
 */
async function expectToursCleaned(daemon: DaemonHandle): Promise<void> {
  await expect
    .poll(
      async () => {
        const tasks = await api<Array<{ title: string; status: string; outcome: string | null }>>(
          daemon,
          "/api/tasks",
        );
        return tasks
          .filter((task) => task.title === "Tour conversation" || task.title === "Tour demo")
          .filter((task) => task.status !== "done" || task.outcome !== task.title);
      },
      { message: "a task the tour created was left open", timeout: 30_000 },
    )
    .toEqual([]);
}

test("both entry points are drawn from the tour registry, and start the same one tour", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.goto(`${daemon.baseURL}/#/settings/keyboard`);

  // The Settings footer draws one row per registered tour - a list, not hardcoded buttons
  // that happen to look alike. Three tours are registered, and each has exactly one row.
  const helpAndTours = dashboard.getByRole("group", { name: "Help & tours" });
  await expect(helpAndTours.getByRole("button")).toHaveCount(3);
  await expect(helpAndTours.getByRole("button", { name: "Start See the work tour" }))
    .toHaveCount(1);
  await expect(helpAndTours.getByRole("button", { name: "Start Author what runs tour" }))
    .toHaveCount(1);
  await expect(helpAndTours.getByRole("button", { name: "Start Set up this machine tour" }))
    .toHaveCount(1);

  // The palette's Do group draws one command row per registered tour, from the same registry.
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await dashboard.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search everything" }).fill("See the work");
  await expect(palette.getByRole("option", { name: TOUR_COMMAND })).toHaveCount(1);
  // Naming one tour finds one row: the palette rows are per tour, not a single "tour" entry.
  await expect(palette.getByRole("option", { name: /Start Author what runs tour, command/ }))
    .toHaveCount(0);
  await palette.getByRole("option", { name: TOUR_COMMAND }).click();

  const first = step(dashboard, "Fleet and the Line");
  await expect(first).toBeVisible();
  await expect(first).toContainText("Step 1 of 14");
  // One active tour means one coachmark, whichever doorway asked for it.
  await expect(dashboard.locator(".driver-popover")).toHaveCount(1);

  // The tour's entry route is a preflight, so starting it left Settings for the fleet.
  await expect.poll(() => dashboard.evaluate(() => location.hash)).toBe("#/fleet");

  await first.getByRole("button", { name: "Exit tour" }).click();
  await expect(first).toBeHidden({ timeout: 30_000 });
  // Restoration replays the complete route it snapshotted, settings category included -
  // the Keyboard category, not just "some settings page".
  await expect.poll(() => dashboard.evaluate(() => location.hash)).toBe("#/settings/keyboard");
  await expect(dashboard.getByRole("tab", { name: /Keyboard/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(helpAndTours.getByRole("button", { name: "Start See the work tour" }))
    .toBeVisible();
  await expectToursCleaned(daemon);
});

test("a second activation while a tour is running does not start a second tour", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.emulateMedia({ reducedMotion: "reduce" });
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const start = dashboard.getByRole("button", { name: "Start See the work tour" });
  await start.click();

  const first = step(dashboard, "Fleet and the Line");
  await expect(first).toBeVisible();
  await expect(dashboard.locator(".driver-popover")).toHaveCount(1);

  // The running tour owns the keyboard, so the palette cannot even open over it. That is the
  // outer guard; the inner one is the single active-run ref, which is what this count proves.
  await dashboard.keyboard.press("Meta+k");
  await expect(dashboard.getByRole("dialog", { name: "Search everything" })).toBeHidden();
  await expect(dashboard.locator(".driver-popover")).toHaveCount(1);
  await expect(first).toContainText("Step 1 of 14");

  await first.getByRole("button", { name: "Exit tour" }).click();
  await expect(first).toBeHidden({ timeout: 30_000 });
  await expectToursCleaned(daemon);
});
