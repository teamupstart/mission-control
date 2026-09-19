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
  await modal.getByPlaceholder("What should this agent do?").fill("exercise message delivery choices");
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
test(`${agent}: steer now reaches the active turn and interrupt-and-deliver preserves other queued messages`, async ({ dashboard, daemon }) => {
  const { card, composer, rail } = await openSession(dashboard, daemon, agent);
  await expect(card.getByLabel("Message delivery")).toHaveValue("after-turn");
  await composer.fill("leave this for after the turn");
  await composer.press("Enter");
  const later = card.locator(".pending-turn").filter({ hasText: "leave this for after the turn" });
  await expect(later).toBeVisible();
  await expect(composer).toHaveValue("");
  await card.getByLabel("Message delivery").selectOption("steer");
  await composer.fill("a correction during active work");
  await composer.press("Enter");
  await expect(card.locator(".turn-user:not(.pending-turn)").getByText("a correction during active work", { exact: true })).toBeVisible();
  await expect(rail.locator(".rail-state")).toHaveText("working");
  await expect(later).toBeVisible();
  await expect(composer).toHaveValue("");

  await card.getByLabel("Message delivery").selectOption("after-turn");
  await composer.fill("hold the current turn open");
  await composer.press("Enter");
  const replacement = card.locator(".pending-turn").filter({ hasText: "hold the current turn open" });
  await replacement.getByRole("button", { name: "Interrupt and deliver", exact: true }).click();
  await expect(replacement).toHaveCount(0);
  await expect(later).toBeVisible();
  await expect(rail.locator(".rail-state")).toHaveText("working");
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("message-delivery-modes");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${dir}${agent}-steered-and-preserved.png` });
  }
});
}

test("timed steering shows its age and reaches a busy agent after one minute", async ({ dashboard, daemon }) => {
  test.setTimeout(110000);
  const { card, composer, rail } = await openSession(dashboard, daemon);
  await card.getByLabel("Message delivery").selectOption("steer-after-wait");
  await composer.fill("send automatically after the deadline");
  await composer.press("Enter");
  const pending = card.locator(".pending-turn").filter({ hasText: "send automatically after the deadline" });
  await expect(pending).toBeVisible();
  await expect(pending.getByText(/Waiting \d+s/)).toBeVisible({ timeout: 40000 });
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("message-delivery-modes");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: `${dir}timed-wait.png` });
  }
  await expect(card.locator(".turn-user:not(.pending-turn)").getByText("send automatically after the deadline", { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(pending).toHaveCount(0);
  await expect(rail.locator(".rail-state")).toHaveText("working");
});

test("an explicitly selected two-minute interruption delivers without losing next-turn messages", async ({ dashboard, daemon }) => {
  test.setTimeout(160000);
  const { card, composer, rail } = await openSession(dashboard, daemon);
  await composer.fill("keep this queued for later");
  await composer.press("Enter");
  const later = card.locator(".pending-turn").filter({ hasText: "keep this queued for later" });
  await expect(later).toBeVisible();
  await expect(composer).toHaveValue("");
  await card.getByLabel("Message delivery").selectOption("interrupt-after-wait");
  await expect(card.getByText("May stop a running tool. Other messages are kept.")).toBeVisible();
  await composer.fill("hold the current turn open");
  await composer.press("Enter");
  const replacement = card.locator(".pending-turn").filter({ hasText: "hold the current turn open" });
  await expect(replacement).toBeVisible();
  await expect(replacement).toHaveCount(0, { timeout: 135000 });
  await expect(later).toBeVisible();
  await expect(rail.locator(".rail-state")).toHaveText("working");
});
