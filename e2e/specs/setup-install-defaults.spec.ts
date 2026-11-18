import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TerminalTargetView } from "../../src/shared/terminal.ts";
import { setupInstallerShell } from "../../src/server/setup/install.ts";
import { shellCommand } from "../../src/server/terminal/shell.ts";
import { appleScriptString } from "../../src/server/terminal/applescript.ts";
import type { ItermBoundaryCall } from "../fixtures/iterm-boundary.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Setup feedback from operators installing on a fresh Mac:
 *
 *  - "Run in a terminal" started on whichever backend the registry lists first, not the
 *    terminal the operator made their macOS default.
 *  - Herdr and CodeRabbit pointed at documentation while every other CLI offered Homebrew.
 *  - CodeRabbit's sign-in was prose inside the install row instead of a step of its own, the
 *    way the Atlassian CLI's is.
 *
 * Every terminal here is the recording fake cmux, or a fulfilled route, and the CodeRabbit
 * binary is `fake-coderabbit.mjs`: nothing reaches Homebrew, CodeRabbit or a real window.
 */

test.describe.configure({ timeout: 90_000 });

function terminalRecords(recordDir: string): { argv: string[] }[] {
  return recordsIn<{ argv: string[] }>(recordDir, (file) => file.startsWith("cmux-"));
}

