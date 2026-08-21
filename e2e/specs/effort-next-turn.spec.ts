import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("effort-next-turn");

/**
 * Photograph the chip this run has already asserted on.
 *
 * The assertions here are accessible names, and an accessible name cannot show the
 * difference a reader actually navigates by: a dashed border, a struck-through old level and
 * a small tag. Taken inside the regression rather than by a separate scripted walk, so the
 * picture and the measurement cannot drift apart.
 */
/**
 * Narrate one milestone into the run's own output.
 *
 * The retained transcript is otherwise a single pass line, which proves the spec ran and
 * says nothing about WHAT it watched. These lines are emitted by the run itself as each
 * assertion lands, so the transcript is a record of the flow rather than a summary someone
 * typed afterwards. Behind the same flag as the frames, so ordinary runs stay quiet.
 */
function note(message: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`    · ${message}`);
}

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the very chip being photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
}

/**
 * The reasoning-effort chip on a Codex session whose driver cannot apply a level now.
 *
 * Codex puts `effort` on `turn/start`. `turn/steer` has no such field, so a level chosen
 * while a turn is running cannot reach that turn - it rides the next one, and until then the
 * rollout goes on appending records that name the OLD level, correctly, because that is what
 * the conversation is running.
 *
 * Both halves of that used to be invisible. The daemon refused to write the selection onto
 * the card (right - it had not happened) and published nothing else (wrong - the control then
 * looked like a no-op), while the browser held a local optimistic value that any newer
 * `SessionMeta.updatedAt` cleared. A running turn refreshes that timestamp on every usage
 * record, so the chip flipped back to the old level within one poll and stayed there.
 *
 * Only this layer can see the whole of it: a click reaches the route, the route reaches the
 * driver, the driver's next `turn/start` reaches a rollout record on disk, the daemon reads
 * that record back, and the chip settles. No other test in the repository crosses all five.
 */
const HELD_TURN = "hold the current turn open";
const NEXT_TURN = "start a fresh turn so the new effort can ride it";

test.use({
  daemonEnv: {
    // Turns this fake Codex into one that records what real Codex records: a `turn_context`
    // per turn (model, effort, and the ISO timestamp the daemon orders reads by) and
    // `token_count` events while a turn runs. `medium` is what its first turn starts on.
    MC_E2E_CODEX_EFFORT: "medium",
    // Long enough to choose a level mid-turn and then WATCH several rollout refreshes go by
    // without losing it. The shipped five seconds cannot show that.
    MC_E2E_CODEX_HELD_TURN_MS: "14000",
    // The refreshes are the subject here, so read them at speed rather than spending the
    // production four seconds of wall clock per observation.
    MISSION_RUNTIME_META_POLL_MS: "400",
  },
});

async function dispatchCodex(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the live effort chip");
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption("codex");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  // The opener is a real first turn; it is the one that writes the first `turn_context`, so
  // the chip has nothing to read until it is over.
  await expect(
    page
      .getByRole("navigation", { name: "Sessions" })
      .locator("button.rail-row")
      .first()
      .locator(".rail-state"),
  ).toHaveText("idle", {
    timeout: 30_000,
  });
}

/** How much of the context window the daemon has read back, or null before its first read. */
async function contextPct(daemon: DaemonHandle): Promise<number | null> {
  const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
    runtime: string;
    meta: { contextPct: number | null } | null;
  }>;
  return all.find((s) => s.runtime === "sdk")?.meta?.contextPct ?? null;
}

test("a Codex effort chosen mid-turn reads as pending and settles on the next turn", async ({
  dashboard,
  daemon,
}) => {
  await dispatchCodex(dashboard, daemon);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  await expect(card).toBeVisible();

  // What the conversation is actually running, read off the rollout the fake wrote.
  const chip = card.getByRole("button", { name: /^Reasoning effort:/ });
  await expect(chip).toHaveAccessibleName("Reasoning effort: medium. Change effort for this session", {
    timeout: 30_000,
  });
  note("live effort read off the rollout: medium, no pending state");

  // A genuinely busy driver. From here until it finishes, every level the operator picks is
  // a statement about a turn that has not started.
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(HELD_TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  note("a turn is now running - any level chosen from here cannot reach it");

  await chip.click();
  const menu = dashboard.getByRole("menu", { name: "Reasoning effort" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "high" }).click();
  await expect(menu).toBeHidden();

  // The chip says BOTH levels and which is which, rather than claiming the running turn
  // moved or silently showing the old level as though the click did nothing.
  await expect(chip).toHaveAccessibleName(
    "Reasoning effort: medium on this turn, high from the next turn. Change effort for this session",
    { timeout: 15_000 },
  );
  await expect(chip).toContainText("next turn");
  await expect(chip).toContainText("high");
  note("chose high mid-turn; chip reads 'medium -> high  NEXT TURN'");

  // The menu carries the sentence the chip has no room for, and gives the two levels
  // different sub-labels - one set for the next turn, one running on this one.
  await chip.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByText("applies from the next turn").first()).toBeVisible();
  await expect(menu.getByText("Running on this turn")).toBeVisible();
  note("menu names both levels: high set for the next turn, medium running on this one");
  await shoot(dashboard, menu, "effort-pending-menu");
  // Closed by the chip rather than by Escape: Escape is a fleet-wide binding and would
  // collapse the conversation this test is still reading out of.
  await chip.click();
  await expect(menu).toBeHidden();

  // THE REGRESSION, met head on. The active turn keeps appending usage records, so the
  // daemon keeps reading fresher metadata - all of it describing a turn still running
  // `medium`. Three distinct reads is enough to prove it is not a single lucky poll.
  const seen = new Set<number>();
  const first = await contextPct(daemon);
  if (first !== null) seen.add(first);
  await expect
    .poll(
      async () => {
        const pct = await contextPct(daemon);
        if (pct !== null) seen.add(pct);
        return seen.size;
      },
      { message: "the running turn should refresh the card's metadata", timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(3);
  note(`active turn refreshed the card's metadata ${seen.size} times (context ${[...seen].join("%, ")}%)`);
  await expect(chip).toHaveAccessibleName(
    "Reasoning effort: medium on this turn, high from the next turn. Change effort for this session",
  );
  note("pending state survived every one of those refreshes - THE REGRESSION");
  await shoot(dashboard, chip, "effort-pending-mid-turn");

  // The turn ENDS, and that alone still settles nothing: no new turn has started, so Codex
  // has written no record that could confirm or contradict the promise.
  await expect(card.getByText(`Mock reply to: ${HELD_TURN}`, { exact: true })).toBeVisible({
    timeout: 40_000,
  });
  await expect(chip).toHaveAccessibleName(
    "Reasoning effort: medium on this turn, high from the next turn. Change effort for this session",
  );
  note("held turn finished; still pending, because no NEW turn has started yet");

  // The next turn starts. It carries `effort: high`, Codex writes the `turn_context` saying
  // so, and the daemon reads it back - which is the only evidence that ever existed.
  await composer.fill(NEXT_TURN);
  await composer.press("Enter");
  await expect(chip).toHaveAccessibleName("Reasoning effort: high. Change effort for this session", {
    timeout: 30_000,
  });
  await expect(chip).not.toContainText("next turn");
  note("next turn started and wrote its turn_context: chip settled to plain 'high'");
  await shoot(dashboard, chip, "effort-settled-next-turn");
});
