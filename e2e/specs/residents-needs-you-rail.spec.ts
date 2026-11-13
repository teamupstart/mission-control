import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * Residents that need you, in Drawer placement:
 *
 * - While a conversation is open, every resident that needs you is an ordinary row in the Needs
 *   you rail, so opening one drills into a full rail listing everything asking, and the
 *   conversation moves between them with a click.
 * - With no conversation open, they stay out of the Needs you column while the drawer is on
 *   screen, and lead the drawer in a Needs you group carrying the review chord's keycap, which
 *   `e` follows.
 *
 * Same setup as `residents-drawer.spec.ts`. No model tokens are spent: every agent binary is
 * redirected by `e2e/fixtures/fake-agents.ts`, and each resident's question is posted on
 * `POST /mcp/reviews`, the channel its own `request_input` tool uses.
 */

const EVIDENCE = artifactsDir("residents-needs-you-rail");
const QUIET = "Quiet watcher";
const ASK_A = "Asking watcher A";
const ASK_B = "Asking watcher B";

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

/** How many launched residents are waiting between iterations. */
function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

/** Author a profile and launch it through the real routes, then wait until its loop is waiting. */
async function launch(daemon: DaemonHandle, name: string): Promise<ResidentProfile> {
  const before = waitingResidents(daemon);
  const personas = await request<Array<{ id: string; name: string }>>(daemon, "/api/personas", undefined, "GET");
  const profile = await request<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name }, persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    // A long cadence keeps the resident waiting between steps instead of iterating under the test.
    loop: { delaySeconds: 3600, minDelaySeconds: 60, maxDelaySeconds: 3600 },
  } });
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, {
    repoRoot: daemon.repo, requestId: `launch-${name.toLowerCase().replace(/\W+/g, "-")}`,
  });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(before + 1);
  return profile;
}

/** The session a task started, once it has one. */
async function sessionOfTask(daemon: DaemonHandle, taskId: string): Promise<string> {
  let sessionId: string | undefined;
  await expect.poll(async () => {
    const sessions = await request<Array<{ id: string; task?: { id?: string } }>>(daemon, "/api/sessions", undefined, "GET");
    sessionId = sessions.find((s) => s.task?.id === taskId)?.id;
    return sessionId;
  }, { timeout: 60_000 }).toBeTruthy();
  return sessionId!;
}

/**
 * Stand in for a session calling its bundled request_input tool, with `<name>: ship it?` as the
 * question. Returns the review id.
 */
async function askSession(daemon: DaemonHandle, sessionId: string, name: string): Promise<string> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST", headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {}, sessionId, kind: "input", title: `${name}: ship it?`, body: `${name}: ship it?`,
      decisions: [{ id: "q", question: `${name}: ship it?`, options: [
        { id: "yes", label: "Ship it" }, { id: "no", label: "Hold it" },
      ], allowOther: false }],
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

/** The live session of a launched resident. */
async function residentSession(daemon: DaemonHandle, profile: ResidentProfile): Promise<string> {
  const taskId = withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT task_id FROM resident_runs WHERE profile_id = ? AND ended_at IS NULL",
  ).get(profile.id) as { task_id: string }).task_id);
  return sessionOfTask(daemon, taskId);
}

/** Stand in for one resident calling its bundled request_input tool. */
async function ask(daemon: DaemonHandle, profile: ResidentProfile): Promise<string> {
  return askSession(daemon, await residentSession(daemon, profile), profile.name);
}

/**
 * Park a resident on a permission prompt: the `Notification` hook a real Claude install posts,
 * in the shape `hooks/harness-hook.mjs` forwards, attributed by the SDK driver's native identity.
 * It moves the session to `awaiting_input` and files no review, so the resident needs you with no
 * review queue to open. The message avoids "waiting for your input", which reads as an idle nudge.
 */
