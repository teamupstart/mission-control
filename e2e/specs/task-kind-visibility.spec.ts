import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A task's kind, marked on every task session and every task card - `ship` included.
 *
 * Before this, the console printed a kind only when it was NOT `ship`, as a small chip in the
 * PATH and BRANCH band, and no Board card printed one at all - so the most common kind of task
 * said what it was nowhere. The operator chose a badge leading the session's name for the
 * console and a tab on the card's top edge for the Board, and both are styles in
 * Settings > Display with `Off` beside them.
 *
 * Laid out in a browser because the claims are about placement: the badge is read before the
 * name on the name's own line, and the tab sits ON the card's top border rather than inside
 * the card. Neither is a fact markup alone can state.
 */

const SHIP = { title: "Ship the kind badge", intent: "mark every task with its kind" };
const SCOUT = { title: "Scout the kind badge", intent: "survey where the kind is printed" };

const EVIDENCE = artifactsDir("task-kind-visibility");

async function shot(locator: Locator, name: string, observed: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await locator.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${observed}`);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-kind-visibility/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * Dispatch a task of `kind` straight through the route. The dispatch form is not this spec's
 * subject, and `workflowId: null` keeps the daemon from refusing a repo that is not
 * allowlisted for Workflows delivery.
 */
async function dispatch(
  daemon: DaemonHandle,
  task: { title: string; intent: string },
  kind: "ship" | "scout",
): Promise<void> {
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title: task.title,
    intent: task.intent,
    kind,
    workflowId: null,
  });
}

/** Wait until the dispatched sessions are live and named, so the surfaces are stable. */
async function live(daemon: DaemonHandle, ...tasks: Array<{ title: string }>): Promise<void> {
  await expect
    .poll(
      async () => {
        const sessions = await api<Array<{ name: string; cwd: string | null; task: unknown }>>(
          daemon,
          "/api/sessions",
        );
        return sessions.filter((s) => s.cwd && s.task).map((s) => s.name).sort();
      },
      { timeout: 60_000, message: "the dispatched sessions should be live" },
    )
    .toEqual(tasks.map((t) => t.title).sort());
}

/**
 * Write a UI preference out of band and reload, because the web store paints from its
 * `localStorage` mirror before `GET /api/ui/config` lands.
 */
async function useUi(page: Page, daemon: DaemonHandle, patch: Record<string, unknown>): Promise<void> {
  await api(daemon, "/api/ui/config", patch, "PUT");
  // To the fleet first: a hash change alone does not reload, and a reload alone stays on
  // whatever route the page is on - Settings, for the test that comes back from there.
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
}

async function openDetail(page: Page, name: string): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).getByRole("button", { name }).first().click();
  const detail = page.locator(".cdetail");
  await expect(detail.getByRole("heading", { name })).toBeVisible();
  return detail;
}

function boardTile(page: Page, name: string): Locator {
  return page.locator("main.board .tile").filter({ has: page.locator(".tile-name", { hasText: name }) });
}

test("a ship task is badged before its name in the console, and the path band no longer carries a kind", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(daemon, SHIP, "ship");
  await dispatch(daemon, SCOUT, "scout");
  await live(daemon, SHIP, SCOUT);
  await useUi(dashboard, daemon, { layout: "console" });

  for (const [task, kind] of [[SHIP, "ship"], [SCOUT, "scout"]] as const) {
    const detail = await openDetail(dashboard, task.title);
    const head = detail.locator("header.detail-head");
    const badge = head.locator(".detail-title-line").getByText(kind, { exact: true });
    await expect(badge, `the ${kind} task is not badged`).toBeVisible();

    // Before the name, on the name's own line: the badge and the name are read in one glance.
    const badgeBox = (await badge.boundingBox())!;
    const nameBox = (await head.getByRole("heading", { name: task.title }).boundingBox())!;
    expect(badgeBox.x + badgeBox.width, "the badge does not lead the name").toBeLessThanOrEqual(nameBox.x);
    expect(Math.abs(badgeBox.y + badgeBox.height / 2 - (nameBox.y + nameBox.height / 2)))
      .toBeLessThan(6);

    // The PATH and BRANCH band says nothing about the kind any more, for either kind. The
    // session is named after its task, so the pill has nothing left to host at all.
    await expect(detail.locator(".detail-sub")).not.toContainText(kind);
    await expect(detail.locator(".task-chip")).toHaveCount(0);
    await shot(
      detail.locator(".detail-sub"),
      `path-band-${kind}`,
      `the ${kind} session's PATH and BRANCH band carries no kind`,
    );

    // Hover says what the kind is for, and so does the badge's accessible description.
    await expect(badge).toHaveAccessibleDescription(new RegExp(`^${kind} task - `));
    await badge.hover();
    await expect(dashboard.locator(".tooltip")).toContainText(`${kind} task - `);
    await shot(head, `console-${kind}-badge`, `the ${kind} session is badged ${kind.toUpperCase()} before its name`);
  }
});

