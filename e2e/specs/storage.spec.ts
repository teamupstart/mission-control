import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Settings > Storage, driven the way a person drives it.
 *
 * What only this layer proves: that the Backups band reads the daemon's real copies and config,
 * that Save reaches the route and its prune comes back to the page over `storage_health`, that
 * Back up now writes a manual copy the list then shows, and that a failed capture appears in the
 * Problems list and clears when a capture succeeds. No agent is launched, so no model tokens are
 * spent.
 */

const EVIDENCE = artifactsDir("storage");

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/storage/${name}.png`);
}

function backupRoot(daemon: DaemonHandle): string {
  return join(daemon.home, "backups", "database");
}

function copiesOnDisk(daemon: DaemonHandle, prefix: string): string[] {
  return readdirSync(backupRoot(daemon)).filter((name) => name.startsWith(`${prefix}-`));
}

/** Copies an earlier daemon generation left, above today's default count of 3. */
function seedScheduledCopies(daemon: DaemonHandle, count: number): void {
  mkdirSync(backupRoot(daemon), { recursive: true });
  for (let hour = 1; hour <= count; hour += 1) {
    const stamp = `20260101T0${hour}0000000Z`;
    writeFileSync(join(backupRoot(daemon), `scheduled-${stamp}-${String(hour).padStart(32, "a")}.sqlite3`), "seeded copy");
  }
}

test("Storage shows backup config, status and kept copies, saves counts that prune, and Back up now adds a manual copy", async ({
  dashboard,
  daemon,
}) => {
  seedScheduledCopies(daemon, 4);
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByRole("tab", { name: "Storage" })).toHaveAttribute("aria-selected", "true");

  const interval = dashboard.getByLabel("Backup interval");
  const scheduledCount = dashboard.getByLabel("Scheduled copies kept");
  const preMigrationCount = dashboard.getByLabel("Pre-migration copies kept");
  await expect(interval).toHaveValue("1");
  await expect(scheduledCount).toHaveValue("3");
  await expect(preMigrationCount).toHaveValue("2");

  const copies = dashboard.getByRole("table", { name: "Kept copies, newest first" });
  const scheduledRows = copies.getByRole("row").filter({ hasText: "Scheduled" });
  const manualRows = copies.getByRole("row").filter({ hasText: "Manual" });
  await expect(scheduledRows).toHaveCount(4);
  await expect(dashboard.getByRole("article", { name: "Manual backups" })).toContainText("Last success: Never");
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  await shoot(dashboard, "01-backups");

  // Save lowered counts and a longer interval: the prune lands on the page and on disk.
  await scheduledCount.fill("2");
  await interval.selectOption("6");
  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.getByText("Backup settings saved.", { exact: false })).toBeVisible();
  await expect(scheduledRows).toHaveCount(2);
  expect(copiesOnDisk(daemon, "scheduled")).toHaveLength(2);
  const stored = await (await dashboard.request.get(`${daemon.baseURL}/api/storage`)).json() as {
    config: { scheduledCount: number; preMigrationCount: number; intervalHours: number };
  };
  expect(stored.config).toEqual({ scheduledCount: 2, preMigrationCount: 2, intervalHours: 6 });

  // The saved values are what a fresh load reads back.
  await dashboard.reload();
  await expect(scheduledCount).toHaveValue("2");
  await expect(interval).toHaveValue("6");
  await expect(preMigrationCount).toHaveValue("2");

  // Back up now adds one manual copy, and a second keeps exactly one.
  const backUpNow = dashboard.getByRole("button", { name: "Back up now" });
  await backUpNow.click();
  await expect(dashboard.getByText("Backup taken.", { exact: false })).toBeVisible();
  await expect(manualRows).toHaveCount(1);
  await expect(dashboard.getByRole("article", { name: "Manual backups" })).not.toContainText("Last success: Never");
  const first = copiesOnDisk(daemon, "manual");
  expect(first).toHaveLength(1);
  await backUpNow.click();
  await expect.poll(() => copiesOnDisk(daemon, "manual").join()).not.toBe(first.join());
  await expect(manualRows).toHaveCount(1);
  expect(copiesOnDisk(daemon, "manual")).toHaveLength(1);
  await expect(scheduledRows).toHaveCount(2);
  await shoot(dashboard, "02-saved-and-backed-up");
});

test("Save sends only the field edited here, so a setting another window saved is not put back", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  const interval = dashboard.getByLabel("Backup interval");
  const scheduledCount = dashboard.getByLabel("Scheduled copies kept");
  await expect(interval).toHaveValue("1");

  // Another window saves a longer interval; this page still holds the config it loaded.
  const elsewhere = await dashboard.request.put(`${daemon.baseURL}/api/storage/backups/config`, {
    data: { intervalHours: 6 },
  });
  expect(elsewhere.ok()).toBe(true);

  await scheduledCount.fill("5");
  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.getByText("Backup settings saved.", { exact: false })).toBeVisible();
  const stored = await (await dashboard.request.get(`${daemon.baseURL}/api/storage`)).json() as {
    config: { scheduledCount: number; preMigrationCount: number; intervalHours: number };
  };
  expect(stored.config).toEqual({ scheduledCount: 5, preMigrationCount: 2, intervalHours: 6 });
  await expect(interval).toHaveValue("6");
});

test("a save from another window reaches this page, keeps an edit in progress, and can be set back", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  const interval = dashboard.getByLabel("Backup interval");
  const scheduledCount = dashboard.getByLabel("Scheduled copies kept");
  await expect(interval).toHaveValue("1");
  await scheduledCount.fill("5");

  const elsewhere = await dashboard.request.put(`${daemon.baseURL}/api/storage/backups/config`, {
    data: { intervalHours: 6 },
  });
  expect(elsewhere.ok()).toBe(true);
  await expect(interval).toHaveValue("6");
  await expect(scheduledCount).toHaveValue("5");

  await interval.selectOption("1");
  await dashboard.getByRole("button", { name: "Save" }).click();
  await expect(dashboard.getByText("Backup settings saved.", { exact: false })).toBeVisible();
  const stored = await (await dashboard.request.get(`${daemon.baseURL}/api/storage`)).json() as {
    config: { scheduledCount: number; preMigrationCount: number; intervalHours: number };
  };
  expect(stored.config).toEqual({ scheduledCount: 5, preMigrationCount: 2, intervalHours: 1 });
});

test("a failed Back up now appears in Problems and clears on the next success", async ({ dashboard, daemon }) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();

  // A backup root the daemon refuses to write into: a symlink in place of the directory.
  const elsewhere = mkdtempSync(join(tmpdir(), "mission-storage-elsewhere-"));
  try {
    rmSync(backupRoot(daemon), { recursive: true, force: true });
    symlinkSync(elsewhere, backupRoot(daemon));
    await dashboard.getByRole("button", { name: "Back up now" }).click();
    await expect(dashboard.getByRole("alert").filter({ hasText: "Manual database backup failed" })).toBeVisible();

    const problems = dashboard.getByRole("list", { name: "Storage problems" });
    await expect(problems.getByRole("listitem")).toHaveCount(1);
    await expect(problems).toContainText("Backup failed");
    await expect(problems).toContainText("Manual database backup failed: Database backup root must be a real directory");
    await expect(dashboard.getByRole("article", { name: "Manual backups" })).toContainText("Last failure:");
    await shoot(dashboard, "03-backup-failed");

    // Its link lands on the Backups band, where Back up now lives.
    await problems.getByRole("button", { name: "Open backups" }).click();
    await expect(dashboard.getByRole("button", { name: "Back up now" })).toBeInViewport();

    rmSync(backupRoot(daemon), { force: true });
    mkdirSync(backupRoot(daemon), { mode: 0o700 });
    await dashboard.getByRole("button", { name: "Back up now" }).click();
    await expect(dashboard.getByText("No storage problems.")).toBeVisible();
    await expect(dashboard.getByRole("article", { name: "Manual backups" })).toContainText("No failures recorded");
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

/** The daemon's real connect-time snapshot, read once off its event stream. */
async function realSnapshot(daemon: DaemonHandle): Promise<Record<string, unknown>> {
  const stream = await fetch(`${daemon.baseURL}/events`);
  expect(stream.ok).toBe(true);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE closed before its snapshot");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const data = text.split("\n").find((line) => line.startsWith("data: "))!;
  return JSON.parse(data.slice(6)) as Record<string, unknown>;
}

test("with the stream down after its snapshot, Back up now still shows the copy it took", async ({
  dashboard,
  daemon,
}) => {
  // The stream delivers one real snapshot, which carries a storage aggregate, and then never
  // reconnects: no `storage_health` frame can reach this page. The panel's re-read after the
  // write is the only way it can learn about the new copy, and it must not be outranked by the
  // older stream value.
  const snapshot = await realSnapshot(daemon);
  expect(snapshot.storageHealth).toBeTruthy();
  let streams = 0;
  await dashboard.route("**/events", (route) => {
    streams += 1;
    if (streams > 1) return route.abort();
    return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(snapshot)}\n\n` });
  });
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await dashboard.reload();
  await expect(dashboard.getByRole("tab", { name: "Storage" })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByText("No copies are kept yet.", { exact: false })).toBeVisible();

  await dashboard.getByRole("button", { name: "Back up now" }).click();
  await expect(dashboard.getByText("Backup taken.", { exact: false })).toBeVisible();
  const copies = dashboard.getByRole("table", { name: "Kept copies, newest first" });
  await expect(copies.getByRole("row").filter({ hasText: "Manual" })).toHaveCount(1);
  await expect(dashboard.getByRole("article", { name: "Manual backups" })).not.toContainText("Last success: Never");
  expect(streams).toBeGreaterThanOrEqual(1);
});

