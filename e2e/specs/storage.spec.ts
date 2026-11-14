import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

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

/**
 * Switch the free-space floor off. Its 10 GiB default would raise a real low-space problem on
 * a machine short of disk, and these tests are about backups, not the machine running them.
 */
async function withoutFreeSpaceFloor(page: Page, daemon: DaemonHandle): Promise<void> {
  const saved = await page.request.put(`${daemon.baseURL}/api/storage/limits`, { data: { freeFloorBytes: null } });
  expect(saved.ok()).toBe(true);
}

async function openTab(page: Page, name: "Overview" | "Backups" | "Pool caches" | "Cleanup" | "Warnings"): Promise<void> {
  await page.getByRole("tablist", { name: "Storage views" }).getByRole("tab", { name }).click();
}

const NO_AGE_OR_SIZE_LIMIT = { scheduledMaxAgeDays: null, preMigrationMaxAgeDays: null, maxTotalBytes: null };

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
  await withoutFreeSpaceFloor(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByRole("tab", { name: "Storage" })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  await openTab(dashboard, "Backups");

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
  expect(stored.config).toEqual({ scheduledCount: 2, preMigrationCount: 2, intervalHours: 6, ...NO_AGE_OR_SIZE_LIMIT });

  // The saved values are what a fresh load reads back.
  await dashboard.reload();
  await openTab(dashboard, "Backups");
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
  await openTab(dashboard, "Backups");
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
  expect(stored.config).toEqual({ scheduledCount: 5, preMigrationCount: 2, intervalHours: 6, ...NO_AGE_OR_SIZE_LIMIT });
  await expect(interval).toHaveValue("6");
});

test("a save from another window reaches this page, keeps an edit in progress, and can be set back", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await openTab(dashboard, "Backups");
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
  expect(stored.config).toEqual({ scheduledCount: 5, preMigrationCount: 2, intervalHours: 1, ...NO_AGE_OR_SIZE_LIMIT });
});

