import { claudeTui } from "../src/server/harness/claude/tui.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasUnansweredWarning,
  optionRowMiss,
  parsePaneDialog,
  sameOptionLabel,
  submitAnswersRow,
} from "../src/server/discovery/pane-dialog.ts";
import { dialogIdentity } from "../src/shared/session.ts";

// The dialog spec the REGISTRY actually holds, not a test-local copy: this suite exists to
// catch our model of a TUI drifting from the TUI, and a fixture checked against a spec the
// daemon does not use would certify a grammar nobody runs.
const CLAUDE_DIALOG = claudeTui.dialog!;

import {
  ASK_USER_QUESTION,
  CURSOR_ON_THIRD,
  MULTI_SELECT,
  PERMISSION,
  REVIEW_UNANSWERED,
  TRUST,
  TRUST_QUESTION,
  TRUST_UNWRAPPED,
} from "./fixtures/claude-panes.ts";

// Reading a Claude option dialog off a pane. Every fixture is a VERBATIM tmux
// capture-pane of a real Claude session, not a hand-written approximation - the bug this
// closes was a hand-written model of a TUI we don't own disagreeing with the TUI, so a
// fixture that agrees with the parser because the same author imagined both would lock in
// exactly the failure. They live in ./fixtures/claude-panes.ts; recapture them there.

test("reads every row of a live AskUserQuestion menu, in rendered order", () => {
  const d = parsePaneDialog(ASK_USER_QUESTION, CLAUDE_DIALOG);
  assert.ok(d);
  assert.deepEqual(
    d.options.map((o) => o.number),
    [1, 2, 3, 4, 5],
  );
  assert.equal(d.options[1]?.label, "SQLite");
  assert.equal(d.highlighted, 1);
});

test("a row's description is not mistaken for a row", () => {
  const d = parsePaneDialog(ASK_USER_QUESTION, CLAUDE_DIALOG);
  // The label is the row's own text; the prose under it belongs to no row.
  assert.equal(d?.options[0]?.label, "Postgres");
  assert.equal(d?.options.length, 5);
});

test("reads a permission prompt, cursor on the default", () => {
  const d = parsePaneDialog(PERMISSION, CLAUDE_DIALOG);
  assert.equal(d?.highlighted, 1);
  assert.equal(d?.options.length, 3);
  assert.equal(d?.options[2]?.label, "No");
});

test("reads the two-row trust check", () => {
  const d = parsePaneDialog(TRUST, CLAUDE_DIALOG);
  assert.equal(d?.options.length, 2);
  assert.equal(d?.highlighted, 1);
});

test("the cursor is read, never assumed to be row 1", () => {
  assert.equal(parsePaneDialog(CURSOR_ON_THIRD, CLAUDE_DIALOG)?.highlighted, 3);
});

test("a multi-select is read as a form, box state separate from the label", () => {
  const d = parsePaneDialog(MULTI_SELECT, CLAUDE_DIALOG);
  assert.ok(d);
  assert.equal(d.multiSelect, true);
  assert.deepEqual(
    d.options.map((o) => [o.label, o.checked]),
    [
      ["Alpha", true],
      ["Beta", true],
      ["Gamma", false],
      // Claude's free-text row RENDERS a box and is not one - see below.
      ["Type something", undefined],
      // Its trailing row carries no box at all, so it is a press and not a tick.
      ["Chat about this", undefined],
    ],
  );
});

test("the free-text row is not one of the form's boxes, though it renders as one", () => {
  // Measured live: a form submitted with "Type something" ticked and nothing typed still
  // met "You have not answered all questions". So it is not an answer, and offering it as a
  // tickable box lets a human submit what looks like a choice and get the question back.
  // It also cannot be WALKED to - pressing it opens a field that eats the arrows the submit
  // walk needs - so it is excluded at the parse, where every caller inherits it.
  const d = parsePaneDialog(MULTI_SELECT, CLAUDE_DIALOG)!;
  const free = d.options.find((o) => o.label === "Type something")!;
  assert.equal(free.checked, undefined, "not a checkbox");
  assert.equal(free.label, "Type something", "and the box it renders is still out of the label");
  // Still a form, and still the same boxes: the row counts toward recognizing a form
  // without being answerable on one.
  assert.equal(d.multiSelect, true);
  assert.deepEqual(
    d.options.filter((o) => o.checked !== undefined).map((o) => o.number),
    [1, 2, 3],
  );
});

