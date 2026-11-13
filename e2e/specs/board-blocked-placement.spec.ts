import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Settings → Display → Blocked sessions: where the Board draws idle sessions standing on a
 * blocker, walked through all three placements against one fleet.
 *
 * Every claim here needs a browser. The unit tests in `test/blocked-placement.test.ts` prove the
 * one ordering and the column rules; they cannot see two laid-out scrollports, a card clipped
 * by a lane, a frame above a card, or a keystroke opening the card it prints on.
 *
 * - **In Needs you** (the default): two lanes in the attention column. With Needs you full, the
 *   Blocked lane still shows at least one whole card, sits at the bottom of the column, and the
 *   two lanes scroll independently. The ⌘-numbers and the arrow keys run from the last Needs
 *   you card into the lane, and a drill-in keeps both lanes.
 * - **At the top of Idle**: a red frame above the idle cards, whose fold survives a reload. A
 *   folded frame takes its cards out of the ⌘-numbers and the arrow keys too, and unfolding puts
 *   them back - the branch App owns, which a unit test over the full column order cannot reach.
 * - **Own column**: a Blocked column immediately after Needs you.
 * - **Console**: the rail's red Blocked heading sits where the Board draws the group: before
 *   Working for In Needs you and Own column, after it (at the top of Idle) for At the top of Idle.
 *   One session is held in Working so that difference is visible.
 *
 * Inside the group a flagged reply leads, then the oldest blocker. The three blocked sessions are
 * named so that order differs from alphabetical order, which the baseline would produce.
 *
 * No model tokens: every agent is `e2e/fixtures/fake-agents.ts`, questions are posted over
 * `POST /mcp/reviews` and blockers over `POST /mcp/blocker`, the routes the agent's MCP child
 * uses.
 */

const EVIDENCE = artifactsDir("blocked-placement");

/** Enough Needs you cards to overflow its lane at this height. */
const ASKING = ["Ask Alpha", "Ask Bravo", "Ask Charlie", "Ask Delta"];
/** Reported in this order, so Zulu's blocker is the oldest and X-ray's the newest. */
const BLOCKED = ["Blocked Zulu", "Blocked Yankee", "Blocked Xray"];
/** X-ray is flagged, so it leads; then the oldest. Alphabetical would be X-ray, Yankee, Zulu. */
const BLOCKED_ORDER = ["Blocked Xray", "Blocked Zulu", "Blocked Yankee"];
const IDLE = "Idle India";
/** Held in Working for the whole spec by the fake agent's release marker, which nothing writes. */
const WORKING = "Work Whiskey";
const HOLD_TURN = "E2E_HOLD_TURN_UNTIL_RELEASED";

interface LiveSession {
  id: string;
  name: string;
  state: string;
  cwd: string | null;
  task?: { title?: string | null } | null;
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function mcp(daemon: DaemonHandle, path: string, body: Record<string, unknown>): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, ...body }),
  });
  expect(res.status, `${path} accepted the call: ${await res.clone().text()}`).toBe(200);
}

/** Dispatch straight over the API: the dispatch form is not what this spec is about. */
async function dispatch(daemon: DaemonHandle, title: string, intent = `hold a card for ${title}`): Promise<void> {
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title,
    intent,
    workflowId: null,
  });
}

async function settled(
  daemon: DaemonHandle,
  titles: readonly string[],
  state = "idle",
): Promise<Map<string, LiveSession>> {
  const byTitle = new Map<string, LiveSession>();
  await expect.poll(async () => {
    byTitle.clear();
    for (const s of await api<LiveSession[]>(daemon, "/api/sessions")) {
      const title = titles.find((t) => s.name === t || s.task?.title === t);
      if (title && s.state === state && s.cwd) byTitle.set(title, s);
    }
    return byTitle.size;
  }, { timeout: 180_000, message: `every dispatched session settled ${state}` }).toBe(titles.length);
  return byTitle;
}

async function setUi(page: Page, daemon: DaemonHandle, config: Record<string, unknown>): Promise<void> {
  await api(daemon, "/api/ui/config", config, "PUT");
  // A reload: the store paints from its first-paint cache and only reads the daemon at boot.
  await page.reload();
}

