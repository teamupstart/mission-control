import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

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
  await expect(currentPage.locator('[data-anchor="setup/dependency-gh-cli"]')).toContainText("Ready");

  daemon.removeFakeGh();
  await currentPage.getByRole("button", { name: "Re-check" }).click();
  await expect(currentPage.locator('[data-anchor="setup/dependency-gh-cli"]')).toContainText("Missing");

  await staleBanner.getByRole("button", { name: "Dismiss setup reminder" }).click();
  await expect(staleBanner).toBeVisible();
  await expect(staleBanner.getByRole("alert")).toContainText("Re-check before dismissing");
});

test("the setup reminder is durable, detects a regression, and the tour stays read-only", async ({
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
  await expect(page.locator('[data-anchor="setup/dependency-gh-cli"]')).toContainText("Missing");

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
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.locator('[data-anchor="setup/dependency-gh-cli"]')).toContainText("Ready");
  await expect(page.locator('[data-anchor="setup/dependency-gh-auth"]')).toContainText("Ready");
  await expect(banner).toBeHidden();

  daemon.removeFakeGh();
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.locator('[data-anchor="setup/dependency-gh-cli"]')).toContainText("Missing");
  await expect(banner).toBeVisible();

  const beforeTour = appConfigSnapshot(daemon);
  await page.getByRole("button", { name: "Start Set up this machine tour" }).click();

  let step = tourStep(page, "Setup in one place");
  await expect(step).toBeVisible();
  await expect(page.locator(".setup-intro")).toHaveClass(/driver-active-element/);
  await shoot(page, "setup-guided-tour");

  await step.getByRole("button", { name: "Next" }).click();
  step = tourStep(page, "Read by family");
  await expect(step).toBeVisible();
  await expect(page.locator("#setup-family-agents")).toHaveClass(/driver-active-element/);

  for (const title of [
    "Trust each status",
    "Follow a remedy",
    "Check again when ready",
    "You know where to return",
  ]) {
    await step.getByRole("button", { name: "Next" }).click();
    step = tourStep(page, title);
    await expect(step).toBeVisible();
  }
  await step.getByRole("button", { name: "Finish tour" }).click();
  await expect(step).toBeHidden();

  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Search everything" });
  await palette.getByRole("combobox", { name: "Search everything" }).fill("Set up this machine");
  await palette.getByRole("option", { name: TOUR_COMMAND }).click();
  step = tourStep(page, "Setup in one place");
  await expect(step).toBeVisible();
  await step.getByRole("button", { name: "Exit tour" }).click();
  await expect(step).toBeHidden();

  expect(appConfigSnapshot(daemon), "the tour must not write machine or UI configuration")
    .toBe(beforeTour);
});
