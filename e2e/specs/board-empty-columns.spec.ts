import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Board's empty columns: an empty "needs you" is a slim all-clear rail, and the stash the
 * other empty columns fold into can be switched off in Settings.
 *
 * Only a browser can settle either. The rail's width is laid-out geometry, not markup; its
 * all-clear sentence is a hover a static render never fires; and "widens in place" is a real
 * session reaching the attention tone through the daemon's own hook route and the column
 * answering over the event stream. The stash toggle is a checkbox that has to reach
 * `app_config.ui` and then change what the Board draws after a reload.
 *
 * No model tokens: the dispatched agent is `e2e/fixtures/fake-agents.ts`.
 */

// A real permission prompt parks the dispatch's opening turn. Holding turn one open keeps the
// fake from emitting its `result` after the hook and flipping the session back to idle - the
// same reason `attention-pills-agree.spec.ts` gives.
test.use({ daemonEnv: { MC_E2E_HOLD_FIRST_TURN: "1" } });

const EVIDENCE = artifactsDir("board-empty-columns");

/** The rail may not be wider than this. It is 34px; the slack is for a border rounding. */
const RAIL_MAX = 40;

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
}

/** The one SDK session this spec dispatched: its checkout is what binds a hook to it. */
async function dispatchedCwd(daemon: DaemonHandle): Promise<string> {
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as {
    cwd: string;
    runtime: string;
  }[];
  const dispatched = sessions.filter((s) => s.runtime === "sdk");
  expect(dispatched.length, "exactly one SDK session was dispatched").toBe(1);
  return dispatched[0]!.cwd;
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
    body: JSON.stringify({ agent: "claude", cwd: await dispatchedCwd(daemon), env: {}, ...fields }),
  });
  expect(res.status, `the daemon accepted the ${event} hook`).toBe(204);
}

/** The hook a real Claude install posts when it parks on a permission prompt. */
async function parkOnPermissionPrompt(daemon: DaemonHandle): Promise<void> {
  await postHook(daemon, "Notification", { message: "Claude needs your permission to use Bash" });
}

test("an empty needs you column is a slim all-clear rail that widens in place when a session needs you", async ({
  dashboard: page,
  daemon,
}) => {
  // An empty fleet draws "No agent sessions detected" instead of a board, so one session
  // first. Its turn is held open, so it sits in Working and leaves needs you empty.
  await dispatch(page, daemon, "check the linter config");
  await openBoard(page, daemon);

  const needsYou = page.locator("main.board section.board-col.tone-attention");
  await expect(needsYou).toBeVisible();
  await expect(needsYou.getByRole("heading", { name: "needs you" })).toBeVisible();
  await expect(needsYou.locator(".board-col-n")).toHaveText("0");

  // ---- thin, not 250px ----
  await expect.poll(() => width(needsYou)).toBeLessThanOrEqual(RAIL_MAX);
  observed(`the empty needs you column drew ${Math.round(await width(needsYou))}px wide`);

  // No widen control on a column with nothing to read wider.
  await expect(needsYou.getByRole("button", { name: /widen|narrow/i })).toHaveCount(0);

  // ---- the all-clear sentence is on hover, anywhere down the rail's blank middle ----
  // `Tooltip` merges its handlers onto `.board-allclear` rather than wrapping it, so that
  // element is the rail's flex item and takes the spare height. Hovered at a point well
  // below the tick and above the count, which is blank rail, not the glyph.
  const tick = await needsYou.locator(".board-allclear-tick").boundingBox();
  const count = await needsYou.locator(".board-col-n").boundingBox();
  expect(tick && count, "the tick and the count are laid out").toBeTruthy();
  const blank = {
    x: tick!.x + tick!.width / 2,
    y: (tick!.y + tick!.height + count!.y) / 2,
  };
  expect(count!.y - (tick!.y + tick!.height), "there is blank rail between tick and count")
    .toBeGreaterThan(100);
  const allClear = await needsYou.locator(".board-allclear").boundingBox();
  expect(blank.y, "the hover target reaches the blank middle").toBeGreaterThan(allClear!.y);
  expect(blank.y).toBeLessThan(allClear!.y + allClear!.height);
  await page.mouse.move(blank.x, blank.y);
  await expect(page.locator(".tooltip")).toHaveText("All clear. Nothing is waiting on you.");
  observed(
    `hovering blank rail at y=${Math.round(blank.y)} (tick ends ${Math.round(tick!.y + tick!.height)}, ` +
      `count starts ${Math.round(count!.y)}) shows: All clear. Nothing is waiting on you.`,
  );
  await shoot(page, "slim-rail", page.locator("main.board"));

  // ---- a session that needs you widens it in place ----
  await parkOnPermissionPrompt(daemon);

  await expect(needsYou.locator(".tile")).toHaveCount(1, { timeout: 30_000 });
  await expect(needsYou).not.toHaveClass(/is-calm/);
  await expect(needsYou.locator(".board-allclear")).toHaveCount(0);
  await expect.poll(() => width(needsYou)).toBeGreaterThanOrEqual(250);
  observed(`with a session waiting it widened to ${Math.round(await width(needsYou))}px`);
  await shoot(page, "widened", page.locator("main.board"));

  // ---- a column widened while full returns to the rail when it empties ----
  // The widen gesture is remembered across the column emptying, and the wide rule outranks
  // the rail's width, so an all-clear rail must never carry it.
  await needsYou.locator(".board-col-head").dblclick();
  await expect(needsYou).toHaveClass(/is-wide/);
  await postHook(daemon, "UserPromptSubmit", { prompt: "carry on" });
  await expect(needsYou.locator(".tile")).toHaveCount(0, { timeout: 30_000 });
  await expect(needsYou).toHaveClass(/is-calm/);
  await expect(needsYou).not.toHaveClass(/is-wide/);
  await expect.poll(() => width(needsYou)).toBeLessThanOrEqual(RAIL_MAX);
  observed("a needs you column widened while full went back to the slim rail once it emptied");
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
  // The needs you rail is not a stash chip.
  await expect(stash.locator(".board-stash-chip.tone-attention")).toHaveCount(0);
  await shoot(page, "stash-on", page.locator("main.board"));

  // ---- uncheck it in Settings ----
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const toggle = page.getByRole("checkbox", { name: "Show the empty-column stash" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await uiConfig(daemon)).showEmptyColumnStash).toBe(false);
  observed("unchecking the toggle wrote app_config.ui.showEmptyColumnStash = false");

  // ---- the Board draws no stash, and the needs you rail is untouched ----
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator("main.board")).toBeVisible();
  await expect(page.locator("main.board .board-stash")).toHaveCount(0);
  const needsYou = page.locator("main.board section.board-col.tone-attention");
  await expect(needsYou).toBeVisible();
  await expect.poll(() => width(needsYou)).toBeLessThanOrEqual(RAIL_MAX);
  observed("with the stash off the Board drew no stash and kept the slim needs you rail");
  await shoot(page, "stash-off", page.locator("main.board"));

  // ---- and back on again: not a one-way door ----
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.getByRole("checkbox", { name: "Show the empty-column stash" }).check();
  await expect.poll(async () => (await uiConfig(daemon)).showEmptyColumnStash).toBe(true);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator("main.board .board-stash")).toBeVisible();
});