async function choosePlacement(
  page: Page,
  daemon: DaemonHandle,
  label: string,
  shotBefore?: string,
): Promise<void> {
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const group = page.getByRole("radiogroup", { name: "Where blocked sessions appear" });
  await expect(group).toBeVisible();
  if (shotBefore) await shoot(group.locator("xpath=ancestor::section[1]"), shotBefore);
  await group.getByRole("radio", { name: label }).check();
  await expect(group.getByRole("radio", { name: label })).toBeChecked();
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator("main.board")).toBeVisible();
}

async function names(tiles: Locator): Promise<string[]> {
  return (await tiles.locator(".tile-name").allInnerTexts()).map((t) => t.trim());
}

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  if ("mouse" in target) await target.mouse.move(0, 0);
  else await target.scrollIntoViewIfNeeded();
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/blocked-placement/${name}.png`);
}

test("idle blocked sessions follow Settings → Display → Blocked sessions on the Board and the rail", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(300_000);
  await dashboard.setViewportSize({ width: 1500, height: 820 });
  const titles = [...ASKING, ...BLOCKED, IDLE];
  for (const title of titles) await dispatch(daemon, title);
  await dispatch(daemon, WORKING, `${HOLD_TURN} keep working for ${WORKING}`);
  const byTitle = await settled(daemon, titles);
  await settled(daemon, [WORKING], "working");

  for (const title of ASKING) {
    const question = `What should ${title} do next?`;
    await mcp(daemon, "/mcp/reviews", {
      cwd: byTitle.get(title)!.cwd,
      kind: "input",
      title: question,
      body: question,
      decisions: [{
        id: "q",
        question,
        options: [{ id: "o0", label: "carry on", recommended: true }],
        allowOther: false,
      }],
    });
  }
  for (const title of BLOCKED) {
    await mcp(daemon, "/mcp/blocker", {
      sessionId: byTitle.get(title)!.id,
      kind: "dependency",
      reason: `${title} needs the platform migration merged before it can continue its work`,
      waitingOn: "the platform team",
      resumeWhen: "The migration pull request merges",
    });
    // Distinct start times, so "oldest first" has something to order.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
  await api(daemon, `/api/sessions/${byTitle.get("Blocked Xray")!.id}/blocker/reply`, {
    note: "The migration merged at 14:02",
  });

  await setUi(dashboard, daemon, { layout: "board" });
  const board = dashboard.locator("main.board");
  const needsYou = board.locator("section.board-col.tone-attention");
  const upper = needsYou.locator(":scope > .board-col-body");
  const lane = needsYou.getByRole("region", { name: "Blocked" });
  const laneBody = lane.locator(".board-lane-body");
  const idle = board.locator("section.board-col.tone-idle");

  // --- In Needs you, the default -------------------------------------------------------------
  await expect(upper.locator(".tile")).toHaveCount(ASKING.length);
  await expect(laneBody.locator(".tile.is-blocked")).toHaveCount(BLOCKED.length);
  expect(await names(laneBody.locator(".tile"))).toEqual(BLOCKED_ORDER);
  await expect(lane.locator(".board-lane-head")).toContainText(/Blocked\s*oldest \d+[smhd]\s*3/);
  await expect(idle.locator(".tile.is-blocked")).toHaveCount(0);
  await expect(idle.locator(".tile")).toHaveCount(1);

  const geometry = await needsYou.evaluate((col) => {
    const up = col.querySelector<HTMLElement>(":scope > .board-col-body")!;
    const laneEl = col.querySelector<HTMLElement>(".board-lane-blocked")!;
    const body = laneEl.querySelector<HTMLElement>(".board-lane-body")!;
    const first = body.querySelector<HTMLElement>(".tile")!;
    const r = (el: Element) => el.getBoundingClientRect();
    return {
      upperOverflows: up.scrollHeight > up.clientHeight + 1,
      laneOverflows: body.scrollHeight > body.clientHeight + 1,
      laneShare: r(laneEl).height / r(col).height,
      firstTop: r(first).top - r(body).top,
      firstBottom: r(body).bottom - r(first).bottom,
      laneBottomGap: Math.abs(r(col).bottom - r(laneEl).bottom),
    };
  });
  expect(geometry.upperOverflows, "Needs you is full and scrolls").toBe(true);
  expect(geometry.laneOverflows, "the Blocked lane holds more than it shows and scrolls").toBe(true);
  expect(geometry.firstTop, "the first Blocked card is not cut at the top").toBeGreaterThanOrEqual(0);
  expect(geometry.firstBottom, "the first Blocked card is not cut at the bottom").toBeGreaterThanOrEqual(0);
  expect(geometry.laneShare, "the lane stays within 45% of the column").toBeLessThanOrEqual(0.46);
  expect(geometry.laneBottomGap, "the lane sits at the bottom of the column").toBeLessThanOrEqual(2);

  await upper.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await laneBody.evaluate((el) => el.scrollTop)).toBe(0);
  const upperAtEnd = await upper.evaluate((el) => el.scrollTop);
  expect(upperAtEnd).toBeGreaterThan(0);
  await laneBody.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await laneBody.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await upper.evaluate((el) => el.scrollTop)).toBe(upperAtEnd);
  await upper.evaluate((el) => { el.scrollTop = 0; });
  await laneBody.evaluate((el) => { el.scrollTop = 0; });
  await shoot(dashboard, "01-in-needs-you-lanes");

  const keycap = (tile: Locator) => tile.locator(".tile-head .kb-hint");
  await expect(keycap(upper.locator(".tile").nth(3))).toHaveText("⌘4");
  await expect(keycap(laneBody.locator(".tile").first())).toHaveText("⌘5");
  await dashboard.keyboard.press("Meta+5");
  await expect(dashboard.locator(".cdetail").getByRole("heading", { name: BLOCKED_ORDER[0] })).toBeVisible();
  await expect(board.locator("section.board-col.is-rail.tone-attention")).toHaveCount(1);
  await expect(lane.locator(".rail-row")).toHaveCount(BLOCKED.length);
  await expect(upper.locator(".rail-row")).toHaveCount(ASKING.length);
  await dashboard.locator(".rail-row").filter({ hasText: BLOCKED_ORDER[0] }).focus();
  await dashboard.keyboard.press("ArrowUp");
  await expect(dashboard.locator(".cdetail").getByRole("heading", { name: ASKING.at(-1)! })).toBeVisible();
  await shoot(dashboard, "02-drill-in-keeps-both-lanes");
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Escape");
  await expect(board).toHaveAttribute("data-focus", "none");

  // --- At the top of Idle --------------------------------------------------------------------
  await choosePlacement(dashboard, daemon, "At the top of Idle", "00-settings-blocked-sessions");
  const frame = idle.getByRole("group", { name: "Blocked" });
  await expect(frame.locator(".tile.is-blocked")).toHaveCount(BLOCKED.length);
  expect(await names(frame.locator(".tile"))).toEqual(BLOCKED_ORDER);
  await expect(needsYou.getByRole("region", { name: "Blocked" })).toHaveCount(0);
  await expect(needsYou.locator(".tile.is-blocked")).toHaveCount(0);
  expect(await names(idle.locator(".tile"))).toEqual([...BLOCKED_ORDER, IDLE]);
  const fold = frame.getByRole("button", { name: /^Collapse Blocked - 3 blocked sessions, oldest/ });
  await expect(fold).toContainText(/Blocked\s*3 · oldest \d+[smhd]/);
  await shoot(dashboard, "03-top-of-idle-frame");
  await fold.click();
  await expect(frame.locator(".tile")).toHaveCount(0);
  await expect(frame.getByRole("button", { name: /^Expand Blocked/ })).toHaveAttribute("aria-expanded", "false");
  await dashboard.reload();
  await expect(frame.getByRole("button", { name: /^Expand Blocked/ })).toBeVisible();
  await expect(frame.locator(".tile")).toHaveCount(0);

  // The cursor is put on the first card the way `board-sidebar.spec.ts` does it: a background
  // click hands the keys to the Board, Escape drops any earlier selection, and ArrowDown from
  // nothing lands on the first card.
  const idleTile = idle.locator(".tile").filter({ hasText: IDLE });
  const selected = board.locator(".tile.selected");
  const fromFirstAsking = async (): Promise<void> => {
    await board.click({ position: { x: 4, y: 4 } });
    await dashboard.keyboard.press("Escape");
    await expect(selected).toHaveCount(0);
    await dashboard.keyboard.press("ArrowDown");
    await expect(selected).toContainText(ASKING[0]!);
    await expect(selected.locator(".tile-open")).toBeFocused();
    await dashboard.keyboard.press("ArrowRight");
    await expect(selected).toContainText(WORKING);
    await dashboard.keyboard.press("ArrowRight");
  };
  await expect(keycap(idleTile)).toHaveText("⌘6");
  await fromFirstAsking();
  await expect(frame.locator(".tile")).toHaveCount(0);
  await expect(selected).toHaveCount(1);
  await expect(selected).toContainText(IDLE);

  await frame.getByRole("button", { name: /^Expand Blocked/ }).click();
  await expect(frame.locator(".tile")).toHaveCount(BLOCKED.length);
  await expect(keycap(frame.locator(".tile").first())).toHaveText("⌘6");
  await expect(keycap(idleTile)).toHaveText("⌘9");
  await fromFirstAsking();
  await expect(selected).toHaveCount(1);
  await expect(selected).toContainText(BLOCKED_ORDER[0]!);
  await expect(frame.locator(".tile.selected")).toHaveCount(1);

  // --- Own column ----------------------------------------------------------------------------
  await choosePlacement(dashboard, daemon, "Own column");
  const blockedCol = board.locator("section.board-col.tone-blocked");
  await expect(blockedCol.getByRole("heading", { name: "blocked" })).toBeVisible();
  await expect(blockedCol.locator(".tile.is-blocked")).toHaveCount(BLOCKED.length);
  expect(await names(blockedCol.locator(".tile"))).toEqual(BLOCKED_ORDER);
  await expect(idle.locator(".tile.is-blocked")).toHaveCount(0);
  await expect(needsYou.locator(".tile.is-blocked")).toHaveCount(0);
  const columnOrder = await board.locator("section.board-col").evaluateAll((cols) =>
    cols.map((c) => [...c.classList].find((name) => name.startsWith("tone-")) ?? "backlog"));
  expect(columnOrder.indexOf("tone-blocked")).toBe(columnOrder.indexOf("tone-attention") + 1);
  await shoot(dashboard, "04-own-column");

  // --- Console rail --------------------------------------------------------------------------
  await setUi(dashboard, daemon, { layout: "console", blockedPlacement: "needs-you" });
  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  const headings = async () =>
    (await rail.locator(".rail-group").allInnerTexts()).map((t) => t.split(/\s/)[0]!.toLowerCase());
  await expect(rail.locator(".rail-group.tone-blocked")).toBeVisible();
  await expect.poll(headings).toEqual(["needs", "blocked", "working", "idle"]);
  const blockedRows = rail.locator(".rail-group.tone-blocked ~ .rail-row");
  await expect(blockedRows).toHaveCount(BLOCKED.length);
  await expect(blockedRows.first()).toContainText(BLOCKED_ORDER[0]!);
  await shoot(dashboard, "05-console-rail-needs-you");
  await setUi(dashboard, daemon, { blockedPlacement: "column" });
  await expect.poll(headings).toEqual(["needs", "blocked", "working", "idle"]);
  await setUi(dashboard, daemon, { blockedPlacement: "idle" });
  await expect.poll(headings).toEqual(["needs", "working", "blocked", "idle"]);
  const groups = rail.locator(".rail-group");
  await expect(groups.nth(2)).toHaveClass(/tone-blocked/);
  await expect(groups.nth(3)).toHaveClass(/tone-idle/);
  await expect(rail.locator(".rail-group.tone-blocked ~ .rail-row").first()).toContainText(BLOCKED_ORDER[0]!);
  await shoot(dashboard, "06-console-rail-top-of-idle");
});
