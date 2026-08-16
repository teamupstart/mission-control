import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreeInventory } from "../../src/shared/worktrees.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("settings-worktrees");

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-worktrees/${name}.png`);
}

test("Settings Worktrees configures, inventories, previews, blocks, launches, and stays bounded", async ({
  dashboard,
  daemon,
  context,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "settings evidence" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string; leaseId: string };

  // Search is one route into the same registered category. The result lands on the native
  // inventory anchor, while the direct hash below proves the bookmark grammar too.
  await dashboard.keyboard.press("Meta+k");
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("native worktree pools");
  await dashboard.getByRole("option", { name: /Native worktree pools/ }).click();
  await expect(dashboard).toHaveURL(/#\/settings\/worktrees$/);
  await expect(dashboard.getByRole("tab", { name: /Worktrees/ })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByText("Manager-owned paths only")).toBeVisible();

  const repo = dashboard.locator(".wt-repo", { hasText: "demo-repo" });
  await expect(repo).toBeVisible();
  await repo.getByRole("button", { name: /demo-repo/ }).click();
  await expect(repo.getByText(lease.path)).toBeVisible();
  await expect(repo.getByText("leased", { exact: true })).toBeVisible();

  // Capacity edits are future-only. The saved one-slot maximum leaves this live lease in
  // place, and a second open dashboard converges through the content-free SSE invalidation.
  const second = await context.newPage();
  await second.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const defaultMax = dashboard.getByLabel("Default maximum native slots");
  await defaultMax.fill("4");
  await expect.poll(async () => (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json())
    .toMatchObject({ config: { maxSlots: 4 } });
  await expect(second.getByLabel("Default maximum native slots")).toHaveValue("4");
  await second.close();

  // Clipboard feedback and terminal opening both use their established abstractions. The
  // daemon's fake cmux records the latter, so no real external window opens in this suite.
  await repo.getByRole("button", { name: "Copy path" }).click();
  await expect(repo.getByRole("button", { name: "Copied" })).toBeVisible();
  await repo.getByLabel("Terminal backend for slot 1").selectOption("cmux");
  await repo.getByRole("button", { name: "Open terminal" }).click();
  await expect.poll(() => readdirSync(daemon.recordDir).filter((name) => name.startsWith("cmux-")).length).toBe(1);

  // A clean manual lease has an actionable preview, with focus inside the dialog and the
  // fixed server-resolved path visible before execution.
  await repo.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(lease.path)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  await expect(preview.locator(":focus")).toBeVisible();
  await shoot(dashboard, "02-actionable-return-preview");
  const staleFile = join(lease.path, "appeared-after-preview.txt");
  writeFileSync(staleFile, "state changed\n");
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview.getByText("State changed after this preview.")).toBeVisible();
  await preview.getByRole("button", { name: "Refresh preview" }).click();
  await expect(preview.getByText(/Dirty or untracked work will be discarded/)).toBeVisible();
  await preview.getByRole("button", { name: "Cancel" }).click();
  unlinkSync(staleFile);

  // A process whose cwd is the leased path is an unacknowledgeable blocker. The preview
  // may name the count, never its command line, and Execute remains unavailable.
  const occupant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: lease.path,
    stdio: "ignore",
  });
  try {
    await dashboard.waitForTimeout(200);
    await repo.getByRole("button", { name: "Return", exact: true }).click();
    const blocked = dashboard.getByRole("dialog", { name: "return worktree preview" });
    await expect(blocked.getByText("Cannot execute")).toBeVisible();
    await expect(blocked.getByText(/Known processes must exit/)).toBeVisible();
    await expect(blocked.getByRole("button", { name: "Execute" })).toBeDisabled();
    await shoot(dashboard, "03-process-blocker");
    await blocked.getByRole("button", { name: "Cancel" }).click();
  } finally {
    occupant.kill("SIGKILL");
  }

  // Legacy capability is isolated from native inventory, which stays fully usable whether
  // this machine has the compatibility binary or not.
  await expect(dashboard.getByText("03 · Legacy drain", { exact: true })).toBeVisible();
  await shoot(dashboard, "01-desktop-inventory-and-legacy", true);

  // A missing binary has a direct remediation and does not erase the native ledger.
  const current = await (await dashboard.request.get(`${daemon.baseURL}/api/worktrees`)).json() as WorktreeInventory;
  const missingPage = await context.newPage();
  await missingPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      legacy: {
        capability: { kind: "missing", version: null, diagnostic: "Treehouse is not installed; install v2.1.1 or newer to drain historical leases." },
        totals: { ownedExact: 0, identityUnverifiable: 0, foreign: 0, unreadable: 0 },
        items: [],
      },
    } satisfies WorktreeInventory),
  }));
  await missingPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(missingPage.getByText(/Treehouse is not installed/)).toBeVisible();
  await expect(missingPage.getByText("Pool ledger", { exact: true })).toBeVisible();
  await missingPage.close();

  // The built panel renders the complete legacy classification vocabulary. Only an exact
  // persisted owner gets an action; unverifiable, foreign, and unreadable rows stay diagnostic.
  const legacyPage = await context.newPage();
  await legacyPage.route("**/api/worktrees", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ...current,
      legacy: {
        capability: { kind: "conditional-json", version: "v2.1.1", diagnostic: null },
        totals: { ownedExact: 1, identityUnverifiable: 1, foreign: 1, unreadable: 1 },
        items: [
          { id: "legacy-exact", classification: "ownedExact", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/exact`, owner: { kind: "task", id: "task-exact", position: 0 }, leaseId: "lease-exact", holder: "mission-control", acquiredAt: "2026-08-16T12:00:00Z", processes: { state: "known", count: 0, reason: null }, dirty: false, canReturn: true, diagnostic: null },
          { id: "legacy-unverifiable", classification: "identityUnverifiable", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/unverifiable`, owner: { kind: "task", id: "task-old", position: 0 }, leaseId: null, holder: "mission-control", acquiredAt: null, processes: { state: "unknown", count: null, reason: "identity unavailable" }, dirty: null, canReturn: false, diagnostic: "Treehouse cannot prove the historical lease identity." },
          { id: "legacy-foreign", classification: "foreign", repoRoot: daemon.repo, path: `${daemon.repo}/.trees/foreign`, owner: null, leaseId: "lease-foreign", holder: "someone-else", acquiredAt: "2026-08-16T12:00:00Z", processes: { state: "known", count: 0, reason: null }, dirty: false, canReturn: false, diagnostic: "This lease belongs to another holder." },
          { id: "legacy-unreadable", classification: "unreadable", repoRoot: daemon.repo, path: daemon.repo, owner: null, leaseId: null, holder: null, acquiredAt: null, processes: { state: "unknown", count: null, reason: "status unavailable" }, dirty: null, canReturn: false, diagnostic: "Treehouse status could not be read." },
        ],
      },
    } satisfies WorktreeInventory),
  }));
  await legacyPage.goto(`${daemon.baseURL}/#/settings/worktrees`);
  await expect(legacyPage.getByRole("button", { name: "Return legacy lease" })).toHaveCount(1);
  for (const classification of ["identityUnverifiable", "foreign", "unreadable"]) {
    await expect(legacyPage.getByText(classification, { exact: true })).toBeVisible();
  }
  await expect(legacyPage.getByText("Force", { exact: true })).toHaveCount(0);
  await shoot(legacyPage, "05-legacy-classification-gates", true);
  await legacyPage.close();

  // The page itself never overflows sideways. Slot detail owns the bounded horizontal
  // scroll at a narrow viewport, and every policy/legacy card stacks within the pane.
  await dashboard.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => dashboard.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual({ client: 390, scroll: 390 });
  await expect(repo).toBeVisible();
  await shoot(dashboard, "04-narrow-inventory", true);
});

