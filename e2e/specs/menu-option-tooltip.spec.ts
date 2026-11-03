import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A dropdown option's tooltip opens BESIDE the option, never over its neighbours (#1315).
 *
 * The conversation view menu explains each rendering in a tooltip. `Tooltip` used to place
 * every bubble above its trigger, and in a menu "above an option" is exactly where the
 * option before it sits: opening the menu focuses the checked row, so hovering or focusing
 * "Terminal" painted a three-line bubble over "Chat" - the one choice the person was
 * reading the tooltip to decide between. Only laid-out rectangles can see that, so this is
 * the layer that pins it.
 *
 * Every placement outcome is driven through a real surface rather than a mounted stub:
 * the right side through the Dispatch dialog's repo list, which has room on both sides; the
 * left through the conversation view menu, pinned to the window's right edge; the fallback
 * above or below the whole menu through a window too narrow for either side; and the
 * vertical slide through a bubble taller than the room above, or below, its row.
 *
 * No model tokens: `MISSION_CLAUDE_BIN` points at the fake throughout.
 */

const EVIDENCE = artifactsDir("menu-option-tooltip");

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b, "the element has no layout box").not.toBeNull();
  return b as Box;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function dispatch(page: Page, daemon: DaemonHandle, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Console layout, written to the daemon because the web store hydrates from it at boot. */
async function openConsoleDetail(page: Page, daemon: DaemonHandle, name: RegExp): Promise<Locator> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  await page.getByRole("navigation", { name: "Sessions" }).getByRole("button", { name }).click();
  const detail = page.locator(".cdetail");
  await expect(detail).toBeVisible();
  return detail;
}

/**
 * The painted bubble. It is `aria-hidden` (the accessible copy is the trigger's
 * `aria-describedby`), so no role reaches it; its own text is what identifies it.
 */
function bubble(page: Page, text: string): Locator {
  return page.locator(".tooltip").filter({ hasText: text });
}

async function expectOnScreen(page: Page, tipBox: Box): Promise<void> {
  const viewport = page.viewportSize()!;
  expect(tipBox.x, "the tooltip runs off the left edge").toBeGreaterThanOrEqual(0);
  expect(tipBox.x + tipBox.width, "the tooltip runs off the right edge").toBeLessThanOrEqual(viewport.width);
  expect(tipBox.y, "the tooltip runs off the top edge").toBeGreaterThanOrEqual(0);
  expect(tipBox.y + tipBox.height, "the tooltip runs off the bottom edge").toBeLessThanOrEqual(viewport.height);
}

/** The vertical extents share a band: the bubble is level with the row it explains. */
function level(tipBox: Box, row: Box): boolean {
  return tipBox.y < row.y + row.height && row.y < tipBox.y + tipBox.height;
}

async function shoot(page: Page, name: string, ...around: Box[]): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  const viewport = page.viewportSize()!;
  const x = Math.max(0, Math.min(...around.map((b) => b.x)) - 16);
  const y = Math.max(0, Math.min(...around.map((b) => b.y)) - 16);
  const right = Math.min(viewport.width, Math.max(...around.map((b) => b.x + b.width)) + 16);
  const bottom = Math.min(viewport.height, Math.max(...around.map((b) => b.y + b.height)) + 16);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, clip: { x, y, width: right - x, height: bottom - y } });
  console.log(`CAPTURED e2e/.artifacts/menu-option-tooltip/${name}.png`);
}

/** Open the conversation view menu from the console detail's tab row. */
async function openViewMenu(page: Page, detail: Locator): Promise<{ menu: Locator; chat: Locator; terminal: Locator }> {
  await detail.locator(".detail-tabs").getByRole("button", { name: "Conversation view" }).click();
  const menu = page.getByRole("menu", { name: "Conversation view" });
  const chat = menu.getByRole("menuitemradio", { name: "Chat" });
  const terminal = menu.getByRole("menuitemradio", { name: "Terminal" });
  await expect(terminal).toBeVisible();
  return { menu, chat, terminal };
}

