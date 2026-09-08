import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectRowStatus, openSetupFamily, setupRow } from "../fixtures/setup-panel.ts";

/**
 * Mission Control says when the hook bridge it installed points at a script that is gone.
 *
 * The outage, from a real machine: a checkout at `~/workspace/ai-harness` was renamed, and
 * the hooks installed from it stayed in `~/.claude/settings.json` naming the old path.
 * Claude Code went on running that path for all nine events, in every session on the
 * machine, and printed `MODULE_NOT_FOUND` with a Node loader stack into each transcript on
 * every turn. Nothing in that stack names Mission Control, the settings file, or the
 * installer that wrote the path, so the operator saw an unattributable error and Mission
 * Control saw no session state at all - for weeks.
 *
 * This is the layer that can prove the fix. `test/mission-hook-script.test.ts` drives the
 * check against arranged deps and pins each sentence; only here does a path in a real
 * settings file become a note in a real dialog and a row in the Setup panel, through the
 * real route and the real render - and only here can "it goes away when you repair it" be
 * shown, since that depends on the route re-reading the disk rather than answering from a
 * snapshot taken when the daemon booted.
 */

const EVIDENCE = artifactsDir("dispatch-hook-script-warning");

/**
 * Capture the note as a reader meets it, behind `MC_E2E_EVIDENCE` like every other capture
 * in this suite. The note is a block of amber prose in a dialog; whether it reads as one is
 * not a thing a markup assertion can answer.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/dispatch-hook-script-warning/${name}.png`);
}

/** Every event this build's installer wires, which is what a real settings file holds. */
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
];

/** Claude Code's user settings, inside the daemon's isolated home. */
function settingsPath(daemon: DaemonHandle): string {
  // `startDaemon` sets `HOME` to this directory, and the check resolves the path from
  // `homedir()`, which follows `$HOME` on POSIX. So this is the file the daemon under test
  // reads, and the operator's real one is never touched.
  return join(daemon.home, ".claude", "settings.json");
}

/** Where a checkout that has since been renamed would have put the hook script. */
function stalePath(daemon: DaemonHandle): string {
  return join(daemon.home, "workspace", "ai-harness", "hooks", "harness-hook.mjs");
}

/** Where the checkout that still exists puts it. */
function livePath(daemon: DaemonHandle): string {
  return join(daemon.home, "workspace", "mission-control", "hooks", "harness-hook.mjs");
}

/** Install the bridge for every event, pointed at `script`, exactly as the installer does. */
function installHooks(daemon: DaemonHandle, script: string, extra: Record<string, unknown> = {}): void {
  const hooks: Record<string, unknown[]> = {};
  for (const event of EVENTS) {
    const group: Record<string, unknown> = {
      hooks: [{ type: "command", command: `"/opt/homebrew/bin/node" "${script}" ${event}` }],
    };
    if (event === "PreToolUse" || event === "PostToolUse") group.matcher = "*";
    hooks[event] = [group];
  }
  mkdirSync(join(daemon.home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(daemon), JSON.stringify({ ...extra, hooks }, null, 2));
}

/** Put the script back where the settings file says it is. */
function createScript(script: string): void {
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(script, "#!/usr/bin/env node\n");
}

async function openDispatch(page: Page) {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDispatch(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Dispatch an agent" })).toBeHidden();
}

function environmentNote(dialog: Locator): Locator {
  return dialog.locator(".dispatch-env-note").filter({ hasText: "Claude Code hooks" });
}

test("a hook path that no longer resolves is named at dispatch time, and clears when repaired", async ({
  dashboard,
  daemon,
}) => {
  // Absence first, so the presence below is a change. A fresh isolated home has no
  // settings.json at all, which is what a machine that never ran the installer looks like.
  let dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog)).toBeHidden();
  await closeDispatch(dashboard);

  // The reported state: nine events wired to a checkout that has been renamed away.
  installHooks(daemon, stalePath(daemon));
  dialog = await openDispatch(dashboard);
  const note = environmentNote(dialog);
  await expect(note).toBeVisible();
  // The path, so the operator can see which of their checkouts it is.
  await expect(note).toContainText(stalePath(daemon));
  // How much of their machine is affected. Nine events, not "a hook".
  await expect(note).toContainText("9 hook events");
  // The symptom they actually saw in the transcript, so this note is connectable to it
  // rather than reading as an unrelated complaint.
  await expect(note).toContainText("MODULE_NOT_FOUND");
  // And the repair, in both the forms an operator may have installed from.
  await expect(note).toContainText("npm run install-hooks");
  await expect(note).toContainText("Install Claude integrations");
  // The evidence names the file holding the dead path, which is the file they must edit or
  // re-run the installer against.
  await expect(note).toContainText(settingsPath(daemon));
  await shoot(dashboard, "hook-script-missing");
  await closeDispatch(dashboard);

  // The operator re-runs the installer from the checkout that still exists. Reopening must
  // re-read the disk: a cached answer would go on naming a problem they just fixed, which is
  // the fastest way to teach someone to ignore this dialog.
  createScript(livePath(daemon));
  installHooks(daemon, livePath(daemon));
  dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog)).toBeHidden();
  await closeDispatch(dashboard);

  // And it comes back without a restart when the machine regresses, which is what proves the
  // absence above was the repair rather than something having silenced the check.
  rmSync(livePath(daemon));
  dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog)).toBeVisible();
});

/**
 * Somebody else's broken hook is not ours to report.
 *
 * Every machine runs this check and most of them carry hooks belonging to other tools. A
 * note about one of those is chrome the reader cannot act on, and the second time they see
 * it they stop reading notes in this dialog - including the one that would have explained
 * their outage. Driven here as well as in `test/` because silence is what a person sees,
 * and silence is invisible in a unit assertion until someone thinks to look for it.
 */
test("a broken hook belonging to another tool produces no note", async ({ dashboard, daemon }) => {
  mkdirSync(join(daemon.home, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath(daemon),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `"/bin/sh" "${join(daemon.home, "gone", "theirs.sh")}"` }] }],
      },
    }),
  );

  const dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog)).toBeHidden();
  // And the form is whole, which is the other half of "this check said nothing".
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeVisible();
});

/**
 * The same finding reaches the Setup panel, where it is a required row rather than a note.
 *
 * The dispatch note is read by whoever is dispatching right now; the panel is where someone
 * goes when they are asking what is wrong with this machine, and the banner is what brings
 * them there unprompted. An environment row exists only while its check is warning, so a
 * required row here can never nag a machine that simply chose not to install the hooks.
 */
test("the Setup panel carries the dead hook path as a required row with its remedy", async ({
  dashboard,
  daemon,
}) => {
  installHooks(daemon, stalePath(daemon));
  await dashboard.goto(`${daemon.baseURL}/#/settings/setup`);

  await openSetupFamily(dashboard, "extensions");
  const row = setupRow(dashboard, "environment-check-mission-hook-script");
  await expect(row).toContainText("Claude Code hooks");
  await expectRowStatus(dashboard, "environment-check-mission-hook-script", "Needs setup");
  await expect(row).toContainText("9 hook events");
  // The remedy the panel offers is the installer, not a skill and not a link.
  await expect(row).toContainText("npm run install-hooks");
  await shoot(dashboard, "hook-script-setup-row");

  // Repair it, re-check, and the row goes: the panel reads the machine rather than a
  // snapshot, exactly as the dispatch form does.
  createScript(livePath(daemon));
  installHooks(daemon, livePath(daemon));
  await dashboard.getByRole("button", { name: "Re-check" }).click();
  await expect(row).toBeHidden();
});
