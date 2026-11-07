import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * The Residents drawer: residents leave the Board columns and the Console rail for a drawer on
 * the right edge, which is the shipped default (Settings → Display → Residents).
 *
 * The `dashboard` fixture pins `residentPlacement: "fleet"` for the specs written before the
 * drawer; this spec opts into the drawer itself, and proves the shipped default through the raw
 * `page` fixture. No model tokens are spent: every agent binary is redirected by
 * `e2e/fixtures/fake-agents.ts`, and the resident's question is posted on `POST /mcp/reviews`,
 * the channel its own `request_input` tool uses.
 */

const EVIDENCE = artifactsDir("residents-drawer");
const NAME = "Drawer watcher";

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

/** Author a resident profile through the real route, with or without a default repository. */
async function createProfile(daemon: DaemonHandle, name: string, repo = true): Promise<ResidentProfile> {
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  return request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name }, persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    ...(repo ? { workspace: { defaultRepoRoot: daemon.repo } } : {}),
    execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
}

/** How many launched residents are waiting between iterations. */
function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

/** Launch one resident through the real routes and wait until its loop is waiting. */
async function launch(daemon: DaemonHandle, name = NAME): Promise<ResidentProfile> {
  const before = waitingResidents(daemon);
  const profile = await createProfile(daemon, name);
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, {
    repoRoot: daemon.repo, requestId: `launch-${name.toLowerCase().replace(/\W+/g, "-")}`,
  });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(before + 1);
  return profile;
}

/** Stand in for the resident calling its bundled request_input tool. Returns the review id. */
async function askResident(daemon: DaemonHandle): Promise<string> {
  const sessions = await request<Array<{ cwd: string | null; task?: { kind?: string } }>>(daemon, "/api/sessions", undefined, "GET");
  const cwd = sessions.find((s) => s.task?.kind === "resident")?.cwd;
  expect(cwd, "the resident session has a workspace to bind the question to").toBeTruthy();
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {}, cwd, kind: "input", title: "Ship the nightly migration?", body: "Ship the nightly migration?",
      decisions: [{ id: "q", question: "Ship the nightly migration?", options: [
        { id: "yes", label: "Ship it" }, { id: "no", label: "Hold it" },
      ], allowOther: false }],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

/** Opt this spec's dashboard into the drawer, in one layout, and land on the fleet. */
async function useDrawer(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  await request(daemon, "/api/ui/config", { residentPlacement: "drawer", residentDrawerPinned: false, layout }, "PUT");
  await page.evaluate((next) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...next }));
  }, { residentPlacement: "drawer", residentDrawerPinned: false, layout });
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
const cardOf = (scope: Locator, name = NAME): Locator =>
  scope.getByRole("listitem").filter({ has: scope.page().getByRole("button", { name: new RegExp(`^${name}, `) }) });
const headOf = (scope: Locator, name = NAME): Locator => scope.getByRole("button", { name: new RegExp(`^${name}, `) });
const band = (page: Page, name = NAME): Locator => page.getByRole("group", { name: `Resident ${name}` });
const edgeTab = (page: Page): Locator => page.getByRole("button", { name: /^Open the Residents drawer - / });

/** No Board column, drill-in rail row or Console rail row names the resident. */
async function expectOffFleet(page: Page, name = NAME): Promise<void> {
  await expect(page.locator(".board-col", { hasText: name })).toHaveCount(0);
  await expect(page.locator(".console-rail", { hasText: name })).toHaveCount(0);
}

test("a new installation keeps residents in the drawer, off the Board", async ({ page, daemon }) => {
  await launch(daemon);
  const stored = await request<{ config: { residentPlacement: string } }>(daemon, "/api/ui/config", undefined, "GET");
  expect(stored.config.residentPlacement).toBe("drawer");

  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator(".board")).toBeVisible();
  await expect(edgeTab(page)).toHaveAccessibleName("Open the Residents drawer - 1 live");
  await expectOffFleet(page);
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  await expect(cardOf(drawerOf(page))).toBeVisible();
  await expect(drawerOf(page).getByRole("heading", { name: "Live", exact: true })).toHaveCount(0);
  await capture(page, "01-default-drawer");
});

