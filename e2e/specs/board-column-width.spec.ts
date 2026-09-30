import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Every Board column has three widths - collapsed to a strip, normal, expanded - set from a
 * three-stop control in its head.
 *
 * Only a browser settles these claims. That the collapsed track is actually 40px once the
 * stylesheet, the Backlog's own basis, and the all-clear column's basis have all had their say.
 * That a click on a stop reaches the daemon and comes back as a fold that survives a reload,
 * while the expanded column does not. That a collapsed Needs you still reacts when a session
 * starts waiting on you, which is a server event arriving at a column that has no cards drawn.
 * And that the arrow keys step over a collapsed column, which is a fact about App's navigation
 * arrays and the DOM agreeing - either half alone passes a unit test.
 *
 * No model tokens: the dispatched agent is `e2e/fixtures/fake-agents.ts`, and the question in
 * the arrival case is posted over `POST /mcp/reviews`, the route the agent's MCP child uses.
 */

const EVIDENCE = artifactsDir("board-column-width");

interface LiveSession {
  id: string;
  state: string;
  cwd: string | null;
}

async function sessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  if (!response.ok) throw new Error(`/api/sessions answered ${response.status}`);
  return (await response.json()) as LiveSession[];
}

async function uiConfig(daemon: DaemonHandle): Promise<{ collapsedBoardColumns: string[] }> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`);
  if (!response.ok) throw new Error(`/api/ui/config answered ${response.status}`);
  return ((await response.json()) as { config: { collapsedBoardColumns: string[] } }).config;
}

/**
 * Dispatch one agent and wait for it to settle idle with a checkout. The new session is found by
 * difference, because the arrival case dispatches twice.
 */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle, goal: string): Promise<LiveSession> {
  const before = new Set((await sessions(daemon)).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field; close it before the next fill.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let fresh: LiveSession | undefined;
  await expect.poll(async () => {
    fresh = (await sessions(daemon)).find((s) => !before.has(s.id) && s.state !== "exited");
    return fresh?.cwd ? fresh.state : "";
  }, { timeout: 60_000, message: `the dispatch for "${goal}" settled with a checkout` })
    .toBe("idle");
  return fresh!;
}

/** Ask this session's human a question, which sorts it into Needs you. */
async function askForInput(daemon: DaemonHandle, cwd: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "input",
      title: "Should this reach a folded column?",
      body: "Should this reach a folded column?",
      decisions: [{
        id: "q",
        question: "Should this reach a folded column?",
        options: [{ id: "o0", label: "yes", recommended: true }],
        allowOther: false,
      }],
    }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`)
    .toBe(200);
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon accepted the Board layout").toBe(true);
  // A reload: the web store paints from its cache and hydrates at boot, so a preference
  // written out of band only takes on the next load.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.locator("main.board").screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function widthOf(column: Locator): Promise<number> {
  const box = await column.boundingBox();
  expect(box, "the column is laid out").not.toBeNull();
  return box!.width;
}

/** Press one stop of a column's width control, hovering its head first as a person would. */
async function pressStop(page: Page, column: Locator, name: string): Promise<void> {
  await column.locator(".board-col-head").hover();
  await column.getByRole("button", { name, exact: true }).click();
}

