import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Claude's advisor, made visible. An operator who set `advisorModel` in their Claude Code
 * settings gets sessions that consult a stronger model at key moments, and before this the
 * dashboard dropped every advisor block and gave no sign one was active.
 *
 * Driven end to end: the fake Claude writes three advisor calls into its real transcript, in
 * the record shape captured from a real Claude Code turn (see `ADVISOR_TURN` in
 * `fake-claude.mjs`), the daemon parses that file, and the browser draws it. Asserted in both
 * conversation renderings, because each draws a turn through its own component, and on the
 * header chip the transcript's `advisorModel` feeds.
 *
 * No model tokens: `MISSION_CLAUDE_BIN` points at the fake throughout.
 */

const ADVISOR_TURN = "E2E_ADVISOR_CALLS";
const ADVISOR_TEXT = "E2E advisor guidance: check the empty input before the loop.";
const REVIEWED = "Advisor (Opus 5.5) reviewed the conversation";
const UNAVAILABLE = "Advisor unavailable (overloaded)";

const EVIDENCE = artifactsDir("advisor-visibility");

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/advisor-visibility/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row").filter({ hasText: goal });
  await expect(row.locator(".rail-state")).toHaveText("idle");
}

/** Set the dashboard's default rendering through the daemon, as the store hydrates from it. */
async function useRendering(page: Page, daemon: DaemonHandle, view: "chat" | "terminal"): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationView: view }),
  });
  const body = (await response.json()) as { config?: { conversationView?: string } };
  expect(body.config?.conversationView, "the daemon accepted the rendering").toBe(view);
  await page.reload();
}

test("advisor calls show in the conversation and the header names the advisor model", async ({
  dashboard,
  daemon,
}) => {
  // Wide enough that the console header's ladder keeps every runtime pill.
  await dashboard.setViewportSize({ width: 1920, height: 1080 });
  await dispatch(dashboard, daemon, "exercise the advisor visibility");
  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  await rail.locator("button.rail-row").first().click();

  const card = dashboard.locator(".console-detail");
  await settled(card);
  // Before any advisor-enabled turn, the session claims no advisor.
  await expect(card.getByRole("group", { name: "Advisor model" })).toHaveCount(0);

  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill(ADVISOR_TURN);
  await reply.press("Enter");
  // The echoed reply is written after the advisor records, so its arrival means they are in.
  await expect(card.getByText(`Mock reply to: ${ADVISOR_TURN}`)).toBeVisible();

  // Chat rendering. The advised call and the redacted one both read as a review; only the
  // advised one has words to disclose. The call markers draw nothing of their own.
  const log = card.locator(".transcript-log");
  await expect(log.getByText(REVIEWED)).toHaveCount(2);
  const advice = log.getByText(ADVISOR_TEXT);
  await expect(advice).toBeHidden();
  await log.getByText(REVIEWED).first().click();
  await expect(advice).toBeVisible();
  await expect(log.getByText(UNAVAILABLE)).toBeVisible();
  await expect(log.getByText("advisor", { exact: true })).toHaveCount(0);

  // The header chip: read off the transcript's `advisorModel`, named for a screen reader,
  // and a readout rather than a control.
  const chip = card.getByRole("group", { name: "Advisor model" });
  await expect(chip).toHaveText("Advisor: Opus 5.5", { timeout: 30_000 });
  await expect(chip.getByRole("button")).toHaveCount(0);
  await shoot(dashboard, card, "01-chat-advisor-rows-and-chip");

  // Terminal rendering draws the same calls through `TerminalTurn`.
  await useRendering(dashboard, daemon, "terminal");
  await rail.getByRole("button", { name: /Exercise the Advisor Visibility/i }).click();
  const terminal = dashboard.locator(".detail-conv").getByRole("region", { name: "Conversation terminal" });
  await expect(terminal).toBeVisible();
  await expect(terminal.getByText(REVIEWED)).toHaveCount(2);
  await expect(terminal.getByText(ADVISOR_TEXT)).toBeHidden();
  await terminal.getByText(REVIEWED).first().click();
  await expect(terminal.getByText(ADVISOR_TEXT)).toBeVisible();
  await expect(terminal.getByText(UNAVAILABLE)).toBeVisible();
  await expect(dashboard.locator(".console-detail").getByRole("group", { name: "Advisor model" }))
    .toHaveText("Advisor: Opus 5.5");
  await shoot(dashboard, dashboard.locator(".console-detail"), "02-terminal-advisor-rows");
});
