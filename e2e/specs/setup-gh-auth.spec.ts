import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base } from "../fixtures/test.ts";
import { openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Setup's GitHub authentication row when the token lives only in the login shell.
 *
 * A desktop launch inherits launchd's environment, so a `GITHUB_TOKEN` exported in `~/.zshrc`
 * signs `gh` in at a terminal while the daemon's `gh` reports no login. The daemon here has
 * no token, its `gh` is the recording fake scripted to refuse `auth status`, and its login
 * shell is a stand-in that exports one before running the daemon's read.
 */
const test = base.extend<{ loginShell: string }>({
  loginShell: async ({ playwright: _playwright }, provide) => {
    const dir = await mkdtemp(join(tmpdir(), "mission-setup-gh-auth-"));
    const shell = join(dir, "login-shell");
    await writeFile(shell, '#!/bin/sh\nGITHUB_TOKEN=fixture-shell-token\nexport GITHUB_TOKEN\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
    try { await provide(shell); }
    finally { await rm(dir, { recursive: true, force: true }); }
  },
  daemonEnv: async ({ loginShell }, provide) => {
    await provide({ SHELL: loginShell, GH_TOKEN: "", GITHUB_TOKEN: "" });
  },
});

test("GitHub authentication explains a token only the login shell sets", async ({ page, daemon }) => {
  writeFileSync(daemon.ghProductPath, JSON.stringify({
    preflight: "gh-auth",
    issueCreate: "created",
    preflightError: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
  }));
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "github");
  const row = setupRow(page, "dependency-gh-auth");
  await expect(row).toContainText("The GitHub CLI is installed but is not authenticated to github.com.");
  await expect(row).toContainText("Your login shell sets GITHUB_TOKEN, but Mission Control was not started from that shell");
  await expect(row).toContainText("env -u GITHUB_TOKEN gh auth login");
  await expect(row).not.toContainText("fixture-shell-token");
  if (process.env.MC_E2E_EVIDENCE === "1") {
    await page.mouse.move(1, 1);
    await row.screenshot({ path: join(artifactsDir("setup-gh-auth"), "login-shell-token.png") });
  }

  // Once gh holds its own login, the row is ready and the hint is gone.
  writeFileSync(daemon.ghProductPath, JSON.stringify({ preflight: "ok", issueCreate: "created" }));
  await page.getByRole("button", { name: "Re-check", exact: true }).click();
  await expect(row.getByRole("img", { name: "Ready", exact: true })).toBeVisible();
  await expect(row).not.toContainText("login shell");
});
