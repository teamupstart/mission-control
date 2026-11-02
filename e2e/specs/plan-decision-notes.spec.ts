import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A plan decision can carry instructions as well as a choice.
 *
 * `request_plan_decisions` used to accept only the options it offered, plus an "Other" field
 * when the agent opted in - and "Other" reads as an answer outside the options, not a note on
 * the one taken. Every decision on a plan-decisions form now has an optional note box. These
 * specs drive the whole seam: a real review over `POST /mcp/reviews`, answered by real clicks
 * and typing, resolved through `POST /api/reviews/:id/resolve`, then read back off the same
 * `GET /mcp/reviews/:id/wait` long poll the MCP server returns to the agent.
 *
 * The note's consequence is asserted where a person and an agent each meet it: the text the
 * agent receives, and the conversation entry the human reads afterwards. An option-carrying
 * `request_input` must NOT grow the box, because the product-issue confirmation shares that
 * form and acts on the selection alone.
 */

const TASK = "tune the transcript cache";

/** Opt-in reviewer pixels, gitignored under `e2e/.artifacts/`, never committed. */
async function evidence(target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  const dir = join(process.cwd(), "e2e", ".artifacts", "plan-decision-notes");
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

async function openReview(page: Page) {
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await page.locator(".console-detail").getByRole("button", { name: "to review" }).click();
  return page.locator(".review-modal");
}

const PLAN = {
  kind: "plan-decisions",
  title: "Transcript cache plan",
  body: "## Plan\n\nCache parsed transcripts so the conversation view stops re-reading JSONL.",
  decisions: [
    {
      id: "store",
      question: "Where should the cache live?",
      options: [
        { id: "memory", label: "In memory per session", recommended: true },
        { id: "disk", label: "On disk beside the transcript" },
      ],
    },
    {
      id: "evict",
      question: "How should entries be evicted?",
      options: [
        { id: "lru", label: "Least recently used" },
        { id: "ttl", label: "Fixed time to live" },
      ],
    },
  ],
};

test("a note typed beside a plan decision reaches the agent and stays in the conversation", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, PLAN);
  const form = await openReview(dashboard);

  // Every decision offers the box, including ones that never asked for "Other".
  const storeNote = form.getByRole("textbox", { name: "Note to the agent: Where should the cache live?" });
  const evictNote = form.getByRole("textbox", { name: "Note to the agent: How should entries be evicted?" });
  await expect(storeNote).toBeVisible();
  await expect(evictNote).toBeVisible();
  await expect(form.getByPlaceholder("Other…")).toHaveCount(0);

  // A note alone does not answer a decision: Submit waits for a selection on each.
  await storeNote.fill("cap it at 200 turns\nand drop it when the session exits");
  await expect(form.getByRole("button", { name: "Submit" })).toBeDisabled();

  await form.getByRole("radio", { name: /On disk beside the transcript/ }).check();
  await form.getByRole("radio", { name: /Least recently used/ }).check();
  await evidence(form, "radio-decisions-with-note-box");
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toBe(
    "Plan decisions submitted:\n\n" +
      "• Where should the cache live?\n  → On disk beside the transcript\n" +
      "  Note: cap it at 200 turns\nand drop it when the session exits\n\n" +
      "• How should entries be evicted?\n  → Least recently used",
  );
  // The untouched note box adds nothing to the stored answer.
  expect(result.selections).toEqual([
    { decisionId: "store", selected: ["disk"], other: null, note: "cap it at 200 turns\nand drop it when the session exits" },
    { decisionId: "evict", selected: ["lru"], other: null },
  ]);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const answer = dashboard.locator(".console-detail .transcript-log .review-answer");
  await expect(answer).toBeVisible();
  await expect(answer.getByLabel("Chosen: On disk beside the transcript")).toBeVisible();
  const note = answer.locator(".review-answer-note");
  await expect(note).toHaveCount(1);
  await expect(note).toContainText("Note");
  await expect(note).toContainText("cap it at 200 turns");
  await expect(note).toHaveCSS("white-space", "pre-wrap");
  await evidence(answer, "conversation-entry-with-note");
});

test("a note typed beside checkbox choices reaches the agent with every selection", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await ask(daemon, {
    kind: "plan-decisions",
    title: "Transcript cache rollout",
    body: "## Plan\n\nRoll the transcript cache out to the harnesses that read JSONL.",
    decisions: [
      {
        id: "harnesses",
        question: "Which harnesses get the cache first?",
        multiSelect: true,
        options: [
          { id: "claude", label: "Claude" },
          { id: "codex", label: "Codex" },
          { id: "pi", label: "Pi" },
        ],
      },
    ],
  });
  const form = await openReview(dashboard);

  // Two of three checked, out of the order they are listed, so a note that rode along with
  // only one selection - or replaced them - would show in the agent's text.
  await form.getByRole("checkbox", { name: /Pi/ }).check();
  await form.getByRole("checkbox", { name: /Claude/ }).check();
  await form
    .getByRole("textbox", { name: "Note to the agent: Which harnesses get the cache first?" })
    .fill("leave Codex until its parser is fixed");
  await evidence(form, "checkbox-decision-with-note-box");
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toBe(
    "Plan decisions submitted:\n\n" +
      "• Which harnesses get the cache first?\n  → Claude, Pi\n" +
      "  Note: leave Codex until its parser is fixed",
  );
  expect(result.selections).toEqual([
    { decisionId: "harnesses", selected: ["pi", "claude"], other: null, note: "leave Codex until its parser is fixed" },
  ]);
});

test("an option-carrying question from request_input offers no note box", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await ask(daemon, {
    kind: "input",
    title: "Which linter should this repo use?",
    body: "Which linter should this repo use?",
    decisions: [
      {
        id: "q",
        question: "Which linter should this repo use?",
        options: [
          { id: "o0", label: "biome" },
          { id: "o1", label: "eslint" },
        ],
      },
    ],
  });
  const form = await openReview(dashboard);
  await expect(form.getByRole("radio", { name: /eslint/ })).toBeVisible();
  await expect(form.getByRole("textbox", { name: /Note to the agent/ })).toHaveCount(0);
});
