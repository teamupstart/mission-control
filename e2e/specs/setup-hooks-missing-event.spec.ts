import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Hooks installed before an event existed are told to reinstall.
 *
 * The installers write the event list they know and never re-run themselves. A machine that
 * installed the Claude hooks before `SubagentStart` was added keeps a bridge that works - every
 * installed event reports, the card's state is right - and is silent on the new event, so a
 * terminal session's background sub-agents report less than they could. Nothing fails and
 * nothing is printed, which is why the dashboard has to say it.
 *
 * Real daemon, real `~/.claude/settings.json` inside its isolated home, real route and render.
 * `test/mission-hook-script.test.ts` pins the sentences; this proves the finding becomes a row
 * a person can act on, and leaves once they have.
 */

const EVIDENCE = artifactsDir("setup-hooks-missing-event");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/setup-hooks-missing-event/${name}.png`);
}

/** Every event this build's installer wires. */
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
  "SubagentStart",
];

/** What an install from before `SubagentStart` existed left behind. */
const BEFORE_SUBAGENT_START = EVENTS.filter((event) => event !== "SubagentStart");

const ROW = "environment-check-mission-hook-events";

/** A checkout that still exists, so the bridge works and only an event is missing. */
function liveScript(daemon: DaemonHandle): string {
  const script = join(daemon.home, "workspace", "mission-control", "hooks", "harness-hook.mjs");
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(script, "#!/usr/bin/env node\n");
  return script;
}

/** Install the bridge for `events`, exactly as the installer writes them. */
function installHooks(daemon: DaemonHandle, script: string, events: string[]): void {
  const hooks: Record<string, unknown[]> = {};
  for (const event of events) {
    const group: Record<string, unknown> = {
      hooks: [{ type: "command", command: `"/opt/homebrew/bin/node" "${script}" ${event}` }],
    };
    if (event === "PreToolUse" || event === "PostToolUse") group.matcher = "*";
    hooks[event] = [group];
  }
  mkdirSync(join(daemon.home, ".claude"), { recursive: true });
  writeFileSync(join(daemon.home, ".claude", "settings.json"), JSON.stringify({ hooks }, null, 2));
}

async function recheck(page: Page): Promise<void> {
  // The dashboard read `/api/setup/checks` at startup, before this spec wrote the settings
  // file; a re-check is what makes the panel answer about the file as it is now.
  const settled = page.waitForResponse((res) => res.url().includes("/api/setup/checks"));
  await page.getByRole("button", { name: "Re-check" }).click();
  await settled;
}

test("hooks installed before SubagentStart get a Setup row with the reinstall command, which leaves once reinstalled", async ({
  dashboard,
  daemon,
}) => {
  const script = liveScript(daemon);
  installHooks(daemon, script, BEFORE_SUBAGENT_START);
  await dashboard.goto(`${daemon.baseURL}/#/settings/setup`);
  await recheck(dashboard);
  await openSetupFamily(dashboard, "extensions");

  const row = setupRow(dashboard, ROW);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Claude Code hook events");
  await expectRowStatus(dashboard, ROW, "Needs setup");
  // The event by name, and what its absence costs.
  await expect(row).toContainText("do not run for SubagentStart");
  await expect(row).toContainText("background sub-agents");
  // The evidence names the settings file the installer wrote.
  await expect(row).toContainText("settings.json");
  // Outside the desktop app there is no installer to press, so the row says where the button
  // is and keeps the checkout command copyable.
  await expect(row.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
  await expect(row).toContainText("Open Settings > Setup in the Mission Control desktop app and press Install");
  await expect(row.locator(".setup-command code")).toHaveText("npm run install-hooks");
  await expect(row.getByRole("button", { name: "Copy" })).toBeVisible();
  // The finding itself no longer tells an app user to clone anything first.
  await expect(row).not.toContainText("re-run");
  // A bridge that works is not a dead path: the louder, required row stays away.
  await expect(setupRow(dashboard, "environment-check-mission-hook-script")).toHaveCount(0);
  await shoot(dashboard, "missing-subagent-start-row", row);

  // The operator reinstalls; the current list now includes SubagentStart.
  installHooks(daemon, script, EVENTS);
  await recheck(dashboard);
  await expect(row).toHaveCount(0);
});

