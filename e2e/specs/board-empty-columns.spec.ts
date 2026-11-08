import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { dispatchedSdkHookIdentity } from "../fixtures/sdk-hook-identity.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Board's empty columns: every empty column leaves the board, "needs you" included, and the
 * stash they fold into can be switched off in Settings.
 *
 * Only a browser can settle either. "Takes no room" is laid-out geometry, not markup, and "comes
 * back when a session needs you" is a real session reaching the attention tone through the
 * daemon's own hook route and the column answering over the event stream. The stash toggle is a
 * checkbox that has to reach `app_config.ui` and then change what the Board draws after a reload.
 *
 * No model tokens: the dispatched agent is `e2e/fixtures/fake-agents.ts`.
 */

// A real permission prompt parks the dispatch's opening turn. Holding turn one open keeps the
// fake from emitting its `result` after the hook and flipping the session back to idle - the
// same reason `attention-pills-agree.spec.ts` gives.
test.use({ daemonEnv: { MC_E2E_HOLD_FIRST_TURN: "1" } });

const EVIDENCE = artifactsDir("board-empty-columns");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-empty-columns/${name}.png`);
}

function observed(what: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${what}`);
}

/**
 * One task saved straight to the Backlog. An empty Backlog leaves the board like any empty
 * column, so a spec that works the Backlog's own controls has to give it a card first.
 */
async function seedBacklogTask(daemon: DaemonHandle, title: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title, intent: title, backlog: true }),
  });
  expect(response.ok, `seeding "${title}" answered ${response.status}`).toBe(true);
}

async function putUi(daemon: DaemonHandle, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.ok, "the daemon accepted the UI patch").toBe(true);
}

async function uiConfig(daemon: DaemonHandle): Promise<Record<string, unknown>> {
  return ((await (await fetch(`${daemon.baseURL}/api/ui/config`)).json()) as {
    config: Record<string, unknown>;
  }).config;
}

/** Board layout, then a reload: the store only hydrates an out-of-band write on load. */
async function openBoard(page: Page, daemon: DaemonHandle): Promise<void> {
  await putUi(daemon, { layout: "board" });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

async function width(locator: Locator): Promise<number> {
  return locator.evaluate((node) => node.getBoundingClientRect().width);
}

async function dispatch(page: Page, daemon: DaemonHandle, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
      runtime: string;
    }[];
    return sessions.filter((session) => session.runtime === "sdk").length;
  }, { message: "the dispatched SDK session should appear before its hooks are posted", timeout: 60_000 }).toBe(1);
}

/** Post a hook exactly as `hooks/harness-hook.mjs` forwards it. */
async function postHook(
  daemon: DaemonHandle,
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ agent: "claude", ...await dispatchedSdkHookIdentity(daemon), env: {}, ...fields }),
  });
  expect(res.status, `the daemon accepted the ${event} hook`).toBe(204);
}

/** The hook a real Claude install posts when it parks on a permission prompt. */
async function parkOnPermissionPrompt(daemon: DaemonHandle): Promise<void> {
  await postHook(daemon, "Notification", { message: "Claude needs your permission to use Bash" });
}

test("an empty needs you column leaves the board and comes back when a session needs you", async ({
  dashboard: page,
  daemon,
}) => {
  // An empty fleet draws "No agent sessions detected" instead of a board, so one session
  // first. Its turn is held open, so it sits in Working and leaves needs you empty.
  await dispatch(page, daemon, "check the linter config");
  await openBoard(page, daemon);

  const board = page.locator("main.board");
  const needsYou = board.locator("section.board-col.tone-attention");
  const working = board.locator("section.board-col.tone-working");
  await expect(working.locator(".tile")).toHaveCount(1, { timeout: 30_000 });

  // ---- empty: no column, not even a slim one - only a stash chip ----
  await expect(needsYou).toHaveCount(0);
  await expect(board.getByRole("heading", { name: "needs you" })).toHaveCount(0);
  await expect(board.locator(".board-stash").getByRole("button", { name: /^needs you$/i })).toBeVisible();
  // Working is the board's first column: the empty Backlog and the empty needs you that would
  // sit before it spend no width at all.
  const boardBox = await board.boundingBox();
  const workingBox = await working.boundingBox();
  expect(boardBox && workingBox, "the board and Working are laid out").toBeTruthy();
  const gap = workingBox!.x - boardBox!.x;
  expect(gap, "no empty column sits before Working").toBeLessThan(30);
  observed(`with nothing waiting and nothing queued, Working starts ${Math.round(gap)}px from the board's left edge`);
  await shoot(page, "needs-you-hidden", board);

  // ---- a session that needs you brings the column back as a full column ----
  await parkOnPermissionPrompt(daemon);

  await expect(needsYou.locator(".tile")).toHaveCount(1, { timeout: 30_000 });
  await expect(needsYou.getByRole("heading", { name: "needs you" })).toBeVisible();
  await expect.poll(() => width(needsYou)).toBeGreaterThanOrEqual(250);
  await expect(board.locator(".board-stash-chip.tone-attention")).toHaveCount(0);
  observed(`with a session waiting needs you came back ${Math.round(await width(needsYou))}px wide`);
  await shoot(page, "needs-you-back", board);

  // ---- and leaves again when it empties, even after being widened ----
  await needsYou.locator(".board-col-head").dblclick();
  await expect(needsYou).toHaveClass(/is-wide/);
  await postHook(daemon, "UserPromptSubmit", { prompt: "carry on" });
  await expect(needsYou).toHaveCount(0, { timeout: 30_000 });
  await expect(board.locator(".board-stash-chip.tone-attention")).toBeVisible();
  observed("once nothing was waiting again, needs you left the board for the stash");
});

