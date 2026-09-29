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
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: task.title }).click();
  return task;
}
async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  console.log(`CAPTURED e2e/.artifacts/task-worktree-return/${name}.png`);
}

test("Complete resets and returns both owned worktrees and the next dispatch reuses them", async ({ dashboard, daemon }) => {
  test.setTimeout(240_000);
  const first = await dispatch(dashboard, daemon, "Complete the multi repo return test", true);
  const paths = [first.worktreePath!, first.extraRepos[0]!.worktreePath!];
  for (const path of paths) writeFileSync(join(path, "remaining-local-work.md"), "Completion discards this after archiving.\n");
  await dashboard.locator(".console-detail").getByRole("button", { name: /^complete$/i }).click();
  const complete = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(complete).toContainText("worktrees are reset and returned");
  await expect(complete).toContainText("local changes are discarded");
  await expectContentClearsBorder(complete);
  await capture(dashboard, "complete-return-confirmation");
  await complete.getByRole("button", { name: "Complete & close" }).click();
  await expect(complete).toBeHidden({ timeout: 1500 });
  await expect.poll(() => taskFor(daemon, first.intent), { timeout: 120_000 }).toMatchObject({
    status: "done", worktreePath: null, worktreeLeaseId: null,
    extraRepos: [{ worktreePath: null, worktreeLeaseId: null }],
  });
  for (const path of paths) {
    expect(slotState(daemon, path)).toBe("available");
    expect(existsSync(join(path, "remaining-local-work.md"))).toBe(false);
  }
  const reused = await dispatch(dashboard, daemon, "Reuse the completed task slots", true);
  expect([reused.worktreePath, reused.extraRepos[0]?.worktreePath]).toEqual(paths);
  expect(reused.worktreeLeaseId).not.toBe(first.worktreeLeaseId);
  await capture(dashboard, "completed-slots-reused");
  console.log("OBSERVED Complete reset both repositories, returned their leases, and a new task reused both slots");
});

test("Reset retains its checkout and a later safe Kill returns it automatically", async ({ dashboard, daemon }) => {
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
  await dashboard.locator(".console-detail").getByRole("button", { name: /kill$/i }).click();
  const kill = dashboard.getByRole("dialog", { name: "Kill session" });
  await expect(kill).toContainText("all are clean, published to origin, and unused");
  await expect(kill).toContainText("automatically after 30 days");
  await expectContentClearsBorder(kill);
  await capture(dashboard, "safe-kill-confirmation");
  await kill.getByRole("button", { name: "Kill", exact: true }).click();
  await expect(kill).toBeHidden();
  await expect.poll(() => taskFor(daemon, first.intent), { timeout: 120_000 }).toMatchObject({ status: "cancelled", worktreePath: null, worktreeLeaseId: null });
  expect(slotState(daemon, first.worktreePath!)).toBe("available");
  const reused = await dispatch(dashboard, daemon, "Reuse the reset and killed slot");
  expect(reused.worktreePath).toBe(first.worktreePath);
  console.log("OBSERVED Reset kept the lease; subsequent clean Kill returned it and dispatch reused it");
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
  await expect.poll(() => daemon.readLog(), { timeout: 60_000 }).toContain(
    `"taskId":"${first.id}","reason":"kill","outcome":"retained","detail":"checkout has uncommitted, untracked or ignored work"`,
  );
  expect(await taskFor(daemon, first.intent)).toMatchObject({
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

test("Shipping explains that owned completion always returns worktrees", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  await expect(dashboard.getByText("Completed tasks with owned worktrees always close their sessions", { exact: false })).toBeVisible();
  await expect(dashboard.getByRole("checkbox", { name: "Close assigned sessions after their pull requests merge" })).toBeVisible();
  await dashboard.getByText("Keep the assigned agent available with its checkout and conversation context.", { exact: true }).scrollIntoViewIfNeeded();
  await capture(dashboard, "shipping-return-policy");
});