test("the conversation view menu's tooltips open to its left, not over its options", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "read the view menu tooltips");
  const detail = await openConsoleDetail(dashboard, daemon, /Read the View Menu Tooltips/i);
  const { menu, chat, terminal } = await openViewMenu(dashboard, detail);

  for (const [option, neighbour, words, name] of [
    [terminal, chat, "terminal stream", "terminal"],
    [chat, terminal, "Turns as messages", "chat"],
  ] as const) {
    await option.hover();
    const tip = bubble(dashboard, words);
    await expect(tip).toBeVisible();
    // Opening the menu focused the checked row, and its bubble must not stay up under this
    // one: two bubbles beside the same menu stack onto each other.
    await expect(dashboard.locator(".tooltip")).toHaveCount(1);
    const tipBox = await box(tip);
    const menuBox = await box(menu);

    // The defect itself: the bubble painted over the other option.
    expect(overlaps(tipBox, await box(neighbour)), "the tooltip covers the neighbouring option")
      .toBe(false);
    // The menu is pinned to the window's right edge, so the right side has no room and the
    // bubble takes the left, clear of the menu.
    expect(tipBox.x + tipBox.width, "the tooltip is not left of the menu").toBeLessThanOrEqual(menuBox.x);
    expect(level(tipBox, await box(option)), "the tooltip drifted away from its option").toBe(true);
    await expectOnScreen(dashboard, tipBox);
    await shoot(dashboard, `${name}-option-tooltip`, tipBox, menuBox);
  }

  // Ordinary controls keep the bubble above or below: the side placement is keyed on the
  // option roles, not applied to every tooltip. The toolbar button that opened the menu is
  // the nearest such control.
  await dashboard.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  const toggle = detail.locator(".detail-tabs").getByRole("button", { name: "Conversation view" });
  await toggle.hover();
  const tip = dashboard.locator(".tooltip").filter({ hasText: /^Conversation view: Chat$/ });
  await expect(tip).toBeVisible();
  const tipBox = await box(tip);
  const toggleBox = await box(toggle);
  expect(
    tipBox.y + tipBox.height <= toggleBox.y || tipBox.y >= toggleBox.y + toggleBox.height,
    "an ordinary control's tooltip is no longer above or below it",
  ).toBe(true);
});

test("an option with room on its right opens its tooltip to the right of the list", async ({
  dashboard,
  daemon,
}) => {
  // The Dispatch dialog is centred, so its repo list has room on both sides; the right is
  // preferred, where submenus open. A change that always placed option tooltips on the left
  // fails here and nowhere else.
  await dashboard.setViewportSize({ width: 1600, height: 900 });
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  // The leaf, not the path: an exact path match is a finished answer and closes the list.
  await dialog.getByPlaceholder("search repos or type a path…").fill(basename(daemon.repo));
  const list = dashboard.getByRole("listbox");
  const option = list.getByRole("option").first();
  await expect(option).toBeVisible();
  await option.hover();

  const tip = bubble(dashboard, daemon.repo);
  await expect(tip).toBeVisible();
  const tipBox = await box(tip);
  const listBox = await box(list);
  expect(tipBox.x, "the tooltip is not right of the list").toBeGreaterThanOrEqual(listBox.x + listBox.width);
  expect(level(tipBox, await box(option)), "the tooltip drifted away from its option").toBe(true);
  await expectOnScreen(dashboard, tipBox);
  // The path wraps inside its bubble rather than running out of it toward the window edge.
  expect(
    await tip.evaluate((el) => el.scrollWidth <= el.clientWidth),
    "the repo path overflows its tooltip",
  ).toBe(true);
  await shoot(dashboard, "repo-option-tooltip-right", tipBox, listBox);
});

test("without room on either side, an option's tooltip goes above or below the whole menu", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "narrow view menu tooltips");
  const detail = await openConsoleDetail(dashboard, daemon, /Narrow View Menu Tooltips/i);
  // Too narrow for a bubble beside a 272px menu on either side.
  await dashboard.setViewportSize({ width: 460, height: 800 });
  const { menu, chat, terminal } = await openViewMenu(dashboard, detail);
  const menuBox = await box(menu);
  expect(menuBox.x, "the window left room for a bubble on the left").toBeLessThan(260);
  expect(460 - (menuBox.x + menuBox.width), "the window left room on the right").toBeLessThan(260);

  await terminal.hover();
  const tip = bubble(dashboard, "terminal stream");
  await expect(tip).toBeVisible();
  const tipBox = await box(tip);
  // Outside the menu altogether, so it covers neither option - not above or below the row,
  // which is where the other option is.
  expect(overlaps(tipBox, menuBox), "the fallback tooltip covers the menu").toBe(false);
  expect(overlaps(tipBox, await box(chat)), "the fallback tooltip covers Chat").toBe(false);
  expect(
    tipBox.y + tipBox.height <= menuBox.y || tipBox.y >= menuBox.y + menuBox.height,
    "the fallback tooltip is not above or below the menu",
  ).toBe(true);
  await expectOnScreen(dashboard, tipBox);
  await shoot(dashboard, "narrow-window-fallback", tipBox, menuBox);
});

