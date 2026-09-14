import { mkdirSync } from "node:fs";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

const EVIDENCE = artifactsDir("review-presets");

for (const [name, judges] of [
  ["General Review", ["Intent Conformance Judge", "Code Risk Reviewer", "Code Quality Judge", "Test Coverage Judge", "Test Evidence Auditor", "Slop Filter"]],
  ["Bug Fix Review", ["Intent Conformance Judge", "Root Cause & Regression Judge", "Code Risk Reviewer", "Test Coverage Judge", "Test Evidence Auditor", "Slop Filter"]],
  ["Plan Validation", ["Intent Conformance Judge", "Plan Consistency Judge", "Phase Dependencies Judge", "Plan Feasibility Judge"]],
] as const) {
  test(`${name} exposes its agreed review stages`, async ({ dashboard, daemon }) => {
    await dashboard.setViewportSize({ width: 1440, height: 1000 });
    await dashboard.goto(`${daemon.baseURL}/#/workflows`);
    await dashboard.getByRole("button", { name: new RegExp(name) }).click();
    const pipeline = dashboard.locator(".wf-pipeline-strip");
    await expect(pipeline.locator(".wf-pipeline-reviewer-name")).toHaveText(name === "Plan Validation"
      ? [...judges]
      : ["Commandtypecheck", "Commandtest", ...judges, "Session actionPull Request"]);
    await expect(pipeline.locator(".wf-pipeline-inspector")).toHaveCount(0);
    if (name === "Plan Validation") {
      await expect(pipeline.locator(".wf-pipeline-stage-name").filter({ hasText: /^Pull Request$/ })).toHaveCount(0);
      await expect(pipeline.locator("section.wf-pipeline-stage")).toHaveCount(2);
    } else {
      await expect(pipeline.locator(".wf-pipeline-stage-name").filter({ hasText: /^Pull Request$/ })).toBeVisible();
    }
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      const reviewStage = pipeline.locator("section.wf-pipeline-stage").nth(name === "Plan Validation" ? 1 : 2);
      await reviewStage.scrollIntoViewIfNeeded();
      await dashboard.screenshot({ path: `${EVIDENCE}${name.toLowerCase().replaceAll(" ", "-")}.png`, fullPage: true });
    }
  });
}

test("bugfix defaults to Bug Fix Review and persists as a schedulable task", async ({ dashboard, daemon }) => {
  await dashboard.setViewportSize({ width: 1280, height: 1000 });
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Fix the retry regression");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const workflow = dialog.getByRole("combobox", { name: "After work", exact: true });
  await kind.selectOption("bugfix");
  await expect(workflow).toHaveValue("builtin-workflow:bug-fix-review");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();
  await kind.selectOption("ship");
  await expect(workflow).toHaveValue("__default");
  await kind.selectOption("bugfix");
  await expect(workflow).toHaveValue("builtin-workflow:bug-fix-review");
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dialog.screenshot({ path: `${EVIDENCE}bugfix-default.png` });
  }
  await workflow.selectOption("__default");
  const responsePromise = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const task = await response.json();
  expect(task.kind).toBe("bugfix");
  expect(task.workflowId).toBe("builtin-workflow:bug-fix-review");
  expect(task.status).toBe("backlog");
  expect(task.enabled).toBe(true);
  await expect(dialog).toBeHidden();
  await dashboard.reload();
  await expect(dashboard.getByText("Fix the retry regression").first()).toBeVisible();
});

test("bugfix can opt out of its default and keep the explicit choice", async ({ dashboard, daemon }) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expectContentClearsBorder(dialog);
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const workflow = dialog.getByRole("combobox", { name: "After work", exact: true });
  await kind.selectOption("bugfix");
  await workflow.selectOption("__none");
  await expect(dialog.getByText("No handoff")).toBeVisible();
  await kind.selectOption("ship");
  await expect(workflow).toHaveValue("__none");

  await kind.selectOption("bugfix");
  await workflow.selectOption("__none");
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Fix the retry without review");
  const responsePromise = dashboard.waitForResponse((response) =>
    response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const task = await response.json();
  expect(task.kind).toBe("bugfix");
  expect(task.workflowId).toBe(null);
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const tasks = await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Array<{
      id: string; kind: string; workflowId: string | null;
    }>;
    return tasks.find((saved) => saved.id === task.id);
  }).toMatchObject({ id: task.id, kind: "bugfix", workflowId: null });
});
