import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * What a person decides has to stay in the conversation they decided it in.
 *
 * An agent's review question reaches the human through the MCP channel, and the human's
 * answer goes back to it as a tool RESULT - which every harness transcript parser drops as
 * machine noise (`harness/claude/transcript.ts`: "A user turn that's purely a tool result is
 * machine noise, not conversation"). So the log used to show the question as a grey tool
 * chip, then nothing, then the agent acting on a decision the reader could not see.
 *
 * These specs drive the whole seam a browser can reach: a real review created over the real
 * `POST /mcp/reviews` channel and bound to a real dispatched session, answered by real
 * clicks on the real form, resolved through the real `POST /api/reviews/:id/resolve` route,
 * and read back out of the real conversation the SSE stream feeds. The only stub is the
 * model, as everywhere in this suite.
 *
 * They assert the user-visible consequence rather than the CSS: the chosen option is
 * readable as chosen, the options passed over are still listed, a typed answer is shown as
 * typed, and the entry is a record with no controls on it. The one styling fact asserted is
 * the one the request was ABOUT - that the entry carries the review form's gold accent, and
 * so is not mistakable for the blue of your own turn or the purple of Foreman's.
 */

const TASK = "tune the transcript cache";

/** `--attention`, the gold the review form wears. Asserted as a used colour, not a class. */
const ATTENTION_GOLD = "rgb(246, 167, 51)";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every
  // keystroke; without this the next fill lands on a covered control. Its own handler stops
  // propagation, so this closes the list rather than the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  // The modal closing means the REQUEST was accepted, not that the session exists. Every
  // spec here goes on to bind a review to that session by cwd, so wait for the card - the
  // user-visible fact that the fleet has adopted it.
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

/**
 * Ask this session's human a question, the way the agent's MCP child does.
 *
 * Posted over HTTP rather than driven through a fake tool call, because the review channel
 * IS an HTTP route - `src/mcp/server.ts` does exactly this POST - and going through it keeps
 * the spec honest about the contract while staying independent of the fake agent's script.
 *
 * Bound by `cwd`, which is how a real agent binds when it has no session id to offer:
 * `findSessionByEnv` resolves a unique live session in that directory. The worktree is read
 * back off the daemon rather than guessed, since a dispatch cuts a fresh uuid-named one.
 */
async function ask(
  daemon: DaemonHandle,
  body: Record<string, unknown>,
): Promise<{ id: string; sessionId: string }> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();

  // Polled, not read once. Playwright auto-waits on locators only, and the session's cwd is
  // read off the daemon rather than the DOM: a card is on screen before the registry has
  // necessarily finished adopting the worktree it was cut into, so a single read here fails
  // intermittently with an empty fleet.
  let cwd: string | null = null;
  await expect
    .poll(
      async () => {
        const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          cwd: string | null;
        }>;
        cwd = sessions[0]?.cwd ?? null;
        return cwd;
      },
      { message: "the dispatched session is on the fleet, with a checkout to bind a review to" },
    )
    .toBeTruthy();

  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as { id: string; sessionId: string };
}

const THREE_OPTIONS = {
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
        { id: "o2", label: "No cache at all" },
      ],
      allowOther: true,
    },
  ],
};

/** Open the session's conversation and return the log. */
async function openConversation(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  return card.locator(".transcript-log");
}

