import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The guided dispatch pass: three keyboard questions inside the dispatch modal, then the
 * ordinary form with those answers already set.
 *
 * Driven through the browser because every claim here is about a keystroke reaching a
 * control. The pass's own walk - order, back, skip - is a pure machine covered in
 * milliseconds by `test/guided-dispatch-steps.test.ts`; what that file cannot see is whether
 * <kbd>t</kbd> arrives at all. `Overlay`'s handler is a `window` listener, the letters it
 * takes are also bound in App's global `selection` group, and the answer has to land in the
 * form's own `<select>` rather than in a second copy of the state. Markup tests assert
 * shape, route tests have no keyboard, and the Electron tests measure geometry. Only this
 * layer joins a key to a control.
 *
 * NO TEST IN THIS FILE SUBMITS A DISPATCH. The modal is opened, driven and closed, so no
 * agent binary is launched and nothing here spends model tokens.
 *
 * The preference is turned ON in-test, deliberately: it ships off in this phase, and the
 * shared `dashboard` fixture pins it off explicitly so that no OTHER spec depends on the
 * shipped default. These tests are the ones that want the opposite value, so they say so.
 */

/** The dispatch modal, with the guided pass running. */
async function openGuided(page: Page): Promise<Locator> {
  const dialog = await openDispatch(page);
  await dialog.getByRole("switch", { name: "Guided" }).click();
  await expect(dialog.getByRole("navigation", { name: "Guided dispatch" })).toBeVisible();
  return dialog;
}

