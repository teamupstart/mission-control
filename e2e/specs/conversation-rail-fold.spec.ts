import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Folding the Conversation's Activity / Yours rail to its edge strip, in both renderings.
 * No model is spent: `MISSION_CLAUDE_BIN` points at the fake throughout.
 */

const TOOL_TURN = "E2E_OBSERVED_TOOLS";

const EVIDENCE = artifactsDir("conversation-rail-fold");

async function shoot(page: Page, card: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await card.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/conversation-rail-fold/${name}.png`);
}

async function putUiConfig(daemon: DaemonHandle, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { config: Record<string, unknown> }).config;
}

async function storedFold(daemon: DaemonHandle): Promise<unknown> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`);
  return ((await response.json()) as { config: { conversationRailCollapsed?: unknown } }).config
    .conversationRailCollapsed;
}

/** Dispatch, open the conversation, and leave deterministic tool activity in it. */
async function openConversation(page: Page, daemon: DaemonHandle, composerPlaceholder: RegExp): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the conversation sideband");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = page.locator(".console-detail");
  const reply = card.getByPlaceholder(composerPlaceholder);
  await expect(reply).toBeEnabled();
  await reply.fill(TOOL_TURN);
  await reply.press("Enter");
  await expect(card.getByText(`Mock reply to: ${TOOL_TURN}`).first()).toBeVisible();
  await expect(card.getByRole("region", { name: "Conversation rail" }).getByText("bash", { exact: true })).toBeVisible();
  return card;
}

async function width(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  expect(box, "the element is laid out").not.toBeNull();
  return box!.width;
}

test("the chat rail folds to an edge strip, remembers it, and reopens from the strip", async ({
  dashboard,
  daemon,
}) => {
  const card = await openConversation(dashboard, daemon, /^Reply to this session/);
  const rail = card.getByRole("region", { name: "Conversation rail" });
  const log = card.locator(".transcript-log");
  const collapse = rail.getByRole("button", { name: "Collapse conversation rail" });
  const strip = rail.getByRole("button", { name: "Expand conversation rail" });

  await expect(rail.getByRole("tab", { name: "Activity" })).toBeVisible();
  await expect(collapse).toBeVisible();
  await expect(strip).toBeHidden();
  const openRail = await width(rail);
  const openLog = await width(log);
  expect(openRail).toBeGreaterThan(200);
  await shoot(dashboard, card, "01-chat-open");

  await collapse.click();
  await expect(strip).toBeVisible();
  await expect(strip).toBeFocused();
  await expect(strip).toContainText("Activity");
  await expect(strip).toContainText(/\d+/);
  await expect(rail.getByRole("tab", { name: "Activity" })).toBeHidden();
  await expect(rail.getByText("bash", { exact: true })).toBeHidden();
  expect(await width(rail)).toBeLessThanOrEqual(32);
  expect(await width(log)).toBeGreaterThan(openLog + 150);
  await expect.poll(() => storedFold(daemon)).toBe(true);
  await shoot(dashboard, card, "02-chat-folded");

  // The reload drops the selection, so the session has to be opened again.
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const reloaded = dashboard.locator(".console-detail").getByRole("region", { name: "Conversation rail" });
  await expect(reloaded.getByRole("button", { name: "Expand conversation rail" })).toBeVisible();
  await expect(reloaded.getByRole("tab", { name: "Activity" })).toBeHidden();

  await dashboard.locator(".console-detail .detail-body").focus();
  await dashboard.keyboard.press("Meta+f");
  await expect(dashboard.getByRole("complementary", { name: "Search results" })).toBeVisible();
  await expect(dashboard.getByRole("region", { name: "Conversation rail" })).toHaveCount(0);
  await dashboard.keyboard.press("Escape");
  const strip2 = reloaded.getByRole("button", { name: "Expand conversation rail" });
  await expect(strip2).toBeVisible();

  await strip2.click();
  const collapse2 = reloaded.getByRole("button", { name: "Collapse conversation rail" });
  await expect(collapse2).toBeVisible();
  await expect(collapse2).toBeFocused();
  await expect(reloaded.getByText("bash", { exact: true })).toBeVisible();
  expect(await width(reloaded)).toBeGreaterThan(200);
  await expect.poll(() => storedFold(daemon)).toBe(false);
});

test("the strip names the Yours tab when Yours is the one that was up", async ({ dashboard, daemon }) => {
  const card = await openConversation(dashboard, daemon, /^Reply to this session/);
  const rail = card.getByRole("region", { name: "Conversation rail" });
  await rail.getByRole("tab", { name: "Yours" }).click();
  await rail.getByRole("button", { name: "Collapse conversation rail" }).click();
  const strip = rail.getByRole("button", { name: "Expand conversation rail" });
  await expect(strip).toContainText("Yours");
  await strip.click();
  await expect(rail.getByRole("tab", { name: "Yours" })).toHaveAttribute("aria-selected", "true");
});

