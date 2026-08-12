import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const HELD_TURN = "hold the current turn open";
const FINAL_ANSWER_HELD_TURN = "hold the current turn open and finish with only a final answer";
const QUEUED_TURN = "deliver this queued turn when the agent goes idle";
const MID_TURN_INJECTION = "a repair round that arrived while the agent was working";

const EVIDENCE = artifactsDir("queued-turn-delivery");

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
  ).toBeVisible({ timeout: 30_000 });

  // The queued row leaves the outbox as a real turn, and the agent answers it.
  await expect(card.locator(".pending-turn")).toHaveCount(0, { timeout: 30_000 });
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(QUEUED_TURN, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    card.getByText(`Mock reply to: ${QUEUED_TURN}`, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await shoot(dashboard, `${agent}-delivered-and-answered`);
});

/**
 * The same delivery, after the driver has taken a message mid-turn - which is where it broke.
 *
 * A workflow repair round, a Foreman recommendation and a work-queue instruction all reach a
 * live session through the direct acknowledged path rather than the outbox, so they are the
 * one thing that hands a driver a message while a turn is already running. Both harnesses
 * fold that message into the running turn and end the whole thing with a single completion.
 *
 * Claude's driver used to report that as `queued` and reserve a second completion for it, so
 * the one that arrived retired the wrong reservation and left one outstanding for ever. From
 * that moment the session was permanently busy as far as delivery was concerned: the card
 * still went idle, because a Stop hook says so independently, and every message a human typed
 * was released from the outbox with "The agent became busy before delivery" against a session
 * that had been sitting idle for hours. Nothing recovered it short of restarting the daemon.
 *
 * Only a browser can see that whole shape, because the failure is the ABSENCE of a later
 * delivery: every layer beneath this one reports a successful send and an idle card.
 */
test(`a queued turn still lands after the ${agent} driver takes a mid-turn message`, async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, agent);

  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();

  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();

  await composer.fill(HELD_TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true }),
  ).toBeVisible();

  // Mid-turn, on the path a workflow repair round uses. Not the composer: the outbox exists
  // precisely so a human message never becomes one of these, so the composer cannot reach the
  // state under test at all.
  const sessions = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
    id: string;
    runtime: string;
  }>;
  const sdk = sessions.find((s) => s.runtime === "sdk");
  expect(sdk, "the dispatch produced an embedded session").toBeTruthy();
  const injected = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(sdk!.id)}/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: MID_TURN_INJECTION, buffer: false, origin: "workflow" }),
  });
  expect(injected.ok, "the driver accepted a message while a turn was running").toBe(true);

  // Now the human types, meets a busy driver, and lands in the durable outbox.
  await composer.fill(QUEUED_TURN);
  await composer.press("Enter");
  await expect(card.getByRole("status").filter({ hasText: /^queued$/ })).toBeVisible();
  // The state the operator was stranded in: a queued message behind a turn that has already
  // absorbed one. Captured while the driver is still working, the only moment it is correct.
  await shoot(dashboard, `${agent}-mid-turn-queued`);

  // The held turn ends, answering both the prompt it started on and the one it absorbed.
  // Scoped to the transcript rather than the card, because the card's activity ticker
  // renders the same sentence while a turn is running and would satisfy a looser locator
  // for the wrong reason.
  const replies = card.locator(".turn-assistant");
  await expect(
    replies.getByText(`Mock reply to: ${HELD_TURN}`, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    replies.getByText(`Mock reply to: ${MID_TURN_INJECTION}`, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  // And the session is genuinely available again, which is the assertion the bug failed.
  await expect(card.locator(".pending-turn")).toHaveCount(0, { timeout: 30_000 });
  await expect(
    replies.getByText(`Mock reply to: ${QUEUED_TURN}`, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  // The recovery, and the frame worth looking at: the outbox is empty, the queued message is
  // an ordinary turn with an answer under it, and the card is idle rather than stuck busy.
  await shoot(dashboard, `${agent}-mid-turn-delivered`);
});
}

test("a Codex final answer releases a queued turn when later lifecycle notifications are lost", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "codex");

  const card = dashboard.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();

  await composer.fill(FINAL_ANSWER_HELD_TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(FINAL_ANSWER_HELD_TURN, {
      exact: true,
    }),
  ).toBeVisible();

  await composer.fill(QUEUED_TURN);
  await composer.press("Enter");
  await expect(card.getByRole("status").filter({ hasText: /^queued$/ })).toBeVisible();

  // The fake emits the completed `final_answer` item and deliberately omits both
  // `turn/completed` and the idle thread status. The user-visible proof is that the outbox
  // still drains and the next turn receives an answer.
  //
  // Scoped to `.turn-assistant`, for the reason the mid-turn case above already gives: while
  // a turn is running the same sentence is on screen TWICE - once as the recorded turn, and
  // once as the live report of the step in progress, which is the card's activity ticker and
  // (since the activity line moved into the log) the ghosted row at its tail. A card-wide
  // `getByText` matches all three and fails strict mode on a timing the assertion does not
  // care about, which is a flake rather than a defect: the reply really is there.
  const replies = card.locator(".turn-assistant");
  await expect(
    replies.getByText(`Mock reply to: ${FINAL_ANSWER_HELD_TURN}`, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".pending-turn")).toHaveCount(0, { timeout: 15_000 });
  await expect(
    replies.getByText(`Mock reply to: ${QUEUED_TURN}`, { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  // Reviewer-visible proof from this exact regression: the former pending row is an
  // ordinary submitted turn and its SDK response is on the card.
  await shoot(dashboard, "codex-final-answer-delivered");
});
