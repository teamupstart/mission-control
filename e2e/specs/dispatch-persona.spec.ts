import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { writeConductorProjects } from "../fixtures/conductor.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";
import type { Task } from "../../src/shared/types.ts";

/**
 * A Persona chosen under Dispatch > Advanced, end to end.
 *
 * The fold is offered for every kind, starts on No Persona, and a chosen Persona reaches the
 * launched agent as its standing instructions. Delivery is read from the session's launch
 * snapshot and its "See standing instructions" chip, for the reason
 * `settings-standing-instructions.spec.ts` gives: the Agent SDK carries `systemPrompt.append`
 * over stdin, so no recorded argv can see it, and the snapshot is written by the launch from
 * the very object it delivers. Every agent is a fake, so no model tokens are spent.
 */

const EVIDENCE = artifactsDir("dispatch-persona");
const NAME = "E2E Reviewer";
const DESCRIPTION = "Reads every diff as if it will be paged for it.";
const GUIDANCE = "# E2E Reviewer\n\nRead every diff as if you will be paged for it at 3am.";
const SECTION = `## Persona: ${NAME}\n\n${GUIDANCE}`;

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const path = `${EVIDENCE}${name}.png`;
  if (target) await target.screenshot({ path, animations: "disabled" });
  else await page.screenshot({ path, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/dispatch-persona/${name}.png`);
}

async function createPersona(daemon: DaemonHandle, name = NAME): Promise<string> {
  const response = await fetch(`${daemon.baseURL}/api/personas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, description: DESCRIPTION, guidanceMarkdown: GUIDANCE }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function openDispatch(page: Page, daemon: DaemonHandle, intent: string): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // RepoCombobox portals its list over the form; close it before reaching fields below.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  return dialog;
}

const advancedOf = (dialog: Locator) => dialog.getByRole("button", { name: /^Advanced/ });
const personaOf = (dialog: Locator) => dialog.getByRole("combobox", { name: "Persona", exact: true });

test("a Persona chosen under Advanced reaches the launched agent as standing instructions", async ({ dashboard: page, daemon }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const personaId = await createPersona(daemon);
  const dialog = await openDispatch(page, daemon, "Review the flexbox helper change");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const advanced = advancedOf(dialog);

  // Every kind the form can dispatch offers the fold, and every one starts on no Persona.
  for (const value of ["scout", "plan", "chat", "bugfix", "document", "ship"]) {
    await kind.selectOption(value);
    await expect(advanced, `${value} offers Advanced`).toBeVisible();
    await expect(advanced).toContainText("Persona: none");
  }
  await shoot(page, "01-advanced-collapsed", dialog);

  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  const persona = personaOf(dialog);
  await expect(persona).toHaveValue("");
  await expect(persona.locator("option:checked")).toHaveText("No Persona");
  await expect(dialog.getByText("The agent launches with no Persona.", { exact: true })).toBeVisible();
  await persona.selectOption({ label: NAME });
  await expect(persona).toHaveValue(personaId);
  await expect(dialog.getByText(DESCRIPTION, { exact: true })).toBeVisible();
  await expectContentClearsBorder(dialog);
  await shoot(page, "02-persona-selected", dialog);

  // Collapsing keeps the choice and names it.
  await advanced.click();
  await expect(persona).toBeHidden();
  await expect(advanced).toContainText(`Persona: ${NAME}`);

  // The form's forecast composes the Persona the way the launch will.
  const note = dialog.locator(".si-note");
  await expect(note).toContainText("Standing instructions will be sent.");
  await note.getByRole("button", { name: "view" }).click();
  await expect(note.locator(".si-delivery-text")).toHaveText(SECTION);
  await shoot(page, "03-forecast", dialog);
  await note.getByRole("button", { name: "hide" }).click();

  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const created = await posted;
  expect(created.ok(), await created.text()).toBe(true);
  expect(((await created.json()) as Task).personaId).toBe(personaId);
  await expect(dialog).toBeHidden();

  // What the launch actually sent, from the record a resume replays.
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as { id: string }[];
    sessionId = sessions[0]?.id ?? "";
    if (!sessionId) return null;
    const snapshot = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/standing-instructions`);
    return snapshot.ok ? ((await snapshot.json()) as { text: string; mechanism: string }) : null;
  }, { message: "the launch should record the Persona it delivered" }).toEqual(expect.objectContaining({
    text: SECTION,
    mechanism: "claude-sdk-system-prompt-append",
  }));

  // And the person can read it on the session itself.
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.getByRole("button", { name: "See standing instructions" }).click();
  const received = page.getByRole("dialog", { name: "Standing instructions this session received" });
  await expect(received.locator(".si-delivery-text")).toHaveText(SECTION);
  await expectContentClearsBorder(received);
  await shoot(page, "04-session-received", received);
});

test("a shelved task's Persona reads back in the editor and can be taken off", async ({ dashboard: page, daemon }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const personaId = await createPersona(daemon);
  const title = "Persona backlog task";
  const dialog = await openDispatch(page, daemon, "Review this later with a Persona");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("bugfix");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  await advancedOf(dialog).click();
  await personaOf(dialog).selectOption({ label: NAME });
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Add to backlog", exact: true }).click();
  const created = await posted;
  expect(created.ok(), await created.text()).toBe(true);
  const task = (await created.json()) as Task;
  expect(task.personaId).toBe(personaId);
  await expect(dialog).toBeHidden();

  const board = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(board.ok).toBe(true);
  await page.reload();
  await page.locator(".bl-card", { hasText: title }).getByRole("button", { name: title, exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit a backlog task" });
  const advanced = advancedOf(editor);
  await expect(advanced).toContainText(`Persona: ${NAME}`);
  await advanced.click();
  const persona = personaOf(editor);
  await expect(persona).toHaveValue(personaId);
  await expectContentClearsBorder(editor);
  await shoot(page, "05-editor-reads-back", editor);

  await persona.selectOption("");
  const updated = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/tasks/${task.id}/update`);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  const response = await updated;
  expect(response.ok(), await response.text()).toBe(true);
  expect(((await response.json()) as { task: Task }).task.personaId).toBeNull();
  await expect(editor).toBeHidden();

  await page.locator(".bl-card", { hasText: title }).getByRole("button", { name: title, exact: true }).click();
  await expect(advancedOf(editor)).toContainText("Persona: none");
});

