import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

// A resident profile that attaches a second repository beside its default one: authored on
// #/residents with + Add another repo, pre-filled in Dispatch > Resident, and launched as one
// resident session with a worktree in each repository. Every agent binary is the fake from
// `fixtures/fake-agents.ts`, so no model tokens are spent.

const PERSONA = "Code Risk Reviewer";
const PROFILE = "Contract Keeper";
const EVIDENCE = artifactsDir("residents-multi-repo");

async function capture(target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

interface ProfileRow {
  name: string;
  settings: { workspace: { defaultRepoRoot: string | null; additionalRepoRoots: string[] } };
}

interface TaskRow {
  id: string;
  kind: string;
  status: string;
  repoRoot: string;
  worktreePath: string | null;
  extraRepos: Array<{ repoRoot: string; worktreePath: string | null }>;
}

/** Author a profile whose default repository is `daemon.repo`, with `daemon.secondRepo` attached. */
async function authorMultiRepoProfile(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.goto(`${daemon.baseURL}/#/residents`);
  await page.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const editor = page.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Name").fill(PROFILE);
  await editor.getByRole("combobox", { name: "Persona" }).selectOption({ label: `${PERSONA} · built-in` });

  // Nothing to attach beside until there is a default repository.
  await expect(editor.getByRole("button", { name: "Add another repo" })).toHaveCount(0);
  // Each `Escape` closes the repo picker's portaled listbox before the next control is used.
  await editor.getByLabel("Default repository").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Add another repo" }).click();
  await editor.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Attach repo" }).click();
  await expect(editor.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` })).toBeVisible();
  await expect(editor).toContainText("Each launch gets one worktree per repo");
  await capture(editor.getByLabel("Default repository").locator("xpath=ancestor::div[contains(@class, 'field')][1]"), "profile-attached-repos");
  await editor.getByRole("button", { name: "Save" }).click();

  const saved = page.getByRole("region", { name: `Resident profile ${PROFILE}` });
  await expect(saved).toContainText("Revision 1");
  // Reseeded from the saved revision, the attachment is still drawn.
  await expect(saved.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` })).toBeVisible();
  const persisted = (await api<ProfileRow[]>(daemon, "/api/residents/profiles")).find((p) => p.name === PROFILE);
  expect(persisted?.settings.workspace).toEqual({ defaultRepoRoot: daemon.repo, additionalRepoRoots: [daemon.secondRepo] });
}

