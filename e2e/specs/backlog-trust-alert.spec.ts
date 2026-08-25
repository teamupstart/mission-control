import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("backlog-trust-alert");

async function request<T>(
  daemon: DaemonHandle,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function seedTask(
  daemon: DaemonHandle,
  title: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; title: string }> {
  const task = await request<{ id: string }>(daemon, "POST", "/api/tasks", {
    repoRoot: daemon.repo,
    title,
    intent: `Implement ${title}.`,
    backlog: true,
    workflowId: null,
    ...over,
  });
  return { id: task.id, title };
}

async function renewForeman(daemon: DaemonHandle): Promise<void> {
  await request(daemon, "POST", "/api/foreman/heartbeat", { workerId: "e2e-trust-alert" });
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/backlog-trust-alert/${name}.png`);
}

async function shootSurface(page: Page, surface: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await surface.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/backlog-trust-alert/${name}.png`);
}

const lineStage = (page: Page): Locator =>
  page.getByRole("navigation", { name: "The Line" })
    .getByRole("button", { name: /^Backlog,/ });

const noticeText = (repo: string): string =>
  `Autopilot cannot schedule this task: ${basename(repo)} is not trusted for Foreman. Manual launch still works.`;

test("task-local trust notices explain every backlog surface and retire after a Trust grant", async ({
  dashboard,
  daemon,
}) => {
  const ready = await seedTask(daemon, "Grant-aware foundation");
  const dependent = await seedTask(daemon, "Grant-aware follow-up");
  const later = await seedTask(daemon, "Grant-aware delivery");
  const last = await seedTask(daemon, "Grant-aware verification");
  const parked = await seedTask(daemon, "Parked by the operator");
  await request(daemon, "POST", `/api/tasks/${parked.id}/update`, { enabled: false });
  await request(daemon, "PUT", "/api/backlog/plan", {
    entries: [
      { taskId: ready.id, dependsOn: [], reason: "The foundation goes first." },
      { taskId: dependent.id, dependsOn: [ready.id], reason: "Needs the foundation." },
      { taskId: later.id, dependsOn: [dependent.id], reason: "Needs the follow-up." },
      { taskId: last.id, dependsOn: [later.id], reason: "Needs delivery." },
      { taskId: parked.id, dependsOn: [], reason: null },
    ],
    note: null,
  });
  await request(daemon, "PUT", "/api/foreman/config", {
    enabled: true,
    mode: "live",
    autoBacklog: true,
    repoAllowlist: [],
  });
  await renewForeman(daemon);
  await request(daemon, "PUT", "/api/ui/config", { layout: "board" });
  await dashboard.reload();

  const board = dashboard.locator("main.board");
  const backlog = board.locator("section.board-backlog");
  await expect(board).toBeVisible();
  const cardFor = (title: string): Locator => backlog
    .getByRole("button", { name: title, exact: true })
    .locator("xpath=ancestor::article");
  const readyCard = cardFor(ready.title);
  const dependentCard = cardFor(dependent.title);
  const parkedCard = cardFor(parked.title);
  const readyNoticeCopy = readyCard.getByText(noticeText(daemon.repo), { exact: true });

  await expect(readyNoticeCopy).toBeVisible({ timeout: 20_000 });
  await expect(readyCard.getByRole("button", { name: "Manage trust" })).toBeVisible();
  await expect(dependentCard.getByText(noticeText(daemon.repo), { exact: true })).toBeVisible();
  await expect(backlog.getByText(noticeText(daemon.repo), { exact: true })).toHaveCount(4);
  await expect(backlog.getByRole("status")).toHaveCount(0);
  await expect(dependentCard).toContainText(`after ${ready.title}`, { timeout: 20_000 });
  await expect(parkedCard.getByText(/Autopilot cannot schedule/)).toHaveCount(0);
  await expect(parkedCard).toContainText("autopilot will skip this");
  await expect(readyCard.getByRole("button", { name: "launch new agent" })).toBeEnabled();
  await expect(backlog.getByRole("button", { name: /Autopilot cannot schedule/ })).toHaveCount(0);
  await dashboard.setViewportSize({ width: 1280, height: 1400 });
  await shoot(dashboard, "board-inline-wide");
  await shootSurface(dashboard, backlog, "board-surface");

  // The existing notification line wraps inside a narrow card, and its inline action stays
  // keyboard-reachable without introducing a triangle or disclosure panel.
  await dashboard.setViewportSize({ width: 860, height: 900 });
  const manage = readyCard.getByRole("button", { name: "Manage trust" });
  await manage.focus();
  await expect(manage).toBeFocused();
  const noticeBox = (await readyNoticeCopy.boundingBox())!;
  const cardBox = (await readyCard.boundingBox())!;
  expect(noticeBox.x).toBeGreaterThanOrEqual(cardBox.x);
  expect(noticeBox.x + noticeBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  await expect(dashboard.getByRole("dialog", { name: /Why autopilot cannot schedule/ })).toHaveCount(0);
  await dashboard.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(dashboard.locator(".tooltip")).toHaveCount(0);
  await shoot(dashboard, "board-inline-narrow");
  await dashboard.setViewportSize({ width: 1280, height: 720 });

  // Sitrep consumes the same inline notice and leaves its existing task line in place.
  await renewForeman(daemon);
  await dashboard.keyboard.press("Shift+P");
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expect(sitrep).toBeVisible();
  await expect(sitrep.getByText(noticeText(daemon.repo), { exact: true })).toHaveCount(4, {
    timeout: 20_000,
  });
  await expect(sitrep.getByRole("status")).toHaveCount(0);
  await expect(sitrep.getByRole("button", { name: "Manage trust" })).toHaveCount(4);
  await shootSurface(dashboard, sitrep, "sitrep-surface");
  await sitrep.getByRole("button", { name: "Close" }).click();

  // The Line drawer uses its new third identity line, preserves the dependency mark, and
  // closes before the inline remedy routes to Trust.
  await lineStage(dashboard).click();
  const drawer = dashboard.getByRole("region", { name: "Backlog drawer" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(noticeText(daemon.repo), { exact: true })).toHaveCount(4);
  await expect(drawer.getByRole("status")).toHaveCount(0);
  const dependentRow = drawer
    .getByRole("button", { name: dependent.title, exact: true })
    .locator("xpath=ancestor::li");
  await expect(dependentRow).toContainText(`after ${ready.title}`);
  await expect(dependentRow.getByText(noticeText(daemon.repo), { exact: true })).toBeVisible();
  await shoot(dashboard, "drawer-inline-with-dependency");
  await shootSurface(dashboard, drawer, "drawer-surface");
  await dependentRow.getByRole("button", { name: "Manage trust" }).click();

  await expect(drawer).toHaveCount(0);
  await expect.poll(() => dashboard.evaluate(() => location.hash)).toBe("#/settings/trust");
  await expect(dashboard.locator('[data-anchor="trust/matrix"]')).toHaveClass(/settings-flash/);
  await expect(dashboard.getByRole("table", { name: "Repository trust grants" })).toBeVisible();

  // Grant through the existing matrix. App stays mounted, and the ordinary Foreman config
  // update removes every task notice without a reload or notice-local dismissal state.
  await renewForeman(daemon);
  await dashboard.getByRole("combobox", { name: /search repos or type a path/i }).fill(daemon.repo);
  await dashboard.getByRole("button", { name: "Add", exact: true }).click();
  const grant = dashboard.getByRole("button", {
    name: `Grant: Foreman sends live for ${daemon.repo}`,
  });
  await expect(grant).toBeVisible();
  await grant.click();
  await expect(dashboard.getByRole("button", {
    name: `Revoke: Foreman sends live for ${daemon.repo}`,
  })).toBeVisible();

  await dashboard.evaluate(() => { location.hash = "#/fleet"; });
  await expect(board).toBeVisible();
  await expect(backlog.getByText(/Autopilot cannot schedule/)).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(readyCard.getByRole("button", { name: "launch new agent" })).toBeEnabled();
});