test("a shelved task whose Persona was archived or deleted keeps it visible, refuses to launch, and clears", async ({ dashboard: page, daemon }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  const archivedId = await createPersona(daemon, "Archived Reviewer");
  const deletedId = await createPersona(daemon, "Deleted Reviewer");
  const shelve = async (title: string, personaId: string): Promise<Task> => {
    const response = await fetch(`${daemon.baseURL}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoRoot: daemon.repo, intent: `${title}, with its Persona`, title, kind: "ship",
        workflowId: null, backlog: true, personaId,
      }),
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return (await response.json()) as Task;
  };
  const archivedTask = await shelve("Task with an archived Persona", archivedId);
  const deletedTask = await shelve("Task with a deleted Persona", deletedId);

  // Archived through the Library's own route; deleted outright while the daemon is down, which
  // no route can do - the state a task meets when its Persona's row is gone.
  const archived = await fetch(`${daemon.baseURL}/api/personas/${archivedId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  expect(archived.ok, await archived.text()).toBe(true);
  const board = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(board.ok).toBe(true);
  await daemon.crash();
  withDaemonDb(daemon, (db) => db.prepare("DELETE FROM personas WHERE id = ?").run(deletedId));
  await daemon.restart();
  await page.reload();

  const editor = page.getByRole("dialog", { name: "Edit a backlog task" });
  const reopen = async (title: string) => {
    await page.locator(".bl-card", { hasText: title }).getByRole("button", { name: title, exact: true }).click();
    await expect(editor).toBeVisible();
  };
  const clearAndSave = async (task: Task) => {
    await personaOf(editor).selectOption("");
    await expect(editor.getByText("The agent launches with no Persona.", { exact: true })).toBeVisible();
    const updated = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/tasks/${task.id}/update`);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const response = await updated;
    expect(response.ok(), await response.text()).toBe(true);
    expect(((await response.json()) as { task: Task }).task.personaId).toBeNull();
    await expect(editor).toBeHidden();
    const stored = ((await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Task[])
      .find((candidate) => candidate.id === task.id);
    expect(stored?.personaId).toBeNull();
    await reopen(task.title);
    await expect(advancedOf(editor)).toContainText("Persona: none");
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
  };

  // Archived: still named, still selected, and the editor says it cannot launch.
  await reopen(archivedTask.title);
  await expect(advancedOf(editor)).toContainText("Persona: Archived Reviewer");
  await advancedOf(editor).click();
  const persona = personaOf(editor);
  await expect(persona).toHaveValue(archivedId);
  await expect(persona.locator("option:checked")).toHaveText("Archived Reviewer (Archived)");
  await expect(editor.getByText("Archived Reviewer is archived, so the task cannot launch with it. Choose another, or No Persona.", { exact: true }))
    .toBeVisible();
  await expectContentClearsBorder(editor);
  await shoot(page, "07-archived-persona-editor", editor);
  // Dispatch now is refused on the form, with the reason, and the task stays shelved.
  await editor.getByRole("button", { name: "Dispatch now" }).click();
  await expect(editor.locator(".dispatch-error"))
    .toContainText("the Persona Archived Reviewer is archived; choose another Persona, or none, under Advanced");
  await clearAndSave(archivedTask);

  // Deleted: kept as an unavailable choice rather than silently reading as No Persona.
  await reopen(deletedTask.title);
  await expect(advancedOf(editor)).toContainText("Persona: unavailable");
  await advancedOf(editor).click();
  await expect(persona).toHaveValue(deletedId);
  await expect(persona.locator("option:checked")).toHaveText("Unavailable Persona");
  await expect(editor.getByText("This Persona no longer exists, so the task cannot launch with it. Choose another, or No Persona.", { exact: true }))
    .toBeVisible();
  await shoot(page, "08-deleted-persona-editor", editor);
  await clearAndSave(deletedTask);
});

test.describe("a Pipeline task", () => {
  test.use({ daemonEnv: { MC_E2E_CONDUCTOR_ENGINEER_MODE: "supported" } });

  test("carries its Persona to the managed Engineer host", async ({ dashboard: page, daemon }) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    const personaId = await createPersona(daemon);
    writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
    const enabled = await fetch(`${daemon.baseURL}/api/pipelines/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        launchRuntime: "agent-sdk",
        foremanMechanicalTriage: false,
        repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
      }),
    });
    expect(enabled.ok, await enabled.text()).toBe(true);
    // A repository rule an ordinary dispatch would carry. A Pipeline launch never does, so the
    // preview must not promise it.
    const rule = "Never force-push from a pipeline worktree.";
    const view = (await (await fetch(`${daemon.baseURL}/api/instructions`)).json()) as { etag: string };
    const ruled = await fetch(`${daemon.baseURL}/api/instructions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedEtag: view.etag, default: "", repositories: { [daemon.repo]: rule } }),
    });
    expect(ruled.ok, await ruled.text()).toBe(true);

    const dialog = await openDispatch(page, daemon, "Plan the persona-aware pipeline");
    await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
    // Claude, because its Agent SDK channel is the one the fixture honors end to end; the fake
    // Codex reports its developer-instructions channel unusable and takes the turn-one fallback,
    // whose ordering `test/dispatch-persona.test.ts` pins.
    await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("claude");
    const advanced = advancedOf(dialog);
    await expect(advanced).toContainText("Persona: none");
    await advanced.click();
    const persona = personaOf(dialog);
    await expect(persona).toBeEnabled();
    await persona.selectOption({ label: NAME });
    await expect(dialog.getByText(`${DESCRIPTION} Only the managed Engineer host receives it; agents Conductor starts later do not, and the Terminal host refuses it.`, { exact: true }))
      .toBeVisible();
    await expectContentClearsBorder(dialog);
    await shoot(page, "06-pipeline-persona", dialog);

    // The preview is what the Engineer host will receive: the Persona alone, without the rule.
    const note = dialog.locator(".si-note");
    await note.getByRole("button", { name: "view" }).click();
    await expect(note.locator(".si-delivery-text")).toHaveText(SECTION);
    await expect(note).not.toContainText(rule);
    await shoot(page, "09-pipeline-forecast", dialog);
    await note.getByRole("button", { name: "hide" }).click();

    const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks");
    await dialog.getByRole("button", { name: "Dispatch now" }).click();
    const created = await posted;
    expect(created.ok(), await created.text()).toBe(true);
    const task = (await created.json()) as Task;
    expect(task.kind).toBe("pipeline");
    expect(task.personaId).toBe(personaId);
    await expect(dialog).toBeHidden();

    // The Engineer host's launch record carries the Persona, on Claude's system-prompt append.
    await expect.poll(async () => {
      const tasks = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Task[];
      const sessionId = tasks.find((candidate) => candidate.id === task.id)?.sessionId;
      if (!sessionId) return null;
      const snapshot = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sessionId)}/standing-instructions`);
      return snapshot.ok ? ((await snapshot.json()) as { text: string; mechanism: string }) : null;
    }, { message: "the managed Engineer host should record the Persona it was sent" }).toEqual(expect.objectContaining({
      text: SECTION,
      mechanism: "claude-sdk-system-prompt-append",
    }));
  });
});
