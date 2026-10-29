import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The conversation's toolbar and reply box line up, in Chat and in Terminal.
 *
 * Two things had drifted, and neither is visible to markup, route or geometry-in-isolation
 * tests - only a laid-out browser can say whether five controls share a line:
 *
 *  1. The strip of buttons in the console detail's tab row had lost its `display: flex` when
 *     the Cards layout was retired. It computed to `display: block`, so its inline-level
 *     buttons sat on a text baseline: the two icon menus hung a few pixels above the
 *     launchers, the launchers touched each other, `gap` did nothing, and the Foreman chip
 *     was a third height.
 *  2. The `mission (s) >` label beside the reply box was positioned for the Terminal
 *     rendering's bare prompt line, so in Chat it rode ~9px above the first line of the
 *     padded field it introduces.
 *
 * The Terminal rendering shares both surfaces, so every claim is made there too: the point of
 * the second half of each test is that fixing Chat did not move Terminal.
 *
 * No model tokens: `MISSION_CLAUDE_BIN` points at the fake throughout.
 */

const EVIDENCE = artifactsDir("console-toolbar-alignment");

// Crisp enough to see a half-pixel drift in the pictures this spec leaves behind.
test.use({ deviceScaleFactor: 2 });

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the row being photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/console-toolbar-alignment/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The combobox portals its listbox over the fields below and reopens on every keystroke.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  // The opening turn has to be finished: selecting the row while it is still moving between
  // Working and Idle can lose the detail selection.
  const row = page
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .filter({ hasText: goal });
  await expect(row.locator(".rail-state")).toHaveText("idle");
}

/** Open one session's console detail the way a person does, off the rail by name. */
async function openConsoleDetail(page: Page, daemon: DaemonHandle, name: RegExp): Promise<Locator> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(((await response.json()) as { config?: { layout?: string } }).config?.layout).toBe(
    "console",
  );
  await page.reload();
  await page.getByRole("navigation", { name: "Sessions" }).getByRole("button", { name }).click();
  const detail = page.locator(".cdetail");
  await expect(detail).toBeVisible();
  return detail;
}

/** Flip this session's rendering from the tab row's own menu, as a person would. */
async function showView(page: Page, detail: Locator, view: "Chat" | "Terminal"): Promise<void> {
  const toggle = detail.locator(".detail-tabs").getByRole("button", { name: "Conversation view" });
  if ((await toggle.getAttribute("aria-label")) === `Conversation view: ${view}`) return;
  await toggle.click();
  await page.getByRole("menuitemradio", { name: view }).click();
  await expect(toggle).toHaveAttribute("aria-label", `Conversation view: ${view}`);
}

/** After layout, and after the ladder's `ResizeObserver` has had its say. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

interface Box {
  name: string;
  top: number;
  bottom: number;
  height: number;
  left: number;
  right: number;
}

/** The five controls the tab row hosts, left to right, as they are laid out right now. */
async function toolbar(page: Page, detail: Locator): Promise<Box[]> {
  const tabs = detail.locator(".detail-tabs");
  const controls: Array<[string, Locator]> = [
    ["session control", tabs.getByRole("button", { name: /^Session control/ })],
    ["conversation view", tabs.getByRole("button", { name: /^Conversation view/ })],
    // Exact, because in Terminal view the rendering menu's own name ends in "Terminal" too.
    ["terminal launcher", tabs.getByRole("button", { name: "Terminal", exact: true })],
    ["agent launcher", tabs.getByRole("button", { name: /Claude Code$/ })],
    ["foreman", tabs.getByRole("button", { name: /foreman/i })],
  ];
  await settle(page);
  const boxes: Box[] = [];
  for (const [name, locator] of controls) {
    await expect(locator, `${name} is not on screen`).toBeVisible();
    const box = (await locator.boundingBox())!;
    boxes.push({
      name,
      top: box.y,
      bottom: box.y + box.height,
      height: box.height,
      left: box.x,
      right: box.x + box.width,
    });
  }
  return boxes;
}

const HALF_PIXEL = 0.5;

/**
 * One line, one height, one rhythm.
 *
 * Stated without a magic number for the gap, because the ladder legitimately tightens it on
 * a narrow pane (rung 2) - what must hold at every rung is that the spacing is EVEN and that
 * the buttons do not touch. The 28px height is a number on purpose: it is the one the icon
 * menus have always had, and the others now match.
 */
function expectOneBand(boxes: Box[], where: string): void {
  const [first, ...rest] = boxes;
  for (const box of rest) {
    expect(
      Math.abs(box.top - first!.top),
      `${box.name} does not start on the same line as ${first!.name} (${where})`,
    ).toBeLessThanOrEqual(HALF_PIXEL);
    expect(Math.abs(box.bottom - first!.bottom), `${box.name} bottom drifted (${where})`)
      .toBeLessThanOrEqual(HALF_PIXEL);
  }
  for (const box of boxes) {
    expect(Math.abs(box.height - 28), `${box.name} is ${box.height}px tall (${where})`)
      .toBeLessThanOrEqual(HALF_PIXEL);
  }

  const gaps = boxes.slice(1).map((box, i) => box.left - boxes[i]!.right);
  for (const [i, gap] of gaps.entries()) {
    expect(gap, `${boxes[i]!.name} touches ${boxes[i + 1]!.name} (${where})`).toBeGreaterThan(3);
  }
  expect(
    Math.max(...gaps) - Math.min(...gaps),
    `the toolbar's gaps are uneven at ${where}: ${gaps.map((g) => g.toFixed(1)).join(", ")}`,
  ).toBeLessThanOrEqual(HALF_PIXEL);
}