test("answering a three-option question puts the choice in the conversation", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, THREE_OPTIONS);

  // The card announces the pending question, which is the entry point a person uses.
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await card.getByRole("button", { name: "to review" }).click();

  // Deliberately NOT the recommended option: a replay that quietly drew the recommendation
  // would look correct for any answer, so the spec picks the one nothing would default to.
  const form = dashboard.locator(".review-modal");
  await form.getByRole("radio", { name: /Single shared ring buffer/ }).check();
  await form.getByPlaceholder("Other…").fill("cap it at 200 turns per session");
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form).toBeHidden();

  const log = await openConversation(dashboard);
  const answer = log.locator(".review-answer");
  await expect(answer).toBeVisible();

  // Who decided, and what they decided about.
  await expect(answer).toContainText("you answered");
  await expect(answer).toContainText("Which caching strategy should the transcript reader use?");

  // The point of the feature: what was taken is readable AS taken, and what was passed over
  // is still there to be read. A list of only the chosen option cannot say what the choice
  // was between.
  await expect(answer.locator(".review-answer-option.is-picked")).toHaveText(
    /Single shared ring buffer/,
  );
  await expect(answer.getByLabel("Chosen: Single shared ring buffer")).toBeVisible();
  await expect(answer.getByLabel("Not chosen: Bounded LRU per session")).toBeVisible();
  await expect(answer.getByLabel("Not chosen: No cache at all")).toBeVisible();
  await expect(answer).toContainText("cap it at 200 turns per session");

  // A record, not a control. A resolved review cannot be answered twice, so nothing on the
  // entry may be clickable - an inert copy of a form is worse than prose.
  await expect(answer.locator("input, button, textarea, select")).toHaveCount(0);

  // The colour the request was about, read off the used style rather than off a class name.
  await expect(answer).toHaveCSS("border-left-color", ATTENTION_GOLD);
});

test("a typed answer appears in the conversation as the text submitted", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  // No `decisions`, so `request_input` is asking open-endedly and the human gets a textarea.
  await ask(daemon, {
    kind: "input",
    title: "What should the retry budget be?",
    body: "What should the retry budget be?",
  });

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await card.getByRole("button", { name: "to review" }).click();

  const form = dashboard.locator(".review-modal");
  await form.getByPlaceholder("Your answer…").fill("two attempts, then fail loudly");
  await form.getByRole("button", { name: "Send answer" }).click();
  await expect(form).toBeHidden();

  const log = await openConversation(dashboard);
  const answer = log.locator(".review-answer");
  await expect(answer).toBeVisible();
  await expect(answer).toContainText("you answered");
  await expect(answer).toContainText("What should the retry budget be?");
  await expect(answer).toContainText("two attempts, then fail loudly");
  // No form is invented for a question that never offered one.
  await expect(answer.locator(".review-answer-options")).toHaveCount(0);
  await expect(answer).toHaveCSS("border-left-color", ATTENTION_GOLD);
});

test("a free-text question can be dismissed without supplying an answer", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, {
    kind: "input",
    title: "What should the retry budget be?",
    body: "What should the retry budget be?",
  });

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await card.getByRole("button", { name: "to review" }).click();

  const form = dashboard.getByRole("dialog", { name: "Review request" });
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidenceDir = join(process.cwd(), "e2e", ".artifacts", "review-dismissal");
    mkdirSync(evidenceDir, { recursive: true });
    await dashboard.screenshot({
      path: join(evidenceDir, "free-text-review-dismissed.png"),
      fullPage: true,
    });
  }

  await form.getByRole("button", { name: "Dismiss" }).click();

  await expect(card.getByRole("button", { name: /to review/ })).toHaveCount(0);
});

test("a diff review can be dismissed without supplying a verdict", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, {
    kind: "diff",
    title: "Review the retry budget change",
    body: [
      "diff --git a/src/retry.ts b/src/retry.ts",
      "--- a/src/retry.ts",
      "+++ b/src/retry.ts",
      "@@ -1 +1 @@",
      "-export const retries = 2;",
      "+export const retries = 3;",
    ].join("\n"),
  });

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await card.getByRole("button", { name: "to review" }).click();

  const form = dashboard.getByRole("dialog", { name: "Review request" });
  const dismiss = form.getByRole("button", { name: "Dismiss" });
  await expect(dismiss).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidenceDir = join(process.cwd(), "e2e", ".artifacts", "review-dismissal");
    mkdirSync(evidenceDir, { recursive: true });
    await dashboard.screenshot({
      path: join(evidenceDir, "diff-review-dismissal.png"),
      fullPage: true,
    });
  }

  await dismiss.click();

  await expect(card.getByRole("button", { name: /to review/ })).toHaveCount(0);
});

