import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { ReviewItem } from "../../src/shared/types.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";

/**
 * Answering a resident from the Residents drawer: an open card shows the open question with its
 * options and answers it through the same `ReviewCard` the attention inbox draws. The card has no
 * reply box of its own; a free-form reply is written in the resident's Conversation.
 *
 * Same setup as `residents-drawer.spec.ts`. No model tokens are spent: every agent binary is
 * redirected by `e2e/fixtures/fake-agents.ts`, and the resident's question is posted on
 * `POST /mcp/reviews`, the channel its own `request_input` tool uses.
 */

const EVIDENCE = artifactsDir("residents-drawer-answer");
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

/** How many launched residents are waiting between iterations. */
function waitingResidents(daemon: DaemonHandle): number {
  return withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT COUNT(*) AS n FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched' AND loop_state = 'waiting'",
  ).get() as { n: number }).n);
}

/** Launch one resident through the real routes and wait until its loop is waiting. */
async function launch(daemon: DaemonHandle, name = NAME): Promise<void> {
  const before = waitingResidents(daemon);
  const profile = await createProfile(daemon, name);
  await request(daemon, `/api/residents/profiles/${profile.id}/launch`, {
    repoRoot: daemon.repo, requestId: `launch-${name.toLowerCase().replace(/\W+/g, "-")}`,
  });
  await expect.poll(() => waitingResidents(daemon), { timeout: 60_000 }).toBe(before + 1);
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
const cardOf = (scope: Locator, name = NAME): Locator =>
  scope.getByRole("listitem").filter({ has: scope.page().getByRole("button", { name: new RegExp(`^${name}, `) }) });
const headOf = (scope: Locator, name = NAME): Locator => scope.getByRole("button", { name: new RegExp(`^${name}, `) });
const edgeTab = (page: Page): Locator => page.getByRole("button", { name: /^Open the Residents drawer - / });
const visitorOf = (page: Page): Locator =>
  page.getByRole("button", { name: `${NAME} needs you - resident, opens its conversation` });
/** Open the drawer from the top bar; it lands on the resident that needs you. */
const openDrawer = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Residents - 1 live", exact: true }).click();
  await expect(drawerOf(page)).toBeVisible();
};

test("the selected card shows a resident's question with its options, and answering it clears the visitor card", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon);
  const reviewId = await askResident(daemon);
  await expect(visitorOf(page)).toBeVisible();
  await expect(edgeTab(page)).toHaveClass(/needs-you/);

  await openDrawer(page);
  const drawer = drawerOf(page);
  await expect(drawer).toBeVisible();
  const card = cardOf(drawer);
  await expect(headOf(drawer)).toHaveAttribute("aria-expanded", "true");
  const ask = card.getByLabel(`${NAME} is asking`);
  await expect(ask.getByRole("heading", { name: "Ship the nightly migration?" })).toBeVisible();
  const options = ask.getByRole("group", { name: "Answer: Ship the nightly migration?" });
  await expect(options.getByRole("button", { name: "Ship it", exact: true })).toBeVisible();
  await expect(options.getByRole("button", { name: "Hold it", exact: true })).toBeVisible();
  await expect(options.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(options.getByRole("button", { name: "Chat about it" })).toBeVisible();
  await expect(ask.getByRole("radio")).toHaveCount(0);
  await expect(ask.getByRole("button", { name: "Submit" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: `Open ${NAME}` })).toBeVisible();
  // No reply box: the drawer answers questions, and the Conversation takes replies.
  await expect(drawer.getByRole("textbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /^Send/ })).toHaveCount(0);
  await expectContentClearsBorder(drawer);
  await capture(page, "01-question-in-drawer");

  await options.getByRole("button", { name: "Ship it", exact: true }).click();
  await expect(ask).toHaveCount(0);
  const answered = async (): Promise<ReviewItem | undefined> =>
    (await request<ReviewItem[]>(daemon, "/api/reviews", undefined, "GET")).find((review) => review.id === reviewId);
  await expect.poll(async () => (await answered())?.status).toBe("answered");
  const resolved = await answered();
  expect(resolved?.selections).toEqual([{ decisionId: "q", selected: ["yes"], other: null }]);
  expect(resolved?.response).toContain("Ship it");
  await expect(drawer).toBeVisible();
  await expect(headOf(drawer)).toHaveAttribute("aria-expanded", "true");
  await expect(card).not.toHaveClass(/needs-you/);
  await capture(page, "02-answered-in-drawer");

  await closeDrawer(page);
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await expect(edgeTab(page)).not.toHaveClass(/needs-you/);
});

test("Dismiss on a drawer question drops it unanswered, and Chat about it moves it to the conversation", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon);
  const review = async (id: string): Promise<ReviewItem | undefined> =>
    (await request<ReviewItem[]>(daemon, "/api/reviews", undefined, "GET")).find((item) => item.id === id);
  const drawer = drawerOf(page);
  const options = drawer.getByRole("group", { name: "Answer: Ship the nightly migration?" });

  const dismissed = await askResident(daemon);
  await expect(visitorOf(page)).toBeVisible();
  await openDrawer(page);
  await options.getByRole("button", { name: "Dismiss" }).click();
  await expect(options).toHaveCount(0);
  await expect.poll(async () => (await review(dismissed))?.status).toBe("dismissed");
  const afterDismiss = await review(dismissed);
  expect(afterDismiss?.response ?? null).toBeNull();
  expect(afterDismiss?.selections ?? null).toBeNull();
  await expect(drawer).toBeVisible();
  await expect(headOf(drawer)).toHaveAttribute("aria-expanded", "true");
  await closeDrawer(page);
  await expect(page.locator(".resident-visitor")).toHaveCount(0);

  const chatted = await askResident(daemon);
  await expect(visitorOf(page)).toBeVisible();
  await openDrawer(page);
  await options.getByRole("button", { name: "Chat about it" }).click();
  await expect.poll(async () => (await review(chatted))?.status).toBe("answered");
  const afterChat = await review(chatted);
  expect(afterChat?.selections).toEqual([{ decisionId: "q", selected: [], other: null, chat: true }]);
  expect(afterChat?.response).toContain("Chat about it");
  // The conversation opens beside the drawer, which stays.
  await expect(drawer).toBeVisible();
  const detail = page.locator(".board-detail");
  await expect(detail.getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expect(detail.locator("textarea.transcript-input")).toBeFocused();
  const answer = detail.locator(".transcript-log .review-answer");
  await expect(answer.getByText("Moved to chat")).toBeVisible();
  await capture(page, "07-chat-about-it-conversation");
  await expect(page.locator(".resident-visitor")).toHaveCount(0);

  // The first Escape leaves the Conversation's reply box, as it always does, and the next leaves
  // the detail, putting the keyboard back on the resident's card.
  await page.keyboard.press("Escape");
  await expect(detail.locator("textarea.transcript-input")).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(detail.getByRole("group", { name: `Resident ${NAME}` })).toHaveCount(0);
  await expect(headOf(drawer)).toBeFocused();
  await expect(options).toHaveCount(0);
});
