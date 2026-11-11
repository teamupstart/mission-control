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
 * Answering a resident from the Residents drawer: an open card names the open question as one row
 * in the Needs you color, and a click on it opens the review modal, which answers it. The card
 * never draws the form itself, and has no reply box; a free-form reply is written in the
 * resident's Conversation.
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

/** The row a card draws for `askResident`'s question: its kind, its title and its options. */
const ROW_NAME = "input: Ship the nightly migration? - Ship it · Hold it";
const reviewModal = (page: Page): Locator => page.getByRole("dialog", { name: "Review request" });

test("a resident's question is a Needs you row on its card, and a click on it opens the review modal that answers it", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon);
  const reviewId = await askResident(daemon);
  await expect(visitorOf(page)).toBeVisible();
  await expect(edgeTab(page)).toHaveClass(/needs-you/);

  await openDrawer(page);
  const drawer = drawerOf(page);
  const card = cardOf(drawer);
  await expect(headOf(drawer)).toHaveAttribute("aria-expanded", "true");
  const ask = card.getByLabel(`${NAME} is asking`);
  const row = ask.getByRole("button", { name: ROW_NAME, exact: true });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Ship the nightly migration?");
  await expect(row).toContainText("Ship it · Hold it");

  // The row names the question; it is not the form. No option, Dismiss, Chat about it or
  // Submit is on the card, and no reply box.
  await expect(drawer.getByRole("button", { name: "Ship it", exact: true })).toHaveCount(0);
  await expect(drawer.getByRole("group", { name: /^Answer: / })).toHaveCount(0);
  await expect(drawer.getByRole("radio")).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: /^(Dismiss|Chat about it|Submit)/ })).toHaveCount(0);
  await expect(drawer.getByRole("textbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: `Open ${NAME}` })).toBeVisible();

  // Drawn in the Needs you color, the one every skin sets as `--attention`.
  const colors = await row.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--attention)";
    el.appendChild(probe);
    const attention = getComputedStyle(probe).color;
    probe.remove();
    return { attention, kind: getComputedStyle(el.querySelector(".residents-drawer-ask-kind")!).color };
  });
  expect(colors.kind).toBe(colors.attention);
  await expectContentClearsBorder(drawer);
  await capture(page, "01-question-row-in-drawer");

  // A click opens the review modal on this resident's queue, with its card selected, and the
  // conversation stays shut: the row is not a way into the conversation.
  await row.click();
  const modal = reviewModal(page);
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Ship the nightly migration?");
  await expect(headOf(drawer)).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toHaveCount(0);
  await capture(page, "02-review-modal-from-drawer");

  await modal.getByRole("radio", { name: "Ship it" }).check();
  await modal.getByRole("button", { name: /^Submit/ }).click();
  await expect(modal).toBeHidden();
  const answered = async (): Promise<ReviewItem | undefined> =>
    (await request<ReviewItem[]>(daemon, "/api/reviews", undefined, "GET")).find((review) => review.id === reviewId);
  await expect.poll(async () => (await answered())?.status).toBe("answered");
  const resolved = await answered();
  expect(resolved?.selections?.[0]).toMatchObject({ decisionId: "q", selected: ["yes"] });
  expect(resolved?.response).toContain("Ship it");

  // Answered, the row is gone and the card is no longer amber.
  await expect(ask).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(card).not.toHaveClass(/needs-you/);
  await capture(page, "03-answered-from-modal");

  await closeDrawer(page);
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await expect(edgeTab(page)).not.toHaveClass(/needs-you/);
});

test("Chat about it in the modal a drawer row opened moves the question to the resident's conversation", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon);
  const chatted = await askResident(daemon);
  await expect(visitorOf(page)).toBeVisible();
  await openDrawer(page);
  const drawer = drawerOf(page);

  await cardOf(drawer).getByRole("button", { name: ROW_NAME, exact: true }).click();
  const modal = reviewModal(page);
  await expect(modal).toBeVisible();
  await modal.getByRole("radio", { name: "Chat about it" }).check();
  await modal.getByRole("button", { name: /^Submit/ }).click();
  await expect(modal).toBeHidden();

  const review = async (): Promise<ReviewItem | undefined> =>
    (await request<ReviewItem[]>(daemon, "/api/reviews", undefined, "GET")).find((item) => item.id === chatted);
  await expect.poll(async () => (await review())?.status).toBe("answered");
  expect((await review())?.selections?.[0]).toMatchObject({ decisionId: "q", selected: [], chat: true });

  // The conversation opens beside the drawer, which stays, with the cursor in its reply box.
  await expect(drawer).toBeVisible();
  const detail = page.locator(".board-detail");
  await expect(detail.getByRole("group", { name: `Resident ${NAME}` })).toBeVisible();
  await expect(detail.locator("textarea.transcript-input")).toBeFocused();
  await expect(detail.locator(".transcript-log .review-answer").getByText("Moved to chat")).toBeVisible();
  await capture(page, "04-chat-about-it-conversation");
  await expect(page.locator(".resident-visitor")).toHaveCount(0);
  await expect(cardOf(drawer).getByLabel(`${NAME} is asking`)).toHaveCount(0);
});

