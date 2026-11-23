import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Background sub-agents on the board, end to end: a dispatched fake Claude launches three
 * background agents through the real Agent SDK stream (`E2E_BACKGROUND_AGENTS`), ends its
 * turn with them still running, and finishes one a second later. The daemon reduces those
 * frames into the session's summary, `session_upsert` carries it, and the board hangs the
 * agents beneath the card.
 *
 * The fake also emits everything that must NOT appear - a foreground agent, an ambient one,
 * a background shell, and a sub-agent's own frame after the parent's turn ended - so the
 * absences asserted below are of things that were really on the wire. No model is spent.
 */

const EVIDENCE = artifactsDir("board-background-agents");

const PLAIN = { title: "Plain card without agents", intent: "settle and wait" };
const AGENTS = { title: "Ledger with background agents", intent: "E2E_BACKGROUND_AGENTS launch three" };
const MANY = { title: "Survey with five agents", intent: "E2E_MANY_BACKGROUND_AGENTS launch five" };

interface LiveSession {
  id: string;
  state: string;
  cwd: string | null;
}

async function sessions(daemon: DaemonHandle): Promise<LiveSession[]> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  return (await response.json()) as LiveSession[];
}

async function dispatchIdle(page: Page, daemon: DaemonHandle, task: { title: string; intent: string }): Promise<void> {
  const before = new Set((await sessions(daemon)).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task.intent);
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(task.title);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => {
    const fresh = (await sessions(daemon)).find((s) => !before.has(s.id) && s.state !== "exited");
    return fresh?.cwd ? fresh.state : "";
  }, { timeout: 60_000, message: `the dispatch for "${task.title}" settled idle` }).toBe("idle");
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon accepted the Board layout").toBe(true);
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

async function shoot(target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-background-agents/${name}.png`);
}

test("background sub-agents hang beneath their card, and an idle parent says they are still running", async ({
  dashboard,
  daemon,
}) => {
  await dispatchIdle(dashboard, daemon, PLAIN);
  await dispatchIdle(dashboard, daemon, AGENTS);
  await useBoardLayout(dashboard, daemon);
  await dashboard.mouse.move(0, 0);

  const idleCol = dashboard.locator("main.board section.board-col.tone-idle");
  const agentsTile = idleCol.locator(".tile").filter({ hasText: AGENTS.title });
  const plainTile = idleCol.locator(".tile").filter({ hasText: PLAIN.title });
  await expect(agentsTile).toHaveCount(1);
  await expect(plainTile).toHaveCount(1);

  // One tree on the whole board, hanging directly beneath the card that launched the agents.
  const tree = dashboard.getByRole("group", { name: /^Background sub-agents of / });
  await expect(tree).toHaveCount(1);
  expect(
    await tree.evaluate((el) => el.previousElementSibling?.textContent ?? ""),
    "the tree is the next sibling of its own card",
  ).toContain(AGENTS.title);

  // The parent is idle - its turn is over - and the card says what is still going on under it.
  // The third agent finishes about a second after the turn, so the line settles on two.
  await expect(agentsTile.locator(".tile-activity")).toHaveText(/idle · 2 agents still running/);
  const head = tree.getByRole("button", { name: "3 sub-agents · 2 running" });
  await expect(head).toHaveAttribute("aria-expanded", "true");

  const rows = tree.getByRole("listitem");
  await expect(rows).toHaveCount(3);
  const mapRow = rows.filter({ hasText: "Map every offset-pagination call site" });
  await expect(mapRow).toContainText("Explore");
  await expect(mapRow).toContainText("18 tools · Grep");
  await expect(rows.filter({ hasText: "Convert billing report queries" })).toContainText("6 tools · Edit");

  // The finished agent stays listed, marked done and dimmed, until the operator's next turn.
  const doneRow = rows.filter({ hasText: "Find contract tests for /ledger" });
  await expect(doneRow).toContainText("done");
  await expect(doneRow).toHaveClass(/is-completed/);
  await expect(doneRow).toHaveCSS("opacity", "0.55");
  await expect(mapRow).toHaveCSS("opacity", "1");

  // Foreground, ambient and non-agent work was on the wire and is nowhere on the board.
  for (const absent of ["Foreground planning", "Housekeeping", "npm run watch"]) {
    await expect(dashboard.locator("main.board")).not.toContainText(absent);
  }

  // A card without background agents is exactly what it was: no tree, no "still running".
  await expect(plainTile).not.toContainText("still running");
  expect(
    await plainTile.evaluate((el) => el.nextElementSibling?.classList.contains("subagent-tree") ?? false),
    "nothing hangs beneath an agent-free card",
  ).toBe(false);
  await shoot(idleCol, "01-sub-cards-and-idle-line");

  // The header folds the group and opens it again.
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(0);
  await head.click();
  await expect(rows).toHaveCount(3);

  // The operator's next turn folds the finished agent into a count.
  await agentsTile.click();
  const detail = dashboard.locator(".cdetail");
  await expect(detail).toBeVisible();
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill("fold the finished agent");
  await reply.press("Enter");
  await expect(detail.getByText("Mock reply to: fold the finished agent")).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Escape");
  await expect(dashboard.locator(".cdetail")).toHaveCount(0);

  await expect(tree.getByRole("button", { name: "2 sub-agents · 2 running" })).toBeVisible();
  await expect(rows.filter({ hasText: "Find contract tests for /ledger" })).toHaveCount(0);
  await expect(tree.getByText("1 finished")).toBeVisible();
  await expect(agentsTile.locator(".tile-activity")).toHaveText(/idle · 2 agents still running/);
  await dashboard.mouse.move(0, 0);
  await shoot(idleCol, "02-finished-agent-folded");
});

test("past three agents the rest fold behind +N more, which opens them", async ({ dashboard, daemon }) => {
  await dispatchIdle(dashboard, daemon, MANY);
  await useBoardLayout(dashboard, daemon);
  await dashboard.mouse.move(0, 0);

  const tree = dashboard.getByRole("group", { name: /^Background sub-agents of / });
  await expect(tree).toHaveCount(1);
  await expect(tree.getByRole("button", { name: "5 sub-agents · 5 running" })).toBeVisible();
  await expect(
    dashboard.locator("main.board .tile").filter({ hasText: MANY.title }).locator(".tile-activity"),
  ).toHaveText(/idle · 5 agents still running/);

  // Three rows drawn, and the two beyond them folded behind one control.
  const agentRows = tree.locator(".st-row:not(.st-more-row)");
  await expect(agentRows).toHaveCount(3);
  for (const n of [1, 2, 3]) await expect(agentRows.filter({ hasText: `Survey area ${n}` })).toHaveCount(1);
  for (const n of [4, 5]) await expect(tree).not.toContainText(`Survey area ${n}`);
  const more = tree.getByRole("button", { name: "Show 2 more sub-agents" });
  await expect(more).toHaveText("+2 more");
  await shoot(tree, "03-plus-more-folded");

  // Opening it draws every agent, and the control has nothing left to open.
  await more.click();
  await expect(agentRows).toHaveCount(5);
  await expect(agentRows.filter({ hasText: "Survey area 4" })).toContainText("4 tools · Read");
  await expect(agentRows.filter({ hasText: "Survey area 5" })).toContainText("5 tools · Read");
  await expect(more).toHaveCount(0);
  await dashboard.mouse.move(0, 0);
  await shoot(tree, "04-plus-more-opened");
});