test("any column collapses to a strip and back, and only the fold survives a reload", async ({
  dashboard,
  daemon,
}) => {
  await dispatchIdleAgent(dashboard, daemon, "sit in the idle column");
  await useBoardLayout(dashboard, daemon);

  const board = dashboard.locator("main.board");
  const backlog = board.locator(".board-backlog");
  const needsYou = board.locator(".board-col.tone-attention");
  const idle = board.locator(".board-col.tone-idle");
  await expect(idle.locator(".tile")).toHaveCount(1);
  await capture(dashboard, "01-all-normal");

  // The Backlog: its own component and its own 232px basis, so it has to be asked separately.
  await pressStop(dashboard, backlog, "Collapse Backlog");
  const backlogStrip = dashboard.getByRole("button", { name: "Restore Backlog, 0 cards" });
  await expect(backlogStrip).toBeVisible();
  await expect.poll(() => widthOf(backlog)).toBeLessThanOrEqual(41);

  // An empty Needs you is already the slim all-clear rail, so it offers no width control. It
  // is collapsed through the control once something needs you (the arrival case below).
  await expect(needsYou).toHaveClass(/\bis-calm\b/);
  await expect(needsYou.getByRole("group", { name: "needs you width" })).toHaveCount(0);

  // A column with a card in it: the strip holds the count, and the card leaves the DOM.
  await pressStop(dashboard, idle, "Collapse idle");
  const idleStrip = dashboard.getByRole("button", { name: "Restore idle, 1 card" });
  await expect(idleStrip).toBeVisible();
  await expect(board.locator(".tile")).toHaveCount(0);
  await expect.poll(() => widthOf(idle)).toBeLessThanOrEqual(41);
  await capture(dashboard, "02-strips");

  // The strip is the way back, and it restores to NORMAL, not to wherever it was before.
  await idleStrip.click();
  await expect(idle.locator(".tile")).toHaveCount(1);
  await expect(idle.getByRole("button", { name: "idle at normal width" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => widthOf(idle)).toBeGreaterThan(200);

  // Expanded is the third stop, and expanding leaves the strips beside it alone.
  await pressStop(dashboard, idle, "Expand idle");
  await expect(idle).toHaveClass(/\bis-wide\b/);
  await expect(idle.getByRole("button", { name: "Expand idle" })).toHaveAttribute("aria-pressed", "true");
  await expect(backlogStrip).toBeVisible();
  await expect.poll(() => widthOf(backlog)).toBeLessThanOrEqual(41);
  await capture(dashboard, "03-idle-expanded-beside-strips");

  // Saved on the daemon, which is what makes the fold outlive the page.
  await expect.poll(async () => (await uiConfig(daemon)).collapsedBoardColumns.sort())
    .toEqual(["backlog"]);

  await dashboard.reload();
  await expect(board).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Restore Backlog, 0 cards" })).toBeVisible();
  // The expansion was a gesture, and a reload forgets it.
  await expect(idle).not.toHaveClass(/\bis-wide\b/);
  await expect(idle.getByRole("button", { name: "idle at normal width" }))
    .toHaveAttribute("aria-pressed", "true");

  // One expanded column at a time: expanding a second returns the first to normal.
  await dashboard.getByRole("button", { name: "Restore Backlog, 0 cards" }).click();
  await pressStop(dashboard, backlog, "Expand Backlog");
  await expect(backlog).toHaveClass(/\bis-wide\b/);
  await pressStop(dashboard, idle, "Expand idle");
  await expect(idle).toHaveClass(/\bis-wide\b/);
  await expect(backlog).not.toHaveClass(/\bis-wide\b/);
  await expect(backlog.getByRole("button", { name: "Backlog at normal width" }))
    .toHaveAttribute("aria-pressed", "true");
});

test("double-clicking a column header still expands it, and again restores it", async ({
  dashboard,
  daemon,
}) => {
  // The gesture predates the width control, and both kinds of header wire it separately:
  // `BacklogColumn` for the Backlog, `BoardView` for the tone columns. Every other case
  // expands through the control's buttons, so each header is double-clicked here. The agent
  // puts a card in the idle column, a tone column, and an empty fleet would draw a "no
  // sessions" placeholder instead of the board.
  await dispatchIdleAgent(dashboard, daemon, "sit in the idle column");
  await useBoardLayout(dashboard, daemon);
  const board = dashboard.locator("main.board");

  for (const [column, name] of [
    [board.locator(".board-backlog"), "Backlog"],
    [board.locator(".board-col.tone-idle"), "idle"],
  ] as const) {
    // On the title rather than the control, which keeps its own clicks to itself.
    const title = column.locator(".board-col-head h2");

    await title.dblclick();
    await expect(column, `double-clicking the ${name} header expands it`).toHaveClass(/\bis-wide\b/);
    await expect(column.getByRole("button", { name: `Expand ${name}`, exact: true }))
      .toHaveAttribute("aria-pressed", "true");

    await title.dblclick();
    await expect(column, `double-clicking the ${name} header again restores it`)
      .not.toHaveClass(/\bis-wide\b/);
    await expect(column.getByRole("button", { name: `${name} at normal width`, exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  }

  // An expansion is never saved, so the gesture must not have written a fold.
  expect((await uiConfig(daemon)).collapsedBoardColumns).toEqual([]);
});

test("a collapsed Needs you counts and pulses when a session starts waiting on you", async ({
  dashboard,
  daemon,
}) => {
  // Needs you has a width control only while something is in it: empty, it is the slim
  // all-clear rail. So one session asks first, and a second arrives while it is collapsed.
  const first = await dispatchIdleAgent(dashboard, daemon, "wait on you first");
  await askForInput(daemon, first.cwd!);
  await useBoardLayout(dashboard, daemon);

  const board = dashboard.locator("main.board");
  const needsYou = board.locator(".board-col.tone-attention");
  await expect(needsYou.locator(".tile")).toHaveCount(1);
  await pressStop(dashboard, needsYou, "Collapse needs you");
  await expect(dashboard.getByRole("button", { name: "Restore needs you, 1 card" })).toBeVisible();
  await expect.poll(() => widthOf(needsYou)).toBeLessThanOrEqual(41);
  // Its first paint is still: the pulse is for an arrival, not for the fold itself.
  await expect(needsYou.locator(".board-col-strip-n")).not.toHaveClass(/\bis-pulsing\b/);

  // The second session moves into a column that draws no cards. The strip is all there is.
  const second = await dispatchIdleAgent(dashboard, daemon, "wait on you second");
  await askForInput(daemon, second.cwd!);
  const strip = dashboard.getByRole("button", { name: "Restore needs you, 2 cards" });
  await expect(strip).toBeVisible();
  await expect(needsYou.locator(".board-col-strip-n")).toHaveClass(/\bis-pulsing\b/);
  await expect(needsYou.locator(".board-col-strip-n")).toHaveText("2");
  // It stays collapsed: the fold was the operator's choice, and an arrival does not undo it.
  await expect(needsYou).toHaveClass(/\bis-collapsed\b/);
  await expect(board.locator(".tile")).toHaveCount(0);
  await capture(dashboard, "04-needs-you-arrival");

  await strip.click();
  await expect(needsYou.locator(".tile")).toHaveCount(2);
});

test("the arrow keys never land on a card a collapsed column is hiding", async ({
  dashboard,
  daemon,
}) => {
  await dispatchIdleAgent(dashboard, daemon, "the only card on the board");
  await useBoardLayout(dashboard, daemon);

  const board = dashboard.locator("main.board");
  const idle = board.locator(".board-col.tone-idle");
  await pressStop(dashboard, idle, "Collapse idle");
  await expect(dashboard.getByRole("button", { name: "Restore idle, 1 card" })).toBeVisible();

  // With the only card folded away, an arrow press has nothing drawn to land on - and Enter
  // must not drill into a session nobody can see.
  await board.click({ position: { x: 4, y: 4 } });
  await dashboard.keyboard.press("ArrowDown");
  await dashboard.keyboard.press("Enter");
  await expect(board).toHaveAttribute("data-focus", "none");
  await expect(board.locator(".tile.selected")).toHaveCount(0);

  // Restored, the same press finds it.
  await dashboard.getByRole("button", { name: "Restore idle, 1 card" }).click();
  await board.click({ position: { x: 4, y: 4 } });
  await dashboard.keyboard.press("ArrowDown");
  await expect(board.locator(".tile.selected")).toHaveCount(1);
});
