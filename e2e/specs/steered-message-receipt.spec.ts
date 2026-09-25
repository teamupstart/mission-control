import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// The held turn keeps Claude busy for the whole spec. The fake takes the deferred steer at
// once but reads it only when `readSteers` says so, so every check of the waiting state runs
// before the receipt exists however slow the run is.
test.use({ daemonEnv: { MC_E2E_CLAUDE_HELD_TURN_MS: "180000" } });

/** Let the fake agent read the steers it is holding (see `READ_STEERS_SIGNAL`). */
function readSteers(daemon: DaemonHandle): void {
  writeFileSync(join(daemon.recordDir, "e2e-read-steers"), "");
}

const STEER = "read this steer at your next step: skip e2e for now";

type Page = import("@playwright/test").Page;
type DaemonHandle = import("../fixtures/daemon.ts").DaemonHandle;

/**
 * A dispatched Claude session with enough history to scroll, held in a running turn, with
 * STEER steered into it and waiting to be read.
 */
async function steerIntoHeldTurn(dashboard: Page, daemon: DaemonHandle, intent: string) {
  await dashboard.getByRole("button", { name: "Dispatch", exact: true }).click();
  const modal = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await modal.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await modal.getByPlaceholder("What should this agent do?").fill(intent);
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
  return { card, log, rail, delivered };
}

test("a steered message stays in view until the agent reads it", async ({ dashboard, daemon }) => {
  test.setTimeout(120000);
  const { card, log, rail, delivered } = await steerIntoHeldTurn(dashboard, daemon, "show a steer until it is read");

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
  readSteers(daemon);
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

test("with the working row pinned, the steer's pill sits above it instead of on it", async ({ dashboard, daemon }) => {
  test.setTimeout(120000);
  // Display > Working indicator > Pin the working row holds that row on the same bottom edge.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const display = dashboard.locator('[data-anchor="display/board-card"]');
  await display.getByRole("checkbox", { name: "Pin the working row", exact: true }).check();
  await expect(display.getByRole("checkbox", { name: "Pin the working row", exact: true })).toBeChecked();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const { card, log } = await steerIntoHeldTurn(dashboard, daemon, "keep the pill clear of the working row");
  await expect(card.getByRole("status").filter({ hasText: "steered · waiting for claude to read it" })).toBeVisible();

  // The agent reports a step, which is what draws the working row.
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as
    { agent: string; agentSessionId: string | null; cwd: string; runtime: string }[];
  const target = sessions.find((s) => s.runtime === "sdk" && s.agentSessionId !== null)!;
  const res = await fetch(`${daemon.baseURL}/hooks/PreToolUse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim(),
    },
    body: JSON.stringify({
      agent: target.agent, sessionId: target.agentSessionId, cwd: target.cwd, env: {}, toolName: "Bash",
    }),
  });
  expect(res.status).toBe(204);
  const row = log.locator(".turn-progress");
  await expect(row).toHaveClass(/is-pinned/, { timeout: 15000 });

  await log.evaluate((el) => { el.scrollTop = 0; });
  const pill = card.getByRole("button", { name: /^Steered \d:\d\d/ });
  await expect(pill).toBeVisible();
  const pillBox = (await pill.boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  expect(pillBox.y + pillBox.height, "the pill ends above the pinned row").toBeLessThanOrEqual(rowBox.y + 1);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("steered-message-receipt");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await card.screenshot({ path: `${dir}pinned-above-working-row.png` });
  }
});

test("Jump to it brings the steer into view when queued turns below it fill the log", async ({ dashboard, daemon }) => {
  test.setTimeout(120000);
  const { card, log } = await steerIntoHeldTurn(dashboard, daemon, "jump to a steer above the queue");
  const steered = card.locator(".pending-turn").filter({ hasText: STEER });
  await expect(steered.getByRole("status")).toHaveText("steered · waiting for claude to read it");
  // Messages queued after the steer are drawn after it, so at the log's very bottom the steer
  // itself can be above the fold.
  const composer = card.getByPlaceholder(/^Reply to this session/);
  for (let i = 1; i <= 4; i++) {
    await composer.fill(`queued after the steer ${i}\n${"this one waits for the turn to end. ".repeat(6)}`);
    await composer.press("Enter");
    await expect(card.locator(".pending-turn").filter({ hasText: `queued after the steer ${i}` })).toHaveCount(1);
    await expect(composer).toHaveValue("");
  }
  await log.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(steered).not.toBeInViewport();
  const pill = card.getByRole("button", { name: /^Steered \d:\d\d/ });
  await expect(pill).toBeVisible();
  // Reached from the keyboard, it draws a ring of its own; its shadow is always there.
  await pill.focus();
  await expect(pill).toHaveCSS("outline-style", "solid");
  await expect(pill).toHaveCSS("outline-width", "2px");
  await pill.press("Enter");
  await expect(steered).toBeInViewport();
  await expect(pill).toHaveCount(0);
});
