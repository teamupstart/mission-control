import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A queued message the agent's own question is sitting on, and whether the log says so.
 *
 * The daemon has always refused to deliver anything while a pane dialog is up -
 * `canDrain` in `src/server/pending-turns.ts` requires `session.paneDialog === null` - so a
 * message typed while the agent was working, that the agent then asks a question over, is
 * not merely late. It is stopped, for exactly as long as the human takes to answer, which
 * may be for ever. The dashboard used to draw it in the same working-blue "queued" as a row
 * that is genuinely on its way, and the composer's "Waiting on a menu" said nothing about
 * the message already in the outbox. The two facts had to be assembled by the reader.
 *
 * Only a browser can see this: the state is a live pane dialog OVER a durable outbox row,
 * produced by a real drain against a real driver's question, and every layer beneath this
 * one sees a healthy queued row and a healthy dialog separately.
 *
 * The second test covers the OTHER thing that stops a queued row for good. A killed session
 * keeps its card, its transcript and its outbox rows for the exit-linger window, and none of
 * those rows can ever drain - `canDrain` requires `idle`. They used to read the same blue
 * "queued" there too. The row says shutdown rather than naming a review, because
 * `activePaneDialog` withdraws a dying session's dialog and there would be no card to jump
 * to.
 */

const EVIDENCE = artifactsDir("queued-turn-held-by-review");

