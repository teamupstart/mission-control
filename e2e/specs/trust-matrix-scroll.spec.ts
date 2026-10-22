import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("trust-matrix-scroll");

/**
 * A Trust page full of repositories keeps its add picker usable.
 *
 * The matrix used to grow one row per repository with no ceiling, which pushed the add row to
 * the bottom of the settings pane. The picker's list opens downward and is capped to the room
 * left below its input, so at the bottom of the pane it opened a few pixels tall and showed no
 * readable option at all. Two things fix it and both are asserted here: the matrix scrolls on
 * its own past a height cap, so the add row stays near the table's top; and the picker opens
 * upward when the room below cannot hold it.
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

/** Scroll every scrollable ancestor of `selector` to its very end, as an operator would. */
async function scrollAncestorsToEnd(
  page: Page,
  selector: string,
): Promise<void> {
  await page.evaluate((sel) => {
    let el = document.querySelector(sel)?.parentElement ?? null;
    while (el) {
      if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
      el = el.parentElement;
    }
  }, selector);
}

test("the matrix scrolls on its own and the add picker opens fully on screen", async ({
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
  // it, but its box stops at the cap and the overflow is reachable by scrolling it.
  const grid = await table.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(grid.overflowY).toBe("auto");
  expect(grid.scrollHeight).toBeGreaterThan(grid.clientHeight);

  // The header stays put while the rows scroll under it.
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

  // The operator's position from the report: the settings pane scrolled to its end, the add
  // row as low as it will go, and the picker opened by typing.
  await scrollAncestorsToEnd(dashboard, ".trust-add");
  const input = dashboard.getByRole("combobox", {
    name: /search repos or type a path/i,
  });
  await input.click();
  const listbox = dashboard.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const options = listbox.getByRole("option");
  expect(await options.count()).toBeGreaterThan(1);

  // Every pixel of the list is inside the viewport, and it is tall enough to read options in
  // rather than a sliver: either it shows every option it holds, or it reaches its full cap.
  const box = (await listbox.boundingBox())!;
  const viewport = dashboard.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const fit = await listbox.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(fit.clientHeight >= fit.scrollHeight || box.height >= 200).toBe(true);
  await expect(options.first()).toBeInViewport({ ratio: 1 });

  // It never covers the field being typed into.
  const field = (await input.boundingBox())!;
  const overlaps =
    box.y < field.y + field.height && box.y + box.height > field.y;
  expect(overlaps).toBe(false);

  await shoot(dashboard, "trust-picker-open-with-many-repos");

  // And it still works: picking a row writes it into the field.
  const name = (await options
    .first()
    .locator(".combobox-option-name")
    .textContent())!;
  await options.first().click();
  await expect(input).toHaveValue(new RegExp(`/${name}$`));
});
