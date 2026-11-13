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
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
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
  // The reinstall action: the installer command, copyable, and the desktop app's button named.
  await expect(row.locator(".setup-command code")).toHaveText("npm run install-hooks");
  await expect(row.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(row).toContainText("Install Claude integrations");
  // A bridge that works is not a dead path: the louder, required row stays away.
  await expect(setupRow(dashboard, "environment-check-mission-hook-script")).toHaveCount(0);
  await shoot(dashboard, "missing-subagent-start-row", row);

  // The operator reinstalls; the current list now includes SubagentStart.
  installHooks(daemon, script, EVENTS);
  await recheck(dashboard);
  await expect(row).toHaveCount(0);
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
