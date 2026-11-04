import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * "Chat about it" on an agent's question (#1351), driven end to end: a real review over
 * `POST /mcp/reviews`, answered by clicks, resolved through `POST /api/reviews/:id/resolve`,
 * and read back off the `GET /mcp/reviews/:id/wait` long poll the MCP server hands to the agent.
 */

const TASK = "persist review drafts";

/** Opt-in reviewer pixels, gitignored under `e2e/.artifacts/`, never committed. */
async function evidence(target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = join(process.cwd(), "e2e", ".artifacts", "review-chat-about-it");
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: join(dir, `${name}.png`) });
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox reopens over the Task field on every keystroke; Escape closes the list,
  // not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row")).toHaveCount(1);
}

function token(daemon: DaemonHandle): string {
  return readFileSync(join(daemon.home, "token"), "utf8").trim();
}

/** Raise a review the way the agent's MCP child does, bound to the session by its checkout. */
async function ask(daemon: DaemonHandle, body: Record<string, unknown>): Promise<string> {
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
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, ...body }),
  });
  expect(res.status, `the review channel accepted the request: ${await res.clone().text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** What the agent's blocked tool call receives once the review resolves. */
async function agentResult(
  daemon: DaemonHandle,
  id: string,
): Promise<{ status: string; response: string | null; selections: Array<Record<string, unknown>> | null }> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews/${id}/wait`, {
    headers: { "x-harness-token": token(daemon) },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    status: string;
    response: string | null;
    selections: Array<Record<string, unknown>> | null;
  };
}

async function openReview(page: Page): Promise<Locator> {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: "to review" }).click();
  const modal = page.getByRole("dialog", { name: "Review request" });
  await expect(modal).toBeVisible();
  return modal;
}

const MIGRATE = "Should the migration ship in this PR?";

const PLAN = {
  kind: "plan-decisions",
  title: "Drafts plan",
  body: "## Plan\n\nPersist half-answered reviews so a reload does not lose them.",
  decisions: [
    {
      id: "store",
      question: "Where should review drafts persist?",
      options: [
        { id: "local", label: "localStorage", recommended: true },
        { id: "server", label: "Server-side table" },
      ],
    },
    {
      id: "migrate",
      question: MIGRATE,
      options: [
        { id: "yes", label: "Yes" },
        { id: "later", label: "No, follow-up PR" },
      ],
    },
    {
      id: "name",
      question: "Name the setting",
      options: [
        { id: "a", label: "reviewDrafts.enabled" },
        { id: "b", label: "drafts.persist" },
      ],
    },
  ],
};

