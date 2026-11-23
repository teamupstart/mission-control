import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { CONDUCTOR_INTEGRATION_ENABLED } from "../../src/shared/conductor-integration.ts";
import type { SetupChecksSnapshot } from "../../src/shared/setup-catalog.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { openSetupFamily } from "../fixtures/setup-panel.ts";

/**
 * The ai-conductor integration is hidden behind `CONDUCTOR_INTEGRATION_ENABLED` while it is
 * rebuilt. These are the operator-visible consequences: Setup has no ai-conductor row and no
 * Pipelines family, Settings has no Conductor category and naming one opens Display, search
 * leads nowhere near it, and Dispatch offers no Pipeline kind.
 *
 * The fake `conduct-ts` stays INSTALLED here (the fixture default), so every absence below is
 * the switch and not a missing engine.
 */

test.skip(CONDUCTOR_INTEGRATION_ENABLED, "the ai-conductor integration is offered");

const EVIDENCE = artifactsDir("conductor-hidden");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conductor-hidden/${name}.png`);
}

const palette = (page: Page) => page.getByRole("dialog", { name: "Search everything" });
const paletteField = (page: Page) => page.getByRole("combobox", { name: "Search everything" });

test("Setup lists no ai-conductor row and draws no Pipelines family", async ({ page, daemon }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  const checks = page.waitForResponse((response) =>
    response.url().endsWith("/api/setup/checks") && response.request().method() === "GET");
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  // The snapshot the page renders from carries no ai-conductor row at all, so it cannot count
  // toward the verdict, a family's tally, or the Setup banner.
  const snapshot = (await (await checks).json()) as SetupChecksSnapshot;
  expect(snapshot.rows.length).toBeGreaterThan(0);
  expect(snapshot.rows.filter((row) => row.rowId.source === "dependency" && row.rowId.id === "ai-conductor"))
    .toEqual([]);
  expect(snapshot.rows.filter((row) => row.family === "pipelines")).toEqual([]);

  const rail = page.getByRole("navigation", { name: "Setup families" });
  await expect(rail.getByRole("button", { name: /^Agent CLIs/ })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Agent extensions/ })).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Pipelines/ })).toHaveCount(0);

  // The verdict's meter counts every reported row, so a hidden row is not counted.
  await expect(page.getByRole("img", { name: new RegExp(` of ${snapshot.rows.length} checks ready$`) }))
    .toBeVisible();

  // Nothing anywhere in Setup names the engine or links to its settings.
  for (const family of ["agents", "terminals", "github", "repositories", "extensions", "runtime"] as const) {
    await openSetupFamily(page, family);
    await expect(page.locator("#setup-pane")).not.toContainText(/conductor/i);
    await expect(page.getByRole("link", { name: "Open Conductor settings" })).toHaveCount(0);
  }
  await openSetupFamily(page, "extensions");
  await shoot(page, "01-setup-without-pipelines");
});

test("Settings draws no Conductor category, and its old link opens Display", async ({ page, daemon }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await expect(page.getByRole("tab", { name: /Task sources/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /Models/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Conductor/ })).toHaveCount(0);
  await shoot(page, "02-settings-rail-without-conductor");

  // A kept bookmark to the panel lands on the default category rather than mounting it.
  await page.goto(`${daemon.baseURL}/#/settings/conductor`);
  await expect(page.getByRole("tab", { name: /Display/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Conductor", exact: true })).toHaveCount(0);
  await expect(page.getByText("Conductor commissioning progress")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /Conductor/ })).toHaveCount(0);
  // The router rewrites the address too, so the kept link does not linger in the URL.
  await expect(page).toHaveURL(/#\/settings\/display$/);
  await shoot(page, "04-conductor-link-opens-display");
});

test("search everything offers nothing that leads to Conductor", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await page.getByRole("button", { name: "Search everything" }).click();
  await expect(palette(page)).toBeVisible();

  // The palette answers a settings query at all, so the empty answer below is a real one.
  await paletteField(page).fill("Task sources");
  await expect(page.getByRole("option", { name: /Task sources settings/ })).toBeVisible();

  for (const query of ["Conductor", "ai-conductor", "Observe Conductor pipelines"]) {
    await paletteField(page).fill(query);
    await expect(paletteField(page)).toHaveValue(query);
    await expect(page.getByRole("option", { name: /Conductor/i })).toHaveCount(0);
  }
  await shoot(page, "03-search-without-conductor");
});

test("Dispatch offers no Pipeline kind and the Runs page no Pipelines tab", async ({ dashboard, daemon }) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  await expect(kind.locator("option", { hasText: "ship" })).toHaveCount(1);
  await expect(kind.locator("option", { hasText: "pipeline" })).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE) {
    // A closed native select draws one option, so for the capture only, size it to its option
    // count: the browser then lists every offered kind inline.
    await kind.evaluate((element) => {
      const select = element as HTMLSelectElement;
      select.size = select.options.length;
    });
    await shoot(dashboard, "05-dispatch-kinds-without-pipeline");
  }
  await dashboard.keyboard.press("Escape");

  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  await expect(dashboard.getByRole("heading", { name: "Workflow runs", exact: true })).toBeVisible();
  await expect(dashboard.getByRole("tab", { name: /Pipelines/ })).toHaveCount(0);
  await shoot(dashboard, "06-runs-without-pipelines-tab");
});
