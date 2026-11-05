import { mkdirSync } from "node:fs";
import { expect, test } from "../fixtures/test.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { Task } from "../../src/shared/types.ts";
import { LOCAL_PLAN_VALIDATION_WORKFLOW_ID, PLAN_VALIDATION_WORKFLOW_ID } from "../../src/shared/builtin-workflow.ts";

test("plan tasks override storage, display their pins, and edit with compatible workflows", async ({ dashboard: page, daemon }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const configure = async (planStorage: "local" | "repository") => {
    const response = await fetch(`${daemon.baseURL}/api/skills/config`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ planStorage }),
    });
    expect(response.ok).toBe(true);
  };
  await configure("repository");
  const created: Task[] = [];
  for (const storage of ["local", "repository"] as const) {
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
    await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
    await page.keyboard.press("Escape");
    await dialog.getByPlaceholder("What should this agent do?").fill(`Plan storage ${storage}`);
    await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
    const picker = dialog.getByRole("combobox", { name: "Plan storage", exact: true });
    await expect(picker.locator('option[value="__default"]')).toHaveText("Use global default - Repository");
    await picker.hover();
    await expect(page.locator(".tooltip")).toContainText("Choose where this task saves its plan.");
    if (process.env.MC_E2E_EVIDENCE && storage === "local") {
      const dir = artifactsDir("task-plan-storage");
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: `${dir}storage-tooltip.png`, animations: "disabled" });
    }
    await picker.selectOption(storage);
    await expect(dialog.getByRole("combobox", { name: "After work", exact: true })).toHaveValue(
      storage === "local" ? LOCAL_PLAN_VALIDATION_WORKFLOW_ID : PLAN_VALIDATION_WORKFLOW_ID);
    await expect(dialog.getByText(storage === "local" ? "Retained outside Git; validates without a plan PR." : "Published through the repository PR workflow.", { exact: true })).toBeVisible();
    await expectContentClearsBorder(dialog);
    const response = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
    await dialog.getByRole("button", { name: "Add to backlog", exact: true }).click();
    const saved = await response;
    expect(saved.ok(), await saved.text()).toBe(true);
    const task = await saved.json() as Task;
    expect(task.planPolicy?.storage).toBe(storage);
    created.push(task);
    await expect(dialog).toBeHidden();
  }
  expect((await (await fetch(`${daemon.baseURL}/api/skills`)).json()).planStorage).toBe("repository");
  await configure("local");
  const board = await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }) });
  expect(board.ok).toBe(true);
  await page.reload();
  const task = created[1]!;
  await page.locator(".bl-card", { hasText: task.title }).getByRole("button", { name: task.title, exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit a backlog task" });
  await expectContentClearsBorder(editor);
  const picker = editor.getByRole("combobox", { name: "Plan storage", exact: true });
  await expect(picker).toHaveValue("repository");
  await expect(editor.getByText(/Pinned storage: Repository/)).toBeVisible();
  await expect(picker.locator('option[value="__default"]')).toHaveText("Use global default - Local plan store");
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("task-plan-storage");
    mkdirSync(dir, { recursive: true });
    await page.mouse.move(0, 0);
    await editor.screenshot({ path: `${dir}pinned-repository.png`, animations: "disabled" });
  }
  await picker.selectOption("__default");
  await expect(editor.getByRole("combobox", { name: "After work", exact: true })).toHaveValue(LOCAL_PLAN_VALIDATION_WORKFLOW_ID);
  const updated = page.waitForResponse(r => new URL(r.url()).pathname === `/api/tasks/${task.id}/update`);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const response = await updated;
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).task.planPolicy.storage).toBe("local");
  await expect(editor).toBeHidden();
  await page.locator(".bl-card", { hasText: task.title }).getByRole("button", { name: task.title, exact: true }).click();
  await expect(picker).toHaveValue("local");
  await expect(editor.getByText(/Pinned storage: Local plan store/)).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE) {
    await page.mouse.move(0, 0);
    await editor.screenshot({ path: `${artifactsDir("task-plan-storage")}pinned-local.png`, animations: "disabled" });
  }
});
