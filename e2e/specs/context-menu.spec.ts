/**
 * What is at stake: the packaged desktop app has no context menu at all.
 *
 * Electron installs none - `src/main/menu.ts` is an application menu and `src/main/tray.ts` a
 * tray menu, and neither is a `webContents` menu - so until this feature the shipped build had
 * no right-click Copy and no right-click Paste anywhere. A browser tab has Chromium's own,
 * which is why the menu is one DOM implementation used by both builds.
 *
 * This is the only layer that can prove any of it. The registry test asserts which rows a
 * resolved hit produces; the markup test asserts what a row is called. Neither can show that a
 * right-click reached the resolver, that the row it drew wrote the clipboard, or that the
 * selection under the cursor survived the gesture that read it - and every one of those is a
 * link in the chain the feature is.
 *
 * Two negatives are asserted here, and both are set up so they cannot pass vacuously (README
 * trap 5). Right-clicking outside a selection and Shift-right-clicking are each checked by
 * reading the SELECTION back - a state change, once, after the event - before the menu's
 * absence, and each is bracketed by the same gesture at the same point succeeding.
 */
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";

const PROSE = "the resolver reads the caret and not the event target";
const LINK_TURN = "the failing run is https://example.test/run/9 today";
const RUN_URL = "https://example.test/run/9";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the fields below and stops this Escape itself,
  // so it closes the list rather than the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the context menu");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** A dispatched session with its conversation open, and the composer ready. */
async function conversation(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await dispatch(page, daemon);
  const card = page.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  await expect(card.getByPlaceholder(/^Reply to this session/)).toBeEnabled();
  return card;
}

/**
 * Send a turn and wait for the log to go quiet again.
 *
 * The echoed reply matters as much as the turn itself: it arrives asynchronously and pushes
 * the log, which auto-scrolls, which moves every turn above it. A point computed before that
 * lands somewhere else by the time the mouse gets there - and a right-click a few pixels off
 * its target is exactly the gesture this file is about.
 */
async function say(card: Locator, text: string): Promise<Locator> {
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await composer.fill(text);
  await composer.press("Enter");
  const turn = card.locator(".turn-user:not(.pending-turn)").filter({ hasText: text });
  await expect(turn).toBeVisible();
  await expect(card.locator(".turn-text").filter({ hasText: `Mock reply to: ${text}` })).toBeVisible();
  return turn;
}

/**
 * A point ON THE GLYPHS of an element, once that element has stopped moving.
 *
 * A turn is a block, so its box runs the full width of the bubble while its text may be a
 * third of that - and the centre of the box is then beside the words, not on them. Every
 * assertion here is about what is under the cursor, so the cursor has to be on it.
 */
async function textPoint(locator: Locator): Promise<{ x: number; y: number }> {
  // `.transcript-log` scrolls, and it auto-scrolls to the newest turn - so by the third turn
  // the first one is above the visible area and its client rects are coordinates the mouse
  // cannot reach. Playwright's own actionability check does this for `locator.click`; a raw
  // `mouse.click` at a computed point has none, so it is done here.
  await locator.scrollIntoViewIfNeeded();
  await settled(locator);
  return locator.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getClientRects()[0];
    if (!rect) throw new Error("the element drew no text to point at");
    return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 };
  });
}

/**
 * Whether the app claimed each right-click, newest last.
 *
 * Registered on `window` in the bubble phase and therefore AFTER the app's own listener, so it
 * observes the decision instead of pre-empting it. `preventDefault()` is exactly what opening
 * the custom menu does and what Shift+right-click must not do, and Chromium's own menu is
 * native and invisible to Playwright - so this is the only direct evidence of the difference.
 */
async function watchRightClicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const claimed: boolean[] = [];
    Object.assign(window, { __claimed: claimed });
    window.addEventListener("contextmenu", (event) => claimed.push(event.defaultPrevented));
  });
}

function claimedRightClicks(page: Page): Promise<boolean[]> {
  return page.evaluate(() => (window as unknown as { __claimed: boolean[] }).__claimed);
}

/** Select an element's contents the way a drag would. */
async function selectContents(locator: Locator): Promise<void> {
  await locator.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

function liveSelection(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString().trim() ?? "");
}

function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * Every row's name is exactly its label.
 *
 * README trap 1 warns off `exact: true` on a control's name because `<kbd>` hints are folded
 * into it. A menu row carries a payload cue - "selection", "link text" - which would do the
 * same thing, so it is `aria-hidden` and the tooltip says it in full instead. That is a
 * deliberate accessibility decision (`Copy` and `Copy URL` have to stay two distinguishable
 * names), it is pinned by `test/context-menu-render.test.ts`, and it is what makes an exact
 * match the right locator here rather than a risky one.
 */
