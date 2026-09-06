import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Page } from "@playwright/test";

const EVIDENCE = artifactsDir("backlog-card-title");

/**
 * A card names the work, not the request for it.
 *
 * The complaint this pins came from the board: a task dictated as "We should implement the
 * Herdr multiplexer" was carded as "We Should Implement the Herdr Multiplexer", and one asked
 * for as "Implement Herdr Multiplexer" kept the "Implement". Both waste the part of a card an
 * operator actually scans on words every other card in the column also has, and the same
 * string is what the git branch is cut from.
 *
 * Driven through the browser because the card is where the defect was seen. The unit tests in
 * `test/dispatch.test.ts` and `test/task-title.test.ts` pin the two title tiers directly; only
 * this layer says that the string the daemon derived is the string a person reads, delivered
 * over the same SSE frame and rendered by the same card.
 *
 * No agent is launched here - tasks are seeded straight into the backlog and never dispatched -
 * so nothing in this file spends model tokens. The daemon's titler still fires per task and
 * still reaches the fake `claude`, whose fixed reply is not a schema-valid title object, so it
 * fails its parse and the deterministic first-line tier is what these cards keep. That is the
 * tier a browser can assert on without racing an async refinement.
 */

/** Seed a task with NO title, so the daemon derives the card's name from the text. */
async function seedUntitled(daemon: DaemonHandle, intent: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, intent, backlog: true }),
  });
  expect(response.ok, `seeding "${intent}" answered ${response.status}`).toBe(true);
}

/** The Board, which is the only layout that draws the backlog as a column of cards. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("a card derived from a dictated task is named for the work", async ({ dashboard, daemon }) => {
  await seedUntitled(
    daemon,
    "We should implement the Herdr multiplexer\n\nOne pane per herd, switchable from the rail.",
  );
  await seedUntitled(daemon, "Implement Herdr Multiplexer");
  await useBoardLayout(dashboard, daemon);

  const column = dashboard.locator("section.board-backlog");
  await expect(column.locator(".board-col-n")).toHaveText("2");

  // The accessible name of the control that opens each editor, exact: this is the whole string
  // the operator reads on the card, so a leftover "We Should" or "Implement" fails here.
  await expect(column.getByRole("button", { name: "The Herdr Multiplexer", exact: true })).toBeVisible();
  await expect(column.getByRole("button", { name: "Herdr Multiplexer", exact: true })).toBeVisible();

  // Stated as absences too, because "contains the right words" is exactly what the old titles
  // also did - they contained them after four the operator did not need.
  await expect(column.locator(".bl-card", { hasText: "We Should" })).toHaveCount(0);
  await expect(column.locator(".bl-card", { hasText: "Implement" })).toHaveCount(0);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // Two cards do not both fit the 720px default viewport, and a card cropped mid-title is the
    // one thing this frame exists to show. Grown for the capture and put straight back, so the
    // assertions above keep running at the size every other spec uses.
    const restore = dashboard.viewportSize();
    await dashboard.setViewportSize({ width: 1280, height: 1100 });
    // Off every control first: `Tooltip` portals a bubble under a resting pointer.
    await dashboard.mouse.move(0, 0);
    await column.screenshot({ path: `${EVIDENCE}01-backlog-cards.png` });
    if (restore) await dashboard.setViewportSize(restore);
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/backlog-card-title/01-backlog-cards.png");
  }
});
