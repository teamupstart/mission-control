import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * What is at stake: the gap between "wait" and "kill".
 *
 * Until this shipped there were two ways to make an agent stop - let it finish work already
 * known to be wrong, or destroy the session holding all the context worth keeping. Ctrl+C is
 * the third, and the claim it makes is a chain no other test layer can follow end to end: a
 * keystroke in a browser becomes a route, becomes a driver control request, becomes an
 * aborted turn in a subprocess, becomes an SSE event, becomes a card that is no longer
 * working - while the queue behind it goes and the cursor lands in the composer.
 *
 * Three assertions, and each is a separate promise the plan makes:
 *
 *  1. the turn stops, and demonstrably EARLY - the fake holds this prompt for five seconds,
 *     so a card that leaves "working" inside two is one the interrupt actually reached;
 *  2. nothing queued behind it survives, or the stop would restart itself seconds later;
 *  3. the composer holds focus, because typing the replacement instruction now is the whole
 *     reason the gesture exists.
 *
 * The last one is also why the chord is pressed FROM the composer here: App's typing guard
 * sits above the action-bar dispatch, so this is the case that needs its own bypass and the
 * one a card-level click would not exercise.
 */

const HELD_TURN = "hold the current turn open";
const QUEUED_TURN = "this queued turn must not outlive the interrupt";
/** ⌃C, not ⌘C: the chord grammar spells the two modifiers apart and the default is `ctrl+c`. */
const INTERRUPT = "Control+c";
/**
 * Comfortably inside the fake's five-second window.
 *
 * Explicit because the config's default `expect` timeout is 20s - four times the window - so
 * a retrying assertion would happily wait past the point where the turn ends on its own and
 * report a pass for the wrong reason.
 */
const WELL_BEFORE_THE_TURN_WOULD_END = 2_500;

const EVIDENCE = artifactsDir("session-interrupt");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: a resting pointer portals a tooltip over the row being shot.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function dispatch(
  page: Page,
  daemon: DaemonHandle,
  agent: "claude" | "codex" = "claude",
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the session interrupt");
  await dialog.locator("select").filter({ hasText: "Claude Code" }).selectOption(agent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

test("Ctrl+C keeps an interrupted Codex session idle after late child activity", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon, "codex");

  const card = await selectTheOnlyCard(dashboard);
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await expect(card).toContainText("Agent SDK");

  await composer.fill(HELD_TURN);
  await composer.press("Enter");
  await expect(card).toContainText("working");

  await composer.focus();
  await composer.press(INTERRUPT);
  const badge = card.locator("span.badge").first();
  await expect(badge).toHaveText("idle", { timeout: WELL_BEFORE_THE_TURN_WOULD_END });

  await expect
    .poll(
      () =>
        readdirSync(join(daemon.recordDir, "codex")).some((name) =>
          name.startsWith("late-descendant-"),
        ),
      { message: "the fake Codex child should emit activity after the root turn completes" },
    )
    .toBe(true);
  await dashboard.waitForTimeout(250);

  expect(await badge.textContent()).toBe("idle");
  await expect(composer).toBeFocused();
});

/**
 * Put the keyboard cursor on the fleet's one card, and return it.
 *
 * Selection is what mounts the action bar the chord dispatches through - a card that merely
 * rendered has none - so this is a precondition of the gesture rather than setup dressing.
 * Polled around the arrow press because the card arrives on an SSE frame: a press that lands
 * before the fleet has a session selects nothing and the key is spent.
 */
async function selectTheOnlyCard(page: Page) {
  await expect
    .poll(
      async () => {
        await page.keyboard.press("ArrowRight");
        return await page.locator("article.card.selected").count();
      },
      { message: "an arrow press should select the only card in the fleet" },
    )
    .toBe(1);
  return page.locator("article.card.selected");
}

test("Ctrl+C stops the turn, drops the queue, and leaves the cursor in the composer", async ({
  dashboard,
  daemon,
}) => {
  await dispatch(dashboard, daemon);

  const card = await selectTheOnlyCard(dashboard);
  await card.getByRole("button", { name: "Expand conversation" }).click();

  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();

  // The embedded runtime is what this phase ships, and the card says which one it is - so
  // assert it rather than trusting the dispatch default, or a config change elsewhere would
  // silently turn this into a test of the terminal path's refusal.
  await expect(card).toContainText("Agent SDK");

  // Send the prompt the fake holds open for five seconds, and wait until the card genuinely
  // reports work in progress. Interrupting a session that was never busy would pass for
  // reasons having nothing to do with the interrupt.
  await composer.fill(HELD_TURN);
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true }),
  ).toBeVisible();
  await expect(card).toContainText("working");

  // And queue one behind it. `sendWhenIdle` only ever delivers to an idle driver, so while
  // the held turn runs this row sits in Mission Control's own durable outbox - which is the
  // queue the interrupt has to take with it.
  await composer.fill(QUEUED_TURN);
  await composer.press("Enter");
  await expect(card.getByRole("status").filter({ hasText: /^queued$/ })).toBeVisible();
  await expect(composer).toHaveValue("");
  await shoot(dashboard, "before-interrupt");

  // From INSIDE the composer, which is the case the typing guard would otherwise swallow.
  await composer.focus();
  await composer.press(INTERRUPT);

  // 1. The turn stopped, and early.
  //
  //    `idle` specifically, and not merely "no longer working". The badge also carries a
  //    transient client-side "interrupting" while the request is in flight, so "working is
  //    gone" would be satisfied by that optimistic label alone - and would therefore stay
  //    green on a build where the request never reached the driver at all. `idle` is a
  //    reading of the session, reported by the driver's own turn completion, so only a turn
  //    that genuinely ended can produce it. Inside the fake's five-second window, so it
  //    cannot be the turn finishing on its own either.
  await expect(card.locator("span.badge").first()).toHaveText("idle", {
    timeout: WELL_BEFORE_THE_TURN_WOULD_END,
  });

  // 2. Nothing queued survived. Left armed, it would have been delivered the moment the
  //    driver reported idle - restarting, seconds later, the work just stopped.
  await expect(card.locator(".pending-turn")).toHaveCount(0);
  await expect(card.getByText(QUEUED_TURN, { exact: true })).toHaveCount(0);

  // 3. The cursor is in the composer, ready for the replacement instruction.
  await expect(composer).toBeFocused();
  await shoot(dashboard, "after-interrupt");

  // And the conversation survived, which is the entire distinction from Kill: the card is
  // still here, still carrying the turn that was interrupted, and can be typed into again.
  await expect(card.getByText(HELD_TURN, { exact: true })).toBeVisible();
  await composer.fill("do this instead");
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText("do this instead", { exact: true }),
  ).toBeVisible();
});

