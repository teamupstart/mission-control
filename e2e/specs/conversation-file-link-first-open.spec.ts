import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const TASK = "open README.md from the conversation";
const REPORT = "docs/reports/first-open-link/report.html";
const REPORT_TURN = `Report: ${REPORT}`;
const EVIDENCE = artifactsDir("conversation-file-link-first-open");

/**
 * Put the report beyond the former 2,000-entry listing boundary.
 *
 * Every path sorts before `docs/reports`, so the old cap omitted the report even though it
 * was a regular, non-ignored checkout file. Keeping the setup here makes the browser test
 * prove the user-visible reason for raising the cap instead of only pinning a server number.
 */
function seedFilesBeyondOldCap(cwd: string): void {
  const dir = join(cwd, "cap-fixture");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i <= 2_000; i += 1) {
    writeFileSync(join(dir, `file-${String(i).padStart(4, "0")}.txt`), "fixture\n");
  }
}

async function captureFirstOpen(page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}first-open-link.png` });
  // eslint-disable-next-line no-console
  console.log("CAPTURED e2e/.artifacts/conversation-file-link-first-open/first-open-link.png");
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

async function useBoardTerminal(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board", conversationView: "terminal" }),
  });
  const body = (await response.json()) as {
    config?: { layout?: string; conversationView?: string };
  };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  expect(body.config?.conversationView, "the daemon accepted the terminal rendering").toBe("terminal");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("a report beyond the old file cap is clickable on the first Board conversation open", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await useBoardTerminal(dashboard, daemon);

  const tile = dashboard.getByRole("button", { name: /Open README\.md From the Conversation/i });
  await tile.focus();
  await tile.press("Enter");

  // Settle the first checkout listing on a file that already exists. This is the stale
  // index the reported flow carries when the agent creates a report afterwards.
  const firstTurn = dashboard.getByRole("article", { name: "claude" }).last();
  await expect(firstTurn).toContainText(`Mock reply to: ${TASK}`);
  await expect(firstTurn.getByRole("link", { name: "README.md" })).toBeVisible();

  await dashboard.getByRole("button", { name: "Back to the board" }).click();

  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    id: string;
    cwd: string | null;
  }[];
  const session = sessions[0];
  expect(session?.cwd, "the dispatched session has a checkout").toBeTruthy();
  seedFilesBeyondOldCap(session!.cwd!);
  mkdirSync(join(session!.cwd!, "docs", "reports", "first-open-link"), { recursive: true });
  writeFileSync(join(session!.cwd!, REPORT), "<!doctype html><h1>First-open report</h1>\n");

  const injected = await fetch(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(session!.id)}/inject`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: REPORT_TURN, buffer: false }),
    },
  );
  expect(injected.ok, `POST /inject answered ${injected.status}: ${await injected.text()}`).toBe(true);

  await tile.focus();
  await tile.press("Enter");

  const assistantTurn = dashboard.getByRole("article", { name: "claude" }).last();
  await expect(assistantTurn).toContainText(`Mock reply to: ${REPORT_TURN}`);
  const path = assistantTurn.getByRole("link", { name: REPORT });
  await expect(path).toBeVisible();
  await captureFirstOpen(dashboard);

  await path.click();
  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
  await expect(tabs.getByRole("tab", { name: /Files$/ })).toHaveAttribute("aria-selected", "true");
  await expect(
    dashboard
      .getByRole("listbox", { name: "Session files" })
      .getByRole("option", { name: REPORT }),
  ).toHaveAttribute("aria-selected", "true");
});
