import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * The Conversation rendering picker, measured.
 *
 * The bug: `ViewGlyph` drew an inline `<svg>` with a viewBox and no `width`/`height`, which
 * is not a small icon - a replaced element with a ratio and no intrinsic size takes 100% of
 * the line and scales its height by the ratio. Its rects also set no `fill`, so they painted
 * SVG-default black rather than the row's tint.
 *
 * THE PRE-FIX SIZES LIVE HERE, and only here, because this file is the one that measures.
 * Taken off the shipped build at the 1500x900 viewport below, with `.layout-glyph` carrying
 * no CSS size either:
 *
 *   Chat      glyph 386x338,  row 383px
 *   Terminal  glyph 785x687,  row 749px    fill: rgb(0, 0, 0) on both
 *   section 1139px tall
 *
 * The two differ because the glyph took the flex line MINUS its label, so the longer word
 * left a smaller picture - which is why "the drawing was NxM" was never one number, and why
 * the prose elsewhere describes the mechanism and points here instead of restating a figure.
 *
 * Only a browser can say any of that. The markup test one layer down proves the attributes
 * are present; used height is what the attributes were for, and no assertion on a string can
 * produce it. So this measures: the thumbnail is 44x32 rather than the width of the pane,
 * each row is a row, and the section fits.
 *
 * No agent is dispatched, so no binary runs and no tokens are spent - this is the settings
 * page and a daemon.
 */

const EVIDENCE = artifactsDir("settings-conversation-picker");

/** A row is a settings row: one line of label over one or two lines of prose, plus padding. */
const MAX_ROW_HEIGHT = 100;

/** What the two rows measured before the fix, in the order the picker lists them. Printed
 *  beside the live numbers when capturing evidence, so the pair carries its own before. */
const PRE_FIX_ROWS = [383, 749] as const;

/** And what the section around them measured. See the header for where these come from. */
const PRE_FIX_SECTION = 1139;

test("Display settings no longer offers the Cards layout", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/display`);

  const picker = page.getByRole("radiogroup", { name: "Dashboard layout" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("radio")).toHaveCount(2);
  await expect(picker.getByRole("radio", { name: /^Board\b/ })).toBeVisible();
  await expect(picker.getByRole("radio", { name: /^Console\b/ })).toBeVisible();
  await expect(picker.getByRole("radio", { name: /^Cards\b/ })).toHaveCount(0);

  const retiredWrite = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "grid" }),
  });
  expect(retiredWrite.status).toBe(400);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.mouse.move(0, 0);
    await picker.screenshot({ path: `${EVIDENCE}01-layout-options.png` });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/settings-conversation-picker/01-layout-options.png");
  }
});

test("the conversation picker draws sized thumbnails, not a full-width picture", async ({
  page,
  daemon,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${daemon.baseURL}/#/settings/display`);

  const picker = page.getByRole("radiogroup", { name: "Conversation rendering" });
  await expect(picker).toBeVisible();
  const chat = picker.getByRole("radio", { name: /^Chat/ });
  const terminal = picker.getByRole("radio", { name: /^Terminal/ });
  await expect(terminal).toBeChecked();
  await expect(chat).not.toBeChecked();

  // THE assertion. Before the fix each of these was as wide as the pane and ~790px tall.
  // Exact rather than bounded: 44x32 is a fixed CSS size that no font metric moves, so a
  // range here would only hide the next regression that lands in between.
  const thumbs = picker.locator(".view-thumb");
  await expect(thumbs).toHaveCount(2);
  for (const box of await thumbs.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    }),
  )) {
    expect(box).toEqual({ width: 44, height: 32 });
  }

  // And the rows they sit in are rows. Bounded rather than exact: the descriptions wrap at
  // a width CI fonts decide, so the honest claim is "a settings row", not a pixel count.
  const rows = picker.locator(".layout-option");
  await expect(rows).toHaveCount(2);
  const heights = await rows.evaluateAll((nodes) =>
    nodes.map((node) => Math.ceil(node.getBoundingClientRect().height)),
  );
  for (const height of heights) {
    expect(height, "a conversation row is drawing a full-size picture again")
      .toBeLessThan(MAX_ROW_HEIGHT);
    // A row that collapsed to nothing would pass the bound above while being just as broken.
    expect(height).toBeGreaterThan(30);
  }

  // The whole section fits the screen, which is the thing an operator actually noticed.
  const section = page.locator('[data-anchor="display/conversation-view"]').locator("..");
  const sectionBox = (await section.boundingBox())!;
  expect(Math.ceil(sectionBox.height)).toBeLessThan(300);

  // The picture is tinted by the row's state rather than painted SVG-default black: the
  // selected row's thumbnail takes the accent, the unselected one the dim text colour. Read
  // off `color` because that is what the `fill="currentColor"` rects resolve against.
  const tint = async (index: number): Promise<string> =>
    thumbs.nth(index).evaluate((node) => getComputedStyle(node).color);
  const restingTint = await tint(0);
  const selectedTint = await tint(1);
  expect(selectedTint).not.toBe(restingTint);
  expect(selectedTint, "the selected thumbnail is painting black").not.toMatch(
    /rgba?\(0,\s*0,\s*0/,
  );
  expect(restingTint, "the resting thumbnail is painting black").not.toMatch(
    /rgba?\(0,\s*0,\s*0/,
  );

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
    // lands on top of the rows being photographed.
    await page.mouse.move(0, 0);
    await section.screenshot({ path: `${EVIDENCE}02-after.png` });
    // eslint-disable-next-line no-console
    console.log(
      `CAPTURED e2e/.artifacts/settings-conversation-picker/02-after.png` +
        ` (rows ${heights.join("/")}px, section ${Math.ceil(sectionBox.height)}px;` +
        ` pre-fix rows ${PRE_FIX_ROWS.join("/")}px, section ${PRE_FIX_SECTION}px)`,
    );
  }
});

test("choosing a rendering in the picker reaches the daemon and survives a reload", async ({
  page,
  daemon,
}) => {
  // The control still does its job. Worth asserting beside the sizing because the fix moved
  // the thumbnail out of the label text, and a picture that stops being part of the label is
  // one click target smaller - the row must still select from anywhere on it.
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const picker = page.getByRole("radiogroup", { name: "Conversation rendering" });
  const chat = picker.getByRole("radio", { name: /^Chat/ });

  // Clicked on the thumbnail rather than the word, which is the half of the row that moved.
  await picker.locator(".layout-option").filter({ hasText: "Chat" }).locator(".view-thumb").click();
  await expect(chat).toBeChecked();
  await expect(picker.getByRole("radio", { name: /^Terminal/ })).not.toBeChecked();

  // It reached the daemon: the reload rehydrates from `GET /api/ui/config`, so a choice that
  // only ever lived in the browser comes back as the shipped default.
  await expect
    .poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/ui/config`);
      const body = (await response.json()) as { config?: { conversationView?: string } };
      return body.config?.conversationView;
    })
    .toBe("chat");
  await page.reload();
  await expect(
    page
      .getByRole("radiogroup", { name: "Conversation rendering" })
      .getByRole("radio", { name: /^Chat/ }),
  ).toBeChecked();
});
