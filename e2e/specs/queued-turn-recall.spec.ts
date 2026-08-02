import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const HELD_TURN = "hold the current turn open";
const QUEUED_TURN = "edit this queued turn before delivery";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise queued turn recall");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

test("a queued conversation turn returns to the composer with Up Arrow", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();

  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();

  // The fake holds this exact prompt open for five seconds. That makes the next submit hit
  // the real SDK busy state and remain in Mission Control's durable pending-turn buffer.
  await composer.fill(HELD_TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true }),
  ).toBeVisible();

  await composer.fill(QUEUED_TURN);
  await composer.press("Enter");

  await expect(card.getByRole("status").filter({ hasText: /^queued$/ })).toBeVisible();
  await expect(card.getByText(QUEUED_TURN, { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(composer).toHaveValue("");

  await composer.press("ArrowUp");

  await expect(composer).toHaveValue(QUEUED_TURN);
  await expect(
    card.locator(".pending-turn").getByText(QUEUED_TURN, { exact: true }),
  ).toHaveCount(0);
});
