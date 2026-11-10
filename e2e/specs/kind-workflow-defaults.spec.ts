import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("kind-workflow-defaults");

/** A frame of the state just asserted, behind `MC_E2E_EVIDENCE` so ordinary runs write nothing. */
async function shoot(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

/**
 * Settings -> Tasks -> Dispatch defaults: one after-work Workflow per task kind.
 *
 * Driven through the browser because the claim spans two surfaces: a row chosen on the
 * Settings page is what the dispatch form preselects when that kind is picked, and what the
 * daemon files when an API caller omits the Workflow. No dispatch is launched, so nothing
 * here spends model tokens.
 */

const GENERAL_REVIEW = "builtin-workflow:general-review";

/** The text of a `<select>`'s chosen option; a collapsed select renders no option text. */
function selectedLabel(select: Locator): Promise<string> {
  return select.evaluate(
    (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "",
  );
}

function kindRow(page: Page, kind: string): Locator {
  return page.getByRole("combobox", { name: `Default after-work Workflow for ${kind} tasks`, exact: true });
}

/** Choose a row's Workflow and wait for the Settings write that carries it to land. */
async function chooseRow(page: Page, kind: string, value: string): Promise<void> {
  const saved = page.waitForResponse((response) =>
    response.url().endsWith("/api/workflows/config") && response.request().method() === "PUT");
  await kindRow(page, kind).selectOption(value);
  expect((await saved).ok()).toBe(true);
}

test("each kind's dispatch default is chosen in Settings and preselected at dispatch", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/tasks`);

  // One row per kind this app launches, each naming what its built-in resolves to.
  await expect(kindRow(dashboard, "bugfix")).toBeEnabled();
  expect(await selectedLabel(kindRow(dashboard, "ship"))).toBe("Built-in default (No-Mistakes Review (High Rigor))");
  expect(await selectedLabel(kindRow(dashboard, "bugfix"))).toBe("Built-in default (Bug Fix Review)");
  expect(await selectedLabel(kindRow(dashboard, "plan"))).toBe("Built-in default (Plan Validation)");
  expect(await selectedLabel(kindRow(dashboard, "scout"))).toBe("Built-in default (None)");
  await expect(kindRow(dashboard, "pipeline")).toHaveCount(0);

  await chooseRow(dashboard, "bugfix", GENERAL_REVIEW);
  await chooseRow(dashboard, "scout", GENERAL_REVIEW);
  await chooseRow(dashboard, "plan", "__none");

  // Durable, not just drawn: a reload reads the rows back from the daemon.
  await dashboard.reload();
  await expect(kindRow(dashboard, "bugfix")).toHaveValue(GENERAL_REVIEW);
  await expect(kindRow(dashboard, "scout")).toHaveValue(GENERAL_REVIEW);
  await expect(kindRow(dashboard, "plan")).toHaveValue("__none");
  expect(await selectedLabel(kindRow(dashboard, "ship"))).toBe("Built-in default (No-Mistakes Review (High Rigor))");
  await shoot(dashboard.locator('[data-anchor="tasks/dispatch-defaults"]'), "01-settings-dispatch-defaults");

  await dashboard.goto(`${daemon.baseURL}/`);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  await expect
    .poll(() => selectedLabel(afterWork), { message: "the Workflow config fetch should settle" })
    .not.toContain("loading");

  await kind.selectOption("bugfix");
  await expect(afterWork).toHaveValue(GENERAL_REVIEW);
  expect(await selectedLabel(afterWork)).toContain("General Review");
  await shoot(dialog, "02-dispatch-bugfix-preselects-row");
  await kind.selectOption("scout");
  await expect(afterWork).toHaveValue(GENERAL_REVIEW);
  // Plan stays on its dispatch default, resolved with its plan storage when the task is saved,
  // and here that default is the row's None.
  await kind.selectOption("plan");
  await expect(afterWork).toHaveValue("__default");
  expect(await selectedLabel(afterWork)).toBe("Dispatch default — none");
  await expect(dialog.getByText("No handoff")).toBeVisible();
  // Back to the kind the form opened on hands back what it opened with.
  await kind.selectOption("ship");
  await expect(afterWork).toHaveValue("__default");
  expect(await selectedLabel(afterWork)).toContain("No-Mistakes Review");

  // The same rows reach a creator that names no Workflow.
  const created = await dashboard.request.post(`${daemon.baseURL}/api/tasks`, {
    data: {
      repoRoot: daemon.repo,
      intent: "fix the retry regression",
      title: "Retry regression",
      agent: "claude",
      kind: "bugfix",
      backlog: true,
    },
  });
  expect(created.ok()).toBe(true);
  expect(((await created.json()) as { workflowId: string | null }).workflowId).toBe(GENERAL_REVIEW);
});

test("returning a row to its built-in follows the built-in again", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/tasks`);
  await expect(kindRow(dashboard, "bugfix")).toBeEnabled();

  await chooseRow(dashboard, "bugfix", GENERAL_REVIEW);
  await chooseRow(dashboard, "bugfix", "__builtin");

  expect(await selectedLabel(kindRow(dashboard, "bugfix"))).toBe("Built-in default (Bug Fix Review)");
  const config = (await (await dashboard.request.get(`${daemon.baseURL}/api/workflows/config`)).json()) as {
    kindWorkflowDefaults: Record<string, string | null>;
  };
  expect(config.kindWorkflowDefaults).toEqual({});
});