async function shoot(page: import("@playwright/test").Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = artifactsDir("setup-install-defaults");
  mkdirSync(dir, { recursive: true });
  await page.mouse.move(1, 1);
  await page.screenshot({ path: join(dir, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/setup-install-defaults/${name}.png`);
}

test.describe("with iTerm2 installed as the macOS default terminal", () => {
  test.use({ daemonEnv: { ITERM_BIN: "/usr/bin/true" } });

  test("the install terminal picker starts on the system default terminal", async ({ page, daemon }) => {
    // The daemon reads LaunchServices only on macOS, and this suite also runs on Linux, so the
    // reading is supplied here on top of the daemon's real catalog.
    await page.route("**/api/terminal-targets", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { targets: TerminalTargetView[] };
      const targets = body.targets.map((target) =>
        target.id === "iterm" ? { ...target, systemDefault: true } : target);
      await route.fulfill({ response, json: { targets } });
    });
    await page.route("**/api/setup/install", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, id: "wezterm", outcome: "opened", label: "iTerm2", detail: "iTerm2 opened the installer." }),
      });
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "terminals");

    const wezterm = setupRow(page, "dependency-wezterm");
    const picker = wezterm.getByLabel("Terminal for WezTerm");
    // iTerm2 is listed after the multiplexers, so it is chosen only because it is the default.
    await expect(picker).toHaveValue("iterm");
    await expect(picker.locator("option:checked")).toHaveText("iTerm2 (system default)");
    await shoot(page, "picker-starts-on-system-default");

    const requestReady = page.waitForRequest((request) =>
      request.url().endsWith("/api/setup/install") && request.method() === "POST");
    await wezterm.getByRole("button", { name: "Run in a terminal" }).click();
    expect((await requestReady).postDataJSON()).toEqual({ id: "wezterm", backend: "iterm" });
    await expect(wezterm.getByRole("status")).toContainText("iTerm2 opened the installer.");

    // The operator can still choose another terminal; the default is only where it starts.
    await picker.selectOption("cmux");
    await expect(picker).toHaveValue("cmux");
  });
});

test.describe("with iTerm2 as the default terminal and its Apple Events recorded", () => {
  // The production daemon bundle with only terminal I/O scripted: the real install route,
  // launcher and iTerm2 adapter run, and the adapter's `osascript` calls are recorded instead
  // of reaching iTerm2. See `e2e/fixtures/iterm-boundary.ts`.
  test.use({ daemonEnv: { MC_E2E_TERMINAL_BOUNDARY: "1", MC_E2E_ITERM_BOUNDARY: "1" } });

  test("Run in a terminal opens the installer through the daemon's iTerm2 adapter", async ({ page, daemon }) => {
    const recorded = join(daemon.recordDir, "iterm-osascript.jsonl");
    const calls = (): ItermBoundaryCall[] => existsSync(recorded)
      ? readFileSync(recorded, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ItermBoundaryCall)
      : [];
    await page.route("**/api/terminal-targets", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { targets: TerminalTargetView[] };
      const targets = body.targets.map((target) =>
        target.id === "iterm" ? { ...target, systemDefault: true } : target);
      await route.fulfill({ response, json: { targets } });
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "terminals");

    const wezterm = setupRow(page, "dependency-wezterm");
    const picker = wezterm.getByLabel("Terminal for WezTerm");
    await expect(picker).toHaveValue("iterm");
    // cmux is a real, enabled alternative here, listed before iTerm2.
    await expect(picker.locator('option[value="cmux"]:not([disabled])')).toHaveCount(1);
    expect(calls()).toEqual([]);

    const requestReady = page.waitForRequest((request) =>
      request.url().endsWith("/api/setup/install") && request.method() === "POST");
    await wezterm.getByRole("button", { name: "Run in a terminal" }).click();
    expect((await requestReady).postDataJSON()).toEqual({ id: "wezterm", backend: "iterm" });
    // The daemon's own outcome, not a fulfilled route: iTerm2 took the launch.
    await expect(wezterm.getByRole("status")).toContainText(
      "iTerm2 opened the installer. Watch it finish and read its exit code in that window.",
    );
    await shoot(page, "iterm-opened-installer");

    // The first Apple Event is the window the installer runs in, aimed at iTerm2's bundle,
    // running the daemon-owned install command in the operator's home.
    const launch = calls()[0];
    expect(launch?.bin).toBe("/usr/bin/osascript");
    const installer = shellCommand(["/bin/sh", "-c", setupInstallerShell(["brew", "install", "--cask", "wezterm"])]);
    const marker = shellCommand([join(daemon.home, "iterm-spawn-marker")]);
    const inner = `cd -- ${shellCommand([daemon.home])} && /usr/bin/printf '%s' "$ITERM_SESSION_ID" > ${marker} && exec ${installer}`;
    expect(launch?.script).toBe(
      `tell application id "com.googlecode.iterm2"\n` +
        `  create window with default profile command ${appleScriptString(shellCommand(["/bin/sh", "-c", inner]))}\n` +
        `end tell`,
    );
    // One window, in iTerm2 alone. cmux is usable in this fixture, so an empty cmux record is
    // proof the launch never reached it, not a refusal.
    expect(calls().filter((call) => call.script.includes("create window"))).toHaveLength(1);
    expect(recordsIn(daemon.recordDir, (file) => file.startsWith("cmux-"))).toEqual([]);
  });
});

test("without a system default the picker keeps starting on the first available terminal", async ({ page, daemon }) => {
  // Two usable terminals and no default, fixed here rather than read off the runner, so a
  // picker that took the last usable row instead of the first fails.
  const base = { glyph: "*", blurb: "", detail: null, unavailable: null };
  const targets: TerminalTargetView[] = [
    { ...base, id: "tmux", label: "tmux", unavailable: "tmux is not installed" },
    { ...base, id: "cmux", label: "cmux" },
    { ...base, id: "iterm", label: "iTerm2" },
  ];
  await page.route("**/api/terminal-targets", (route) => route.fulfill({ json: { targets } }));
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const picker = setupRow(page, "dependency-wezterm").getByLabel("Terminal for WezTerm");
  await expect(picker.locator("option:not([disabled])")).toHaveCount(2);
  await expect(picker).toHaveValue("cmux");
  await expect(picker.locator("option", { hasText: "(system default)" })).toHaveCount(0);
});

test("Herdr offers a Homebrew install instead of its installation guide", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "terminals");
  const herdr = setupRow(page, "dependency-herdr");
  await expect(herdr.locator(".setup-command code")).toHaveText("brew install herdr");
  await expect(herdr.getByRole("link", { name: "Open Herdr installation guide" })).toHaveCount(0);
  await herdr.getByLabel("Terminal for Herdr").selectOption("cmux");

  const requestReady = page.waitForRequest((request) =>
    request.url().endsWith("/api/setup/install") && request.method() === "POST");
  await herdr.getByRole("button", { name: "Run in a terminal" }).click();
  expect((await requestReady).postDataJSON()).toEqual({ id: "herdr", backend: "cmux" });
  await expect(herdr.getByRole("status")).toContainText("cmux opened the installer.");
  await expect.poll(() => terminalRecords(daemon.recordDir).length).toBe(1);
  const argv = terminalRecords(daemon.recordDir)[0]?.argv ?? [];
  expect(argv[argv.indexOf("--command") + 1]).toBe(
    shellCommand(["/bin/sh", "-c", setupInstallerShell(["brew", "install", "herdr"])]),
  );
});

test("CodeRabbit's sign-in follows its install as its own step, and opens coderabbit auth login", async ({
  page,
  daemon,
}) => {
  const script = join(daemon.home, "coderabbit-script.json");
  writeFileSync(script, JSON.stringify({ unauthenticated: true }));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "extensions");
  await page.getByRole("button", { name: "Re-check" }).click();

  const cli = setupRow(page, "dependency-coderabbit-cli");
  const auth = setupRow(page, "dependency-coderabbit-auth");
  // The sign-in is the next row after the install, not wherever the family happens to end.
  await expect(cli.locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-anchor", "setup/dependency-coderabbit-auth");
  // Installed: the install row is done even though nobody has signed in yet.
  await expectRowStatus(page, "dependency-coderabbit-cli", "Ready");
  await expect(cli).toContainText("CodeRabbit 0.9.1");
  await expectRowStatus(page, "dependency-coderabbit-auth", "Needs setup");
  await expect(auth).toContainText("CodeRabbit CLI sign-in");
  await expect(auth).toContainText("The CodeRabbit CLI is installed but not signed in.");
  await expect(auth.locator(".setup-command code")).toHaveText("coderabbit auth login");
  await auth.getByLabel("Terminal for CodeRabbit CLI sign-in").selectOption("cmux");
  await shoot(page, "coderabbit-sign-in-needed");

  const requestReady = page.waitForRequest((request) =>
    request.url().endsWith("/api/setup/install") && request.method() === "POST");
  await auth.getByRole("button", { name: "Run in a terminal" }).click();
  expect((await requestReady).postDataJSON()).toEqual({ id: "coderabbit-auth", backend: "cmux" });
  await expect(auth.getByRole("status")).toContainText(
    "cmux opened the sign-in. Finish it in your browser, then read its exit code in that window.",
  );
  await expect.poll(() => terminalRecords(daemon.recordDir).length).toBe(1);
  const argv = terminalRecords(daemon.recordDir)[0]?.argv ?? [];
  // The coderabbit the daemon resolves - the fake - never a bare `coderabbit` off PATH.
  const fake = fileURLToPath(new URL("../fixtures/fake-coderabbit.mjs", import.meta.url));
  expect(argv[argv.indexOf("--command") + 1]).toBe(
    shellCommand(["/bin/sh", "-c", setupInstallerShell(["/usr/bin/env", `HOME=${daemon.home}`, fake, "auth", "login"], "sign-in")]),
  );

  writeFileSync(script, JSON.stringify({}));
  await page.getByRole("button", { name: "Re-check" }).click();
  await expectRowStatus(page, "dependency-coderabbit-auth", "Ready");
  await expect(auth).toContainText("Stored CodeRabbit authentication is ready");
});

test("a broken CodeRabbit sign-in check reads Unknown with its reason, not signed out", async ({ page, daemon }) => {
  const script = join(daemon.home, "coderabbit-script.json");
  // `auth status --agent` exits non-zero: the CLI's sign-in state was never read.
  writeFileSync(script, JSON.stringify({ authFails: true }));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await openSetupFamily(page, "extensions");
  await page.getByRole("button", { name: "Re-check" }).click();

  const auth = setupRow(page, "dependency-coderabbit-auth");
  await expectRowStatus(page, "dependency-coderabbit-cli", "Ready");
  await expectRowStatus(page, "dependency-coderabbit-auth", "Unknown");
  await expect(auth).toContainText(
    "CodeRabbit authentication is unavailable. Run coderabbit auth login using the daemon's effective HOME.",
  );
  // Not claimed as a sign-out, and the probe's stderr never reaches the page.
  await expect(auth).not.toContainText("installed but not signed in");
  await expect(auth).not.toContainText("auth status crashed");
  await auth.scrollIntoViewIfNeeded();
  await shoot(page, "coderabbit-auth-probe-unknown");
});

test.describe("with the CodeRabbit CLI not installed", () => {
  test.use({ daemonEnv: { MISSION_CODERABBIT_BIN: "/nonexistent/coderabbit" } });

  test("CodeRabbit offers a Homebrew install, and its sign-in waits for it", async ({ page, daemon }) => {
    await page.goto(`${daemon.baseURL}/#/settings/setup`);
    await openSetupFamily(page, "extensions");
    const cli = setupRow(page, "dependency-coderabbit-cli");
    await expect(cli.locator(".setup-command code")).toHaveText("brew install --cask coderabbit");
    await expect(cli.getByRole("link", { name: "Install and authenticate CodeRabbit" })).toHaveCount(0);
    await expect(cli.getByRole("button", { name: "Run in a terminal" })).toBeVisible();
    await expect(setupRow(page, "dependency-coderabbit-auth")).toContainText(
      "Install the CodeRabbit CLI first, press Re-check, then sign in.",
    );
    await shoot(page, "coderabbit-install");
  });
});
