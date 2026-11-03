import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SetupChecksSnapshot } from "../../src/shared/setup-catalog.ts";
import { setupInstallerShell } from "../../src/server/setup/install.ts";
import { shellCommand } from "../../src/server/terminal/shell.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Setup's Jira family: the Atlassian CLI installed, signed in, and signed in to the right site.
 *
 * The daemon's `MISSION_ACLI_BIN` points at the recording fake, whose `jira auth status`
 * answer a spec rewrites through `fake-acli-state.json`. So every reading below is the real
 * probe parsing a real subprocess, and the sign-in launch is the real route resolving the
 * real override - nothing here reaches Atlassian.
 */

test.describe.configure({ timeout: 90_000 });

function terminalRecords(recordDir: string): { argv: string[] }[] {
  return recordsIn<{ argv: string[] }>(recordDir, (file) => file.startsWith("cmux-"));
}

async function shoot(page: import("@playwright/test").Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = artifactsDir("setup-acli");
  mkdirSync(dir, { recursive: true });
  await page.mouse.move(1, 1);
  await page.screenshot({ path: join(dir, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/setup-acli/${name}.png`);
}

test("Setup checks acli's install and sign-in, and opens the sign-in for the daemon's own acli", async ({
  page,
  daemon,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = join(daemon.recordDir, "fake-acli-state.json");
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "jira");

  const cli = setupRow(page, "dependency-acli-cli");
  const auth = setupRow(page, "dependency-acli-auth");
  await expectRowStatus(page, "dependency-acli-cli", "Ready");
  await expect(cli).toContainText("Atlassian CLI");
  await expectRowStatus(page, "dependency-acli-auth", "Ready");
  await expect(auth).toContainText("Signed in to example.atlassian.net");
  // acli prints the account address beside the site. Setup shows the site only.
  await expect(page.locator("#setup-pane")).not.toContainText("operator@example.invalid");
  await shoot(page, "setup-acli-ready");

  // Signed out: the row says so and offers the sign-in, not a documentation link.
  writeFileSync(state, JSON.stringify({ unauthorized: true }));
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-acli-auth", "Needs setup");
  await expect(auth).toContainText("installed but not signed in to Jira");
  await expect(auth).toContainText("acli jira auth login --web");
  await auth.getByLabel("Terminal for Atlassian CLI sign-in").selectOption("cmux");
  const runButton = auth.getByRole("button", { name: "Run in a terminal" });
  await runButton.hover();
  await expect(page.locator(".tooltip")).toHaveText(
    "Open this daemon-owned sign-in command in the selected visible terminal",
  );

  const requestReady = page.waitForRequest((request) =>
    request.url().endsWith("/api/setup/install") && request.method() === "POST");
  await runButton.click();
  expect((await requestReady).postDataJSON()).toEqual({ id: "acli-auth", backend: "cmux" });
  await expect(auth.getByRole("status")).toContainText(
    "cmux opened the sign-in. Finish it in your browser, then read its exit code in that window.",
  );
  await expect(auth.getByRole("status")).toContainText("When the sign-in finishes, press Re-check.");
  await shoot(page, "setup-acli-sign-in-opened");

  // The terminal runs the acli the daemon resolved - the fake - never a bare `acli` the
  // terminal's PATH would pick, which on a developer's machine is the real, signed-in one.
  await expect.poll(() => terminalRecords(daemon.recordDir).length).toBe(1);
  const argv = terminalRecords(daemon.recordDir)[0]?.argv ?? [];
  expect(argv[argv.indexOf("--cwd") + 1]).toBe(daemon.home);
  const checks = await (await page.request.get(`${daemon.baseURL}/api/setup/checks`)).json() as SetupChecksSnapshot;
  const cliStatus = checks.rows.find((row) => row.rowId.id === "acli-cli")?.status;
  const resolved = cliStatus?.state === "satisfied" ? cliStatus.evidence : "";
  expect(resolved).toMatch(/\/fake-acli$/);
  expect(argv[argv.indexOf("--command") + 1]).toBe(shellCommand([
    "/bin/sh",
    "-c",
    setupInstallerShell([resolved, "jira", "auth", "login", "--web"], "sign-in"),
  ]));

  // Signed in again, to a site a configured source does not read.
  writeFileSync(state, JSON.stringify({}));
  const seeded = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, {
    data: { sources: [{
      id: "jira-acli", kind: "jira", label: "Atlassian queue", repoRoot: daemon.repo, enabled: false,
      config: { site: "other.atlassian.net", jql: "project = MC", queryVia: "acli" },
    }] },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-acli-auth", "Needs setup");
  await expect(auth).toContainText(
    "acli is signed in to example.atlassian.net, but a Jira source reads other.atlassian.net.",
  );
  await expect(auth).toContainText("acli jira auth switch --site other.atlassian.net");
  await auth.scrollIntoViewIfNeeded();
  await shoot(page, "setup-acli-site-mismatch");

  await page.setViewportSize({ width: 680, height: 900 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "the Jira rows must not create horizontal clipping",
  ).toBe(true);
});

test.describe("with acli not installed", () => {
  // An override naming a file that does not exist is how the locator reads "not here at
  // all": no fallback to PATH, so this holds on a machine where the real acli is installed.
  test.use({ daemonEnv: { MISSION_ACLI_BIN: "/nonexistent/mission-e2e/acli" } });

  test("Setup marks acli Missing and offers its install, and sign-in waits for it", async ({ page, daemon }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "jira");

    const cli = setupRow(page, "dependency-acli-cli");
    await expectRowStatus(page, "dependency-acli-cli", "Missing");
    await expect(cli).toContainText("Atlassian CLI");
    await expect(cli).toContainText("cannot sweep, check, or write back");
    await expect(cli.locator(".setup-command code")).toHaveText("brew install atlassian/acli/acli");
    await expect(cli.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(cli.getByRole("button", { name: "Run in a terminal" })).toBeEnabled();

    const auth = setupRow(page, "dependency-acli-auth");
    await expectRowStatus(page, "dependency-acli-auth", "Needs setup");
    await expect(auth).toContainText("Install the Atlassian CLI first, press Re-check, then sign in.");
    await shoot(page, "setup-acli-missing");

    // The install runs exactly the catalog's command, in the terminal the operator picks.
    await cli.getByLabel("Terminal for Atlassian CLI").selectOption("cmux");
    await cli.getByRole("button", { name: "Run in a terminal" }).click();
    await expect(cli.getByRole("status")).toContainText("cmux opened the installer.");
    await expect.poll(() => terminalRecords(daemon.recordDir).length).toBe(1);
    const argv = terminalRecords(daemon.recordDir)[0]?.argv ?? [];
    expect(argv[argv.indexOf("--command") + 1]).toBe(shellCommand([
      "/bin/sh",
      "-c",
      setupInstallerShell(["brew", "install", "atlassian/acli/acli"]),
    ]));
  });
});
