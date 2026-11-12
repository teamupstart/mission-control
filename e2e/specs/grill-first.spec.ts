import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("grill-first");

/** A frame of the state just asserted, behind `MC_E2E_EVIDENCE` so ordinary runs write nothing. */
async function shoot(page: Page, target: Locator, name: string, keepPointer = false): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first, unless the frame is of the tooltip the pointer opened.
  if (!keepPointer) await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
}

/**
 * Grill me first, for every task kind this app launches: one default per kind on Settings -> Tasks, all
 * off, and an override on the dispatch form and in the backlog editor, each described by its
 * "i". The interview itself is the Library's built-in Grill session action, which is edited in
 * place and reset to its shipped text.
 *
 * Every task here is added to the backlog, never launched, so no agent runs and nothing spends
 * model tokens.
 */

const GRILL_ID = "builtin:grill";
const TIP = /runs the Library's Grill action/;

interface TaskRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  grillFirst?: boolean;
}

async function storedTask(daemon: DaemonHandle, page: Page, title: string): Promise<TaskRow> {
  const rows = (await (await page.request.get(`${daemon.baseURL}/api/tasks`)).json()) as TaskRow[];
  const row = rows.find((task) => task.title === title);
  expect(row, `a task titled ${title}`).toBeTruthy();
  return row!;
}

async function setDefaults(daemon: DaemonHandle, page: Page, grillFirstKinds: string[]): Promise<void> {
  const saved = await page.request.put(`${daemon.baseURL}/api/skills/config`, { data: { grillFirstKinds } });
  expect(saved.ok()).toBe(true);
}

function grillBox(scope: Locator | Page): Locator {
  return scope.getByRole("checkbox", { name: "Grill me first", exact: true });
}

function kindBox(page: Page, kind: string): Locator {
  return page.getByRole("checkbox", { name: `Grill me first for ${kind} tasks`, exact: true });
}

/** Open the dispatch form on this repo with an intent and an explicit title. */
async function openDispatch(page: Page, daemon: DaemonHandle, title: string): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form. Close it before reaching fields below.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Work out how archive exports should behave.");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  return dialog;
}

/** Add the open form's task to the backlog and wait for the daemon to accept it. */
async function addToBacklog(page: Page, dialog: Locator): Promise<void> {
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Add to backlog" }).click();
  expect((await created).ok()).toBe(true);
  await expect(dialog).toBeHidden();
}

test("each kind's default is chosen on Settings -> Tasks, all off until then, and survives a reload", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/tasks`);
  // Each kind's own section holds its box; Conductor launches pipeline, so it has none.
  for (const kind of ["ship", "bugfix", "document", "plan", "scout", "chat"]) {
    const box = dashboard.locator(`[data-anchor="tasks/kind-${kind}"]`)
      .getByRole("checkbox", { name: `Grill me first for ${kind} tasks`, exact: true });
    await expect(box).toBeEnabled();
    await expect(box).not.toBeChecked();
  }
  await expect(dashboard.locator('[data-anchor="tasks/kind-pipeline"]')).toHaveCount(0);
  await expect(kindBox(dashboard, "pipeline")).toHaveCount(0);
  const card = dashboard.locator('[data-anchor="tasks/kind-plan"]');
  // What it does is the "i"'s tooltip.
  const info = card.getByRole("button", { name: "About Grill me first" });
  await expect(info).toHaveAccessibleDescription(TIP);
  await info.hover();
  await expect(dashboard.getByText("Before it starts the work, the agent runs the Library's Grill action", { exact: false }).first())
    .toBeVisible();

  for (const kind of ["plan", "bugfix"]) {
    const saved = dashboard.waitForResponse((response) =>
      response.url().endsWith("/api/skills/config") && response.request().method() === "PUT");
    await kindBox(dashboard, kind).check();
    expect((await saved).ok()).toBe(true);
  }

  // Durable, not just drawn: a reload reads the boxes back from the daemon.
  await dashboard.reload();
  await expect(kindBox(dashboard, "plan")).toBeChecked();
  await expect(kindBox(dashboard, "bugfix")).toBeChecked();
  await expect(kindBox(dashboard, "ship")).not.toBeChecked();
  const skills = (await (await dashboard.request.get(`${daemon.baseURL}/api/skills`)).json()) as {
    grillFirstKinds: string[];
  };
  expect(skills.grillFirstKinds.sort()).toEqual(["bugfix", "plan"]);
  await shoot(dashboard, dashboard.locator("main.settings-page"), "01-settings-per-kind");
});

test("the dispatch form offers it for every kind, follows each kind's default, and pins the choice", async ({
  dashboard,
  daemon,
}) => {
  await setDefaults(daemon, dashboard, ["bugfix"]);

  let dialog = await openDispatch(dashboard, daemon, "Ship, grilled by hand");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  // Ship's default is off; the description sits on the "i" beside the box, not under it.
  await expect(grillBox(dialog)).toBeVisible();
  await expect(grillBox(dialog)).not.toBeChecked();
  const info = dialog.getByRole("button", { name: "About Grill me first" });
  await expect(info).toHaveAccessibleDescription(TIP);
  await shoot(dashboard, dialog, "02-dispatch-ship-default-off");
  await info.hover();
  await expect(dashboard.getByText("Before it starts the work, the agent runs the Library's Grill action", { exact: false }).first())
    .toBeVisible();
  await shoot(dashboard, dashboard.locator("body"), "02b-dispatch-info-tooltip", true);
  await dashboard.mouse.move(0, 0);
  await kind.selectOption("bugfix");
  await expect(grillBox(dialog)).toBeChecked();
  for (const other of ["document", "plan", "scout", "chat"]) {
    await kind.selectOption(other);
    await expect(grillBox(dialog), `${other} offers it`).toBeVisible();
    await expect(grillBox(dialog), `${other}'s default is off`).not.toBeChecked();
  }
  await kind.selectOption("ship");
  await grillBox(dialog).check();
  await addToBacklog(dashboard, dialog);
  expect(await storedTask(daemon, dashboard, "Ship, grilled by hand")).toMatchObject({ kind: "ship", grillFirst: true });

  // Overriding a kind whose default is on, for one task, leaves the default alone.
  dialog = await openDispatch(dashboard, daemon, "Bug fix, straight");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("bugfix");
  await expect(grillBox(dialog)).toBeChecked();
  await grillBox(dialog).uncheck();
  await shoot(dashboard, dialog, "03-dispatch-bugfix-override-off");
  await addToBacklog(dashboard, dialog);
  expect((await storedTask(daemon, dashboard, "Bug fix, straight")).grillFirst).toBe(false);

  // Untouched, the task takes its kind's default.
  dialog = await openDispatch(dashboard, daemon, "Bug fix, by default");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("bugfix");
  await addToBacklog(dashboard, dialog);
  expect((await storedTask(daemon, dashboard, "Bug fix, by default")).grillFirst).toBe(true);
});

