import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

const DRAFT = "Select this task text without closing the dispatch form.";
const QUESTION = "What retry budget should the reader use?";
const ANSWER = "three retries, then give up";
const EVIDENCE = artifactsDir("overlay-backdrop-dismiss");

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
}

async function outsidePoint(dialog: Locator, y: number): Promise<{ x: number; y: number }> {
  const panel = (await dialog.boundingBox())!;
  return { x: panel.x / 2, y };
}

async function dragOut(page: Page, dialog: Locator, source: Locator): Promise<{ x: number; y: number }> {
  const bounds = (await source.boundingBox())!;
  const start = { x: bounds.x + Math.min(100, bounds.width / 2), y: bounds.y + Math.min(15, bounds.height / 2) };
  const outside = await outsidePoint(dialog, start.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(outside.x, outside.y, { steps: 12 });
  await page.mouse.up();
  return outside;
}

function textareaSelection(field: Locator): Promise<string> {
  return field.evaluate((element: HTMLTextAreaElement) =>
    element.value.slice(element.selectionStart, element.selectionEnd));
}

function documentSelection(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function openDispatch(page: Page) {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  return dialog;
}

for (const source of ["task text", "heading"] as const) {
  test(`selecting dispatch ${source} and releasing on the backdrop keeps dispatch open`, async ({ dashboard }) => {
    const dialog = await openDispatch(dashboard);
    const task = dialog.getByPlaceholder("What should this agent do?");
    await task.fill(DRAFT);
    const selectionSource = source === "task text"
      ? task
      : dialog.getByRole("heading", { name: "Dispatch an agent" });

    const outside = await dragOut(dashboard, dialog, selectionSource);

    await expect(dialog).toBeVisible();
    await expect(task).toHaveValue(DRAFT);
    const selected = source === "task text" ? await textareaSelection(task) : await documentSelection(dashboard);
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
  const inside = { x: bounds.x + 100, y: bounds.y + 15 };
  const outside = await outsidePoint(dialog, inside.y);

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

test("a drag out of the product feedback modal keeps it open; a full outside click closes it", async ({ dashboard }) => {
  await dashboard.getByRole("button", { name: "Report product feedback", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Report product feedback" });
  await expectContentClearsBorder(dialog);
  const heading = dialog.getByRole("heading", { name: "Report product feedback" });

  const outside = await dragOut(dashboard, dialog, heading);

  await expect(dialog).toBeVisible();
  expect((await documentSelection(dashboard)).length, "the drag selected heading text").toBeGreaterThan(0);
  await capture(dashboard, "feedback-drag-retained");

  await dashboard.mouse.click(outside.x, outside.y);
  await expect(dialog).toBeHidden();
});

function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

async function dispatchSession(page: Page, daemon: DaemonHandle): Promise<void> {
  const dialog = await openDispatch(page);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("tune the transcript cache");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

async function askQuestion(daemon: DaemonHandle): Promise<void> {
  let cwd: string | null = null;
  await expect
    .poll(
      async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          cwd: string | null;
        }>;
        cwd = sessions[0]?.cwd ?? null;
        return cwd;
      },
      { message: "the dispatched session is on the fleet, with a checkout to bind a review to" },
    )
    .toBeTruthy();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, kind: "input", title: QUESTION, body: QUESTION }),
  });
  expect(res.status, `the review channel accepted the request: ${await res.clone().text()}`).toBe(200);
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: /to review/ }).click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  return modal;
}

test("selecting review question text and releasing on the backdrop keeps the review open", async ({
  dashboard,
  daemon,
}) => {
  await dispatchSession(dashboard, daemon);
  await askQuestion(daemon);
  const modal = await openReview(dashboard);
  await expectContentClearsBorder(modal);
  const answer = modal.getByPlaceholder("Your answer…");
  await answer.fill(ANSWER);

  await dragOut(dashboard, modal, answer);
  await expect(modal).toBeVisible();
  await expect(answer).toHaveValue(ANSWER);
  expect((await textareaSelection(answer)).length, "the drag selected answer text").toBeGreaterThan(0);
  await capture(dashboard, "review-answer-selection-retained");

  const outside = await dragOut(dashboard, modal, modal.getByText(QUESTION).first());
  await expect(modal).toBeVisible();
  expect((await documentSelection(dashboard)).length, "the drag selected question text").toBeGreaterThan(0);
  await capture(dashboard, "review-question-selection-retained");

  const bounds = (await answer.boundingBox())!;
  await dashboard.mouse.move(outside.x, outside.y);
  await dashboard.mouse.down();
  await dashboard.mouse.move(bounds.x + 20, bounds.y + bounds.height / 2, { steps: 12 });
  await dashboard.mouse.up();
  await expect(modal).toBeVisible();

  await dashboard.mouse.click(outside.x, outside.y);
  await expect(modal).toBeHidden();
  const reopened = await openReview(dashboard);
  await expect(reopened.getByText(QUESTION).first()).toBeVisible();
});
