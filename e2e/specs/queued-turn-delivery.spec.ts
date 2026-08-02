import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const HELD_TURN = "hold the current turn open";
const QUEUED_TURN = "deliver this queued turn when the agent goes idle";

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/queued-turn-delivery/", import.meta.url));

/**
 * Photograph the surface this spec is already asserting on.
 *
 * Behind `MC_E2E_EVIDENCE` rather than unconditional, for the reason the session-action
 * captures give: a card carries a fresh worktree uuid and a relative clock, so every ordinary
 * run would rewrite the binaries for no added signal. Inside the regression test rather than
 * in a staged capture spec of its own, because the point of the picture is that the assertions
 * beneath it passed on the same run - a screenshot produced by a separate scripted walk proves
 * the walk, not the fix.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it lands
  // on top of the row being photographed.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function dispatch(page: Page, daemon: DaemonHandle, agent: "claude" | "codex"): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(`exercise queued turn delivery on ${agent}`);
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption(agent);
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
 *
 * Run against BOTH embedded harnesses, because the claim the fix rests on is that the outbox
 * never branches on the agent - it reacts to registry state every driver reports through the
 * same path. A pair of runs is how that stops being a code-reading argument: Claude's driver
 * accepts a turn into its own queue, Codex's would turn one into a `turn/steer`, and the row
 * has to survive the idle transition on each.
 */
for (const agent of ["codex", "claude"] as const) {
test(`a queued conversation turn is delivered once the ${agent} agent goes idle`, async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, agent);

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
  // The state the bug left behind for ever. Captured while the driver is still working, which
  // is the only moment it is legitimate.
  await shoot(dashboard, `${agent}-queued-while-working`);

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
  await shoot(dashboard, `${agent}-delivered-and-answered`);
});
}