/** Open Dispatch > Resident on the profile from its page. */
async function openResidentDispatch(page: Page): Promise<Locator> {
  await page.getByRole("region", { name: `Resident profile ${PROFILE}` }).getByRole("button", { name: "Launch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog.getByRole("radio", { name: new RegExp(PROFILE) })).toHaveAttribute("aria-checked", "true");
  return dialog;
}

/** The resident task, once every repository it attached has a worktree recorded on it. */
async function provisionedResidentTask(daemon: DaemonHandle): Promise<TaskRow> {
  let task: TaskRow | undefined;
  await expect.poll(async () => {
    task = (await api<TaskRow[]>(daemon, "/api/tasks")).find((t) => t.kind === "resident");
    return Boolean(task && task.status === "running" && task.worktreePath && task.extraRepos.every((e) => e.worktreePath));
  }, { timeout: 60_000, message: "the resident runs with one worktree per repository" }).toBe(true);
  return task!;
}

test("a resident profile attaches a second repository, Dispatch pre-fills it, and the launch gets a worktree in each", async ({
  dashboard,
  daemon,
}) => {
  await authorMultiRepoProfile(dashboard, daemon);

  const dialog = await openResidentDispatch(dashboard);
  await expect(dialog.getByLabel("Repository")).toHaveValue(daemon.repo);
  await expect(dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` })).toBeVisible();
  await expect(dialog).toContainText("Each repo the resident changes gets its own pull request");
  await expectContentClearsBorder(dialog);
  await capture(dialog, "dispatch-resident-attached-repos");
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  const task = await provisionedResidentTask(daemon);
  expect(task.repoRoot).toBe(daemon.repo);
  expect(task.extraRepos.map((entry) => entry.repoRoot)).toEqual([daemon.secondRepo]);
  expect(task.extraRepos[0]!.worktreePath).not.toBe(task.worktreePath);
});

test("Dispatch > Resident can detach the profile's attached repository for one run, and No repository removes the control", async ({
  dashboard,
  daemon,
}) => {
  await authorMultiRepoProfile(dashboard, daemon);

  const dialog = await openResidentDispatch(dashboard);
  // A repository-free run has nothing to attach beside, so the control goes with the primary.
  await dialog.getByRole("button", { name: "No repository" }).click();
  await expect(dialog.getByRole("button", { name: "Add another repo" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` })).toHaveCount(0);
  await expect(dialog).toContainText("A private working directory is created for this run");

  // Choosing the repository again starts this run's own set, without the profile's attachment.
  await dialog.getByLabel("Repository").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await expect(dialog.getByRole("button", { name: "Add another repo" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  let task: TaskRow | undefined;
  await expect.poll(async () => {
    task = (await api<TaskRow[]>(daemon, "/api/tasks")).find((t) => t.kind === "resident");
    return task?.status ?? null;
  }, { timeout: 60_000 }).toBe("running");
  expect(task!.repoRoot).toBe(daemon.repo);
  expect(task!.extraRepos).toEqual([]);
  // The profile's own default is untouched by a one-run choice.
  const persisted = (await api<ProfileRow[]>(daemon, "/api/residents/profiles")).find((p) => p.name === PROFILE);
  expect(persisted?.settings.workspace.additionalRepoRoots).toEqual([daemon.secondRepo]);
});

test("the Residents dock's one-click Launch carries the profile's attached repository", async ({
  dashboard,
  daemon,
}) => {
  await authorMultiRepoProfile(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);

  const dockButton = dashboard.locator("header.topbar").getByRole("button", { name: /^Residents - \d+ live$/ });
  await dockButton.click();
  const dock = dashboard.getByRole("dialog", { name: "Residents" });
  const launch = dock.getByRole("button", { name: `Launch ${PROFILE}` });
  // A profile with a default repository launches straight away, not through Dispatch.
  await expect(launch).toHaveText("Launch");
  await launch.click();
  await expect(dock.getByRole("button", { name: `Open ${PROFILE}` })).toBeEnabled({ timeout: 60_000 });
  await capture(dock, "dock-launched");

  const task = await provisionedResidentTask(daemon);
  expect(task.repoRoot).toBe(daemon.repo);
  expect(task.extraRepos.map((entry) => entry.repoRoot)).toEqual([daemon.secondRepo]);
  expect(task.extraRepos[0]!.worktreePath).not.toBe(task.worktreePath);
});

test("Detach in Dispatch > Resident launches one run without the attachment and leaves the profile's default alone", async ({
  dashboard,
  daemon,
}) => {
  await authorMultiRepoProfile(dashboard, daemon);

  const dialog = await openResidentDispatch(dashboard);
  const detach = dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` });
  await expect(detach).toBeVisible();
  await detach.click();
  await expect(detach).toHaveCount(0);
  // The primary is untouched, and attaching another stays available.
  await expect(dialog.getByLabel("Repository")).toHaveValue(daemon.repo);
  await expect(dialog.getByRole("button", { name: "Add another repo" })).toBeVisible();
  await expect(dialog).not.toContainText("Each repo the resident changes gets its own pull request");
  await capture(dialog, "dispatch-resident-detached");
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  let task: TaskRow | undefined;
  await expect.poll(async () => {
    task = (await api<TaskRow[]>(daemon, "/api/tasks")).find((t) => t.kind === "resident");
    return task?.status ?? null;
  }, { timeout: 60_000 }).toBe("running");
  expect(task!.repoRoot).toBe(daemon.repo);
  expect(task!.extraRepos).toEqual([]);
  const persisted = (await api<ProfileRow[]>(daemon, "/api/residents/profiles")).find((p) => p.name === PROFILE);
  expect(persisted?.settings.workspace.additionalRepoRoots).toEqual([daemon.secondRepo]);
});

test("the attachment control stops at the shared cap of eight and Detach reopens it", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/residents`);
  await dashboard.getByRole("complementary", { name: "Resident profiles" }).getByRole("button", { name: "New" }).click();
  const editor = dashboard.getByRole("region", { name: "New resident profile" });
  await editor.getByLabel("Default repository").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  const add = editor.getByRole("button", { name: "Add another repo" });
  for (let index = 0; index < 8; index += 1) {
    await add.click();
    await editor.getByPlaceholder("repo to attach…").fill(`${daemon.repo}-extra-${index}`);
    await dashboard.keyboard.press("Escape");
    await editor.getByRole("button", { name: "Attach repo" }).click();
  }
  await expect(editor.getByRole("button", { name: /^Detach repo: / })).toHaveCount(8);
  // A ninth would only be refused on save or launch, so the control stops offering one.
  await expect(add).toBeDisabled();
  await editor.getByRole("button", { name: `Detach repo: ${daemon.repo}-extra-0` }).click();
  await expect(add).toBeEnabled();
});

test("Launch as a new resident after a lost answer launches the repository set it displayed, not a default edited since", async ({
  dashboard,
  daemon,
}) => {
  await authorMultiRepoProfile(dashboard, daemon);
  const dialog = await openResidentDispatch(dashboard);

  // The first launch never reaches the daemon: its answer is lost, so it stays outstanding.
  await dashboard.route("**/api/residents/profiles/*/launch", (route) => route.abort(), { times: 1 });
  await dialog.getByRole("button", { name: "Launch resident" }).click();
  await expect(dialog.getByRole("alert").filter({ hasNotText: "may already be running" })).toBeVisible();

  // Another window detaches the profile's attachment while this launch is outstanding.
  const stored = (await api<Array<ProfileRow & { id: string; revision: number; settings: Record<string, unknown> }>>(daemon, "/api/residents/profiles"))
    .find((p) => p.name === PROFILE)!;
  const edited = await fetch(`${daemon.baseURL}/api/residents/profiles/${stored.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedRevision: stored.revision,
      settings: { ...stored.settings, workspace: { defaultRepoRoot: daemon.repo, additionalRepoRoots: [] } },
    }),
  });
  expect(edited.status).toBe(200);
  await expect(dialog).toContainText(`revision ${stored.revision + 1}`);
  // The form still shows the set that was sent.
  await expect(dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` })).toBeVisible();

  // A changed request asks which to do; launching it separately sends what is on screen.
  await dialog.getByLabel("Instructions for this run").fill("A separate run.");
  await dialog.getByRole("button", { name: "Launch as a new resident" }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  const task = await provisionedResidentTask(daemon);
  expect(task.extraRepos.map((entry) => entry.repoRoot)).toEqual([daemon.secondRepo]);
  const persisted = (await api<ProfileRow[]>(daemon, "/api/residents/profiles")).find((p) => p.name === PROFILE);
  expect(persisted?.settings.workspace.additionalRepoRoots).toEqual([]);
});