/**
 * The reply box's prompt label against the first line of text in the field it introduces.
 * Centres rather than baselines, because that is what a reader's eye compares and it is
 * what both renderings can satisfy: Terminal's bare line and Chat's padded field.
 */
async function promptOffset(page: Page, detail: Locator): Promise<number> {
  await settle(page);
  return await detail.evaluate((root) => {
    const prompt = root.querySelector(".transcript .pty-prompt") as HTMLElement;
    const input = root.querySelector(".transcript .transcript-input") as HTMLTextAreaElement;
    const style = getComputedStyle(input);
    const p = prompt.getBoundingClientRect();
    const field = input.getBoundingClientRect();
    const firstLine =
      field.top +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.paddingTop) +
      parseFloat(style.lineHeight) / 2;
    return p.top + p.height / 2 - firstLine;
  });
}

test("Chat: the toolbar is one even band at every width, and its menu opens under its button", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "line up the chat toolbar");
  const detail = await openConsoleDetail(dashboard, daemon, /Line Up the Chat Toolbar/i);
  await showView(dashboard, detail, "Chat");
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toHaveCount(0);

  // Each width lands on a different rung of the tab row's ladder, so this is the toolbar
  // with its words, with its keycaps gone, with its gaps tightened and as bare glyphs.
  for (const width of [1800, 1440, 1280, 1160, 1000]) {
    await dashboard.setViewportSize({ width, height: 900 });
    expectOneBand(await toolbar(dashboard, detail), `${width}px`);
  }

  // The chooser hangs off the button it belongs to: the popover is positioned against the
  // launcher's wrapper, so a wrapper that is not the button's own height moves the menu.
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  const [, , terminal] = await toolbar(dashboard, detail);
  await shoot(dashboard, detail.locator(".detail-tabs"), "chat-toolbar");
  await detail
    .locator(".detail-tabs")
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  const menu = detail.getByRole("menu", { name: /Open a shell in the worktree with/ });
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  expect(
    Math.abs(menuBox.y - (terminal!.bottom + 6)),
    "the launcher's menu is not 6px under its button",
  ).toBeLessThanOrEqual(1);
  await dashboard.keyboard.press("Escape");
});

test("Chat: the reply box's prompt label sits on the first line of the field", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "line up the chat prompt");
  const detail = await openConsoleDetail(dashboard, daemon, /Line Up the Chat Prompt/i);
  await showView(dashboard, detail, "Chat");

  const composer = detail.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await expect(detail.locator(".transcript[data-view='chat'] .pty-prompt")).toBeVisible();

  // ~9px high before; the tolerance is the sub-pixel a label and a field in different faces
  // cannot avoid, and still fails the drift this guards.
  const offset = await promptOffset(dashboard, detail);
  expect(Math.abs(offset), `the prompt label is ${offset.toFixed(1)}px off the first line`)
    .toBeLessThanOrEqual(1.5);

  // It still holds once the field grows: the label belongs to the FIRST line, so a taller
  // box must not drag it down with it.
  await composer.fill("one\ntwo\nthree\nfour");
  expect(Math.abs(await promptOffset(dashboard, detail))).toBeLessThanOrEqual(1.5);
  await composer.fill("");

  await shoot(dashboard, detail.locator(".transcript-compose"), "chat-composer");
});

test("Terminal: the toolbar and prompt line up the same way, and the frame is untouched", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "line up the terminal toolbar");
  const detail = await openConsoleDetail(dashboard, daemon, /Line Up the Terminal Toolbar/i);
  await showView(dashboard, detail, "Terminal");

  const frame = detail.getByRole("region", { name: "Conversation terminal" });
  await expect(frame).toBeVisible();
  // The rendering still reads as a framed stream with its composer in it.
  const composer = detail.getByPlaceholder(/^Send the next instruction/);
  await expect(composer).toBeEnabled();
  await expect(frame.locator(".pty-prompt")).toBeVisible();

  for (const width of [1800, 1440, 1160, 1000]) {
    await dashboard.setViewportSize({ width, height: 900 });
    expectOneBand(await toolbar(dashboard, detail), `terminal view at ${width}px`);
  }
  await dashboard.setViewportSize({ width: 1440, height: 900 });

  // Terminal's prompt is on its line, as it was before Chat's was moved: this is the half
  // that fails if the Chat correction ever leaks into the terminal rule.
  const offset = await promptOffset(dashboard, detail);
  expect(Math.abs(offset), `the terminal prompt is ${offset.toFixed(1)}px off its line`)
    .toBeLessThanOrEqual(1.5);
  // And its geometry is the terminal's, not the chat field's: a bare 24px prompt line.
  const field = (await composer.boundingBox())!;
  expect(field.height, "the terminal's prompt line grew into the chat field's box").toBeLessThan(32);

  await shoot(dashboard, detail.locator(".detail-tabs"), "terminal-toolbar");
  await shoot(dashboard, detail.locator(".transcript"), "terminal-frame");

  // Round trip: back to Chat, and the toolbar has not moved.
  await showView(dashboard, detail, "Chat");
  expectOneBand(await toolbar(dashboard, detail), "back in Chat");
});