/** The fake holds this exact prompt long enough to queue two messages under contention. */
const REVIEW_HELD_TURN = "hold the current turn open for queued review setup";
/** The ordinary five-second hold is sufficient when this spec queues only one message. */
const HELD_TURN = "hold the current turn open";
/** The fake answers this one by raising `AskUserQuestion` and blocking on it. */
const ASK_TURN = "ask me which linter to use";
const FOLLOW_UP = "and once you have picked, run the suite twice";
/** `--attention`, the gold the blocking dialog wears. Asserted as a used colour. */
const ATTENTION_GOLD = "rgb(246, 167, 51)";

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // held row's own jump button is one.
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/queued-turn-held-by-review/${name}.png`);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog
    .getByPlaceholder("What should this agent do?")
    .fill("exercise a queued turn held by a review");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("navigation", { name: "Sessions" })
      .locator("button.rail-row")
      .first()
      .locator(".rail-state"),
  ).toHaveText("idle", { timeout: 20_000 });
}

test("a queued message says the open review is what is holding it, and stops saying so", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const card = dashboard.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();

  // The scenario as an operator meets it, and the reason it is built in this order: the
  // composer REFUSES text while a dialog is open, so a message can only be under one by
  // having been queued before it. This scenario's longer held turn keeps both submissions
  // inside that window even when the full gate's other workers are contending for the host.
  await composer.fill(REVIEW_HELD_TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(REVIEW_HELD_TURN, { exact: true }),
  ).toBeVisible();

  // One at a time, each confirmed into the outbox before the next is typed. Submitting is not
  // synchronous: the composer is cleared when the queued row comes back, so filling the second
  // message straight after pressing Enter on the first lets that clear land ON the second,
  // which then sends an empty box and queues nothing. The page at the moment of failure said
  // so exactly: the ask queued, the follow-up absent, the composer active and empty.
  await composer.fill(ASK_TURN);
  await composer.press("Enter");
  await expect(card.locator(".pending-turn").filter({ hasText: ASK_TURN })).toHaveCount(1);
  await expect(composer).toHaveValue("");

  await composer.fill(FOLLOW_UP);
  await composer.press("Enter");

  const followUpRow = card.locator(".pending-turn").filter({ hasText: FOLLOW_UP });
  // Before the dialog exists it is an ordinary queued row - which is the control for
  // everything below, and proves the amber that follows is caused by the dialog.
  await expect(followUpRow).toHaveCount(1);
  await expect(followUpRow.getByRole("status")).toHaveText("queued");

  // The held turn ends, the outbox delivers the ask, and the agent raises its question.
  const form = card.locator(".pane-dialog");
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form).toContainText("Which linter?");

  // The row is still in the outbox and is now visibly stopped rather than merely waiting.
  await expect(followUpRow).toHaveCount(1);
  await expect(followUpRow).toHaveClass(/\bis-held\b/);
  await expect(followUpRow.getByRole("status")).toHaveText("queued · held");
  await expect(followUpRow).toContainText("Held until you answer the review above");
  // It wears the dialog's own gold, so the eye pairs the two without reading either.
  await expect(followUpRow).toHaveCSS("border-left-color", ATTENTION_GOLD);
  // Stuck, not out of reach: recall still works on a held row.
  await expect(followUpRow.getByRole("button", { name: "Edit" })).toBeVisible();
  // And the composer is refusing new text for the same reason, as it always did.
  await expect(card.getByPlaceholder(/^Waiting on a menu/)).toBeDisabled();
  await shoot(dashboard, "held-by-the-review");
  await followUpRow.scrollIntoViewIfNeeded();
  await shoot(dashboard, "held-row", followUpRow);

  // The jump lands on the thing that has to be answered, which is the whole reason the row
  // names it rather than just colouring itself.
  await followUpRow.getByRole("button", { name: "Go to review" }).click();
  await expect(form).toBeFocused();

  // Answering releases it. The claim is not "amber for ever" - it is that the amber tracks
  // the blocker, so clearing the blocker has to clear the amber.
  await form.getByRole("radio", { name: /eslint/ }).click();
  await form.getByRole("checkbox", { name: /tests/ }).click();
  await form.getByRole("button", { name: "Submit answers" }).click();
  await expect(form).toBeHidden({ timeout: 30_000 });

  // Either it is already gone from the outbox, or it is briefly a plain queued row again on
  // its way out. Both are "no longer held", and which one the browser catches is a timing
  // detail of the drain, not a behaviour worth pinning.
  await expect(card.locator(".pending-turn.is-held")).toHaveCount(0, { timeout: 30_000 });
  await expect(card.locator(".pending-turn")).toHaveCount(0, { timeout: 30_000 });
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(FOLLOW_UP, { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await shoot(dashboard, "released-by-the-answer");
});

test("a queued message on a killed session says the shutdown is what is holding it", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const card = dashboard.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();

  await composer.fill(HELD_TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true }),
  ).toBeVisible();

  await composer.fill(FOLLOW_UP);
  await composer.press("Enter");
  const followUpRow = card.locator(".pending-turn").filter({ hasText: FOLLOW_UP });
  await expect(followUpRow).toHaveCount(1);
  await expect(followUpRow.getByRole("status")).toHaveText("queued");

  // Kill it out from under the queued row, which is the state the outbox can never leave.
  await card.getByRole("button", { name: /kill$/i }).click();
  const kill = dashboard.getByRole("dialog", { name: "Kill session" });
  await kill.getByRole("button", { name: "Kill" }).click();
  await expect(kill).toBeHidden();

  // Exiting DESELECTS the session - it moves to the rail's GONE bucket and the detail closes
  // - so the row is reached the way an operator reaches it, by opening the gone session
  // during its linger. Without this the assertions below would be aimed at an unmounted pane
  // and would pass or fail for the wrong reason.
  const gone = dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first();
  await expect(gone.locator(".rail-state")).toHaveText("exited", { timeout: 15_000 });
  await gone.click();

  // The row is still in the outbox and can never leave it. It must not read as on its way.
  await expect(followUpRow).toHaveClass(/\bis-held\b/);
  await expect(followUpRow.getByRole("status")).toHaveText("queued · held");
  await expect(followUpRow).toContainText("this session is ending and will not receive it");
  await expect(followUpRow).toHaveCSS("border-left-color", ATTENTION_GOLD);
  // No jump: a dying session has no dialog card rendered, so the button would aim at an
  // anchor that is not in the document.
  await expect(followUpRow.getByRole("button", { name: "Go to review" })).toHaveCount(0);
  await expect(followUpRow).not.toContainText("Held until you answer the review above");
  await followUpRow.scrollIntoViewIfNeeded();
  await shoot(dashboard, "held-by-shutdown", followUpRow);
});
