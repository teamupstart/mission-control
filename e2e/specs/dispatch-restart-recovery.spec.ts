import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

const TITLE = "Retry the dispatch after restart";
const LIVE_FAILURE_TITLE = "Retry the dispatch after git fetch recovers";
const RECOVERY =
  "Dispatch was interrupted before a worktree or agent was created. It is back in the backlog and safe to launch again.";
const EVIDENCE = artifactsDir("dispatch-restart-recovery");

async function captureRecovery(page: Page): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.locator("main.board").screenshot({
    path: join(EVIDENCE, "restart-recovery-backlog.png"),
  });
  // eslint-disable-next-line no-console
  console.log("OBSERVED the interrupted dispatch visible in Backlog with its retry explanation and launch control");
  // eslint-disable-next-line no-console
  console.log(
    "CAPTURED e2e/.artifacts/dispatch-restart-recovery/restart-recovery-backlog.png",
  );
}

async function captureLiveFailure(page: Page): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport?.width ?? 1280, height: 900 });
  try {
    await page.locator("main.board").screenshot({
      path: join(EVIDENCE, "git-preflight-recovery-backlog.png"),
    });
  } finally {
    if (viewport) await page.setViewportSize(viewport);
  }
  // eslint-disable-next-line no-console
  console.log("OBSERVED the failed git preflight visible in Backlog with its error and launch control");
  // eslint-disable-next-line no-console
  console.log(
    "CAPTURED e2e/.artifacts/dispatch-restart-recovery/git-preflight-recovery-backlog.png",
  );
}

async function seedBacklogTask(daemon: DaemonHandle, title = TITLE): Promise<string> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repoRoot: daemon.repo,
      title,
      intent: "Make this launch safe to retry when it stops before provisioning.",
      kind: "ship",
      agent: "claude",
      workflowId: null,
      backlog: true,
    }),
  });
  expect(response.ok, `task seed answered ${response.status}`).toBe(true);
  const task = (await response.json()) as { id?: string };
  expect(task.id).toBeTruthy();
  return task.id!;
}

async function taskState(
  daemon: DaemonHandle,
  id: string,
): Promise<{ status: string; error: string | null } | null> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  expect(response.ok, `/api/tasks answered ${response.status}`).toBe(true);
  const tasks = (await response.json()) as Array<{
    id: string;
    status: string;
    error: string | null;
  }>;
  return tasks.find((task) => task.id === id) ?? null;
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, `Board layout update answered ${response.status}`).toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("a pre-provision dispatch interrupted by restart stays visible and retries", async ({
  dashboard,
  daemon,
}) => {
  const taskId = await seedBacklogTask(daemon);

  // Arrange the exact durable boundary from the incident while the daemon is down: the
  // dispatch was accepted, but no worktree or launch resource was ever recorded. Restart
  // recovery itself remains real, as do the dashboard snapshot, retry route and fake launch.
  await daemon.crash();
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `UPDATE tasks
         SET status = 'dispatching',
             worktree_path = NULL,
             branch = 'harness/stale-restart-metadata',
             provider = NULL,
             base_sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             home_name = NULL,
             terminal_resource_id = NULL,
             session_id = NULL,
             error = NULL,
             dispatched_at = ?
       WHERE id = ?`,
    ).run(Date.now(), taskId);
  });
  await daemon.restart();

  await expect
    .poll(async () => {
      const task = await taskState(daemon, taskId);
      return task ? { status: task.status, error: task.error } : null;
    })
    .toEqual({ status: "backlog", error: RECOVERY });
  await useBoardLayout(dashboard, daemon);

  const card = dashboard.locator(".bl-card", { hasText: TITLE });
  await expect(card).toBeVisible();
  await expect(card.getByRole("status")).toHaveText(RECOVERY);
  const retry = card.getByRole("button", { name: "launch new agent" });
  await expect(retry).toBeEnabled();
  await captureRecovery(dashboard);
  await retry.click();

  await expect(dashboard.getByRole("button", { name: `Open ${TITLE}`, exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(async () => (await taskState(daemon, taskId))?.status ?? null).toBe(
    "running",
  );
});

test("a live git preflight failure returns to Backlog with its error and retries there", async ({
  dashboard,
  daemon,
}) => {
  const taskId = await seedBacklogTask(daemon, LIVE_FAILURE_TITLE);
  await useBoardLayout(dashboard, daemon);

  const originalOrigin = execFileSync(
    "git",
    ["-C", daemon.repo, "remote", "get-url", "origin"],
    { encoding: "utf8" },
  ).trim();
  execFileSync(
    "git",
    ["-C", daemon.repo, "remote", "set-url", "origin", join(daemon.home, "missing-origin")],
    { stdio: "pipe" },
  );

  const card = dashboard.locator(".bl-card", { hasText: LIVE_FAILURE_TITLE });
  const retry = card.getByRole("button", { name: "launch new agent" });
  try {
    await expect(card).toBeVisible();
    await retry.click();

    await expect.poll(async () => (await taskState(daemon, taskId))?.status ?? null).toBe(
      "backlog",
    );
    await expect(card).toBeVisible();
    await expect(card.getByRole("status")).toContainText("could not freeze");
    await expect(card.getByRole("status")).toContainText("git fetch origin failed");
    await expect(card.getByText("next up", { exact: true })).toHaveCount(0);
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await captureLiveFailure(dashboard);
  } finally {
    execFileSync(
      "git",
      ["-C", daemon.repo, "remote", "set-url", "origin", originalOrigin],
      { stdio: "pipe" },
    );
  }

  await retry.click();
  await expect(
    dashboard.getByRole("button", { name: `Open ${LIVE_FAILURE_TITLE}`, exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await taskState(daemon, taskId))?.status ?? null).toBe(
    "running",
  );
});