test("Ctrl+C over a selection copies instead of stopping the agent", async ({
  dashboard,
  daemon,
}) => {
  // The other half of the binding, and the one a naive implementation breaks. ⌃C is Copy on
  // Windows and Linux, which the Electron shell inherits, so a live selection keeps the
  // keystroke. The selection here is READ-ONLY transcript text, which is the case that
  // matters: App's typing guard is true only for focus inside an editable field, so this
  // path reaches the action-bar dispatch and its unconditional preventDefault. A gate placed
  // inside the composer bypass would look correct and would silently break the commonest
  // copy in the app while interrupting the agent instead.
  await dispatch(dashboard, daemon);

  const card = await selectTheOnlyCard(dashboard);
  await card.getByRole("button", { name: "Expand conversation" }).click();

  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  await composer.fill(HELD_TURN);
  await composer.press("Enter");

  const turn = card.locator(".turn-user:not(.pending-turn)").getByText(HELD_TURN, { exact: true });
  await expect(turn).toBeVisible();
  await expect(card).toContainText("working");

  // Leave the composer, so the keypress arrives on the read-only path. This is the case the
  // typing guard does NOT cover and the one a bypass-local selection check would break.
  await dashboard.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await dashboard.evaluate(() => document.activeElement?.tagName ?? "")).not.toBe(
    "TEXTAREA",
  );

  // Watch whether the app CLAIMS the keystroke, which is the fact decision 2 turns on.
  //
  // `defaultPrevented`, read from a listener registered after the app's own, rather than the
  // clipboard: a headless browser's clipboard needs a permission this suite does not grant,
  // and asserting on it would make this spec a test of Chromium rather than of the gate.
  // Whether the handler called `preventDefault()` is the whole question - the browser's copy
  // is precisely what that call suppresses - and it is answerable with no permissions at all.
  await dashboard.evaluate(() => {
    const w = window as unknown as { __claimed?: boolean };
    w.__claimed = undefined;
    // Capture phase, and the flag read on a later task. Both matter. The app re-registers
    // its own bubble-phase listener whenever the effect's dependencies move, so "register
    // after it and read in line" is a race about listener order rather than a measurement.
    // Capturing guarantees this runs; deferring the read guarantees it happens after every
    // other listener has had its turn, which is the only moment `defaultPrevented` is the
    // answer to "did the app claim this key".
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key.toLowerCase() !== "c" || !event.ctrlKey) return;
        w.__claimed = undefined;
        setTimeout(() => {
          w.__claimed = event.defaultPrevented;
        }, 0);
      },
      true,
    );
  });

  // Select that read-only turn, the way a person dragging across it would.
  await turn.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await dashboard.keyboard.press(INTERRUPT);

  await expect
    .poll(
      () => dashboard.evaluate(() => (window as unknown as { __claimed?: boolean }).__claimed),
      { message: "with text selected the chord must reach the browser, so the copy happens" },
    )
    .toBe(false);
  // And the agent was NOT stopped. Read once rather than retried: the claim is that
  // something never became false, and a web-first assertion would poll happily past the
  // point where the held turn ends on its own and report that as a pass.
  await dashboard.waitForTimeout(1_000);
  await expect(card).toContainText("working");

  // The positive control, on the same page and the same key: drop the selection and press
  // again. Without it this spec would pass just as well against a build where ⌃C did nothing
  // at all - which is a different bug, not a fix.
  await dashboard.evaluate(() => window.getSelection()?.removeAllRanges());
  await dashboard.keyboard.press(INTERRUPT);

  await expect
    .poll(
      () => dashboard.evaluate(() => (window as unknown as { __claimed?: boolean }).__claimed),
      { message: "with nothing selected the chord belongs to the agent" },
    )
    .toBe(true);
  await expect(card).not.toContainText("working", {
    timeout: WELL_BEFORE_THE_TURN_WOULD_END,
  });
});
