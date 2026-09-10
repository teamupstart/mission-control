import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { recordsIn } from "../fixtures/records.ts";

/**
 * Pi's managed runtime, on an Amazon Bedrock model, from the picker to the terminal handoff.
 *
 * This is the one layer that can follow the whole claim. The unit suite drives the adapter
 * against a scripted Pi, and the supervisor suite proves the durable row - but neither can
 * say that an operator can SELECT `amazon-bedrock/deepseek.v3.2`, dispatch it, watch it
 * work, steer it, stop a turn, clear the conversation, survive a daemon crash, and take the
 * same conversation into a terminal. Every one of those is a click, a route, a server event
 * and a DOM change.
 *
 * ## What is faked, and why it has to be
 *
 * Pi is the only harness whose managed runtime has NO subprocess: its SDK is imported into
 * the daemon, so `MISSION_PI_BIN` - the redirection that makes every other agent free here -
 * cannot reach it. `MISSION_PI_SDK_MODULE` is the same override at the only other seam, and
 * `e2e/fixtures/fake-pi-sdk.mjs` is what every daemon in this suite points it at. That fake
 * refuses to start unless Pi's agent directory is inside the disposable home, and replaces
 * `fetch` with one that throws - so a run cannot reach AWS, cannot read the operator's
 * `~/.pi`, and cannot spend a token even if a code path tried.
 *
 * Everything else is real: the real adapter, the real supervisor, the real registry, the
 * real SQLite row, the real SSE stream, and Pi's real JSONL transcript format read back by
 * the real `piToMessage`.
 */

const EVIDENCE = artifactsDir("pi-bedrock-managed-runtime");
const BEDROCK_MODEL = "amazon-bedrock/deepseek.v3.2";
const INTENT = "summarize the repository with a Bedrock model";
const HELD_TURN = "work on this SLOWLY so it can be interrupted";
const FOLLOW_UP = "and mention flexbox";
const AFTER_CLEAR = "this belongs to the replacement conversation";
/** Comfortably inside the fake's never-settling turn, so an idle badge means the abort landed. */
const WELL_BEFORE_A_HELD_TURN_ENDS = 5_000;

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

/** What the driver asked the (fake) Pi SDK for, oldest first. */
function runtimeRequests(daemon: DaemonHandle): Array<{
  cwd: string;
  sessionPath: string | null;
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  trusted: boolean;
  toolStateHome: string | null;
}> {
  return recordsIn(join(daemon.recordDir, "pi-sdk"), (file) => file.startsWith("create-runtime-"));
}

async function sessions(daemon: DaemonHandle): Promise<
  Array<{ id: string; agentSessionId: string | null; runtime: string }>
> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  return (await response.json()) as Array<{
    id: string;
    agentSessionId: string | null;
    runtime: string;
  }>;
}

/** Every `--command` the fake cmux has been asked to open a workspace with. */
function workspaceCommands(daemon: DaemonHandle): string[] {
  return recordsIn<{ argv?: unknown }>(daemon.recordDir, (file) => file.startsWith("cmux-"))
    .map((record) => {
      if (!Array.isArray(record.argv) || record.argv[0] !== "new-workspace") return "";
      const argv = record.argv as string[];
      const at = argv.indexOf("--command");
      return at >= 0 ? (argv[at + 1] ?? "") : "";
    })
    .filter(Boolean);
}

