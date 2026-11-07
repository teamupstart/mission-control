import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * Compressing a resident's card in the Residents drawer: a click on its title folds it to the
 * name, one live status line and its controls, the way a Board repository frame folds, so more
 * residents fit. Each card folds on its own, the fold outlives the drawer closing, and a reload
 * opens every card again. Open, a card's latest message is a click into the conversation.
 *
 * Same setup as `residents-drawer.spec.ts`. No model tokens are spent: every agent binary is
 * redirected by `e2e/fixtures/fake-agents.ts`. The resident's activity line arrives on
 * `POST /mcp/status`, the channel its own `report_status` tool uses.
 */

const EVIDENCE = artifactsDir("residents-drawer-compress");
const FIRST = "Alpha keeper";
const SECOND = "Bravo keeper";

async function capture(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function request<T>(daemon: DaemonHandle, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, body === undefined && method === "GET" ? {} : {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** Author a resident profile through the real route. */
async function createProfile(daemon: DaemonHandle, name: string): Promise<ResidentProfile> {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  return request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name }, persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
}

function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

/** Launch one resident through the real routes and wait until its loop is waiting. */
async function launch(daemon: DaemonHandle, name: string): Promise<void> {
  const before = waitingResidents(daemon);
  const profile = await createProfile(daemon, name);
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, {
    repoRoot: daemon.repo, requestId: `launch-${name.toLowerCase().replace(/\W+/g, "-")}`,
  });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(before + 1);
}

function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

/** Stand in for the resident calling its bundled `report_status` tool. */
async function reportStatus(daemon: DaemonHandle, sessionId: string, activity: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/mcp/status`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, sessionId, activity }),
  });
  expect(response.status, await response.clone().text()).toBe(204);
}

/** Opt this spec's dashboard into the Residents drawer, closed, on the Board, and land on the fleet. */
async function useDrawer(page: Page, daemon: DaemonHandle): Promise<void> {
  const config = { residentPlacement: "drawer", residentDrawerPinned: false, layout: "board" };
  await request(daemon, "/api/ui/config", config, "PUT");
  await page.evaluate((next) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...next }));
  }, config);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
}

/** The drawer: a column beside the fleet, pinned or not, never a dialog over the page. */
const drawerOf = (page: Page): Locator => page.getByRole("complementary", { name: "Residents", exact: true });
const closeDrawer = async (page: Page): Promise<void> => {
  await drawerOf(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(drawerOf(page)).toHaveCount(0);
};
const cardOf = (scope: Locator, name: string): Locator =>
  scope.getByRole("listitem").filter({ has: scope.page().getByRole("button", { name: new RegExp(`^${name}, `) }) });
const headOf = (scope: Locator, name: string): Locator => scope.getByRole("button", { name: new RegExp(`^${name}, `) });
const openDrawer = async (page: Page): Promise<Locator> => {
  await page.getByRole("button", { name: /^Residents - \d+ live$/ }).click();
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  return drawer;
};

/** The session id a card belongs to, which the status and review channels address. */
async function sessionIdOf(card: Locator): Promise<string> {
  const id = await card.getAttribute("data-resident-card");
  expect(id, "the card has a live session").toBeTruthy();
  return id!;
}

async function heightOf(card: Locator): Promise<number> {
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  return box!.height;
}

test("a click on a resident's title compresses its card to the live status line and its controls", async ({ dashboard: page, daemon }) => {
  await launch(daemon, FIRST);
  await launch(daemon, SECOND);
  await useDrawer(page, daemon);

  const drawer = await openDrawer(page);
  const first = cardOf(drawer, FIRST);
  const second = cardOf(drawer, SECOND);
  const firstId = await sessionIdOf(first);
  await reportStatus(daemon, firstId, "Reading the nightly build log");

  // Both cards start open, with their loop facts, whichever is selected. No card has a reply box.
  for (const card of [first, second]) {
    await expect(card.getByRole("button", { expanded: true })).toHaveCount(1);
    await expect(card.getByLabel("Resident loop status")).toBeVisible();
  }
  await expect(drawer.getByRole("textbox")).toHaveCount(0);
  await expect(first.getByLabel(`Latest from ${FIRST}`)).toHaveText("Reading the nightly build log");
  const openHeight = await heightOf(first);
  await capture(page, "01-both-open");

  await headOf(drawer, FIRST).click();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByLabel("Resident loop status")).toHaveCount(0);
  // The controls stay.
  await expect(first.getByRole("button", { name: `Open ${FIRST}` })).toBeVisible();
  await expect(first.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(first.getByRole("button", { name: "Run now" })).toBeVisible();
  await expect(first.getByLabel(`Latest from ${FIRST}`)).toHaveText("Reading the nightly build log");
  expect(await heightOf(first)).toBeLessThan(openHeight);
  // The other card folds on its own.
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-expanded", "true");
  await expect(second.getByLabel("Resident loop status")).toBeVisible();

  // The status line follows the resident as it works, compressed.
  await reportStatus(daemon, firstId, "Editing src/release/notes.md");
  await expect(first.getByLabel(`Latest from ${FIRST}`)).toHaveText("Editing src/release/notes.md");
  await capture(page, "02-first-compressed");

  // Compressing the second as well stacks both into less room.
  await headOf(drawer, SECOND).click();
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-expanded", "false");
  await expect(drawer.getByLabel("Resident loop status")).toHaveCount(0);
  await capture(page, "03-both-compressed");

  // The fold outlives the drawer closing; Space on a title folds it too.
  await closeDrawer(page);
  await openDrawer(page);
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-expanded", "false");
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-expanded", "false");
  await headOf(drawer, FIRST).focus();
  await page.keyboard.press("Space");
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-expanded", "true");
  await expect(first.getByLabel("Resident loop status")).toBeVisible();
  await expect(drawer).toBeVisible();

  // It is not a setting: a reload opens every card again.
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
  await openDrawer(page);
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-expanded", "true");
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-expanded", "true");
});

test("a click on an open card's latest message opens the resident's conversation", async ({ dashboard: page, daemon }) => {
  await launch(daemon, FIRST);
  await useDrawer(page, daemon);

  const drawer = await openDrawer(page);
  const first = cardOf(drawer, FIRST);
  await reportStatus(daemon, await sessionIdOf(first), "Reading the nightly build log");
  const latest = first.getByLabel(`Latest from ${FIRST}`);
  await expect(latest).toHaveText("Reading the nightly build log");

  // Compressed, the status line is only a status line: a click on it opens nothing.
  await headOf(drawer, FIRST).click();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-expanded", "false");
  await latest.click();
  await expect(drawer).toBeVisible();
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${FIRST}` })).toHaveCount(0);

  // Open, the same text is the way into the conversation, as Open is.
  await headOf(drawer, FIRST).click();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-expanded", "true");

  // But a drag that selects some of the text is reading it, not opening it: the press and the
  // release both land on the message, so a click still fires, and the conversation stays shut.
  const box = await latest.boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + 90, y, { steps: 6 });
  await page.mouse.up();
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).length).toBeGreaterThan(0);
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${FIRST}` })).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  // An ordinary click opens it.
  await latest.click();
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${FIRST}` })).toBeVisible();
  await expect(drawer).toBeVisible();
  await capture(page, "04-latest-opens-conversation");

  // Escape leaves the conversation and puts the keyboard back on the card, as it does after Open.
  await page.locator("body").press("Escape");
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${FIRST}` })).toHaveCount(0);
  await expect(headOf(drawer, FIRST)).toBeFocused();
});
