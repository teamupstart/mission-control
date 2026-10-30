import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Settings > Display > Conversation header shows what its controls change.
 *
 * The group's Task type picker and its two band cells were the only controls in Display that
 * changed nothing on screen: the one preview in the panel was a board card, which none of
 * them move, so picking Eyebrow over Title badge could only be checked by leaving Settings.
 * The group now carries a picture of the console header beside its checklist, and it redraws
 * in place with each click - which is the claim no markup test can make.
 *
 * Where the panel is too narrow for the picture beside the checklist, it moves under the
 * group's heading instead of falling off the end of the list. That is a fact about laid-out
 * rectangles, so it is measured here.
 *
 * No agent is dispatched, so no binary runs and no tokens are spent.
 */

const EVIDENCE = artifactsDir("conversation-header-preview");

async function shot(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conversation-header-preview/${name}.png`);
}

test("the conversation header preview redraws with each style and band cell", async ({ page, daemon }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${daemon.baseURL}/#/settings/display`);

  const panel = page.locator('[data-anchor="display/board-card"]');
  const picker = panel.getByRole("radiogroup", { name: "Conversation header: Task type" });
  // `has` is queried INSIDE each customizer, so it is rooted at the page, not the panel.
  const customizer = panel
    .locator(".board-card-customizer")
    .filter({ has: page.getByRole("radiogroup", { name: "Conversation header: Task type" }) });
  const preview = customizer.locator(".conversation-header-preview");
  await picker.scrollIntoViewIfNeeded();
  await expect(preview).toBeVisible();

  // Beside the checklist, not under it: the preview's left edge is right of the picker's.
  const pickerBox = (await picker.boundingBox())!;
  const previewBox = (await preview.boundingBox())!;
  expect(previewBox.x).toBeGreaterThan(pickerBox.x + pickerBox.width);

  // The preview's stage is `inert`, so nothing in it is in the accessibility tree a person
  // using the dashboard gets. Its contents are asserted as drawn markup, not through roles,
  // so these checks do not lean on the test runner exposing what assistive tech cannot see.
  const name = preview.locator(".detail-title h2");

  // The session's identity is always drawn, whatever the style.
  await expect(name).toHaveText("Fix the parser");

  // Shipped style: the badge leads the name.
  await expect(picker.getByRole("radio", { name: "Title badge" })).toBeChecked();
  await expect(preview.locator(".detail-title-line .tk-badge")).toHaveText("ship");
  await shot(customizer, "title-badge");

  await picker.getByText("Eyebrow", { exact: true }).click();
  await expect(preview.locator(".tk-badge")).toHaveCount(0);
  await expect(preview.locator(".detail-title > .tk-eyebrow")).toContainText("ship task");
  await shot(customizer, "eyebrow");

  await picker.getByText("Kind tile", { exact: true }).click();
  await expect(preview.locator(".detail-head.tk-edge .tk-tile")).toBeVisible();
  await expect(preview.locator(".tk-tile")).toHaveAttribute("aria-label", "ship task");
  await shot(customizer, "kind-tile");

  await picker.getByText("Tab strip", { exact: true }).click();
  await expect(preview.locator(".detail-tabs > .tk-tabs")).toHaveText("ship task");
  await shot(customizer, "tab-strip");

  await picker.getByText("Off", { exact: true }).click();
  await expect(preview.locator(".tk-mark")).toHaveCount(0);
  await expect(name).toHaveText("Fix the parser");
  await shot(customizer, "off");

  // The band's two cells move it too, and the band goes whole when both are off.
  const band = preview.locator(".detail-sub");
  await expect(band.getByText("mission/fix-the-parser")).toBeVisible();
  // Each cell on its own: the path off leaves the band standing for the branch...
  await customizer.getByRole("checkbox", { name: "Working directory", exact: true }).uncheck();
  await expect(band.getByText("mission/fix-the-parser")).toBeVisible();
  await expect(band.getByText("path", { exact: true })).toHaveCount(0);
  await customizer.getByRole("checkbox", { name: "Working directory", exact: true }).check();
  // ...and the branch off leaves it standing for the path.
  await customizer.getByRole("checkbox", { name: "Git branch", exact: true }).uncheck();
  await expect(band.getByText("mission/fix-the-parser")).toHaveCount(0);
  await expect(band.getByText("path", { exact: true })).toBeVisible();
  await customizer.getByRole("checkbox", { name: "Working directory", exact: true }).uncheck();
  await expect(band).toHaveCount(0);

  // Restore the shipped state through the same controls, so the daemon is left as found.
  await customizer.getByRole("checkbox", { name: "Working directory", exact: true }).check();
  await customizer.getByRole("checkbox", { name: "Git branch", exact: true }).check();
  await picker.getByText("Title badge", { exact: true }).click();
  await expect(preview.locator(".tk-badge")).toBeVisible();
});

