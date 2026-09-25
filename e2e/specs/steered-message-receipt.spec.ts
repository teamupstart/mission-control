import { mkdirSync } from "node:fs";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// The held turn keeps Claude busy for the whole spec, and the fake reads the deferred steer
// fifteen seconds after taking it: long enough to prove the row stays, scroll away from it
// and come back, short enough that the receipt arrives inside the spec.
test.use({ daemonEnv: { MC_E2E_CLAUDE_HELD_TURN_MS: "180000", MC_E2E_CLAUDE_STEER_READ_MS: "15000" } });

const STEER = "read this steer at your next step: skip e2e for now";

test("a steered message stays in view until the agent reads it", async ({ dashboard, daemon }) => {
  test.setTimeout(120000);
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const modal = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await modal.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await modal.getByPlaceholder("What should this agent do?").fill("show a steer until it is read");
  await modal.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await modal.getByRole("button", { name: "Dispatch now" }).click();
  await expect(modal).toBeHidden();
  const rail = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
  await expect(rail.locator(".rail-state")).toHaveText("idle", { timeout: 20000 });
  await rail.click();
  const card = dashboard.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Reply to this session/);
  const log = card.locator(".transcript-log");
  const delivered = (text: string) => card.locator(".turn-user:not(.pending-turn)").getByText(text, { exact: true });

  // Enough history that the log scrolls, so there is somewhere to scroll AWAY to.
  for (let i = 1; i <= 6; i++) {
    const filler = `earlier message ${i}\n${"so the conversation is long enough to scroll. ".repeat(4)}`;
    await composer.fill(filler);
    await composer.press("Enter");
    await expect(delivered(filler)).toBeVisible();
  }
  await composer.fill("hold the current turn open");
  await composer.press("Enter");
  await expect(delivered("hold the current turn open")).toBeVisible();
  await expect(rail.locator(".rail-state")).toHaveText("working");

  await composer.fill(STEER);
  await composer.press("Enter");
  const queued = card.locator(".pending-turn").filter({ hasText: STEER });
  await queued.getByRole("button", { name: "Steer now", exact: true }).click();

  // Accepted into the turn, not yet read: the row stays, says so, and counts.
  const steered = card.locator(".pending-turn").filter({ hasText: STEER });
  await expect(steered.getByRole("status")).toHaveText("steered · waiting for claude to read it");
  await expect(steered.getByText(/^Sent 0:\d\d ago$/)).toBeVisible();
  await expect(steered.getByText("Claude reads steering at its next step")).toBeVisible();
  await expect(steered.getByRole("button", { name: "Steer now" })).toHaveCount(0);
  await expect(delivered(STEER)).toHaveCount(0);

  // Scrolled away from the tail, the message pins itself to the log's bottom edge.
  const pill = card.getByRole("button", { name: /^Steered \d:\d\d/ });
  await expect(pill).toHaveCount(0);
  expect(await log.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await log.evaluate((el) => { el.scrollTop = 0; });
  await expect(pill).toBeVisible();
  await expect(pill).toContainText(STEER);
  await expect(pill).toContainText("Jump to it");
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("steered-message-receipt");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await card.screenshot({ path: `${dir}pinned-while-scrolled.png` });
  }
  await pill.click();
  await expect(steered).toBeInViewport();
  await expect(pill).toHaveCount(0);
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.mouse.move(0, 0);
    await card.screenshot({ path: `${artifactsDir("steered-message-receipt")}waiting-to-be-read.png` });
  }

  // The agent reads it: the transcript turn replaces the row and says it was received.
  await expect(delivered(STEER)).toBeVisible({ timeout: 30000 });
  await expect(card.locator(".pending-turn").filter({ hasText: STEER })).toHaveCount(0);
  const receivedTurn = card.getByRole("article", { name: "you" }).filter({ hasText: STEER });
  await expect(receivedTurn.getByRole("status")).toHaveText("✓ received by claude");
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.mouse.move(0, 0);
    await card.screenshot({ path: `${artifactsDir("steered-message-receipt")}received.png` });
  }
  await expect(receivedTurn.getByRole("status")).toHaveCount(0, { timeout: 10000 });
  await expect(rail.locator(".rail-state")).toHaveText("working");
});
