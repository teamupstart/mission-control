import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { seedRepo, type DaemonHandle } from "../fixtures/daemon.ts";
import { SETTINGS_RESTORE_CONFIRMATION } from "../../src/shared/settings-backups.ts";

/**
 * The Dispatch form's Repo picker never waits on a workspace rescan.
 *
 * Reported as "Dispatch is stuck on `indexing workspace…` and I cannot pick a repo": under
 * load the daemon's walk queues every `readdir` behind the rest of its I/O, and the form held
 * an empty picker until that walk finished. A request that never answers is the limiting case
 * of a slow one, so each case here holds the repo reads open in the browser and asserts the
 * picker is populated anyway - from the daemon's last scan, and then from the list this
 * window already has.
 */
const EVIDENCE = artifactsDir("dispatch-repo-picker-cache");

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/dispatch-repo-picker-cache/${name}.png`);
}

/** Hold matching requests open - a rescan that never finishes - until the test releases them. */
async function holdRequests(page: Page, matches: (url: URL) => boolean): Promise<() => Promise<void>> {
  const held: Route[] = [];
  await page.route(
    (url) => url.pathname === "/api/repos" && matches(url),
    (route) => {
      held.push(route);
    },
  );
  return async () => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await Promise.all(held.map((route) => route.abort().catch(() => {})));
  };
}

async function openDispatch(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectPickerListsSeededRepos(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog.getByText("indexing workspace…")).toHaveCount(0);
  await expect(dialog.getByText(/\d+ repos found - type to filter/)).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").click();
  const list = page.getByRole("listbox");
  await expect(list.getByRole("option", { name: /demo-repo/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /second-repo/ })).toBeVisible();
}

test("the Repo picker answers from the last scan while a rescan is still running", async ({ dashboard }) => {
  // Only the read that waits for a CURRENT scan is held; the daemon's last scan answers.
  const release = await holdRequests(dashboard, (url) => url.searchParams.get("rescan") === "1");
  try {
    const dialog = await openDispatch(dashboard);
    await expectPickerListsSeededRepos(dashboard, dialog);
    await shoot(dashboard, "rescan-running");
  } finally {
    await release();
  }
});

test("a reopened Dispatch form lists repos even when no repo read answers", async ({ dashboard }) => {
  // First open: the reads answer, and the window keeps what it was told.
  let dialog = await openDispatch(dashboard);
  await expectPickerListsSeededRepos(dashboard, dialog);
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Second open with the daemon unable to answer at all - the reported "stuck" state.
  const release = await holdRequests(dashboard, () => true);
  try {
    dialog = await openDispatch(dashboard);
    await expectPickerListsSeededRepos(dashboard, dialog);
    await shoot(dashboard, "reads-held");
  } finally {
    await release();
  }
});

test("a window whose repo reads all fail says the index is unavailable, not that it is empty", async ({
  dashboard,
}) => {
  // A fresh window holds no list, and the daemon cannot answer either read.
  await dashboard.route(
    (url) => url.pathname === "/api/repos",
    (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
  );
  try {
    const dialog = await openDispatch(dashboard);
    await expect(dialog.getByText("workspace index unavailable - type a path")).toBeVisible();
    await expect(dialog.getByText(/repos? found - type to filter/)).toHaveCount(0);
    await expect(dialog.getByText("indexing workspace…")).toHaveCount(0);
    await shoot(dashboard, "reads-failed-index-unavailable");
  } finally {
    await dashboard.unrouteAll({ behavior: "ignoreErrors" });
  }
});

async function closeDispatch(page: Page, dialog: Locator): Promise<void> {
  // Escape closes the portaled repo list first when it is open, then the dialog.
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 500 });
  }).toPass({ timeout: 5_000 });
}

test("a rescan that completes adds a checkout cloned since the last scan to the open picker", async ({
  dashboard,
  daemon,
}) => {
  // Prime both the daemon's scan and this window's list, without the clone.
  let dialog = await openDispatch(dashboard);
  await expectPickerListsSeededRepos(dashboard, dialog);
  await closeDispatch(dashboard, dialog);

  // Cloned on disk now - inside the cache TTL, with nothing invalidated. The ordinary read
  // on the next open answers from the scan above, so only the completed rescan can bring it.
  seedRepo(daemon.workspace, "fresh-clone");
  // The daemon reports canonical paths; the fixture's temp home may sit behind a symlink.
  const freshClone = join(realpathSync(daemon.workspace), "fresh-clone");
  const rescan = dashboard.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/repos" && new URL(response.url()).searchParams.get("rescan") === "1");
  dialog = await openDispatch(dashboard);
  expect((await (await rescan).json()) as string[]).toContain(freshClone);

  await expect(dialog.getByText("3 repos found - type to filter")).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").click();
  const option = dashboard.getByRole("listbox").getByRole("option", { name: /fresh-clone/ });
  await expect(option).toBeVisible();
  await shoot(dashboard, "rescan-added-clone");
  // Selectable, not merely listed: picking it fills the field.
  await option.click();
  await expect(dialog.getByPlaceholder("search repos or type a path…")).toHaveValue(freshClone);
});

/** Save the indexed directories from a client that is NOT the window under test. */
async function saveDirectoriesElsewhere(daemon: DaemonHandle, paths: string[]): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/repo-index`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directories: paths.map((path) => ({ path })) }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/**
 * Reopen Dispatch with every repo read held - the stalled daemon the window's list exists
 * for - and expect the picker to have let go of that list: it waits, and offers no seeded repo.
 */