test("a Bedrock model runs on Pi's managed runtime, through every control it offers", async ({
  dashboard,
  daemon,
}) => {
  // ---- 1. Turn the managed runtime on -------------------------------------------------
  //
  // It is not the shipped default (`DEFAULT_HARNESSES_SESSION_RUNTIMES`), which is itself
  // the first thing worth pinning: an operator opts into it, and every existing Pi dispatch
  // keeps the terminal it had.
  await dashboard.goto(`${daemon.baseURL}/#/settings`);
  await dashboard.getByRole("tab", { name: /Harnesses/ }).click();
  const runtime = dashboard.getByRole("combobox", {
    name: "Session runtime for dispatched Pi sessions",
  });
  await expect(runtime).toHaveValue("terminal");
  await runtime.selectOption("sdk");
  await expect(
    dashboard.getByText(/They run inside Mission Control on the Agent SDK/).first(),
  ).toBeVisible();
  await shoot(dashboard, "runtime-selected");

  // ---- 2. Dispatch a live Bedrock model ------------------------------------------------
  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(INTENT);
  await dialog.getByLabel("Agent").selectOption("pi");
  // By ROLE as well as name: the task field's own accessible name overlaps "Model" once it
  // carries text, and a label-only match resolves to both.
  const model = dialog.getByRole("combobox", { name: /^Model/ });
  // The provider group is Pi's own answer, not a Mission Control list: `amazon-bedrock` is
  // here because a signed-in Pi reported it.
  await expect(model.locator('optgroup[label="amazon-bedrock"]')).toHaveCount(1);
  await model.selectOption(BEDROCK_MODEL);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // ---- 3. It bound, it worked, and it went idle ----------------------------------------
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const card = dashboard.locator(".console-detail");
  const badge = card.locator("span.badge").first();
  await expect(card).toContainText("Agent SDK");
  await expect(badge).toHaveText("idle");
  // Turn one reached Pi and its answer came back through Pi's own transcript file - which is
  // the read path a pane-backed Pi session uses, working unchanged for a session with no pane.
  await expect(card.getByText(`pi answered: ${INTENT}`, { exact: false })).toBeVisible();
  // The exact provider-qualified id, on the card and in what the driver asked Pi for.
  await expect(card).toContainText("deepseek.v3.2");
  expect(runtimeRequests(daemon)[0]?.model).toEqual({
    provider: "amazon-bedrock",
    id: "deepseek.v3.2",
  });
  // A fresh conversation, not a reopened one - and Mission Control's own state home rather
  // than the daemon's, which is the isolation an in-process SDK has to apply itself.
  expect(runtimeRequests(daemon)[0]?.sessionPath).toBeNull();
  expect(runtimeRequests(daemon)[0]?.toolStateHome).toBeTruthy();
  expect(runtimeRequests(daemon)[0]?.toolStateHome).not.toBe(daemon.home);
  await shoot(dashboard, "bound-and-idle");

  const [{ id: sessionId, agentSessionId: firstConversation, runtime: reported }] =
    await sessions(daemon);
  expect(reported).toBe("sdk");
  expect(firstConversation).toBeTruthy();

  // ---- 4. A follow-up, and an interrupt that leaves the session usable -------------------
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(FOLLOW_UP);
  await composer.press("Enter");
  await expect(card.getByText(`pi answered: ${FOLLOW_UP}`, { exact: false })).toBeVisible();

  await composer.fill(HELD_TURN);
  await composer.press("Enter");
  await expect(badge).toHaveText("working");
  await shoot(dashboard, "working");
  await composer.focus();
  await composer.press("Control+c");
  // `idle`, well inside a turn the fake never settles on its own: only a turn the interrupt
  // genuinely reached can produce it.
  await expect(badge).toHaveText("idle", { timeout: WELL_BEFORE_A_HELD_TURN_ENDS });

  // Still usable afterwards, which is the whole point of an interrupt rather than a kill.
  await composer.fill("carry on");
  await composer.press("Enter");
  await expect(card.getByText("pi answered: carry on", { exact: false })).toBeVisible();
  await shoot(dashboard, "after-interrupt");

  // ---- 5. Clear the conversation --------------------------------------------------------
  //
  // Pi mints a NEW session id and a new transcript, on the same card - and Mission Control's
  // own identity is preserved, so the task, the note and the work episode move with it.
  await card.getByRole("button", { name: /reset/ }).click();
  const reset = dashboard.getByRole("dialog", { name: "Reset session to origin" });
  const confirm = reset.getByRole("button", { name: "Reset & clear" });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(reset).toBeHidden();

  await expect
    .poll(async () => (await sessions(daemon))[0]?.agentSessionId)
    .not.toBe(firstConversation);
  const [{ id: afterClearId, agentSessionId: replacement }] = await sessions(daemon);
  expect(afterClearId).toBe(sessionId);
  expect(replacement).toBeTruthy();

  // Later input belongs to the REPLACEMENT conversation: it appears in this card, and the
  // card is now keyed on the new Pi session.
  await expect(composer).toBeEnabled();
  await composer.fill(AFTER_CLEAR);
  await composer.press("Enter");
  await expect(card.getByText(`pi answered: ${AFTER_CLEAR}`, { exact: false })).toBeVisible();
  // And the conversation it replaced is gone from the card rather than merged into it.
  await expect(card.getByText(`pi answered: ${INTENT}`, { exact: false })).toHaveCount(0);
  await shoot(dashboard, "after-clear");

  // ---- 6. Survive a daemon crash --------------------------------------------------------
  //
  // The exact conversation, reopened by path through Pi's own session store - never a fresh
  // session wearing the old card, which would strand its note, goal and work episode.
  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();

  await expect
    .poll(async () => (await sessions(daemon))[0]?.agentSessionId, { timeout: 30_000 })
    .toBe(replacement);
  const resumeRequest = runtimeRequests(daemon).at(-1)!;
  expect(resumeRequest.sessionPath).toContain(`_${replacement}.jsonl`);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const restored = dashboard.locator(".console-detail");
  await expect(restored).toContainText("Agent SDK");
  await expect(restored.locator("span.badge").first()).toHaveText("idle");
  // The conversation came back with it - the same turns, read off the same file.
  await expect(restored.getByText(`pi answered: ${AFTER_CLEAR}`, { exact: false })).toBeVisible();
  await shoot(dashboard, "after-restart");

  // ---- 7. Hand the same conversation to a terminal ---------------------------------------
  //
  // The one thing a managed session genuinely takes away is a place to type, and Pi keeps
  // ONE session store behind its SDK and its CLI - so `pi --session <id>` reopens exactly
  // what this driver has been writing. That is what stops the runtime from being a trap.
  const chooser = restored.locator(".conv-launch").getByRole("button", { name: /Pi/ });
  await expect(chooser).toBeEnabled();
  await chooser.click();
  const menu = restored.getByRole("menu", { name: /resume this conversation in/ });
  const row = menu.getByRole("menuitem").filter({ hasText: "cmux" });
  await expect(row).toBeEnabled();
  await row.click();

  await expect.poll(() => workspaceCommands(daemon), { timeout: 20_000 }).toHaveLength(1);
  const [command] = workspaceCommands(daemon);
  expect(command).toContain(join(daemon.home, "fake-bin", "fake-pi"));
  // `--session`, not `--resume` (which opens Pi's interactive picker and takes no id) and
  // not `--fork` (which branches instead of continuing). Three adjacent flags, one answer.
  expect(command).toContain("'--session'");
  expect(command).toContain(`'${replacement}'`);
  expect(command).not.toContain("'--resume'");
  expect(command).not.toContain("'--fork'");
  if (process.env.MC_E2E_EVIDENCE) {
    // oxlint-disable-next-line no-console
    console.log(`OBSERVED the terminal command reopens the managed Pi conversation: ${command}`);
  }
});