function menuOf(page: Page): Locator {
  return page.getByRole("menu", { name: "Context actions" });
}

function row(page: Page, name: string): Locator {
  return menuOf(page).getByRole("menuitem", { name, exact: true });
}

test("right-clicking a selection copies exactly what was selected", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const card = await conversation(dashboard, daemon);
  const turn = await say(card, PROSE);
  // A live card reflows for about a second - the titler's rename, the model line, the pulse -
  // and Playwright refuses to click an unstable box.
  await settled(card);

  const body = turn.locator(".turn-text");
  const point = await textPoint(body);

  await selectContents(body);
  const selected = await liveSelection(dashboard);
  expect(selected).toContain(PROSE);

  await dashboard.mouse.click(point.x, point.y, { button: "right" });
  await expect(menuOf(dashboard)).toBeVisible();
  await row(dashboard, "Copy").click();
  await expect(menuOf(dashboard)).toBeHidden();

  expect(await clipboard(dashboard)).toBe(selected);
  // The confirmation is the host's, not the menu's: the menu closes on activation, so a line
  // inside it would die with the click that earned it.
  await expect(dashboard.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
});

test("right-clicking outside a selection clears it, so Copy is never offered for it", async ({
  dashboard,
  daemon,
}) => {
  const card = await conversation(dashboard, daemon);
  const elsewhere = await say(card, PROSE);
  const here = await say(card, LINK_TURN);
  await settled(card);

  /*
   * Both halves right-click THE SAME LINK and both open a menu; only the rows differ. That is
   * deliberate, and it is what makes the negative mean something.
   *
   * The obvious version of this test - right-click plain prose with the selection elsewhere,
   * assert no menu - proves less than it appears to and is unreadable besides: Chromium
   * answers a right-click on unselected text by selecting the word under the cursor, so the
   * selection is non-empty again by the time anything can be read, and the menu's absence is
   * an absence, which a web-first assertion will happily agree with before the app has done
   * anything at all.
   *
   * This link is autolinked from bare text, so its link text IS its href and `Copy` collapses
   * into `Copy URL` - UNLESS a live selection under the cursor gives `Copy` something else to
   * write. So the row's presence is exactly the question "did the selection survive", asked
   * where the answer is a visible row rather than a missing menu.
   */
  const link = card.locator(`a[href="${RUN_URL}"]`).first();

  await selectContents(here.locator(".turn-text"));
  expect(await liveSelection(dashboard)).toContain(RUN_URL);
  await link.click({ button: "right" });
  await expect(menuOf(dashboard).getByRole("menuitem")).toHaveCount(3);
  await expect(row(dashboard, "Copy")).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(menuOf(dashboard)).toBeHidden();

  // Now the selection is in the turn above and the cursor is not in it. The right-click
  // collapses it before resolving anything, which is what every browser does and what stops
  // `Copy` writing something the reader is no longer pointing at.
  await selectContents(elsewhere.locator(".turn-text"));
  expect(await liveSelection(dashboard)).toContain(PROSE);
  await link.click({ button: "right" });

  await expect(menuOf(dashboard).getByRole("menuitem")).toHaveCount(2);
  await expect(row(dashboard, "Copy")).toHaveCount(0);
  await expect(row(dashboard, "Copy URL")).toBeVisible();
  expect(await liveSelection(dashboard)).not.toContain(PROSE);
});

test("Shift+right-click falls through to the browser's own menu", async ({
  dashboard,
  daemon,
}) => {
  const card = await conversation(dashboard, daemon);
  const turn = await say(card, PROSE);
  await settled(card);

  const body = turn.locator(".turn-text");
  await watchRightClicks(dashboard);

  await selectContents(body);
  const point = await textPoint(body);
  await dashboard.keyboard.down("Shift");
  await dashboard.mouse.click(point.x, point.y, { button: "right" });
  await dashboard.keyboard.up("Shift");

  // The handler returns before it touches anything, so the event goes back to the browser with
  // its default intact - which is a read, once, of the decision itself rather than a wait on
  // an absence. Deliberately NOT asserted by comparing the selection: Shift+mousedown is the
  // browser's own extend-selection gesture, so the selection legitimately moves here.
  expect(await claimedRightClicks(dashboard)).toEqual([false]);
  await expect(menuOf(dashboard)).toHaveCount(0);

  // Same point, no modifier: the custom menu opens and takes the event. Decision D1 is that
  // the browser's menu is one modifier away on a developer tool, not that right-click is
  // unhandled. Re-selected first, because the Shift+click above moved the selection.
  await selectContents(body);
  await dashboard.mouse.click(point.x, point.y, { button: "right" });
  await expect(row(dashboard, "Copy")).toBeVisible();
  expect(await claimedRightClicks(dashboard)).toEqual([false, true]);
});

