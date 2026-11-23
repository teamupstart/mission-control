import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

const TASK = "tune the transcript cache";
/** A second, differently-named agent, so the travel test can name the queue that opened. */
const OTHER_TASK = "rebuild the pane capture index";

const QUESTION = {
  kind: "input",
  title: "Which caching strategy should the transcript reader use?",
  body: "Which caching strategy should the transcript reader use?",
  decisions: [
    {
      id: "q",
      question: "Which caching strategy should the transcript reader use?",
      options: [
        { id: "o0", label: "Bounded LRU per session", recommended: true },
        { id: "o1", label: "Single shared ring buffer" },
      ],
      allowOther: false,
    },
  ],
};

/** Launch one agent and wait for the fleet to have adopted `expected` cards. */
async function dispatch(
  page: Page,
  daemon: DaemonHandle,
  expected: number,
  task = TASK,
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control. Its own handler stops
  // propagation, so this closes the list rather than the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(expected);
}

/**
 * Ask a question the way the agent's MCP child does, bound to the session in `cwd`.
 *
 * Posted over HTTP rather than scripted into the fake agent, because the review channel IS
 * an HTTP route (`src/mcp/server.ts` performs exactly this POST), and going through it keeps
 * the spec honest about the contract while every agent binary stays a cost-free fake.
 */
async function ask(
  daemon: DaemonHandle,
  cwd: string,
  question = QUESTION.title,
  body = question,
): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {}, cwd, ...QUESTION, title: question, body,
      decisions: QUESTION.decisions.map((decision) => ({ ...decision, question })),
    }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`).toBe(
    200,
  );
}

/**
 * The checkouts the daemon actually cut, in the order it reports them, once every dispatched
 * session has one.
 *
 * Polled rather than read once: a card is on screen before the registry has necessarily
 * finished adopting the worktree it was cut into, so a single read is intermittently empty.
 */
async function checkouts(
  daemon: DaemonHandle,
  count: number,
): Promise<{ cwd: string; name: string }[]> {
  let found: { cwd: string; name: string }[] = [];
  await expect
    .poll(
      async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          cwd: string | null;
          name: string;
        }>;
        found = sessions
          .filter((s): s is { cwd: string; name: string } => Boolean(s.cwd))
          .map((s) => ({ cwd: s.cwd, name: s.name }));
        return found.length;
      },
      { message: `${count} dispatched sessions have checkouts to bind a review to` },
    )
    .toBe(count);
  return found;
}

test("clicking the review badge opens the session review queue", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, 1);
  const [session] = await checkouts(daemon, 1);
  await ask(daemon, session.cwd);

  // The badge is the thing the chord stands in for, so wait for it rather than for a count:
  // it appearing is the fleet having heard about the review.
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card.getByRole("button", { name: "to review" })).toBeVisible();

  await card.getByRole("button", { name: "to review" }).click();

  const modal = dashboard.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("1 pending");
  await expect(modal).toContainText("Which caching strategy should the transcript reader use?");
});

test("the review badge prints the attention shortcut", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, 1);
  const [session] = await checkouts(daemon, 1);
  await ask(daemon, session.cwd);

  // A bare letter keycap stays lowercase (`formatChord` only uppercases a MODIFIED letter),
  // so this asserts the exact glyph a person reads on the badge.
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const badge = dashboard.locator(".console-detail").getByRole("button", { name: "to review" });
  await expect(badge.locator("kbd.kb-hint")).toHaveText("e");
});

test("e opens the standard inbox when the current conversation has no inbox question", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, 1);
  // Give the conversations distinct names so we can detect an unwanted selection change.
  await dispatch(dashboard, daemon, 2, OTHER_TASK);
  const sessions = await checkouts(daemon, 2);

  // Bound by NAME, not by index: `/api/sessions` promises no particular order, so picking
  // `[1]` would silently ask the wrong agent on any run that returned them the other way
  // round - and the test would still pass, because a modal would still open.
  const askTarget = sessions.find((s) => s.name.toLowerCase().includes("pane capture"));
  expect(askTarget, `the ${OTHER_TASK} session is on the fleet`).toBeTruthy();
  await ask(daemon, askTarget!.cwd);

  // Exactly one of the two is asking. Which row that is gets read off the DOM rather than
  // assumed: a pending review tones a session `attention`, which re-sorts it to the front.
  const rows = dashboard.getByRole("navigation", { name: "Sessions" });
  const asking = rows.locator("button.rail-row.tone-attention");
  await expect(asking).toHaveCount(1);

  // Open the conversation without a question and move focus into it.
  const quiet = rows.locator("button.rail-row:not(.tone-attention)");
  await expect(quiet).toHaveCount(1);
  await quiet.click();
  await expect(quiet).toHaveClass(/selected/);
  const opener = dashboard.locator(".cdetail").getByRole("tab", { name: "Conversation" });
  await opener.focus();

  await dashboard.keyboard.press("e");

  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox).toBeVisible();
  await expect(inbox).toContainText(askTarget!.name);
  await expect(inbox.getByRole("button", { name: "Close (esc)" })).toBeFocused();
  await capture(inbox, "standard-inbox-from-conversation");
  await dashboard.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
  await expect(quiet).toHaveClass(/selected/);
  await expect(opener).toBeFocused();
});

test("e is left to the browser on a fleet with nothing waiting", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, 1);
  await checkouts(daemon, 1);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await card.click();
  await expect(card.getByRole("button", { name: "to review" })).toHaveCount(0);

  await dashboard.keyboard.press("e");

  // No queue exists, so no queue opens - and the chord is left unclaimed rather than
  // swallowed, which is what keeps a bare letter usable by the page underneath it.
  await expect(dashboard.getByRole("dialog")).toHaveCount(0);
});

test("e from a conversation opens the standard inbox with only an unread report", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, 1);
  const [session] = await checkouts(daemon, 1);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").click();
  const conversation = dashboard.locator(".cdetail");
  await expect(conversation).toContainText(session.name);

  const enabled = await fetch(`${daemon.baseURL}/api/feature-flags`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "flag", id: "inbox", enabled: true }),
  });
  expect(enabled.ok).toBe(true);
  const title = "Transcript cache benchmark results";
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const posted = await fetch(`${daemon.baseURL}/mcp/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd: session.cwd, title, body: "The bounded cache passed the benchmark." }),
  });
  expect(posted.status, await posted.text()).toBe(200);
  await expect(dashboard.getByRole("button", { name: /1 to read/ })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: /to answer/ })).toHaveCount(0);

  const opener = conversation.getByRole("tab", { name: "Conversation" });
  await opener.focus();
  await dashboard.keyboard.press("e");
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox.getByText("Nothing to answer")).toBeVisible();
  await expect(inbox.getByRole("button", { name: title })).toHaveAttribute("aria-expanded", "false");
  await expect(inbox.getByRole("button", { name: "Close (esc)" })).toBeFocused();
  await expectContentClearsBorder(inbox);
  await capture(inbox, "report-only-inbox");
  await dashboard.keyboard.press("Escape");
  await expect(inbox).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(conversation).toContainText(session.name);
});

