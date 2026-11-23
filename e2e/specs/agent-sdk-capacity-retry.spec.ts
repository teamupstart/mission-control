import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

const EVIDENCE = artifactsDir("agent-sdk-capacity-retry");

async function sessions(daemon: DaemonHandle): Promise<Array<{ id: string; state: string; activity: string | null }>> {
  const response = await fetch(`${daemon.baseURL}/api/sessions`);
  if (!response.ok) throw new Error(`/api/sessions answered ${response.status}: ${await response.text()}`);
  return await response.json() as Array<{ id: string; state: string; activity: string | null }>;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("start the work");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

// Claude Code ends a turn with "Repeated 529 Overloaded errors" once its own retries are
// spent. That used to read as a finished turn: the card went idle and whatever waited on it
// received half-done work. The session now stays working, says when it will retry, and
// continues the work by itself once the backoff elapses.
test("an SDK session whose model is at capacity waits, then continues the work by itself", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  await rail.locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  const turn = (text: string | RegExp) => detail.locator(".turn").getByText(text);

  await expect(turn("Mock reply to: start the work")).toBeVisible();
  await expect.poll(async () => (await sessions(daemon))[0]?.state).toBe("idle");

  await reply.fill("E2E_CLAUDE_AT_CAPACITY");
  await reply.press("Enter");

  await expect(turn(/^API Error: Repeated 529 Overloaded errors/)).toBeVisible();
  const waiting = detail.getByText("Model at capacity - retrying in 15s (attempt 1 of 8)");
  await expect(waiting).toBeVisible();
  const [held] = await sessions(daemon);
  expect(held?.state, "a capacity failure is not a finished turn").toBe("working");

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await detail.screenshot({ path: join(EVIDENCE, "capacity-retry-waiting.png") });
    console.log("CAPTURED e2e/.artifacts/agent-sdk-capacity-retry/capacity-retry-waiting.png");
  }

  // The first backoff is 15 seconds; the continuation is answered by the fake like any turn.
  await expect(turn(/^Mock reply to: Your previous turn stopped because the model provider reported it was at capacity/))
    .toBeVisible({ timeout: 40_000 });
  await expect(waiting).toBeHidden();
  await expect.poll(async () => (await sessions(daemon))[0]?.state).toBe("idle");

  if (process.env.MC_E2E_EVIDENCE === "1") {
    await detail.screenshot({ path: join(EVIDENCE, "capacity-retry-continued.png") });
    console.log("CAPTURED e2e/.artifacts/agent-sdk-capacity-retry/capacity-retry-continued.png");
  }
});
