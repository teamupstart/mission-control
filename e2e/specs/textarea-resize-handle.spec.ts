import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * The shared `:where(textarea)` rule capped every field at five lines with `max-height`,
 * and the cap clamped the browser's own resize drag as firmly as it clamped content
 * growth. In fields that show a resize grip, a drag stopped at five lines, and a field
 * already at five lines, or held at a taller `min-height`, did not move at all (issue
 * #1477).
 *
 * The drag is the subject, so it is a real pointer drag on the grip, not a style write.
 */

const EVIDENCE = artifactsDir("textarea-resize-handle");
const DRAG = 200;

async function height(field: Locator): Promise<number> {
  const box = await field.boundingBox();
  if (!box) throw new Error("the textarea is not laid out");
  return box.height;
}

/** Drags the grip in the field's bottom-right corner straight down by `dy` pixels. */
async function dragGrip(page: Page, field: Locator, dy: number): Promise<void> {
  await field.scrollIntoViewIfNeeded();
  const box = await field.boundingBox();
  if (!box) throw new Error("the textarea is not laid out");
  const x = box.x + box.width - 3;
  const y = box.y + box.height - 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 12 });
  await page.mouse.up();
}

async function capture(target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}`, animations: "disabled" });
}

test("dragging a textarea's grip makes it taller than the five lines it grows to on its own", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const task = dialog.getByPlaceholder("What should this agent do?");
  await expect(task).toBeVisible();

  await task.fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
  const capped = await height(task);
  await task.fill(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
  expect(await height(task)).toBeCloseTo(capped, 0);
  expect(await task.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await dragGrip(dashboard, task, DRAG);
  const dragged = await height(task);
  expect(dragged).toBeGreaterThan(capped + DRAG - 20);
  await capture(dialog, "dispatch-task-dragged.png");

  await dragGrip(dashboard, task, -120);
  expect(await height(task)).toBeLessThan(dragged - 100);

  // The handle is vertical only. A sideways drag would push a full-width field out of its
  // column, so the width does not follow the pointer.
  const width = (await task.boundingBox())!.width;
  const box = (await task.boundingBox())!;
  await dashboard.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
  await dashboard.mouse.down();
  await dashboard.mouse.move(box.x + box.width + 150, box.y + box.height - 3, { steps: 8 });
  await dashboard.mouse.up();
  expect((await task.boundingBox())!.width).toBeCloseTo(width, 0);

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await task.fill("exercise the composer resize grip");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();

  // Fill it to the cap first, so the drag starts exactly where the old rule pinned it.
  await composer.fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
  const composerCapped = await height(composer);
  await dragGrip(dashboard, composer, DRAG);
  expect(await height(composer)).toBeGreaterThan(composerCapped + DRAG - 20);
  await expect(composer).toHaveValue(/line 12$/);
  await capture(card, "composer-dragged.png");
});
