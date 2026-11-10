import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { dispatchedSdkHookIdentity } from "../fixtures/sdk-hook-identity.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Board's empty columns: every column exists, and it is drawn only while it has a card in
 * it. An empty column - Backlog, needs you, idle, unconfirmed, gone - leaves nothing behind: no
 * slim rail, and no "empty" stash of chips.
 *
 * Only a browser can settle this. "Takes no room" is laid-out geometry, not markup, and "comes
 * back when a session needs you" is a real session reaching the attention tone through the
 * daemon's own hook route and the column answering over the event stream.
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

  // ---- empty: no column, not even a slim one, and no chip standing in for it ----
  await expect(needsYou).toHaveCount(0);
  await expect(board.getByRole("heading", { name: "needs you" })).toHaveCount(0);
  await expect(board.getByRole("button", { name: /^needs you$/i })).toHaveCount(0);
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
  observed(`with a session waiting needs you came back ${Math.round(await width(needsYou))}px wide`);
  await shoot(page, "needs-you-back", board);

  // ---- and leaves again when it empties, even after being widened ----
  await needsYou.locator(".board-col-head").dblclick();
  await expect(needsYou).toHaveClass(/is-wide/);
  await postHook(daemon, "UserPromptSubmit", { prompt: "carry on" });
  await expect(needsYou).toHaveCount(0, { timeout: 30_000 });
  await expect(board.getByRole("button", { name: /^needs you$/i })).toHaveCount(0);
  observed("once nothing was waiting again, needs you left the board and left nothing behind");
});

test("an empty Backlog leaves the board and comes back with its first task", async ({
  dashboard: page,
  daemon,
}) => {
  await dispatch(page, daemon, "check the linter config");
  await openBoard(page, daemon);

  const board = page.locator("main.board");
  const backlog = board.locator("section.board-backlog");
  await expect(board.locator("section.board-col.tone-working .tile")).toHaveCount(1, { timeout: 30_000 });

  // ---- empty: no column, no "Nothing queued", and no chip to bring it back ----
  await expect(backlog).toHaveCount(0);
  await expect(board.getByText("Nothing queued")).toHaveCount(0);
  await expect(board.getByRole("button", { name: /^backlog$/i })).toHaveCount(0);
  observed("with nothing queued the Board drew no Backlog column and no Backlog chip");

  // ---- the first queued task brings the column back by itself ----
  await seedBacklogTask(daemon, "Tidy the release notes");
  await expect(backlog).toBeVisible({ timeout: 30_000 });
  await expect(backlog.locator(".bl-card")).toHaveCount(1);
  observed("saving a task to the Backlog brought the Backlog column back with its card");
  await shoot(page, "backlog-back", board);
});