test("ticking a box does not change what the row IS", () => {
  // The bug this closes: with the box inside the label, a row rendered to the human as
  // "[ ] Gamma" read back as "[✔] Gamma" the moment anything ticked it - including their
  // own previous click - so every later click was refused as a changed screen, and a form
  // that had been sitting there became permanently unanswerable.
  const before = parsePaneDialog(MULTI_SELECT, CLAUDE_DIALOG)!;
  const after = parsePaneDialog(MULTI_SELECT.replace("3. [ ] Gamma", "3. [✔] Gamma"), CLAUDE_DIALOG)!;
  assert.equal(after.options[2]?.checked, true);
  assert.equal(optionRowMiss(after, { number: 3, label: before.options[2]!.label }), null);
  assert.equal(dialogIdentity(after), dialogIdentity(before));
});

test("driver request identity changes without changing pane identity", () => {
  const pane = parsePaneDialog(ASK_USER_QUESTION, CLAUDE_DIALOG)!;
  const paneIdentity = dialogIdentity(pane);
  assert.equal(
    paneIdentity,
    JSON.stringify([pane.prompt ?? "", pane.options.map((option) => [option.number, option.label])]),
  );
  assert.equal(dialogIdentity({ ...pane, source: "pane" }), paneIdentity);
  assert.notEqual(
    dialogIdentity({ ...pane, source: "driver", requestId: "request-one" }),
    dialogIdentity({ ...pane, source: "driver", requestId: "request-two" }),
  );
});

test("a single-select menu is not a form, and parses exactly as it always did", () => {
  for (const capture of [ASK_USER_QUESTION, PERMISSION, TRUST, CURSOR_ON_THIRD]) {
    const d = parsePaneDialog(capture, CLAUDE_DIALOG);
    assert.equal(d?.multiSelect, undefined);
    assert.ok(d?.options.every((o) => o.checked === undefined));
  }
});

test("a lone bracketed row is text, not a checkbox", () => {
  // A permission prompt quoting a command that contains brackets must not have them
  // stripped out of the label the human is asked to confirm, nor be routed to the form
  // path. One box is not a form; a real one always renders several.
  const d = parsePaneDialog(`
Run this command?

❯ 1. [ ] is a test builtin
  2. No

Enter to select · ↑/↓ to navigate · Esc to cancel
`, CLAUDE_DIALOG);
  assert.equal(d?.multiSelect, undefined);
  assert.equal(d?.options[0]?.label, "[ ] is a test builtin");
  assert.equal(d?.options[0]?.checked, undefined);
});

test("the form's Submit tab is recognized, and its warning read", () => {
  const review = parsePaneDialog(REVIEW_UNANSWERED, CLAUDE_DIALOG);
  assert.ok(review);
  assert.equal(submitAnswersRow(review, CLAUDE_DIALOG)?.number, 1);
  assert.ok(hasUnansweredWarning(REVIEW_UNANSWERED, CLAUDE_DIALOG));
  // The question tab is not the Submit tab - stepping onto the next question must not be
  // mistaken for arriving at the send.
  assert.equal(submitAnswersRow(parsePaneDialog(MULTI_SELECT, CLAUDE_DIALOG)!, CLAUDE_DIALOG), null);
  assert.equal(hasUnansweredWarning(MULTI_SELECT, CLAUDE_DIALOG), false);
});

test("the foreground menu wins over an earlier one left in scrollback", () => {
  // Two menus on screen: the one still being shown is the lower. Answering the scrollback
  // would navigate against rows that are no longer live.
  const d = parsePaneDialog(`
❯ 1. Stale choice A
  2. Stale choice B

 ⏺ Done.

  1. Live choice A
❯ 2. Live choice B

Enter to select · ↑/↓ to navigate · Esc to cancel
`, CLAUDE_DIALOG);
  assert.equal(d?.options[1]?.label, "Live choice B");
  assert.equal(d?.highlighted, 2);
});

test("a numbered list in the agent's prose is not a menu", () => {
  // No cursor: nothing is selected because nothing is selectable. Typing at this pane is
  // correct, so reporting a menu here would suppress a legitimate prose reply.
  assert.equal(
    parsePaneDialog(`
⏺ Here's the plan:
  1. Read the config
  2. Fix the parser
  3. Run the tests

 ⏵⏵ accept edits on
`, CLAUDE_DIALOG),
    null,
  );
});

test("a menu whose cursor we cannot see reads as no menu", () => {
  // We could see the rows but not where Enter would land. A caller must take its safe path
  // rather than fire arrows from a guessed position.
  assert.equal(
    parsePaneDialog(`
  1. Yes
  2. No

Enter to select · Esc to cancel
`, CLAUDE_DIALOG),
    null,
  );
});