test("the terminal rail folds too, and its key legend gives up the rail's column", async ({
  dashboard,
  daemon,
}) => {
  const config = await putUiConfig(daemon, { conversationView: "terminal" });
  expect(config.conversationView).toBe("terminal");
  await dashboard.reload();

  const card = await openConversation(dashboard, daemon, /^Send the next instruction/);
  await expect(card.getByRole("region", { name: "Conversation terminal" })).toBeVisible();
  const rail = card.getByRole("region", { name: "Conversation rail" });
  const legend = card.getByText(/^enter sends/);
  const composer = card.getByPlaceholder(/^Send the next instruction/);

  await expect(legend).toBeVisible();
  const openRail = await width(rail);
  expect(Math.abs((await width(legend)) - openRail)).toBeLessThanOrEqual(2);
  const openComposer = await width(composer);
  await shoot(dashboard, card, "03-terminal-open");

  await rail.getByRole("button", { name: "Collapse conversation rail" }).click();
  await expect(rail.getByRole("button", { name: "Expand conversation rail" })).toBeVisible();
  expect(await width(rail)).toBeLessThanOrEqual(32);
  await expect(legend).toBeVisible();
  const box = (await composer.boundingBox())!;
  const legendBox = (await legend.boundingBox())!;
  expect(legendBox.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
  expect(await width(composer)).toBeGreaterThan(openComposer + 150);
  await shoot(dashboard, card, "04-terminal-folded");
});

test("a narrow conversation ignores the fold and keeps its one-row disclosure", async ({
  dashboard,
  daemon,
}) => {
  const card = await openConversation(dashboard, daemon, /^Reply to this session/);
  const rail = card.getByRole("region", { name: "Conversation rail" });
  await rail.getByRole("button", { name: "Collapse conversation rail" }).click();
  await expect.poll(() => storedFold(daemon)).toBe(true);

  await dashboard.setViewportSize({ width: 600, height: 900 });

  await expect(rail.getByRole("button", { name: "Expand conversation rail" })).toBeHidden();
  await expect(rail.getByRole("button", { name: "Collapse conversation rail" })).toBeHidden();
  const toggle = rail.getByRole("button", { name: /Observed activity/ });
  await expect(toggle).toBeVisible();
  await expect(rail.getByRole("tab", { name: "Activity" })).toBeVisible();
  await toggle.click();
  await expect(rail.getByText("bash", { exact: true })).toBeVisible();
});

test("a rail folded wide and then narrowed keeps a running agent's elapsed time counting on the Agents tab", async ({
  dashboard,
  daemon,
}) => {
  // Chip and popover gives the rail its Agents tab. A dispatched fake Claude launches three
  // background agents and ends its turn with two still running.
  await putUiConfig(daemon, { backgroundAgentsStyle: "chip" });
  await dashboard.reload();
  const goal = "E2E_BACKGROUND_AGENTS keep two running for the folded rail";
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  const row = dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").filter({ hasText: goal });
  await expect(row.locator(".rail-state")).toHaveText("idle", { timeout: 60_000 });
  await row.click();
  const card = dashboard.locator(".console-detail");
  const rail = card.getByRole("region", { name: "Conversation rail" });
  const agentsTab = rail.getByRole("tab", { name: /^Agents/ });
  await expect(agentsTab).toBeVisible();

  // Fold the rail while the window is wide, the way an operator who wanted the room would.
  await rail.getByRole("button", { name: "Collapse conversation rail" }).click();
  await expect.poll(() => storedFold(daemon)).toBe(true);
  await expect(rail.getByRole("button", { name: "Expand conversation rail" })).toBeVisible();

  // Narrow the window: the narrow layout ignores the fold, and the tabs come back in its head.
  await dashboard.setViewportSize({ width: 600, height: 900 });
  await expect(rail.getByRole("button", { name: "Expand conversation rail" })).toBeHidden();
  await agentsTab.click();
  await expect(agentsTab).toHaveAttribute("aria-selected", "true");

  // A running agent's detail line is on screen, and its elapsed time advances while you watch.
  const running = rail.getByRole("listitem").filter({ hasText: "Map every offset-pagination call site" });
  const detail = running.locator(".agents-detail");
  await expect(detail).toBeVisible();
  await expect(running).toHaveClass(/is-running/);
  // Only the elapsed part is compared: the tool and token figures arrive with the agent's own
  // progress frames and may land between the two readings.
  const elapsed = async (): Promise<string> => /^(?:\d+m )?\d+s/.exec((await detail.textContent()) ?? "")?.[0] ?? "";
  await expect.poll(elapsed, { message: "the row reads an elapsed time" }).toMatch(/^(\d+m )?\d+s$/);
  const first = await elapsed();
  await expect.poll(elapsed, {
    timeout: 5_000,
    message: "the running agent's elapsed time advanced on the folded-then-narrowed rail",
  }).not.toBe(first);
  await shoot(dashboard, card, "agents-tab-folded-then-narrowed");
});