test("the rows live under Settings -> Tasks and nowhere under Workflows", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  await expect(dashboard.getByRole("tab", { name: "Workflows", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("heading", { name: "Live delivery" })).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "Dispatch defaults" })).toHaveCount(0);
  await expect(dashboard.getByRole("combobox", { name: /^Default after-work Workflow for / })).toHaveCount(0);

  // Reached from the rail, in the Sessions group, by its own tab.
  const tasks = dashboard.getByRole("tab", { name: "Tasks", exact: true });
  await tasks.click();
  await expect(dashboard).toHaveURL(/#\/settings\/tasks$/);
  await expect(tasks).toHaveAttribute("aria-selected", "true");
  const card = dashboard.locator('[data-anchor="tasks/dispatch-defaults"]');
  await expect(card.getByRole("heading", { name: "Dispatch defaults" })).toBeVisible();
  await expect(kindRow(dashboard, "ship")).toBeEnabled();
  await expect(card.getByRole("combobox", { name: /^Default after-work Workflow for / })).toHaveCount(6);
  const head = dashboard.locator(".settings-panel-head");
  await expect(head.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(head.getByText("This machine", { exact: true })).toBeVisible();
  await shoot(dashboard.locator("main.settings-page"), "00-settings-tasks-category");
});

/**
 * Holds every GET of the workflow config until `release` is called, so a spec can act inside
 * the window where the Settings rows are not known yet.
 */
async function holdConfigReads(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workflows/config", async (route) => {
    if (route.request().method() === "GET") await gate;
    await route.continue();
  });
  return release;
}

async function setRows(daemon: { baseURL: string }, page: Page, rows: Record<string, string | null>): Promise<void> {
  const saved = await page.request.put(`${daemon.baseURL}/api/workflows/config`, {
    data: { liveEnabled: false, repoAllowlist: [], kindWorkflowDefaults: rows },
  });
  expect(saved.ok()).toBe(true);
}

test("a kind picked before the Settings rows load is corrected to the configured row", async ({
  dashboard,
  daemon,
}) => {
  await setRows(daemon, dashboard, { bugfix: GENERAL_REVIEW });
  const release = await holdConfigReads(dashboard);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  expect(await selectedLabel(afterWork)).toContain("loading");

  // Inside the window the rows are unknown, so only the built-in can be shown...
  await kind.selectOption("bugfix");
  await expect(afterWork).toHaveValue("builtin-workflow:bug-fix-review");
  await shoot(dialog, "03-dispatch-guess-while-rows-load");

  // ...and it is a guess, not the operator's choice: the real row replaces it on arrival.
  release();
  await expect(afterWork).toHaveValue(GENERAL_REVIEW);
  await shoot(dialog, "04-dispatch-corrected-to-configured-row");
});

test("a Workflow chosen by hand while the rows load is not replaced when they land", async ({
  dashboard,
  daemon,
}) => {
  await setRows(daemon, dashboard, { bugfix: GENERAL_REVIEW });
  const release = await holdConfigReads(dashboard);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });

  await kind.selectOption("bugfix");
  await afterWork.selectOption("__none");
  release();
  await expect.poll(() => selectedLabel(afterWork)).not.toContain("loading");
  await expect(afterWork).toHaveValue("__none");
});

/** Fill what a backlog save needs, and return the dialog's Kind and After work controls. */
async function openDispatch(page: Page, repo: string, intent: string) {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  return {
    dialog,
    kind: dialog.getByRole("combobox", { name: "Kind", exact: true }),
    afterWork: dialog.getByRole("combobox", { name: "After work", exact: true }),
  };
}

async function addToBacklog(page: Page, dialog: Locator, before?: () => void): Promise<{ workflowId: string | null }> {
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Add to backlog", exact: true }).click();
  before?.();
  const response = await created;
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { workflowId: string | null };
}

test("a guess carried through a second rowless kind is still corrected when the rows land", async ({
  dashboard,
  daemon,
}) => {
  await setRows(daemon, dashboard, { chat: GENERAL_REVIEW });
  const release = await holdConfigReads(dashboard);
  const { kind, afterWork } = await openDispatch(dashboard, daemon.repo, "talk it through");

  // Scout and chat both rest on None as built-ins, so the hop to chat changes nothing yet...
  await kind.selectOption("scout");
  await expect(afterWork).toHaveValue("__none");
  await kind.selectOption("chat");
  await expect(afterWork).toHaveValue("__none");

  // ...but chat's real row names a Workflow, and that is what arrives.
  release();
  await expect(afterWork).toHaveValue(GENERAL_REVIEW);
});

test("a task saved while the rows load is filed on the kind's real row, not the guess", async ({
  dashboard,
  daemon,
}) => {
  await setRows(daemon, dashboard, { bugfix: null });
  const release = await holdConfigReads(dashboard);
  const { dialog, kind, afterWork } = await openDispatch(dashboard, daemon.repo, "fix the flaky retry");

  await kind.selectOption("bugfix");
  await expect(afterWork).toHaveValue("builtin-workflow:bug-fix-review");
  const task = await addToBacklog(dashboard, dialog, release);
  expect(task.workflowId).toBe(null);
});

test("an explicit None on a plan survives a switch to local storage under a None plan row", async ({
  dashboard,
  daemon,
}) => {
  await setRows(daemon, dashboard, { plan: null });
  const { dialog, kind, afterWork } = await openDispatch(dashboard, daemon.repo, "plan the migration");
  await expect.poll(() => selectedLabel(afterWork)).not.toContain("loading");

  await kind.selectOption("plan");
  await afterWork.selectOption("__none");
  await dialog.getByRole("button", { name: /^Advanced/ }).click();
  const storage = dialog.getByRole("combobox", { name: "Plan storage", exact: true });
  await expect(storage).toBeEnabled();
  await storage.selectOption("local");
  await expect(afterWork).toHaveValue("__none");

  const task = await addToBacklog(dashboard, dialog);
  expect(task.workflowId).toBe(null);
});
