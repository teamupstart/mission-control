import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

const DRAFT = "Select this task text without closing the dispatch form.";
const EVIDENCE = artifactsDir("dispatch-backdrop-dismiss");

async function openDispatch(page: Page) {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  return dialog;
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
}

for (const source of ["task text", "heading"] as const) {
  test(`selecting ${source} and releasing on the backdrop keeps dispatch open`, async ({ dashboard }) => {
    const dialog = await openDispatch(dashboard);
    const task = dialog.getByPlaceholder("What should this agent do?");
    await task.fill(DRAFT);
    const selectionSource = source === "task text"
      ? task
      : dialog.getByRole("heading", { name: "Dispatch an agent" });
    const bounds = (await selectionSource.boundingBox())!;
    const panel = (await dialog.boundingBox())!;
    const start = { x: bounds.x + 100, y: bounds.y + 15 };
    const outside = { x: panel.x / 2, y: start.y };

    await dashboard.mouse.move(start.x, start.y);
    await dashboard.mouse.down();
    await dashboard.mouse.move(outside.x, outside.y, { steps: 12 });
    await dashboard.mouse.up();

    await expect(dialog).toBeVisible();
    await expect(task).toHaveValue(DRAFT);
    const selected = source === "task text"
      ? await task.evaluate((element: HTMLTextAreaElement) =>
        element.value.slice(element.selectionStart, element.selectionEnd))
      : await dashboard.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.length, "the mouse gesture actually selected text").toBeGreaterThan(0);
    await capture(dashboard, source === "task text" ? "task-selection-retained" : "heading-selection-retained");

    // An ignored drag must not prevent the next ordinary outside click from dismissing.
    await dashboard.mouse.click(outside.x, outside.y);
    await expect(dialog).toBeHidden();
  });
}

test("only a complete outside click dismisses dispatch, and explicit close controls still work", async ({ dashboard }) => {
  const dialog = await openDispatch(dashboard);
  const task = dialog.getByPlaceholder("What should this agent do?");
  await task.fill(DRAFT);
  const heading = dialog.getByRole("heading", { name: "Dispatch an agent" });
  await heading.click();
  await expect(dialog).toBeVisible();
  const bounds = (await heading.boundingBox())!;
  const panel = (await dialog.boundingBox())!;
  const inside = { x: bounds.x + 100, y: bounds.y + 15 };
  const outside = { x: panel.x / 2, y: inside.y };

  // The inverse crossing is not an outside click either.
  await dashboard.mouse.move(outside.x, outside.y);
  await dashboard.mouse.down();
  await expect(dialog).toBeVisible();
  await dashboard.mouse.move(inside.x, inside.y, { steps: 12 });
  await dashboard.mouse.up();
  await expect(dialog).toBeVisible();

  await dashboard.mouse.move(outside.x, outside.y);
  await dashboard.mouse.down();
  await expect(dialog).toBeVisible();
  await dashboard.mouse.up();
  await expect(dialog).toBeHidden();
  await capture(dashboard, "outside-click-dismissed");

  await openDispatch(dashboard);
  await expect(task).toHaveValue(DRAFT);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await openDispatch(dashboard);
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("non-Dispatch overlays keep their existing drag-release dismissal", async ({ dashboard }) => {
  await dashboard.getByRole("button", { name: "Report product feedback", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Report product feedback" });
  await expectContentClearsBorder(dialog);
  const heading = dialog.getByRole("heading", { name: "Report product feedback" });
  const bounds = (await heading.boundingBox())!;
  const panel = (await dialog.boundingBox())!;

  await dashboard.mouse.move(bounds.x + 100, bounds.y + 15);
  await dashboard.mouse.down();
  await dashboard.mouse.move(panel.x / 2, bounds.y + 15, { steps: 12 });
  await dashboard.mouse.up();

  await expect(dialog).toBeHidden();
  await capture(dashboard, "feedback-drag-dismissed");
});
