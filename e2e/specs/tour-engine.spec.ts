import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The engine's own guarantees, as a browser can see them.
 *
 * `see-work-tour.spec.ts` is the regression proof that the one shipped tour still behaves
 * exactly as it did. This file asserts what the engine adds underneath it: entry points drawn
 * from one registry, one active run whichever doorway asks, and a restoration that replays the
 * complete route rather than a per-tour list of fields.
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

test("a fresh profile enables and starts the guided tour by default", async ({ page, daemon }) => {
  const initial = await api<{ configured: boolean; config: { guidedTour: boolean } }>(
    daemon,
    "/api/ui/config",
  );
  expect(initial.configured).toBe(false);
  expect(initial.config.guidedTour).toBe(true);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const first = step(page, "Fleet and the Line");
  await expect(first).toBeVisible();
  await expect(first).toContainText("Step 1 of 14");
  await shoot(page);

  // The default is one-time: starting the orientation records it before a later dashboard
  // visit can reopen the overlay over the operator's work.
  await expect.poll(async () => (
    await api<{ config: { guidedTour: boolean } }>(daemon, "/api/ui/config")
  ).config.guidedTour).toBe(false);
  await first.getByRole("button", { name: "Exit tour" }).click();
  await expect(first).toBeHidden({ timeout: 30_000 });
  await expectToursCleaned(daemon);
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

  // The Settings footer draws one row per registered tour - a LIST, not two hardcoded buttons
  // that happen to look alike. Two tours are registered, and each has exactly one row.
  const helpAndTours = dashboard.getByRole("group", { name: "Help & tours" });
  await expect(helpAndTours.getByRole("button")).toHaveCount(2);
  await expect(helpAndTours.getByRole("button", { name: "Start See the work tour" }))
    .toHaveCount(1);
  await expect(helpAndTours.getByRole("button", { name: "Start Author what runs tour" }))
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