test("refreshing a preview drops acknowledgements that the new token does not require", async ({
  dashboard,
  daemon,
}) => {
  const acquired = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
    data: { repositoryPath: daemon.repo, label: "acknowledgement refresh" },
  });
  expect(acquired.status()).toBe(201);
  const lease = await acquired.json() as { path: string };
  const dirtyFile = join(lease.path, "dirty-before-preview.txt");
  writeFileSync(dirtyFile, "preview this risk\n");

  await dashboard.goto(`${daemon.baseURL}/#/settings/worktrees`);
  const repo = dashboard.locator(".wt-repo", { hasText: "demo-repo" });
  await repo.getByRole("button", { name: /demo-repo/ }).click();
  await repo.getByRole("button", { name: "Return", exact: true }).click();
  const preview = dashboard.getByRole("dialog", { name: "return worktree preview" });
  const dirtyAcknowledgement = preview.getByRole("checkbox", {
    name: /Dirty or untracked work will be discarded/,
  });
  await dirtyAcknowledgement.check();

  unlinkSync(dirtyFile);
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview.getByText("State changed after this preview.")).toBeVisible();
  await preview.getByRole("button", { name: "Refresh preview" }).click();
  await expect(dirtyAcknowledgement).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Execute" })).toBeEnabled();
  await preview.getByRole("button", { name: "Execute" }).click();
  await expect(preview).toHaveCount(0);
});