async function expectListForgottenWhileReadsHeld(page: Page, evidence: string): Promise<void> {
  const release = await holdRequests(page, () => true);
  try {
    await expect(async () => {
      const reopened = await openDispatch(page);
      try {
        await expect(reopened.getByText("indexing workspace…")).toBeVisible({ timeout: 1_000 });
      } finally {
        await closeDispatch(page, reopened);
      }
    }).toPass({ timeout: 15_000 });
    const reopened = await openDispatch(page);
    await reopened.getByPlaceholder("search repos or type a path…").click();
    await expect(page.getByRole("option", { name: /demo-repo/ })).toHaveCount(0);
    await shoot(page, evidence);
    await closeDispatch(page, reopened);
  } finally {
    await release();
  }
}

/** Prime this window's list the way an operator who opened Dispatch once would have. */
async function primeWindowList(page: Page): Promise<void> {
  const dialog = await openDispatch(page);
  await expectPickerListsSeededRepos(page, dialog);
  await closeDispatch(page, dialog);
}

/**
 * Drop this window's event stream and keep it down while `whileDisconnected` runs, then let
 * it reconnect - a daemon restart is the one way to end an established stream, and the held
 * route makes sure no frame emitted meanwhile can reach the window.
 */
async function reconnectAfter(
  page: Page,
  daemon: DaemonHandle,
  whileDisconnected: () => Promise<void>,
): Promise<void> {
  const isEvents = (url: URL): boolean => url.pathname === "/events";
  await page.route(isEvents, (route) => route.abort());
  await daemon.crash();
  await daemon.restart();
  await whileDisconnected();
  const reconnected = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/events" && response.status() === 200, { timeout: 30_000 });
  await page.unroute(isEvents);
  await reconnected;
}

