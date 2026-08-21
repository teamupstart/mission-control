import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The worktree is a new item on the card, and it is off until an operator asks for it.
 *
 * Two claims, and only a browser can settle either. The first is the compatibility one: a
 * profile that has never opened the panel draws the card the previous release drew, so a
 * checkout path does not appear on every card in every column on upgrade. The second is
 * that turning it on puts the DIRECTORY'S NAME on the card, with the whole path on hover -
 * a pool worktree path is sixty characters of bookkeeping and the branch row is two cells
 * sharing one line.
 *
 * No model tokens: the dispatched agent is `e2e/fixtures/fake-agents.ts`.
 */

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Dispatch one agent, settle it, and report the checkout the daemon put it in. */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("live in a worktree");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let cwd = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string; cwd: string | null }>>(
      daemon,
      "/api/sessions",
    );
    const live = sessions.find((s) => s.state !== "exited");
    cwd = live?.cwd ?? "";
    return live?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  expect(cwd, "the dispatched session reported a checkout").not.toBe("");
  return cwd;
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon accepted the Board layout").toBe(true);
  // A RELOAD, not a hash navigation: the web store hydrates from `GET /api/ui/config` at
  // boot and paints from its `localStorage` mirror before that lands, so a preference
  // written out of band only takes on the next load.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("the worktree ships off, and switching it on puts the leaf on the card", async ({
  dashboard,
  daemon,
}) => {
  const cwd = await dispatchIdleAgent(dashboard, daemon);
  const leaf = cwd.replace(/\/+$/, "").split("/").pop()!;
  await useBoardLayout(dashboard, daemon);

  const tile = dashboard.locator("main.board .tile");
  await expect(tile).toHaveCount(1);
  // Off, on a profile that has never opened the panel. This is the assertion that an
  // upgrade moves nothing: no card drew a checkout before, and none draws one now.
  await expect(tile.locator(".tile-worktree")).toHaveCount(0);

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const worktree = dashboard.getByRole("checkbox", { name: "Worktree", exact: true });
  await expect(worktree).not.toBeChecked();
  await worktree.check();

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const cell = tile.locator(".tile-worktree");
  await expect(cell).toBeVisible();
  // The leaf, not the path. The whole point of the cell.
  await expect(cell).toHaveText(leaf);
  await expect(cell).not.toContainText("/");

  // And the path itself is one hover away, through the app's own tooltip rather than a
  // native `title` - which is why it is also readable without hovering at all.
  const described = await cell.getAttribute("aria-describedby");
  expect(described, "the worktree cell carries a tooltip").not.toBeNull();
  await expect(dashboard.locator(`#${described}`)).toHaveText(cwd);
  await cell.hover();
  await expect(dashboard.locator(".tooltip", { hasText: cwd })).toBeVisible();
});
