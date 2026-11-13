import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { recordsIn } from "../fixtures/records.ts";

/**
 * Every decision a Mission Control Claude task asks goes through `request_input`, which needs
 * Mission Control's MCP server on the launch. Without it the launch is refused - and the
 * operator is told why - on BOTH runtimes, rather than started with `AskUserQuestion` (a
 * decision asked outside `request_input`, with no room for its context) or with no way to ask
 * at all.
 *
 * The server is made unavailable the way it is in the field: its bundle is not where the daemon
 * looks for it.
 */

test.use({ daemonEnv: { MISSION_MCP_SERVER: "/nonexistent/mission-control/server.mjs" } });

async function dispatch(page: Page, daemon: DaemonHandle, task: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The refused task's tile, saying it did not start and why. */
async function expectRefused(page: Page, daemon: DaemonHandle, task: string): Promise<void> {
  const tile = page.getByRole("list", { name: "Did not start" }).getByRole("listitem").filter({ hasText: task });
  await expect(tile).toBeVisible();
  await expect(tile).toContainText(/did not start/i);
  await expect(tile).toContainText("request_input");
  await expect(tile).toContainText("npm run build");

  // Refused before anything ran: no Claude process was started in a task checkout.
  const launched = recordsIn<{ cwd: string }>(join(daemon.recordDir, "claude")).filter((record) =>
    record.cwd.startsWith(join(daemon.home, "worktree-pools")),
  );
  expect(launched, "no Claude process was launched for the refused task").toEqual([]);
}

test("a Claude SDK task without Mission Control's MCP server does not start, and says why", async ({
  dashboard,
  daemon,
}) => {
  const task = "pick a migration strategy";
  await dispatch(dashboard, daemon, task);
  await expectRefused(dashboard, daemon, task);
});

test("a Claude terminal task without Mission Control's MCP server does not start either", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  const runtime = dashboard.getByRole("combobox", { name: "Session runtime for dispatched Claude Code sessions" });
  await runtime.selectOption("terminal");
  await expect(runtime).toHaveValue("terminal");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();

  const task = "pick a rollout order";
  await dispatch(dashboard, daemon, task);
  await expectRefused(dashboard, daemon, task);
});