test("answer some questions, move one to chat, and land in the session's message box", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, PLAN);
  const modal = await openReview(dashboard);

  for (const d of PLAN.decisions) {
    await expect(modal.getByRole("group", { name: d.question }).getByRole("radio", { name: "Chat about it" })).toBeVisible();
  }
  const submit = modal.getByRole("button", { name: /^Submit/ });
  await expect(submit).toHaveText("Submit");
  await expect(submit).toBeDisabled();

  const migrate = modal.getByRole("group", { name: MIGRATE });
  await modal.getByRole("radio", { name: /localStorage/ }).check();
  // Picked first, then moved: the move replaces the pick rather than sending both.
  await migrate.getByRole("radio", { name: "Yes" }).check();
  await migrate.getByRole("radio", { name: "Chat about it" }).check();
  await expect(migrate.getByRole("radio", { name: "Yes" })).not.toBeChecked();
  await expect(submit).toBeDisabled();
  await modal.getByRole("radio", { name: /reviewDrafts\.enabled/ }).check();
  await migrate.getByRole("textbox", { name: `Note to the agent: ${MIGRATE}` }).fill("why would a later PR be safer?");

  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText("Submit & chat (1)");
  await evidence(modal, "form-with-one-question-moved-to-chat");
  await submit.click();
  await expect(modal).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toBe(
    [
      "Plan decisions submitted:",
      "",
      "• Where should review drafts persist?",
      "  → localStorage",
      "",
      `• ${MIGRATE}`,
      "  → Chat about it",
      "  Note: why would a later PR be safer?",
      "",
      "• Name the setting",
      "  → reviewDrafts.enabled",
      "",
      "The human wants to discuss this decision with you in conversation before choosing:",
      `- ${MIGRATE}`,
      "",
      "Do not choose it yourself, and do not ask it again with request_input or request_plan_decisions." +
        " Act on the other answers only where they do not depend on it.",
      "Then, in your next message, explain it in plain terms: the context behind it, the trade-off" +
        " you cannot settle on your own, and what you would need to know to decide. End your turn" +
        " after that message so the human can reply in this session.",
    ].join("\n"),
  );
  expect(result.selections).toEqual([
    { decisionId: "store", selected: ["local"], other: null },
    { decisionId: "migrate", selected: [], other: null, chat: true, note: "why would a later PR be safer?" },
    { decisionId: "name", selected: ["a"], other: null },
  ]);

  const detail = dashboard.locator(".console-detail");
  await expect(detail.locator("textarea.transcript-input")).toBeFocused();

  const answer = detail.locator(".transcript-log .review-answer");
  await expect(answer).toBeVisible();
  await expect(answer.getByLabel("Chosen: localStorage")).toBeVisible();
  await expect(answer.getByText("Moved to chat")).toHaveCount(1);
  await expect(answer.getByText("No option chosen.")).toHaveCount(0);
  await evidence(answer, "conversation-entry-moved-to-chat");
});

test("Chat about all moves every question at once", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, PLAN);
  const modal = await openReview(dashboard);

  await modal.getByRole("button", { name: "Chat about all" }).click();
  await expect(modal).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toContain("The human wants to discuss these 3 decisions with you in conversation");
  expect(result.response).not.toContain("Act on the other answers");
  expect(result.selections).toEqual(
    PLAN.decisions.map((d) => ({ decisionId: d.id, selected: [], other: null, chat: true })),
  );
  await expect(dashboard.locator(".console-detail textarea.transcript-input")).toBeFocused();
});

test("an open-ended question can be moved to chat too", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const question = "What retry budget should flaky shards get?";
  const id = await ask(daemon, { kind: "input", title: question, body: question });
  const modal = await openReview(dashboard);

  // Anything already typed travels as the note.
  await modal.getByPlaceholder("Your answer…").fill("what counts as flaky here?");
  await evidence(modal, "free-text-question-with-chat-button");
  await modal.getByRole("button", { name: "Chat about it" }).click();
  await expect(modal).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toMatch(
    new RegExp(`^Answered:\\n\\n• ${question.replace("?", "\\?")}\\n  → Chat about it\\n  Note: what counts as flaky here\\?\\n\\nThe human wants to discuss this decision`),
  );

  const answer = dashboard.locator(".console-detail .transcript-log .review-answer");
  await expect(answer.getByText("Moved to chat")).toBeVisible();
  await expect(answer.getByText("what counts as flaky here?")).toBeVisible();
  await expect(answer.getByText(/Do not choose/)).toHaveCount(0);
});

