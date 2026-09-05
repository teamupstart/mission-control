import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";
import { expectRowStatus, openSetupFamily } from "../fixtures/setup-panel.ts";
import { expectSpotlight } from "../fixtures/tour-spotlight.ts";

const EVIDENCE = artifactsDir("guided-setup");
const TOUR_COMMAND = /Start Set up this machine tour, command/;

test.describe.configure({ timeout: 120_000 });
test.use({
  daemonEnv: { MC_E2E_GH_STARTS_MISSING: "1" },
  setupReminder: true,
});

function tourStep(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title }).or(page.getByRole("status", { name: title }));
}

function appConfigSnapshot(daemon: DaemonHandle): string {
  return JSON.stringify(withDaemonDb(daemon, (db) =>
    db.prepare("SELECT key, value FROM app_config ORDER BY key").all()));
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/guided-setup/${name}.png`);
}

test("a stale tab cannot dismiss a setup regression observed elsewhere", async ({
  page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const staleBanner = page.getByRole("status", { name: "Machine setup needs attention" });
  await expect(staleBanner).toBeVisible();

  daemon.installFakeGh();
  const currentPage = await page.context().newPage();
  await currentPage.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(currentPage, "github");
  await expectRowStatus(currentPage, "dependency-gh-cli", "Ready");

  daemon.removeFakeGh();
  await currentPage.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(currentPage, "dependency-gh-cli", "Missing");

  await staleBanner.getByRole("button", { name: "Dismiss setup reminder" }).click();
  await expect(staleBanner).toBeVisible();
  await expect(staleBanner.getByRole("alert")).toContainText("Re-check before dismissing");
});

test("a dismissal transport failure stays actionable without leaking into a later reminder", async ({
  page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const banner = page.getByRole("status", { name: "Machine setup needs attention" });
  await expect(banner).toBeVisible();

  await banner.getByRole("button", { name: "Dismiss setup reminder" }).click();
  await expect(banner).toBeHidden();

  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "github");
  daemon.installFakeGh();
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Ready");

  daemon.removeFakeGh();
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Missing");
  await expect(banner).toBeVisible();

  await daemon.crash();
  await banner.getByRole("button", { name: "Dismiss setup reminder" }).click();

  await expect(banner.getByRole("alert")).toContainText("Failed to fetch");
  await expect(banner.getByRole("button", { name: "Dismiss setup reminder" })).toBeEnabled();

  await daemon.restart();
  daemon.installFakeGh();
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Ready");
  await expect(banner).toBeHidden();

  daemon.removeFakeGh();
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Missing");
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("alert")).toHaveCount(0);
});

test("the setup reminder is durable, detects a regression, and the tour hands over Setup", async ({
  page,
  daemon,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${daemon.baseURL}/#/fleet`);

  const banner = page.getByRole("status", { name: "Machine setup needs attention" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("2 required setup checks need attention.");
  await shoot(page, "setup-attention-banner");

  await banner.getByRole("link", { name: "Open Setup" }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/settings/setup");
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
  await openSetupFamily(page, "github");
  await expectRowStatus(page, "dependency-gh-cli", "Missing");

  await page.getByRole("button", { name: "Dismiss setup reminder" }).click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(banner).toBeHidden();

  await daemon.crash();
  await daemon.restart();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
  await expect(banner).toBeHidden();

  daemon.installFakeGh();
  await openSetupFamily(page, "github");
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Ready");
  await expectRowStatus(page, "dependency-gh-auth", "Ready");
  await expect(banner).toBeHidden();

  daemon.removeFakeGh();
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Missing");
  await expect(banner).toBeVisible();

  const beforeTour = appConfigSnapshot(daemon);
  await page.getByRole("button", { name: "Start Set up this machine tour" }).click();

  // Four stops, and the first two are outside the panel: an operator who has never opened
  // Setup is shown how to reach it before a single status word is explained.
  let step = tourStep(page, "Settings live behind the gear");
  await expect(step).toBeVisible();
  await expect(step).toContainText("Step 1 of 4");
  // Starting it LEAVES Settings for the fleet, because the gear only reads "Settings" from
  // somewhere else - on this page the same control is "Return to Fleet".
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/fleet");
  await expectSpotlight(page.locator(".gear-btn"));
  await shoot(page, "setup-guided-tour");

  await step.getByRole("button", { name: "Open Settings" }).click();
  step = tourStep(page, "Open Setup");
  await expect(step).toBeVisible();
  // Settings opens on the same category the gear itself opens, so the row this stop points
  // at is one the operator has not selected yet. A row that was already active would teach
  // nothing about reaching it.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/settings/display");
  const setupTab = page.locator("#settings-tab-setup");
  await expectSpotlight(setupTab);
  await expect(setupTab).toHaveAttribute("aria-selected", "false");

  await step.getByRole("button", { name: "Open Setup" }).click();
  step = tourStep(page, "Install what you will use");
  await expect(step).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/settings/setup");
  // The rail and its rows as one spotlight. The tour does not walk the families: which one
  // is worth opening depends on what this machine turns out to be missing.
  await expectSpotlight(page.locator(".setup-split"));
  await expect(setupTab).toHaveAttribute("aria-selected", "true");
  await shoot(page, "setup-tour-dependencies");

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "Re-check once they are installed");
  await expect(step).toBeVisible();
  await expectSpotlight(page.getByRole("button", { name: "Re-check" }));

  await step.getByRole("button", { name: "Finish tour" }).click();
  await expect(step).toBeHidden();
  // The tour HANDS THE PANEL OVER rather than replaying the route it started from. Showing
  // an operator Setup and then taking it away again would undo the whole point of it, and
  // the control that started the tour is still here to take focus back.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/settings/setup");
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Set up this machine tour" }))
    .toBeFocused();
  await shoot(page, "setup-tour-left-on-setup");

  // The invoker survived, so the exit route's landing control has nothing to land, and the
  // pass that would look for one must never have started. The vacuum it waits for is also
  // what an ordinary click on a non-focusable area leaves behind, so a pass still running
  // here would answer that click by pulling focus onto Re-check.
  //
  // Read the baseline BEFORE the blur - the assertion above is it - then blur the way that
  // click does, and watch every frame. Frames rather than milliseconds deliberately: the
  // landing pass counts its own window in animation frames, so a slower machine cannot
  // outrun this sampler the way a wall-clock wait can. Two hundred exceeds its budget.
  await page.getByRole("heading", { name: "Setup", exact: true }).click();
  const hijacked = await page.evaluate(async (frames) => {
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise((settle) => requestAnimationFrame(() => settle(null)));
      if (document.activeElement !== document.body) {
        return (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "unknown";
      }
    }
    return null;
  }, 200);
  expect(hijacked, "a finished tour took focus back from where the operator clicked")
    .toBeNull();

  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await palette.getByRole("combobox", { name: "Search everything" }).fill("Set up this machine");
  await palette.getByRole("option", { name: TOUR_COMMAND }).click();
  step = tourStep(page, "Settings live behind the gear");
  await expect(step).toBeVisible();
  await step.getByRole("button", { name: "Exit tour" }).click();
  await expect(step).toBeHidden();
  // Exiting early lands on Setup too: the exit route belongs to the tour, not to its last
  // stop, so an operator who leaves at stop one still gets the page they were promised.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/settings/setup");

  expect(appConfigSnapshot(daemon), "the tour must not write machine or UI configuration")
    .toBe(beforeTour);
});
