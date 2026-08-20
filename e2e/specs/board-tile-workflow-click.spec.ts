import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * An expanded workflow on a Board tile answers the clicks that land in it.
 *
 * The bug is one only a browser can see, and it is a dead region rather than a wrong pixel.
 * The disclosure panel stops every click from reaching the tile - it has to, because an
 * expanded ladder is most of a tall tile and a bubbling miss would open the console on every
 * mis-aim - and that stop was the whole handler. So the largest thing on the tile did nothing
 * at all: clicking the ladder you were reading did not even make its tile the board's cursor,
 * while clicking the two lines of goal text above it did.
 *
 * It now reads as two steps, and the tile's own selection is what tells them apart:
 *
 *   1. On an unselected tile, a click on the panel's background selects that tile - and only
 *      selects it. Opening would morph the column into the console rail and replace the tile,
 *      and the ladder in it, with a rail row.
 *   2. On the selected tile, the next click into the same area follows the run into Runs -
 *      the same destination as the collapsed peek link and the ladder's own "Open run".
 *
 * Controls inside the panel keep answering their own clicks, which is the half most at risk
 * of a regression: "Collapse workflow" must collapse, not navigate.
 *
 * No model tokens: the reviewer is a Persona whose guidance carries `E2E_FAIL_VERDICT`, which
 * `e2e/fixtures/fake-agents.ts` answers with a schema-valid failing verdict. That returns the
 * run to the session and parks it open, which is exactly the tile in the report - a live run,
 * mid-review, being read on the board.
 */

const EVIDENCE = artifactsDir("board-tile-workflow-click");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  // Let the disclosure's own transition settle. A frame taken mid-expand photographs the
  // ladder half-faded, which reads as a rendering fault in a picture meant for pixel review.
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-tile-workflow-click/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Dispatch one agent and wait for it to settle, with no workflow armed by the modal itself. */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle, goal: string): Promise<string> {
  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((s) => s.id),
  );
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const fresh = sessions.find((s) => !before.has(s.id) && s.state !== "exited");
    sessionId = fresh?.id ?? "";
    return fresh?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  return sessionId;
}

/** A one-reviewer workflow whose persona fails, so the submitted run parks open on the tile. */
async function openRunOn(daemon: DaemonHandle, sessionId: string): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Tile click reviewer",
    guidanceMarkdown: "# Tile click reviewer\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Tile click review",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-tile-click" },
  );
  await expect.poll(
    async () =>
      (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`))
        .run.status,
    { timeout: 60_000 },
  ).toBe("waiting_for_session");
  return submitted.run.id;
}

/**
 * Put the dashboard in the Board layout.
 *
 * Written to the daemon rather than `localStorage`: the web store hydrates from
 * `GET /api/ui/config` at boot and overwrites the local cache. The reload is what makes it take.
 */
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

test("an expanded workflow on a Board tile selects it, then follows its run", async ({
  dashboard,
  daemon,
}) => {
  const session = await dispatchIdleAgent(dashboard, daemon, "be read on the board");
  const runId = await openRunOn(daemon, session);
  await useBoardLayout(dashboard, daemon);

  const tile = dashboard.locator(".tile").filter({ has: dashboard.locator(".tile-workflow-disclosure") });
  await expect(tile).toHaveCount(1);

  // Expand in place, through the control a person clicks.
  await tile.getByRole("button", { name: "Show full workflow" }).click();
  await expect(tile).toHaveClass(/workflow-expanded/);
  await expect(tile.getByRole("button", { name: "Collapse workflow" })).toBeVisible();
  // The full ladder, not the collapsed peek - this is the region the bug was about.
  await expect(tile.locator(".wf-ladder-open")).toBeVisible();
  await expect(tile).not.toHaveClass(/selected/);
  await expect(dashboard.locator(".board-detail")).toHaveAttribute("aria-hidden", "true");

  // Frame 1 of the sequence a reviewer reads: expanded, and NOT selected. This is the state the
  // bug left you stuck in - every click into the ladder below returned you to exactly this.
  await shoot(dashboard, "01-expanded-not-selected");

  // The panel's own background: the ladder's stage list, aimed between its rows rather than at
  // a rung's controls. This is the click that used to do nothing at all.
  const ladder = tile.locator(".tile-workflow-content");
  await ladder.click({ position: { x: 4, y: 4 } });

  // Selected - and ONLY selected. The board has not drilled in, so the tile and the ladder
  // being read are both still on screen for the second click.
  await expect(tile).toHaveClass(/selected/);
  await expect(tile).toHaveClass(/workflow-expanded/);
  await expect(tile.getByRole("button", { name: "Collapse workflow" })).toBeVisible();
  await expect(dashboard.locator("main.board")).toHaveAttribute("data-focus", "none");
  // The drill-in specifically: `.board-detail` is the track the console detail mounts into,
  // and it stays closed. This is the assertion behind "selects, and only selects".
  await expect(dashboard.locator(".board-detail")).toHaveAttribute("aria-hidden", "true");
  expect(new URL(dashboard.url()).hash).not.toContain("/runs/");

  // Frame 2: the same tile, now the board's cursor, with the ladder still expanded and no
  // console detail beside it.
  await shoot(dashboard, "02-first-click-selects");

  // The same click again, now that the tile is the cursor, follows the run into Runs.
  await ladder.click({ position: { x: 4, y: 4 } });
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}`));
  await expect(dashboard.getByRole("list", { name: "Workflow runs" })).toBeVisible();
  // The run it landed on is THIS run, not a neighbour that happens to head the list.
  await expect(dashboard.getByRole("list", { name: "Workflow runs" }))
    .toContainText("Tile click review");

  // Frame 3: the run's own page, reached by the second click alone.
  await shoot(dashboard, "03-second-click-opens-run");
});

test("controls inside an expanded workflow keep answering their own clicks", async ({
  dashboard,
  daemon,
}) => {
  // The other half, and the one that would rot silently: a panel that acts on its background
  // must not also fire underneath the buttons on top of it. Collapse has to collapse - on a
  // tile that is already selected, where the background click navigates away.
  const session = await dispatchIdleAgent(dashboard, daemon, "keep its buttons working");
  await openRunOn(daemon, session);
  await useBoardLayout(dashboard, daemon);

  const tile = dashboard.locator(".tile").filter({ has: dashboard.locator(".tile-workflow-disclosure") });
  await tile.getByRole("button", { name: "Show full workflow" }).click();
  await expect(tile).toHaveClass(/workflow-expanded/);

  await tile.locator(".tile-workflow-content").click({ position: { x: 4, y: 4 } });
  await expect(tile).toHaveClass(/selected/);

  await tile.getByRole("button", { name: "Collapse workflow" }).click();
  await expect(tile).not.toHaveClass(/workflow-expanded/);
  await expect(tile.getByRole("button", { name: "Show full workflow" })).toBeVisible();
  // Collapsing is not navigating, and it is not opening the console either.
  expect(new URL(dashboard.url()).hash).not.toContain("/runs/");
  await expect(dashboard.locator("main.board")).toHaveAttribute("data-focus", "none");

  // The collapsed peek keeps its own contract: it is a link to the run, and one click follows
  // it whether or not the tile is the cursor.
  await expect(tile.locator("a.wf-tile-peek")).toBeVisible();
});