test("every Board card carries its kind on a tab on its top edge", async ({ dashboard, daemon }) => {
  await dispatch(daemon, SHIP, "ship");
  await dispatch(daemon, SCOUT, "scout");
  await live(daemon, SHIP, SCOUT);
  await useUi(dashboard, daemon, { layout: "board" });
  await expect(dashboard.locator("main.board")).toBeVisible();

  for (const [task, kind] of [[SHIP, "ship"], [SCOUT, "scout"]] as const) {
    const tile = boardTile(dashboard, task.title);
    await expect(tile).toBeVisible();
    const tab = tile.getByText(kind, { exact: true });
    await expect(tab, `the ${kind} card is not marked`).toBeVisible();

    // ON the top border: the tab straddles the card's top edge rather than taking a row
    // inside it, and the name below it is not pushed aside.
    // Both rectangles in one read, polled: a card can move column while its session
    // settles, and a read that lands mid re-render measures a detached node as all zeros.
    await expect
      .poll(
        () =>
          tab.evaluate((el) => {
            const own = el.getBoundingClientRect();
            const card = el.closest(".tile")!.getBoundingClientRect();
            if (card.height === 0) return "not laid out";
            if (own.top >= card.top) return "the tab does not rise above the card's edge";
            if (own.bottom <= card.top) return "the tab floats clear of the card";
            return "on the edge";
          }),
        { message: `the ${kind} tab should sit on the card's top border` },
      )
      .toBe("on the edge");
  }
  await shot(dashboard.locator("main.board"), "board-kind-tabs", "each card has a SHIP or SCOUT tab on its top edge");
});

