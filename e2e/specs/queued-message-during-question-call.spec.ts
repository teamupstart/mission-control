import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A message typed to an agent that is stopped inside its own `request_input` call.
 *
 * The live failure: a Claude SDK task called `request_input` in call mode and its turn
 * waited inside that call. The operator typed instead of answering the card. At one minute
 * the outbox steered the message into the running turn, but Claude reads a steer only
 * between tool calls, so the message sat in the CLI's own queue, unread, for as long as the
 * question stayed open: two and a half hours. Nothing escalated it, because it had already
 * left the outbox.
 *
 * `fake-claude.mjs` models that exactly: a prompt sent into a held turn is pushed onto that
 * turn and reaches the transcript only when the turn ends. So the row must never offer
 * Steer now while the question call is open, must say interruption is how it gets there,
 * and Interrupt and deliver must actually put it in front of the agent.
 */

const EVIDENCE = artifactsDir("queued-message-during-question-call");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/queued-message-during-question-call/${name}.png`);
}

const TASK = "pick the toolchain";
/** The prompt `fake-claude.mjs` answers by calling `request_input` and blocking on it. */
const ASK_TURN = "ask me which linter to use";
const FOLLOW_UP = "what is happening? report back";

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

test("a message queued while the agent waits inside request_input is interrupted in, never steered", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(120_000);
  await dispatch(dashboard, daemon);

  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
  await expect(row).toHaveClass(/tone-idle/);
  await row.click({ delay: 1_000 });
  const card = dashboard.locator(".console-detail");
  await expect(card.getByText("Agent SDK")).toBeVisible();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(ASK_TURN);
  await composer.press("Enter");

  // The turn is now parked inside the call, waiting on the review card.
  await expect(card.getByRole("button", { name: "to review" })).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".pane-dialog")).toHaveCount(0);

  await composer.fill(FOLLOW_UP);
  await composer.press("Enter");
  const queued = card.locator(".pending-turn").filter({ hasText: FOLLOW_UP });
  await expect(queued).toHaveCount(1);

  // A steer would sit unread behind the open call, so the row does not offer one.
  await expect(queued.getByRole("button", { name: "Interrupt and deliver", exact: true })).toBeEnabled();
  await expect(queued.getByRole("button", { name: "Steer now", exact: true })).toHaveCount(0);
  // Once the wait notice shows, it names why this message will interrupt the turn.
  await expect(
    queued.getByText(/Waiting \d+s · The agent is stopped on its question to you, so this message will interrupt it/),
  ).toBeVisible({ timeout: 45_000 });
  await shoot(dashboard, "queued-behind-the-question-call", queued);

  await queued.getByRole("button", { name: "Interrupt and deliver", exact: true }).click();
  await expect(queued).toHaveCount(0, { timeout: 20_000 });
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(FOLLOW_UP, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await shoot(dashboard, "delivered-after-the-interruption", card.locator(".transcript-log"));
});