test("in the desktop app the row installs the hooks with one press, then leaves", async ({ page, daemon }) => {
  const script = liveScript(daemon);
  installHooks(daemon, script, BEFORE_SUBAGENT_START);
  let presses = 0;
  // The desktop bridge stands in for the shell's installer, which writes today's whole list.
  await page.exposeFunction("installHooksFixture", () => {
    presses += 1;
    if (presses === 1) return { ok: false, message: "Claude Code: hook installation needs attention." };
    installHooks(daemon, script, EVENTS);
    return { ok: true, message: "Claude integrations installed via this app's bundled Node." };
  });
  await page.addInitScript(() => Object.defineProperty(window, "missionDesktop", { value: {
    isDesktop: true,
    onOpenSettings: () => () => {},
    installIntegrations: () => (window as unknown as { installHooksFixture(): Promise<unknown> }).installHooksFixture(),
  } }));
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await recheck(page);
  await openSetupFamily(page, "extensions");

  const row = setupRow(page, ROW);
  await expectRowStatus(page, ROW, "Needs setup");
  const install = row.getByRole("button", { name: "Install", exact: true });
  await expect(install).toBeVisible();
  // No command to copy and no checkout to find: the button is the whole remedy.
  await expect(row.locator(".setup-command")).toHaveCount(0);
  await install.hover();
  await expect(page.locator(".tooltip")).toContainText("Install Mission Control's Claude Code hooks");
  await shoot(page, "missing-subagent-start-install-button", row);

  // A refused install says why, and the button stays to retry.
  await install.click();
  await expect(row.getByRole("status")).toHaveText("Claude Code: hook installation needs attention.");
  await expect(install).toBeEnabled();
  await shoot(page, "missing-subagent-start-install-refused", row);

  // The successful press re-reads the machine, so the row leaves without a Re-check.
  await install.click();
  await expect(row).toHaveCount(0);
  expect(presses).toBe(2);
});

test("a desktop installer that throws shows a retry error and keeps Install enabled", async ({ page, daemon }) => {
  const script = liveScript(daemon);
  installHooks(daemon, script, BEFORE_SUBAGENT_START);
  // The first call rejects through the bridge itself, which is distinct from a returned refusal:
  // the shell never produced a message, so the row has to supply one.
  await page.addInitScript(() => {
    let attempts = 0;
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true,
      onOpenSettings: () => () => {},
      installIntegrations: async () => {
        if (++attempts === 1) throw new Error("Synthetic desktop bridge rejection");
        return { ok: false, message: "Second attempt reached the installer." };
      },
    } });
  });
  await page.goto(`${daemon.baseURL}/#/settings/setup`);
  await recheck(page);
  await openSetupFamily(page, "extensions");

  const row = setupRow(page, ROW);
  const install = row.getByRole("button", { name: "Install", exact: true });
  await install.click();
  await expect(row.getByRole("status")).toHaveText("The install could not finish. Check the app log and retry.");
  await expect(install).toBeEnabled();
  await expect(install).toHaveText("Install");
  await shoot(page, "missing-subagent-start-install-threw", row);

  // The retry really runs again, and its own outcome replaces the earlier error.
  await install.click();
  await expect(row.getByRole("status")).toHaveText("Second attempt reached the installer.");
  await expect(install).toBeEnabled();
});

