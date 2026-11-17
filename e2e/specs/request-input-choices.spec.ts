import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A `request_input` question with options, answered the way a person actually answers one:
 * "Chat about it" sits with the agent's options rather than under the text box, the text box
 * carries context beside whichever row is picked, and clicking a picked radio a second time
 * takes the pick back. Driven end to end, from `POST /mcp/reviews` to the
 * `GET /mcp/reviews/:id/wait` long poll the agent's MCP call reads.
 */

const EVIDENCE = artifactsDir("request-input-choices");
const TASK = "choose a linter";
const LINTER = "Which linter should this repo use?";

/** Opt-in reviewer pixels, gitignored under `e2e/.artifacts/`, never committed. */
async function evidence(target: Locator | Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
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

/** Raise the review exactly as `request_input` builds it: one decision, id `q`, ids by position. */
async function askLinter(daemon: DaemonHandle): Promise<string> {
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
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "input",
      title: LINTER,
      body: LINTER,
      decisions: [
        {
          id: "q",
          question: LINTER,
          allowOther: true,
          options: [
            { id: "o0", label: "biome", detail: "One binary for lint and format; fewer plugins." },
            { id: "o1", label: "eslint", detail: "Type-aware rules; more config.", recommended: true },
          ],
        },
      ],
    }),
  });
  expect(res.status, `the review channel accepted the request: ${await res.clone().text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

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

async function box(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await target.boundingBox();
  expect(b, "the element is laid out").not.toBeNull();
  return b!;
}

test("Chat about it is laid out with the options, above the text box and aligned with them", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  await askLinter(daemon);
  const modal = await openReview(dashboard);
  const group = modal.getByRole("group", { name: LINTER });

  const lastOption = await box(group.locator("label.decision-option").filter({ hasText: "eslint" }));
  const chatRow = await box(group.locator("label.decision-chat"));
  const textBox = await box(group.getByPlaceholder("Other answer, or add context…"));

  // Directly after the last option, and the text box only after that.
  expect(chatRow.y).toBeGreaterThan(lastOption.y);
  expect(textBox.y, "the text box sits below Chat about it, not above it").toBeGreaterThanOrEqual(
    chatRow.y + chatRow.height,
  );
  // The same column as the agent's options: same left edge, same width.
  expect(Math.abs(chatRow.x - lastOption.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(chatRow.width - lastOption.width)).toBeLessThanOrEqual(1);
  const radioX = (await box(group.getByRole("radio", { name: /^eslint/ }))).x;
  const chatRadioX = (await box(group.getByRole("radio", { name: "Chat about it" }))).x;
  expect(Math.abs(chatRadioX - radioX), "the radios line up in one column").toBeLessThanOrEqual(1);
  await evidence(modal, "chat-about-it-with-the-options");
});

test("an option can be picked with context typed beside it, and both reach the agent", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await askLinter(daemon);
  const modal = await openReview(dashboard);
  const group = modal.getByRole("group", { name: LINTER });
  const eslint = group.getByRole("radio", { name: /^eslint/ });
  const text = group.getByPlaceholder("Other answer, or add context…");

  await eslint.check();
  await text.click();
  await text.fill("but keep the flat config");
  // Typing does not clear the pick, and picking again does not clear the text.
  await expect(eslint).toBeChecked();
  await group.getByRole("radio", { name: /^biome/ }).check();
  await expect(text).toHaveValue("but keep the flat config");
  await eslint.check();
  await expect(eslint).toBeChecked();
  await expect(text).toHaveValue("but keep the flat config");
  await evidence(modal, "option-picked-with-context");

  await modal.getByRole("button", { name: "Submit" }).click();
  await expect(modal).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toBe(`Answered:\n\n• ${LINTER}\n  → eslint\n  Context: but keep the flat config`);
  expect(result.selections).toEqual([{ decisionId: "q", selected: ["o1"], other: "but keep the flat config" }]);

  // The conversation replays the text as the context it was, beside the pick.
  const answer = dashboard.locator(".console-detail .transcript-log .review-answer");
  await expect(answer.getByLabel("Chosen: eslint")).toBeVisible();
  await expect(answer.locator(".review-answer-other")).toHaveText("Contextbut keep the flat config");
});

test("Chat about it can carry typed context too", async ({ dashboard, daemon }) => {
  await dispatch(dashboard, daemon);
  const id = await askLinter(daemon);
  const modal = await openReview(dashboard);
  const group = modal.getByRole("group", { name: LINTER });
  const chat = group.getByRole("radio", { name: "Chat about it" });
  const text = group.getByPlaceholder("Other answer, or add context…");

  await chat.check();
  await text.fill("does biome cover our import rules?");
  await expect(chat).toBeChecked();
  await modal.getByRole("button", { name: "Submit & chat (1)" }).click();
  await expect(modal).toBeHidden();

  const result = await agentResult(daemon, id);
  expect(result.status).toBe("answered");
  expect(result.response).toMatch(
    /^Answered:\n\n• Which linter should this repo use\?\n {2}→ Chat about it\n {2}Context: does biome cover our import rules\?\n\nThe human wants to discuss/,
  );
  expect(result.selections).toEqual([
    { decisionId: "q", selected: [], other: "does biome cover our import rules?", chat: true },
  ]);
});

test("clicking a picked radio again clears it, for an option and for Chat about it", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);
  const id = await askLinter(daemon);
  const modal = await openReview(dashboard);
  const group = modal.getByRole("group", { name: LINTER });
  const biome = group.getByRole("radio", { name: /^biome/ });
  const chat = group.getByRole("radio", { name: "Chat about it" });
  const submit = modal.getByRole("button", { name: /^Submit/ });

  await biome.click();
  await expect(biome).toBeChecked();
  await expect(submit).toBeEnabled();
  await biome.click();
  await expect(biome).not.toBeChecked();
  await expect(submit).toBeDisabled();

  // Clicking the row's text toggles it the same way as clicking the radio itself.
  await group.locator("label.decision-option").filter({ hasText: "biome" }).getByText("biome", { exact: true }).click();
  await expect(biome).toBeChecked();
  await group.locator("label.decision-option").filter({ hasText: "biome" }).getByText("biome", { exact: true }).click();
  await expect(biome).not.toBeChecked();

  await chat.click();
  await expect(chat).toBeChecked();
  await expect(submit).toHaveText("Submit & chat (1)");
  await chat.click();
  await expect(chat).not.toBeChecked();
  await expect(submit).toHaveText("Submit");
  await expect(submit).toBeDisabled();
  await evidence(modal, "radio-cleared-by-second-click");

  // Still answerable after clearing: the form is a normal form again.
  await group.getByRole("radio", { name: /^eslint/ }).click();
  await submit.click();
  await expect(modal).toBeHidden();
  const result = await agentResult(daemon, id);
  expect(result.selections).toEqual([{ decisionId: "q", selected: ["o1"], other: null }]);
});
