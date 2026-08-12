import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The console detail's tab strip IS the conversation's toolbar.
 *
 * The worktree band that used to sit above the transcript is gone, and its two controls -
 * the Terminal-view toggle and the two launchers - live in the tab row, which already ran
 * the full width with dead space after "Files". That band was ~81px of the ~294px of fixed
 * chrome above the transcript in a 600px pane, and the conversation gets it back
 * (`docs/plans/console-header-density/plan.md`).
 *
 * Four things are at stake and only a browser can settle any of them:
 *
 *  1. The controls are really in the tab row, they really work from there, and the pane's
 *     worktree path appears exactly ONCE - in the `PATH`/`BRANCH` row. Twice would recreate
 *     the duplication this whole effort started from.
 *  2. **Cards did not lose anything.** `SessionLaunchers` had a single deliberate mount in
 *     `TranscriptPanel`, and `.detail-tabs` belongs to `ConsoleDetail`, which the Cards
 *     layout never renders - so MOVING the mount would have deleted the strip, the toggle
 *     and the `t` / `a` chords from Cards. It is suppressed per-host instead, and this is
 *     the layer that can tell those two apart.
 *  3. The `t` / `a` chords still resolve in BOTH hosts. That break is silent: App parks a
 *     `pendingLauncherAction` and clears it only when a `SessionLaunchers` registers for
 *     that id, so a host with no strip leaves a pending action that never fires and a stale
 *     ref that fires on some unrelated later mount.
 *  4. The row stays ONE row on a narrow pane, and the labels it sheds keep their accessible
 *     names. Modelled on `topbar-one-row.spec.ts`, including its width-based "is it actually
 *     drawn" poll - a visually-hidden label still has a 1x1 box, so Playwright counts it
 *     visible and `toBeVisible` cannot tell a shed label from a drawn one.
 *
 * No model tokens: `MISSION_CLAUDE_BIN` points at the fake throughout.
 */

