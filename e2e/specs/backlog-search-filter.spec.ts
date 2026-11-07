import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Backlog search and filtering (issue #1395), on both surfaces that draw the backlog: the
 * Board's Backlog column and the Line's Backlog drawer.
 *
 * The seeded backlog covers each facet value once over: two ready tasks with autopilot on and
 * off, one task blocked on another, and one task only a label search can find. No model
 * tokens - nothing here dispatches.
 */

const EVIDENCE = artifactsDir("backlog-search-filter");

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/backlog-search-filter/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function file(daemon: DaemonHandle, title: string, over: Record<string, unknown> = {}) {
  return api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title,
    intent: `Whatever "${title}" is for.`,
    backlog: true,
    workflowId: null,
    ...over,
  });
}

async function seed(daemon: DaemonHandle): Promise<void> {
  const task = (title: string, over: Record<string, unknown> = {}) => file(daemon, title, over);
  const base = await task("Fix GitHub auth refresh");
  await task("Rotate Codex auth token", { enabled: false });
  await task("Build on the auth fix", { dependencies: [{ type: "task", taskId: base.id, mode: "merge" }] });
  await task("Tidy the changelog script", { labels: ["docs"] });
}

const titles = (scope: Locator, selector: string): Promise<string[]> =>
  scope.locator(selector).allInnerTexts();

test("the Board's Backlog column searches and filters by dependencies and autopilot", async ({
  dashboard,
  daemon,
}) => {
  await seed(daemon);
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.reload();

  const column = dashboard.locator("section.board-backlog");
  const cards = column.locator(".bl-card");
  const count = column.locator(".board-col-n");
  await expect(cards).toHaveCount(4);
  await expect(count).toHaveText("4");

  // ---- search: title, and a label the title does not carry ----
  await column.getByRole("button", { name: "Search the backlog" }).click();
  const search = column.getByRole("textbox", { name: "Search backlog tasks" });
  await expect(search).toBeFocused();
  // The input has no outline of its own, so the field carries a visible focus ring.
  await expect(column.locator(".bl-filter-search")).not.toHaveCSS("box-shadow", "none");
  await search.fill("auth");
  await expect(cards).toHaveCount(3);
  await expect(count).toHaveText("3 of 4");
  await expect(column.locator("mark.bl-hit").first()).toHaveText("auth");
  await expect(column.getByRole("status")).toHaveText("1 task hidden by search and filters. Clear");

  // ---- the dependencies facet ----
  const filter = column.getByRole("button", { name: /^Filter the backlog/ });
  await filter.click();
  const menu = dashboard.getByRole("menu", { name: "Backlog filters" });
  await expect(menu).toBeVisible();
  // The column's button can sit at the window's left edge; the menu stays inside the window.
  const box = await menu.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= dashboard.viewportSize()!.width).toBe(true);
  // Counts reflect the search, so they say what checking the row would show.
  await expect(menu.getByRole("menuitemcheckbox", { name: /^Ready to start/ })).toContainText("2");
  await expect(menu.getByRole("menuitemcheckbox", { name: /^Blocked/ })).toContainText("1");
  await menu.getByRole("menuitemcheckbox", { name: /^Blocked/ }).click();
  await expect(menu.getByRole("menuitemcheckbox", { name: /^Blocked/ })).toHaveAttribute("aria-checked", "true");
  expect(await titles(column, ".bl-title")).toEqual(["Build on the auth fix"]);

  await menu.getByRole("menuitemcheckbox", { name: /^Blocked/ }).click();
  await menu.getByRole("menuitemcheckbox", { name: /^Ready to start/ }).click();
  expect(await titles(column, ".bl-title")).toEqual(["Fix GitHub auth refresh", "Rotate Codex auth token"]);

  // ---- the autopilot facet, combined with the first ----
  await menu.getByRole("menuitemcheckbox", { name: /^Autopilot off/ }).click();
  expect(await titles(column, ".bl-title")).toEqual(["Rotate Codex auth token"]);
  await expect(count).toHaveText("1 of 4");
  await expect(filter).toHaveAccessibleName("Filter the backlog, 2 active");
  await shoot(dashboard, "board-filter-menu");

  // Escape closes the menu and leaves the filters and search in place.
  await dashboard.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(column.getByRole("button", { name: "Remove filter: Ready to start" })).toBeVisible();
  await expect(column.getByRole("button", { name: "Remove filter: Autopilot off" })).toBeVisible();
  await shoot(column, "board-filtered-column");

  await column.getByRole("button", { name: "Remove filter: Autopilot off" }).click();
  expect(await titles(column, ".bl-title")).toEqual(["Fix GitHub auth refresh", "Rotate Codex auth token"]);

  // Autopilot on without the search reaches the label-only task too.
  await column.getByRole("button", { name: "Clear the backlog search" }).click();
  await expect(search).toBeHidden();
  await filter.click();
  await menu.getByRole("menuitemcheckbox", { name: /^Autopilot on/ }).click();
  await dashboard.keyboard.press("Escape");
  expect(await titles(column, ".bl-title")).toEqual(["Fix GitHub auth refresh", "Tidy the changelog script"]);

  // ---- a label search, and the way back to everything ----
  const searchButton = column.getByRole("button", { name: "Search the backlog" });
  await searchButton.click();
  await search.fill("chang");
  // Cmd/Ctrl-A in the field selects its text, not the column's cards: typing replaces it.
  await dashboard.keyboard.press("ControlOrMeta+a");
  await expect(dashboard.getByRole("toolbar", { name: "Selected backlog tasks" })).toHaveCount(0);
  await dashboard.keyboard.type("docs");
  await expect(search).toHaveValue("docs");
  expect(await titles(column, ".bl-title")).toEqual(["Tidy the changelog script"]);
  // With a search typed, the Search button hides the field AND clears it, so no search is
  // left filtering behind a closed field.
  await expect(searchButton).toHaveAttribute("aria-pressed", "true");
  await searchButton.click();
  await expect(search).toBeHidden();
  await expect(searchButton).toHaveAttribute("aria-pressed", "false");
  expect(await titles(column, ".bl-title")).toEqual(["Fix GitHub auth refresh", "Tidy the changelog script"]);
  await searchButton.click();
  await expect(search).toHaveValue("");
  await search.fill("nothing like this");
  await expect(cards).toHaveCount(0);
  await expect(column.getByRole("status")).toHaveText("No backlog tasks match. 4 tasks hidden by search and filters. Clear");
  await column.getByRole("status").getByRole("button", { name: "Clear" }).click();
  await expect(cards).toHaveCount(4);
  await expect(count).toHaveText("4");
  await expect(search).toBeHidden();
  await expect(column.getByRole("status")).toHaveCount(0);
});