/** The turn `fake-claude.mjs` answers by raising its own `AskUserQuestion` menu and blocking. */
const ASK_TURN = "ask me which linter to use";

test("a menu the resident is parked on is a Needs you row too, and a click opens the review modal that answers it", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon);
  const sessions = await request<Array<{ id: string; task?: { kind?: string } }>>(daemon, "/api/sessions", undefined, "GET");
  const sessionId = sessions.find((s) => s.task?.kind === "resident")?.id;
  expect(sessionId, "the resident has a session to send the turn to").toBeTruthy();
  // Stand in for the operator's turn that makes the resident ask through the agent's own menu,
  // not through `request_input`: no review is created, only the menu it is parked on.
  await request(daemon, `/api/sessions/${encodeURIComponent(sessionId!)}/send`, { text: ASK_TURN, submit: true, origin: "human" });

  await openDrawer(page);
  const drawer = drawerOf(page);
  const card = cardOf(drawer);
  const ask = card.getByLabel(`${NAME} is asking`);
  const row = ask.getByRole("button", { name: "menu: Claude has some questions. - 2 questions", exact: true });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The row names the menu; its rows are not on the card.
  await expect(card.locator(".pane-dialog")).toHaveCount(0);
  await expect(drawer.getByRole("radio")).toHaveCount(0);
  await expect(drawer.getByRole("checkbox")).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Submit answers" })).toHaveCount(0);
  expect((await request<ReviewItem[]>(daemon, "/api/reviews", undefined, "GET"))
    .filter((review) => review.status === "pending")).toHaveLength(0);
  await capture(page, "05-menu-row-in-drawer");

  // A click opens the review modal, which draws the menu the way the Conversation does; the
  // conversation itself stays shut.
  await row.click();
  const modal = reviewModal(page);
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("1 pending");
  const form = modal.locator(".pane-dialog");
  await expect(form).toContainText("Which linter?");
  await expect(page.locator(".board-detail").getByRole("group", { name: `Resident ${NAME}` })).toHaveCount(0);
  await expect(headOf(drawer)).toHaveAttribute("aria-current", "true");
  await expectContentClearsBorder(modal);
  await capture(page, "06-menu-in-review-modal");

  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("checkbox", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();

  // Answered, the menu is gone: the modal closes on its own and the card's row clears.
  await expect(modal).toBeHidden({ timeout: 15_000 });
  await expect(ask).toHaveCount(0);
  await expect(drawer).toBeVisible();
});

test("a menu and a pending review are both rows on the card, and the review modal answers each in turn", async ({ dashboard: page, daemon }) => {
  await launch(daemon);
  await useDrawer(page, daemon);
  const sessions = await request<Array<{ id: string; task?: { kind?: string } }>>(daemon, "/api/sessions", undefined, "GET");
  const sessionId = sessions.find((s) => s.task?.kind === "resident")?.id;
  expect(sessionId, "the resident has a session to send the turn to").toBeTruthy();
  await request(daemon, `/api/sessions/${encodeURIComponent(sessionId!)}/send`, { text: ASK_TURN, submit: true, origin: "human" });

  await openDrawer(page);
  const drawer = drawerOf(page);
  const ask = cardOf(drawer).getByLabel(`${NAME} is asking`);
  const menuRow = ask.getByRole("button", { name: "menu: Claude has some questions. - 2 questions", exact: true });
  await expect(menuRow).toBeVisible({ timeout: 30_000 });
  // With the menu still open, the resident also asks through `request_input`.
  const reviewId = await askResident(daemon);
  const reviewRow = ask.getByRole("button", { name: ROW_NAME, exact: true });
  await expect(reviewRow).toBeVisible();
  // Both are on the card, one row each, menu first - never one hiding the other.
  await expect(ask.getByRole("button")).toHaveCount(2);
  const [menuBox, reviewBox] = [await menuRow.boundingBox(), await reviewRow.boundingBox()];
  expect(menuBox!.y, "the menu leads, as it does in the review modal").toBeLessThan(reviewBox!.y);
  await capture(page, "07-menu-and-review-rows");

  // Either row opens the one modal, holding both.
  await reviewRow.click();
  const modal = reviewModal(page);
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("2 pending");
  const form = modal.locator(".pane-dialog");
  await expect(form).toContainText("Which linter?");
  await expect(modal).toContainText("Ship the nightly migration?");
  await capture(page, "08-menu-and-review-in-modal");

  // Answering the menu leaves the review: the modal stays open on it, and the card drops the
  // menu's row but keeps the review's.
  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("checkbox", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toHaveCount(0, { timeout: 15_000 });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("1 pending");
  await expect(menuRow).toHaveCount(0);
  await expect(reviewRow).toBeVisible();

  await modal.getByRole("radio", { name: "Ship it" }).check();
  await modal.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect.poll(async () =>
    (await request<ReviewItem[]>(daemon, "/api/reviews", undefined, "GET")).find((review) => review.id === reviewId)?.status,
  ).toBe("answered");
  await expect(ask).toHaveCount(0);
});
