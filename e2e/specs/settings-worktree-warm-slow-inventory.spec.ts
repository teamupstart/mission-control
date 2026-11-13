import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Route } from "@playwright/test";
import type { WorktreeInventory } from "../../src/shared/worktrees.ts";
import { expect, test } from "../fixtures/test.ts";

// Settings > Worktrees: a running Warm invalidates the inventory about once a second. When each
// inventory read takes longer than that - a busy daemon, a loaded machine - the panel must still
// show the Warm move from queued to in progress to finished. Every read is held here for longer
// than the step's output interval, so a panel that keeps only the newest read never updates. A
// refused Cancel must also stay on the Warm through those reads instead of being cleared by the
// next one. Nothing is dispatched; every agent binary stays faked anyway.

const WARM_SETTLES_MS = 60_000;
const READ_DELAY_MS = 2_500;

/** Print a line every 250 ms until the gate file exists, then exit with the code it holds. */
const STEP_SCRIPT = [
  `const fs = require("fs");`,
  `const gate = process.argv[1];`,
  `let n = 0;`,
  `const tick = () => {`,
  `  if (fs.existsSync(gate)) process.exit(Number(fs.readFileSync(gate, "utf8")));`,
  `  n += 1;`,
  `  console.log("fetched package " + n);`,
  `  setTimeout(tick, 250);`,
  `};`,
  `tick();`,
].join(" ");

test("a Warm still shows its progress when every inventory read is slower than its updates", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(join(tmpdir(), "mc-e2e-warm-slow-"));
  const gate = join(dir, "gate");
  try {
    const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label: "an idle slot to warm" },
    });
    expect(acquired.status()).toBe(201);
    const { leaseId } = await acquired.json() as { leaseId: string };
    expect((await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId } })).ok())
      .toBe(true);
    const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
    const repository = inventory.repositories.find((repo) => repo.name === "demo-repo");
    expect(repository).toBeTruthy();
    const saved = await dashboard.request.put(`${daemon.baseURL}/api/worktrees/config`, {
      data: {
        repositories: {
          [repository!.commonDirectory]: {
            claim: { steps: [{ argv: [process.execPath, "-e", STEP_SCRIPT, gate], env: [] }], timeoutMinutes: 5, fingerprintPaths: [] },
          },
        },
      },
    });
    expect(saved.status()).toBe(200);

    await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
    const pool = dashboard.locator(".wt-pool", { hasText: "demo-repo" });
    const disclosure = pool.getByRole("button", { name: /demo-repo/ });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
    const slotOne = pool.getByRole("article", { name: "Slot 1" });
    await expect(slotOne.getByRole("button", { name: "Warm", exact: true })).toBeVisible();

    const slowRead = async (route: Route) => {
      if (route.request().method() === "GET" && new URL(route.request().url()).pathname === "/api/worktrees") {
        await new Promise((resolve) => setTimeout(resolve, READ_DELAY_MS));
      }
      await route.continue().catch(() => {});
    };
    await dashboard.route("**/api/worktrees", slowRead);

    await slotOne.getByRole("button", { name: "Warm", exact: true }).click();
    const dialog = dashboard.getByRole("dialog", { name: "warm worktree preview" });
    await dialog.getByRole("button", { name: "Execute" }).click();
    await expect(dialog).toHaveCount(0);

    const single = dashboard.getByRole("region", { name: "Warm operations" }).getByRole("listitem", { name: "Warm slot 1" });
    await expect(single).toContainText("in progress", { timeout: WARM_SETTLES_MS });
    await expect(single.getByLabel("Warm slot 1 output")).toContainText("fetched package 20", { timeout: WARM_SETTLES_MS });

    // A refused Cancel stays on its Warm through the reads that keep arriving while it runs.
    const refuseCancel = (route: Route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "the daemon is shutting down" }) });
    await dashboard.route("**/api/worktrees/operations/*/cancel", refuseCancel);
    await single.getByRole("button", { name: "Cancel" }).click();
    const refused = single.getByText("That Warm could not be cancelled: the daemon is shutting down");
    await expect(refused).toBeVisible();
    await expect(single.getByLabel("Warm slot 1 output")).toContainText("fetched package 40", { timeout: WARM_SETTLES_MS });
    await expect(refused).toBeVisible();
    await expect(single).toContainText("in progress");
    await dashboard.unroute("**/api/worktrees/operations/*/cancel", refuseCancel);

    writeFileSync(gate, "0");
    await expect(single).toContainText("finished", { timeout: WARM_SETTLES_MS });
    await expect(single.getByRole("list", { name: "Warm slot 1 slots" })).toContainText("warmed");
    await expect(refused).toHaveCount(0);
    await dashboard.unroute("**/api/worktrees", slowRead);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
