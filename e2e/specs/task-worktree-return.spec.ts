import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("task-worktree-return");
test.afterEach(async ({ daemon }, info) => {
  if (info.status !== info.expectedStatus) console.log(daemon.readLog());
});
interface TaskRow {
  id: string; title: string; intent: string; status: string; sessionId: string | null;
  worktreePath: string | null; worktreeLeaseId: string | null;
  extraRepos: Array<{ worktreePath: string | null; worktreeLeaseId: string | null }>;
}
async function taskFor(daemon: DaemonHandle, intent: string): Promise<TaskRow | undefined> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  return ((await response.json()) as TaskRow[]).find((task) => task.intent === intent);
}
function slotState(daemon: DaemonHandle, path: string): string | undefined {
  return withDaemonDb(daemon, (db) => (db.prepare("SELECT state FROM worktree_slots WHERE path = ?").get(path) as { state: string } | undefined)?.state);
}
async function dispatch(page: Page, daemon: DaemonHandle, intent: string, multi = false): Promise<TaskRow> {
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  if (multi) {
    await dialog.getByRole("button", { name: "Add another repo" }).click();
    await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Attach repo" }).click();
  }
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => taskFor(daemon, intent), { timeout: 45_000 }).toMatchObject({ status: "running", worktreePath: expect.any(String) });
  const task = (await taskFor(daemon, intent))!;
  const row = page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: task.title });
  // A running task can still be launching its first turn. Act on its settled session,
  // rather than selecting a startup row before native identity/SSE binding finishes.
  await expect(row.locator(".rail-state")).toHaveText("idle", { timeout: 45_000 });
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".console-detail")).toBeVisible();
  return task;
}
async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  console.log(`CAPTURED e2e/.artifacts/task-worktree-return/${name}.png`);
}

test("Complete closes the session and retains both owned worktrees and their local changes", async ({ dashboard, daemon }) => {
  test.setTimeout(240_000);
  const first = await dispatch(dashboard, daemon, "Complete the multi repo return test", true);
  const paths = [first.worktreePath!, first.extraRepos[0]!.worktreePath!];
  for (const path of paths) writeFileSync(join(path, "remaining-local-work.md"), "Keep this work through completion.\n");
  await dashboard.locator(".console-detail").getByRole("button", { name: /^complete$/i }).click();
  const complete = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(complete).toContainText("Task-owned worktrees and their local changes stay in place.");
  await expect(complete).toContainText("The retention window starts when the last tracked session using the worktrees leaves.");
  await expect(complete).toContainText("Automatic cleanup requires clean worktrees with commits published to origin.");
  await expectContentClearsBorder(complete);
  await capture(dashboard, "complete-return-confirmation");
  await complete.getByRole("button", { name: "Complete & close" }).click();
  await expect(complete).toBeHidden({ timeout: 1500 });
  await expect.poll(() => taskFor(daemon, first.intent), { timeout: 120_000 }).toMatchObject({
    status: "done", worktreePath: first.worktreePath, worktreeLeaseId: first.worktreeLeaseId,
    extraRepos: [{ worktreePath: paths[1], worktreeLeaseId: first.extraRepos[0]!.worktreeLeaseId }],
  });
  for (const path of paths) {
    expect(slotState(daemon, path)).toBe("leased");
    expect(readFileSync(join(path, "remaining-local-work.md"), "utf8")).toBe("Keep this work through completion.\n");
  }
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: first.title })).toHaveCount(0);
  await capture(dashboard, "completed-slots-retained");
});

test("Reset and a later clean Kill both retain the checkout", async ({ dashboard, daemon }) => {
  test.setTimeout(180_000);
  const first = await dispatch(dashboard, daemon, "Reset then kill the clean task");
  writeFileSync(join(first.worktreePath!, "discard-on-reset.md"), "Reset removes this.\n");
  await dashboard.locator(".console-detail").getByRole("button", { name: /reset/ }).click();
  const reset = dashboard.getByRole("dialog", { name: "Reset session to origin" });
  await expectContentClearsBorder(reset);
  await reset.getByRole("button", { name: "Reset & clear" }).click();
  await expect(reset).toBeHidden();
  await expect.poll(() => taskFor(daemon, first.intent)).toMatchObject({ status: "cancelled", sessionId: null, worktreePath: first.worktreePath });
  expect(slotState(daemon, first.worktreePath!)).toBe("leased");
  expect(existsSync(join(first.worktreePath!, "discard-on-reset.md"))).toBe(false);
  await dashboard.locator(".console-detail").getByRole("button", { name: /kill$/i }).click();
  const kill = dashboard.getByRole("dialog", { name: "Kill session" });
  await expect(kill).toContainText("all are clean, published to origin, and unused");
  await expect(kill).toContainText("automatically after the configured retention window");
  await expectContentClearsBorder(kill);
  await capture(dashboard, "safe-kill-confirmation");
  await kill.getByRole("button", { name: "Kill", exact: true }).click();
  await expect(kill).toBeHidden();
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: first.title })).toHaveCount(0);
  expect(await taskFor(daemon, first.intent)).toMatchObject({
    status: "cancelled", worktreePath: first.worktreePath, worktreeLeaseId: first.worktreeLeaseId,
  });
  expect(slotState(daemon, first.worktreePath!)).toBe("leased");
});

test("Kill retains ignored local work and leaves manual cleanup available", async ({ dashboard, daemon }) => {
  const first = await dispatch(dashboard, daemon, "Preserve ignored notes on Kill");
  const path = first.worktreePath!;
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  const exclude = git("rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  appendFileSync(exclude, "\nprivate-notes.txt\n");
  writeFileSync(join(path, "private-notes.txt"), "Keep these ignored notes.\n");
  expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
  await dashboard.locator(".console-detail").getByRole("button", { name: /^kill$/i }).click();
  const kill = dashboard.getByRole("dialog", { name: "Kill session" });
  await expectContentClearsBorder(kill);
  await kill.getByRole("button", { name: "Kill", exact: true }).click();
  await expect(kill).toBeHidden();
  await expect(dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: first.title })).toHaveCount(0);
  await expect.poll(() => taskFor(daemon, first.intent)).toMatchObject({
    status: "failed", worktreePath: path, worktreeLeaseId: first.worktreeLeaseId,
  });
  expect(slotState(daemon, path)).toBe("leased");
  expect(readFileSync(join(path, "private-notes.txt"), "utf8")).toBe("Keep these ignored notes.\n");
  await expect(async () => {
    await dashboard.keyboard.press("Shift+P");
    await expect(dashboard.getByRole("dialog", { name: "Sitrep" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expectContentClearsBorder(sitrep);
  await expect(sitrep.locator(".report-row", { hasText: first.title }).getByRole("button", { name: "Clean up" })).toBeVisible();
  await capture(dashboard, "ignored-work-retained");
  console.log("OBSERVED Kill preserved ignored notes, retained the lease, and kept manual cleanup available");
});

test("Shipping explains that owned completion always closes its session", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  await expect(dashboard.getByText("Completed tasks with owned worktrees always close their sessions", { exact: false })).toBeVisible();
  await expect(dashboard.getByRole("checkbox", { name: "Close assigned sessions after their pull requests merge" })).toBeVisible();
  await dashboard.getByText("Keep the assigned agent available with its checkout and conversation context.", { exact: true }).scrollIntoViewIfNeeded();
  await capture(dashboard, "shipping-return-policy");
});