test("a link offers its URL once, and opens through the desktop bridge", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const card = await conversation(dashboard, daemon);
  await say(card, LINK_TURN);
  await settled(card);

  const link = card.locator(`a[href="${RUN_URL}"]`).first();
  await expect(link).toBeVisible();
  await link.click({ button: "right" });

  // The dedupe rule, in a real browser. This link was autolinked from bare text, so its link
  // text IS its href - `Copy` and `Copy URL` would write the same string, and the label that
  // survives has to be the one that says what it writes.
  await expect(menuOf(dashboard).getByRole("menuitem")).toHaveCount(2);
  await expect(row(dashboard, "Copy URL")).toBeVisible();
  await expect(row(dashboard, "Open link")).toBeVisible();

  await row(dashboard, "Copy URL").click();
  expect(await clipboard(dashboard)).toBe(RUN_URL);

  // `Open link` is the first caller `missionDesktop.openExternal` has ever had. The bridge is
  // absent in a browser tab, so it is stood up here to assert the desktop path specifically -
  // the branch that stops the app window starting a navigation away from the dashboard and
  // being caught on the way out by `will-navigate`.
  await dashboard.evaluate(() => {
    const opened: string[] = [];
    Object.assign(window, {
      __opened: opened,
      missionDesktop: {
        isDesktop: true,
        openExternal: (url: string) => {
          opened.push(url);
          return Promise.resolve();
        },
      },
    });
  });
  await link.click({ button: "right" });
  await row(dashboard, "Open link").click();

  expect(await dashboard.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
    .toEqual([RUN_URL]);
  expect(dashboard.url()).toContain("#/fleet");
});

test("no fleet shortcut reaches the card behind an open menu", async ({ dashboard, daemon }) => {
  /*
   * The gap this menu closes for itself rather than inherits.
   *
   * `test/overlay-registry.test.ts` records six anchored popovers that are deliberately outside
   * the Overlay registry, and the consequence it also records is unfixed: while one is open,
   * focus sits on a button so App's `typing` guard is false and `anyOpen` is false, and the
   * grid shortcuts - INCLUDING kill and reset - still act on the card behind it. A context menu
   * is opened ON a target with the operator's hands on the keyboard, so it is the surface where
   * a stray `k` matters most.
   */
  await dispatch(dashboard, daemon);
  const card = dashboard.locator("article.card").first();
  await settled(card);

  // Select the card the way the keyboard does, then prove `k` really does reach it from here.
  // Without this the assertion below would hold on a build where `k` was bound to nothing.
  await dashboard.keyboard.press("ArrowDown");
  await dashboard.keyboard.press("k");
  const kill = dashboard.getByRole("dialog", { name: "Kill session" });
  await expect(kill).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(kill).toBeHidden();

  await card.getByRole("button", { name: "Expand conversation" }).click();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.click({ button: "right" });
  await expect(menuOf(dashboard)).toBeVisible();

  await dashboard.keyboard.press("k");

  // The menu is still up, which is the positive half of this: the keystroke was swallowed by
  // the surface that owns the keyboard, not merely ignored by something that had stood down.
  await expect(menuOf(dashboard)).toBeVisible();
  await expect(kill).toHaveCount(0);
});

test("Shift+F10 and the Menu key open the menu from inside the composer", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const card = await conversation(dashboard, daemon);
  await settled(card);

  const composer = card.getByPlaceholder(/^Reply to this session/);
  await composer.fill("ship the fix");
  // A real selection gesture, and the one App's typing guard used to make unreachable: ⇧F10
  // carries no ⌘/⌃, so before `chordIsNonTyping` it was eaten inside every text field - which
  // is exactly where Paste lives.
  await composer.press("Shift+Home");
  await composer.press("Shift+F10");

  await expect(menuOf(dashboard)).toBeVisible();
  await expect(menuOf(dashboard).getByRole("menuitem")).toHaveCount(4);
  for (const name of ["Cut", "Copy", "Paste", "Paste as quote"]) {
    await expect(row(dashboard, name)).toBeVisible();
  }

  // A field's selection is its own - `window.getSelection()` is empty inside a textarea - and
  // it is captured before the menu takes focus, or it is gone by the time a row is clicked.
  await row(dashboard, "Copy").click();
  expect(await clipboard(dashboard)).toBe("ship the fix");

  // The desktop build's first right-click Paste, driven from the keyboard end to end.
  await dashboard.evaluate(() => navigator.clipboard.writeText("pasted from the menu"));
  await composer.fill("");
  await composer.press("ContextMenu");
  await expect(menuOf(dashboard)).toBeVisible();
  await row(dashboard, "Paste").click();
  await expect(composer).toHaveValue("pasted from the menu");
});
