import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The chain no other layer here can follow: a chord inside a live textarea opens a
 * registered overlay, the overlay's ⌘Enter writes back through the draft map into an
 * UNCONTROLLED input, and the message is still sitting there unsent afterwards.
 */

const DRAFT = "the first attempt at a correction";
const REFINED = "one: the first point\ntwo: the second point\nthree: the third";
const ABANDONED = "\nfour: a point that must not survive Escape";

const EVIDENCE = artifactsDir("composer-editor");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: a resting pointer portals a tooltip over the surface being shot.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();

  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the message editor");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Dispatch one session, open its console detail, and return the detail and its reply box. */
async function openTheOnlySession(page: Page, daemon: DaemonHandle) {
  await dispatch(page, daemon);
  await page
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const card = page.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Reply to this session/);
  await expect(composer).toBeEnabled();
  return { card, composer };
}

test("⌃G opens the draft full size and ⌘Enter stages it back, unsent", async ({
  dashboard,
  daemon,
}) => {
  const { card, composer } = await openTheOnlySession(dashboard, daemon);

  // The legend beside the box is the only place the chord is named outside Settings.
  await expect(card.locator(".pty-sendkey")).toContainText("⌃G expands");

  await composer.fill(DRAFT);
  await composer.press("Control+g");

  const editor = dashboard.getByRole("dialog", { name: "Edit the message" });
  await expect(editor).toBeVisible();
  // Opened on what the box held, not on a stale draft or an empty panel.
  const big = editor.getByRole("textbox", { name: "Message" });
  await expect(big).toHaveValue(DRAFT);
  await expect(big).toBeFocused();
  // Text printed onto the panel border is invisible to every other layer - see the fixture.
  await expectContentClearsBorder(editor);
  await shoot(dashboard, "editor-open-on-the-draft");

  // Multi-line, so plain Enter inside the dialog has to stay a newline.
  await big.fill(REFINED);
  await expect(big).toHaveValue(REFINED);
  await shoot(dashboard, "editor-holding-the-modified-text");

  await big.press("Meta+Enter");

  await expect(editor).toBeHidden();
  await expect(composer).toHaveValue(REFINED);
  // Staged, NOT sent: no turn carrying this text, and the cursor back in the box.
  await expect(card.locator(".turn-user").getByText("one: the first point")).toHaveCount(0);
  await expect(composer).toBeFocused();
  await shoot(dashboard, "staged-in-the-send-box-unsent");

  // The second press must open on the REFINEMENT - the case a dialog seeded from its own
  // stale state fails.
  await composer.press("Control+g");
  await expect(editor).toBeVisible();
  await expect(big).toHaveValue(REFINED);

  // Escape discards the edit and leaves the send box holding exactly what it had.
  await big.fill(REFINED + ABANDONED);
  await dashboard.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(composer).toHaveValue(REFINED);
  await expect(composer).toBeFocused();

  // The staged text is an ordinary draft, so the deferred send still works.
  await composer.press("Enter");
  await expect(
    card.locator(".turn-user:not(.pending-turn)").getByText("three: the third"),
  ).toBeVisible();
  await expect(composer).toHaveValue("");
});