test("the Line's Backlog drawer carries the same search and filters", async ({ dashboard, daemon }) => {
  await seed(daemon);
  await dashboard
    .getByRole("navigation", { name: "The Line" })
    .getByRole("button", { name: /^Backlog,/ })
    .click();
  const drawer = dashboard.getByRole("region", { name: "Backlog drawer" });
  const rows = drawer.locator(".line-bl-title");
  const count = drawer.locator(".line-drawer-count");
  await expect(rows).toHaveCount(4);
  await expect(count).toHaveText("2 ready · 1 blocked · 1 parked");

  await drawer.getByRole("button", { name: /^Filter the backlog/ }).click();
  const menu = dashboard.getByRole("menu", { name: "Backlog filters" });
  await menu.getByRole("menuitemcheckbox", { name: /^Blocked/ }).click();
  await dashboard.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  // Escape belonged to the menu: the drawer is still open.
  await expect(drawer).toBeVisible();
  expect(await titles(drawer, ".line-bl-title")).toEqual(["Build on the auth fix"]);
  await expect(count).toHaveText("1 of 4 shown");
  await expect(drawer.getByRole("button", { name: "Remove filter: Blocked" })).toBeVisible();

  await drawer.getByRole("button", { name: "Remove filter: Blocked" }).click();
  await drawer.getByRole("button", { name: "Search the backlog" }).click();
  await drawer.getByRole("textbox", { name: "Search backlog tasks" }).fill("codex");
  expect(await titles(drawer, ".line-bl-title")).toEqual(["Rotate Codex auth token"]);
  await expect(drawer.locator("mark.bl-hit")).toHaveText("Codex");
  await shoot(drawer, "line-drawer-search");

  // Escape in the field clears the search, not the drawer.
  await dashboard.keyboard.press("Escape");
  await expect(drawer).toBeVisible();
  await expect(rows).toHaveCount(4);
  await expect(count).toHaveText("2 ready · 1 blocked · 1 parked");
});

/**
 * A backlog whose middle three cards match "match" and whose two ends do not, filed in this
 * order, so a search leaves hidden cards on BOTH sides of what the column shows.
 */
const FILED = ["Hidden top", "Match alpha", "Match beta", "Match gamma", "Hidden bottom"];

async function searchedBoard(dashboard: Page, daemon: DaemonHandle): Promise<Locator> {
  for (const title of FILED) await file(daemon, title);
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.reload();
  const column = dashboard.locator("section.board-backlog");
  await expect(column.locator(".bl-card")).toHaveCount(5);
  await column.getByRole("button", { name: "Search the backlog" }).click();
  await column.getByRole("textbox", { name: "Search backlog tasks" }).fill("match");
  await expect.poll(() => titles(column, ".bl-title")).toEqual(["Match alpha", "Match beta", "Match gamma"]);
  return column;
}