test("too narrow to sit beside the checklist, the preview moves under the group's heading", async ({
  page,
  daemon,
}) => {
  // Narrow enough that the panel cannot hold a readable checklist and a 300px picture side by
  // side, wide enough that Settings still draws its rail.
  await page.setViewportSize({ width: 860, height: 1000 });
  await page.goto(`${daemon.baseURL}/#/settings/display`);

  const panel = page.locator('[data-anchor="display/board-card"]');
  const heading = panel.getByRole("heading", { name: "Conversation header" });
  const picker = panel.getByRole("radiogroup", { name: "Conversation header: Task type" });
  // `has` is queried INSIDE each customizer, so it is rooted at the page, not the panel.
  const customizer = panel
    .locator(".board-card-customizer")
    .filter({ has: page.getByRole("radiogroup", { name: "Conversation header: Task type" }) });
  const preview = customizer.locator(".board-card-preview");
  await heading.scrollIntoViewIfNeeded();
  await expect(preview).toBeVisible();

  const headingBox = (await heading.boundingBox())!;
  const previewBox = (await preview.boundingBox())!;
  const pickerBox = (await picker.boundingBox())!;
  // Under the heading and above the first control, rather than beside or after the list.
  expect(previewBox.y).toBeGreaterThan(headingBox.y + headingBox.height);
  expect(previewBox.y + previewBox.height).toBeLessThanOrEqual(pickerBox.y);
  expect(Math.abs(previewBox.x - headingBox.x)).toBeLessThan(2);

  // And it still answers the picker from there.
  await picker.getByText("Eyebrow", { exact: true }).click();
  await expect(customizer.locator(".conversation-header-preview .tk-eyebrow")).toBeVisible();
  await shot(customizer, "narrow-under-heading");
  await picker.getByText("Title badge", { exact: true }).click();
});

test("the preview moves under the heading at a 640px container and stays beside it at 641px", async ({
  page,
  daemon,
}) => {
  // The switch is a container query on the customizers' wrapper, so the wrapper is sized
  // directly rather than through the window: a viewport width lands on the container only
  // after the Settings rail and the page's padding take their share, and that share is not
  // what this test is about. Wide enough that the unconstrained panel is well past 641px.
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`${daemon.baseURL}/#/settings/display`);

  const panel = page.locator('[data-anchor="display/board-card"]');
  const container = panel.locator(".board-card-customizers");
  const heading = panel.getByRole("heading", { name: "Conversation header" });
  const picker = panel.getByRole("radiogroup", { name: "Conversation header: Task type" });
  const customizer = panel
    .locator(".board-card-customizer")
    .filter({ has: page.getByRole("radiogroup", { name: "Conversation header: Task type" }) });
  const preview = customizer.locator(".board-card-preview");

  const cases = [
    { width: 639, under: true },
    { width: 640, under: true },
    { width: 641, under: false },
  ];
  for (const { width, under } of cases) {
    await container.evaluate((el, w) => {
      (el as HTMLElement).style.width = `${w}px`;
    }, width);
    // The container query reads the content box, so that is what is checked.
    expect(await container.evaluate((el) => el.clientWidth)).toBe(width);
    await heading.scrollIntoViewIfNeeded();

    const headingBox = (await heading.boundingBox())!;
    const pickerBox = (await picker.boundingBox())!;
    const previewBox = (await preview.boundingBox())!;
    if (under) {
      // One column: under the heading, above the first control, on the heading's left edge.
      expect(previewBox.y, `${width}px: preview is not under the heading`).toBeGreaterThan(
        headingBox.y + headingBox.height,
      );
      expect(previewBox.y + previewBox.height, `${width}px: preview is not above the picker`)
        .toBeLessThanOrEqual(pickerBox.y);
      expect(Math.abs(previewBox.x - headingBox.x), `${width}px: preview left edge moved`).toBeLessThan(2);
    } else {
      // Two columns: right of the checklist, its top level with the heading's.
      expect(previewBox.x, `${width}px: preview is not beside the checklist`).toBeGreaterThan(
        pickerBox.x + pickerBox.width,
      );
      expect(previewBox.y, `${width}px: preview is not level with the heading`).toBeLessThan(
        headingBox.y + headingBox.height,
      );
    }
  }
  await shot(customizer, "breakpoint-641-beside");
});