test("the expand chord is rebindable, and refuses a key that would type itself", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/keyboard`);
  const row = dashboard.locator('[data-anchor="keyboard/composerEditor"]');
  await expect(row).toContainText("Expand the message box");
  await expect(
    row.getByRole("button", { name: /^Change shortcut for Expand the message box \(currently ⌃G\)/ }),
  ).toBeVisible();

  await row.getByRole("button", { name: /^Change shortcut for Expand the message box/ }).click();
  await expect(row.getByRole("button", { name: /^Recording/ })).toBeVisible();

  // `z` collides with nothing, so only this action's own typing-safety rule can refuse it.
  await dashboard.keyboard.press("z");
  await expect(dashboard.locator(".settings-error")).toContainText("fires from inside the send box");
  // Still recording after a refusal, rather than silently back on an unchanged row.
  await expect(row.getByRole("button", { name: /^Recording/ })).toBeVisible();

  await dashboard.keyboard.press("Meta+e");
  await expect(
    row.getByRole("button", { name: /^Change shortcut for Expand the message box \(currently ⌘E\)/ }),
  ).toBeVisible();
  await shoot(dashboard, "rebound-in-keyboard-settings");

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const { card, composer } = await openTheOnlySession(dashboard, daemon);

  // The legend follows the rebinding rather than teaching a key that does nothing.
  await expect(card.locator(".pty-sendkey")).toContainText("⌘E expands");
  await expect(card.locator(".pty-sendkey")).not.toContainText("⌃G");

  await composer.fill(DRAFT);
  const editor = dashboard.getByRole("dialog", { name: "Edit the message" });

  // The old chord is now a keystroke the field ignores; the new one opens the editor.
  await composer.press("Control+g");
  await expect(editor).toBeHidden();
  await expect(composer).toHaveValue(DRAFT);

  await composer.press("Meta+e");
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Message" })).toHaveValue(DRAFT);
});

test("the terminal rendering names the chord in its `enter sends` legend", async ({
  dashboard,
  daemon,
}) => {
  // The chat rendering teaches Enter and Shift+Enter through its placeholder, so the literal
  // `enter sends` legend only exists here - which makes this the rendering where the expand
  // chord has to appear beside it. The fixture pins chat, so ask for terminal and reload:
  // `hydrateUiConfig` adopts the daemon's answer at boot.
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationView: "terminal" }),
  });
  const body = (await response.json()) as { config?: { conversationView?: string } };
  expect(body.config?.conversationView, "the daemon accepted the rendering").toBe("terminal");
  await dashboard.reload();

  await dispatch(dashboard, daemon);
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  const card = dashboard.locator(".console-detail");
  const composer = card.getByPlaceholder(/^Send the next instruction/);
  await expect(composer).toBeEnabled();

  const legend = card.locator(".pty-sendkey");
  await expect(legend).toHaveText("enter sends · shift+enter newline · ⌃G expands · drop images");
  await shoot(dashboard, "hint-beside-enter-sends-terminal");

  // And the chord works from this composer too, not only from the chat one.
  await composer.fill(DRAFT);
  await composer.press("Control+g");
  const editor = dashboard.getByRole("dialog", { name: "Edit the message" });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "Message" })).toHaveValue(DRAFT);
});

test("time spent writing in the editor still reads as a composing operator", async ({
  dashboard,
  daemon,
}) => {
  // The regression this exists for is silent and expensive: opening the dialog moves focus
  // off the reply box, so that box BLURS and the panel releases the composer lease. If the
  // dialog reported nothing, a person spending minutes writing here would read as idle and
  // Foreman would enter the conversation mid-message - the exact thing composer activity
  // was built to prevent for the ordinary box.
  const { composer } = await openTheOnlySession(dashboard, daemon);

  // Every report this tab sends, captured from the wire rather than inferred from focus.
  const reports: Array<{ focused?: boolean; typed?: boolean }> = [];
  dashboard.on("request", (request) => {
    if (!request.url().includes("/composer-activity")) return;
    reports.push(request.postDataJSON() as { focused?: boolean; typed?: boolean });
  });

  await composer.fill(DRAFT);
  await composer.press("Control+g");
  const editor = dashboard.getByRole("dialog", { name: "Edit the message" });
  const big = editor.getByRole("textbox", { name: "Message" });
  await expect(big).toBeFocused();

  // Focus landing in the dialog re-takes the lease the reply box just gave up.
  await expect
    .poll(() => reports.some((r) => r.focused === true), {
      message: "the dialog should report a focused composer once it takes focus",
    })
    .toBe(true);

  reports.length = 0;
  await big.pressSequentially("a further thought", { delay: 10 });

  // And typing in here is typing, which is what buys the minute of protection after blur.
  await expect
    .poll(() => reports.some((r) => r.focused === true && r.typed === true), {
      message: "typing in the editor should report a typed, focused composer",
    })
    .toBe(true);
});

test("⌃G opens on an empty send box, and what is written there stages too", async ({
  dashboard,
  daemon,
}) => {
  // The boundary `TranscriptPanel` draws is `composerEditorText !== null`, where null means
  // closed and "" means open on an empty box. A refactor to a truthiness check would compile,
  // pass every other test here, and silently refuse to open the editor from an empty
  // composer - which is the state the box spends most of its life in, and a reasonable place
  // to start a long message rather than to continue one.
  const { composer } = await openTheOnlySession(dashboard, daemon);
  await expect(composer).toHaveValue("");

  await composer.focus();
  await composer.press("Control+g");

  const editor = dashboard.getByRole("dialog", { name: "Edit the message" });
  await expect(editor).toBeVisible();

  const big = editor.getByRole("textbox", { name: "Message" });
  await expect(big).toHaveValue("");
  await expect(big).toBeEditable();
  await expect(big).toBeFocused();

  // And it is a working editor, not merely an open one: what gets written from empty stages
  // back the same way a continued draft does.
  await big.fill(REFINED);
  await big.press("Meta+Enter");
  await expect(editor).toBeHidden();
  await expect(composer).toHaveValue(REFINED);
});
