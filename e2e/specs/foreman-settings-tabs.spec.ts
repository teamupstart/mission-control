import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";

const GROUPS = ["Posture", "Models", "Launches", "Safety"] as const;

function controls(page: Page): Locator {
  return page.locator(".sc-controls");
}

function panel(page: Page, name: (typeof GROUPS)[number]): Locator {
  return controls(page).getByRole("tabpanel", { name, includeHidden: true });
}

function tab(page: Page, name: (typeof GROUPS)[number]): Locator {
  return controls(page).getByRole("tab", { name });
}

test("each Foreman tab reveals one group while the posture and read-only cards stay visible", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1500, height: 849 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);

  const posture = controls(dashboard).locator(".sc-state");
  await expect(posture).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "Right now" })).toBeVisible();
  const heights = new Map<(typeof GROUPS)[number], number>();

  for (const name of GROUPS) {
    const selectedTab = tab(dashboard, name);
    await selectedTab.click();
    await expect(selectedTab).toHaveAttribute("aria-selected", "true");
    await expect(posture).toBeVisible();
    for (const candidate of GROUPS) {
      if (candidate === name) await expect(panel(dashboard, candidate)).toBeVisible();
      else await expect(panel(dashboard, candidate)).toBeHidden();
    }

    switch (name) {
      case "Posture":
        await expect(panel(dashboard, name).getByRole("group", { name: "Cheap tier" }))
          .toBeVisible();
        break;
      case "Models":
        await expect(panel(dashboard, name).getByRole("combobox", { name: "Provider" }))
          .toBeVisible();
        break;
      case "Launches":
        await expect(panel(dashboard, name).getByRole("combobox", { name: "Claude backlog tasks" }))
          .toBeVisible();
        break;
      case "Safety":
        await expect(panel(dashboard, name).getByRole("checkbox", {
          name: "Skip automatic completion for Scout tasks",
        })).toBeVisible();
        break;
    }

    const height = await controls(dashboard).evaluate((element) =>
      Math.ceil(element.getBoundingClientRect().height),
    );
    heights.set(name, height);
  }

  // Phase 1 keeps every field's visible prose by contract, so it cannot reproduce the
  // mockup's sub-800 measurements until Phase 2 moves those blurbs on demand. It does prove
  // the groups no longer sum to the previous 1988px column.
  expect(Math.max(...heights.values()), "the hidden groups still contribute to layout")
    .toBeLessThan(1_200);
  if (process.env.MC_E2E_EVIDENCE) {
    // eslint-disable-next-line no-console
    console.log(`OBSERVED Foreman control heights: ${JSON.stringify(Object.fromEntries(heights))}`);
  }

  await tab(dashboard, "Models").click();
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.locator(".settings-section.sc-section").screenshot({
      path: fileURLToPath(new URL("../evidence/foreman-settings-tabs.png", import.meta.url)),
    });
  }
});

test("the Foreman tabs use selection-following-focus keyboard navigation", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);
  const posture = tab(dashboard, "Posture");
  const models = tab(dashboard, "Models");

  await posture.focus();
  await posture.press("ArrowRight");
  await expect(models).toBeFocused();
  await expect(models).toHaveAttribute("aria-selected", "true");
  await expect(panel(dashboard, "Models")).toBeVisible();

  await models.press("Home");
  await expect(posture).toBeFocused();
  await expect(posture).toHaveAttribute("aria-selected", "true");
  await expect(panel(dashboard, "Posture")).toBeVisible();
});

test("a settings deep link selects the closed Foreman tab before flashing its control", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.keyboard.press("Meta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" })
    .fill("Skip automatic completion for Scout tasks");
  await dashboard.getByRole("option", {
    name: /Skip automatic completion for Scout tasks, setting/,
  }).click();

  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/settings/foreman");
  await expect(tab(dashboard, "Safety"))
    .toHaveAttribute("aria-selected", "true");
  const target = dashboard.locator('[data-anchor="foreman/skip-scout-wrapup"]');
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/settings-flash/);

  // The request id matters when the exact same search hit is chosen twice. Move away, wait
  // until the first flash has genuinely finished, then drive the same palette result again.
  await expect(target).not.toHaveClass(/settings-flash/, { timeout: 5_000 });
  await tab(dashboard, "Posture").click();
  await dashboard.keyboard.press("Meta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" })
    .fill("Skip automatic completion for Scout tasks");
  await dashboard.getByRole("option", {
    name: /Skip automatic completion for Scout tasks, setting/,
  }).click();
  await expect(tab(dashboard, "Safety")).toHaveAttribute("aria-selected", "true");
  await expect(target).toBeVisible();
  await expect(target).toHaveClass(/settings-flash/);
});

test("Live repositories is a read-only count that links to the separate Trust editor", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);
  const card = dashboard.getByRole("heading", { name: "Live repositories" })
    .locator("..").locator("..");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Manage in Trust" })).toBeVisible();
  await expect(card.getByRole("combobox")).toHaveCount(0);
  await expect(card.getByRole("checkbox")).toHaveCount(0);

  await card.getByRole("button", { name: "Manage in Trust" }).click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/settings/trust");
  await expect(dashboard.getByRole("table", { name: "Repository trust grants" })).toBeVisible();
  await expect(dashboard.getByPlaceholder("search repos or type a path…")).toBeVisible();
});
