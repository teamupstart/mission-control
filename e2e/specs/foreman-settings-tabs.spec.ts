import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { FOREMAN_SETTINGS_TABS } from "../../src/web/lib/foreman-settings-tabs.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// No "Models": Foreman's provider and its four role models moved to Settings > Models, where
// every app-owned model choice is answerable in one screen. The pointer they left behind sits
// OUTSIDE this strip, so a bookmark that expected the tab still finds the way.
const GROUPS = ["Posture", "Launches", "Safety"] as const;

function declaredCount(name: (typeof GROUPS)[number]): number {
  const group = FOREMAN_SETTINGS_TABS.find((candidate) => candidate.label === name);
  if (!group) throw new Error(`no Foreman settings group is labelled ${name}`);
  return group.anchors.length;
}

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
    // The settings count rides the tab face, so an unopened tab already says how much is
    // behind it - while the accessible name stays the bare group name this locator uses.
    await expect(selectedTab).toHaveText(`${name}${declaredCount(name)}`);
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

  // The bound sits between two measured states of this column, not at a target. The compact
  // Standing guidance card added by the fixed System profile puts the tallest tab near
  // 1160px locally and 1185px in CI. Printing the per-field prose again would add roughly
  // 245px, so 1300 still catches that regression while leaving room for CI font metrics.
  expect(Math.max(...heights.values()), "a field's explanation is printing under it again")
    .toBeLessThan(1_300);
  if (process.env.MC_E2E_EVIDENCE) {
    // eslint-disable-next-line no-console
    console.log(`OBSERVED Foreman control heights: ${JSON.stringify(Object.fromEntries(heights))}`);
  }

  await tab(dashboard, "Launches").click();
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.locator(".settings-section.sc-section").screenshot({
      path: `${EVIDENCE}foreman-settings-tabs.png`,
    });
  }
});

test("the departed Models tab leaves a pointer that is reachable from any tab", async ({
  dashboard,
  daemon,
}) => {
  // A bookmark or a keyboard walk that expected the Models tab now lands on Posture. The
  // signpost therefore sits outside the tab strip - inside a tabpanel it would be hidden
  // exactly when it is needed - and it has to actually navigate, not just read as prose.
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);
  await expect(tab(dashboard, "Models" as never)).toHaveCount(0);
  await expect(controls(dashboard).getByRole("combobox", { name: "Review" })).toHaveCount(0);

  const pointer = controls(dashboard).getByRole("button", { name: "Open them in Models →" });
  await expect(pointer).toBeVisible();
  await tab(dashboard, "Safety").click();
  await expect(pointer, "the pointer is buried in one tab").toBeVisible();

  await pointer.click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/settings/models");
  await expect(dashboard.getByRole("combobox", { name: "Foreman Review provider" })).toBeVisible();
});

test("the Foreman tabs use selection-following-focus keyboard navigation", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);
  const posture = tab(dashboard, "Posture");
  const launches = tab(dashboard, "Launches");

  await posture.focus();
  await posture.press("ArrowRight");
  await expect(launches).toBeFocused();
  await expect(launches).toHaveAttribute("aria-selected", "true");
  await expect(panel(dashboard, "Launches")).toBeVisible();

  await launches.press("Home");
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

  // The completed request stays in SettingsPage as history, but must not act like a new
  // request when changing categories unmounts and later remounts the Foreman panel.
  await dashboard.getByRole("tab", { name: "Trust" }).click();
  await dashboard.getByRole("tab", { name: "Foreman" }).click();
  await expect(tab(dashboard, "Posture")).toHaveAttribute("aria-selected", "true");
  await expect(panel(dashboard, "Posture")).toBeVisible();
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
const EVIDENCE = artifactsDir("foreman-settings-tabs");
