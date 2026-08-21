import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("effort-chip-sdk");

/**
 * Photograph the chip this run has already asserted on.
 *
 * An accessible name cannot show what a reader actually navigates by - the pill, its glyph
 * and the caret that says it opens. Taken inside the regression rather than by a separate
 * scripted walk, so the picture and the measurement cannot drift apart. Behind the same flag
 * the other capturing specs use, so ordinary runs stay quiet.
 */
async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the very chip being photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

/**
 * The reasoning-effort chip on an Agent SDK Claude card.
 *
 * The regression it pins: those cards showed no effort at all. The daemon read Claude's
 * effort from ONE place - the `<local-command-stdout>` echo `/effort` writes into the
 * transcript - and an embedded session never types a slash command. Its level is a launch
 * option and a driver call, so nothing echoed, `meta.thinkingLevel` stayed null, and the
 * chip (which draws from the level it would be changing) rendered nothing. Model and
 * context% sat on the same row, read out of the same file, which is what made it read as a
 * missing chip rather than a missing session.
 *
 * Both halves are asserted here, because the fix is only worth having if the control still
 * works: the launched level is VISIBLE, and it is still SELECTABLE - a pick reaches the
 * driver, the driver's next turn records the new level, and the daemon reads it back.
 *
 * Only this layer can see that. The transcript unit tests prove the parse, the HTTP tests
 * prove the route, and neither of them can say whether a person looking at the card can
 * see what their session is running at.
 */

async function dispatchClaude(page: Page, daemon: DaemonHandle, effort: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the effort chip");
  // The launch level, chosen the way an operator chooses it. It reaches the CLI as
  // `--effort <level>`, which is the only thing that ever tells an embedded session what to
  // run at.
  await dialog
    .getByRole("combobox", { name: "Effort for dispatched Claude Code session" })
    .selectOption(effort);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

test("an Agent SDK Claude card shows the effort it launched at, and can change it", async ({
  dashboard,
  daemon,
}) => {
  await dispatchClaude(dashboard, daemon, "high");

  const card = dashboard.locator("article.card").first();
  await expect(card).toContainText("Agent SDK");

  // THE REGRESSION. `high` is what the dispatch asked for, and the card says so - off the
  // turn record the driver wrote, with no slash command anywhere in the conversation.
  const chip = card.getByRole("button", { name: /^Reasoning effort:/ });
  await expect(chip).toHaveAccessibleName(
    "Reasoning effort: high. Change effort for this session",
    { timeout: 30_000 },
  );
  await expect(chip).toContainText("high");
  await shoot(dashboard, card, "effort-chip-on-agent-sdk-card");

  // Still a control, not a label: the levels this model offers are all reachable, because
  // the driver applies one atomically rather than walking a TUI picker one step at a time.
  await chip.click();
  const menu = dashboard.getByRole("menu", { name: "Reasoning effort" });
  await expect(menu).toBeVisible();
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    // Each row's accessible name is its level followed by what picking it does, so anchor
    // to the start rather than matching the whole sentence.
    await expect(menu.getByRole("menuitemradio", { name: new RegExp(`^${level} `) })).toBeVisible();
  }
  await expect(menu.getByRole("menuitemradio", { name: /^high / })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await shoot(dashboard, menu, "effort-menu-open");

  await menu.getByRole("menuitemradio", { name: /^low / }).click();
  await expect(menu).toBeHidden();
  // Claude's driver applies a level to the conversation it is already running, so the card
  // reports it immediately - no "next turn" pending state, which is Codex's shape.
  await expect(chip).toHaveAccessibleName(
    "Reasoning effort: low. Change effort for this session",
    { timeout: 15_000 },
  );
  await expect(chip).not.toContainText("next turn");

  // And it really reached the process, rather than being a browser-local optimism the next
  // metadata read would wipe: the next turn's record carries `low`, and that record is what
  // the daemon reads the chip back off.
  await expect(card.getByRole("button", { name: "Expand conversation" })).toBeVisible();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill("run one more turn");
  await composer.press("Enter");
  await expect(card.getByText("Mock reply to: run one more turn", { exact: true })).toBeVisible({
    timeout: 40_000,
  });
  await expect(chip).toHaveAccessibleName(
    "Reasoning effort: low. Change effort for this session",
  );
});
