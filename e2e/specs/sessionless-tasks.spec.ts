import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../../src/shared/types.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { test, expect } from "../fixtures/test.ts";

async function createTask(daemon: DaemonHandle, title: string): Promise<Task> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title, intent: title, backlog: true,
      agent: "codex", workflowId: null, enabled: false }),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function tasks(daemon: DaemonHandle): Promise<Task[]> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  expect(response.ok).toBe(true);
  return response.json();
}

test("Sitrep exposes a running task without a session and cancels it through the daemon", async ({ dashboard, daemon }) => {
  const task = await createTask(daemon, "Recover sessionless work");
  await daemon.shutdown();
  // Provider-owned work can legitimately remain running without an agent. Keep that
  // startup exception real so this tests the fallback UI against a real running row,
  // rather than racing automatic orphan settlement or mocking a cancellation response.
  withDaemonDb(daemon, (db) => db.prepare(
    "UPDATE tasks SET kind='pipeline', status='running', session_id=NULL, dispatched_at=? WHERE id=?",
  ).run(Date.now() - 5 * 86400_000, task.id));
  await daemon.restart();
  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await dashboard.keyboard.press("Shift+P");
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expect(sitrep).toBeVisible();
  await expectContentClearsBorder(sitrep);
  const section = sitrep.locator("section", { has: dashboard.getByRole("heading", { name: /Lost tasks/ }) });
  const row = section.locator(".report-row", { hasText: task.title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("running");
  await expect(row).toContainText("No session attached · dispatched 5d ago");
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row.getByRole("button", { name: "Confirm cancel", exact: true })).toBeVisible();
  expect(await row.getByText(/^No session attached/)
    .evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("sessionless-tasks");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await sitrep.screenshot({ path: join(dir, "cancel-sessionless-task.png") });
  }
  // A refused cancellation must be visible, and retry must still use the real endpoint.
  await dashboard.route(`**/api/tasks/${task.id}/cancel`, (route) => route.fulfill({
    status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "resources are being cleaned up" }),
  }), { times: 1 });
  await row.getByRole("button", { name: "Confirm cancel", exact: true }).click();
  await expect(sitrep.getByRole("alert")).toContainText("resources are being cleaned up");
  await expect.poll(async () => (await tasks(daemon)).find((t) => t.id === task.id)?.status).toBe("running");
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await row.getByRole("button", { name: "Confirm cancel", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await tasks(daemon)).find((t) => t.id === task.id)?.status).toBe("cancelled");
  const recent = sitrep.locator("section", { has: dashboard.getByRole("heading", { name: /Recent outcomes/ }) });
  await expect(recent.locator(".report-row", { hasText: task.title })).toContainText("cancelled");
});

/** A running task with no session and no Pipeline link, made real across a restart. */
async function strandTask(daemon: DaemonHandle, title: string): Promise<Task> {
  const task = await createTask(daemon, title);
  await daemon.shutdown();
  // The `pipeline` kind is the startup exception that keeps the row running rather than
  // settling it; with no run link it is still lost, because nothing owns it.
  withDaemonDb(daemon, (db) => db.prepare(
    "UPDATE tasks SET kind='pipeline', status='running', session_id=NULL, dispatched_at=? WHERE id=?",
  ).run(Date.now() - 2 * 86400_000, task.id));
  await daemon.restart();
  return task;
}

