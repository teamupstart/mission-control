import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A task on the Agent SDK runtime asks its human through `request_input`, never through
 * Claude's built-in `AskUserQuestion`.
 *
 * The launch removes the built-in (`disallowedTools`), pre-approves `request_input` and
 * appends the redirect (`sdkAskChannel` in `ask-channel-prompt.ts`). `fake-claude.mjs` honours that
 * the way the real CLI does: with `AskUserQuestion` disallowed it never raises the native
 * `can_use_tool` form, and only when the appended system prompt names `request_input` does
 * it call the real Mission MCP tool. So the review this spec answers exists only if the
 * daemon sent both halves of the channel - and the native form appearing would mean the
 * built-in was still there.
 */

const EVIDENCE = artifactsDir("sdk-task-asks-through-request-input");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/sdk-task-asks-through-request-input/${name}.png`);
}

const TASK = "pick the toolchain";
/** The prompt `fake-claude.mjs` answers by asking which linter to use. */
const ASK_TURN = "ask me which linter to use";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
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

test("a dispatched SDK task's question arrives as a request_input review, not the native form", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
  await expect(row).toHaveClass(/tone-idle/);
  await row.click({ delay: 1_000 });
  const card = dashboard.locator(".console-detail");
  // The SDK runtime, so this is the launch path the change is about.
  await expect(card.getByText("Agent SDK")).toBeVisible();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(ASK_TURN);
  await composer.press("Enter");

  // The question is a review the card announces, and the built-in's driver form never shows.
  const toReview = card.getByRole("button", { name: "to review" });
  await expect(toReview).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".pane-dialog")).toHaveCount(0);
  await shoot(dashboard, "the-question-as-a-review", card);

  await toReview.click();
  const form = dashboard.locator(".review-modal");
  await expect(form).toContainText("Which linter?");
  await shoot(dashboard, "the-review-form", form);
  // Deliberately not the first option, so a form that ignores the click cannot pass.
  await form.getByRole("radio", { name: /eslint/ }).check();
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form).toBeHidden();

  // The blocked tool call returns the human's choice, and the agent's turn ends on it.
  await expect(card.getByText("request_input answered: Answered:")).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("• Which linter? → eslint")).toBeVisible();
  const answer = card.locator(".transcript-log .review-answer");
  await expect(answer.getByLabel("Chosen: eslint")).toBeVisible();
  await expect(answer.getByLabel("Not chosen: biome")).toBeVisible();
  await expect(card.locator(".pane-dialog")).toHaveCount(0);
  await shoot(dashboard, "the-answer-in-the-conversation", card.locator(".transcript-log"));
});
