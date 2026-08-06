import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The dispatch form warns about the MACHINE before an agent is sent out on it.
 *
 * An operator with UpstartClaw core installed but its setup unfinished has a fleet whose
 * agents stall on Claw's `PreToolUse` gate - it refuses the plugin's own MCP calls until a
 * state file in `~/.claude` says setup completed. Nothing in Mission Control's own state can
 * explain that after the fact, so the form says it beforehand.
 *
 * This is the layer that can prove it. The unit tests drive the check against arranged deps
 * and pin the sentence per state; only here does a file in a home directory become a note in
 * a dialog - through the real route, the real fetch, and the real render - and only here can
 * "the note goes away when you fix it" be shown at all, since that depends on the route
 * re-reading the disk rather than answering from a boot-time snapshot.
 *
 * One test here does dispatch, because "the warning does not block" is not provable by reading
 * a `disabled` attribute. That launch reaches the fake `MISSION_CLAUDE_BIN` like every other
 * dispatch in this suite, so it spends no model tokens.
 */

const EVIDENCE = fileURLToPath(
  new URL("../../docs/evidence/dispatch-environment-warning/", import.meta.url),
);

/**
 * Capture the note as a reader meets it.
 *
 * Behind `MC_E2E_EVIDENCE` like every other capture in this suite: an ordinary run asserts
 * and writes nothing. The note is a new visual element in a dialog, and markup assertions
 * cannot show whether an amber block of prose reads as one - so the picture is what a
 * reviewer inspects.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control, pointer and focus: `Tooltip` opens on either, and a bubble over the
  // note would be in the picture instead of the note.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED docs/evidence/dispatch-environment-warning/${name}.png`);
}

/** Where the plugin's setup skill records how far it got, inside the daemon's isolated home. */
function stateFile(daemon: DaemonHandle): string {
  // `startDaemon` sets `HOME` to this directory (see `fixtures/daemon.ts`), and the check
  // resolves the path from `homedir()`, which follows `$HOME` on POSIX. So this is the file
  // the daemon under test will read - and the operator's real one is never touched.
  return join(daemon.home, ".claude", "upstartclaw-core-setup");
}

function writeState(daemon: DaemonHandle, value: string): void {
  mkdirSync(join(daemon.home, ".claude"), { recursive: true });
  writeFileSync(stateFile(daemon), value);
}

/** Open the Dispatch modal. The env fetch rides the modal's mount, so each open re-asks. */
async function openDispatch(page: Page) {
  // Not `{ exact: true }`: the keyboard hint renders inside the accessible name.
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDispatch(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Dispatch an agent" })).toBeHidden();
}

/** The note's own words, matched on the half that names the consequence. */
const STALL_NOTE = /stalls on its first one/;
const UNFINISHED_NOTE = /Setup was started and never finished/;

test("an unfinished UpstartClaw setup warns at dispatch time, and a finished one does not", async ({
  dashboard,
  daemon,
}) => {
  // Absence first, and it is worth asserting only because the same locator is about to be
  // shown present: a fresh isolated home has no state file and no plugin, which is what
  // every machine outside Upstart looks like. This is the "sees nothing" claim.
  let dialog = await openDispatch(dashboard);
  await expect(dialog.getByText(/UpstartClaw core setup/)).toBeHidden();
  await closeDispatch(dashboard);

  // Setup started and abandoned. Claw's gate lets tool calls through in this state, so the
  // note must say what actually goes wrong - unauthenticated servers - not claim a stall.
  writeState(daemon, "in_progress\n");
  dialog = await openDispatch(dashboard);
  const note = dialog.getByText(UNFINISHED_NOTE);
  await expect(note).toBeVisible();
  // The subject, so the reader can attribute the note to a tool they installed.
  await expect(dialog.getByText(/UpstartClaw core setup/)).toBeVisible();
  // The fix, named in the note rather than left for them to find.
  await expect(note).toContainText("/upstartclaw-core:setup");
  // And the evidence: which file was read, and what it said.
  await expect(dialog.getByText(stateFile(daemon), { exact: false })).toBeVisible();
  await shoot(dashboard, "setup-unfinished");
  await closeDispatch(dashboard);

  // The operator finishes setup. Reopening must re-read the disk - the daemon booted before
  // any of this and a cached answer would go on naming a problem they just fixed.
  writeState(daemon, "completed\n");
  dialog = await openDispatch(dashboard);
  await expect(dialog.getByText(UNFINISHED_NOTE)).toBeHidden();
  await expect(dialog.getByText(/UpstartClaw core setup/)).toBeHidden();
  await closeDispatch(dashboard);

  // And the state the gate actually blocks on, for the same live-read reason in reverse:
  // the note comes back without a restart when the machine regresses.
  writeState(daemon, "no_setup\n");
  dialog = await openDispatch(dashboard);
  await expect(dialog.getByText(STALL_NOTE)).toBeVisible();
  await shoot(dashboard, "setup-blocked");
});

test("the warning never blocks a dispatch - the agent still goes out", async ({
  dashboard,
  daemon,
}) => {
  writeState(daemon, "no_setup\n");
  const dialog = await openDispatch(dashboard);
  await expect(dialog.getByText(STALL_NOTE)).toBeVisible();

  // A filled-in form, so the footer is judged on the warning and not on an empty draft.
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the fields below and reopens on every
  // keystroke; without this the next fill lands on a covered control.
  await dashboard.keyboard.press("Escape");
  await dialog
    .getByPlaceholder("What should this agent do?")
    .fill("check the environment warning does not gate dispatch");
  // Pinned to None: the machine's default after-work Workflow refuses this un-allowlisted
  // fixture repo, and the modal would then stay open for a reason that has nothing to do
  // with the warning under test.
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  // Both footer paths remain open, with the note on screen the whole time - that pair is the
  // claim. An operator who knows their agent may stall is still allowed to send it.
  await expect(dialog.getByText(STALL_NOTE)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add to backlog" })).toBeEnabled();
  const go = dialog.getByRole("button", { name: "Dispatch now" });
  await expect(go).toBeEnabled();
  await go.click();

  // And it actually went. An enabled button proves only half of it: `submit` carries its own
  // guard list, which is exactly where a future "just refuse it while warned" would land, and
  // a form that swallowed the click would look identical up to here. The agent behind this is
  // the fake `MISSION_CLAUDE_BIN`, so the launch costs no model tokens.
  await expect(dialog).toBeHidden();
  await expect(dashboard.locator("article.card")).toHaveCount(1);
});

test("an unreadable state file is reported as its own problem", async ({ dashboard, daemon }) => {
  // A directory where the state file belongs: the daemon can open it and not read it, which
  // is the shape of every "present but unreadable" case (a permission, a broken install).
  // Reported distinctly so the operator repairs the file instead of re-running a setup that
  // may well have finished.
  const path = stateFile(daemon);
  rmSync(path, { force: true });
  mkdirSync(path, { recursive: true });

  const dialog = await openDispatch(dashboard);
  await expect(dialog.getByText(/cannot be read/)).toBeVisible();
  await expect(dialog.getByText(STALL_NOTE)).toBeHidden();
});
