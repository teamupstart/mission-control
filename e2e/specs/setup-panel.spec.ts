import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { writeGhProductScript } from "../fixtures/fake-agents.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

test.use({ daemonEnv: { MC_E2E_CONDUCTOR_STARTS_MISSING: "1" } });

test("Setup keeps the machine verdict unknown until its first reading", async ({ page, daemon }) => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/setup/checks", async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  const verdict = page.locator(".setup-verdict");
  await expect(verdict.getByRole("heading", { name: "Reading this machine..." })).toBeVisible();
  await expect(verdict.locator(".setup-verdict-mark")).toHaveClass(/is-unknown/);
  await expect(verdict.locator(".setup-verdict-mark")).toHaveText("…");
  await expect(verdict).not.toContainText("0 of 0 ready");
  await expect(verdict.getByRole("img", { name: "0 of 0 checks ready" })).toHaveCount(0);

  release();
  await expect(verdict.getByRole("heading", { name: /This machine/ })).toBeVisible();
});

test("Setup recovers when its inspection request is rejected", async ({ page, daemon }) => {
  await page.route("**/api/setup/checks", (route) => route.abort("connectionrefused"));
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  await expect(page.getByText("Mission Control could not inspect this machine's setup.")).toBeVisible();
  const recheck = page.getByRole("button", { name: "Re-check" });
  await expect(recheck).toBeEnabled();
});

test("Setup clears stale results when a re-check is rejected", async ({ page, daemon }) => {
  let rejectChecks = false;
  await page.route("**/api/setup/checks", (route) => {
    if (rejectChecks) return route.abort("connectionrefused");
    return route.continue();
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  await openSetupFamily(page, "agents");
  const claude = setupRow(page, "dependency-claude-cli");
  await expectRowStatus(page, "dependency-claude-cli", "Ready");

  rejectChecks = true;
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByText("Mission Control could not inspect this machine's setup.")).toBeVisible();
  await expect(claude).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Re-check" })).toBeEnabled();
});

test("Setup explains the machine and re-checks without executing a remedy", async ({ page, daemon }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  const scope = page.locator(".settings-panel-head .settings-scope");
  await expect(scope).toHaveText("Reads ~/");
  await scope.hover();
  await expect(page.locator(".tooltip")).toHaveText(
    "Inspects tools and configuration in your home directory without changing them.",
  );

  await openSetupFamily(page, "agents");
  const claude = setupRow(page, "dependency-claude-cli");
  await expect(claude).toContainText("Claude Code");
  await expectRowStatus(page, "dependency-claude-cli", "Ready");
  // The evidence is stated relative to this machine's home rather than repeating it. The
  // absolute path stays reachable through the row's tooltip description.
  const evidence = claude.locator(".setup-evidence");
  await expect(evidence).toHaveText(/^~\//);
  const describedBy = await evidence.getAttribute("aria-describedby");
  expect(await page.locator(`#${describedBy}`).textContent()).toContain(daemon.home);

  await openSetupFamily(page, "terminals");
  const wezterm = setupRow(page, "dependency-wezterm");
  await expect(wezterm).toContainText("Missing");
  await expect(wezterm.getByRole("button", { name: "Copy" })).toBeVisible();
  const iterm = setupRow(page, "dependency-iterm");
  await expect(iterm).toContainText("iTerm2");
  await expect(iterm.getByText("optional", { exact: true })).toBeVisible();
  await expect(iterm).toContainText("brew install --cask iterm2");
  await expect(iterm.getByRole("button", { name: "Copy" })).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("iterm-support");
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/setup-row.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/iterm-support/setup-row.png");
  }

  await openSetupFamily(page, "pipelines");
  const conductor = setupRow(page, "dependency-ai-conductor");
  await expect(conductor).toContainText("Missing");
  await expect(conductor.getByRole("link", { name: "Open Conductor settings" })).toBeVisible();

  daemon.installFakeConductor();
  await page.getByRole("button", { name: "Re-check" }).click();
  // Still on Pipelines: a Re-check reports into the family being read rather than moving the
  // rail to wherever the gaps now are.
  await expectRowStatus(page, "dependency-ai-conductor", "Ready");
  await expect(conductor).toContainText("installed-conductor/bin/conduct-ts");

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidence = artifactsDir("guided-setup");
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/setup-panel.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/guided-setup/setup-panel.png");
  }
});

test("Setup warns when the installed GitHub CLI is older than the required minimum, and clears once it is current", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);

  await openSetupFamily(page, "github");
  const gh = setupRow(page, "dependency-gh-cli");
  await expectRowStatus(page, "dependency-gh-cli", "Ready");

  writeGhProductScript(daemon.home, { preflight: "gh-version", issueCreate: "created" });
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Needs setup");
  await expect(gh).toContainText("older than the required 2.100.0");

  writeGhProductScript(daemon.home, { preflight: "ok", issueCreate: "created" });
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-gh-cli", "Ready");
});

test.describe("login-shell binaries", () => {
  test.use({
    daemonEnv: {
      MC_E2E_CONDUCTOR_STARTS_MISSING: "1",
      MC_E2E_PI_LOGIN_SHELL_ONLY: "1",
    },
  });

  test("Setup recognizes Pi installed by a login-shell version manager", async ({ page, daemon }) => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);

    await openSetupFamily(page, "agents");
    const pi = setupRow(page, "dependency-pi-cli");
    await expect(pi).toContainText("Pi");
    await expectRowStatus(page, "dependency-pi-cli", "Ready");
    await expect(pi).toContainText("login-bin/pi");
    await expect(pi.getByText("Missing", { exact: true })).not.toBeVisible();

    if (process.env.MC_E2E_EVIDENCE === "1") {
      const evidence = artifactsDir("pi-login-shell-setup");
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/pi-ready.png`, fullPage: true });
      // eslint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/pi-login-shell-setup/pi-ready.png");
    }
  });
});