test("the drawer opens three ways as a column beside the Board, dims nothing, and stays beside the drill-in", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon, "board");
  await expectOffFleet(page);
  const boardWidth = async (): Promise<number> => (await page.locator(".board").boundingBox())!.width;
  const before = await boardWidth();

  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  // Unpinned, it looks just as it does pinned: the Board narrows beside it, and nothing is
  // dimmed or covered.
  await expect(drawer.getByRole("button", { name: "Pin", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(boardWidth).toBeLessThan(before - 200);
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectContentClearsBorder(drawer);
  const card = cardOf(drawer);
  await expect(card).toHaveCount(1);
  expect(await card.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--resident"))).toMatch(/^var\(--resident-/);
  await expect(card).toContainText("⌥1");
  await expect(headOf(drawer)).toBeFocused();
  await capture(page, "02-drawer-open");

  // A column, not an overlay: Escape and a click on the Board leave it where it is.
  await page.keyboard.press("Escape");
  await page.mouse.click(40, 400);
  await expect(drawer).toBeVisible();
  await closeDrawer(page);
  await expect.poll(boardWidth).toBe(before);

  await page.keyboard.press("Shift+KeyH");
  await expect(drawer).toBeVisible();
  await expect(headOf(drawer)).toBeFocused();
  await page.keyboard.press("Shift+KeyH");
  await expect(drawer).toHaveCount(0);

  await edgeTab(page).click();
  await expect(drawer).toBeVisible();
  await expect(edgeTab(page)).toHaveCount(0);
  await expect(headOf(drawer)).toHaveAttribute("aria-expanded", "true");
  await drawer.getByRole("button", { name: `Open ${NAME}` }).click();
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expectOffFleet(page);
  await capture(page, "03-board-drill-in");

  // Escape leaves the detail and puts the keyboard back on the resident's card.
  await page.locator("body").press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(headOf(drawer)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(band(page)).toBeVisible();
  await page.locator("body").press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(drawer).toBeVisible();

  // Open is for this page load only: a reload closes an unpinned drawer.
  await page.reload();
  await expect(edgeTab(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);

  await page.keyboard.press("Alt+Digit1");
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expectOffFleet(page);
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(drawer).toHaveCount(0);
});

test("in Console the drawer is a column beside the rail, and a resident opens in the detail pane beside it", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  // A fleet session to move to: dispatched straight over the API, opted out of Workflows.
  await request(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fleet neighbour", intent: "settle and wait", workflowId: null,
  });
  await useDrawer(page, daemon, "console");
  const rail = page.locator(".console-rail");
  await expect(rail.getByRole("button", { name: /Fleet neighbour/ })).toBeVisible({ timeout: 60_000 });
  await expectOffFleet(page);

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await drawer.getByRole("button", { name: `Open ${NAME}` }).click();
  await expect(page.locator(".console-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(page.locator(".board")).toHaveCount(0);
  await expectOffFleet(page);
  await capture(page, "04-console-detail");

  // A fleet session opens beside it as any other would, and the drawer stays.
  await rail.getByRole("button", { name: /Fleet neighbour/ }).click();
  await expect(band(page)).toBeHidden();
  await expect(drawer).toBeVisible();
  await closeDrawer(page);

  await page.keyboard.press("Alt+Digit1");
  await expect(page.locator(".console-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expectOffFleet(page);
});

test("Pin keeps the drawer open through a reload, and Unpin leaves it open until the next one", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon, "board");
  const storedPin = async (): Promise<boolean> => (await request<{ config: { residentDrawerPinned: boolean } }>(
    daemon, "/api/ui/config", undefined, "GET")).config.residentDrawerPinned;

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  // Pinning changes nothing on screen: the same column, the same place.
  await expect(drawer.getByRole("button", { name: "Unpin", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await drawer.boundingBox()).toEqual(box);
  await expect(edgeTab(page)).toHaveCount(0);
  await expect.poll(storedPin).toBe(true);
  await capture(page, "05-pinned");

  await page.reload();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  // Restored by a reload, it does not take the keyboard on its own.
  await expect(headOf(drawer)).not.toBeFocused();

  await drawer.getByRole("button", { name: `Open ${NAME}` }).click();
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expect(drawer).toBeVisible();
  await expectOffFleet(page);
  await page.locator("body").press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(headOf(drawer)).toBeFocused();

  await drawer.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Pin", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(storedPin).toBe(false);
  await page.reload();
  await expect(edgeTab(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);

  // Closing a pinned drawer unpins it too, so it stays closed after a reload.
  await page.keyboard.press("Shift+KeyH");
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  await expect.poll(storedPin).toBe(true);
  await closeDrawer(page);
  await expect.poll(storedPin).toBe(false);
  await page.reload();
  await expect(edgeTab(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);
});

test("a resident that needs you is a visitor card while the drawer is closed, and a click opens its conversation", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon, "board");
  const reviewId = await askResident(daemon);

  const needsYou = page.locator(".board-col.tone-attention");
  const visitor = needsYou.getByRole("button", { name: `${NAME} needs you - resident, opens its conversation` });
  await expect(visitor).toBeVisible();
  await expect(needsYou).toContainText("Resident · opens its conversation");
  await expect(edgeTab(page)).toHaveClass(/needs-you/);
  // The Need you count still includes the resident.
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toBeVisible();
  await capture(page, "06-visitor-card");

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await page.keyboard.press("Shift+KeyH");
  await expect(visitor).toBeVisible();

  // The tile is the click target: its conversation opens, and the drawer stays closed.
  await page.locator(".resident-visitor").click();
  await expect(band(page)).toBeVisible();
  await expect(page.locator(".board-detail").getByRole("tab", { name: "Conversation", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await capture(page, "06b-visitor-opens-conversation");
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(visitor).toBeVisible();

  await page.keyboard.press("Alt+Digit1");
  await expect(band(page)).toBeVisible();
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await expectOffFleet(page);
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(visitor).toBeVisible();

  await request(daemon, `/api/reviews/${reviewId}/resolve`, { action: "dismiss" });
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await expectOffFleet(page);
});

test("Board and Console placement restores the fleet placement and the dock, live, and ⌥1 still opens", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon, "board");
  await expectOffFleet(page);

  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const picker = page.getByRole("radiogroup", { name: "Where residents live" });
  await expect(picker.getByRole("radio", { name: "Drawer" })).toBeChecked();
  await picker.getByRole("radio", { name: "Board and Console" }).check();
  await expect(picker.locator("label.is-on")).toHaveText(/^Board and Console/);
  await capture(page, "07-settings");
  await page.getByRole("button", { name: /Fleet/ }).first().click();

  await expect(page.locator(".board-col", { hasText: NAME })).toHaveCount(1);
  await expect(edgeTab(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  const dock = page.getByRole("dialog", { name: "Residents", exact: true });
  await expect(dock.getByRole("heading", { name: "Live", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dock).toBeHidden();

  await page.keyboard.press("Alt+Digit1");
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
});

test("the ⌘K palette finds a live resident by name or label and opens its full detail", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon, "board");
  const palette = page.getByRole("dialog").filter({ has: page.getByRole("combobox") }).first();
  const row = page.getByRole("option", { name: `${NAME}, resident` });

  await page.keyboard.press("Meta+K");
  await page.keyboard.type("DW");
  await expect(row).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.keyboard.press("Meta+K");
  await page.keyboard.type(NAME);
  await row.click();
  await expect(palette).toBeHidden();
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expectOffFleet(page);
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(drawerOf(page)).toHaveCount(0);
});

test("the arrow keys move the drawer's selection and Enter opens the selected resident", async ({ dashboard: page, daemon }) => {
  const FIRST = "Alpha keeper";
  const SECOND = "Bravo keeper";
  await launch(daemon, FIRST);
  await launch(daemon, SECOND);
  await useDrawer(page, daemon, "board");

  // Both residents have reached the dashboard before the drawer opens, so both cards are there
  // to walk from the first press.
  await expect(page.getByRole("button", { name: "Residents - 2 live", exact: true })).toBeVisible();
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(cardOf(drawer, FIRST)).toBeVisible();
  await expect(cardOf(drawer, SECOND)).toBeVisible();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-current", "true");
  await expect(headOf(drawer, FIRST)).toBeFocused();
  await expect(cardOf(drawer, FIRST)).toContainText("⌥1");
  await expect(cardOf(drawer, SECOND)).toContainText("⌥2");
  // The selection is not the fold: both cards are open, and moving the selection keeps them so.
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-expanded", "true");

  // The selection stops at the ends; it does not wrap.
  await page.keyboard.press("ArrowUp");
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-current", "true");
  await expect(headOf(drawer, SECOND)).not.toHaveAttribute("aria-current");
  await expect(headOf(drawer, FIRST)).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-current", "true");
  await expect(headOf(drawer, FIRST)).not.toHaveAttribute("aria-current");
  await expect(headOf(drawer, SECOND)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-current", "true");
  await expect(headOf(drawer, FIRST)).not.toHaveAttribute("aria-current");
  await expect(headOf(drawer, SECOND)).toBeFocused();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(band(page, SECOND)).toBeVisible();
  await expect(drawer).toBeVisible();
  await expectOffFleet(page, SECOND);

  await page.locator("body").press("Escape");
  await expect(band(page, SECOND)).toBeHidden();
  await expect(headOf(drawer, SECOND)).toBeFocused();
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("ArrowUp");
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  await expect(band(page, FIRST)).toBeVisible();
  await expectOffFleet(page, FIRST);
});

test("Enter on a visitor card opens its resident's conversation, not the drawer", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon, "board");
  await askResident(daemon);
  const visitorOpen = page.getByRole("button", { name: `${NAME} needs you - resident, opens its conversation` });
  await expect(visitorOpen).toBeVisible();
  const drawer = drawerOf(page);

  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("ArrowDown");
  await expect(visitorOpen).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(band(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(band(page)).toBeHidden();
  await expect(visitorOpen).toBeVisible();

  // With the cursor on the visitor but the keyboard nowhere in particular, App's own Enter arm
  // opens the same conversation.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await expect(band(page)).toBeVisible();
  await expect(drawer).toHaveCount(0);
});

test("opened before any resident has arrived, the drawer puts the keyboard on the first card once it does", async ({ dashboard: page, daemon }) => {
  await useDrawer(page, daemon, "board");
  await expect(page.getByRole("button", { name: "Residents - 0 live", exact: true })).toBeVisible();

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toContainText("No residents are running. Launch one from a profile below.");

  // The resident arrives while the drawer is open and nobody has touched anything since.
  await launch(daemon);
  await expect(cardOf(drawer)).toBeVisible({ timeout: 60_000 });
  await expect(headOf(drawer)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(band(page)).toBeVisible();
});

test("a click elsewhere while the drawer waits for its first resident keeps the keyboard where it went", async ({ dashboard: page, daemon }) => {
  await useDrawer(page, daemon, "board");
  await expect(page.getByRole("button", { name: "Residents - 0 live", exact: true })).toBeVisible();

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toContainText("No residents are running. Launch one from a profile below.");
  // The operator moves on to the page beside it before any resident arrives. (With no session
  // anywhere the Board has nothing to draw, so this is its empty state.)
  await page.mouse.click(40, 400);

  await launch(daemon);
  await expect(cardOf(drawer)).toBeVisible({ timeout: 60_000 });
  await expect(headOf(drawer)).toBeEnabled();
  // Given every chance to land, it never pulls the keyboard into the drawer.
  await page.waitForTimeout(500);
  await expect(headOf(drawer)).not.toBeFocused();
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(false);
});

test("reopened after the selected resident has ended, the drawer puts the keyboard on a live card", async ({ dashboard: page, daemon }) => {
  const FIRST = "Alpha keeper";
  const SECOND = "Bravo keeper";
  await launch(daemon, FIRST);
  await launch(daemon, SECOND);
  await useDrawer(page, daemon, "board");
  await expect(page.getByRole("button", { name: "Residents - 2 live", exact: true })).toBeVisible();

  // Alpha is selected, and the drawer is closed with that selection left on it.
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(headOf(drawer, FIRST)).toBeFocused();
  await expect(headOf(drawer, FIRST)).toHaveAttribute("aria-current", "true");
  const firstId = await cardOf(drawer, FIRST).getAttribute("data-resident-card");
  await page.keyboard.press("Shift+KeyH");
  await expect(drawer).toHaveCount(0);

  // Alpha's run ends while the drawer is closed; Bravo is still live.
  const sessions = await request<Array<{ id: string; task?: { id: string } }>>(daemon, "/api/sessions", undefined, "GET");
  const firstTask = sessions.find((s) => s.id === firstId)?.task?.id;
  expect(firstTask, "the selected resident's session carries its task").toBeTruthy();
  await request(daemon, `/api/tasks/${firstTask}/complete`, { outcome: "Stood down" });
  await expect(page.getByRole("button", { name: "Residents - 1 live", exact: true })).toBeVisible({ timeout: 60_000 });

  await page.keyboard.press("Shift+KeyH");
  await expect(cardOf(drawer, FIRST)).toHaveCount(0);
  await expect(headOf(drawer, SECOND)).toBeFocused();
  await expect(headOf(drawer, SECOND)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  await expect(band(page, SECOND)).toBeVisible();
});

test("the drawer's footer launches a profile, and a profile with no repository launches through Dispatch", async ({ dashboard: page, daemon }) => {
  const WITH_REPO = "Footer launcher";
  const NO_REPO = "Footer gardener";
  await createProfile(daemon, WITH_REPO);
  await createProfile(daemon, NO_REPO, false);
  await useDrawer(page, daemon, "board");

  await expect(edgeTab(page)).toHaveAccessibleName("Open the Residents drawer - 0 live");
  await expect(edgeTab(page).locator(".residents-edge-count")).toHaveCount(0);
  await expect(edgeTab(page)).toHaveText("⌂");

  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toContainText("No residents are running. Launch one from a profile below.");
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText("Residents · 0 live");
  await expect(drawer.getByRole("list", { name: "Live residents" })).toHaveCount(0);
  const footer = drawer.locator(".residents-drawer-foot");
  const row = (name: string): Locator => footer.getByRole("listitem").filter({ hasText: name });
  await expect(row(WITH_REPO).getByRole("button", { name: `Launch ${WITH_REPO}` })).toHaveText("Launch");
  await expect(row(NO_REPO).getByRole("button", { name: `Launch ${NO_REPO}` })).toHaveText("Launch…");

  await row(WITH_REPO).getByRole("button", { name: `Launch ${WITH_REPO}` }).click();
  await expect(row(WITH_REPO).getByRole("status")).toHaveText("launched", { timeout: 60_000 });
  await expect(cardOf(drawer, WITH_REPO)).toBeVisible({ timeout: 60_000 });
  await capture(page, "08-footer-launched");

  await row(NO_REPO).getByRole("button", { name: `Launch ${NO_REPO}` }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog.getByRole("radio", { name: "Resident" })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("radio", { name: new RegExp(NO_REPO) })).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("combobox", { name: "Repository" })).toHaveValue("");
});

test("Manage residents sits on its own row at the top, above the cards, and opens the Residents page", async ({ dashboard: page, daemon }) => {
  const FIRST = "Alpha keeper";
  const SECOND = "Bravo keeper";
  await launch(daemon, FIRST);
  await launch(daemon, SECOND);
  await useDrawer(page, daemon, "board");

  // Both residents have reached the dashboard before the drawer opens, so the layout measured
  // below is the one with both cards in it.
  await expect(page.getByRole("button", { name: "Residents - 2 live", exact: true })).toBeVisible();
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(cardOf(drawer, SECOND)).toBeVisible();
  const manage = drawer.getByRole("button", { name: "Manage residents" });
  await expect(manage).toHaveCount(1);
  // The new row does not take the keyboard: opening the drawer still lands on the selected card.
  await expect(headOf(drawer, FIRST)).toBeFocused();
  await expect(manage).toBeInViewport();
  // Under the title, before the first card, and no longer in the footer under the profiles.
  const title = await drawer.getByRole("heading", { level: 2 }).boundingBox();
  const button = await manage.boundingBox();
  const firstCard = await cardOf(drawer, FIRST).boundingBox();
  expect(title && button && firstCard).toBeTruthy();
  expect(button!.y).toBeGreaterThan(title!.y + title!.height);
  expect(button!.y + button!.height).toBeLessThanOrEqual(firstCard!.y);
  await expect(drawer.locator(".residents-drawer-foot").getByRole("button", { name: "Manage residents" })).toHaveCount(0);
  await expectContentClearsBorder(drawer);
  await capture(page, "09-manage-at-top");

  // The drawer is a column on Fleet, so it is not drawn over the Residents page.
  await manage.click();
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(`${daemon.baseURL}/#/residents`);
});

test("the Keyboard panel refuses ⌥1 as macOS delivers it, and drops a binding stored as its symbol", async ({ dashboard: page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/keyboard`);
  const panel = page
    .locator("section.settings-section")
    .filter({ has: page.getByRole("heading", { name: "Shortcuts", exact: true }) });
  const diffRow = panel.locator('[data-anchor="keyboard/diff"]');
  await diffRow.getByRole("button", { name: /^Change shortcut for Open diff/ }).click();
  await expect(diffRow.getByRole("button", { name: /^Recording/ })).toBeVisible();

  // What a US-layout Mac delivers for Option+1: the symbol it types as `key`, the digit as `code`.
  // Playwright's key table cannot produce the symbol, so the event is dispatched as the OS sends it.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "¡", code: "Digit1", altKey: true, bubbles: true, cancelable: true,
    }));
  });
  await expect(panel.locator(".settings-error")).toHaveText("⌥1 is reserved for the resident jump shortcuts.");
  await expect(diffRow.getByRole("button", { name: /^Recording/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(diffRow.getByRole("button", { name: /^Change shortcut for Open diff \(currently ⇧D\)/ })).toBeVisible();

  // A binding an earlier build recorded as the symbol is dropped on read: the action keeps its own key.
  await request(daemon, "/api/ui/config", { keybindings: { diff: "alt+¡" } }, "PUT");
  await page.reload();
  await expect(
    panel.locator('[data-anchor="keyboard/diff"]').getByRole("button", { name: /^Change shortcut for Open diff \(currently ⇧D\)/ }),
  ).toBeVisible();
});

test("opening or pinning from another page lands on Fleet with the keyboard on a card", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon, "board");
  const drawer = drawerOf(page);
  await expect(page.getByRole("button", { name: "Residents - 1 live", exact: true })).toBeVisible();

  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await page.keyboard.press("Shift+KeyH");
  await expect(page).toHaveURL(/#\/fleet/);
  await expect(drawer).toBeVisible();
  await expect(headOf(drawer)).toBeFocused();
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();

  // The drawer mounts on Fleet with the palette's focus request already set.
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(drawer).toHaveCount(0);
  await page.keyboard.press("Meta+K");
  await page.keyboard.type("Residents drawer or dock");
  await page.getByRole("option", { name: "Open the Residents drawer or dock, command" }).click();
  await expect(page).toHaveURL(/#\/fleet/);
  await expect(headOf(drawer)).toBeFocused();
});
