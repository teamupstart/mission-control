import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const EVIDENCE = artifactsDir("sdk-startup-bootstrap");
const TASK = "prove the Board renders while SDK restoration is pending";

test.use({
  daemonEnv: {
    MC_E2E_CODEX_RESUME_DELAY_MS: "8000",
    MC_E2E_CODEX_THREAD_ID: "01999999-2222-7000-8000-000000000001",
  },
});

async function useLayout(
  page: Page,
  daemon: DaemonHandle,
  layout: "board" | "console",
): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

async function dispatchCodex(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption("codex");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function sdkSessions(
  daemon: DaemonHandle,
): Promise<Array<{ id: string; name: string; state: string }>> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  expect(response.ok).toBe(true);
  return response.json() as Promise<Array<{ id: string; name: string; state: string }>>;
}

function turnInProgress(daemon: DaemonHandle, id: string): number | null {
  return withDaemonDb(daemon, (db) => {
    const row = db.prepare(
      "SELECT turn_in_progress FROM sdk_sessions WHERE id = ?",
    ).get(id) as { turn_in_progress: number } | undefined;
    return row?.turn_in_progress ?? null;
  });
}

function resumePhase(daemon: DaemonHandle, phase: "started" | "completed"): boolean {
  return existsSync(join(daemon.recordDir, "codex", `resume-${phase}.json`));
}

test("the built Board is usable while a persisted SDK driver restores", async ({
  dashboard,
  daemon,
}) => {
  await useLayout(dashboard, daemon, "board");
  await dispatchCodex(dashboard, daemon);

  await expect.poll(async () => (await sdkSessions(daemon)).length).toBe(1);
  const before = (await sdkSessions(daemon))[0]!;
  await expect
    .poll(async () => ({
      state: (await sdkSessions(daemon))[0]?.state ?? null,
      turnInProgress: turnInProgress(daemon, before.id),
    }), { timeout: 60_000 })
    .toEqual({ state: "idle", turnInProgress: 0 });

  // Persist Console before the restart. Restoring rows are Board-only, so Console must keep
  // its ordinary empty state rather than becoming a blank screen while the driver is absent.
  await useLayout(dashboard, daemon, "console");
  await daemon.crash();
  await daemon.restart();

  await expect.poll(() => resumePhase(daemon, "started")).toBe(true);
  expect(
    resumePhase(daemon, "completed"),
    "health should answer before the delayed native resume handshake completes",
  ).toBe(false);

  await dashboard.reload();
  await expect(dashboard.getByText("No agent sessions detected")).toBeVisible();
  await expect(dashboard.getByRole("status", { name: `Restoring ${before.name}` })).toHaveCount(0);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: join(EVIDENCE, "console-during-restore.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/sdk-startup-bootstrap/console-during-restore.png");
  }

  await useLayout(dashboard, daemon, "board");
  const restoring = dashboard.getByRole("status", { name: `Restoring ${before.name}` });
  await expect(restoring).toBeVisible();
  await expect(restoring).toContainText("Restoring");
  await expect(restoring.getByRole("button")).toHaveCount(0);
  await expect(restoring.getByRole("link")).toHaveCount(0);
  expect(await restoring.getAttribute("draggable")).not.toBe("true");
  await expect(dashboard.locator(".tile")).toHaveCount(0);

  const filter = dashboard.getByPlaceholder("Filter (/)");
  await dashboard.locator(".filter-box").click();
  await expect(filter).toBeFocused();
  await filter.fill("no restoring row matches this");
  await expect(restoring).toBeHidden();
  const filterEmpty = dashboard.locator(".empty");
  await expect(filterEmpty.getByText('Nothing matches "no restoring row matches this"')).toBeVisible();
  await expect(filterEmpty).toContainText(
    "No session row or backlog task matches that title or status.",
  );
  await expect(filterEmpty).toContainText("to see all 1 session row.");

  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.screenshot({ path: join(EVIDENCE, "filtered-restoring-board.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/sdk-startup-bootstrap/filtered-restoring-board.png");
  }

  await filter.fill("");
  await expect(restoring).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({ path: join(EVIDENCE, "restoring-board.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/sdk-startup-bootstrap/restoring-board.png");
  }

  await expect.poll(() => resumePhase(daemon, "completed"), { timeout: 15_000 }).toBe(true);
  await expect(restoring).toBeHidden();
  const idle = dashboard.locator("section.board-col.tone-idle");
  await expect(idle.locator(".tile")).toHaveCount(1);
  await expect(idle.locator(".tile")).toContainText(before.name);
  await expect(idle.locator(".board-col-n")).toHaveText("1");

  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.screenshot({ path: join(EVIDENCE, "settled-board.png"), fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/sdk-startup-bootstrap/settled-board.png");
  }
});
