import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectRowStatus, openRepositorySetup, openSetupFamily } from "../fixtures/setup-panel.ts";

/** The required Setup row that passes only once at least one repository is detected. */
const REPOSITORY_CHECK = "derived-indexed-repositories";

const EVIDENCE = artifactsDir("settings-repository-index");

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.locator(".settings-pane").screenshot({
    path: `${EVIDENCE}${name}.png`,
    animations: "disabled",
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-repository-index/${name}.png`);
}

const directoryRow = (page: Page, path: string): Locator =>
  page.locator(".ri-row").filter({ has: page.getByText(path, { exact: true }) });

test.describe("config-backed repository indexing", () => {
  test.use({ daemonEnv: { MC_E2E_USE_REPO_INDEX_DEFAULTS: "1" } });

  test("seeded rows are removable, durable, restorable, and still feed dispatch", async ({
    dashboard,
    daemon,
  }) => {
    await openRepositorySetup(dashboard, daemon.baseURL);
    // Repositories is a Setup family now, not its own Settings category.
    await expect(dashboard.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
    await expect(dashboard.getByRole("tab", { name: "Repositories" })).toHaveCount(0);
    await expectRowStatus(dashboard, REPOSITORY_CHECK, "Ready");
    await expect(dashboard.locator("#setup-pane")).toContainText("At least one detected repository");

    const paths = ["~/workspace", "~/code", "~/dev", "~/upstart"];
    for (const path of paths) await expect(directoryRow(dashboard, path)).toBeVisible();
    await expect(directoryRow(dashboard, "~/workspace")).toContainText("2 repositories");
    await expect(directoryRow(dashboard, "~/dev")).toContainText("not found");
    await shoot(dashboard, "01-seeded");

    const add = dashboard.getByLabel("Directory to index");
    await add.fill("~/");
    await dashboard.getByRole("button", { name: "Add directory" }).click();
    await expect(dashboard.getByText(/is at or above your home directory/)).toBeVisible();
    await shoot(dashboard, "02-refused-path");

    const dev = directoryRow(dashboard, "~/dev");
    await dev.getByRole("button", { name: "Remove" }).click();
    await expect(dev).toHaveCount(0);
    await dashboard.reload();
    await openSetupFamily(dashboard, "repositories");
    await expect(directoryRow(dashboard, "~/dev")).toHaveCount(0);

    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    await dashboard.getByRole("button", { name: "Dispatch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    const repo = dialog.getByPlaceholder("search repos or type a path…");
    await repo.focus();
    await expect(dashboard.getByRole("option", { name: /demo-repo/ })).toBeVisible();
    await dashboard.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Close" }).click();

    await openRepositorySetup(dashboard, daemon.baseURL);
    await dashboard.getByRole("button", { name: "Restore defaults" }).click();
    await expect(directoryRow(dashboard, "~/dev")).toBeVisible();

    for (const path of paths) {
      const row = directoryRow(dashboard, path);
      await row.getByRole("button", { name: "Remove" }).click();
      await expect(row).toHaveCount(0);
    }
    await expect(dashboard.getByText("Nothing is indexed.")).toBeVisible();
    await expect(dashboard.getByText(/dispatch repo picker offers no repositories/)).toBeVisible();
    // With nothing detected, Setup does not pass: the required row is a gap, the family says
    // so on the rail, and the verdict names a required gap.
    await expectRowStatus(dashboard, REPOSITORY_CHECK, "Needs setup");
    await expect(dashboard.getByText("No directories are indexed, so no repositories can be detected.", { exact: false })).toBeVisible();
    await expect(dashboard.locator("#setup-family-repositories")).toHaveAttribute("aria-label", "Repositories: 0 of 1 ready");
    await expect(dashboard.locator(".setup-verdict")).toContainText("This machine is missing something required.");
    await shoot(dashboard, "03-empty");

    await dashboard.getByRole("button", { name: "Restore defaults" }).click();
    for (const path of paths) await expect(directoryRow(dashboard, path)).toBeVisible();
    await expectRowStatus(dashboard, REPOSITORY_CHECK, "Ready");
    await expect(dashboard.locator("#setup-family-repositories")).toHaveAttribute("aria-label", "Repositories: 1 of 1 ready");
    await shoot(dashboard, "04-restored");
  });

  test("repository indexing polls only while the Repositories family is on screen", async ({
    dashboard,
    daemon,
  }) => {
    let reads = 0;
    dashboard.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === "/api/repo-index") {
        reads += 1;
      }
    });

    await openRepositorySetup(dashboard, daemon.baseURL);
    await expect(directoryRow(dashboard, "~/workspace")).toBeVisible();

    // Another Setup family: the editor is unmounted, so nothing walks the index.
    await openSetupFamily(dashboard, "agents");
    await expect(directoryRow(dashboard, "~/workspace")).toHaveCount(0);
    reads = 0;
    await dashboard.waitForTimeout(4_500);
    expect(reads).toBe(0);

    // Another Settings category entirely.
    await dashboard.getByRole("tab", { name: "Harnesses" }).click();
    await expect(dashboard.getByRole("tab", { name: "Harnesses" }))
      .toHaveAttribute("aria-selected", "true");
    reads = 0;
    await dashboard.waitForTimeout(4_500);
    expect(reads).toBe(0);

    await dashboard.getByRole("tab", { name: "Setup" }).click();
    await openSetupFamily(dashboard, "repositories");
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(directoryRow(dashboard, "~/workspace")).toBeVisible();
  });

  test("an old Repositories settings link lands on Setup", async ({ dashboard, daemon }) => {
    await dashboard.goto(`${daemon.baseURL}/#/settings/repositories`);
    await expect(dashboard.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
    await openSetupFamily(dashboard, "repositories");
    await expect(directoryRow(dashboard, "~/workspace")).toBeVisible();
  });

  test("a missing saved path is not scanned if it later resolves above home", async ({
    dashboard,
    daemon,
  }) => {
    await openRepositorySetup(dashboard, daemon.baseURL);

    for (const path of ["~/workspace", "~/code", "~/dev", "~/upstart"]) {
      const row = directoryRow(dashboard, path);
      await row.getByRole("button", { name: "Remove" }).click();
      await expect(row).toHaveCount(0);
    }

    const deferred = join(daemon.home, "future-code");
    await dashboard.getByLabel("Directory to index").fill(deferred);
    await dashboard.getByRole("button", { name: "Add directory" }).click();
    const row = directoryRow(dashboard, deferred);
    await expect(row).toContainText("not found");

    symlinkSync(daemon.home, deferred);
    await dashboard.getByRole("button", { name: "Rescan now" }).click();

    await expect(row).toContainText("unsafe path");
    await expect(dashboard.getByText(/0 repositories indexed/)).toBeVisible();
    await shoot(dashboard, "06-deferred-unsafe");
  });
});

test.describe("environment-owned repository indexing", () => {
  test("the environment list is effective and the saved list is read-only", async ({
    dashboard,
    daemon,
  }) => {
    await openRepositorySetup(dashboard, daemon.baseURL);
    await expect(dashboard.getByText("Set by the environment.")).toBeVisible();
    await expect(dashboard.getByText(/MISSION_WORKSPACE_DIRS=/)).toBeVisible();

    const effective = directoryRow(dashboard, daemon.workspace);
    await expect(effective).toContainText("from environment");
    await expect(effective).toContainText("2 repositories");
    await expect(dashboard.getByText("Saved here, currently ignored")).toBeVisible();
    await expect(dashboard.getByLabel("Directory to index")).toHaveCount(0);
    await expect(dashboard.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(dashboard.getByRole("button", { name: "Restore defaults" })).toHaveCount(0);
    await expect(dashboard.getByRole("button", { name: "Rescan now" })).toBeEnabled();
    await expectRowStatus(dashboard, REPOSITORY_CHECK, "Ready");
    await shoot(dashboard, "05-environment-owned");
  });
});