test("a slow first read that lands after Back up now's re-read never replaces the newer copies", async ({
  dashboard,
  daemon,
}) => {
  // With the stream down, only the route reads can change the page, so the order they land in
  // is the only thing deciding what it shows.
  const snapshot = await realSnapshot(daemon);
  let streams = 0;
  await dashboard.route("**/events", (route) => {
    streams += 1;
    if (streams > 1) return route.abort();
    return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(snapshot)}\n\n` });
  });
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);

  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => { held = resolve; });
  let reads = 0;
  await dashboard.route("**/api/storage", async (route) => {
    reads += 1;
    if (reads > 1) return route.continue();
    const stale = await route.fetch();
    held();
    await released;
    return route.fulfill({ response: stale });
  });
  await dashboard.reload();
  await holding;

  await dashboard.getByRole("button", { name: "Back up now" }).click();
  await expect(dashboard.getByText("Backup taken.", { exact: false })).toBeVisible();
  const manualRows = dashboard.getByRole("table", { name: "Kept copies, newest first" })
    .getByRole("row").filter({ hasText: "Manual" });
  await expect(manualRows).toHaveCount(1);

  const staleLanded = dashboard.waitForResponse((response) => new URL(response.url()).pathname === "/api/storage");
  release();
  await staleLanded;
  await dashboard.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(manualRows).toHaveCount(1);
  await expect(dashboard.getByText("No copies are kept yet.", { exact: false })).toHaveCount(0);
  // The mount read, the re-read when the stream opens (`storageConfigRevision`), and Back up now's.
  expect(reads).toBe(3);
});
