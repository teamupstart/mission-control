import { mkdirSync } from "node:fs";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// The fake stays busy long enough to prove that steering reaches it before completion.
test.use({ daemonEnv: { MC_E2E_CODEX_HELD_TURN_MS: "180000", MC_E2E_CLAUDE_HELD_TURN_MS: "180000" } });

async function openSession(dashboard: import("@playwright/test").Page, daemon: import("../fixtures/daemon.ts").DaemonHandle, agent = "codex") {
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const modal = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await modal.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await modal.getByPlaceholder("What should this agent do?").fill("exercise the message delivery policy");
  await modal.locator("select").filter({ hasText: "Claude Code" }).selectOption(agent);
  await modal.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await modal.getByRole("button", { name: "Dispatch now" }).click();
  await expect(modal).toBeHidden();
  const rail = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first();
  await expect(rail.locator(".rail-state")).toHaveText("idle", { timeout: 20000 });
  await rail.click();
  const card = dashboard.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await composer.fill("hold the current turn open");
  await composer.press("Enter");
  await expect(card.locator(".turn-user:not(.pending-turn)").getByText("hold the current turn open", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");
  return { card, composer, rail };
}

for (const agent of ["claude", "codex"]) {
test(`${agent}: the send box offers no delivery choice, and interrupt-and-deliver preserves other queued messages`, async ({ dashboard, daemon }) => {
  const { card, composer, rail } = await openSession(dashboard, daemon, agent);
  // There is nothing to pick before sending. Every message carries the same policy, so a
  // selector here would only be a way to get it wrong.
  await expect(card.getByRole("combobox", { name: "Message delivery" })).toHaveCount(0);
  await expect(card.getByText("Delivery", { exact: true })).toHaveCount(0);

  await composer.fill("leave this for after the turn");
  await composer.press("Enter");
  const later = card.locator(".pending-turn").filter({ hasText: "leave this for after the turn" });
  await expect(later).toBeVisible();
  await expect(composer).toHaveValue("");

  // The queued row still carries both explicit actions, which is where an operator who does
  // not want to wait out the clock reaches instead.
  await composer.fill("a correction during active work");
  await composer.press("Enter");
  const correction = card.locator(".pending-turn").filter({ hasText: "a correction during active work" });
  await correction.getByRole("button", { name: "Steer now", exact: true }).click();
  await expect(card.locator(".turn-user:not(.pending-turn)").getByText("a correction during active work", { exact: true })).toBeVisible();
  await expect(rail.locator(".rail-state")).toHaveText("working");
  await expect(later).toBeVisible();

  await composer.fill("hold the current turn open");
  await composer.press("Enter");
  const replacement = card.locator(".pending-turn").filter({ hasText: "hold the current turn open" });
  await replacement.getByRole("button", { name: "Interrupt and deliver", exact: true }).click();
  await expect(replacement).toHaveCount(0);
  await expect(later).toBeVisible();
  await expect(rail.locator(".rail-state")).toHaveText("working");
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("message-delivery-policy");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${dir}${agent}-steered-and-preserved.png` });
  }
});
}

test("a message nobody touched shows its wait and steers into the running turn after one minute", async ({ dashboard, daemon }) => {
  // The message's own minute is only part of this: a cold dispatch, a settling session and a
  // held turn all precede it, and this spec cannot start the clock until they are done.
  test.setTimeout(180000);
  const { card, composer, rail } = await openSession(dashboard, daemon);
  await composer.fill("send automatically after the deadline");
  await composer.press("Enter");
  const pending = card.locator(".pending-turn").filter({ hasText: "send automatically after the deadline" });
  await expect(pending).toBeVisible();
  await expect(pending.getByText(/Waiting \d+s · Steering it into this turn/)).toBeVisible({ timeout: 40000 });
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("message-delivery-policy");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${dir}timed-wait.png` });
  }
  await expect(card.locator(".turn-user:not(.pending-turn)").getByText("send automatically after the deadline", { exact: true })).toBeVisible({ timeout: 60000 });
  await expect(pending).toHaveCount(0);
  await expect(rail.locator(".rail-state")).toHaveText("working");
});
