import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const EVIDENCE = artifactsDir("sdk-idle-restore");
const TASK = "prove an idle SDK restore stays idle";

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  // With neither sessions nor backlog, the fleet deliberately renders its empty state
  // instead of an empty layout. The Board appears after the dispatch below.
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function sdkSessions(
  daemon: DaemonHandle,
): Promise<Array<{ id: string; state: string; stateConfirmed: boolean }>> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  expect(response.ok, "/api/sessions should answer").toBe(true);
  return (await response.json()) as Array<{
    id: string;
    state: string;
    stateConfirmed: boolean;
  }>;
}

function turnInProgress(daemon: DaemonHandle, id: string): number | null {
  return withDaemonDb(daemon, (db) => {
    const row = db.prepare(
      "SELECT turn_in_progress FROM sdk_sessions WHERE id = ?",
    ).get(id) as { turn_in_progress: number } | undefined;
    return row?.turn_in_progress ?? null;
  });
}

test("an idle SDK session remains idle on the Board and outside the working count after restart", async ({
  dashboard,
  daemon,
}) => {
  await useBoardLayout(dashboard, daemon);
  await dispatch(dashboard, daemon);

  await expect
    .poll(async () => (await sdkSessions(daemon)).length, {
      message: "the dispatch should publish one SDK session",
    })
    .toBe(1);
  const id = (await sdkSessions(daemon))[0]!.id;
  await expect
    .poll(
      async () => ({
        state: (await sdkSessions(daemon))[0]?.state ?? null,
        turnInProgress: turnInProgress(daemon, id),
      }),
      { timeout: 60_000 },
    )
    .toEqual({ state: "idle", turnInProgress: 0 });

  await daemon.crash();
  await daemon.restart();

  // Read the successor daemon, not the browser's pre-crash frame. Before the fix this exact
  // state settles at confirmed `starting`: the fake Claude resume emits `system/init` (bound)
  // and no assistant/result frame because the launch prompt is intentionally empty.
  await expect
    .poll(
      async () => {
        const session = (await sdkSessions(daemon))[0];
        return {
          id: session?.id ?? null,
          state: session?.state ?? null,
          stateConfirmed: session?.stateConfirmed ?? null,
          turnInProgress: session ? turnInProgress(daemon, session.id) : null,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({
      id,
      state: "idle",
      stateConfirmed: true,
      turnInProgress: 0,
    });

  // Reload onto the successor's initial snapshot so no assertion can pass against the old
  // daemon's cached idle card while the SSE connection is still reconnecting.
  await dashboard.reload();
  const idle = dashboard.locator("section.board-col.tone-idle");
  await expect(idle).toBeVisible();
  await expect(idle.locator(".board-col-n")).toHaveText("1");
  await expect(idle.locator(".tile")).toHaveCount(1);
  await expect(idle.locator(".tile")).toContainText("Prove an Idle SDK Restore Stays Idle");
  await expect(dashboard.locator("section.board-col.tone-working")).toHaveCount(0);

  const boardEvidence = process.env.MC_E2E_EVIDENCE
    ? await dashboard.locator("main.board").screenshot()
    : null;

  // The Sitrep is the reportBucket consumer with an explicit Working count. Both projections
  // must agree: the card is idle, and the restored session is absent from Working.
  await dashboard.keyboard.press("Shift+P");
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expect(sitrep).toBeVisible();
  await expect(sitrep.getByRole("heading", { name: "Working 0" })).toBeVisible();
  await expect(sitrep.getByRole("heading", { name: "Idle 1" })).toBeVisible();

  if (boardEvidence) {
    mkdirSync(EVIDENCE, { recursive: true });
    const sitrepEvidence = await sitrep.screenshot();
    const evidence = await dashboard.context().newPage();
    await evidence.setViewportSize({ width: 1800, height: 900 });
    await evidence.setContent(`
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; background: #090d12; color: #eef2f7; font: 16px system-ui, sans-serif; }
        main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(420px, 2fr); gap: 24px; padding: 24px; }
        figure { margin: 0; min-width: 0; }
        figcaption { margin-bottom: 12px; color: #b7c0cc; font-size: 15px; font-weight: 650; }
        img { display: block; width: 100%; border: 1px solid #28303b; border-radius: 8px; }
      </style>
      <main>
        <figure>
          <figcaption>Board after daemon restart</figcaption>
          <img alt="Restored Board" src="data:image/png;base64,${boardEvidence.toString("base64")}">
        </figure>
        <figure>
          <figcaption>Sitrep from the same restored state</figcaption>
          <img alt="Sitrep" src="data:image/png;base64,${sitrepEvidence.toString("base64")}">
        </figure>
      </main>
    `);
    await evidence.screenshot({
      path: `${EVIDENCE}restored-idle-board-and-sitrep.png`,
      fullPage: true,
    });
    await evidence.close();
    // eslint-disable-next-line no-console
    console.log(
      "CAPTURED e2e/.artifacts/sdk-idle-restore/restored-idle-board-and-sitrep.png",
    );
  }
});
