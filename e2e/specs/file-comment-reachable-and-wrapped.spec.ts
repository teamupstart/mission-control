import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Reaching a file comment's control, and reading what you typed into it.
 *
 * Both are laid-out geometry, which is what the other three UI layers cannot produce:
 * `renderToStaticMarkup` never lays anything out, the route tests have no browser, and the
 * Electron geometry tests never mount this workspace.
 */

const EVIDENCE = artifactsDir("file-comment-reachable-and-wrapped");

/** Photograph a state this spec has already asserted on. See file-line-comments.spec.ts. */
async function shoot(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/file-comment-reachable-and-wrapped/${name}.png`);
}

const TASK = "point at a paragraph and write about it";
const SOURCE = "docs/plans/spec.md";

/** Long enough that the editor scrolls sideways, which is the condition under test. */
const LONG_LINE = `The retry budget is thirty seconds${", and the window is not configurable".repeat(12)}.`;
const CONTENTS = [
  "# The spec",                                  // 1
  "",                                            // 2
  "The retry budget is thirty seconds.",         // 3
  "",                                            // 4
  LONG_LINE,                                     // 5
  "",                                            // 6
].join("\n");

const COMMENT =
  "This contradicts the table three screens down, which says the retry budget is ninety "
  + "seconds and that the window is configurable per repository.";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every keystroke;
  // without this the next fill lands on a covered control. See file-default-view.spec.ts.
  await page.keyboard.press("Escape");
  const task = dialog.getByPlaceholder("What should this agent do?");
  await expect.poll(async () => {
    await task.fill(TASK);
    return task.inputValue();
  }, { message: "the Task field never took the text" }).toBe(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The Files TAB lives in the Console layout. See diff-open-in-files.spec.ts. */
async function useConsoleLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Console layout").toBe("console");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
}

async function sessionCwd(daemon: DaemonHandle): Promise<string> {
  await expect
    .poll(async () => {
      const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
        cwd: string | null;
      }[];
      return sessions[0]?.cwd ?? null;
    }, { message: "the dispatched session never reported a working directory" })
    .not.toBeNull();
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    cwd: string | null;
  }[];
  return sessions[0]!.cwd!;
}

function write(cwd: string, path: string, contents: string): void {
  mkdirSync(join(cwd, dirname(path)), { recursive: true });
  writeFileSync(join(cwd, path), contents);
}

async function openTheFile(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Sessions" })
    .getByRole("button", { name: /Point At A Paragraph/i })
    .click();
  await page
    .getByRole("tablist", { name: "Session detail" })
    .getByRole("tab", { name: /Files$/ })
    .click();
  await expect(page.getByRole("listbox", { name: "Session files" })).toBeVisible();
  await page
    .getByRole("listbox", { name: "Session files" })
    .getByRole("option", { name: SOURCE })
    .click();
  await expect(page.getByLabel(`Preview of ${SOURCE}`)).toBeVisible();
}

/** Turn comment mode on, and prove the control says so. */
async function startCommenting(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Comment mode" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
}

test.describe("reaching and reading a file comment", () => {
  test("the pointer can travel from a rendered block to its comment control", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, SOURCE, CONTENTS);
    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await startCommenting(page);

    const preview = page.getByLabel(`Preview of ${SOURCE}`);
    const paragraph = preview.getByText("The retry budget is thirty seconds.", { exact: true });
    await paragraph.hover();
    const control = preview.getByRole("button", { name: "Comment on line 3" });
    const box = (await control.boundingBox())!;
    const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // Raw `page.mouse` in steps rather than `locator.hover()`/`click()`, which teleport the
    // pointer onto the target: the gutter between the block and its control has to be crossed
    // rather than skipped, or the case this test exists for never happens.
    await page.mouse.move(box.x + box.width + 24, target.y, { steps: 8 });
    await page.mouse.move(target.x, target.y, { steps: 8 });

    // Opacity, not `toBeVisible()`: the control is hidden by opacity so it stays focusable,
    // and Playwright counts an `opacity: 0` element as visible.
    await expect
      .poll(() => control.evaluate((el) => getComputedStyle(el).opacity), {
        message: "the control faded out as the pointer arrived on it",
      })
      .toBe("1");
    await shoot(page.locator(".file-content"), "preview-control-under-pointer");

    // Pressed where the pointer already is; `control.click()` would re-aim first.
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByRole("region", { name: "New comment on line 3" })).toBeVisible();
  });

  test("the Editor composer fits the pane and wraps what is typed into it", async ({
    dashboard: page,
    daemon,
  }) => {
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, SOURCE, CONTENTS);
    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    await startCommenting(page);

    // The precondition: a document wide enough that the editor scrolls sideways.
    const scroller = page.locator(".file-codemirror .cm-scroller");
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth), {
        message: "the fixture never made the editor scroll sideways",
      })
      .toBe(true);

    await page
      .locator(".cm-lineNumbers .cm-gutterElement")
      .filter({ hasText: /^3$/ })
      .click();
    const composer = page.getByRole("region", { name: "New comment on line 3" });
    await expect(composer).toBeVisible();
    const box = page.getByRole("textbox", { name: "Comment on line 3" });
    await box.fill(COMMENT);

    const fits = await composer.evaluate((panel) => {
      const scrollport = panel.closest(".cm-scroller")!;
      const area = panel.querySelector("textarea")!;
      return {
        panelRight: panel.getBoundingClientRect().right,
        // The scrollport's right edge - what a reader can see - not the content box's.
        visibleRight: scrollport.getBoundingClientRect().left + scrollport.clientWidth,
        boxScrollWidth: area.scrollWidth,
        boxClientWidth: area.clientWidth,
      };
    });
    // Rounded: a fractional pane width leaves a sub-pixel remainder that means nothing here.
    expect(Math.round(fits.panelRight)).toBeLessThanOrEqual(Math.round(fits.visibleRight));
    // A box that did not wrap would scroll sideways: scroll width past client width.
    expect(fits.boxScrollWidth).toBeLessThanOrEqual(fits.boxClientWidth);
    await shoot(page.locator(".file-main"), "editor-composer-wraps");
  });

  test("the open composer re-fits when the pane resizes, the gutter grows, or the source scrolls", async ({
    dashboard: page,
    daemon,
  }) => {
    // A frozen width passes a test that measures once, so each observed dimension is moved
    // here and the fit re-asserted.
    await dispatch(page, daemon);
    const cwd = await sessionCwd(daemon);
    write(cwd, SOURCE, CONTENTS);
    await useConsoleLayout(page, daemon);
    await openTheFile(page);
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    await startCommenting(page);

    await page
      .locator(".cm-lineNumbers .cm-gutterElement")
      .filter({ hasText: /^3$/ })
      .click();
    const composer = page.getByRole("region", { name: "New comment on line 3" });
    await expect(composer).toBeVisible();
    await page.getByRole("textbox", { name: "Comment on line 3" }).fill(COMMENT);

    /** `available` is the contract: the visible scrollport, less the gutters to clear. */
    const measure = async (): Promise<{
      available: number;
      panelWidth: number;
      overflowRight: number;
      clearsGutter: boolean;
    }> =>
      composer.evaluate((panel) => {
        const host = panel.parentElement!;
        const scrollport = panel.closest(".cm-scroller") as HTMLElement;
        const gutters = scrollport.querySelector(".cm-gutters") as HTMLElement;
        const visibleLeft = scrollport.getBoundingClientRect().left;
        const rect = host.getBoundingClientRect();
        return {
          available: Math.round(scrollport.clientWidth - gutters.offsetWidth),
          panelWidth: Math.round(rect.width),
          overflowRight: Math.round(rect.right - (visibleLeft + scrollport.clientWidth)),
          clearsGutter: Math.round(rect.left) >= Math.round(visibleLeft + gutters.offsetWidth) - 1,
        };
      });

    const atRest = await measure();
    expect(atRest.panelWidth).toBe(atRest.available);

    // ---- the pane resizes ----
    // The app's own divider, which is the gesture a reader makes. See file-list-resize.
    const divider = page.getByRole("separator", { name: "Resize file list" });
    const handle = (await divider.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + handle.height / 2, {
      steps: 8,
    });
    await page.mouse.up();

    await expect
      .poll(async () => {
        const now = await measure();
        return {
          widened: now.available > atRest.available,
          fitsExactly: now.panelWidth === now.available,
          onScreen: now.overflowRight <= 0,
        };
      }, { message: "the composer did not re-fit after the pane was resized" })
      .toEqual({ widened: true, fitsExactly: true, onScreen: true });
    const afterResize = await measure();

    // ---- the gutter grows ----
    // Six lines become sixteen, so line numbers need a second digit and the gutter widens
    // while the pane does not. Appended at the END, so line 3 keeps its number.
    await page.locator(".cm-content .cm-line").last().click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(
      `\n${Array.from({ length: 10 }, (_, index) => `Filler line ${index + 1}.`).join("\n")}`,
    );

    await expect
      .poll(async () => {
        const now = await measure();
        return {
          narrowed: now.available < afterResize.available,
          fitsExactly: now.panelWidth === now.available,
          clearsGutter: now.clearsGutter,
        };
      }, { message: "the composer did not re-fit after the gutter widened" })
      .toEqual({ narrowed: true, fitsExactly: true, clearsGutter: true });

    // ---- the source scrolls sideways ----
    // The panel is sticky, so it must stay in the pane and stay off the gutters.
    await page.locator(".file-codemirror .cm-scroller").evaluate((el) => {
      el.scrollLeft = 400;
    });
    await expect
      .poll(async () => {
        const now = await measure();
        return { onScreen: now.overflowRight <= 0, clearsGutter: now.clearsGutter };
      }, { message: "the composer did not stay in view when the source scrolled sideways" })
      .toEqual({ onScreen: true, clearsGutter: true });
    await shoot(page.locator(".file-main"), "editor-composer-refits");

    // ---- the view is destroyed and rebuilt ----
    // Leaving the Editor disconnects the observers; coming back must measure again.
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByLabel(`Preview of ${SOURCE}`)).toBeVisible();
    await page.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(page.getByLabel(`Editor for ${SOURCE}`)).toBeVisible();
    await expect(composer).toBeVisible();
    await expect
      .poll(async () => {
        const now = await measure();
        return { fitsExactly: now.panelWidth === now.available, onScreen: now.overflowRight <= 0 };
      }, { message: "a rebuilt editor did not measure its panel host again" })
      .toEqual({ fitsExactly: true, onScreen: true });
  });
});