test("a side tooltip taller than the room above its row slides down to stay on screen", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "tall view menu tooltips");
  const detail = await openConsoleDetail(dashboard, daemon, /Tall View Menu Tooltips/i);
  // A tall window keeps the menu, which opens under its trigger, in the upper part, with
  // room below for what slides down. Larger user text in a narrower bubble - the same idiom
  // the tall-menu spec uses - then makes the real copy too tall to centre on its row.
  await dashboard.setViewportSize({ width: 1280, height: 1400 });
  await dashboard.addStyleTag({ content: ".tooltip { font-size: 40px; max-width: 120px; }" });
  const { menu, chat, terminal } = await openViewMenu(dashboard, detail);

  await terminal.hover();
  const tip = bubble(dashboard, "terminal stream");
  await expect(tip).toBeVisible();
  const tipBox = await box(tip);
  const row = await box(terminal);
  console.log(`VERTICAL_SLIDE ${JSON.stringify({ viewport: dashboard.viewportSize(), row, tip: tipBox })}`);
  // The precondition, so this can never pass by not exercising the slide: centred on the
  // row, this bubble would start above the top of the window.
  expect(row.y + row.height / 2 - tipBox.height / 2, "the bubble fits without sliding").toBeLessThan(0);

  await expectOnScreen(dashboard, tipBox);
  // Slid exactly as far as the top edge's margin, and no further.
  expect(tipBox.y).toBeCloseTo(8, 0);
  const menuBox = await box(menu);
  // A narrow bubble fits right of the menu here; either side is beside it.
  expect(
    tipBox.x >= menuBox.x + menuBox.width || tipBox.x + tipBox.width <= menuBox.x,
    "the tooltip is not beside the menu",
  ).toBe(true);
  expect(overlaps(tipBox, await box(chat)), "the tooltip covers Chat").toBe(false);
  expect(level(tipBox, row), "the slide carried the tooltip away from its option").toBe(true);
  await shoot(dashboard, "vertical-slide", tipBox, menuBox);
});

test("a side tooltip taller than the room below its row slides up to stay on screen", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "low view menu tooltips");
  const detail = await openConsoleDetail(dashboard, daemon, /Low View Menu Tooltips/i);
  // A short window leaves the menu's rows in its lower part, so there is less room below
  // the Terminal row than above it.
  await dashboard.setViewportSize({ width: 1280, height: 640 });
  const { menu, chat, terminal } = await openViewMenu(dashboard, detail);
  const viewport = dashboard.viewportSize()!;
  const row = await box(terminal);
  const centre = row.y + row.height / 2;
  // Tall enough that, centred on the row, it crosses the bottom edge by 20px; short enough
  // to fit the window, so the slide rather than a clamp is what keeps it on screen. Set from
  // the row's real position rather than a guessed font size, standing in for long copy.
  const height = Math.round(2 * (viewport.height - centre) + 40);
  expect(height, "the row is too close to the middle to cross only the bottom edge")
    .toBeLessThanOrEqual(viewport.height - 16);
  await dashboard.addStyleTag({ content: `.tooltip { min-height: ${height}px; box-sizing: border-box; }` });

  await terminal.hover();
  const tip = bubble(dashboard, "terminal stream");
  await expect(tip).toBeVisible();
  const tipBox = await box(tip);
  console.log(`BOTTOM_SLIDE ${JSON.stringify({ viewport, row, tip: tipBox })}`);
  // The precondition, so this can never pass by not exercising the slide: centred on the
  // row, this bubble would end below the bottom of the window.
  expect(centre + tipBox.height / 2, "the bubble fits without sliding").toBeGreaterThan(viewport.height);

  await expectOnScreen(dashboard, tipBox);
  // Slid exactly as far as the bottom edge's margin, and no further.
  expect(tipBox.y + tipBox.height).toBeCloseTo(viewport.height - 8, 0);
  const menuBox = await box(menu);
  expect(
    tipBox.x >= menuBox.x + menuBox.width || tipBox.x + tipBox.width <= menuBox.x,
    "the tooltip is not beside the menu",
  ).toBe(true);
  expect(overlaps(tipBox, await box(chat)), "the tooltip covers Chat").toBe(false);
  expect(overlaps(tipBox, row), "the tooltip covers Terminal").toBe(false);
  expect(level(tipBox, row), "the slide carried the tooltip away from its option").toBe(true);
  await shoot(dashboard, "vertical-slide-bottom", tipBox, menuBox);
});
