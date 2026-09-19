import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { settled } from "../fixtures/settle.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A failed Codex turn reaches the conversation: rollout file to daemon to SSE to DOM. The
 * unit tests assert the parse; only this layer asserts the delivery.
 *
 * No model tokens: `MISSION_CODEX_BIN` points at `fake-codex.mjs`.
 */

/** The fake's prompt whose turn ends in a provider rejection instead of a reply. */
const FAILING_TURN = "E2E_CODEX_TURN_FAILS";

/** Asserted in full: a substring match would also pass against a rendered raw JSON envelope. */
const FAILURE_SENTENCE =
  "The 'gpt-6-e2e' model requires a newer version of Codex. Please upgrade and try again.";

const EVIDENCE = artifactsDir("codex-failed-turn-conversation");

/** Screenshot behind `MC_E2E_EVIDENCE`, taken inside the passing run and written outside the repo. */
async function shoot(page: Page, card: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it lands
  // on top of the surface being photographed.
  await page.mouse.move(0, 0);
  await card.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/codex-failed-turn-conversation/${name}.png`);
}

async function dispatchCodex(page: Page, daemon: DaemonHandle, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption("codex");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

test("a Codex turn that failed shows the reason instead of nothing", async ({
  dashboard,
  daemon,
}) => {
  // Not asserted below: the task becomes the card heading and would make matchers ambiguous.
  const goal = "exercise a turn that the provider rejects";
  await dispatchCodex(dashboard, daemon, goal);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const card = dashboard.locator(".console-detail");
  await settled(card);
  const log = card.locator(".transcript-log");
  await expect(log).toBeVisible();

  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();

  // A normal answer first, so the silence below is a failure and not a dead session.
  await expect(log.getByText(`Mock reply to: ${goal}`)).toBeVisible();

  // A healthy turn must carry no marker; anchors the count below.
  await expect(log.getByText("[Codex error]")).toHaveCount(0);

  await reply.fill(FAILING_TURN);
  await reply.press("Enter");

  await expect(log.getByText(FAILURE_SENTENCE)).toBeVisible();

  // Drawn as a synthesized marker, not as agent prose.
  await expect(log.getByText(`[Codex error] ${FAILURE_SENTENCE}`)).toBeVisible();

  // The rollout is re-read each poll; an unstable id would duplicate rather than de-dupe.
  await expect(log.getByText("[Codex error]")).toHaveCount(1);

  await shoot(dashboard, card, "failed-turn-explains-itself");
});