/** The dispatch modal as the fixture leaves it: the preference off, the ordinary form. */
async function openDispatch(page: Page): Promise<Locator> {
  // Never `{ exact: true }`: the keycap renders inside the button's label, so its accessible
  // name is "+Dispatch".
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  const toggle = dialog.getByRole("switch", { name: "Guided" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  // The machine's Workflow config arrives on its own fetch, and until it lands the After
  // work default reads "loading…" - in the select AND in the pass's list over it. Gating on
  // that copy disappearing means every assertion below reads a settled control.
  await expect
    .poll(() => selectedLabel(afterWorkSelect(dialog)), {
      message: "the Workflow config fetch should settle the after-work default option",
    })
    .not.toContain("loading");
  return dialog;
}

/**
 * The question on screen, and the row inside it that the arrows are pointing at.
 *
 * Scoped to the listbox, never to the dialog: a collapsed `<select>` still exposes its
 * `<option>`s to the accessibility tree, so `dialog.getByRole("option")` finds the form's own
 * options as well as the pass's and resolves to two elements.
 */
const picker = (dialog: Locator, question: string): Locator =>
  dialog.getByRole("listbox", { name: question });
const option = (dialog: Locator, question: string, name: RegExp): Locator =>
  picker(dialog, question).getByRole("option", { name });

const kindSelect = (dialog: Locator): Locator =>
  dialog.getByRole("combobox", { name: "Kind", exact: true });
const agentSelect = (dialog: Locator): Locator =>
  dialog.getByRole("combobox", { name: "Agent", exact: true });
const afterWorkSelect = (dialog: Locator): Locator =>
  dialog.getByRole("combobox", { name: "After work", exact: true });
const taskBox = (dialog: Locator): Locator =>
  dialog.getByPlaceholder("What should this agent do?");
const rail = (dialog: Locator): Locator =>
  dialog.getByRole("navigation", { name: "Guided dispatch" });

/**
 * The text of a `<select>`'s chosen option.
 *
 * Read with `evaluate` rather than asserted with `toContainText`, because Playwright matches
 * RENDERED text and the options of a collapsed `<select>` render none.
 */
function selectedLabel(select: Locator): Promise<string> {
  return select.evaluate(
    (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "",
  );
}

const EVIDENCE = artifactsDir("guided-dispatch");

/**
 * A frame of the pass, for review.
 *
 * Behind `MC_E2E_EVIDENCE` like the rest of this suite's captures - an ordinary run would
 * rewrite the binaries for no added signal - and taken inside a test whose assertions pass,
 * so the picture is of a working build rather than of a staged one. The pointer is parked off
 * every control first: `Tooltip` opens on hover, and a bubble over the list would be the one
 * thing in the frame that is not the feature.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  // `animations: "disabled"` finishes the list's pop and holds it at its end state. Without
  // it the frame catches whatever fraction of the 160ms had elapsed - which is a picture of
  // a fade, not of the feature, and reads as a translucent panel that has lost a z-index
  // fight it never had.
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/guided-dispatch/${name}.png`);
}

test("each mnemonic lands its value in the form's own control", async ({ dashboard }) => {
  const dialog = await openGuided(dashboard);

  // Preconditions, asserted rather than assumed: every value below differs from the one a
  // fresh draft opens with, so none of these assertions could pass without the keystroke.
  await expect(kindSelect(dialog)).toHaveValue("ship");
  await expect(agentSelect(dialog)).toHaveValue("claude");
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");

  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
  await shoot(dashboard, "01-kind");
  await dashboard.keyboard.press("t");
  await expect(kindSelect(dialog)).toHaveValue("scout");

  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();
  await shoot(dashboard, "02-harness");
  await dashboard.keyboard.press("x");
  await expect(agentSelect(dialog)).toHaveValue("codex");

  // Scout has moved After work to None, so `d` is a real move rather than a confirmation of
  // where the list already sat.
  await expect(picker(dialog, "What runs after the work?")).toBeVisible();
  await expect(afterWorkSelect(dialog)).toHaveValue("__none");
  await shoot(dashboard, "03-after-work");
  await dashboard.keyboard.press("d");
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");

  // The pass is spent: the strip is gone, the form has its ordinary shape, and the caret is
  // in the task box - which is the whole point of asking the questions first.
  await expect(rail(dialog)).toBeHidden();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(taskBox(dialog)).toBeFocused();
  await shoot(dashboard, "04-handed-over");
});

test("arrows and Enter reach the same place as the mnemonics", async ({ dashboard }) => {
  const dialog = await openGuided(dashboard);

  // Kind opens on `ship`, the value the draft carries; one step down is `scout`.
  await dashboard.keyboard.press("ArrowDown");
  await expect(
    option(dialog, "What kind of run is this?", /^scout/),
  ).toHaveAttribute("aria-selected", "true");
  await dashboard.keyboard.press("Enter");
  await expect(kindSelect(dialog)).toHaveValue("scout");

  await dashboard.keyboard.press("ArrowDown");
  await dashboard.keyboard.press("Enter");
  await expect(agentSelect(dialog)).toHaveValue("codex");
});

test("Backspace steps back and the rung returns to unanswered", async ({ dashboard }) => {
  const dialog = await openGuided(dashboard);

  await dashboard.keyboard.press("t");
  // The rung names the step as well as the value: "scout" on its own says nothing about
  // which question it answered.
  const answered = rail(dialog).getByRole("button", { name: "Kind: scout" });
  await expect(answered).toBeVisible();

  await dashboard.keyboard.press("Backspace");

  await expect(answered).toBeHidden();
  await expect(dialog.getByRole("listbox", { name: "What kind of run is this?" })).toBeVisible();
  // The draft keeps what was answered - going back reopens the question, it does not undo
  // the write - and the list reopens on that value rather than on the first entry.
  await expect(kindSelect(dialog)).toHaveValue("scout");
  await expect(
    option(dialog, "What kind of run is this?", /^scout/),
  ).toHaveAttribute("aria-selected", "true");
});

test("Tab leaves the pass with every answer intact and the caret in the task box", async ({
  dashboard,
}) => {
  const dialog = await openGuided(dashboard);

  await dashboard.keyboard.press("t");
  await dashboard.keyboard.press("x");
  await expect(dialog.getByRole("listbox", { name: "What runs after the work?" })).toBeVisible();

  await dashboard.keyboard.press("Tab");

  await expect(rail(dialog)).toBeHidden();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(taskBox(dialog)).toBeFocused();
  // The escape costs nothing. Both answered questions survive it, and the unanswered one is
  // left on the default a fresh draft opened with.
  await expect(kindSelect(dialog)).toHaveValue("scout");
  await expect(agentSelect(dialog)).toHaveValue("codex");
  await expect(afterWorkSelect(dialog)).toHaveValue("__none");

  // And typing goes to the task, not to the pass: the letters that were mnemonics a moment
  // ago are letters again.
  await taskBox(dialog).fill("");
  await dashboard.keyboard.type("tidy the pass");
  await expect(taskBox(dialog)).toHaveValue("tidy the pass");
});

test("scout preselects None through the pass, and ship hands the stash back", async ({
  dashboard,
}) => {
  const dialog = await openGuided(dashboard);

  await dashboard.keyboard.press("t");
  await dashboard.keyboard.press("c");

  // The same rule the Kind `<select>` applies - `afterWorkForKind`, one implementation - so
  // by the time the question is on screen the right row is already lit. And it says WHY,
  // rather than silently landing there.
  await expect(dialog.getByRole("listbox", { name: "What runs after the work?" })).toBeVisible();
  await expect(
    option(dialog, "What runs after the work?", /^None —/),
  ).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("A scout has no diff, so None is preselected.")).toBeVisible();
  await expect(afterWorkSelect(dialog)).toHaveValue("__none");
  await expect(dialog.getByText("No handoff")).toBeVisible();

  // Back to Kind and change our mind. The stash is handed back exactly as it is when the
  // `<select>` drives the same reversal - the pass has no opinion the form does not have.
  await dashboard.keyboard.press("Backspace");
  await dashboard.keyboard.press("Backspace");
  await expect(dialog.getByRole("listbox", { name: "What kind of run is this?" })).toBeVisible();
  await dashboard.keyboard.press("p");

  await expect(kindSelect(dialog)).toHaveValue("ship");
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");
  await expect(dialog.getByText("Foreman complete")).toBeVisible();
});

test("using the question's own control answers it and moves the pass on", async ({
  dashboard,
}) => {
  const dialog = await openGuided(dashboard);

  // The list hangs BELOW its control rather than over it, so the `<select>` a question is
  // about stays visible and clickable - and a mouse user reaching for the control they can
  // see is doing the reasonable thing. Left to its own handler it wrote the draft and left
  // the pass parked on a question it had just answered, with the list still open over a form
  // that had already moved.
  await kindSelect(dialog).selectOption("scout");

  await expect(rail(dialog).getByRole("button", { name: "Kind: scout" })).toBeVisible();
  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();
  await expect(picker(dialog, "What kind of run is this?")).toHaveCount(0);

  // The same for the other two, including the one whose value the Kind answer just moved.
  await agentSelect(dialog).selectOption("pi");
  await expect(rail(dialog).getByRole("button", { name: "Harness: Pi" })).toBeVisible();
  await expect(picker(dialog, "What runs after the work?")).toBeVisible();

  await afterWorkSelect(dialog).selectOption("__default");

  // Last question, so the pass is spent and the form is the ordinary one.
  await expect(rail(dialog)).toBeHidden();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(taskBox(dialog)).toBeFocused();
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");
});

test("Clear during a pass restarts it rather than stranding the keyboard", async ({
  dashboard,
}) => {
  const dialog = await openGuided(dashboard);
  await dashboard.keyboard.press("t");
  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();

  // Answering Kind is enough to enable Clear, so this is reachable rather than theoretical.
  const clear = dialog.getByRole("button", { name: "Clear" });
  await expect(clear).toBeEnabled();
  await clear.click();

  // Back to the first question over a form that holds none of the old answers. The bug this
  // pins put the caret in the task box with the strip still up - and the pass stands down for
  // a text field, so every remaining key typed instead of answering.
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
  await expect(rail(dialog).getByRole("button", { name: "Kind: scout" })).toHaveCount(0);
  await expect(kindSelect(dialog)).toHaveValue("ship");
  await expect(taskBox(dialog)).not.toBeFocused();

  // And the keyboard still drives it.
  await dashboard.keyboard.press("t");
  await expect(kindSelect(dialog)).toHaveValue("scout");
});

test("an answered rung jumps back to its question", async ({ dashboard }) => {
  const dialog = await openGuided(dashboard);

  await dashboard.keyboard.press("t");
  await dashboard.keyboard.press("x");
  await expect(dialog.getByRole("listbox", { name: "What runs after the work?" })).toBeVisible();

  await rail(dialog).getByRole("button", { name: "Kind: scout" }).click();

  // Back at the first question, with the two rungs behind it un-answered: they are about to
  // be asked again, and a tick over a live question is the strip saying something untrue.
  await expect(dialog.getByRole("listbox", { name: "What kind of run is this?" })).toBeVisible();
  await expect(rail(dialog).getByRole("button", { name: "Kind: scout" })).toBeHidden();
  await expect(rail(dialog).getByRole("button", { name: /^Harness/ })).toBeHidden();
});

test("the chord opens straight into the pass once the preference is on", async ({
  dashboard,
}) => {
  // Turned on through the header toggle - the only surface that offers it in this phase -
  // and then proved to have outlived the modal that set it.
  const first = await openDispatch(dashboard);
  await first.getByRole("switch", { name: "Guided" }).click();
  await dashboard.keyboard.press("Escape");
  await expect(first).toBeHidden();

  // Specs open this modal by clicking Dispatch; the chord is the reason the pass exists, so
  // at least one of them presses it.
  await dashboard.keyboard.press("+");
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "Guided" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(dialog.getByRole("listbox", { name: "What kind of run is this?" })).toBeVisible();
  // The caret is deliberately NOT in the task box while the questions are up: `Overlay`'s
  // handler is a window listener, so a focused textarea would take the mnemonic as a letter
  // and advance the pass at the same time.
  await expect(taskBox(dialog)).not.toBeFocused();
});

test("turning Guided off mid-pass hands back today's form", async ({ dashboard }) => {
  const dialog = await openGuided(dashboard);
  await dashboard.keyboard.press("t");

  await dialog.getByRole("switch", { name: "Guided" }).click();

  await expect(rail(dialog)).toBeHidden();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(taskBox(dialog)).toBeFocused();
  // What was already answered stays answered. Turning it off is a change of interface, not
  // an undo.
  await expect(kindSelect(dialog)).toHaveValue("scout");
});

test("Ensemble mode never runs the pass", async ({ dashboard }) => {
  const dialog = await openGuided(dashboard);

  await dialog.getByRole("radio", { name: "Ensemble" }).click();

  // Ensemble replaces Crew and After work outright, so the questions would be floating over
  // controls that are no longer rendered.
  await expect(rail(dialog)).toBeHidden();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);

  // And coming back to Single does not restart it: the pass ended, it did not pause.
  await dialog.getByRole("radio", { name: "Single agent" }).click();
  await expect(rail(dialog)).toBeHidden();
});

test("a backlog task opened for edit never enters the pass", async ({ dashboard, daemon }) => {
  const first = await openDispatch(dashboard);
  await first.getByRole("switch", { name: "Guided" }).click();
  await expect(rail(first)).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(first).toBeHidden();

  const title = "Audit The Retry Policy";
  const created = (await (
    await fetch(`${daemon.baseURL}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoRoot: daemon.repo,
        intent: "audit the retry policy",
        // Titled explicitly rather than derived, so the row can be found by name without
        // waiting on the async model retitle a dispatch would apply.
        title,
        agent: "claude",
        kind: "scout",
        backlog: true,
      }),
    })
  ).json()) as { id: string; title: string };
  expect(created.title).toBe(title);

  await dashboard.keyboard.press("Shift+P");
  await expect(dashboard.getByRole("heading", { name: "Sitrep" })).toBeVisible();
  await dashboard.getByRole("button", { name: title, exact: true }).click();

  const editor = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(editor).toBeVisible();
  // Those answers already exist on the row. Re-asking them would be a quiz, not a shortcut -
  // and the toggle is absent too, because there is no pass here for it to be about.
  await expect(rail(editor)).toBeHidden();
  await expect(editor.getByRole("listbox")).toHaveCount(0);
  await expect(editor.getByRole("switch", { name: "Guided" })).toHaveCount(0);
  await expect(taskBox(editor)).toBeFocused();
  await expect(kindSelect(editor)).toHaveValue("scout");
});

test("with the preference off, the dispatch modal is today's form", async ({ dashboard }) => {
  const dialog = await openDispatch(dashboard);

  // The claim the fixture's pin protects, asserted once here so it is a tested property
  // rather than the accident of a default that a later phase moves.
  await expect(rail(dialog)).toBeHidden();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(taskBox(dialog)).toBeFocused();
  await expect(kindSelect(dialog)).toHaveValue("ship");
  await expect(agentSelect(dialog)).toHaveValue("claude");
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");

  // The counterpart to the four frames above: the same dialog with the preference off, so
  // "indistinguishable from today's" is a picture a reviewer can hold against them rather
  // than a sentence in a pull request.
  await shoot(dashboard, "00-preference-off");

  // And the letters the pass would have taken are letters.
  await dashboard.keyboard.type("tpc");
  await expect(taskBox(dialog)).toHaveValue("tpc");
});