test("the dispatch form carries the same notice, and drops it once the hooks are reinstalled", async ({
  dashboard,
  daemon,
}) => {
  const script = liveScript(daemon);
  installHooks(daemon, script, BEFORE_SUBAGENT_START);

  async function openDispatch(): Promise<Locator> {
    const settled = dashboard.waitForResponse((res) => res.url().includes("/api/environment/checks"));
    await dashboard.getByRole("button", { name: "Dispatch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    await expect(dialog).toBeVisible();
    await settled;
    return dialog;
  }

  let dialog = await openDispatch();
  const note = dialog.locator(".dispatch-env-note").filter({ hasText: "Claude Code hook events" });
  await expect(note).toBeVisible();
  await expect(note).toContainText("SubagentStart");
  await expect(note).toContainText("npm run install-hooks");
  await shoot(dashboard, "missing-subagent-start-dispatch", dialog);
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  installHooks(daemon, script, EVENTS);
  dialog = await openDispatch();
  await expect(dialog.locator(".dispatch-env-note").filter({ hasText: "Claude Code hook events" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeVisible();
});

/**
 * The dispatch note is a door, not a sentence naming a settings path.
 *
 * The operator reading it is standing in a modal, and the remedy (the Install button, or the
 * command to copy) lives on a Setup row three navigations away. The note's "Fix in Setup"
 * control closes the form and lands on that exact row. Here the panel has no Setup snapshot at
 * all when the door is pressed: the door has to select the right family from the anchor alone
 * and keep it once the re-read lands, or it drops the operator on whichever family the rail
 * happens to open on.
 */
test("the dispatch notice links straight to its Setup row", async ({ dashboard, daemon }) => {
  const script = liveScript(daemon);
  installHooks(daemon, script, BEFORE_SUBAGENT_START);

  // The door must not depend on how fast the machine answers. Under load the dashboard's
  // startup Setup read can still be outstanding when the operator presses the door, and the
  // page hands the jump to the panel only until it starts waiting for the row; a panel that
  // waited for rows before choosing a family lost the jump and opened its default family.
  // Every Setup read is held here until the rail has been checked, so this spec takes that
  // path on every run instead of only on a loaded runner.
  let releaseSetupReads!: () => void;
  const setupReadsHeld = new Promise<void>((resolve) => { releaseSetupReads = resolve; });
  await dashboard.route((url) => url.pathname === "/api/setup/checks", async (route) => {
    await setupReadsHeld;
    await route.continue();
  });
  await dashboard.reload();

  const settled = dashboard.waitForResponse((res) => res.url().includes("/api/environment/checks"));
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await settled;

  const note = dialog.locator(".dispatch-env-note").filter({ hasText: "Claude Code hook events" });
  const fix = note.getByRole("button", { name: "Fix Claude Code hook events in Setup" });
  await expect(fix).toBeVisible();
  await expect(fix).toHaveText("Fix in Setup");
  await shoot(dashboard, "missing-subagent-start-dispatch-fix", note);

  await fix.click();
  await expect(dialog).toBeHidden();
  await expect(dashboard).toHaveURL(/#\/settings\/setup/);
  // The family is chosen from the anchor alone, before any row has loaded.
  await expect(dashboard.locator("#setup-family-extensions")).toHaveAttribute("aria-current", "true");
  const row = setupRow(dashboard, ROW);
  await expect(row).toHaveCount(0);
  releaseSetupReads();
  // The rows land under the family already chosen, and the waiting flash finds its row.
  await expect(dashboard.locator("#setup-family-extensions")).toHaveAttribute("aria-current", "true");
  await expect(row).toBeVisible();
  // Landed on, not merely present: the page flashes the control a deep link names. Asserted
  // first because the flash is transient (`FLASH_MS`, 3.2s from the row mounting), while
  // everything below is steady state and can be read at any time after.
  await expect(row).toHaveClass(/settings-flash/);
  await shoot(dashboard, "missing-subagent-start-setup-landing", row);
  // And the family it selected, in the rail the flash scrolled away from. Evidence runs only.
  if (process.env.MC_E2E_EVIDENCE) await dashboard.locator("#setup-family-extensions").scrollIntoViewIfNeeded();
  await shoot(dashboard, "missing-subagent-start-setup-landing-family");
  await expectRowStatus(dashboard, ROW, "Needs setup");
  await expect(row.locator(".setup-command code")).toHaveText("npm run install-hooks");
});