test("no empty column leaves a stash behind, and Settings offers no stash to turn on", async ({
  dashboard: page,
  daemon,
}) => {
  // An empty fleet draws "No agent sessions detected" instead of a board, so one session
  // first. Its turn is held open, so it sits in Working and every other column is empty.
  await dispatch(page, daemon, "check the linter config");
  await openBoard(page, daemon);

  const board = page.locator("main.board");
  await expect(board.locator("section.board-col.tone-working .tile")).toHaveCount(1, { timeout: 30_000 });

  // ---- every empty column is gone, and nothing is drawn in its place ----
  for (const tone of ["attention", "idle", "neutral", "exited"]) {
    await expect(board.locator(`section.board-col.tone-${tone}`), `${tone} is not drawn`).toHaveCount(0);
  }
  await expect(board.locator("section.board-backlog")).toHaveCount(0);
  for (const label of ["needs you", "idle", "unconfirmed", "gone", "Backlog"]) {
    await expect(board.getByRole("button", { name: new RegExp(`^${label}$`, "i") }), `no ${label} chip`)
      .toHaveCount(0);
  }
  await expect(board.getByText("empty", { exact: true })).toHaveCount(0);
  // Working is the only column on the board: nothing sits beside it.
  await expect(board.locator(":scope > section.board-col")).toHaveCount(1);
  observed("with one working session the Board drew Working alone - no empty column and no stash");
  await shoot(page, "no-stash", board);

  // ---- a drill-in has no exception: opening the session mounts no empty column either ----
  // The open session's own column is the rail; needs you, idle, unconfirmed, gone and the
  // empty Backlog are not rendered even at zero width while the morph runs.
  await board.locator("section.board-col.tone-working .tile").click();
  await expect(board.locator("section.board-col.tone-working.is-rail")).toBeVisible();
  await expect(board).toHaveAttribute("data-focus", "working");
  for (const tone of ["attention", "idle", "neutral", "exited"]) {
    await expect(board.locator(`section.board-col.tone-${tone}`), `${tone} is not drawn in the drill-in`)
      .toHaveCount(0);
  }
  await expect(board.locator("section.board-backlog")).toHaveCount(0);
  await expect(board.getByText("Nothing here")).toHaveCount(0);
  await expect(board.locator(":scope > section.board-col")).toHaveCount(1);
  // Read once the morph has settled: the rail animates in from the column's width to the
  // fixed 320px console rail.
  await expect.poll(() => width(board.locator("section.board-col.is-rail"))).toBeLessThanOrEqual(321);
  observed("drilled into Working, the Board mounted only the Working rail - no empty column, reserved or Backlog");
  await shoot(page, "drill-in-no-empty-columns", board);
  await page.locator("body").press("Escape");
  await expect(board).toHaveAttribute("data-focus", "none");

  // ---- and Settings has no toggle that could bring a stash back ----
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(page.getByRole("checkbox", { name: "Group by repository" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /empty-column stash/i })).toHaveCount(0);
  observed("Settings, Display offers no empty-column stash toggle");
});

/** The three reserved columns, by the tone class the Board draws and the heading it prints. */
const RESERVED = [
  { tone: "attention", label: "needs you" },
  { tone: "neutral", label: "unconfirmed" },
  { tone: "exited", label: "gone" },
] as const;

/**
 * Unconfirmed and Gone, each with one card, in a real browser.
 *
 * An Unconfirmed card is a session the daemon can see but has no fresh lifecycle reading for,
 * and the only door to one is terminal discovery: an agent in a real pane that has never
 * posted a hook. A Gone card is a pane-backed session its own `SessionEnd` hook marked exited -
 * an Agent SDK session cannot be one, because only its supervisor may close it and that
 * removes the card. So both need a discovered pane, and this block turns discovery on for its
 * own daemon, the way `backlog-reorder.spec.ts` does, and pays for it the same way: it
 * addresses its own card by the tmux session name it generated, and never assumes the fleet
 * is only that card.
 *
 * NO MODEL TOKENS: the thing in the pane is `node` under a symlink named `claude` - the shape
 * `harnessOf` detects - running a script that only stays alive.
 */
