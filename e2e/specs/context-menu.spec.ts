import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";

const TRAILING_URL = "https://example.com/docs";
const TURN = `Context menu selection target and [CI page](https://example.com/menu-target). Raw \`${TRAILING_URL},\` follows.`;
const SELECTED = "selection target";
const PASTED = "pasted from the context menu";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the context menu");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Find one text run, optionally make it the live Selection, and return its centre point. */
async function pointForText(
  locator: Locator,
  needle: string,
  select: boolean,
): Promise<{ x: number; y: number }> {
  return locator.evaluate((root, input) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.textContent ?? "";
      const at = text.indexOf(input.needle);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + input.needle.length);
        if (input.select) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      node = walker.nextNode();
    }
    throw new Error(`Could not find text: ${input.needle}`);
  }, { needle, select });
}

test("context actions work by pointer and keyboard without leaking keys to the grid", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await dispatch(dashboard, daemon);

  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(TURN);
  await composer.press("Enter");

  const turn = card.locator(".turn-user:not(.pending-turn)").filter({ hasText: "Context menu selection target" });
  await expect(turn).toBeVisible();
  await settled(card);

  // A right-click inside the live selection preserves it and Copy writes those exact bytes.
  const selectedPoint = await pointForText(turn, SELECTED, true);
  await dashboard.mouse.click(selectedPoint.x, selectedPoint.y, { button: "right" });
  let menu = dashboard.getByRole("menu", { name: "Actions for this item" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Copy$/ }).click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(SELECTED);
  await expect(dashboard.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();

  // Pointing somewhere else collapses the old selection before resolution, so that remote
  // selection can never be copied by accident.
  const outsidePoint = await pointForText(turn, "Context menu", false);
  await dashboard.mouse.click(outsidePoint.x, outsidePoint.y, { button: "right" });
  await expect(menu).toBeHidden();
  await expect(dashboard.getByRole("menuitem", { name: /^Copy$/ })).toHaveCount(0);

  const link = turn.getByRole("link", { name: "CI page" });
  await link.click({ button: "right" });
  menu = dashboard.getByRole("menu", { name: "Actions for this item" });
  await expect(menu.getByRole("menuitem", { name: "Copy URL" })).toBeVisible();

  // While the anchored menu owns the keyboard, a bare grid shortcut cannot reach the selected
  // card behind it. The menu stays up and no Kill dialog appears.
  await dashboard.keyboard.press("k");
  await expect(menu).toBeVisible();
  await expect(dashboard.getByRole("dialog", { name: "Kill session" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Copy URL" }).click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://example.com/menu-target",
  );

  // Keyboard invocation has no pointer proving an unrelated live selection belongs to this
  // focused link. Its first Copy action therefore uses the visible link text.
  await pointForText(turn, SELECTED, true);
  await link.focus();
  await dashboard.keyboard.press("Shift+F10");
  await dashboard.getByRole("menuitem", { name: /^Copy$/ }).first().click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe("CI page");

  // A URL-shaped text run stops before prose punctuation, even though the punctuation is in
  // the same text node. Both clipboard and open actions therefore receive the usable URL.
  const rawUrlPoint = await pointForText(turn, TRAILING_URL, false);
  await dashboard.mouse.click(rawUrlPoint.x, rawUrlPoint.y, { button: "right" });
  await dashboard.getByRole("menuitem", { name: "Copy URL" }).click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(TRAILING_URL);

  // The desktop preload bridge wins when it exists, and opening never navigates this page.
  const dashboardUrl = dashboard.url();
  await dashboard.evaluate(() => {
    const probe = window as Window & { __contextMenuOpened?: string };
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        openExternal: async (url: string) => { probe.__contextMenuOpened = url; },
      },
    });
  });
  await link.click({ button: "right" });
  await dashboard.getByRole("menuitem", { name: "Open link" }).click();
  await expect.poll(() => dashboard.evaluate(
    () => (window as Window & { __contextMenuOpened?: string }).__contextMenuOpened,
  )).toBe("https://example.com/menu-target");
  expect(dashboard.url()).toBe(dashboardUrl);

  // Firefox's Shift+right-click convention remains the escape hatch to the native menu.
  await link.click({ button: "right", modifiers: ["Shift"] });
  await expect(menu).toBeHidden();

  // Shift+F10 bypasses the text-field typing guard, captures the field offsets before focus
  // moves into the menu, and the selected Paste row drives the controlled React textarea.
  await dashboard.evaluate((text) => navigator.clipboard.writeText(text), PASTED);
  await composer.fill("Before ");
  await composer.focus();
  await dashboard.keyboard.press("Shift+F10");
  menu = dashboard.getByRole("menu", { name: "Actions for this item" });
  await expect(menu.getByRole("menuitem", { name: /^Paste$/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /^Paste$/ }).click();
  await expect(composer).toHaveValue(`Before ${PASTED}`);

  // Copy itself does not manage field focus, so the host restores the invoking textarea and
  // typing can continue after the menu action completes.
  await composer.selectText();
  await dashboard.keyboard.press("Shift+F10");
  await dashboard.getByRole("menuitem", { name: /^Copy$/ }).click();
  await expect(composer).toBeFocused();
  await dashboard.keyboard.type("!");
  await expect(composer).toHaveValue("!");

  // The fixed Menu key is a structural alias, not a second row in Keyboard settings.
  await composer.evaluate((field) => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }));
  });
  await expect(menu).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(composer).toBeFocused();
});
