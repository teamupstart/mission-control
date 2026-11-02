import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Picking a style in Settings > Display leaves the page where it was, on both pickers.
 *
 * Each segment of a style picker is a `<label>` around a radio whose circle is hidden, and a
 * click on the label focuses that radio. The radio was absolutely positioned with no
 * positioned ancestor, so its containing block was the viewport: its box landed outside
 * Settings' own scroller, stretched the DOCUMENT taller than the window, and focusing it
 * scrolled the document - not Settings - to wherever that box sat. The operator lost the
 * preview card they had picked the style to look at, and Settings' scroller never moved,
 * which is why both offsets are read below.
 *
 * Measured in a browser because it is a fact about layout and focus scrolling, which no
 * markup assertion can state. No agent is dispatched, so no tokens are spent.
 */

const EVIDENCE = artifactsDir("display-choice-scroll");

/** Settings' scroller offset and the document's, which should never scroll at all. */
async function scrollOffsets(page: Page): Promise<{ settings: number; document: number }> {
  return page.evaluate(() => ({
    settings: document.querySelector("main.settings-page")?.scrollTop ?? -1,
    document: document.scrollingElement?.scrollTop ?? 0,
  }));
}

/**
 * Every style a picker offers, clicked in turn, with the page held still and the picker and
 * its own preview kept in view after each. Both pickers, because each sits in its own group
 * beside its own preview and either one regressing loses the operator the picture they picked
 * the style to look at.
 */
const PICKERS = [
  {
    name: "Board card: Task type",
    styles: ["Medallion", "Name chip", "Top band", "Off", "Edge tab"],
    preview: ".board-card-preview-stage .tile",
  },
  {
    name: "Conversation header: Task type",
    styles: ["Eyebrow", "Kind tile", "Tab strip", "Off", "Title badge"],
    preview: ".conversation-header-preview",
  },
] as const;

for (const { name, styles, preview } of PICKERS) {
  test(`picking a style in "${name}" keeps the picker and its preview in view`, async ({ page, daemon }) => {
    // Short enough that Display scrolls, which is the only condition the jump needs.
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`${daemon.baseURL}/#/settings/display`);

    const panel = page.locator('[data-anchor="display/board-card"]');
    const picker = panel.getByRole("radiogroup", { name });
    const picture = panel.locator(preview);
    await picker.scrollIntoViewIfNeeded();
    await expect(picker).toBeInViewport();
    await expect(picture).toBeInViewport();

    const before = await scrollOffsets(page);
    expect(before.document).toBe(0);

    for (const style of styles) {
      await picker.getByText(style, { exact: true }).click();
      await expect(picker.getByRole("radio", { name: style, exact: true })).toBeChecked();
      // Focus scrolling is synchronous with the click, so a jump has already happened here.
      expect(await scrollOffsets(page), `picking "${style}" scrolled the page`).toEqual(before);
      await expect(picker).toBeInViewport();
      await expect(picture).toBeInViewport();
    }
  });
}

test("the board card style lands on the preview the operator stayed to look at", async ({ page, daemon }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = page.locator('[data-anchor="display/board-card"]');
  const picker = panel.getByRole("radiogroup", { name: "Board card: Task type" });
  const card = panel.locator(".board-card-preview-stage .tile");
  await picker.scrollIntoViewIfNeeded();
  await picker.getByText("Medallion", { exact: true }).click();
  await expect(card.locator(".tk-medallion")).toBeVisible();
  await expect(card).toBeInViewport();

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.screenshot({ path: join(EVIDENCE, "after-picking-medallion.png") });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/display-choice-scroll/after-picking-medallion.png");
  }
});