/** Store UI preferences the way the dashboard does, daemon and local mirror, then reload. */
async function setUi(page: Page, daemon: DaemonHandle, next: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next),
  });
  expect(res.ok).toBe(true);
  await page.evaluate((patch) => {
    const raw = JSON.parse(window.localStorage.getItem("mission-control.ui") ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem("mission-control.ui", JSON.stringify({ ...raw, ...patch }));
  }, next);
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
}

test("the Board's Needs you column prints e while a review waits, and e opens it with no card picked", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon, 1);
  const [session] = await checkouts(daemon, 1);
  await setUi(dashboard, daemon, { layout: "board", keybindingHints: true });

  const needsYou = dashboard.locator(".board-col.tone-attention");
  const heading = needsYou.locator(".board-col-head");
  // Nothing waiting: the column is not drawn, so no key is offered.
  await expect(heading.locator("kbd.kb-hint")).toHaveCount(0);

  await ask(daemon, session.cwd);
  await expect(heading.getByRole("heading", { name: "needs you" })).toBeVisible();
  // Beside the column's name, the same lowercase glyph the badge prints.
  const keycap = heading.locator("kbd.kb-hint");
  await expect(keycap).toHaveText("e");
  const name = await heading.getByRole("heading", { name: "needs you" }).boundingBox();
  const key = await keycap.boundingBox();
  expect(name && key).toBeTruthy();
  expect(key!.x).toBeGreaterThan(name!.x + name!.width - 1);
  expect(Math.abs((key!.y + key!.height / 2) - (name!.y + name!.height / 2))).toBeLessThan(6);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = artifactsDir("review-shortcut");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await needsYou.screenshot({ path: `${dir}needs-you-keycap.png` });
  }

  await expect(dashboard.getByRole("button", { name: /1 to answer/ })).toBeVisible();
  await dashboard.keyboard.press("e");
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox).toBeVisible();
  await expectContentClearsBorder(inbox);
  await expect(inbox).toContainText(QUESTION.title);
  await expect(inbox.getByRole("button", { name: "Close (esc)" })).toBeFocused();
  await capture(inbox, "board-inbox");
  await dashboard.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // With keycaps turned off, the column prints none.
  await setUi(dashboard, daemon, { keybindingHints: false });
  await expect(heading.getByRole("heading", { name: "needs you" })).toBeVisible();
  await expect(heading.locator("kbd.kb-hint")).toHaveCount(0);
});

