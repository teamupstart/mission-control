import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: with the `async-input` preview flag on, every answer the operator gives
 * reaches its agent as a message the daemon writes. Drawn literally, that message is a block of
 * daemon text that looks typed - bylined "mission control", and "you" once the daemon restarts -
 * beside the gold answer card. It must instead be the same gold card, once, at the turn the
 * agent received it, in both renderings and across a restart. A Remind me later instruction is
 * the snoozed line. An operator who pastes the marker line keeps their own visible message.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. Questions are posted on the
 * exact channel the MCP `request_input` tool uses, and the agents are the suite's fakes, so no
 * model tokens are spent. The fake writes each delivered message into its transcript verbatim
 * and replies "Mock reply to: <message>", so the reply - an assistant turn - is the one place
 * the raw text may still appear, and the assertions below are scoped to user turns.
 */

const EVIDENCE = artifactsDir("async-input-answer-cards");
const HELD_TURN = "E2E_HOLD_TURN_UNTIL_RELEASED";
const RAW = "Mission Control answer to question";

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/async-input-answer-cards/${name}.png`);
}

const token = (daemon: DaemonHandle) => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function enableAsyncInput(daemon: DaemonHandle): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id: "async-input", enabled: true }, "PUT");
  expect(config.overrides["async-input"]).toBe(true);
}

async function setConversationView(daemon: DaemonHandle, view: "chat" | "terminal"): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationView: view }),
  });
  expect(res.ok, `the daemon should accept the ${view} rendering`).toBe(true);
}

function question(title: string): Record<string, unknown> {
  return {
    kind: "input", title, body: `${title}\n\nThe repo has no linter. CI runs Prettier only.`, snoozable: true,
    decisions: [{
      id: "q", question: title, allowOther: true,
      options: [
        { id: "o0", label: "biome", detail: "lint + format in one fast binary" },
        { id: "o1", label: "eslint", detail: "type-aware rules", recommended: true },
      ],
    }],
  };
}

type Filed = { id: string; wait: "call" | "message" };

/** Ask the way the MCP `request_input` tool does, as a child that can take a receipt. */
async function ask(daemon: DaemonHandle, cwd: string, title: string): Promise<Filed> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, asyncCapable: true, ...question(title) }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const filed = await res.json() as Filed;
  expect(filed.wait).toBe("message");
  return filed;
}

async function sessionFor(daemon: DaemonHandle, taskId: string): Promise<Session | undefined> {
  return (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === taskId);
}

async function dispatch(daemon: DaemonHandle, title: string, intent: string, state: "working" | "idle"): Promise<Session> {
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title, intent, kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await sessionFor(daemon, task.id))!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe(state);
  return session;
}

async function openSession(page: Page, session: Session): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: session.name }).first().click();
  const detail = page.locator(".console-detail");
  await expect(detail).toContainText(session.name);
  return detail;
}

/** Every user turn, in either rendering, that shows the delivered message as raw text. */
const rawUserTurns = (detail: Locator, text: string) =>
  detail.locator(".turn-user, .turn-harness, .pty-user", { hasText: text });

const answerCard = (detail: Locator, title: string) => detail.locator(".review-answer", { hasText: title });

/** The agent's reply to the delivered message: proof the turn is in the transcript. */
const replyTo = (detail: Locator, reviewId: string) =>
  detail.locator(".turn-assistant, .pty-entry", { hasText: `Mock reply to: [mission-control:answer review=${reviewId}]` });

const LINTER = "Which linter should this repo use?";
const FORMATTER = "Which formatter should this repo use?";

test("an inbox answer is one gold card at the turn the agent received it, in chat and terminal renderings, across a restart", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  await enableAsyncInput(daemon);
  const session = await dispatch(daemon, "Add a linter to CI", "add a linter to CI", "idle");
  const filed = await ask(daemon, session.cwd!, LINTER);

  // Answered from the inbox.
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await page.locator("button.pulse-seg", { hasText: "to answer" }).click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  await inbox.getByRole("radio", { name: /eslint/ }).check();
  await inbox.getByRole("button", { name: /^Submit/ }).click();
  await expect(inbox.getByText("Nothing to answer")).toBeVisible();
  await page.keyboard.press("Escape");

  const detail = await openSession(page, session);
  await expect(replyTo(detail, filed.id).first()).toBeVisible({ timeout: 30_000 });

  // One gold card, at the delivery turn, and the raw message nowhere as a turn of its own.
  const card = answerCard(detail, LINTER);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("you answered");
  await expect(card).toContainText("Delivered to the agent");
  await expect(card).not.toContainText("On its way");
  await expect(card.getByRole("listitem", { name: "Chosen: eslint" })).toBeVisible();
  await expect(rawUserTurns(detail, RAW)).toHaveCount(0);
  await expect(detail.locator('.turn[aria-label="you"]', { hasText: RAW })).toHaveCount(0);
  // Placed where the agent received it: the card comes straight before the reply it caused.
  const order = await detail.locator(".transcript-log").evaluate((log, id) => {
    const children = [...log.children];
    const cardAt = children.findIndex((el) => el.classList.contains("review-answer"));
    const replyAt = children.findIndex((el) => el.textContent?.includes(`Mock reply to: [mission-control:answer review=${id}]`));
    return { cardAt, replyAt };
  }, filed.id);
  expect(order.cardAt).toBeGreaterThanOrEqual(0);
  expect(order.replyAt).toBe(order.cardAt + 1);

  // Nothing is hidden for good: the disclosure shows exactly what the agent read.
  const received = card.getByRole("group", { name: "What the agent received" });
  await expect(received.locator(".review-received-text")).toBeHidden();
  await received.getByText("What the agent received").click();
  await expect(received.locator(".review-received-text")).toContainText(`[mission-control:answer review=${filed.id}]`);
  await expect(received.locator(".review-received-text")).toContainText(RAW);
  await capture(card, "01-chat-answer-card", page);

  // An operator who pastes the marker line keeps their own visible message.
  const composer = detail.getByPlaceholder(/^Reply to this session/);
  const pasted = `[mission-control:answer review=${filed.id}]\n\nI pasted this marker myself.`;
  await composer.fill(pasted);
  await composer.press("Enter");
  const operatorTurn = detail.locator('.turn-user[aria-label="you"]', { hasText: "I pasted this marker myself." });
  await expect(operatorTurn).toBeVisible({ timeout: 30_000 });
  await expect(operatorTurn).toContainText(`[mission-control:answer review=${filed.id}]`);
  await expect(card).toHaveCount(1);
  await capture(operatorTurn, "02-pasted-marker-stays-operator", page);

  // The terminal rendering draws the same card, and no `mission-control@mission ❯` line for it.
  await setConversationView(daemon, "terminal");
  await page.reload();
  const terminal = await openSession(page, session);
  await expect(terminal.locator(".pty-entry").first()).toBeVisible({ timeout: 30_000 });
  await expect(answerCard(terminal, LINTER)).toHaveCount(1);
  await expect(answerCard(terminal, LINTER)).toContainText("Delivered to the agent");
  await expect(rawUserTurns(terminal, RAW)).toHaveCount(0);
  await expect(terminal.locator(".pty-user", { hasText: "I pasted this marker myself." })).toHaveCount(1);
  await capture(answerCard(terminal, LINTER), "03-terminal-answer-card", page);
  await capture(terminal.locator(".pty-user", { hasText: "I pasted this marker myself." }), "03b-terminal-pasted-marker", page);

  // After a daemon restart, which forgets every in-memory label, it is still a card, and still
  // not a "you" turn.
  await setConversationView(daemon, "chat");
  await page.goto("about:blank");
  await daemon.shutdown();
  await daemon.restart();
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.state,
    { timeout: 60_000 }).toBe("idle");
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const after = await openSession(page, session);
  await expect(replyTo(after, filed.id).first()).toBeVisible({ timeout: 30_000 });
  await expect(answerCard(after, LINTER)).toHaveCount(1);
  await expect(answerCard(after, LINTER)).toContainText("Delivered to the agent");
  await expect(rawUserTurns(after, RAW)).toHaveCount(0);
  await expect(after.locator('.turn-user[aria-label="you"]', { hasText: "I pasted this marker myself." })).toBeVisible();
  await capture(answerCard(after, LINTER), "04-after-restart", page);
});

test("two answers delivered together draw two cards on the one turn, each on its way until then", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await enableAsyncInput(daemon);
  // The fake holds its first turn open, so both answers wait in the outbox and fold into one.
  const session = await dispatch(daemon, "Add lint and format", `${HELD_TURN} add lint and format to CI`, "working");
  const linter = await ask(daemon, session.cwd!, LINTER);
  const formatter = await ask(daemon, session.cwd!, FORMATTER);
  const answer = { action: "answer", response: "eslint", selections: [{ decisionId: "q", selected: ["o1"] }] };
  await api(daemon, `/api/reviews/${linter.id}/resolve`, answer);
  await api(daemon, `/api/reviews/${formatter.id}/resolve`, answer);

  const detail = await openSession(page, session);
  // Answered, not yet delivered: each card stands where it was given, saying so.
  for (const title of [LINTER, FORMATTER]) {
    await expect(answerCard(detail, title)).toContainText("On its way to the agent");
  }
  const queued = withDaemonDb(daemon, (db) => db.prepare("SELECT text FROM pending_turns WHERE id LIKE 'review-continuation:answer:%'").all()) as Array<{ text: string }>;
  expect(queued.map((row) => row.text.split("\n")[0])).toEqual([`[mission-control:answer reviews=${linter.id},${formatter.id}]`]);
  await capture(answerCard(detail, LINTER), "05-on-its-way", page);

  writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  await expect(detail.locator(".turn-assistant, .pty-entry", { hasText: `[mission-control:answer reviews=${linter.id},${formatter.id}]` }).first())
    .toBeVisible({ timeout: 45_000 });
  const cards = detail.locator(".review-answer");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText(LINTER);
  await expect(cards.nth(1)).toContainText(FORMATTER);
  const turnIds = await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-turn-id")));
  expect(turnIds[0]).toBeTruthy();
  expect(turnIds[1]).toBe(turnIds[0]);
  await expect(detail.getByRole("group", { name: "What the agent received" })).toHaveCount(1);
  await expect(detail.getByText("On its way to the agent")).toHaveCount(0);
  await expect(rawUserTurns(detail, RAW)).toHaveCount(0);
  await capture(cards.nth(0), "06a-first-of-two-cards", page);
  await capture(cards.nth(1), "06b-second-of-two-cards", page);
});

test("a delivered answer whose question is no longer available is still a card, never the raw message", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await enableAsyncInput(daemon);
  const session = await dispatch(daemon, "Add a linter to CI", "add a linter to CI", "idle");
  const filed = await ask(daemon, session.cwd!, LINTER);
  await api(daemon, `/api/reviews/${filed.id}/resolve`, { action: "answer", response: "eslint", selections: [{ decisionId: "q", selected: ["o1"] }] });
  // Delivered, read once, and drawn as the ordinary card.
  const before = await openSession(page, session);
  await expect(replyTo(before, filed.id).first()).toBeVisible({ timeout: 30_000 });
  await expect(answerCard(before, LINTER)).toHaveCount(1);

  // A database restored from before the question existed: the review row is gone.
  await page.goto("about:blank");
  await daemon.shutdown();
  withDaemonDb(daemon, (db) => db.prepare("DELETE FROM reviews WHERE id = ?").run(filed.id));
  await daemon.restart();
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.state,
    { timeout: 60_000 }).toBe("idle");
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const detail = await openSession(page, session);
  await expect(replyTo(detail, filed.id).first()).toBeVisible({ timeout: 30_000 });

  const card = detail.getByRole("note", { name: "Answer to a question no longer available" });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("This question is no longer available");
  await expect(card).toContainText("Delivered to the agent");
  await expect(rawUserTurns(detail, RAW)).toHaveCount(0);
  await card.getByText("What the agent received").click();
  await expect(card.getByRole("group", { name: "What the agent received" })).toContainText(`[mission-control:answer review=${filed.id}]`);
  await capture(card, "08-question-no-longer-available", page);
});

test("while the review history is still loading, a delivered answer reads as loading, then becomes its card", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await enableAsyncInput(daemon);
  const session = await dispatch(daemon, "Add a linter to CI", "add a linter to CI", "idle");
  const filed = await ask(daemon, session.cwd!, LINTER);
  await api(daemon, `/api/reviews/${filed.id}/resolve`, { action: "answer", response: "eslint", selections: [{ decisionId: "q", selected: ["o1"] }] });
  const before = await openSession(page, session);
  await expect(answerCard(before, LINTER)).toHaveCount(1, { timeout: 30_000 });

  // After a restart the answer lives only in the durable history, which is held back here.
  await page.goto("about:blank");
  await daemon.shutdown();
  await daemon.restart();
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.state,
    { timeout: 60_000 }).toBe("idle");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/resolved-reviews*", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const detail = await openSession(page, session);
  await expect(replyTo(detail, filed.id).first()).toBeVisible({ timeout: 30_000 });
  const loading = detail.getByRole("note", { name: "Answer loading" });
  await expect(loading).toBeVisible();
  await expect(loading).toContainText("Loading the question…");
  await expect(detail.getByText("This question is no longer available")).toHaveCount(0);
  await expect(rawUserTurns(detail, RAW)).toHaveCount(0);
  await capture(loading, "09-loading-the-question", page);

  release();
  await expect(answerCard(detail, LINTER)).toHaveCount(1, { timeout: 30_000 });
  await expect(loading).toHaveCount(0);
  await page.unroute("**/resolved-reviews*");
});

test("a failed review-history read keeps a delivered answer loading, never gone, and the retry brings its card", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await enableAsyncInput(daemon);
  const session = await dispatch(daemon, "Add a linter to CI", "add a linter to CI", "idle");
  const filed = await ask(daemon, session.cwd!, LINTER);
  await api(daemon, `/api/reviews/${filed.id}/resolve`, { action: "answer", response: "eslint", selections: [{ decisionId: "q", selected: ["o1"] }] });
  const before = await openSession(page, session);
  await expect(answerCard(before, LINTER)).toHaveCount(1, { timeout: 30_000 });

  // After a restart the answer lives only in the durable history, and its first read fails.
  await page.goto("about:blank");
  await daemon.shutdown();
  await daemon.restart();
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.state,
    { timeout: 60_000 }).toBe("idle");
  let failures = 0;
  await page.route("**/resolved-reviews*", async (route) => {
    if (!route.request().url().includes("lineage") && failures++ === 0) await route.fulfill({ status: 500, body: "{}" });
    else await route.continue();
  });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const detail = await openSession(page, session);
  await expect(replyTo(detail, filed.id).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => failures, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const loading = detail.getByRole("note", { name: "Answer loading" });
  await expect(loading).toBeVisible();
  await expect(detail.getByText("This question is no longer available")).toHaveCount(0);
  await expect(rawUserTurns(detail, RAW)).toHaveCount(0);

  // The retry succeeds and the real card takes the turn.
  await expect(answerCard(detail, LINTER)).toHaveCount(1, { timeout: 30_000 });
  await expect(loading).toHaveCount(0);
  expect(failures).toBeGreaterThanOrEqual(2);
  await page.unroute("**/resolved-reviews*");
});

test("a review-history read that keeps failing ends in a read error, never \"no longer available\"", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  await enableAsyncInput(daemon);
  const session = await dispatch(daemon, "Add a linter to CI", "add a linter to CI", "idle");
  const filed = await ask(daemon, session.cwd!, LINTER);
  await api(daemon, `/api/reviews/${filed.id}/resolve`, { action: "answer", response: "eslint", selections: [{ decisionId: "q", selected: ["o1"] }] });
  const before = await openSession(page, session);
  await expect(answerCard(before, LINTER)).toHaveCount(1, { timeout: 30_000 });

  await page.goto("about:blank");
  await daemon.shutdown();
  await daemon.restart();
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.state,
    { timeout: 60_000 }).toBe("idle");
  // Every read of this session's own history fails transiently; its retries back off over minutes,
  // so the page's clock is driven past each wait rather than waited out.
  let ownReads = 0;
  await page.route("**/resolved-reviews*", async (route) => {
    if (route.request().url().includes("lineage")) return route.continue();
    ownReads += 1;
    await route.fulfill({ status: 500, body: "{}" });
  });
  await page.clock.install();
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const detail = await openSession(page, session);
  await expect(replyTo(detail, filed.id).first()).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByRole("note", { name: "Answer loading" })).toBeVisible();
  await expect.poll(() => ownReads, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  // The first read and six retries.
  while (ownReads < 7) {
    const reads = ownReads;
    await page.clock.fastForward(60_000);
    await expect.poll(() => ownReads, { timeout: 15_000 }).toBeGreaterThan(reads);
  }

  const card = detail.getByRole("note", { name: "Answer whose question could not be loaded" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Couldn't load the question");
  await expect(card).toContainText("Delivered to the agent");
  await expect(detail.getByText("This question is no longer available")).toHaveCount(0);
  await expect(detail.getByRole("note", { name: "Answer loading" })).toHaveCount(0);
  await expect(rawUserTurns(detail, RAW)).toHaveCount(0);
  await card.getByText("What the agent received").click();
  await expect(card.getByRole("group", { name: "What the agent received" })).toContainText(`[mission-control:answer review=${filed.id}]`);
  await capture(card, "10-question-could-not-be-loaded", page);
  // The retries are spent: no further reads.
  await page.clock.fastForward(120_000);
  await page.waitForTimeout(1_000);
  expect(ownReads, "the read stops once its retries are spent").toBe(7);
  await page.unroute("**/resolved-reviews*");
});

test("a review-history read the daemon refuses outright settles at once as a read error, and is not retried", async ({ dashboard: page, daemon }) => {
  test.setTimeout(150_000);
  await enableAsyncInput(daemon);
  const session = await dispatch(daemon, "Add a linter to CI", "add a linter to CI", "idle");
  const filed = await ask(daemon, session.cwd!, LINTER);
  await api(daemon, `/api/reviews/${filed.id}/resolve`, { action: "answer", response: "eslint", selections: [{ decisionId: "q", selected: ["o1"] }] });
  const before = await openSession(page, session);
  await expect(answerCard(before, LINTER)).toHaveCount(1, { timeout: 30_000 });

  await page.goto("about:blank");
  await daemon.shutdown();
  await daemon.restart();
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.state,
    { timeout: 60_000 }).toBe("idle");
  // A 4xx is the daemon's definite answer: asking again would not change it. It says the daemon
  // no longer holds the session, not that the question is gone, so the card says it could not load.
  let ownReads = 0;
  await page.route("**/resolved-reviews*", async (route) => {
    if (route.request().url().includes("lineage")) return route.continue();
    ownReads += 1;
    await route.fulfill({ status: 404, body: '{"error":"no such session"}' });
  });
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const detail = await openSession(page, session);
  await expect(replyTo(detail, filed.id).first()).toBeVisible({ timeout: 30_000 });
  const refused = detail.getByRole("note", { name: "Answer whose question could not be loaded" });
  await expect(refused).toBeVisible({ timeout: 15_000 });
  await expect(refused).toContainText("Couldn't load the question");
  await expect(detail.getByText("This question is no longer available")).toHaveCount(0);
  await expect(detail.getByRole("note", { name: "Answer loading" })).toHaveCount(0);
  await expect(rawUserTurns(detail, RAW)).toHaveCount(0);
  await capture(refused, "11-refused-read-could-not-load", page);
  const reads = ownReads;
  await page.waitForTimeout(6_000); // past the first retry delay
  expect(ownReads, "a refused read is not retried").toBe(reads);
  await page.unroute("**/resolved-reviews*");
});

test("Remind me later with a provisional option draws the snoozed line, not raw instructions", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await enableAsyncInput(daemon);
  const session = await dispatch(daemon, "Add a linter to CI", "add a linter to CI", "idle");
  const filed = await ask(daemon, session.cwd!, LINTER);
  await api(daemon, `/api/reviews/${filed.id}/snooze`, { delay: "1h", meanwhile: { mode: "option", optionId: "o1" } });

  const detail = await openSession(page, session);
  await expect(detail.locator(".turn-assistant, .pty-entry", { hasText: `Mock reply to: [mission-control:remind-later review=${filed.id}]` }).first())
    .toBeVisible({ timeout: 30_000 });
  const line = detail.getByRole("note", { name: `Snoozed: ${LINTER}` });
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("Delivered to the agent");
  await expect(line.getByRole("button", { name: "Answer now" })).toBeVisible();
  await expect(rawUserTurns(detail, "Not answered yet")).toHaveCount(0);
  await line.getByText("What the agent received").click();
  await expect(line.locator(".review-received-text")).toContainText("Not answered yet");
  await capture(line, "07-remind-later-line", page);
});