test.describe("with the indexed directories editable in Settings", () => {
  // The fixture otherwise pins the roots with MISSION_WORKSPACE_DIRS, which makes them
  // read-only; the seeded defaults put the same workspace under the saved config instead.
  test.use({ daemonEnv: { MC_E2E_USE_REPO_INDEX_DEFAULTS: "1" } });

  test("another window saving the directories makes this one forget its repository list", async ({
    dashboard,
    daemon,
  }) => {
    await primeWindowList(dashboard);

    // A SECOND window removes every indexed directory. This window's own code never runs.
    const other = await dashboard.context().newPage();
    try {
      await other.goto(daemon.baseURL);
      const status = await other.evaluate(async () => {
        const res = await fetch("/api/repo-index", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directories: [] }),
        });
        return res.status;
      });
      expect(status).toBe(200);
    } finally {
      await other.close();
    }

    await expectListForgottenWhileReadsHeld(dashboard, "other-window-removed-directories");
  });

  test("a Dispatch form already open stops offering repositories from a removed directory", async ({
    dashboard,
    daemon,
  }) => {
    const dialog = await openDispatch(dashboard);
    await expectPickerListsSeededRepos(dashboard, dialog);

    // Saved elsewhere while this form is on screen with its list open.
    await saveDirectoriesElsewhere(daemon, []);

    const list = dashboard.getByRole("listbox");
    await expect(dashboard.getByRole("option", { name: /demo-repo/ })).toHaveCount(0);
    await expect(list.getByRole("option", { name: /second-repo/ })).toHaveCount(0);
    // It asked again, and the index now holds nothing.
    await expect(dialog.getByText("0 repos found - type to filter")).toBeVisible();
    await shoot(dashboard, "open-form-dropped-removed-directory");
  });

  test("a reconnect keeps a list that still applies and drops one whose directories changed meanwhile", async ({
    dashboard,
    daemon,
  }) => {
    await primeWindowList(dashboard);

    // Dropped and back with nothing changed - the common case under load. The list survives.
    await reconnectAfter(dashboard, daemon, async () => {});
    const release = await holdRequests(dashboard, () => true);
    try {
      const dialog = await openDispatch(dashboard);
      await expectPickerListsSeededRepos(dashboard, dialog);
      await closeDispatch(dashboard, dialog);
    } finally {
      await release();
    }

    // Dropped again, and this time the directories are removed while the window cannot hear
    // `repo_index_changed`. The reconnect snapshot names another index, so the list goes.
    await reconnectAfter(dashboard, daemon, async () => {
      await saveDirectoriesElsewhere(daemon, []);
    });
    await expectListForgottenWhileReadsHeld(dashboard, "reconnect-after-missed-directory-change");
  });

  test("restoring settings from elsewhere makes this window forget its repository list", async ({
    dashboard,
    daemon,
  }) => {
    // A settings snapshot taken while NO directory is indexed. The daemon captures one at boot
    // when none exists, so clear the store and restart it with the empty list saved.
    await saveDirectoriesElsewhere(daemon, []);
    await daemon.crash();
    const backups = join(daemon.home, "backups", "settings");
    for (const file of readdirSync(backups).filter((name) => name.endsWith(".json"))) {
      unlinkSync(join(backups, file));
    }
    await daemon.restart();
    let snapshot: { id: string; digest: string } | undefined;
    await expect.poll(async () => {
      const response = await fetch(`${daemon.baseURL}/api/settings-backups`);
      const body = await response.json() as { snapshots: Array<{ id: string; status: string; digest?: string }> };
      const ready = body.snapshots.find((item) => item.status === "ready" && item.digest);
      snapshot = ready ? { id: ready.id, digest: ready.digest! } : undefined;
      return snapshot !== undefined;
    }, { timeout: 30_000 }).toBe(true);

    // The workspace indexed again, and this window - freshly loaded - learns its repos.
    await saveDirectoriesElsewhere(daemon, [daemon.workspace]);
    await dashboard.goto(daemon.baseURL);
    await primeWindowList(dashboard);

    // Restored by another client: this window hears only `settings_restored`.
    const restored = await fetch(`${daemon.baseURL}/api/settings-backups/${snapshot!.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedDigest: snapshot!.digest,
        requestId: randomUUID(),
        confirmation: SETTINGS_RESTORE_CONFIRMATION,
      }),
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const index = await fetch(`${daemon.baseURL}/api/repo-index`).then((r) => r.json()) as { directories: unknown[] };
    expect(index.directories, "the restore really removed the indexed directory").toHaveLength(0);

    await expectListForgottenWhileReadsHeld(dashboard, "settings-restore-removed-directories");
  });

  test("a read left over from before a directory change never prints 0 repos over the next load", async ({
    dashboard,
    daemon,
  }) => {
    // The first load's rescan stays out; once the directories change, every read is held.
    const held: Route[] = [];
    let holdAll = false;
    await dashboard.route(
      (url) => url.pathname === "/api/repos",
      (route) => {
        const rescan = new URL(route.request().url()).searchParams.get("rescan") === "1";
        if (holdAll || rescan) {
          held.push(route);
          return;
        }
        void route.continue();
      },
    );
    try {
      const dialog = await openDispatch(dashboard);
      await expectPickerListsSeededRepos(dashboard, dialog);
      await expect.poll(() => held.length).toBe(1);
      const stale = held.shift()!;

      // Saved elsewhere: a second, empty directory beside the workspace, so the index changes
      // while the same two repositories stay in it.
      holdAll = true;
      const extra = join(daemon.home, "extra-root");
      mkdirSync(extra, { recursive: true });
      await saveDirectoriesElsewhere(daemon, [daemon.workspace, extra]);
      await expect(dialog.getByText("indexing workspace…")).toBeVisible();
      await expect.poll(() => held.length).toBe(2);

      // The read from before the change now ends. It answers for nothing current: the form
      // keeps waiting for the new load instead of printing an empty index.
      const failed = dashboard.waitForEvent("requestfailed", (request) => request === stale.request());
      await stale.abort();
      await failed;
      await dashboard.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(dialog.getByText("indexing workspace…")).toBeVisible();
      await expect(dialog.getByText("0 repos found - type to filter")).toHaveCount(0);
      await shoot(dashboard, "stale-read-keeps-indexing");

      holdAll = false;
      for (const route of held.splice(0)) await route.continue();
      await expect(dialog.getByText("2 repos found - type to filter")).toBeVisible();
    } finally {
      await dashboard.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
});