/** Every backlog task's title in the daemon's own rank order - the list the scheduler reads. */
async function storedOrder(daemon: DaemonHandle): Promise<string[]> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`);
  const tasks = (await response.json()) as Array<{ title: string; status: string; backlogRank: number | null }>;
  return tasks
    .filter((t) => t.status === "backlog")
    .sort((a, b) => (a.backlogRank ?? Infinity) - (b.backlogRank ?? Infinity))
    .map((t) => t.title);
}

/**
 * One HTML5 drag with a real page-side `DataTransfer`, dispatched the way
 * `backlog-reorder.spec.ts` does and for its reason: Chromium's own drag machinery does not
 * reliably raise native HTML5 drag events through CDP.
 */
async function dragInto(page: Page, source: Locator, gap: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await gap.dispatchEvent("dragover", { dataTransfer });
  await gap.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
}

test("a drop at either end of a filtered column lands beside the visible cards, not past the hidden ones", async ({
  dashboard,
  daemon,
}) => {
  const column = await searchedBoard(dashboard, daemon);
  const gaps = column.locator(".bl-gap");
  const card = (title: string) => column.locator(".bl-card", { hasText: title });
  // Three visible cards, four places to drop one.
  await expect(gaps).toHaveCount(4);

  // The first gap means "above the first card you can see": the hidden top card stays first.
  await dragInto(dashboard, card("Match gamma"), gaps.first());
  await expect.poll(() => storedOrder(daemon)).toEqual([
    "Hidden top",
    "Match gamma",
    "Match alpha",
    "Match beta",
    "Hidden bottom",
  ]);
  await expect.poll(() => titles(column, ".bl-title")).toEqual(["Match gamma", "Match alpha", "Match beta"]);

  // The last gap means "below the last card you can see": the hidden bottom card stays last.
  await dragInto(dashboard, card("Match gamma"), gaps.last());
  await expect.poll(() => storedOrder(daemon)).toEqual([
    "Hidden top",
    "Match alpha",
    "Match beta",
    "Match gamma",
    "Hidden bottom",
  ]);
  await expect.poll(() => titles(column, ".bl-title")).toEqual(["Match alpha", "Match beta", "Match gamma"]);
});

test("select-all takes only the visible cards, and a bulk delete leaves the hidden ones", async ({
  dashboard,
  daemon,
}) => {
  const column = await searchedBoard(dashboard, daemon);
  // Focus inside the column but outside the search field, which keeps Cmd-A for its own text.
  await column.getByRole("button", { name: "Match alpha", exact: true }).focus();
  await dashboard.keyboard.press("ControlOrMeta+a");
  const bar = dashboard.getByRole("toolbar", { name: "Selected backlog tasks" });
  await expect(bar).toContainText("3 selected");
  for (const title of ["Match alpha", "Match beta", "Match gamma"]) {
    await expect(column.getByRole("checkbox", { name: `Select "${title}"` })).toBeChecked();
  }

  await bar.getByRole("button", { name: "Delete…" }).click();
  await expect(bar).toContainText("Delete 3 tasks?");
  await bar.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => storedOrder(daemon)).toEqual(["Hidden top", "Hidden bottom"]);
  await expect(bar).toBeHidden();
});

test("a card hidden by the filter leaves the selection, and does not come back selected", async ({
  dashboard,
  daemon,
}) => {
  const column = await searchedBoard(dashboard, daemon);
  const search = column.getByRole("textbox", { name: "Search backlog tasks" });
  const bar = dashboard.getByRole("toolbar", { name: "Selected backlog tasks" });
  // Start unfiltered, and pick one card the search will hide and one it will keep.
  await search.fill("");
  await expect(column.locator(".bl-card")).toHaveCount(5);
  await column.getByRole("checkbox", { name: 'Select "Hidden top"' }).click();
  await column.getByRole("checkbox", { name: 'Select "Match alpha"' }).click();
  await expect(bar).toContainText("2 selected");

  await search.fill("match");
  await expect(bar).toContainText("1 selected");
  await search.fill("");
  await expect(column.locator(".bl-card")).toHaveCount(5);
  await expect(bar).toContainText("1 selected");
  await expect(column.getByRole("checkbox", { name: 'Select "Hidden top"' })).not.toBeChecked();
  await expect(column.getByRole("checkbox", { name: 'Select "Match alpha"' })).toBeChecked();
});

test("the filter menu stays inside a window too short to open it below its button", async ({
  dashboard,
  daemon,
}) => {
  await seed(daemon);
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.reload();
  const column = dashboard.locator("section.board-backlog");
  const filter = column.getByRole("button", { name: /^Filter the backlog/ });
  await filter.click();
  const menu = dashboard.getByRole("menu", { name: "Backlog filters" });
  await menu.getByRole("menuitemcheckbox", { name: /^Blocked/ }).click();
  const button = (await filter.boundingBox())!;
  // Shrink the window until the menu no longer fits below its button. The menu re-places
  // itself on resize and must stay entirely inside the window.
  const height = Math.round(button.y + button.height + 120);
  await dashboard.setViewportSize({ width: 1280, height });
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return Boolean(box && box.y >= 0 && box.y + box.height <= height);
    })
    .toBe(true);
  // Every row, Clear filters included, is reachable inside it.
  const clear = menu.getByRole("menuitem", { name: "Clear filters" });
  await clear.scrollIntoViewIfNeeded();
  await clear.click();
  await expect(filter).toHaveAccessibleName("Filter the backlog");
});