test("a block that never reaches row 1 is not a menu", () => {
  assert.equal(parsePaneDialog("\n❯ 3. Third\n  4. Fourth\n", CLAUDE_DIALOG), null);
});

test("no pane, no menu", () => {
  assert.equal(parsePaneDialog(null, CLAUDE_DIALOG), null);
  assert.equal(parsePaneDialog("", CLAUDE_DIALOG), null);
});

test("a shell prompt carrying a digit is not a row", () => {
  // `✗ 1 ❯ claude --model haiku` is what the pane shows once Claude has exited - the
  // scrollback above it still holds the menu it died on.
  const d = parsePaneDialog(`
 ❯ 1. Yes, I trust this folder
   2. No, exit

✗ 1 ❯ claude --model haiku
`, CLAUDE_DIALOG);
  // The menu is still parsed (it is on screen), but the prompt line contributed no row.
  assert.equal(d?.options.length, 2);
});

test("option labels match across the viewport's hard wrap", () => {
  // The pane cut the row at the terminal's width; the caller quotes it whole.
  assert.ok(
    sameOptionLabel(
      "Yes, and don’t ask again for: curl -s https://exa",
      "Yes, and don't ask again for: curl -s https://example.com",
    ),
  );
});

test("option labels do not match across different options", () => {
  assert.equal(sameOptionLabel("Yes", "No"), false);
  assert.equal(sameOptionLabel("Revert it; rely on master switch", "Make the tray uninstall durable"), false);
  assert.equal(sameOptionLabel("", "Yes"), false);
});

test("a row the target's label can't be told apart from is refused, not confirmed", () => {
  // The real permission prompt: "Yes" is a prefix of "Yes, and don't ask again for: X", so a
  // caller that miscounts between rows 1 and 2 has its LABEL agree with the wrong row - the
  // exact miscount the label is carried to catch. Neither direction may confirm.
  const menu = parsePaneDialog(PERMISSION, CLAUDE_DIALOG)!;
  assert.equal(
    optionRowMiss(menu, { number: 1, label: "Yes, and don’t ask again for: curl -s https://example.com" }),
    "label-ambiguous",
    "the persistent grant must never be answered as the one-off Yes",
  );
  assert.equal(
    optionRowMiss(menu, { number: 2, label: "Yes" }),
    "label-ambiguous",
    "nor the one-off Yes as the persistent grant",
  );
});

test("every row of the real permission prompt is answerable by its own exact label", () => {
  // The whole menu, row by row, because the prefix pair is the shape Foreman meets most and
  // an ambiguity rule that overshoots here takes the APPROVE direction with it - the one it
  // exists to deliver. Asserting only the row the ambiguity can't touch ("No") is what let a
  // build ship in which Foreman could refuse a permission prompt and never approve one.
  const menu = parsePaneDialog(PERMISSION, CLAUDE_DIALOG)!;
  assert.equal(optionRowMiss(menu, { number: 1, label: "Yes" }), null, "approve once");
  assert.equal(
    optionRowMiss(menu, { number: 2, label: "Yes, and don’t ask again for: curl -s https://example.com" }),
    null,
    "the persistent grant, quoted whole",
  );
  assert.equal(optionRowMiss(menu, { number: 3, label: "No" }), null, "deny");
});

test("an exact label is confirmed even where a partial one would be ambiguous", () => {
  // Row 1's label is a prefix of row 2's, so the >1-row count sees both - but a caller meaning
  // row 2 cannot quote "Yes" exactly, because row 2 does not read "Yes". Reading the row whole
  // is itself the disambiguation, so the count must not run at all on an exact match.
  const menu = parsePaneDialog(PERMISSION, CLAUDE_DIALOG)!;
  assert.equal(optionRowMiss(menu, { number: 1, label: "  yes  " }), null, "normalized, still exact");
  assert.equal(
    optionRowMiss(menu, { number: 2, label: "Yes, and don't ask again for: curl -s https://example.com" }),
    null,
    "an ASCII apostrophe against the pane's typographic one is still exact",
  );
});

test("a wrapped label still confirms its row - the ambiguity check doesn't cost the wrap handling", () => {
  const menu = parsePaneDialog(ASK_USER_QUESTION, CLAUDE_DIALOG)!;
  assert.equal(optionRowMiss(menu, { number: 2, label: "SQLite" }), null);
});