test.describe("an agent with no lifecycle reading", () => {
  test.use({ daemonEnv: { MISSION_POLL_MS: "400" } });
  test.skip(
    spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0,
    "tmux is not installed on this machine",
  );

  let cleanup: (() => void) | undefined;
  test.afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  test("one unconfirmed card renders unconfirmed, and the same card ended renders gone", async ({
    dashboard: page,
    daemon,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "mc-e2e-unconfirmed-"));
    const bin = join(dir, "fake-bin");
    mkdirSync(bin);
    symlinkSync(execPath, join(bin, "claude"));
    // Never posts a hook and never writes a transcript: nothing can confirm its state.
    const quiet = join(dir, "quiet-agent.mjs");
    writeFileSync(quiet, "setInterval(() => {}, 60_000);\n");
    const name = `mc-e2e-unconfirmed-${process.pid}-${Date.now()}`;
    execFileSync("tmux", [
      "new-session", "-d", "-s", name, "-x", "120", "-y", "40", "-c", daemon.repo, `${join(bin, "claude")} ${quiet}`,
    ]);
    const paneId = execFileSync("tmux", ["list-panes", "-t", name, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
    cleanup = () => {
      spawnSync("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    };

    await openBoard(page, daemon);
    const board = page.locator("main.board");
    const unconfirmed = board.locator("section.board-col.tone-neutral");
    const ours = unconfirmed.locator(".tile").filter({ hasText: name });
    await expect(ours).toHaveCount(1, { timeout: 30_000 });
    await expect(unconfirmed.getByRole("heading", { name: "unconfirmed" })).toBeVisible();
    observed(`the quiet pane agent ${name} rendered the unconfirmed column with its card`);

    // Discovery can also find agents this machine is running, so the fleet is not assumed to
    // be ours alone. The rule is asserted as stated instead: every reserved column that is on
    // the board holds at least one card, and when the daemon lists only our session the other
    // two are not rendered at all.
    for (const { tone, label } of RESERVED) {
      const column = board.locator(`section.board-col.tone-${tone}`);
      if ((await column.count()) > 0) {
        expect(await column.locator(".tile, .rail-row").count(), `${label} is drawn only with a card`).toBeGreaterThan(0);
      }
    }
    const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as unknown[];
    if (sessions.length === 1) {
      for (const { tone } of RESERVED.filter((r) => r.tone !== "neutral")) {
        await expect(board.locator(`section.board-col.tone-${tone}`), `${tone} is not drawn`).toHaveCount(0);
      }
      await expect(board.locator(":scope > section.board-col")).toHaveCount(1);
      observed("the daemon listed only the quiet pane agent: unconfirmed rendered alone, needs you and gone did not");
    } else {
      observed(`discovery also listed ${sessions.length - 1} of this machine's agents; every reserved column drawn held a card`);
    }
    await expect(board.locator("section.board-col.tone-exited")).toHaveCount(0);
    await shoot(page, "unconfirmed-one-card", board);

    // ---- the same card ends: it moves to Gone, which renders for it ----
    // The hook a real Claude posts when its process ends, addressed to this pane exactly as
    // `fixtures/pane-agent.mjs` addresses its own.
    const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
    const ended = await fetch(`${daemon.baseURL}/hooks/SessionEnd`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({ agent: "claude", cwd: daemon.repo, env: { tmuxPane: paneId }, reason: "other" }),
    });
    expect(ended.status, "the daemon accepted the SessionEnd hook").toBe(204);

    const gone = board.locator("section.board-col.tone-exited");
    await expect(gone.locator(".tile").filter({ hasText: name })).toHaveCount(1, { timeout: 30_000 });
    await expect(gone.getByRole("heading", { name: "gone" })).toBeVisible();
    await expect(unconfirmed.locator(".tile").filter({ hasText: name })).toHaveCount(0);
    observed(`${name} ended: the gone column rendered with its card, and the card left unconfirmed`);
    for (const { tone, label } of RESERVED) {
      const column = board.locator(`section.board-col.tone-${tone}`);
      if ((await column.count()) > 0) {
        expect(await column.locator(".tile, .rail-row").count(), `${label} is drawn only with a card`).toBeGreaterThan(0);
      }
    }
    const after = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as unknown[];
    if (after.length === 1) {
      // Ours alone: Unconfirmed just lost its only card, so it is not rendered at all.
      for (const { tone } of RESERVED.filter((r) => r.tone !== "exited")) {
        await expect(board.locator(`section.board-col.tone-${tone}`), `${tone} is not drawn`).toHaveCount(0);
      }
      observed("the daemon listed only the ended pane agent: gone rendered alone, unconfirmed and needs you did not");
    } else {
      observed("unconfirmed stayed only because this machine's own agents are cards in it; every reserved column drawn held a card");
    }
    await shoot(page, "gone-one-card", board);
  });
});