test("on a checkbox question, Chat about it and the real options replace each other", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const question = "Which harnesses get the cache first?";
  const id = await ask(daemon, {
    kind: "plan-decisions",
    title: "Cache rollout",
    body: "## Plan\n\nRoll the transcript cache out to the harnesses that read JSONL.",
    decisions: [
      {
        id: "harnesses",
        question,
        multiSelect: true,
        options: [
          { id: "claude", label: "Claude" },
          { id: "codex", label: "Codex" },
          { id: "pi", label: "Pi" },
        ],
      },
    ],
  });
  const modal = await openReview(dashboard);
  const group = modal.getByRole("group", { name: question });
  const submit = modal.getByRole("button", { name: /^Submit/ });
  const chat = group.getByRole("checkbox", { name: "Chat about it" });

  await group.getByRole("checkbox", { name: "Claude" }).check();
  await group.getByRole("checkbox", { name: "Pi" }).check();

  await chat.check();
  await expect(group.getByRole("checkbox", { name: "Claude" })).not.toBeChecked();
  await expect(group.getByRole("checkbox", { name: "Pi" })).not.toBeChecked();
  await expect(submit).toHaveText("Submit & chat (1)");

  await group.getByRole("checkbox", { name: "Codex" }).check();
  await expect(chat).not.toBeChecked();
  await expect(group.getByRole("checkbox", { name: "Claude" })).not.toBeChecked();
  await expect(submit).toHaveText("Submit");
  await submit.click();
  await expect(modal).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toBe(`Plan decisions submitted:\n\n• ${question}\n  → Codex`);
  expect(result.selections).toEqual([{ decisionId: "harnesses", selected: ["codex"], other: null }]);
});

test("a refused submit with a question moved to chat keeps the dialog and does not leave for the conversation", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, PLAN);

  // The resolve fails the way a daemon mid-restart or a refused route does.
  await dashboard.route("**/api/reviews/*/resolve", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "daemon unavailable" }) }),
  );
  const modal = await openReview(dashboard);
  const migrate = modal.getByRole("group", { name: MIGRATE });
  await modal.getByRole("radio", { name: /localStorage/ }).check();
  await migrate.getByRole("radio", { name: "Chat about it" }).check();
  await modal.getByRole("radio", { name: /reviewDrafts\.enabled/ }).check();
  await modal.getByRole("button", { name: "Submit & chat (1)" }).click();

  await expect(modal.getByText("daemon unavailable")).toBeVisible();
  await expect(modal).toBeVisible();
  await expect(migrate.getByRole("radio", { name: "Chat about it" })).toBeChecked();
  await expect(dashboard.locator(".console-detail textarea.transcript-input")).not.toBeFocused();
  await evidence(modal, "refused-submit-keeps-chat-dialog");

  await dashboard.unroute("**/api/reviews/*/resolve");
  await modal.getByRole("button", { name: "Submit & chat (1)" }).click();
  await expect(modal).toBeHidden();
  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.selections).toEqual([
    { decisionId: "store", selected: ["local"], other: null },
    { decisionId: "migrate", selected: [], other: null, chat: true },
    { decisionId: "name", selected: ["a"], other: null },
  ]);
  await expect(dashboard.locator(".console-detail textarea.transcript-input")).toBeFocused();
});

test("moving a question to chat from the attention inbox opens the session at its message box", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, PLAN);

  // Somewhere with no session on screen, so opening the session is the inbox's doing.
  await dashboard.evaluate(() => {
    location.hash = "#/runs";
  });
  await expect(dashboard.locator(".console-detail")).toHaveCount(0);

  const toAnswer = dashboard.locator("button.pulse-seg", { hasText: "to answer" });
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  // Retried as a whole: an SSE frame can replace the pulse segment under the click.
  await expect(async () => {
    if (!(await inbox.isVisible())) await toAnswer.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });

  const migrate = inbox.getByRole("group", { name: MIGRATE });
  await inbox.getByRole("radio", { name: /localStorage/ }).check();
  await migrate.getByRole("radio", { name: "Chat about it" }).check();
  await inbox.getByRole("radio", { name: /reviewDrafts\.enabled/ }).check();
  await evidence(inbox, "inbox-question-moved-to-chat");
  await inbox.getByRole("button", { name: "Submit & chat (1)" }).click();

  await expect(inbox).toBeHidden();
  const detail = dashboard.locator(".console-detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator("textarea.transcript-input")).toBeFocused();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.selections).toEqual([
    { decisionId: "store", selected: ["local"], other: null },
    { decisionId: "migrate", selected: [], other: null, chat: true },
    { decisionId: "name", selected: ["a"], other: null },
  ]);
  await expect(detail.locator(".transcript-log .review-answer").getByText("Moved to chat")).toHaveCount(1);
});

