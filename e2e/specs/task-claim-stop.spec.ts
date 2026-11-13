import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

// A dispatch that waits on a pool's dependency claim. Its task card says "Installing
// dependencies" with the running step and elapsed time, and both the task card and the slot
// card in Settings › Worktrees offer Stop. Stop kills the claim and hands the slot over as a
// failed claim, so the dispatch continues and the session's task band carries the warning.
//
// The claim really runs: its one step is a Node program that prints a line and then waits
// forever, so only a Stop ends it. Every agent binary stays faked.

const EVIDENCE = artifactsDir("task-claim-stop");

/** A real native dispatch is git worktree work on disk; see native-worktree-dispatch.spec.ts. */
const DISPATCH_SETTLES_MS = 60_000;

const NEVER_ENDS = [
  `console.log("resolving fixture packages");`,
  `setInterval(() => {}, 1000);`,
].join(" ");

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-claim-stop/${name}.png`);
}

/** The demo repository's pool claim: one step that never ends on its own. */
async function configureClaim(daemon: DaemonHandle): Promise<void> {
  const configured = await fetch(`${daemon.baseURL}/api/worktrees/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repositories: {
        [realpathSync(join(daemon.repo, ".git"))]: {
          claim: { steps: [{ argv: [process.execPath, "-e", NEVER_ENDS] }], timeoutMinutes: 30 },
        },
      },
    }),
  });
  expect(configured.ok, `the claim was refused: ${await configured.text()}`).toBe(true);
}

async function useLayout(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout }),
  });
  expect(response.ok).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
}

/** Dispatch a ship task with an explicit title, and return its id. */
async function dispatch(page: Page, daemon: DaemonHandle, title: string): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(`${title}, after the dependencies install.`);
  await dialog.getByLabel("Kind").selectOption("ship");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: /^Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(title);
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/tasks");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  const response = await created;
  expect(response.ok(), `dispatching answered ${response.status()}`).toBe(true);
  await expect(dialog).toBeHidden();
  return ((await response.json()) as { id: string }).id;
}

async function taskStatus(daemon: DaemonHandle, id: string): Promise<string | undefined> {
  const tasks = await (await fetch(`${daemon.baseURL}/api/tasks`)).json() as Array<{ id: string; status: string }>;
  return tasks.find((task) => task.id === id)?.status;
}

test("the task card shows Installing dependencies with Stop, and Stop lets the dispatch continue with a warning", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  await configureClaim(daemon);
  await useLayout(dashboard, daemon, "console");
  const title = "Install fixture dependencies";
  const id = await dispatch(dashboard, daemon, title);

  // The dispatch placeholder in the rail's Working group, where the session's row will land.
  const starting = dashboard.getByRole("navigation", { name: "Sessions" }).getByRole("list", { name: "Starting" });
  const row = starting.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("Installing dependencies", { timeout: DISPATCH_SETTLES_MS });
  await expect(row).not.toContainText("Provisioning its worktree");
  await expect(row).toContainText("Step 1 of 1");
  const elapsed = row.getByText(/^\d+:\d\d elapsed$/);
  const before = await elapsed.textContent();
  await expect(elapsed).not.toHaveText(before ?? "", { timeout: 5_000 });
  const stop = row.getByRole("button", { name: `Stop installing dependencies for ${title}` });
  await expect(stop).toBeEnabled();
  // Still dispatching while it claims, which is what Foreman's session limit counts.
  expect(await taskStatus(daemon, id)).toBe("dispatching");
  await shoot(dashboard, row, "01-task-card-installing");

  await stop.click();

  // The claim failed, the slot was handed over, and the dispatch went on to launch the agent.
  const sessionRow = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: title });
  await expect(sessionRow).toBeVisible({ timeout: DISPATCH_SETTLES_MS });
  await expect(starting).toBeHidden();
  await sessionRow.click();
  const warnings = dashboard.getByRole("group", { name: "Dependency install warnings" });
  await expect(warnings).toContainText("Dependency install failed in demo-repo: step 1 of 1 was stopped.");
  await warnings.getByText(/^Dependency install failed/).click();
  await expect(warnings.getByLabel("Dependency install output tail")).toContainText("resolving fixture packages");
  await expect(warnings.getByLabel(/^Failed command: /)).toContainText(`${process.execPath} -e`);
  await shoot(dashboard, warnings, "02-session-claim-warning");

  // And the slot keeps its own record of the same Stop.
  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const deps = pool.getByRole("region", { name: /^Slot \d+ dependencies$/ }).filter({ hasText: "failed" });
  await expect(deps).toContainText("Step 1 of 1 was stopped.");
  await expect(pool.getByRole("button", { name: /^Stop slot \d+ dependency claim$/ })).toHaveCount(0);
});

test("the slot card's Stop ends the claim a dispatch is waiting on, and the dispatch continues", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  await configureClaim(daemon);
  await useLayout(dashboard, daemon, "board");
  const title = "Wait on the slot claim";
  const id = await dispatch(dashboard, daemon, title);

  // The Board's placeholder tile says the same as the rail row, with its own Stop.
  const tile = dashboard.locator("section.board-col.tone-working")
    .getByRole("list", { name: "Starting" })
    .getByRole("listitem")
    .filter({ hasText: title });
  await expect(tile).toContainText("Installing dependencies", { timeout: DISPATCH_SETTLES_MS });
  await expect(tile).toContainText("Step 1 of 1");
  await expect(tile.getByRole("button", { name: `Stop installing dependencies for ${title}` })).toBeEnabled();
  await shoot(dashboard, tile, "00-board-tile-installing");

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  await expect(disclosure).toBeVisible({ timeout: DISPATCH_SETTLES_MS });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const installing = pool.getByRole("region", { name: /^Slot \d+ dependencies$/ }).filter({ hasText: "installing" });
  await expect(installing).toHaveCount(1, { timeout: DISPATCH_SETTLES_MS });
  await expect(installing).toContainText("Step 1 of 1 · ");
  const ordinal = Number(/Slot (\d+) dependencies/.exec((await installing.getAttribute("aria-label")) ?? "")?.[1]);
  const stop = installing.getByRole("button", { name: `Stop slot ${ordinal} dependency claim` });
  await expect(stop).toBeEnabled();
  await shoot(dashboard, pool.getByRole("article", { name: `Slot ${ordinal}` }), "03-slot-card-installing");

  await stop.click();

  const deps = pool.getByRole("region", { name: `Slot ${ordinal} dependencies` });
  await expect(deps).toContainText("failed", { timeout: DISPATCH_SETTLES_MS });
  await expect(deps).toContainText("Step 1 of 1 was stopped.");
  await expect(deps.getByLabel(`Slot ${ordinal} dependency output tail`)).toContainText("resolving fixture packages");
  await expect(deps).toContainText("The next lease runs the claim again.");
  await expect(stop).toHaveCount(0);
  await shoot(dashboard, pool.getByRole("article", { name: `Slot ${ordinal}` }), "04-slot-card-stopped");
  // The slot was handed over rather than quarantined, and the task launched into it.
  await expect(pool.getByRole("article", { name: `Slot ${ordinal}` })).toContainText("leased");
  await expect.poll(() => taskStatus(daemon, id), { timeout: DISPATCH_SETTLES_MS }).toBe("running");
});