test("the Display settings switch both surfaces to another style, and off", async ({ dashboard, daemon }) => {
  await dispatch(daemon, SHIP, "ship");
  await live(daemon, SHIP);

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const panel = dashboard.locator('[data-anchor="display/board-card"]');
  const cardStyle = panel.getByRole("radiogroup", { name: "Board card: Task type" });
  const headerStyle = panel.getByRole("radiogroup", { name: "Conversation header: Task type" });
  await expect(cardStyle.getByRole("radio", { name: "Edge tab" })).toBeChecked();
  await expect(headerStyle.getByRole("radio", { name: "Title badge" })).toBeChecked();

  // The preview beside the checklist is the real card, so it follows the choice live.
  // The card's preview; the Working indicator group has a preview of its own below it.
  const preview = panel.locator(".board-card-preview").first();
  await expect(preview.getByText("ship", { exact: true })).toBeVisible();
  await cardStyle.getByText("Top band", { exact: true }).click();
  await headerStyle.getByText("Eyebrow", { exact: true }).click();
  await expect(cardStyle.getByRole("radio", { name: "Top band" })).toBeChecked();
  await expect(preview.getByText("deliver a change")).toBeVisible();
  await shot(
    panel.locator(".display-choice").first(),
    "settings-card-task-type",
    "the Board card section offers Edge tab, Name chip, Top band, Medallion and Off",
  );
  await shot(preview, "settings-preview-band", "the preview card redraws with the Top band");
  // The radiogroup's own container: the label, description and all five segments.
  await expect(headerStyle.getByRole("radio")).toHaveCount(5);
  await shot(
    headerStyle.locator("xpath=.."),
    "settings-header-task-type",
    "the Conversation header section offers Title badge, Eyebrow, Kind tile, Tab strip and Off",
  );

  // Stored in the daemon, not only painted: a reload reads it back.
  await expect
    .poll(async () => {
      const view = await api<{ config: { taskKindCard: string; taskKindHeader: string } }>(daemon, "/api/ui/config");
      return [view.config.taskKindCard, view.config.taskKindHeader];
    })
    .toEqual(["band", "eyebrow"]);

  await useUi(dashboard, daemon, { layout: "board" });
  const tile = boardTile(dashboard, SHIP.title);
  await expect(tile.getByText("deliver a change")).toBeVisible();
  await expect(tile.locator(".tk-tab")).toHaveCount(0);

  await useUi(dashboard, daemon, { layout: "console" });
  const detail = await openDetail(dashboard, SHIP.title);
  await expect(detail.locator(".detail-title").getByText("ship task", { exact: true })).toBeVisible();
  await expect(detail.locator(".detail-title-line").getByText("ship", { exact: true })).toHaveCount(0);

  // Off takes the mark away on both surfaces.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await cardStyle.getByText("Off", { exact: true }).click();
  await headerStyle.getByText("Off", { exact: true }).click();
  await expect(headerStyle.getByRole("radio", { name: "Off" })).toBeChecked();
  await expect(preview.locator(".tk-mark")).toHaveCount(0);

  await useUi(dashboard, daemon, { layout: "board" });
  await expect(boardTile(dashboard, SHIP.title)).toBeVisible();
  await expect(boardTile(dashboard, SHIP.title).locator(".tk-mark")).toHaveCount(0);
  await useUi(dashboard, daemon, { layout: "console" });
  const quiet = await openDetail(dashboard, SHIP.title);
  await expect(quiet.locator(".tk-mark")).toHaveCount(0);
});

test("every style draws its mark in the real layout", async ({ dashboard, daemon }) => {
  // The defaults are covered above; this lays out the other six styles in the built app so
  // none of them ships having only ever been rendered to a string.
  await dispatch(daemon, SHIP, "ship");
  await live(daemon, SHIP);

  for (const style of ["eyebrow", "tile", "tabs"] as const) {
    await useUi(dashboard, daemon, { layout: "console", taskKindHeader: style });
    const detail = await openDetail(dashboard, SHIP.title);
    const mark = detail.locator(`.tk-${style}`);
    await expect(mark).toBeVisible();
    if (style === "tile") await expect(mark).toHaveAccessibleName("ship task");
    else await expect(mark).toContainText("ship", { ignoreCase: true });
    await shot(detail.locator("header.detail-head"), `console-${style}`, `the console header marks the kind as ${style}`);
    if (style === "tabs") await shot(detail.locator(".detail-tabs"), "console-tabs-strip", "the kind anchors the tab strip");
  }

  for (const style of ["chip", "band", "medallion"] as const) {
    await useUi(dashboard, daemon, { layout: "board", taskKindCard: style });
    const tile = boardTile(dashboard, SHIP.title);
    const mark = tile.locator(`.tk-${style}`);
    await expect(mark).toBeVisible();
    if (style === "medallion") await expect(mark).toHaveAccessibleName("ship task");
    else await expect(mark).toContainText("ship", { ignoreCase: true });
    await shot(tile, `card-${style}`, `the card marks the kind as ${style}`);
  }
});