test("optionRowMiss names how the screen failed, so each caller can word it", () => {
  const menu = parsePaneDialog(TRUST, CLAUDE_DIALOG)!;
  assert.equal(optionRowMiss(menu, { number: 9, label: "Yes, I trust this folder" }), "no-such-row");
  assert.equal(optionRowMiss(menu, { number: 2, label: "Yes, I trust this folder" }), "label-differs");
});

// The question and the per-row descriptions. Both are DISPLAY-only reads, added so the
// dashboard can render a dialog the human can actually answer: `optionRowMiss` still
// verifies a selection by label alone, so nothing below can widen what a click confirms.

test("the question above the rows is read, so the dashboard shows what is being asked", () => {
  assert.equal(parsePaneDialog(ASK_USER_QUESTION, CLAUDE_DIALOG)?.prompt, "Which database would you like to use?");
  assert.equal(parsePaneDialog(PERMISSION, CLAUDE_DIALOG)?.prompt, "Do you want to proceed?");
  assert.equal(parsePaneDialog(CURSOR_ON_THIRD, CLAUDE_DIALOG)?.prompt, "Which holder policy do you want?");
});

test("the question wins over nearer text that isn't one", () => {
  // The trust check renders "Security guide" - and a whole sentence about what Claude will
  // be able to do - BETWEEN the question and the rows. Taking the closest block would label
  // the control with "Security guide": confident, wrong, and on the one control that most
  // needs to say what it is agreeing to.
  assert.equal(parsePaneDialog(TRUST, CLAUDE_DIALOG)?.prompt, TRUST_QUESTION);
});

test("a question the terminal wrapped is put back together, not shown as its last fragment", () => {
  // The defect this closes. The `?` falls mid-line at every width Claude renders this at, so
  // an end-of-line anchor matched nothing and the fallback captioned the dialog "Security
  // guide". Finding the line is only half of it: the line the `?` lands on trails off at
  // "...take a moment to", so a caption taken from that line alone would be a sentence
  // fragment where a security question belongs.
  const prompt = parsePaneDialog(TRUST, CLAUDE_DIALOG)?.prompt ?? "";
  assert.ok(prompt.startsWith("Quick safety check:"), prompt);
  assert.ok(prompt.endsWith("review what's in this folder first."), prompt);
  assert.ok(!prompt.includes("Security guide"), "the link is never the question");
  // The continuation line is joined in, rather than the caption stopping where the pane did.
  assert.ok(prompt.includes("take a moment to review"), prompt);
});

test("wrapping is a viewport artifact - the same dialog asks the same thing at any width", () => {
  // Width 180 breaks the question across two lines; width 400 does not. What is being asked
  // did not change, so what the human is shown must not either.
  assert.equal(parsePaneDialog(TRUST_UNWRAPPED, CLAUDE_DIALOG)?.prompt, TRUST_QUESTION);
  assert.equal(parsePaneDialog(TRUST_UNWRAPPED, CLAUDE_DIALOG)?.prompt, parsePaneDialog(TRUST, CLAUDE_DIALOG)?.prompt);
});

test("the rows and the cursor are unchanged by however the question wrapped", () => {
  // The question is display-only; reading it must not disturb what a click is checked
  // against. Both captures still offer the same two rows with the cursor on the default.
  for (const capture of [TRUST, TRUST_UNWRAPPED]) {
    const d = parsePaneDialog(capture, CLAUDE_DIALOG)!;
    assert.deepEqual(
      d.options.map((o) => o.label),
      ["Yes, I trust this folder", "No, exit"],
    );
    assert.equal(d.highlighted, 1);
  }
});

test("a row's description is carried alongside its label, never folded into it", () => {
  const d = parsePaneDialog(ASK_USER_QUESTION, CLAUDE_DIALOG);
  assert.equal(d?.options[0]?.label, "Postgres");
  assert.match(d?.options[0]?.detail ?? "", /^Open-source relational database/);
  // The label stays exactly the row's own text - it is what a selection is checked against.
  assert.equal(optionRowMiss(d!, { number: 1, label: "Postgres" }), null);
});

test("the trailing rows carry no description, and the footer is not mistaken for one", () => {
  const d = parsePaneDialog(ASK_USER_QUESTION, CLAUDE_DIALOG);
  // "Type something." is followed by a rule, "Chat about this" by the blank line above
  // the footer - neither has prose of its own, and the footer belongs to no row.
  assert.equal(d?.options[3]?.detail, undefined);
  assert.equal(d?.options[4]?.detail, undefined);
});

test("a dialog with no descriptions reports none rather than inventing them", () => {
  const d = parsePaneDialog(PERMISSION, CLAUDE_DIALOG);
  assert.ok(d?.options.every((o) => o.detail === undefined));
});