test("the fleet pulse flags a lost task and its card opens Sitrep on it", async ({ dashboard, daemon }) => {
  const task = await strandTask(daemon, "Stranded release notes");
  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();

  const segment = dashboard.getByRole("button", { name: "1 lost task - running with no session", exact: true });
  await expect(segment).toBeVisible();
  await expect(segment).toHaveText("1lost");
  await segment.click();

  const card = dashboard.getByRole("dialog", { name: "Lost tasks" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("1 task is running with no session");
  await expect(card).toContainText("Review and cancel it in Sitrep.");
  // The card takes focus, which also clears the segment's own tooltip that would otherwise
  // sit over the card's headline, and Tab lands on its one action.
  await expect(card).toBeFocused();
  await expect(dashboard.locator(".tooltip", { hasText: "Click for details" })).toHaveCount(0);
  await expect(dashboard.locator(".tooltip")).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("sessionless-tasks");
    mkdirSync(dir, { recursive: true });
    const bar = await dashboard.locator(".topbar").boundingBox();
    await dashboard.screenshot({
      path: join(dir, "lost-tasks-pulse-card.png"),
      clip: { x: 0, y: 0, width: bar!.width + bar!.x * 2, height: bar!.y + bar!.height + 200 },
    });
  }

  await dashboard.keyboard.press("Tab");
  await expect(card.getByRole("button", { name: /^Open Sitrep/ })).toBeFocused();

  // Escape closes the card and hands the keyboard back to the segment.
  await dashboard.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(segment).toBeFocused();

  await segment.click();
  await card.getByRole("button", { name: /^Open Sitrep/ }).click();
  await expect(card).toHaveCount(0);
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expect(sitrep).toBeVisible();
  // The section the segment counted leads the panel, ahead of Needs you.
  const titles = await sitrep.locator(".report-section-title").allTextContents();
  expect(titles[0]).toMatch(/^Lost tasks/);
  const section = sitrep.locator("section", { has: dashboard.getByRole("heading", { name: /Lost tasks/ }) });
  const row = section.locator(".report-row", { hasText: task.title });
  await expect(row).toContainText("No session attached · dispatched 2d ago");
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.mouse.move(0, 0);
    await sitrep.screenshot({ path: join(artifactsDir("sessionless-tasks"), "lost-tasks-sitrep.png") });
  }

  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await row.getByRole("button", { name: "Confirm cancel", exact: true }).click();
  await expect(row).toHaveCount(0);
  // Cancelling the last lost task takes the alarm away with it.
  await expect(segment).toHaveCount(0);
});

test("Cancel all clears every lost task after one confirming click", async ({ dashboard, daemon }) => {
  const first = await createTask(daemon, "First stranded task");
  const second = await createTask(daemon, "Second stranded task");
  await daemon.shutdown();
  withDaemonDb(daemon, (db) => {
    const update = db.prepare("UPDATE tasks SET kind='pipeline', status='running', session_id=NULL, dispatched_at=? WHERE id=?");
    update.run(Date.now() - 86400_000, first.id);
    update.run(Date.now() - 86400_000, second.id);
  });
  await daemon.restart();
  await dashboard.reload();

  const segment = dashboard.getByRole("button", { name: "2 lost tasks - running with no session", exact: true });
  await expect(segment).toBeVisible();
  await segment.click();
  await dashboard.getByRole("dialog", { name: "Lost tasks" }).getByRole("button", { name: /^Open Sitrep/ }).click();
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await sitrep.getByRole("button", { name: "Cancel all 2", exact: true }).click();
  await sitrep.getByRole("button", { name: "Confirm cancel all 2", exact: true }).click();
  await expect(sitrep.getByRole("heading", { name: /Lost tasks/ })).toHaveCount(0);
  await expect(segment).toHaveCount(0);
  await expect.poll(async () => (await tasks(daemon)).filter((t) => [first.id, second.id].includes(t.id)).map((t) => t.status))
    .toEqual(["cancelled", "cancelled"]);
});

test("restart settles lost ship and scout sessions and shows the reason in Sitrep", async ({ dashboard, daemon }) => {
  const ship = await createTask(daemon, "Lost ship session");
  const scout = await createTask(daemon, "Lost scout session");
  await daemon.shutdown();
  withDaemonDb(daemon, (db) => {
    const update = db.prepare("UPDATE tasks SET kind=?, status='running', session_id=NULL, dispatched_at=? WHERE id=?");
    update.run("ship", Date.now() - 13 * 86400_000, ship.id);
    update.run("scout", Date.now() - 5 * 86400_000, scout.id);
  });
  await daemon.restart();
  await expect.poll(async () => (await tasks(daemon)).filter((t) => [ship.id, scout.id].includes(t.id)).map((t) => t.status))
    .toEqual(["failed", "failed"]);
  await dashboard.reload();
  await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await dashboard.keyboard.press("Shift+P");
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expect(sitrep).toBeVisible();
  await expectContentClearsBorder(sitrep);
  for (const task of [ship, scout]) {
    const row = sitrep.locator(".report-row", { hasText: task.title });
    await expect(row).toContainText("failed");
    await expect(row).toContainText("session ended with no outcome recorded");
  }
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("sessionless-tasks");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await sitrep.screenshot({ path: join(dir, "settled-sessionless-tasks.png") });
  }
});
