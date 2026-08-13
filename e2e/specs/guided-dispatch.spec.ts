import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The guided dispatch pass: four keyboard questions inside the dispatch modal, then the
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
 * The Repo question raises the stakes again, because it does not draw its own list: it drives
 * the `RepoCombobox` the form already carries, whose Escape, whose portalled listbox and whose
 * ↵ were all spoken for before the pass existed. Whether those two agree is not a fact about
 * either of them separately, and this is the only layer that can ask.
 *
 * NO TEST IN THIS FILE SUBMITS A DISPATCH. The modal is opened, driven and closed, so no
 * agent binary is launched and nothing here spends model tokens.
 *
 * The preference is turned ON in-test, deliberately: it ships off in this phase, and the
 * shared `dashboard` fixture pins it off explicitly so that no OTHER spec depends on the
 * shipped default. These tests are the ones that want the opposite value, so they say so.
 */

/** The dispatch modal, with the guided pass running and parked on its first question, Repo. */
async function openGuided(page: Page): Promise<Locator> {
  const dialog = await openDispatch(page);
  await dialog.getByRole("switch", { name: "Guided" }).click();
  await expect(dialog.getByRole("navigation", { name: "Guided dispatch" })).toBeVisible();
  // The pass places this caret itself - the mount autofocus stands down while a pass runs -
  // and every Repo-step assertion below depends on it, so it is waited on here rather than
  // assumed by a `press` that would otherwise type into whatever the click left focused.
  await expect(repoField(dialog)).toBeFocused();
  return dialog;
}

/**
 * The same, one question further on: Repo taken, Kind asked.
 *
 * <kbd>↵</kbd> with nothing typed takes the row the combobox has highlighted, which is what
 * the seeded case does in one key. Which repo that is does not matter to the callers of this
 * helper - they are about the three closed-set questions behind it - so it is deliberately not
 * asserted here; the specs that are about the Repo step seed it and say which.
 */
