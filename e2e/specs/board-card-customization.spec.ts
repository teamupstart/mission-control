import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Unchecking a board card item removes it from every card in EVERY COLUMN, and checking it
 * puts it back.
 *
 * The "every column" half is the whole claim, and it is why this spec pays for two sessions
 * rather than one. A single card proves the tile reads the preference; it cannot distinguish
 * that from a preference reaching only the card that happened to be on screen, or only the
 * column that happened to be first. So the fleet here is deliberately split by TONE: one
 * session settles idle, and one is asked a question over the real review channel so it sorts
 * into **needs you**. Two tones, two columns, one toggle.
 *
 * This is also the layer the other three cannot reach. `renderToStaticMarkup` proves the tile
 * gates on the registry and the panel draws a checkbox per entry, but not that clicking one
 * reaches the daemon, comes back through the config store and repaints cards on a page the
 * operator has since navigated to. Only here does a click become a PUT become a re-render.
 *
 * No model tokens are spent: every agent binary is redirected by
 * `e2e/fixtures/fake-agents.ts`, and the review is posted over `POST /mcp/reviews`, which is
 * the same route the agent's own MCP child uses.
 */

const EVIDENCE = artifactsDir("board-card-customization");

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface LiveSession {
  id: string;
  state: string;
  cwd: string | null;
}

/**
 * Dispatch one agent, settle it, and report the session it became.
 *
 * The new session is identified by DIFFERENCE against the ids already on the fleet, because
 * this spec dispatches twice and "the one live session" stops being a description after the
 * first. `cwd` comes back with it: the review channel binds by checkout, and a dispatch cuts
 * a fresh uuid-named worktree that nothing here could guess.
 */
async function dispatchIdleAgent(
  page: Page,
  daemon: DaemonHandle,
  goal: string,
): Promise<LiveSession> {
  const before = new Set(
    (await api<LiveSession[]>(daemon, "/api/sessions")).map((s) => s.id),
  );
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control. Its own handler stops
  // propagation, so this closes the list rather than the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let fresh: LiveSession | undefined;
  await expect.poll(async () => {
    const sessions = await api<LiveSession[]>(daemon, "/api/sessions");
    fresh = sessions.find((s) => !before.has(s.id) && s.state !== "exited");
    // The cwd is read off the daemon rather than the DOM, and a card is on screen before the
    // registry has necessarily finished adopting the worktree it was cut into - so the poll
    // waits for both facts rather than for the state alone.
    return fresh?.cwd ? fresh.state : "";
  }, { timeout: 60_000, message: `the dispatch for "${goal}" settled with a checkout` })
    .toBe("idle");
  return fresh!;
}

/**
 * Ask this session's human a question, the way the agent's MCP child does.
 *
 * A pending review outranks every other reading in `stateDisplay`, so this is the cheapest
 * honest way to put a second session in a second Board column - no second harness, no
 * workflow run, no kill. Bound by `cwd`, which is how a real agent binds when it has no
 * session id to offer.
 */
async function askForReview(daemon: DaemonHandle, cwd: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "input",
      title: "Which column should this card sit in?",
      body: "Which column should this card sit in?",
      decisions: [{
        id: "q",
        question: "Which column should this card sit in?",
        options: [{ id: "o0", label: "needs you", recommended: true }],
        allowOther: false,
      }],
    }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`)
    .toBe(200);
}

/** Put the dashboard in the Board layout, where the cards this spec is about are drawn. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon accepted the Board layout").toBe(true);
  // A RELOAD, not a hash navigation: the web store hydrates from `GET /api/ui/config` at
  // boot and paints from its `localStorage` mirror before that lands, so a preference
  // written out of band only takes on the next load.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // would sit over the very cells this picture is of.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-card-customization/${name}.png`);
}

/** The Board's columns that are actually holding a card. */
function occupiedColumns(page: Page): Locator {
  return page.locator("main.board section.board-col").filter({ has: page.locator(".tile") });
}