test("the backlog editor reads a task's pin back, keeps it on a switch into plan, and saves it", async ({
  dashboard,
  daemon,
}) => {
  await setDefaults(daemon, dashboard, ["plan"]);
  const create = async (title: string, kind: string, grillFirst?: boolean): Promise<TaskRow> => {
    const created = await dashboard.request.post(`${daemon.baseURL}/api/tasks`, {
      data: { repoRoot: daemon.repo, intent: "Work out the export format.", title, kind, grillFirst, backlog: true },
    });
    expect(created.ok()).toBe(true);
    return (await created.json()) as TaskRow;
  };
  const scout = await create("Scout, grilled", "scout", true);
  const doc = await create("Document becomes a plan", "document", false);

  const layout = await dashboard.request.put(`${daemon.baseURL}/api/ui/config`, { data: { layout: "board" } });
  expect(layout.ok()).toBe(true);
  await dashboard.reload();
  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  const save = async (id: string): Promise<Record<string, unknown>> => {
    const saved = dashboard.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/tasks/${id}/update`);
    await editor.getByRole("button", { name: "Save" }).click();
    const response = await saved;
    expect(response.ok()).toBe(true);
    await expect(editor).toBeHidden();
    return JSON.parse(response.request().postData() ?? "{}") as Record<string, unknown>;
  };

  await dashboard.locator(".bl-card", { hasText: "Scout, grilled" })
    .getByRole("button", { name: "Scout, grilled", exact: true }).click();
  await expect(grillBox(editor)).toBeChecked();
  await grillBox(editor).uncheck();
  expect(await save(scout.id)).toEqual({ grillFirst: false });
  expect((await storedTask(daemon, dashboard, "Scout, grilled")).grillFirst).toBe(false);

  // Between two kinds that offer it the pin goes with the task, so an explicit off stays off
  // although plan's default is on, and the switch alone sends no pin.
  await dashboard.locator(".bl-card", { hasText: "Document becomes a plan" })
    .getByRole("button", { name: "Document becomes a plan", exact: true }).click();
  await expect(grillBox(editor)).not.toBeChecked();
  await editor.getByRole("combobox", { name: "Kind", exact: true }).selectOption("plan");
  await expect(grillBox(editor)).not.toBeChecked();
  await shoot(dashboard, editor, "04-editor-document-into-plan");
  const switched = await save(doc.id);
  expect(switched).toMatchObject({ kind: "plan" });
  expect(switched).not.toHaveProperty("grillFirst");
  expect(await storedTask(daemon, dashboard, "Document becomes a plan")).toMatchObject({ kind: "plan", grillFirst: false });

  // Choosing it on the plan is the answer the daemon stores.
  await dashboard.locator(".bl-card", { hasText: "Document becomes a plan" })
    .getByRole("button", { name: "Document becomes a plan", exact: true }).click();
  await grillBox(editor).check();
  expect(await save(doc.id)).toEqual({ grillFirst: true });
  expect(await storedTask(daemon, dashboard, "Document becomes a plan")).toMatchObject({ kind: "plan", grillFirst: true });
});

test("the dispatch form claims no answer until it knows the default", async ({ dashboard, daemon }) => {
  await setDefaults(daemon, dashboard, ["ship"]);
  // A draft, kept by the dispatch surface across a close.
  let dialog = await openDispatch(dashboard, daemon, "Ship, waiting");
  await expect(grillBox(dialog)).toBeChecked();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Reopened with the Skills read held: the box is indeterminate and cannot be used yet.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await dashboard.route("**/api/skills", async (route) => {
    if (route.request().method() === "GET") await gate;
    await route.continue();
  });
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(grillBox(dialog)).toBeDisabled();
  await expect(grillBox(dialog)).toBeChecked({ indeterminate: true });
  await expect(dialog.getByRole("button", { name: "About Grill me first" }))
    .toHaveAccessibleDescription(/Reading this kind's default from Settings → Tasks/);
  release();
  await expect(grillBox(dialog)).toBeEnabled();
  await expect(grillBox(dialog)).toBeChecked();
  await dashboard.unroute("**/api/skills");
});

test("a default that cannot be read is said so, and the box still chooses for the task", async ({ dashboard, daemon }) => {
  await dashboard.route("**/api/skills", (route) =>
    route.request().method() === "GET" ? route.fulfill({ status: 500, body: "unavailable" }) : route.continue());
  const dialog = await openDispatch(dashboard, daemon, "Ship, unread default");
  await expect(grillBox(dialog)).toBeEnabled();
  await expect(grillBox(dialog)).toBeChecked({ indeterminate: true });
  await expect(dialog.getByRole("button", { name: "About Grill me first" }))
    .toHaveAccessibleDescription(/default could not be read/);

  await grillBox(dialog).check();
  await expect(grillBox(dialog)).toBeChecked();
  await grillBox(dialog).uncheck();
  await addToBacklog(dashboard, dialog);
  expect((await storedTask(daemon, dashboard, "Ship, unread default")).grillFirst).toBe(false);
});

test("the built-in Grill action is edited in place in the Library and reset to its shipped text", async ({
  dashboard,
  daemon,
}) => {
  const shipped = (await (await dashboard.request.get(`${daemon.baseURL}/api/session-actions/${GRILL_ID}`)).json()) as {
    promptMarkdown: string;
    revision: number;
  };
  await dashboard.goto(`${daemon.baseURL}/#/library/actions/${encodeURIComponent(GRILL_ID)}`);
  const name = dashboard.locator("section.wf-action-fields").getByLabel("Name");
  await expect(name).toHaveValue("Grill");
  // Its contract stays shipped: the name is read-only, while the instruction is the operator's.
  await expect(name).not.toBeEditable();
  await expect(dashboard.getByText("Built-in, editable", { exact: false })).toBeVisible();
  const save = dashboard.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(dashboard.getByRole("button", { name: "Duplicate to edit" })).toHaveCount(0);

  const promptEditor = dashboard.locator(".wf-action-editor-host .cm-content");
  await promptEditor.click();
  await dashboard.keyboard.press("ControlOrMeta+End");
  await promptEditor.pressSequentially("- Ask about rollout risk in the first round.");
  const patched = dashboard.waitForResponse((response) =>
    response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/session-actions/${GRILL_ID}`);
  await save.click();
  expect((await patched).ok()).toBe(true);
  await expect(dashboard.locator(".lib-tag", { hasText: "edited" })).toBeVisible();
  await expect(dashboard.getByText("Built-in, edited", { exact: false })).toBeVisible();
  await shoot(dashboard, dashboard.locator("article.wf-action-editor"), "05-library-grill-edited");

  // Durable: the daemon holds the edit, and a reload shows it.
  const edited = (await (await dashboard.request.get(`${daemon.baseURL}/api/session-actions/${GRILL_ID}`)).json()) as {
    promptMarkdown: string;
    customized?: boolean;
    revision: number;
  };
  expect(edited.customized).toBe(true);
  expect(edited.promptMarkdown).toContain("Ask about rollout risk in the first round.");
  expect(edited.revision).toBe(shipped.revision + 1);
  await dashboard.reload();
  await expect(dashboard.locator(".lib-tag", { hasText: "edited" })).toBeVisible();

  // Reset to built-in, from the menu, behind a confirm.
  await dashboard.getByRole("button", { name: "More session action options" }).click();
  await dashboard.getByRole("menu", { name: "More session action options" })
    .getByRole("menuitem", { name: "Reset to built-in" }).click();
  const confirm = dashboard.getByRole("dialog", { name: "Reset Grill" });
  const reset = dashboard.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/session-actions/${GRILL_ID}/reset`);
  await confirm.getByRole("button", { name: "Reset to built-in" }).click();
  expect((await reset).ok()).toBe(true);
  await expect(dashboard.locator(".lib-tag", { hasText: "edited" })).toHaveCount(0);
  await expect(dashboard.getByText("Built-in, editable", { exact: false })).toBeVisible();
  const restored = (await (await dashboard.request.get(`${daemon.baseURL}/api/session-actions/${GRILL_ID}`)).json()) as {
    promptMarkdown: string;
    customized?: boolean;
  };
  expect(restored.promptMarkdown).toBe(shipped.promptMarkdown);
  expect(restored.customized).toBeUndefined();
});