async function openGuidedAtKind(page: Page): Promise<Locator> {
  const dialog = await openGuided(page);
  await page.keyboard.press("Enter");
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
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

/**
 * The Repo question, which has no listbox of its own to be named by.
 *
 * It rides in the repo field's own hint slot: `RepoCombobox` portals its list over everything
 * below the input, and a row inserted above the input would move every field under it mid-pass.
 * So the question is text on a line that was already there, and text is how it is found.
 */
const repoAsk = (dialog: Locator): Locator => dialog.getByText("Which repo is this for?");
/** The primary repo field. Never `{ name: … }`: its accessible name carries the question. */
const repoField = (dialog: Locator): Locator =>
  dialog.getByPlaceholder("search repos or type a path…");
/**
 * The combobox's own dropdown, portalled to the body and so NOT inside the dialog.
 *
 * Reached from the page rather than the dialog for that reason, and unambiguous while a Repo
 * question is up: the pass draws no list of its own in this step, which is the point of it.
 */
const repoList = (page: Page): Locator => page.getByRole("listbox");

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

/**
 * Point the next dispatch at a repo, the way a dispatch that already happened would.
 *
 * Through `localStorage` and a reload rather than by dispatching one, because a dispatch
 * launches an agent and this file launches none. The seed is read once, when the layer builds
 * its draft on load, so setting the key without the reload would change nothing - and the
 * `dashboard` fixture clears this storage on purpose, so a spec that wants a seeded field is
 * required to say so.
 */
async function seedLastDispatchRepo(page: Page, repo: string): Promise<void> {
  await page.evaluate(
    (root) => window.localStorage.setItem("mission-control.dispatch.repo", root),
    repo,
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Dispatch" })).toBeVisible();
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

// ---- the Repo question -----------------------------------------------------------------

test("a default dispatch is + ↵ p c ↵, and the caret ends in the task box", async ({
  dashboard,
  daemon,
}) => {
  // The claim the whole feature is for, asserted as the five keys an operator actually
  // presses. Seeded first, because "↵ alone takes it" is only true of a form that opens on
  // the repo the last dispatch went to - which is the ordinary case and the one the
  // fixture's cleared storage removes.
  await seedLastDispatchRepo(dashboard, daemon.repo);
  const first = await openDispatch(dashboard);
  await first.getByRole("switch", { name: "Guided" }).click();
  await expect(repoField(first)).toHaveValue(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Escape");
  await expect(first).toBeHidden();

  await dashboard.keyboard.press("+");
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(repoAsk(dialog)).toBeVisible();
  await shoot(dashboard, "01-repo");
  await dashboard.keyboard.press("Enter");
  await dashboard.keyboard.press("p");
  await dashboard.keyboard.press("c");
  await dashboard.keyboard.press("Enter");

  // Four questions, four keys, and the form left holding the answers - three of which are
  // confirmations, because a default dispatch is what this measures.
  await expect(rail(dialog)).toBeHidden();
  await expect(repoField(dialog)).toHaveValue(daemon.repo);
  await expect(kindSelect(dialog)).toHaveValue("ship");
  await expect(agentSelect(dialog)).toHaveValue("claude");
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");
  await expect(taskBox(dialog)).toBeFocused();
  // Empty, which is what makes the three confirmations above real: had the pass not taken
  // those keys, `p` and `c` would be sitting in this box.
  await expect(taskBox(dialog)).toHaveValue("");

  // And you are typing the task, in the same breath.
  await dashboard.keyboard.type("audit the retry policy");
  await expect(taskBox(dialog)).toHaveValue("audit the retry policy");
});

test("typing filters by name, and ↵ takes the repo it reaches", async ({ dashboard, daemon }) => {
  const dialog = await openGuided(dashboard);

  // Both repos, because the field opens empty and an empty query is not a filter.
  await expect(repoList(dashboard).getByRole("option")).toHaveCount(2);

  // `second` is in neither repo's shared prefix but is in one repo's NAME. Under the match
  // this step replaced - substring over the whole path - a workspace's repos all share their
  // first 28 characters, so the letters an operator reaches for first returned everything.
  await dashboard.keyboard.type("second");
  await expect(repoList(dashboard).getByRole("option")).toHaveCount(1);
  await expect(repoList(dashboard).getByRole("option")).toHaveText(daemon.secondRepo);

  await dashboard.keyboard.press("Enter");

  // The answer lands in the form's OWN field - there is no second copy of it - and the pass
  // moves on to Kind with the rung naming the leaf.
  await expect(repoField(dialog)).toHaveValue(daemon.secondRepo);
  await expect(rail(dialog).getByRole("button", { name: "Repo: second-repo" })).toBeVisible();
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
});

test("clicking a repo in the list answers the question too", async ({ dashboard, daemon }) => {
  const dialog = await openGuided(dashboard);

  // The mouse path, and the rule it keeps is phase 2's: a question answered through its own
  // control moves the pass on. Left to `onChange` alone this wrote the repo and left the pass
  // parked on a question it had just answered.
  await repoList(dashboard).getByRole("option", { name: daemon.secondRepo }).click();

  await expect(repoField(dialog)).toHaveValue(daemon.secondRepo);
  await expect(rail(dialog).getByRole("button", { name: "Repo: second-repo" })).toBeVisible();
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
});

test("the multi-repo control recedes while the Repo question is up", async ({ dashboard }) => {
  const dialog = await openGuided(dashboard);

  // The repo FIELD is the one lit thing on the form, and `+ Add another repo` sits inside it -
  // but attaching a second repo is a form control, not an answer to "which repo is this for?".
  // Left live it reads as part of the question, and clicking it puts the caret in a second
  // combobox this pass cannot see, where ↵ answers nothing.
  const attach = dialog.getByRole("button", { name: "Add another repo" });
  await expect(attach).toBeVisible();
  expect(
    await attach.evaluate((el) => getComputedStyle(el).pointerEvents),
    "the attach control should not take the pointer mid-question",
  ).toBe("none");

  // And it comes back the moment the pass hands over - it was never disabled, only out of the
  // way of a question that is not about it.
  await dashboard.keyboard.press("Tab");
  await expect(rail(dialog)).toBeHidden();
  await expect(attach).toBeEnabled();
  expect(await attach.evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe("none");
});

test("a digit typed in the Repo step filters rather than selecting", async ({ dashboard }) => {
  const dialog = await openGuided(dashboard);

  // The step's stated exception. In the three closed-set questions a digit takes the option
  // at that position; here every character is a character, because repository names contain
  // digits and a digit that picked would make a repo called `service2` unfilterable.
  await dashboard.keyboard.type("2");

  await expect(repoField(dialog)).toHaveValue("2");
  await expect(repoAsk(dialog)).toBeVisible();
  // Nothing was taken, by this question or the one after it.
  await expect(rail(dialog).getByRole("button", { name: /^Repo:/ })).toHaveCount(0);
  await expect(kindSelect(dialog)).toHaveValue("ship");
});

test("Escape leaves the pass for the ordinary form, and a second closes the modal", async ({
  dashboard,
}) => {
  const dialog = await openGuided(dashboard);
  await dashboard.keyboard.type("second");
  await expect(repoList(dashboard)).toBeVisible();

  await dashboard.keyboard.press("Escape");

  // Progressive, and not by choice: `RepoCombobox` closes its own portalled list on Escape and
  // stops the event, deliberately, so an open list cannot let one press close the whole dialog.
  // So the first press closes the list and ends the pass together - a pass left running over a
  // question whose list has gone is a dimmed form waiting on keys that no longer arrive.
  await expect(repoList(dashboard)).toBeHidden();
  await expect(rail(dialog)).toBeHidden();
  await expect(dialog).toBeVisible();
  // The ordinary form, with the field exactly as typed. Not reverted, and not completed: this
  // is an escape hatch, not an answer.
  await expect(repoField(dialog)).toHaveValue("second");
  await expect(taskBox(dialog)).toBeFocused();

  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Backspace from Kind returns to Repo with the answer intact", async ({
  dashboard,
  daemon,
}) => {
  const dialog = await openGuided(dashboard);
  await dashboard.keyboard.type("second");
  await dashboard.keyboard.press("Enter");
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();

  await dashboard.keyboard.press("Backspace");

  // The rung stops claiming an answer, because the question is about to be asked again - but
  // the draft keeps the path, and the caret goes back to the field holding it, so ↵ takes the
  // same repo a second time.
  await expect(repoAsk(dialog)).toBeVisible();
  await expect(rail(dialog).getByRole("button", { name: /^Repo:/ })).toHaveCount(0);
  await expect(repoField(dialog)).toHaveValue(daemon.secondRepo);
  await expect(repoField(dialog)).toBeFocused();

  await dashboard.keyboard.press("Enter");
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
  await expect(repoField(dialog)).toHaveValue(daemon.secondRepo);
});

test("the form does not move while the four questions are asked", async ({ dashboard }) => {
  // The interaction's standing promise, and the reason the questions float over the fields
  // instead of sitting between them: the form an operator finishes in has been standing in its
  // final position the whole time. Repo is where that promise was easiest to break, because
  // its question has no floating list to live in - it rides in the field's own hint slot, one
  // line that already existed, precisely so that asking it inserts no row.
  //
  // Measured rather than eyeballed. A keycap two pixels taller than the line it sits on moves
  // every field below it, and no assertion on markup can see that.
  const dialog = await openGuided(dashboard);
  const tops = async (): Promise<{ repo: number; task: number }> => {
    const repo = await repoField(dialog).boundingBox();
    const task = await taskBox(dialog).boundingBox();
    return { repo: repo?.y ?? -1, task: task?.y ?? -1 };
  };

  const atRepo = await tops();
  await dashboard.keyboard.press("Enter");
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
  expect(await tops(), "asking Kind moved the form").toEqual(atRepo);

  await dashboard.keyboard.press("p");
  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();
  expect(await tops(), "asking Harness moved the form").toEqual(atRepo);

  await dashboard.keyboard.press("c");
  await expect(picker(dialog, "What runs after the work?")).toBeVisible();
  expect(await tops(), "asking After work moved the form").toEqual(atRepo);
});

// ---- the three closed-set questions -----------------------------------------------------

test("each mnemonic lands its value in the form's own control", async ({ dashboard }) => {
  const dialog = await openGuidedAtKind(dashboard);

  // Preconditions, asserted rather than assumed: every value below differs from the one a
  // fresh draft opens with, so none of these assertions could pass without the keystroke.
  await expect(kindSelect(dialog)).toHaveValue("ship");
  await expect(agentSelect(dialog)).toHaveValue("claude");
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");

  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
  await shoot(dashboard, "02-kind");
  await dashboard.keyboard.press("t");
  await expect(kindSelect(dialog)).toHaveValue("scout");

  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();
  await shoot(dashboard, "03-harness");
  await dashboard.keyboard.press("x");
  await expect(agentSelect(dialog)).toHaveValue("codex");

  // Scout has moved After work to None, so `d` is a real move rather than a confirmation of
  // where the list already sat.
  await expect(picker(dialog, "What runs after the work?")).toBeVisible();
  await expect(afterWorkSelect(dialog)).toHaveValue("__none");
  await shoot(dashboard, "04-after-work");
  await dashboard.keyboard.press("d");
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");

  // The pass is spent: the strip is gone, the form has its ordinary shape, and the caret is
  // in the task box - which is the whole point of asking the questions first.
  await expect(rail(dialog)).toBeHidden();
  await expect(dialog.getByRole("listbox")).toHaveCount(0);
  await expect(taskBox(dialog)).toBeFocused();
  await shoot(dashboard, "05-handed-over");
});

test("arrows and Enter reach the same place as the mnemonics", async ({ dashboard }) => {
  const dialog = await openGuidedAtKind(dashboard);

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

test("a position digit takes the option at that position", async ({ dashboard }) => {
  const dialog = await openGuidedAtKind(dashboard);

  // Out of range first, while the list is short enough to be certain it is: nothing is taken
  // and the question stays put. That is the `if (!guidedList[index]) return false` guard,
  // and without it a stray digit would fall through to whatever is behind the dialog.
  await dashboard.keyboard.press("9");
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
  await expect(kindSelect(dialog)).toHaveValue("ship");

  // 2 is the SECOND option - not the third, and not the first. This is the assertion the
  // `Number(event.key) - 1` in the digit branch exists to be wrong about.
  await dashboard.keyboard.press("2");
  await expect(kindSelect(dialog)).toHaveValue("scout");

  // Third of three, so the digit is not quietly capped at the pair the Kind step offered.
  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();
  await dashboard.keyboard.press("3");
  await expect(agentSelect(dialog)).toHaveValue("pi");

  // And 1 is the first, asserted on the one question whose row the previous answer has
  // already moved: scout left this on None, so taking position 1 is a real move to the
  // dispatch default rather than a confirmation of where the list already sat.
  await expect(picker(dialog, "What runs after the work?")).toBeVisible();
  await expect(afterWorkSelect(dialog)).toHaveValue("__none");
  await dashboard.keyboard.press("1");
  await expect(afterWorkSelect(dialog)).toHaveValue("__default");

  // Three questions answered by digit alone, so the pass is spent like any other route.
  await expect(rail(dialog)).toBeHidden();
  await expect(taskBox(dialog)).toBeFocused();
});

test("Backspace steps back and the rung returns to unanswered", async ({ dashboard }) => {
  const dialog = await openGuidedAtKind(dashboard);

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
  const dialog = await openGuidedAtKind(dashboard);

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
  const dialog = await openGuidedAtKind(dashboard);

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
  const dialog = await openGuidedAtKind(dashboard);

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
  const dialog = await openGuidedAtKind(dashboard);
  await dashboard.keyboard.press("t");
  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();

  // Answering Kind is enough to enable Clear, so this is reachable rather than theoretical.
  const clear = dialog.getByRole("button", { name: "Clear" });
  await expect(clear).toBeEnabled();
  await clear.click();

  // Back to the FIRST question over a form that holds none of the old answers. The bug this
  // pins put the caret in the task box with the strip still up - and the pass stands down for
  // a text field, so every remaining key typed instead of answering.
  //
  // With Repo at the front the same bug has a second shape, which is why the caret is asserted
  // rather than only the question: Clear is clicked, so focus is on the Clear button, and the
  // restart has to move it. An effect keyed on which step is active would not have - the pass
  // is on Repo before the click and on Repo after it.
  await expect(repoAsk(dialog)).toBeVisible();
  await expect(repoField(dialog)).toBeFocused();
  await expect(rail(dialog).getByRole("button", { name: "Kind: scout" })).toHaveCount(0);
  await expect(kindSelect(dialog)).toHaveValue("ship");
  await expect(taskBox(dialog)).not.toBeFocused();

  // And the keyboard still drives it, from the question it restarted on.
  await dashboard.keyboard.press("Enter");
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
  await dashboard.keyboard.press("t");
  await expect(kindSelect(dialog)).toHaveValue("scout");
});

test("Clear after the pass has handed over asks the questions again", async ({ dashboard }) => {
  const dialog = await openGuidedAtKind(dashboard);
  await dashboard.keyboard.press("t");
  await dashboard.keyboard.press("x");
  await dashboard.keyboard.press("d");

  // Spent, handed over, and typed into - the ordinary form.
  await expect(rail(dialog)).toBeHidden();
  await expect(taskBox(dialog)).toBeFocused();
  await dashboard.keyboard.type("audit the retry policy");

  await dialog.getByRole("button", { name: "Clear" }).click();

  // "Back where it opened" is about the OPENING, not about whether a question happens to be
  // on screen. Guided is still on, so this form still opens guided - and gating this on
  // "is a question showing" instead blanked the draft and left the operator in the plain
  // form, which is the one thing Clear is not for.
  await expect(repoAsk(dialog)).toBeVisible();
  await expect(repoField(dialog)).toBeFocused();
  await expect(rail(dialog).getByRole("button", { name: /^Kind:/ })).toHaveCount(0);
  await expect(taskBox(dialog)).toHaveValue("");
  await expect(kindSelect(dialog)).toHaveValue("ship");
  await expect(agentSelect(dialog)).toHaveValue("claude");
  await expect(taskBox(dialog)).not.toBeFocused();
});

test("confirming the harness you are already on keeps the model and effort overrides", async ({
  dashboard,
}) => {
  const dialog = await openDispatch(dashboard);

  // Both overrides live in the always-visible Crew row, so this needs no fold opened - and
  // the draft outlives a close, so a reopened form can carry them into a pass too.
  const model = dialog.getByRole("combobox", { name: "Model", exact: true });
  const effort = dialog.getByRole("combobox", { name: /^Effort for dispatched/ });
  await model.selectOption({ index: 1 });
  await effort.selectOption({ index: 1 });
  const pinnedModel = await model.inputValue();
  const pinnedEffort = await effort.inputValue();
  expect(pinnedModel, "the Model select should offer a real override").not.toBe("");
  expect(pinnedEffort, "the Effort select should offer a real override").not.toBe("");

  await dialog.getByRole("switch", { name: "Guided" }).click();
  // Past Repo first: the overrides this test is about sit two questions further on, and ↵
  // takes the repo the field is already pointing at.
  await expect(repoAsk(dialog)).toBeVisible();
  await dashboard.keyboard.press("Enter");
  await expect(picker(dialog, "What kind of run is this?")).toBeVisible();
  await dashboard.keyboard.press("t");

  // Claude Code is already the harness, so `c` is the fastest way past this question - and
  // it is a confirmation, not a switch. A `<select>` fires no `onChange` for re-picking its
  // own value, so the form never dropped anything here; the pass must not either.
  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();
  await dashboard.keyboard.press("c");

  await expect(agentSelect(dialog)).toHaveValue("claude");
  await expect(model).toHaveValue(pinnedModel);
  await expect(effort).toHaveValue(pinnedEffort);

  // And the guard has not gone too far the other way: an actual switch still drops both,
  // because neither selection travels across harnesses.
  await rail(dialog).getByRole("button", { name: "Harness: Claude Code" }).click();
  await expect(picker(dialog, "Which harness runs it?")).toBeVisible();
  await dashboard.keyboard.press("x");

  await expect(agentSelect(dialog)).toHaveValue("codex");
  await expect(model).toHaveValue("");
  await expect(effort).toHaveValue("");
});

test("an answered rung jumps back to its question", async ({ dashboard }) => {
  const dialog = await openGuidedAtKind(dashboard);

  await dashboard.keyboard.press("t");
  await dashboard.keyboard.press("x");
  await expect(dialog.getByRole("listbox", { name: "What runs after the work?" })).toBeVisible();

  await rail(dialog).getByRole("button", { name: "Kind: scout" }).click();

  // Back at that question, with the two rungs behind it un-answered: they are about to be
  // asked again, and a tick over a live question is the strip saying something untrue.
  await expect(dialog.getByRole("listbox", { name: "What kind of run is this?" })).toBeVisible();
  await expect(rail(dialog).getByRole("button", { name: "Kind: scout" })).toBeHidden();
  await expect(rail(dialog).getByRole("button", { name: /^Harness/ })).toBeHidden();
  // The rung BEFORE it keeps its tick, though: jumping back un-answers the question you land
  // on and everything after, never what you already walked past to get there.
  await expect(rail(dialog).getByRole("button", { name: /^Repo:/ })).toBeVisible();
});

test("the chord opens straight into the pass once the preference is on", async ({
  dashboard,
}) => {
  // Turned on through the header toggle - the only surface that offers it in this phase -
  // and then proved to have outlived the modal that set it.
  const first = await openDispatch(dashboard);
  await first.getByRole("switch", { name: "Guided" }).click();
  // Two presses, because the first one lands on the Repo question and Escape is progressive
  // there: it closes the combobox's list and ends the pass, and the second closes the modal.
  // That ladder is the subject of its own test below; here it is only how this one gets out.
  await dashboard.keyboard.press("Escape");
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
  await expect(repoAsk(dialog)).toBeVisible();
  // The caret is in the repo field rather than the task box, which is both halves of the same
  // rule: `Overlay`'s handler is a window listener, so a focused textarea would take a
  // mnemonic as a letter and advance the pass at the same time - and the question being asked
  // here is answered BY a text field, so that field is where the keys have to arrive.
  await expect(repoField(dialog)).toBeFocused();
  await expect(taskBox(dialog)).not.toBeFocused();
});

test("turning Guided off mid-pass hands back today's form", async ({ dashboard }) => {
  const dialog = await openGuidedAtKind(dashboard);
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

  // And the switch goes with them. Left on screen it would be live and inert - clicking it
  // saves the preference and starts nothing, which is the one thing the switch exists to
  // avoid being.
  await expect(dialog.getByRole("switch", { name: "Guided" })).toHaveCount(0);

  // Back in Single it is offered again, still on - but it does not restart the pass, which
  // ended rather than paused.
  await dialog.getByRole("radio", { name: "Single agent" }).click();
  await expect(dialog.getByRole("switch", { name: "Guided" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(rail(dialog)).toBeHidden();
});

test("a backlog task opened for edit never enters the pass", async ({ dashboard, daemon }) => {
  const first = await openDispatch(dashboard);
  await first.getByRole("switch", { name: "Guided" }).click();
  await expect(rail(first)).toBeVisible();
  // Twice: the pass opens on the Repo question, where the first press closes the combobox's
  // list and ends the pass and the second closes the modal.
  await dashboard.keyboard.press("Escape");
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