const EVIDENCE = artifactsDir("console-tabs-toolbar");

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the row being photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/console-tabs-toolbar/${name}.png`);
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
}

/**
 * Switch to the Console layout and open one session's detail.
 *
 * Written to the daemon rather than to `localStorage`, because the web store hydrates from
 * `GET /api/ui/config` at boot and overwrites the local cache - the same idiom
 * `conversation-terminal-view.spec.ts` uses. The session is then chosen the way a person
 * chooses one, off the rail by name, so the detail under test is one somebody arrived at.
 */
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

  const rail = page.getByRole("navigation", { name: "Sessions" });
  await rail.getByRole("button", { name }).click();
  const detail = page.locator(".cdetail");
  await expect(detail).toBeVisible();
  return detail;
}

/**
 * Assert whether an element is actually DRAWN, rather than clipped to the 1x1
 * visually-hidden box a shed label keeps so it can hold on to its accessible name.
 * Playwright counts that box as visible, so `toBeVisible` cannot tell the two apart and the
 * width has to be read. Polled, because a rung lands a frame after the resize that caused it.
 */
async function expectDrawn(locator: Locator, want: boolean, why: string): Promise<void> {
  await expect
    .poll(async () => ((await locator.boundingBox())?.width ?? 0) > 2, { message: why })
    .toBe(want);
}

interface Row {
  /** How many rows the strip's controls are laid out on. */
  rows: number;
  /** The rungs currently applied, e.g. `1 2`. */
  rung: string;
  /** The room the row has, and how much text it carries - the fit's two guards. */
  container: number;
  textLength: number;
}

/**
 * Read the tab strip after letting the fit run.
 *
 * The wait is not slack. `ResizeObserver` delivers after layout and before paint, so a
 * sample taken between a viewport change and that delivery catches a row the operator never
 * sees - which reads as an intermittent two-row failure at scattered widths.
 */
async function readRow(page: Page): Promise<Row> {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  return await page.evaluate(() => {
    const row = document.querySelector(".detail-tabs") as HTMLElement;
    const style = getComputedStyle(row);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    // One row is as tall as the tallest control on it. A second row costs the 6px row-gap
    // plus a ~37px tab, so this is never a close call.
    const tallest = Math.max(0, ...[...row.children].map((k) => (k as HTMLElement).offsetHeight));
    return {
      rows: row.clientHeight - padY > tallest + 2 ? 2 : 1,
      rung: row.dataset.rung ?? "",
      container: Math.round(
        row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      ),
      textLength: (row.textContent ?? "").length,
    };
  });
}

test("the console detail's tab row carries the conversation's toolbar, and the path once", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "fold the toolbar into the tab row");
  const detail = await openConsoleDetail(dashboard, daemon, /Fold the Toolbar Into the Tab Row/i);

  const tabs = detail.locator(".detail-tabs");
  await expect(tabs).toBeVisible();

  // The three controls are IN the tab row - asserted through the row rather than through the
  // detail, which is the difference between "they moved" and "they exist somewhere".
  await expect(tabs.getByRole("button", { name: "Terminal view" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /Terminal$/ })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /Claude Code$/ })).toBeVisible();
  // And Foreman is still at the far end of it, past them.
  await expect(tabs.getByRole("button", { name: /foreman/i })).toBeVisible();

  // The band they came from is gone: the conversation pane draws no strip of its own.
  await expect(detail.locator(".detail-conv .conv-launch")).toHaveCount(0);

  // The worktree path appears EXACTLY ONCE in the pane, in the `PATH`/`BRANCH` row. This is
  // the assertion that keeps the move from recreating the duplication the plan started from:
  // option 2 keeps that row, so a copy in the tab strip would be the second one.
  const cwd = (await detail.locator(".detail-sub .kv").first().innerText()).split("\n").pop()!;
  const leaf = cwd.trim().split("/").filter(Boolean).pop()!;
  expect(leaf.length, "the path row rendered nothing to look for").toBeGreaterThan(3);
  await expect(tabs.getByText(leaf)).toHaveCount(0);

  // And the point of all of it: the log takes a materially larger share of the pane. Stated
  // as a SHARE rather than as a pixel count, because the absolute figure is a function of
  // the window and of the font stack, while the split between the log and the chrome
  // stacked on top of it inside `.detail-conv` is the thing this change moved. Measured on
  // this machine at a 600px detail: 236/404 = 58% before, 285/404 = 71% after - so a 65%
  // floor fails the previous commit and passes this one with room on both sides.
  const share = await dashboard.evaluate(() => {
    const conv = document.querySelector(".detail-conv") as HTMLElement;
    const log = document.querySelector(".transcript-log") as HTMLElement;
    return log.getBoundingClientRect().height / conv.getBoundingClientRect().height;
  });
  expect(share, "the transcript log is not taking the height the retired band gave back")
    .toBeGreaterThan(0.65);

  await shoot(dashboard, detail, "01-console-detail-tab-toolbar");
});

test("the toggle in the tab row really switches the conversation under it", async ({
  dashboard,
  daemon,
}) => {
  // `useSessionConversationView` re-renders only its OWN caller, and the caller is now
  // `ConsoleDetail` rather than the panel that draws the log. That works because the panel
  // is this component's child and is not memoized - a cascade, not a subscription - so the
  // claim is worth asserting rather than reasoning about. A sibling of the panel would have
  // set the override and left the log drawn in the other rendering.
  await dispatch(dashboard, daemon, "switch the rendering from the tab row");
  const detail = await openConsoleDetail(dashboard, daemon, /Switch the Rendering From the Tab Row/i);

  const toggle = detail.locator(".detail-tabs").getByRole("button", { name: "Terminal view" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toBeVisible();
  await expect(detail.getByPlaceholder(/^Send the next instruction/)).toBeEnabled();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(detail.getByRole("region", { name: "Conversation terminal" })).toHaveCount(0);
  await expect(detail.getByPlaceholder(/^Reply to this session/)).toBeVisible();

  // The toggle is about the pane you are READING, so it stands down on a tab that is not the
  // conversation - where it would be an `aria-pressed` control over a surface not on screen.
  // The launchers do not: they open the session somewhere else, which is a question you can
  // ask from any tab.
  await detail.getByRole("tab", { name: /Files/ }).click();
  await expect(toggle).toHaveCount(0);
  await expect(
    detail.locator(".detail-tabs").getByRole("button", { name: /Terminal$/ }),
  ).toBeVisible();
});

test("Cards keep their own toolbar, and t still opens it there", async ({ dashboard, daemon }) => {
  // The regression that a naive move ships, and it is silent in both halves. `SessionLaunchers`
  // is mounted from `TranscriptPanel`, whose only other host is the Cards layout - which never
  // renders `ConsoleDetail` and so has no tab row to move anything into. And App clears its
  // parked `pendingLauncherAction` only when a strip REGISTERS for that id, so a host with no
  // strip leaves the chord dead and a stale ref behind.
  await dispatch(dashboard, daemon, "keep the cards toolbar working");
  const card = dashboard.locator("article.card").first();
  await settled(card);
  await card.getByRole("button", { name: "Expand conversation" }).click();

  // Still the pane-owned band, worktree path and all - this host has nowhere better to put it.
  const strip = card.locator(".conv-launch");
  await expect(strip).toBeVisible();
  // The caption by class rather than by text: the fixture's checkout is a temp directory
  // whose own path contains the word, so `getByText` matches the caption and the path both.
  await expect(strip.locator(".conv-launch-lbl")).toHaveText("worktree");
  await expect(strip.locator(".conv-launch-path")).toHaveText(/^\/.+/);
  await expect(strip.getByRole("button", { name: "Terminal view" })).toBeVisible();

  // The chord, driven from the card the arrows have selected. It reaches the exact button
  // the operator can see: the terminal launcher's own backend chooser opens.
  await card.click({ position: { x: 8, y: 8 } });
  await dashboard.keyboard.press("t");
  const menu = card.getByRole("menu", { name: /Open a shell in the worktree with/ });
  await expect(menu).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await shoot(dashboard, card, "02-cards-keep-their-own");
});

test("t reaches the tab row's launcher in the console too", async ({ dashboard, daemon }) => {
  // The other half of the same registration. The console's strip is the one that registers
  // now, and it does so from a row that is mounted on every tab - so the chord resolves
  // without first having to reveal the conversation.
  await dispatch(dashboard, daemon, "drive the console launcher by chord");
  const detail = await openConsoleDetail(dashboard, daemon, /Drive the Console Launcher by Chord/i);
  await expect(detail.locator(".detail-tabs .conv-launch")).toBeVisible();

  await detail.getByRole("tab", { name: /Files/ }).click();
  await dashboard.keyboard.press("t");
  const menu = detail.getByRole("menu", { name: /Open a shell in the worktree with/ });
  await expect(menu).toBeVisible();
  // It is the tab row's button that owns it, not a resurrected second mount in the pane.
  await expect(detail.locator(".detail-tabs .launch-pop")).toHaveCount(1);
  await dashboard.keyboard.press("Escape");
});

test("the tab row stays one row on a narrow pane, and keeps every name", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "hold the tab row to one line");
  const detail = await openConsoleDetail(dashboard, daemon, /Hold the Tab Row to One Line/i);
  const tabs = detail.locator(".detail-tabs");

  // Wide first, so the narrow case below is a change rather than a starting condition.
  await dashboard.setViewportSize({ width: 1800, height: 900 });
  const wide = await readRow(dashboard);
  expect(wide.rows, "the row is already stacked at 1800px").toBe(1);
  const viewWord = tabs.getByRole("button", { name: "Terminal view" }).locator(".launch-word");
  await expectDrawn(viewWord, true, "precondition: a wide pane draws every word");

  // The reported width. The console gives the rail ~300px, so this is the pane the design
  // mockup measured a 101px overflow at.
  await dashboard.setViewportSize({ width: 1160, height: 900 });
  const narrow = await readRow(dashboard);

  // Photographed BEFORE the assertion, so the same command run against the commit this
  // builds on produces the stacked frame rather than stopping at a red assertion with
  // nothing to look at. "One row" is checkable in the DOM as a height; it is only legible
  // as a toolbar here.
  await shoot(dashboard, tabs, "03-narrow-one-row");

  expect(narrow.rows, `the tab row wrapped to ${narrow.rows} rows`).toBe(1);
  expect(narrow.rung, "the row bought that by spending no rung at all").not.toBe("");

  // It bought the row by shedding a LABEL, and the control it shed still says what it is:
  // the button is drawn (its glyph is there), its word is not, and its accessible name is
  // untouched - which is the whole reason a shed label is hidden visually and never with
  // `display: none`.
  await expectDrawn(viewWord, false, "the toggle's word survived a pane that had no room");
  await expect(tabs.getByRole("button", { name: "Terminal view" })).toBeVisible();
  // And no tab ever gives up its own word. The tabs are what this row IS.
  for (const label of ["Conversation", "Work queue", "Workflows", "Diff", "Files"]) {
    await expectDrawn(
      tabs.getByRole("tab", { name: new RegExp(label) }),
      true,
      `the ${label} tab was shed, and no rung may ever do that`,
    );
  }

  // The invariant, stated without a magic number: at every width the row is either on one
  // line or has already spent every rung it has. A threshold cannot promise that, because
  // this row's requirement moves with the session - the agent's own name, the Foreman slot's
  // three shapes, the queue pip.
  const stacked: string[] = [];
  for (let width = 1800; width >= 900; width -= 40) {
    await dashboard.setViewportSize({ width, height: 900 });
    const row = await readRow(dashboard);
    if (row.rows === 1 || row.rung === "1 2 3 4") continue;
    stacked.push(`${width}px (rungs applied: "${row.rung}")`);
  }
  expect(stacked, "the tab row stacked while it still had rungs in hand").toEqual([]);

  // And it is a ladder, not a ratchet: the words come back when the room does. A fit that
  // only ever collapsed would satisfy the sweep above completely and leave the row reading
  // as unnamed glyphs for the rest of the session.
  await dashboard.setViewportSize({ width: 1800, height: 900 });
  const back = await readRow(dashboard);
  expect(back.rows).toBe(1);
  expect(
    back.rung.split(" ").filter(Boolean).length,
    `the wide row still holds the narrow row's rungs ("${back.rung}" after "${narrow.rung}")`,
  ).toBeLessThan(narrow.rung.split(" ").filter(Boolean).length);
  await expectDrawn(viewWord, true, "the toggle's word never came back when the room did");
});
