import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const HELD_TURN = "hold the current turn open";
const QUEUED_TURN = "deliver this queued turn when the agent goes idle";

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise queued turn delivery");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * The half of the editable outbox the recall spec cannot see: a queued turn that is LEFT
 * queued has to leave on its own.
 *
 * An embedded session is driven entirely by its own events - nothing polls it the way the
 * discovery poller re-emits a terminal card - so the single idle transition its driver emits
 * when a turn ends is the only chance the outbox gets. A queued row that survives that
 * transition is stuck for the life of the session, and the only place that is visible is
 * here, where the browser can watch the row leave and the reply come back.
 */
test("a queued conversation turn is delivered once the agent goes idle", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();

  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();

  // The fake holds this exact prompt open for five seconds, so the next submit meets a
  // genuinely busy driver and lands in the durable outbox instead of starting a turn.
  await composer.fill(HELD_TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true }),
  ).toBeVisible();

  await composer.fill(QUEUED_TURN);
  await composer.press("Enter");
  await expect(card.getByRole("status").filter({ hasText: /^queued$/ })).toBeVisible();

  // The held turn finishes and the session goes idle. That is the outbox's cue.
  await expect(
    card.getByText(`Mock reply to: ${HELD_TURN}`, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });

  // The queued row leaves the outbox as a real turn, and the agent answers it.
  await expect(card.locator(".pending-turn")).toHaveCount(0, { timeout: 15_000 });
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(QUEUED_TURN, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    card.getByText(`Mock reply to: ${QUEUED_TURN}`, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
});
