import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("trust-matrix-scroll");

/**
 * A Trust page full of repositories keeps adding on screen.
 *
 * The matrix used to grow one row per repository with no ceiling, which pushed the add row to
 * the bottom of the settings pane, where its dropdown had no room to open. The page is now two
 * panes side by side in a split of fixed height, and both claims here are about that: the
 * matrix scrolls inside its own pane under a header that stays put, and the add pane - its
 * search, its list and its Add button - is fully on screen without scrolling the settings
 * pane at all, however many repositories are trusted.
 *
 * Driven in a browser because both claims are laid-out geometry against a real viewport.
 * Nothing here dispatches, so no agent binary runs and no model tokens are spent.
 */

const TRUSTED = Array.from(
  { length: 40 },
  (_, i) => `/workspaces/fleet/repo-${String(i).padStart(2, "0")}`,
);

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/trust-matrix-scroll/${name}.png`);
}

/** Seed many trusted repositories straight into the Workflows allowlist. */
async function seedTrusted(page: Page, baseURL: string): Promise<void> {
  const current = (await (
    await fetch(`${baseURL}/api/workflows/config`)
  ).json()) as Record<string, unknown>;
  const saved = await page.request.put(`${baseURL}/api/workflows/config`, {
    data: { ...current, repoAllowlist: TRUSTED },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
}

test("the matrix scrolls on its own and the add pane stays fully on screen", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 760 });
  await seedTrusted(dashboard, daemon.baseURL);
  await dashboard.goto(`${dashboard.url().split("#")[0]}#/settings/trust`);

  const table = dashboard.getByRole("table", {
    name: "Repository trust grants",
  });
  await expect(table.locator(".trust-repo-path")).toHaveCount(TRUSTED.length);

  // The table holds its own scroll rather than stretching the pane: every row is still in
  // it, but its box stops at the pane and the overflow is reachable by scrolling it.
  const grid = await table.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(grid.overflowY).toBe("auto");
  expect(grid.scrollHeight).toBeGreaterThan(grid.clientHeight);

  // With no scrolling anywhere, the whole add pane is on screen - the search it starts from
  // and the button it ends at - beside a matrix forty rows long.
  const addPane = dashboard.getByRole("group", { name: "Add repositories" });
  await expect(addPane.getByRole("searchbox", { name: "Search repositories to add" }))
    .toBeInViewport({ ratio: 1 });
  await expect(addPane.getByRole("textbox", { name: "Repository path" }))
    .toBeInViewport({ ratio: 1 });
  await expect(addPane.getByRole("button", { name: /^Add/ })).toBeInViewport({ ratio: 1 });
  const paneScroll = await dashboard.evaluate(() => {
    let el = document.querySelector(".trust-split")?.parentElement ?? null;
    let scrolled = 0;
    while (el) {
      scrolled += el.scrollTop;
      el = el.parentElement;
    }
    return scrolled + window.scrollY;
  });
  expect(paneScroll).toBe(0);
  await shoot(dashboard, "trust-many-repos-add-on-screen");

  // The header stays put while the rows scroll under it, and the last row is reachable.
  const header = table.getByText("Repository", { exact: true });
  const headerTop = (await header.boundingBox())!.y;
  await table.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect((await header.boundingBox())!.y).toBeCloseTo(headerTop, 0);
  const last = dashboard.getByRole("button", {
    name: `Remove every grant for ${TRUSTED[TRUSTED.length - 1]}`,
  });
  await expect(last).toBeInViewport();
  // Scrolling the matrix moved nothing else: the add button is exactly where it was.
  await expect(addPane.getByRole("button", { name: /^Add/ })).toBeInViewport({ ratio: 1 });
  await shoot(dashboard, "trust-many-repos-scrolled");
});
