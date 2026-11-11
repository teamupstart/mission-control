import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { WorktreeInventory } from "../../src/shared/worktrees.ts";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

// Settings > Worktrees: Warm on an available slot's card, and Warm idle slots on the pool row.
// The pool's claim really runs. Its one step is a small Node program that prints a line every
// few hundred milliseconds until a gate file this spec writes appears, so the live tail is
// observed growing through the worktrees revision bump, one Warm is observed finishing with its
// full log kept on the slot card, and a second is cancelled mid-step. Nothing is dispatched, so
// no agent runs; every agent binary stays faked anyway.

const EVIDENCE = artifactsDir("settings-worktree-warm");

/** A Warm is a fetch, a reset and a claim on disk; see native-worktree-dispatch.spec.ts. */
const WARM_SETTLES_MS = 45_000;

/**
 * The claim's step: record its pid, then print a numbered line every 250 ms until the gate file
 * exists, and exit with the code it holds.
 */
const STEP_SCRIPT = [
  `const fs = require("fs");`,
  `const [gate, pidFile] = process.argv.slice(1);`,
  `fs.writeFileSync(pidFile, String(process.pid));`,
  `console.log("resolving fixture packages");`,
  `let n = 0;`,
  `const tick = () => {`,
  `  if (fs.existsSync(gate)) process.exit(Number(fs.readFileSync(gate, "utf8")));`,
  `  n += 1;`,
  `  console.log("fetched package " + n);`,
  `  setTimeout(tick, 250);`,
  `};`,
  `tick();`,
].join(" ");

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-worktree-warm/${name}.png`);
}

async function openPool(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const pool = page.locator(".wt-pool", { hasText: "demo-repo" });
  const disclosure = pool.getByRole("button", { name: /demo-repo/ });
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  return pool;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Warm and Warm idle slots prepare idle slots with a live tail, Cancel, and a kept log", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(240_000);
  const dir = mkdtempSync(join(tmpdir(), "mc-e2e-warm-gate-"));
  const gate = join(dir, "gate");
  const pidFile = join(dir, "pid");

  // Two slots, made before any claim is configured, so each is answered at once with 201, then
  // returned: both available and never installed.
  const leases: Array<{ leaseId: string }> = [];
  for (const label of ["first idle slot", "second idle slot"]) {
    const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(response.status()).toBe(201);
    leases.push(await response.json() as { leaseId: string });
  }
  for (const lease of leases) {
    const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, {
      data: { leaseId: lease.leaseId },
    });
    expect(returned.ok()).toBe(true);
  }
  const inventory = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const repository = inventory.repositories.find((repo) => repo.name === "demo-repo");
  expect(repository).toBeTruthy();
  const saved = await dashboard.request.put(`${daemon.baseURL}/api/worktrees/config`, {
    data: {
      repositories: {
        [repository!.commonDirectory]: {
          claim: {
            steps: [{ argv: [process.execPath, "-e", STEP_SCRIPT, gate, pidFile], env: [] }],
            timeoutMinutes: 5,
            fingerprintPaths: [],
          },
        },
      },
    },
  });
  expect(saved.status()).toBe(200);

  const pool = await openPool(dashboard, daemon);
  const slotOne = pool.getByRole("article", { name: "Slot 1" });
  await expect(slotOne.getByRole("button", { name: "Warm", exact: true })).toBeVisible();

  // ---- Warm on one slot's card ----
  await slotOne.getByRole("button", { name: "Warm", exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "warm worktree preview" });
  await expect(dialog.getByRole("heading", { name: "Warm worktree" })).toBeVisible();
  await expect(dialog).toContainText(
    "Holds each slot under a warm lease, fetches origin, resets the slot to origin's default branch",
  );
  await expect(dialog).toContainText("Cancel stops the running step's process group and returns the slot to the pool.");
  await expect(dialog.getByRole("button", { name: "Execute" })).toBeEnabled();
  await expectContentClearsBorder(dialog);
  await shoot(dashboard, dialog, "01-warm-slot-preview");
  await dialog.getByRole("button", { name: "Execute" }).click();
  await expect(dialog).toHaveCount(0);

  const warms = dashboard.getByRole("region", { name: "Warm operations" });
  const single = warms.getByRole("listitem", { name: "Warm slot 1" });
  await expect(single).toContainText("in progress", { timeout: WARM_SETTLES_MS });
  const singleTail = single.getByLabel("Warm slot 1 output");
  // Whole lines: the tail also shows the step's command, which spells the script out.
  await expect(singleTail).toContainText(/^resolving fixture packages$/m, { timeout: WARM_SETTLES_MS });
  // The tail keeps growing without a refresh: each line arrives through the revision bump.
  await expect(singleTail).toContainText("fetched package 3", { timeout: WARM_SETTLES_MS });
  await expect(singleTail).toContainText("fetched package 6", { timeout: WARM_SETTLES_MS });
  await expect(single.getByRole("list", { name: "Warm slot 1 slots" })).toContainText("warming");
  await expect(pool.getByRole("region", { name: "Slot 1 dependencies" })).toContainText("installing");
  await expect(slotOne).toContainText("Warming this slot ahead of time");
  await shoot(dashboard, single, "02-warm-slot-live-tail");

  writeFileSync(gate, "0");
  await expect(single).toContainText("finished", { timeout: WARM_SETTLES_MS });
  await expect(single.getByRole("list", { name: "Warm slot 1 slots" })).toContainText("warmed");
  await expect(single.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(pool.getByRole("region", { name: "Slot 1 dependencies" })).toContainText("current");
  await expect(slotOne.getByText("available", { exact: true })).toBeVisible();

  // The full log, from the operation and from the slot card, which keeps it after a dismissal.
  const fromOperation = dashboard.waitForEvent("download");
  await single.getByRole("link", { name: "Download the full log of Warm slot 1" }).click();
  const logText = readFileSync((await (await fromOperation).path())!, "utf8");
  expect(logText).toMatch(/^resolving fixture packages$/m);
  expect(logText).toContain("Fetching origin's default branch");
  expect(logText).toMatch(/^Slot 1: warmed$/m);
  await shoot(dashboard, single, "03-warm-slot-finished");
  await single.getByRole("button", { name: "Dismiss" }).click();
  await expect(single).toHaveCount(0);
  const kept = slotOne.getByRole("link", { name: "Download slot 1's last Warm log" });
  await expect(kept).toBeVisible();
  const fromSlot = dashboard.waitForEvent("download");
  await kept.click();
  expect(readFileSync((await (await fromSlot).path())!, "utf8")).toBe(logText);
  await shoot(dashboard, slotOne, "04-slot-keeps-last-warm-log");

  // ---- Warm idle slots on the pool row, cancelled mid-step ----
  unlinkSync(gate);
  if (existsSync(pidFile)) unlinkSync(pidFile);
  await pool.getByRole("button", { name: "Warm idle slots" }).click();
  await expect(dialog.getByRole("heading", { name: "Warm idle slots" })).toBeVisible();
  await expect(dialog.getByRole("list").first().getByRole("listitem")).toHaveCount(2);
  await expect(dialog).toContainText("A slot leased before its turn comes is skipped and listed as skipped.");
  await expectContentClearsBorder(dialog);
  await shoot(dashboard, dialog, "05-warm-idle-slots-preview");
  await dialog.getByRole("button", { name: "Execute" }).click();
  await expect(dialog).toHaveCount(0);

  const bulk = warms.getByRole("listitem", { name: "Warm idle slots" });
  const bulkTail = bulk.getByLabel("Warm idle slots output");
  await expect(bulkTail).toContainText("fetched package 2", { timeout: WARM_SETTLES_MS });
  await expect.poll(() => existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(alive(pid)).toBe(true);
  await shoot(dashboard, bulk, "06-warm-idle-slots-running");

  await bulk.getByRole("button", { name: "Cancel" }).click();
  await expect(bulk).toContainText("finished", { timeout: WARM_SETTLES_MS });
  const targets = bulk.getByRole("list", { name: "Warm idle slots slots" }).getByRole("listitem");
  await expect(targets).toHaveCount(2);
  await expect(targets.nth(0)).toContainText("cancelled");
  await expect(targets.nth(0)).toContainText("Slot 1");
  await expect(targets.nth(1)).toContainText("cancelled");
  await expect(targets.nth(1)).toContainText("Slot 2");
  await expect(targets.nth(1)).toContainText("cancelled before its turn");
  await expect(bulkTail).toContainText("Step 1 of 1 was stopped.");
  await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);

  // Cancel returned the slot it held, with the claim failed (a Cancel during a step), and never
  // reached the second one.
  await expect(slotOne.getByText("available", { exact: true })).toBeVisible();
  await expect(pool.getByRole("region", { name: "Slot 1 dependencies" })).toContainText("failed");
  await expect(pool.getByRole("region", { name: "Slot 2 dependencies" })).toContainText("never installed");
  await shoot(dashboard, bulk, "07-warm-idle-slots-cancelled");
  await bulk.getByRole("button", { name: "Dismiss" }).click();
  await expect(warms).toHaveCount(0);
});