test("a plan review can be dismissed without supplying a verdict", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, {
    kind: "plan",
    title: "Review the retry budget rollout",
    body: [
      "# Retry budget rollout",
      "",
      "1. Increase the retry budget from two attempts to three.",
      "2. Watch the worker error rate for one hour.",
    ].join("\n"),
  });

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await card.getByRole("button", { name: "to review" }).click();

  const form = dashboard.getByRole("dialog", { name: "Review request" });
  const dismiss = form.getByRole("button", { name: "Dismiss" });
  await expect(dismiss).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE === "1") {
    const evidenceDir = join(process.cwd(), "e2e", ".artifacts", "review-dismissal");
    mkdirSync(evidenceDir, { recursive: true });
    await dashboard.screenshot({
      path: join(evidenceDir, "plan-review-dismissal.png"),
      fullPage: true,
    });
  }

  await dismiss.click();

  await expect(card.getByRole("button", { name: /to review/ })).toHaveCount(0);
});

test("your answer is told apart from your own turn and from Foreman's", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, THREE_OPTIONS);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await card.getByRole("button", { name: "to review" }).click();
  const form = dashboard.locator(".review-modal");
  await form.getByRole("radio", { name: /No cache at all/ }).check();
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form).toBeHidden();

  const log = await openConversation(dashboard);
  const answer = log.locator(".review-answer");
  await expect(answer).toBeVisible();

  // The dispatch seeds the task as the session's first turn, so there is a real turn of the
  // human's own on screen to be confused with. Assert the distinction rather than assuming
  // it: same conversation, different left rule.
  const ownTurn = log.locator(".turn-user").first();
  await expect(ownTurn).toBeVisible();
  await expect(ownTurn).toContainText(TASK);

  const answerRule = await answer.evaluate((el) => getComputedStyle(el).borderLeftColor);
  const ownRule = await ownTurn.evaluate((el) => getComputedStyle(el).borderLeftColor);
  expect(answerRule, "the review answer wears the form's gold").toBe(ATTENTION_GOLD);
  expect(
    ownRule,
    "a turn you typed does not wear it - otherwise the two read as the same thing",
  ).not.toBe(ATTENTION_GOLD);

  // Foreman's voice is the other one this must not be mistaken for. It is a `turn-foreman`
  // bubble, and its styling is what the gold entry is being distinguished FROM; asserting
  // the two selectors are disjoint keeps a future restyle from collapsing them.
  await expect(log.locator(".review-answer.turn-foreman")).toHaveCount(0);
  await expect(log.locator(".turn-foreman .review-answer")).toHaveCount(0);
});

test("Foreman's own resolution is not shown as yours", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const review = await ask(daemon, {
    kind: "input",
    title: "Retry the flaky worker test?",
    body: "Retry the flaky worker test?",
  });

  // Resolved the way the Foreman worker resolves - the same route the dashboard posts to,
  // declaring itself. Its answers already appear in the log as its own entry, so showing
  // them again as the operator's would credit a person with a decision they never made.
  //
  // Seeded rather than asserted-absent from nothing: the review is really created and really
  // answered, so a regression that stopped honouring the actor would make this entry appear
  // and fail the test. An assertion over a review that was never resolved would pass either
  // way (see the standing rule in e2e/README.md).
  const res = await fetch(`${daemon.baseURL}/api/reviews/${review.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "answer", response: "yes, retry once", by: "foreman" }),
  });
  expect(res.status).toBe(200);

  const log = await openConversation(dashboard);
  // The conversation has to have SETTLED before absence means anything, so wait on the
  // session's own first turn rather than on a bare negative.
  await expect(log.locator(".turn-user").first()).toContainText(TASK);
  await expect(log.locator(".review-answer")).toHaveCount(0);
  await expect(log).not.toContainText("Retry the flaky worker test?");
});
