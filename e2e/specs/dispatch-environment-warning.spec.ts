import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
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

const EVIDENCE = artifactsDir("dispatch-environment-warning");

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
  console.log(`CAPTURED e2e/.artifacts/dispatch-environment-warning/${name}.png`);
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

/** Where Claude Code keeps installed plugins, and its own record of them. */
function pluginsDir(daemon: DaemonHandle): string {
  return join(daemon.home, ".claude", "plugins");
}

/**
 * Make the fixture home look like a machine with `upstartclaw-core` installed.
 *
 * Both signals the check reads, because a real installation has both: the cache directory
 * (`cache/<marketplace>/<plugin>/<version>/`, the layout verified against a live install) and
 * Claude Code's install record. Arranged rather than assumed - the check refuses to say
 * anything about a machine that does not have the plugin, so without this every warning below
 * would correctly never appear and the spec would assert nothing.
 */
function installPlugin(daemon: DaemonHandle): void {
  mkdirSync(join(pluginsDir(daemon), "cache", "upstartclaw", "upstartclaw-core", "1.1.7"), {
    recursive: true,
  });
  writeFileSync(
    join(pluginsDir(daemon), "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "upstartclaw-core@upstartclaw": [{ scope: "user", version: "1.1.7" }] },
    }),
  );
}

/** Take the plugin away and leave its state file behind, which is what an uninstall does. */
function uninstallPlugin(daemon: DaemonHandle): void {
  rmSync(join(pluginsDir(daemon), "cache"), { recursive: true, force: true });
  writeFileSync(
    join(pluginsDir(daemon), "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: {} }),
  );
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

/** The action-first copy an operator sees for the two ordinary incomplete states. */
const SETUP_NOTE =
  "Run /upstartclaw-core:setup in an interactive Claude Code session before dispatching. UpstartClaw requires an interactive sign-in before agents can use its tools.";
const FINISH_SETUP_NOTE =
  "Finish /upstartclaw-core:setup in an interactive Claude Code session before dispatching. UpstartClaw requires its interactive sign-ins to finish before agents can reliably use its tools.";

function environmentNote(dialog: Locator, message: string): Locator {
  return dialog.locator(".dispatch-env-note").filter({ hasText: message });
}

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
  // action is to finish the interactive sign-ins rather than begin setup from scratch.
  installPlugin(daemon);
  writeState(daemon, "in_progress\n");
  dialog = await openDispatch(dashboard);
  const note = environmentNote(dialog, FINISH_SETUP_NOTE);
  await expect(note).toBeVisible();
  // The subject, so the reader can attribute the note to a tool they installed.
  await expect(dialog.getByText(/UpstartClaw core setup/)).toBeVisible();
  // Routine setup state stays concise instead of exposing its implementation detail.
  await expect(dialog.getByText(stateFile(daemon), { exact: false })).toBeHidden();
  await shoot(dashboard, "setup-unfinished");
  await closeDispatch(dashboard);

  // The operator finishes setup. Reopening must re-read the disk - the daemon booted before
  // any of this and a cached answer would go on naming a problem they just fixed.
  writeState(daemon, "completed\n");
  dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, FINISH_SETUP_NOTE)).toBeHidden();
  await expect(dialog.getByText(/UpstartClaw core setup/)).toBeHidden();
  await closeDispatch(dashboard);

  // And the state the gate actually blocks on, for the same live-read reason in reverse:
  // the note comes back without a restart when the machine regresses.
  writeState(daemon, "no_setup\n");
  dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeVisible();
  await shoot(dashboard, "setup-blocked");
});

/**
 * Uninstalling the plugin retires the note, even though its state file survives.
 *
 * Nothing deletes `~/.claude/upstartclaw-core-setup` when the plugin goes away, so a machine
 * that tried UpstartClaw and dropped it keeps a stale `no_setup` indefinitely. Warning about
 * that is a note the operator cannot act on: there is no gate left to stall on. Driven here as
 * well as in `test/` because the promise is about what the dispatch form SHOWS, and it is the
 * one the README makes to every non-Upstart machine.
 */
test("a leftover state file after an uninstall shows no note", async ({ dashboard, daemon }) => {
  installPlugin(daemon);
  writeState(daemon, "no_setup\n");

  // Present first, so the absence below is a change and not an empty assertion.
  let dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeVisible();
  await closeDispatch(dashboard);

  uninstallPlugin(daemon);

  dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeHidden();
  await expect(dialog.getByText(/UpstartClaw core setup/)).toBeHidden();
  // The file is still exactly where it was - the note went away because the plugin did, not
  // because anything cleaned up after it.
  expect(readFileSync(stateFile(daemon), "utf8")).toBe("no_setup\n");
});