test("a failed Back up now appears in Problems and clears on the next success", async ({ dashboard, daemon }) => {
  await withoutFreeSpaceFloor(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  await openTab(dashboard, "Backups");

  // A backup root the daemon refuses to write into: a symlink in place of the directory.
  const elsewhere = mkdtempSync(join(tmpdir(), "mission-storage-elsewhere-"));
  try {
    rmSync(backupRoot(daemon), { recursive: true, force: true });
    symlinkSync(elsewhere, backupRoot(daemon));
    await dashboard.getByRole("button", { name: "Back up now" }).click();
    await expect(dashboard.getByRole("alert").filter({ hasText: "Manual database backup failed" })).toBeVisible();
    await expect(dashboard.getByRole("article", { name: "Manual backups" })).toContainText("Last failure:");

    await openTab(dashboard, "Overview");
    const problems = dashboard.getByRole("list", { name: "Storage problems" });
    await expect(problems.getByRole("listitem")).toHaveCount(1);
    await expect(problems).toContainText("Backup failed");
    await expect(problems).toContainText("Manual database backup failed: Database backup root must be a real directory");
    await shoot(dashboard, "03-backup-failed");

    // Its link lands on the Backups tab, where Back up now lives.
    await problems.getByRole("button", { name: "Open backups" }).click();
    await expect(dashboard.getByRole("tab", { name: "Backups" })).toHaveAttribute("aria-selected", "true");
    await expect(dashboard.getByRole("button", { name: "Back up now" })).toBeInViewport();

    rmSync(backupRoot(daemon), { force: true });
    mkdirSync(backupRoot(daemon), { mode: 0o700 });
    await dashboard.getByRole("button", { name: "Back up now" }).click();
    await expect(dashboard.getByRole("article", { name: "Manual backups" })).toContainText("No failures recorded");
    await openTab(dashboard, "Overview");
    await expect(dashboard.getByText("No storage problems.")).toBeVisible();
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
  await openTab(dashboard, "Backups");
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

  await openTab(dashboard, "Backups");
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

// ---- disk use, limits and warnings, and the idle-cache budget ----

const MIB = 1024 ** 2;

test("Measure now fills Overview by category, and a free-space floor warns on the rail and the fleet until cleared", async ({
  dashboard,
  daemon,
}) => {
  await withoutFreeSpaceFloor(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await expect(dashboard.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();

  // The first scheduled walk is minutes away; Measure now runs one and the result streams in.
  await dashboard.getByRole("button", { name: /Measure (now|again)/ }).click();
  const categories = dashboard.getByRole("table", { name: "What is in the state directory" });
  await expect(categories).toBeVisible();
  for (const label of ["Native worktree pools", "Database backups", "Live database", "Everything else"]) {
    await expect(categories.getByRole("rowheader", { name: label })).toBeVisible();
  }
  await expect(dashboard.getByText(/Measured (just now|\d+s ago)/)).toBeVisible();
  await expect(dashboard.getByRole("img", { name: /^Volume: Mission Control/ })).toBeVisible();
  await shoot(dashboard, "04-overview");

  // A floor above any real free space: the warning starts at once, without deleting anything.
  await openTab(dashboard, "Warnings");
  const floor = dashboard.getByLabel("Free-space floor in GiB");
  await floor.fill("60000");
  await dashboard.getByRole("button", { name: "Save limits" }).click();
  await expect(dashboard.getByText("Storage limits saved. Nothing was removed.")).toBeVisible();
  await expect(dashboard.getByRole("article", { name: "Warnings now" })).toContainText("Low free space");
  await expect(dashboard.getByRole("tab", { name: /Warnings/ }).getByRole("img", { name: "A warning is standing" })).toBeVisible();
  await expect(dashboard.getByRole("tab", { name: /^Storage/ }).getByRole("img", { name: /free space is low/ })).toBeVisible();
  await shoot(dashboard, "05-warnings");

  await openTab(dashboard, "Overview");
  const problems = dashboard.getByRole("list", { name: "Storage problems" });
  await expect(problems).toContainText("Low free space");
  await expect(problems).toContainText("below your 59 TiB floor");
  await problems.getByRole("button", { name: "Open cleanup" }).click();
  await expect(dashboard.getByRole("tab", { name: /Cleanup/ })).toHaveAttribute("aria-selected", "true");

  // The fleet carries the same warning, and Dismiss hides this occurrence.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const banner = dashboard.getByRole("status", { name: "Storage warning" });
  await expect(banner).toContainText("Disk space is running low.");
  await expect(banner.getByRole("link", { name: "Open Storage" })).toHaveAttribute("href", "#/settings/storage");
  await shoot(dashboard, "06-fleet-banner");
  await banner.getByRole("button", { name: "Dismiss storage warning" }).click();
  await expect(banner).toHaveCount(0);

  // Clearing the floor ends the warning everywhere.
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await openTab(dashboard, "Warnings");
  await dashboard.getByLabel("Free-space floor in GiB").fill("");
  await dashboard.getByRole("button", { name: "Save limits" }).click();
  await expect(dashboard.getByRole("article", { name: "Warnings now" })).toContainText("None");
  await openTab(dashboard, "Overview");
  await expect(dashboard.getByText("No storage problems.")).toBeVisible();
  const stored = await (await dashboard.request.get(`${daemon.baseURL}/api/storage`)).json() as {
    health: { limits: { freeFloorBytes: number | null } };
  };
  expect(stored.health.limits.freeFloorBytes).toBeNull();
});

test("Overview names the backup space the saved limits would reclaim, and says within limits only once nothing goes", async ({
  dashboard,
  daemon,
}) => {
  await withoutFreeSpaceFloor(dashboard, daemon);
  // Five copies left above today's default count of 3, never pruned since: the saved limits
  // would delete two, so Overview must not call the backups within limits.
  seedScheduledCopies(daemon, 5);
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await dashboard.getByRole("button", { name: /Measure (now|again)/ }).click();
  const categories = dashboard.getByRole("table", { name: "What is in the state directory" });
  const backups = categories.getByRole("row").filter({ has: dashboard.getByRole("rowheader", { name: "Database backups" }) });
  await expect(backups).toContainText(/ in 2 copies/);
  await expect(backups).not.toContainText("Within limits");

  // Raising the count deletes nothing, and the same copies are now within the saved limits.
  const saved = await dashboard.request.put(`${daemon.baseURL}/api/storage/backups/config`, { data: { scheduledCount: 5 } });
  expect(saved.ok()).toBe(true);
  await expect(backups).toContainText("Within limits");
  expect(copiesOnDisk(daemon, "scheduled")).toHaveLength(5);
});

test("a save whose prune fails says the copies are still there, not that they were removed", async ({ dashboard, daemon }) => {
  await withoutFreeSpaceFloor(dashboard, daemon);
  seedScheduledCopies(daemon, 4);
  // A directory where the oldest copy's WAL sidecar would be: unlinking it fails on every
  // platform, so the prune that follows the save stops before deleting anything.
  const [oldest] = copiesOnDisk(daemon, "scheduled").sort();
  mkdirSync(join(backupRoot(daemon), `${oldest}-wal`, "held"), { recursive: true });
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await openTab(dashboard, "Backups");
  await dashboard.getByLabel("Scheduled copies kept").fill("2");
  await expect(dashboard.getByRole("list", { name: "Copies saving deletes" }).getByRole("listitem")).toHaveCount(2);

  await dashboard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dashboard.getByText(
    "Backup settings saved, but the 2 copies the new limits no longer keep could not be removed. The daemon tries again at the next backup or restart.",
  )).toBeVisible();
  await expect(dashboard.getByText("were removed", { exact: false })).toHaveCount(0);
  expect(copiesOnDisk(daemon, "scheduled").filter((name) => name.endsWith(".sqlite3"))).toHaveLength(4);
});

test("a backup size budget previews what saving deletes, then deletes exactly that, oldest first", async ({ dashboard, daemon }) => {
  // Four 200 MiB copies, sparse so the fixture costs no disk.
  mkdirSync(backupRoot(daemon), { recursive: true });
  for (let hour = 1; hour <= 4; hour += 1) {
    const path = join(backupRoot(daemon), `scheduled-20260101T0${hour}0000000Z-${String(hour).padStart(32, "a")}.sqlite3`);
    writeFileSync(path, "");
    truncateSync(path, 200 * MIB);
  }
  await dashboard.request.put(`${daemon.baseURL}/api/storage/backups/config`, { data: { scheduledCount: 4 } });
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await openTab(dashboard, "Backups");
  const alwaysKept = dashboard.getByRole("group", { name: "Always kept" });
  await expect(alwaysKept).toContainText("Newest scheduled copy");
  await expect(alwaysKept).toContainText("2 newest pre-migration copies");
  // A pre-migration count of 1 keeps only the newest, and the promise follows the count.
  const preMigrationCount = dashboard.getByLabel("Pre-migration copies kept");
  await preMigrationCount.fill("1");
  await expect(alwaysKept).toContainText("Newest pre-migration copy");
  await expect(alwaysKept).not.toContainText("2 newest pre-migration copies");
  await preMigrationCount.fill("2");
  await expect(alwaysKept).toContainText("2 newest pre-migration copies");

  // Text that is not a number never reaches Save: it would otherwise be dropped from the patch
  // and Save would report success without saving it.
  const age = dashboard.getByLabel("Scheduled maximum age in days");
  await age.fill("abc");
  await expect(dashboard.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(dashboard.getByText("ages 1 to 365 days", { exact: false })).toBeVisible();
  await age.fill("");

  await dashboard.getByLabel("Backup size budget in GiB").fill("0.5");
  const effect = dashboard.getByRole("status").filter({ hasText: "Saving deletes" });
  // The copies are sparse, so deleting them frees no disk, and the page says so rather than
  // promising their 400 MiB of file size; it names that figure as what the budget counts.
  await expect(effect).toContainText("Saving deletes 2 copies, freeing 0 B on disk.");
  await expect(effect).toContainText("Their file sizes add up to 400 MiB, which is what the size budget counts");
  await expect(effect).toContainText("Fewer copies shorten how far back you can restore.");
  // The exact copies the save deletes, named before the save, oldest first.
  const targets = dashboard.getByRole("list", { name: "Copies saving deletes" });
  await expect(targets.getByRole("listitem")).toHaveCount(2);
  await expect(targets.getByRole("listitem").nth(0)).toContainText(`scheduled-20260101T010000000Z-${"1".padStart(32, "a")}.sqlite3`);
  await expect(targets.getByRole("listitem").nth(1)).toContainText(`scheduled-20260101T020000000Z-${"2".padStart(32, "a")}.sqlite3`);
  await expect(targets).toContainText("over the size budget, oldest first");
  const keptTable = dashboard.getByRole("table", { name: "Kept copies, newest first" });
  await expect(keptTable.getByRole("columnheader", { name: "On save" })).toBeVisible();
  await expect(keptTable.getByRole("row").filter({ hasText: "Deleted" })).toHaveCount(2);
  await shoot(dashboard, "07-backup-budget");

  // A copy lands after the preview: the list shown no longer matches what the save would delete.
  const late = join(backupRoot(daemon), `scheduled-20251231T230000000Z-${"0".padStart(32, "a")}.sqlite3`);
  writeFileSync(late, "");
  truncateSync(late, 200 * MIB);
  const save = dashboard.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(dashboard.getByRole("alert").filter({ hasText: "The kept copies changed after this preview, so nothing was saved or deleted." })).toBeVisible();
  expect(readdirSync(backupRoot(daemon))).toHaveLength(5);
  // The page re-read the copies, so the list beside Save now names the late copy too.
  await expect(targets.getByRole("listitem")).toHaveCount(3);
  await expect(targets).toContainText(`scheduled-20251231T230000000Z-${"0".padStart(32, "a")}.sqlite3`);
  await shoot(dashboard, "07c-backup-stale-preview");

  await save.click();
  await expect(dashboard.getByText("Backup settings saved.", { exact: false })).toBeVisible();
  await expect.poll(() => readdirSync(backupRoot(daemon)).sort()).toEqual([
    `scheduled-20260101T030000000Z-${"3".padStart(32, "a")}.sqlite3`,
    `scheduled-20260101T040000000Z-${"4".padStart(32, "a")}.sqlite3`,
  ]);
  await expect(dashboard.getByRole("table", { name: "Kept copies, newest first" }).getByRole("row").filter({ hasText: "Scheduled" })).toHaveCount(2);
});

test("the idle-cache budget offers the least recently used idle slot, previews it in the Worktrees dialog, and removes it", async ({
  dashboard,
  daemon,
}) => {
  await withoutFreeSpaceFloor(dashboard, daemon);
  const acquire = async (label: string) => {
    const response = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/acquire`, {
      data: { repositoryPath: daemon.repo, label },
    });
    expect(response.status()).toBe(201);
    return await response.json() as { path: string; leaseId: string };
  };
  const idle = await acquire("warm cache to remove");
  const held = await acquire("session still working");
  // An ignored build cache, the kind of thing that makes a warm slot large. Ignored through the
  // repository's own exclude file, so the slot stays clean and passes the Safe prune bar.
  appendFileSync(join(daemon.repo, ".git", "info", "exclude"), "\nbuild-cache/\n");
  mkdirSync(join(idle.path, "build-cache"));
  writeFileSync(join(idle.path, "build-cache", "blob"), Buffer.alloc(300 * MIB, 1));
  const returned = await dashboard.request.post(`${daemon.baseURL}/api/worktrees/manual/return`, { data: { leaseId: idle.leaseId } });
  expect(returned.ok()).toBe(true);

  // The budget is set before anything has been measured: the first walk is minutes away.
  await dashboard.goto(`${daemon.baseURL}/#/settings/storage`);
  await openTab(dashboard, "Pool caches");
  await dashboard.getByLabel("Idle-cache budget in GiB").fill("0.25");
  await dashboard.getByLabel("Warm idle slots kept per pool").fill("0");
  await dashboard.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dashboard.getByText("Storage limits saved. Nothing was removed.")).toBeVisible();

  // Unsized, the idle slot is unknown, never reported as fitting the budget.
  await openTab(dashboard, "Cleanup");
  await expect(dashboard.getByText("1 idle slot has not been measured yet,", { exact: false })).toBeVisible();
  await expect(dashboard.getByText("Nothing is offered until the unmeasured idle slots are sized.")).toBeVisible();
  await expect(dashboard.getByText("The idle caches already fit the budget.")).toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: "Preview removal" })).toBeDisabled();
  await shoot(dashboard, "07b-cleanup-unmeasured");

  // Measure now, from right here; the plan is read again when the walk finishes.
  await dashboard.getByRole("button", { name: "Measure now" }).click();
  const remove = dashboard.getByRole("list", { name: "Idle slots to remove" });
  await expect(remove.getByRole("listitem")).toHaveCount(1);
  await expect(dashboard.getByText("has not been measured yet", { exact: false })).toHaveCount(0);

  await openTab(dashboard, "Pool caches");
  await expect(dashboard.getByRole("img", { name: /Idle caches .* against a 256 MiB budget/ })).toBeVisible();
  await expect(dashboard.getByText("Removing a warm slot makes a later session slower.")).toBeVisible();
  await shoot(dashboard, "08-pool-caches");

  await openTab(dashboard, "Cleanup");
  await expect(remove.getByRole("listitem")).toHaveCount(1);
  await expect(remove).toContainText(idle.path);
  await expect(remove).not.toContainText(held.path);
  await expect(dashboard.getByRole("group", { name: "Cleanup summary" })).toContainText("1 idle slot");
  await dashboard.getByText("Never touched here").click();
  await expect(dashboard.getByText(/1 leased slot/)).toBeVisible();
  await shoot(dashboard, "09-cleanup");

  // Another window changes the budget, and the plan cannot be read again: the old plan is
  // dropped and nothing is offered, rather than slots chosen under the old budget.
  await dashboard.route("**/api/storage/pool-caches", (route) => route.fulfill({ status: 500, body: "{}" }));
  const otherWindow = await dashboard.request.put(`${daemon.baseURL}/api/storage/limits`, { data: { poolIdleBudgetBytes: 1024 ** 3 } });
  expect(otherWindow.ok()).toBe(true);
  await expect(dashboard.getByRole("alert").filter({ hasText: "could not be read from the daemon, so nothing is offered for removal" })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Preview removal" })).toBeDisabled();
  await expect(dashboard.getByRole("list", { name: "Idle slots to remove" })).toHaveCount(0);
  // Readable again under the budget it was set back to: offered again.
  await dashboard.unroute("**/api/storage/pool-caches");
  const restored = await dashboard.request.put(`${daemon.baseURL}/api/storage/limits`, { data: { poolIdleBudgetBytes: 1024 ** 3 / 4 } });
  expect(restored.ok()).toBe(true);
  await expect(remove.getByRole("listitem")).toHaveCount(1);
  await expect(dashboard.getByRole("button", { name: "Preview removal" })).toBeEnabled();

  await dashboard.getByRole("button", { name: "Preview removal" }).click();
  const dialog = dashboard.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Remove 1 idle slot" })).toBeVisible();
  await expect(dialog).toContainText(idle.path);
  await expect(dialog).toContainText("Ignored files inside a slot are never cleaned one by one.");
  await expectContentClearsBorder(dialog);
  await shoot(dashboard, "10-remove-dialog");

  // Another window changes the budget while this preview is open: the slots it names were chosen
  // under the old budget, so it can no longer run, and Execute stays disabled until a new preview.
  let executes = 0;
  dashboard.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/worktrees/actions/execute") executes += 1;
  });
  const moved = await dashboard.request.put(`${daemon.baseURL}/api/storage/limits`, { data: { poolIdleBudgetBytes: 280 * MIB } });
  expect(moved.ok()).toBe(true);
  await expect(dialog).toContainText("State changed after this preview.");
  await expect(dialog).toContainText("The cleanup plan changed while this preview was open");
  await expect(dialog.getByRole("button", { name: "Execute" })).toBeDisabled();
  expect(executes).toBe(0);
  expect(existsSync(idle.path)).toBe(true);

  // Previewed again from the current plan, which still chooses the slot under 280 MiB, it runs.
  await dialog.getByRole("button", { name: "Refresh preview" }).click();
  await expect(dashboard.getByRole("dialog")).toHaveCount(0);
  await expect(remove.getByRole("listitem")).toHaveCount(1);
  await dashboard.getByRole("button", { name: "Preview removal" }).click();
  await expect(dialog.getByRole("heading", { name: "Remove 1 idle slot" })).toBeVisible();
  await dialog.getByRole("button", { name: "Execute" }).click();
  await expect(dashboard.getByText("Removing 1 idle slot in the background.", { exact: false })).toBeVisible();
  await expect.poll(() => existsSync(idle.path), { timeout: 30_000 }).toBe(false);
  expect(existsSync(held.path)).toBe(true);
  await expect(dashboard.getByText("The idle caches already fit the budget.")).toBeVisible({ timeout: 30_000 });
});

test("a desktop notification fires once per new warning occurrence, and never while switched off or denied", async ({
  dashboard,
  daemon,
}) => {
  // The browser's Notification, replaced so the page's own calls can be counted. Each page
  // gets the permission its test step needs.
  const stubNotifications = async (page: Page, permission: "granted" | "denied") => {
    // Plain script text rather than a function: a function is serialized from the test runner's
    // transpiled output, whose naming helpers do not exist in the page.
    await page.addInitScript({
      content: `(() => {
        const shown = [];
        Object.defineProperty(window, "__storageToasts", { configurable: true, value: shown });
        function RecordingNotification(title, options) {
          shown.push({ title, tag: options ? options.tag : undefined });
          this.onclick = null;
        }
        RecordingNotification.prototype.close = function () {};
        RecordingNotification.permission = ${JSON.stringify(permission)};
        RecordingNotification.requestPermission = () => Promise.resolve(${JSON.stringify(permission)});
        Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: RecordingNotification });
      })();`,
    });
  };
  const toasts = (page: Page) => page.evaluate(() =>
    (window as unknown as { __storageToasts: Array<{ title: string; tag: string | undefined }> }).__storageToasts);
  const settled = async (page: Page) => {
    await expect(page.getByRole("status", { name: "Storage warning" })).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const limits = async (data: Record<string, unknown>) => {
    const saved = await dashboard.request.put(`${daemon.baseURL}/api/storage/limits`, { data });
    expect(saved.ok()).toBe(true);
  };
  const HUGE_FLOOR = 60_000 * 1024 ** 3;

  await stubNotifications(dashboard, "granted");
  await limits({ desktopNotification: true, freeFloorBytes: HUGE_FLOOR });

  // A new occurrence: exactly one notification, tagged with that occurrence's id.
  // The fixture already opened the fleet, so a reload is what loads a document with the stub.
  await dashboard.reload();
  await expect.poll(async () => (await toasts(dashboard)).length).toBe(1);
  const [first] = await toasts(dashboard);
  expect(first!.title).toBe("Disk space is running low");
  expect(first!.tag).toMatch(/^low-free-space:volume:\d+$/);

  // The same occurrence still standing: a reload notifies nothing more.
  await dashboard.reload();
  await settled(dashboard);
  expect(await toasts(dashboard)).toEqual([]);

  // Switched off, a new occurrence (the floor cleared and set again) notifies nothing.
  await limits({ desktopNotification: false, freeFloorBytes: null });
  await limits({ freeFloorBytes: HUGE_FLOOR });
  await dashboard.reload();
  await settled(dashboard);
  expect(await toasts(dashboard)).toEqual([]);

  // Switched on again, but in a browser that denied notifications: still nothing. The granted
  // page is parked first, or it would take the live update and notify before this step looks.
  await dashboard.goto("about:blank");
  await limits({ desktopNotification: true });
  const denied = await dashboard.context().newPage();
  await stubNotifications(denied, "denied");
  await denied.goto(`${daemon.baseURL}/#/fleet`);
  await settled(denied);
  expect(await toasts(denied)).toEqual([]);
  await denied.close();

  // Where it is granted, that same unnotified occurrence is now due, once.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect.poll(async () => (await toasts(dashboard)).length).toBe(1);
  const [second] = await toasts(dashboard);
  expect(second!.tag).toMatch(/^low-free-space:volume:\d+$/);
  expect(second!.tag).not.toBe(first!.tag);
});
