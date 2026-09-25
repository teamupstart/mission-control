import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Task } from "../../src/shared/types.ts";

/**
 * What is at stake: a dispatched task an operator wants to run LATER had no way back to the
 * backlog (issue #1115). Kill settled it `failed`, and Sitrep then offered only Clean up and
 * Retry, neither of which re-files it; Reschedule existed but only surfaced on a dependent's
 * dead-blocker warning, which a task nothing waits on never has.
 *
 * Two doors now, and each is driven end to end against the real daemon and the fake agents:
 * the session footer's **backlog** control for a live task, and **Reschedule** on a stopped
 * task's own Recent outcomes row. Both must put the task back at the rank it had, which is
 * why each files a second task behind it and reads the order afterwards.
 */

const EVIDENCE = artifactsDir("task-return-to-backlog");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: a resting pointer portals a tooltip over the row being shot.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function file(daemon: DaemonHandle, title: string): Promise<Task> {
  return api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title,
    intent: title,
    backlog: true,
    workflowId: null,
  });
}

async function taskById(daemon: DaemonHandle, id: string): Promise<Task> {
  const found = (await api<Task[]>(daemon, "/api/tasks")).find((t) => t.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
}

/** Open the Sitrep panel, re-pressing until the fleet-scoped chord is actually bound. */
async function openSitrep(page: Page): Promise<Locator> {
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    await page.keyboard.press("Shift+P");
    await expect(page.getByRole("dialog", { name: "Sitrep" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  return page.getByRole("dialog", { name: "Sitrep" });
}

function sitrepSection(sitrep: Locator, title: RegExp): Locator {
  return sitrep.locator("section.report-section", {
    has: sitrep.page().locator("h3.report-section-title", { hasText: title }),
  });
}

test("an idle dispatched task returns to the backlog from its session footer", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  const first = await file(daemon, "Requeue me from the footer");
  const second = await file(daemon, "Stay behind the requeued task");
  const rankBefore = (await taskById(daemon, first.id)).backlogRank!;
  expect(rankBefore).toBeLessThan((await taskById(daemon, second.id)).backlogRank!);

  await api(daemon, `/api/tasks/${first.id}/dispatch`, {});
  const row = dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row", { hasText: first.title });
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await row.click();

  const detail = dashboard.locator(".console-detail");
  await expect(detail.locator("span.badge").first()).toHaveText("idle", { timeout: 60_000 });

  // The footer after this change: Backlog joins it, and Diff and Interrupt are gone from it
  // (the Diff tab and ⌃C remain).
  const footer = detail.locator(".actions");
  const backlog = footer.getByRole("button", { name: "backlog", exact: true });
  await expect(backlog).toBeEnabled();
  await expect(footer.getByRole("button", { name: /^interrupt/ })).toHaveCount(0);
  await expect(footer.getByRole("button", { name: "diff", exact: true })).toHaveCount(0);
  await expect(footer.getByRole("button", { name: "kill", exact: true })).toBeVisible();
  await shoot(dashboard, "footer-with-backlog");

  await backlog.click();
  const dialog = dashboard.getByRole("dialog", { name: "Return to backlog" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  await expect(dialog).toContainText(first.title);
  await expect(dialog).toContainText("Uncommitted and unpushed work in it is deleted");
  await shoot(dashboard, "return-to-backlog-confirm");

  // Cancel leaves everything where it was.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await taskById(daemon, first.id)).status).toBe("running");

  // `b` reaches the same confirm as the button.
  await dashboard.keyboard.press("b");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Return to backlog", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });

  // The agent Mission Control launched is stopped, so its session leaves the fleet...
  await expect(row).toHaveCount(0, { timeout: 60_000 });
  // ...and the task is a clean backlog row again, at the rank it had before dispatch.
  const back = await taskById(daemon, first.id);
  expect(back.status).toBe("backlog");
  expect(back.enabled).toBe(true);
  expect(back.sessionId).toBeNull();
  expect(back.backlogRank).toBe(rankBefore);

  const sitrep = await openSitrep(dashboard);
  const queued = sitrepSection(sitrep, /^Backlog\b/);
  await expect(queued).toContainText(first.title);
  const text = (await queued.textContent()) ?? "";
  expect(text.indexOf(first.title)).toBeLessThan(text.indexOf(second.title));
  await expect(sitrepSection(sitrep, /^Recent outcomes\b/)).not.toContainText(first.title);
  await shoot(dashboard, "requeued-in-sitrep-backlog");
});

test("a stopped task with nothing waiting on it is rescheduled from its own Sitrep row", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  const stopped = await file(daemon, "Cancelled with nothing waiting");
  const behind = await file(daemon, "Filed after the cancelled task");
  const rankBefore = (await taskById(daemon, stopped.id)).backlogRank!;
  await api(daemon, `/api/tasks/${stopped.id}/cancel`, {});
  expect((await taskById(daemon, stopped.id)).status).toBe("cancelled");

  const sitrep = await openSitrep(dashboard);
  await expectContentClearsBorder(sitrep);
  const recent = sitrepSection(sitrep, /^Recent outcomes\b/);
  const row = recent.locator(".report-row", { hasText: stopped.title });
  await expect(row).toContainText("cancelled");

  await row.getByRole("button", { name: "Reschedule", exact: true }).click();
  // Nothing to remove on a cancel that already reclaimed its tree, so the prompt does not
  // warn about a checkout that is not there.
  await expect(row).toContainText("back to backlog?");
  await expect(row).not.toContainText("removes its checkout");
  await shoot(dashboard, "reschedule-confirm");
  // Backing out of the confirm changes nothing.
  await row.getByRole("button", { name: "✕", exact: true }).click();
  await expect(row).not.toContainText("back to backlog?");
  expect((await taskById(daemon, stopped.id)).status).toBe("cancelled");

  await row.getByRole("button", { name: "Reschedule", exact: true }).click();
  await row.getByRole("button", { name: "Reschedule", exact: true }).click();

  await expect.poll(async () => (await taskById(daemon, stopped.id)).status).toBe("backlog");
  expect((await taskById(daemon, stopped.id)).backlogRank).toBe(rankBefore);
  await expect(recent).not.toContainText(stopped.title);
  const queued = sitrepSection(sitrep, /^Backlog\b/);
  await expect(queued).toContainText(stopped.title);
  const text = (await queued.textContent()) ?? "";
  expect(text.indexOf(stopped.title)).toBeLessThan(text.indexOf(behind.title));
  await shoot(dashboard, "rescheduled-in-sitrep-backlog");
});