test("unchecking a card item empties it from every card in every column, and checking it restores them", async ({
  dashboard,
  daemon,
}) => {
  const settled = await dispatchIdleAgent(dashboard, daemon, "sit in the idle column");
  const asked = await dispatchIdleAgent(dashboard, daemon, "sit in the needs-you column");
  await askForReview(daemon, asked.cwd!);
  await useBoardLayout(dashboard, daemon);

  // The precondition the whole test rests on: two cards, in two DIFFERENT columns. Asserted
  // rather than assumed, because a run that silently ended up with both sessions in one
  // column would go on to pass while proving exactly what a single-card version proved.
  const needsYou = dashboard.locator("main.board section.board-col.tone-attention");
  const idle = dashboard.locator("main.board section.board-col.tone-idle");
  const tiles = dashboard.locator("main.board .tile");
  await expect(needsYou.locator(".tile")).toHaveCount(1);
  await expect(idle.locator(".tile")).toHaveCount(1);
  await expect(occupiedColumns(dashboard)).toHaveCount(2);
  await expect(tiles).toHaveCount(2);
  expect(settled.id, "the two dispatches are two sessions").not.toBe(asked.id);

  // The two items this test drives, present on BOTH cards first so their disappearance below
  // means something. Both are drawn for every session rather than only for one that happens
  // to have reported something: the branch cell falls back to the name source, and the
  // permission-mode chip falls back to "permissions" until a mode is observed.
  await expect(tiles.locator(".tile-branch")).toHaveCount(2);
  await expect(tiles.locator(".mode")).toHaveCount(2);
  // And the attention flag that put the second card in its column, which no setting may
  // touch (D3) - so its survival below is part of the claim rather than a bystander.
  await expect(needsYou.locator(".tile .tf-review")).toHaveCount(1);
  await shoot(dashboard, "01-two-columns-defaults");

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const branch = dashboard.getByRole("checkbox", { name: "Branch", exact: true });
  const mode = dashboard.getByRole("checkbox", { name: "Permission mode", exact: true });
  await expect(branch).toBeChecked();
  await expect(mode).toBeChecked();

  await branch.uncheck();
  await mode.uncheck();

  // Back to the board - the preference is per browser and stored in the daemon, so it has
  // to survive the navigation rather than living in this page's React state.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(tiles).toHaveCount(2);
  await expect(occupiedColumns(dashboard)).toHaveCount(2);
  // EVERY card, counted across the whole board rather than checked on one...
  await expect(tiles.locator(".tile-branch")).toHaveCount(0);
  await expect(tiles.locator(".mode")).toHaveCount(0);
  // ...and then column by column, which is the assertion a whole-board count cannot make:
  // two cards each missing both cells reads the same as one card missing four.
  for (const column of [needsYou, idle]) {
    await expect(column.locator(".tile")).toHaveCount(1);
    await expect(column.locator(".tile .tile-branch")).toHaveCount(0);
    await expect(column.locator(".tile .mode")).toHaveCount(0);
    // Still a card: its name and its state tone are not on the list and cannot be switched
    // off, in either column.
    await expect(column.locator(".tile .tile-name")).toHaveCount(1);
  }
  // The attention flag is untouched by a setting that just emptied two cells beside it (D3).
  await expect(needsYou.locator(".tile .tf-review")).toHaveCount(1);
  await shoot(dashboard, "02-two-columns-branch-and-mode-hidden");

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(branch).not.toBeChecked();
  await expect(mode).not.toBeChecked();
  await branch.check();
  await mode.check();

  // And back on both cards, which is the half that proves this is a preference rather than a
  // one-way trim.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(tiles.locator(".tile-branch")).toHaveCount(2);
  await expect(tiles.locator(".mode")).toHaveCount(2);
  for (const column of [needsYou, idle]) {
    await expect(column.locator(".tile .tile-branch")).toHaveCount(1);
    await expect(column.locator(".tile .mode")).toHaveCount(1);
  }
  await shoot(dashboard, "03-two-columns-restored");
});

test("the attention flags are not on the list at all", async ({ dashboard, daemon }) => {
  // D3, from the surface an operator would look on. There is no checkbox for a review, a
  // queued turn, a pull request, an Inspector verdict or an ensemble, so no configuration
  // can make a session that needs you look like one that does not.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = dashboard.locator('[data-anchor="display/board-card"]');
  await expect(panel).toBeVisible();
  for (const name of ["Review", "Note", "Queue", "Pull request", "Inspector", "Ensemble"]) {
    await expect(panel.getByRole("checkbox", { name })).toHaveCount(0);
  }
});