/**
 * A state file the gate refuses still warns, however much it looks like a finished setup.
 *
 * `completed\r\n` - a file written with CRLF line endings - is the shape of this: UpstartClaw's
 * `STATE=$(cat …)` strips the newline and leaves the carriage return, `case` matches the bare
 * word, and the gate exits 2 on every core MCP call. A lenient comparison in the check would
 * show the operator a clean dispatch form while their fleet stalls, which is the only direction
 * of wrong this surface cannot afford. Driven here because silence is what a person would have
 * seen, and silence is invisible in a unit assertion until someone thinks to look for it.
 */
test("a state file the gate refuses still warns, CRLF and all", async ({ dashboard, daemon }) => {
  installPlugin(daemon);
  writeState(daemon, "completed\r\n");

  const dialog = await openDispatch(dashboard);
  await expect(dialog.getByText(/UpstartClaw core setup/)).toBeVisible();
  // Named as the malformed file it is - the operator's setup ran, and the fix is one character
  // to delete rather than an hour of sign-in flows.
  await expect(dialog.getByText(/whitespace/)).toBeVisible();
  // And the evidence shows the invisible character rather than hiding it, which is the whole
  // reason the detail line escapes what it prints.
  await expect(dialog.getByText(/completed\\r/)).toBeVisible();
});

/**
 * The contents of the state file do not reach the dashboard.
 *
 * The daemon reads a file it does not own, and reading is not permission to render: whatever an
 * operator has in `~/.claude/upstartclaw-core-setup` would otherwise travel through the route
 * and into this dialog. Driven here because "did not appear in the UI" is a claim about the UI,
 * and the sentinel is checked against the WHOLE page rather than the note, so it cannot hide in
 * a title, a tooltip, or an attribute.
 *
 * The note is asserted present in the same breath: a check that silently dropped the finding
 * would satisfy the redaction and hide a stall, which is the failure worth guarding against
 * once the obvious one is fixed.
 */
test("the state file's contents never reach the dialog", async ({ dashboard, daemon }) => {
  const sentinel = "sk-ant-api03-DO-NOT-RENDER-ME";
  installPlugin(daemon);
  writeState(daemon, `2026-08-06 12:33:01 INFO ${sentinel} retrying\n`);

  const dialog = await openDispatch(dashboard);
  // The finding still lands: the gate refuses this file, so the note has to say so.
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeVisible();
  await expect(dialog.getByText(/not shown here/)).toBeVisible();
  // And the path is still named, so the operator can go read the file themselves.
  await expect(dialog.getByText(stateFile(daemon), { exact: false })).toBeVisible();

  expect(await dashboard.content()).not.toContain(sentinel);
});

/**
 * A read that fails shows nothing, rather than the last answer or a broken form.
 *
 * The two failure shapes `fetchJson` folds into `null` are both driven here - a request that
 * never completes, and one that answers 500 - because this surface's policy is that a fetch
 * which did not land is indistinguishable from "nothing to report". The alternative, keeping
 * the previous answer, is the one way a note could outlive the problem it named: the operator
 * fixes their setup, the read fails, and the form still accuses them.
 *
 * The warning is made present first so neither absence below is an empty assertion.
 */
test("a failed environment read shows nothing and still lets the dispatch go", async ({
  dashboard,
  daemon,
}) => {
  installPlugin(daemon);
  writeState(daemon, "no_setup\n");

  let dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeVisible();
  await closeDispatch(dashboard);

  // A request that never completes.
  await dashboard.route("**/api/environment/checks", (route) => route.abort());
  dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeHidden();
  await expect(dialog.getByText(/UpstartClaw core setup/)).toBeHidden();
  // The form is whole: a failed optional read must not cost the operator the dialog.
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeVisible();
  await closeDispatch(dashboard);

  // And one that answers, badly. `fetchJson` folds a non-2xx into the same `null`, and the
  // route is documented as always-200, so a 500 here means the daemon is not itself.
  await dashboard.unroute("**/api/environment/checks");
  await dashboard.route("**/api/environment/checks", (route) => route.fulfill({ status: 500 }));
  dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeVisible();
  await closeDispatch(dashboard);

  // Unrouted, the note comes back - which is what proves the two absences above were the
  // failed reads and not something else having silenced the check for the rest of the test.
  await dashboard.unroute("**/api/environment/checks");
  dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeVisible();
});

test("the warning never blocks a dispatch - the agent still goes out", async ({
  dashboard,
  daemon,
}) => {
  installPlugin(daemon);
  writeState(daemon, "no_setup\n");
  const dialog = await openDispatch(dashboard);
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeVisible();

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
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeVisible();
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
  installPlugin(daemon);
  const path = stateFile(daemon);
  rmSync(path, { force: true });
  mkdirSync(path, { recursive: true });

  const dialog = await openDispatch(dashboard);
  await expect(dialog.getByText(/cannot be read/)).toBeVisible();
  await expect(environmentNote(dialog, SETUP_NOTE)).toBeHidden();
});
