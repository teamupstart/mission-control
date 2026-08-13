import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";

const SELECTED = "context menu selection sentinel";
const URL = "https://example.com/context-menu";
const TURN = `${SELECTED}. Review [the context docs](${URL}) before continuing.`;

async function evidence(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const directory = artifactsDir("context-menu");
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name), animations: "disabled" });
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise context menus");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Select one phrase and return the centre of its first rendered rectangle. */
async function selectPhrase(body: Locator, phrase: string): Promise<{ x: number; y: number }> {
  return body.evaluate((element, selected) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const start = node.data.indexOf(selected);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + selected.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const rect = range.getClientRects()[0];
      if (!rect) throw new Error("selected phrase has no rendered rectangle");
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`could not find ${selected}`);
  }, phrase);
}

/** Return a rendered point inside a phrase without creating a document selection. */
async function pointInPhrase(body: Locator, phrase: string): Promise<{ x: number; y: number }> {
  return body.evaluate((element, value) => {
    const node = element.firstChild;
    if (!(node instanceof Text)) throw new Error("context specimen has no text node");
    const start = node.data.indexOf(value);
    if (start < 0) throw new Error(`could not find ${value}`);
    const middle = start + Math.floor(value.length / 2);
    const range = document.createRange();
    range.setStart(node, middle);
    range.setEnd(node, middle + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, phrase);
}

test("context actions work by pointer and keyboard without leaking grid shortcuts", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await dispatch(dashboard, daemon);

  const card = dashboard.locator("article.card").first();
  await settled(card);
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-assistant").filter({ hasText: `Mock reply to: ${SELECTED}` }).last(),
  ).toBeVisible();
  await settled(card);

  const sent = card.locator(".turn-user:not(.pending-turn)").filter({ hasText: SELECTED }).last();
  const body = sent.locator(".turn-text");
  await expect(body).toBeVisible();

  // A right-click inside the selection preserves it and offers raw Copy. The clipboard read
  // proves the action, while the status proves the promise resolved in the interface.
  const point = await selectPhrase(body, SELECTED);
  await dashboard.mouse.click(point.x, point.y, { button: "right" });
  let menu = dashboard.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect(dashboard.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(SELECTED);

  // Keyboard invocation scopes document selections to the focused target. A selection left
  // elsewhere cannot replace this link's text payload or manufacture actions for a button.
  const link = sent.locator(`a[href="${URL}"]`);
  await expect(link).toHaveText("the context docs");
  await link.focus();
  await selectPhrase(body, SELECTED);
  await expect(link).toBeFocused();
  await dashboard.keyboard.press("Shift+F10");
  menu = dashboard.getByRole("menu", { name: "Actions" });
  await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe("the context docs");
  const collapse = card.getByRole("button", { name: "Collapse conversation" });
  await collapse.focus();
  await selectPhrase(body, SELECTED);
  await expect(collapse).toBeFocused();
  await dashboard.keyboard.press("Shift+F10");
  await expect(dashboard.getByRole("menu", { name: "Actions" })).toHaveCount(0);

  // The same live selection is no longer relevant when the pointer moves elsewhere. The host
  // collapses it before resolving, so it cannot offer Copy for words the reader did not point at.
  expect(await dashboard.evaluate(() => window.getSelection()?.toString())).toBe(SELECTED);
  await dashboard.locator(".brand").click({ button: "right" });
  await expect(menu).toHaveCount(0);
  expect(await dashboard.evaluate(() => window.getSelection()?.toString())).toBe("");

  // A worded external link keeps its text and destination as separate choices.
  await link.click({ button: "right" });
  menu = dashboard.getByRole("menu", { name: "Actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Copylink text", "Copy URL", "Open link"]);
  await evidence(dashboard, "worded-link-menu.png");
  await menu.getByRole("menuitem", { name: "Copy URL" }).click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(URL);

  // Raw text URL detection stops before terminal sentence punctuation.
  const rawUrl = dashboard.getByLabel("Raw URL context specimen");
  await dashboard.evaluate((url) => {
    const specimen = document.createElement("span");
    specimen.setAttribute("aria-label", "Raw URL context specimen");
    specimen.textContent = `Raw destination: ${url}.`;
    specimen.style.position = "fixed";
    specimen.style.left = "12px";
    specimen.style.bottom = "12px";
    document.body.append(specimen);
  }, URL);
  const rawPoint = await pointInPhrase(rawUrl, URL);
  await dashboard.mouse.click(rawPoint.x, rawPoint.y, { button: "right" });
  menu = dashboard.getByRole("menu", { name: "Actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Copy URL", "Open link"]);
  await menu.getByRole("menuitem", { name: "Copy URL" }).click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe(URL);
  await rawUrl.evaluate((element) => element.remove());

  // The Electron bridge is the explicit Open-link path. A browser-side stand-in records the
  // call without navigating this page, which is the renderer half of the desktop contract.
  await dashboard.evaluate(() => {
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: {
        openExternal: async (url: string) => window.localStorage.setItem("opened-external", url),
      },
    });
  });
  await link.click({ button: "right" });
  await dashboard.getByRole("menu", { name: "Actions" })
    .getByRole("menuitem", { name: "Open link" })
    .click();
  await expect.poll(() => dashboard.evaluate(() => localStorage.getItem("opened-external"))).toBe(URL);

  // Shift+right-click deliberately falls through to Chromium's menu, leaving no DOM menu.
  await composer.click({ button: "right", modifiers: ["Shift"] });
  await expect(dashboard.getByRole("menu", { name: "Actions" })).toHaveCount(0);

  // Shift+F10 works from inside a field even though it has no command modifier. The field's
  // own selection was captured before focus moved into the menu.
  await composer.fill("copy this draft");
  await composer.evaluate((field: HTMLTextAreaElement) => {
    field.focus();
    field.setSelectionRange(0, 4);
  });
  await dashboard.keyboard.press("Shift+F10");
  menu = dashboard.getByRole("menu", { name: "Actions" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Cutselection",
    "Copyselection",
    "Paste⌘V",
    "Paste as quote⌘V",
  ]);
  await menu.getByRole("menuitem", { name: "Copy" }).click();
  expect(await dashboard.evaluate(() => navigator.clipboard.readText())).toBe("copy");

  // Paste reads the real clipboard and replaces the field's captured selection, which is the
  // desktop affordance this phase restores rather than merely drawing a menu row for it.
  await dashboard.evaluate(() => navigator.clipboard.writeText("pasted"));
  await composer.evaluate((field: HTMLTextAreaElement) => {
    field.focus();
    field.setSelectionRange(0, 4);
  });
  await dashboard.keyboard.press("Shift+F10");
  await dashboard.getByRole("menu", { name: "Actions" })
    .getByRole("menuitem")
    .filter({ hasText: /^Paste⌘V$/ })
    .click();
  await expect(composer).toHaveValue("pasted this draft");
  await expect(dashboard.getByRole("status").filter({ hasText: "Pasted" })).toBeVisible();

  // A readonly field can still copy its selection, but never offers an action that mutates it.
  const locked = dashboard.getByLabel("Readonly context menu specimen");
  await dashboard.evaluate(() => {
    const field = document.createElement("input");
    field.setAttribute("aria-label", "Readonly context menu specimen");
    field.value = "locked words";
    field.readOnly = true;
    field.style.position = "fixed";
    field.style.left = "12px";
    field.style.bottom = "12px";
    document.body.append(field);
    field.focus();
    field.setSelectionRange(0, 6);
  });
  await dashboard.keyboard.press("Shift+F10");
  menu = dashboard.getByRole("menu", { name: "Actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Copyselection"]);
  await dashboard.keyboard.press("Escape");
  await expect(locked).toHaveValue("locked words");
  await locked.evaluate((field) => field.remove());

  // The dedicated Menu key takes the same structural path, and Escape restores the composer.
  await composer.focus();
  await composer.evaluate((field) => {
    field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
    }));
  });
  menu = dashboard.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(composer).toBeFocused();

  // While the anchored popover owns the keyboard, a grid action cannot reach the selected
  // card behind it. `k` used to be one of the documented popover leaks.
  await link.click({ button: "right" });
  menu = dashboard.getByRole("menu", { name: "Actions" });
  await dashboard.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await expect(menu).toBeVisible();
  await dashboard.keyboard.press("k");
  await expect(menu).toBeVisible();
  await expect(dashboard.getByRole("dialog", { name: /Kill/ })).toHaveCount(0);
  await dashboard.keyboard.press("Escape");
});