async function parkOnPermissionPrompt(daemon: DaemonHandle, profile: ResidentProfile): Promise<void> {
  const sessionId = await residentSession(daemon, profile);
  let identity: { cwd: string; sessionId: string } | null = null;
  await expect.poll(async () => {
    const sessions = await request<Array<{ id: string; cwd: string; agentSessionId: string | null }>>(
      daemon, "/api/sessions", undefined, "GET");
    const session = sessions.find((s) => s.id === sessionId);
    identity = session?.agentSessionId ? { cwd: session.cwd, sessionId: session.agentSessionId } : null;
    return identity !== null;
  }, { message: "the SDK driver binds its native identity before its hooks are posted", timeout: 30_000 }).toBe(true);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Notification`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ agent: "claude", ...identity!, env: {}, message: "Claude needs your permission to use Bash" }),
  });
  expect(response.status, "the daemon accepted the hook").toBe(204);
}

/** Opt this spec's dashboard into the drawer, in one layout, and land on the fleet. */
async function useDrawer(page: Page, daemon: DaemonHandle, layout: "board" | "console"): Promise<void> {
  const config = { residentPlacement: "drawer", residentDrawerPinned: false, layout };
  await request(daemon, "/api/ui/config", config, "PUT");
  await page.evaluate((next) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...next }));
  }, config);
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
}

const drawerOf = (page: Page): Locator => page.getByRole("complementary", { name: "Residents", exact: true });
const headOf = (scope: Locator, name: string): Locator => scope.getByRole("button", { name: new RegExp(`^${name}, `) });
const band = (page: Page, name: string): Locator => page.getByRole("group", { name: `Resident ${name}` });
/** A session row in a rail: the drill-in's column or the Console's. */
const railRowOf = (rail: Locator, name: string): Locator => rail.locator("button.rail-row", { hasText: name });

/**
 * Three residents launched interleaved - asking, quiet, asking - so their ⌥-numbers are ⌥1 (A),
 * ⌥2 (quiet) and ⌥3 (B), with both asking residents' questions posted, on a Board beside a pinned
 * drawer: the setup the reported screenshot showed. Interleaved so the drawer's drawn order (A, B,
 * quiet) differs from launch order at every step.
 */
async function threeResidentsBesidePinnedDrawer(page: Page, daemon: DaemonHandle): Promise<Locator> {
  const askA = await launch(daemon, ASK_A);
  await launch(daemon, QUIET);
  const askB = await launch(daemon, ASK_B);
  await ask(daemon, askA);
  await ask(daemon, askB);
  await useDrawer(page, daemon, "board");
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  return drawer;
}

test("on the Board, opening a resident that needs you drills into a full Needs you rail of everything asking, and a click swaps between them", async ({ dashboard: page, daemon }) => {
  const drawer = await threeResidentsBesidePinnedDrawer(page, daemon);
  const needsYouColumn = page.locator(".board-col.tone-attention");

  // Opening one drills the Board into the Needs you rail at full rail width, listing both
  // residents asking, and not the quiet one.
  await drawer.getByRole("button", { name: `Open ${ASK_A}` }).click();
  await expect(band(page, ASK_A)).toBeVisible();
  const rail = page.locator(".board-col.is-rail");
  await expect(rail).toHaveClass(/tone-attention/);
  await expect(rail.getByRole("heading", { name: "needs you" })).toBeVisible();
  await expect(railRowOf(rail, ASK_A)).toBeVisible();
  await expect(railRowOf(rail, ASK_A)).toHaveAttribute("aria-current", "true");
  await expect(railRowOf(rail, ASK_B)).toBeVisible();
  await expect(rail).not.toContainText(QUIET);
  // Read once the drill-in morph has settled: the rail animates in from the column's width.
  await expect.poll(async () => (await rail.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  // Ordinary rows, not doorways, and the ⌘-numbers skip them.
  await expect(rail.locator(".resident-visitor")).toHaveCount(0);
  await expect(railRowOf(rail, ASK_B)).not.toHaveAttribute("aria-keyshortcuts", /.+/);
  await capture(page, "02-drill-in-needs-you-rail");

  // A click on the other row swaps the conversation; the drawer stays beside it.
  await railRowOf(rail, ASK_B).click();
  await expect(band(page, ASK_B)).toBeVisible();
  await expect(band(page, ASK_A)).toHaveCount(0);
  await expect(railRowOf(rail, ASK_B)).toHaveAttribute("aria-current", "true");
  await expect(drawer).toBeVisible();
  await capture(page, "03-swapped-to-second-resident");

  // Back on the Board, they leave Needs you again for the drawer, and Escape hands the keyboard
  // to the open resident's card.
  await page.locator("body").press("Escape");
  await expect(band(page, ASK_B)).toBeHidden();
  await expect(headOf(drawer, ASK_B)).toBeFocused();
  for (const name of [QUIET, ASK_A, ASK_B]) await expect(needsYouColumn.filter({ hasText: name })).toHaveCount(0);
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
});

test("with no conversation open, residents that need you stay out of the Needs you column and lead the drawer in a Needs you group that `e` reaches", async ({ dashboard: page, daemon }) => {
  const drawer = await threeResidentsBesidePinnedDrawer(page, daemon);

  // The drawer is on screen beside the Board, so no resident is in Needs you, not even a visitor.
  const needsYouColumn = page.locator(".board-col.tone-attention");
  for (const name of [QUIET, ASK_A, ASK_B]) await expect(needsYouColumn.filter({ hasText: name })).toHaveCount(0);
  await expect(page.locator(".resident-visitor")).toHaveCount(0);

  // The drawer leads with a Needs you group holding just the two asking residents, the review
  // chord's keycap on its heading, and the quiet resident below it. Every card keeps its ⌥-number.
  const group = drawer.getByRole("region", { name: "Needs you", exact: true });
  await expect(group).toBeVisible();
  await expect(group.getByRole("heading", { name: "Needs you" })).toBeVisible();
  // The review chord's keycap, printed as the Board column prints it: a lowercase `e`.
  const reviewKey = group.locator(".residents-drawer-group-key kbd");
  await expect(reviewKey).toHaveText("e");
  expect(await reviewKey.evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
  await expect(group.locator(".residents-drawer-group-n")).toHaveText("2");
  const asking = group.getByRole("list", { name: "Residents that need you" });
  await expect(headOf(asking, ASK_A)).toBeVisible();
  await expect(headOf(asking, ASK_B)).toBeVisible();
  await expect(headOf(asking, QUIET)).toHaveCount(0);
  await expect(headOf(drawer.getByRole("list", { name: "Live residents" }), QUIET)).toBeVisible();
  const cardOrder = await drawer.locator("[data-resident-card] .residents-drawer-name").allTextContents();
  expect(cardOrder).toEqual([ASK_A, ASK_B, QUIET]);
  const keycaps = await drawer.locator(".residents-drawer-key").allTextContents();
  expect(keycaps).toEqual(["⌥1", "⌥3", "⌥2"]);
  await capture(page, "01-drawer-needs-you-group");

  // The arrow keys walk the cards in the drawn order, not launch order: from A, down reaches B
  // (launch order would reach the quiet resident), then the quiet one, and back up the same way.
  await headOf(drawer, ASK_A).focus();
  await expect(headOf(drawer, ASK_A)).toHaveAttribute("aria-current", "true");
  for (const [key, name] of [
    ["ArrowDown", ASK_B], ["ArrowDown", QUIET], ["ArrowDown", QUIET],
    ["ArrowUp", ASK_B], ["ArrowUp", ASK_A], ["ArrowUp", ASK_A],
  ] as const) {
    await page.keyboard.press(key);
    await expect(headOf(drawer, name), `${key} lands on ${name}`).toHaveAttribute("aria-current", "true");
    await expect(headOf(drawer, name)).toBeFocused();
  }

  // `e` reaches the group: no fleet session is asking, so it opens the first resident's queue.
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("e");
  const reviewDialog = page.getByRole("dialog");
  await expect(reviewDialog).toBeVisible();
  await expect(reviewDialog).toContainText(`${ASK_A}: ship it?`);
  await expect(headOf(drawer, ASK_A)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Escape");
  await expect(reviewDialog).toHaveCount(0);
});

test("with a fleet session and a drawer resident both asking, `e` opens the fleet session's question first", async ({ dashboard: page, daemon }) => {
  const askA = await launch(daemon, ASK_A);
  const residentReview = await ask(daemon, askA);
  // A fleet session asking too: dispatched straight over the API, opted out of Workflows.
  const task = await request<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fleet neighbour", intent: "settle and wait", workflowId: null,
  });
  const fleetReview = await askSession(daemon, await sessionOfTask(daemon, task.id), "Fleet neighbour");
  await useDrawer(page, daemon, "board");
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(drawer.getByRole("region", { name: "Needs you", exact: true })).toBeVisible();
  await expect(page.locator(".board-col.tone-attention")).toContainText("Fleet neighbour");

  // The fleet is to the drawer's left and comes first.
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("e");
  const reviewDialog = page.getByRole("dialog");
  await expect(reviewDialog).toContainText("Fleet neighbour: ship it?");
  await expect(reviewDialog).not.toContainText(`${ASK_A}: ship it?`);
  await capture(page, "06-e-fleet-first");
  await page.keyboard.press("Escape");
  await expect(reviewDialog).toHaveCount(0);

  // Still first with the resident's own conversation open and selected, when the resident is a
  // row in the Needs you rail: its review does not jump ahead of the fleet session's.
  await drawer.getByRole("button", { name: `Open ${ASK_A}` }).click();
  await expect(band(page, ASK_A)).toBeVisible();
  await expect(railRowOf(page.locator(".board-col.is-rail.tone-attention"), ASK_A)).toHaveAttribute("aria-current", "true");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("e");
  await expect(reviewDialog).toContainText("Fleet neighbour: ship it?");
  await expect(reviewDialog).not.toContainText(`${ASK_A}: ship it?`);
  await page.keyboard.press("Escape");
  await expect(reviewDialog).toHaveCount(0);

  // Once the fleet session's question is answered, `e` reaches the resident in the drawer.
  await request(daemon, `/api/reviews/${fleetReview}/resolve`, { action: "dismiss" });
  await expect(page.locator(".board-col.tone-attention")).not.toContainText("Fleet neighbour");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("e");
  await expect(reviewDialog).toContainText(`${ASK_A}: ship it?`);
  await expect(headOf(drawer, ASK_A)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Escape");
  await request(daemon, `/api/reviews/${residentReview}/resolve`, { action: "dismiss" });
  await expect(drawer.getByRole("region", { name: "Needs you", exact: true })).toHaveCount(0);
});

test("a drawer resident that needs you without a review: `e` still addresses it, by opening its conversation", async ({ dashboard: page, daemon }) => {
  const resident = await launch(daemon, ASK_A);
  await useDrawer(page, daemon, "board");
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();

  await parkOnPermissionPrompt(daemon, resident);
  const group = drawer.getByRole("region", { name: "Needs you", exact: true });
  await expect(headOf(group, ASK_A)).toBeVisible();
  // No review is filed, and the heading still names the key, because the key still reaches it.
  await expect(group.locator(".residents-drawer-group-key kbd")).toHaveText("e");
  await capture(page, "07-awaiting-input-group");

  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("e");
  await expect(band(page, ASK_A)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".board-detail").getByRole("tab", { name: "Conversation", exact: true })).toHaveAttribute("aria-selected", "true");
  // The cursor lands in its reply box, ready to answer.
  await expect(page.locator(".board-detail").getByPlaceholder(/^Reply to this session/)).toBeFocused();
  // Its conversation is open, so it is a row in the Needs you rail like any other resident asking.
  await expect(railRowOf(page.locator(".board-col.is-rail.tone-attention"), ASK_A)).toBeVisible();
  await capture(page, "08-e-opens-awaiting-input-conversation");
});

test("with another conversation open, `e` still reaches a resident awaiting input from the Needs you rail", async ({ dashboard: page, daemon }) => {
  const resident = await launch(daemon, ASK_A);
  // A fleet session that is NOT asking: the conversation the operator has open.
  const neighbour = await request<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fleet neighbour", intent: "settle and wait", workflowId: null,
  });
  await useDrawer(page, daemon, "board");
  await page.keyboard.press("Shift+KeyH");
  const drawer = drawerOf(page);
  await drawer.getByRole("button", { name: "Pin", exact: true }).click();
  await parkOnPermissionPrompt(daemon, resident);
  const group = drawer.getByRole("region", { name: "Needs you", exact: true });
  await expect(headOf(group, ASK_A)).toBeVisible();
  await expect(group.locator(".residents-drawer-group-key kbd")).toHaveText("e");

  // Open the fleet session's conversation. The resident is on the fleet now, as a Needs you row,
  // and no review is pending anywhere.
  // The session's own tile, never the provisioning placeholder (`.pend-tile`) the Board draws
  // with the same title while the task starts: that placeholder opens nothing, and under suite
  // load the task was still starting when the click landed on it.
  await sessionOfTask(daemon, neighbour.id);
  const fleetTile = page.locator("section.board-col .tile:not(.pend-tile)").filter({ hasText: "Fleet neighbour" });
  await expect(fleetTile).toBeVisible({ timeout: 60_000 });
  // The tile's pointer half is the card itself, as a person clicks it.
  await fleetTile.click();
  const detail = page.locator(".board-detail");
  await expect(detail.locator(".cdetail")).toBeVisible();
  await expect(detail).toContainText("Fleet neighbour");
  await expect(band(page, ASK_A)).toHaveCount(0);

  // `e` addresses the resident: its conversation opens, with the cursor in its reply box.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("e");
  await expect(band(page, ASK_A)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeFocused();
  await expect(railRowOf(page.locator(".board-col.is-rail.tone-attention"), ASK_A)).toHaveAttribute("aria-current", "true");
  await capture(page, "09-e-from-another-conversation");

  // Pressed again with that conversation open and nothing else asking, `e` puts the cursor back
  // in its reply box rather than doing nothing.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(reply).not.toBeFocused();
  await page.keyboard.press("e");
  await expect(reply).toBeFocused();
  await expect(band(page, ASK_A)).toBeVisible();
});

test("in Console, a resident that needs you joins the rail as a row once a conversation is open", async ({ dashboard: page, daemon }) => {
  const askA = await launch(daemon, ASK_A);
  await ask(daemon, askA);
  // A fleet session to open first: dispatched straight over the API, opted out of Workflows.
  await request(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fleet neighbour", intent: "settle and wait", workflowId: null,
  });
  await useDrawer(page, daemon, "console");
  const rail = page.locator(".console-rail");
  await expect(railRowOf(rail, "Fleet neighbour")).toBeVisible({ timeout: 60_000 });

  // Nothing open and the drawer closed: the resident is a visitor card standing in for it.
  const visitor = rail.getByRole("button", { name: `${ASK_A} needs you - resident, opens its conversation` });
  await expect(visitor).toBeVisible();

  // Open the fleet session: the resident becomes an ordinary row among the sessions that need you.
  await railRowOf(rail, "Fleet neighbour").click();
  await expect(page.locator(".console-detail .cdetail")).toBeVisible();
  await expect(visitor).toHaveCount(0);
  const row = railRowOf(rail, ASK_A);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/tone-attention/);
  await expect(rail.locator(".rail-group.tone-attention")).toBeVisible();
  await capture(page, "04-console-rail-resident-row");

  // A click on its row swaps the conversation to it.
  await row.click();
  await expect(band(page, ASK_A)).toBeVisible();
  await expect(row).toHaveAttribute("aria-current", "true");
  await capture(page, "05-console-resident-open");
});