test("typing an Other answer takes a question out of chat, and blank text does not", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const question = "Which version should the cache format pin?";
  const id = await ask(daemon, {
    kind: "plan-decisions",
    title: "Cache format",
    body: "## Plan\n\nVersion the on-disk transcript cache.",
    decisions: [
      {
        id: "format",
        question,
        allowOther: true,
        options: [
          { id: "v1", label: "v1" },
          { id: "v2", label: "v2" },
        ],
      },
    ],
  });
  const modal = await openReview(dashboard);
  const group = modal.getByRole("group", { name: question });
  const chat = group.getByRole("radio", { name: "Chat about it" });
  const other = group.getByPlaceholder("Other…");
  const submit = modal.getByRole("button", { name: /^Submit/ });

  await other.fill("something else");
  await chat.check();
  await expect(other).toHaveValue("");
  await expect(submit).toHaveText("Submit & chat (1)");

  await other.fill("   ");
  await expect(chat).toBeChecked();
  await expect(submit).toHaveText("Submit & chat (1)");

  await other.fill("pin to v3");
  await expect(chat).not.toBeChecked();
  await expect(submit).toHaveText("Submit");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(modal).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toBe(`Plan decisions submitted:\n\n• ${question}\n  Other: pin to v3`);
  expect(result.selections).toEqual([{ decisionId: "format", selected: [], other: "pin to v3" }]);
});

test("moving a question to chat closes the dialog even while another review is still pending", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, PLAN);
  const other = "Should the cache survive a daemon restart?";
  await ask(daemon, { kind: "input", title: other, body: other });
  const modal = await openReview(dashboard);
  await expect(modal.getByText("2 pending")).toBeVisible();

  await modal.getByRole("radio", { name: /localStorage/ }).check();
  await modal.getByRole("group", { name: MIGRATE }).getByRole("radio", { name: "Chat about it" }).check();
  await modal.getByRole("radio", { name: /reviewDrafts\.enabled/ }).check();
  await modal.getByRole("button", { name: "Submit & chat (1)" }).click();

  await expect(modal).toBeHidden();
  await expect(dashboard.locator(".console-detail textarea.transcript-input")).toBeFocused();
  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");

  const reopened = await openReview(dashboard);
  await expect(reopened.getByText("1 pending")).toBeVisible();
  await expect(reopened.getByRole("heading", { name: other })).toBeVisible();
  await expect(reopened.getByPlaceholder("Your answer…")).toBeVisible();
});

test("an open-ended question with nothing typed can be moved to chat", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const question = "What retry budget should flaky shards get?";
  const id = await ask(daemon, { kind: "input", title: question, body: question });
  const modal = await openReview(dashboard);

  await expect(modal.getByPlaceholder("Your answer…")).toHaveValue("");
  await expect(modal.getByRole("button", { name: "Send answer" })).toBeDisabled();
  await modal.getByRole("button", { name: "Chat about it" }).click();
  await expect(modal).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toBe(
    [
      "Answered:",
      "",
      `• ${question}`,
      "  → Chat about it",
      "",
      "The human wants to discuss this decision with you in conversation before choosing:",
      `- ${question}`,
      "",
      "Do not choose it yourself, and do not ask it again with request_input or request_plan_decisions.",
      "Then, in your next message, explain it in plain terms: the context behind it, the trade-off" +
        " you cannot settle on your own, and what you would need to know to decide. End your turn" +
        " after that message so the human can reply in this session.",
    ].join("\n"),
  );
  expect(result.selections).toEqual([{ decisionId: "q", selected: [], other: null, chat: true }]);
  await expect(dashboard.locator(".console-detail textarea.transcript-input")).toBeFocused();
});