async function capture(target: Locator, filename: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = artifactsDir("review-shortcut");
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: join(dir, `${filename}.png`) });
}

for (const layout of ["board", "console"] as const) {
  test(`e focuses the first of two questions from the active ${layout} conversation`, async ({
    dashboard, daemon,
  }) => {
    await dispatch(dashboard, daemon, 1);
    await dispatch(dashboard, daemon, 2, OTHER_TASK);
    const sessions = await checkouts(daemon, 2);
    const earlier = sessions.find((session) => session.name.toLowerCase().includes("transcript cache"))!;
    const current = sessions.find((session) => session.name.toLowerCase().includes("pane capture"))!;
    const context = Array.from({ length: 30 }, (_, index) => `Cache benchmark ${index + 1} recorded.`).join("\n");
    await ask(daemon, earlier.cwd, QUESTION.title, `${QUESTION.title}\n\n${context}`);
    const currentQuestion = "How should the pane capture index be rebuilt?";
    await ask(daemon, current.cwd, currentQuestion);
    const laterQuestion = "When should the pane capture index refresh?";
    await ask(daemon, current.cwd, laterQuestion);
    const questionOrder = [QUESTION.title, currentQuestion, laterQuestion];
    await setUi(dashboard, daemon, { layout });

    const session = layout === "board"
      ? dashboard.locator(".board-col .tile:not(.pend-tile)").filter({ hasText: current.name })
      : dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: current.name });
    await session.click();
    const conversation = dashboard.locator(".cdetail");
    await expect(conversation).toContainText(current.name);
    const toAnswer = dashboard.getByRole("button", { name: /3 to answer/ });
    await expect(toAnswer).toBeVisible();

    // Keep the fixture's original ordering so the shortcut has to reach past a different question.
    const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
    const headings = inbox.locator(".inbox-entry").getByRole("heading", { level: 3 });
    const question = inbox.getByRole("heading", { name: currentQuestion });
    await toAnswer.click();
    await expect(headings).toHaveText(questionOrder);
    await expect(question).not.toBeInViewport();
    await dashboard.keyboard.press("Escape");
    await expect(inbox).toBeHidden();

    const reply = conversation.getByRole("textbox").filter({ visible: true });
    await reply.focus();
    await dashboard.keyboard.press("e");
    await expect(reply).toHaveValue("e");
    await expect(inbox).toBeHidden();
    await reply.clear();
    const opener = conversation.getByRole("tab", { name: "Conversation" });
    await opener.focus();
    await dashboard.keyboard.press("e");
    await expect(inbox).toBeVisible();
    await expectContentClearsBorder(inbox);
    await expect(question).toBeFocused();
    await expect(inbox.getByRole("heading", { name: laterQuestion })).not.toBeFocused();
    await expect(question).toBeInViewport();
    await expect(headings).toHaveText(questionOrder);
    await capture(inbox, `${layout}-conversation-first-question`);
    await dashboard.keyboard.press("Escape");
    await expect(inbox).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(conversation).toContainText(current.name);

    // Opening from the count again uses the standard entry point even in this conversation.
    await toAnswer.click();
    await expect(inbox.getByRole("button", { name: "Close (esc)" })).toBeFocused();
  });
}