test("an empty Backlog leaves the board, waits in the stash, and comes back with its first task", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon, "check the linter config");
  await openBoard(page, daemon);

  const board = page.locator("main.board");
  const backlog = board.locator("section.board-backlog");
  const chip = board.locator(".board-stash").getByRole("button", { name: /^backlog$/i });
  await expect(board.locator("section.board-col.tone-working .tile")).toHaveCount(1, { timeout: 30_000 });

  // ---- empty: no column, no "Nothing queued", only a chip ----
  await expect(backlog).toHaveCount(0);
  await expect(board.getByText("Nothing queued")).toHaveCount(0);
  await expect(chip).toBeVisible();
  observed("with nothing queued the Board drew no Backlog column, only a Backlog chip in the stash");

  // ---- the chip brings it back on request, and its × puts it away again ----
  await chip.click();
  await expect(backlog).toBeVisible();
  await expect(backlog.locator(".board-col-n")).toHaveText("0");
  await backlog.getByRole("button", { name: "Hide the empty Backlog column" }).click();
  await expect(backlog).toHaveCount(0);
  await expect(chip).toBeVisible();

  // ---- the first queued task brings the column back by itself ----
  await seedBacklogTask(daemon, "Tidy the release notes");
  await expect(backlog).toBeVisible({ timeout: 30_000 });
  await expect(backlog.locator(".bl-card")).toHaveCount(1);
  await expect(chip).toHaveCount(0);
  observed("saving a task to the Backlog brought the Backlog column back with its card");
  await shoot(page, "backlog-back", board);
});

test("the empty-column stash can be switched off under Settings, Display", async ({
  dashboard: page,
  daemon,
}) => {
  // An empty fleet draws "No agent sessions detected" instead of a board, so one session
  // first. Its turn is held open, so it sits in Working and leaves needs you empty.
  await dispatch(page, daemon, "check the linter config");
  await openBoard(page, daemon);

  // ---- shipped on: the empty idle column (and the rest) fold into the stash ----
  const stash = page.locator("main.board .board-stash");
  await expect(stash).toBeVisible();
  await expect(stash.getByRole("button", { name: /^idle$/i })).toBeVisible();
  await expect(stash.getByText("empty")).toBeVisible();
  // An empty needs you is a stash chip like the rest.
  await expect(stash.getByRole("button", { name: /^needs you$/i })).toBeVisible();
  await expect(stash.getByRole("button", { name: /^backlog$/i })).toBeVisible();
  await shoot(page, "stash-on", page.locator("main.board"));

  // ---- uncheck it in Settings ----
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const toggle = page.getByRole("checkbox", { name: "Show the empty-column stash" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await uiConfig(daemon)).showEmptyColumnStash).toBe(false);
  observed("unchecking the toggle wrote app_config.ui.showEmptyColumnStash = false");

  // ---- the Board draws no stash, and the empty columns simply leave ----
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator("main.board")).toBeVisible();
  await expect(page.locator("main.board .board-stash")).toHaveCount(0);
  await expect(page.locator("main.board section.board-col.tone-attention")).toHaveCount(0);
  await expect(page.locator("main.board section.board-col.tone-idle")).toHaveCount(0);
  await expect(page.locator("main.board section.board-backlog")).toHaveCount(0);
  observed("with the stash off the Board drew no stash and no empty column, needs you and Backlog included");
  await shoot(page, "stash-off", page.locator("main.board"));

  // ---- and back on again: not a one-way door ----
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.getByRole("checkbox", { name: "Show the empty-column stash" }).check();
  await expect.poll(async () => (await uiConfig(daemon)).showEmptyColumnStash).toBe(true);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator("main.board .board-stash")).toBeVisible();
});
