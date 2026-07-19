import { test } from "node:test";
import assert from "node:assert/strict";
import { optionRowMiss, parsePaneDialog, sameOptionLabel } from "../src/server/discovery/pane-dialog.ts";

// Reading a Claude option dialog off a pane. Every fixture here is a VERBATIM tmux
// capture-pane of a real Claude session, not a hand-written approximation - the bug this
// closes was a hand-written model of a TUI we don't own disagreeing with the TUI, so a
// fixture that agrees with the parser because the same author imagined both would lock in
// exactly the failure. Recapture them against a real session when Claude's chrome moves.

/**
 * `AskUserQuestion`, captured live. The shape that produced the production bug: rows carry
 * a description underneath, Claude appends its own "Type something." / "Chat about this"
 * rows, and a separator rule sits between them - so the rows are NOT adjacent lines.
 */
const ASK_USER_QUESTION = `
 ☐ Database

Which database would you like to use?

❯ 1. Postgres
     Open-source relational database with advanced features, excellent for production applications
  2. SQLite
     Lightweight, file-based database, great for development and simple deployments
  3. MySQL
     Popular open-source relational database, widely supported and easy to set up
  4. Type something.
────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

/** A permission prompt, captured live. Note the footer shares no wording with the menu's. */
const PERMISSION = `
 Bash command

   curl -s https://example.com | head -1
   Fetch example.com and show first line

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don’t ask again for: curl -s https://example.com
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`;

/** The folder-trust check, captured live - the two-row shape, cursor on the default. */
const TRUST = `
 Quick safety check: Is this a project you created or one you trust?

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

/**
 * A live-fleet menu whose cursor rests on the LAST row, not the first. Claude does not
 * always default to row 1, which is why navigation is computed from the cursor we read
 * rather than assumed to start at the top.
 */
const CURSOR_ON_THIRD = `
 ☐ Holder policy

Which holder policy do you want?

  1. Only reap fleet-control leases (Recommended)
     Reap only leases whose recorded holder is 'fleet-control'.
  2. Reap any holder, but only repos we know
     Keep reaping regardless of holder, but drop the workspace-wide scan.
❯ 3. Keep as-is (any holder, workspace-wide)
     Ship current behavior: maximum reclamation.

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

test("reads every row of a live AskUserQuestion menu, in rendered order", () => {
  const d = parsePaneDialog(ASK_USER_QUESTION);
  assert.ok(d);
  assert.deepEqual(
    d.options.map((o) => o.number),
    [1, 2, 3, 4, 5],
  );
  assert.equal(d.options[1]?.label, "SQLite");
  assert.equal(d.highlighted, 1);
});

test("a row's description is not mistaken for a row", () => {
  const d = parsePaneDialog(ASK_USER_QUESTION);
  // The label is the row's own text; the prose under it belongs to no row.
  assert.equal(d?.options[0]?.label, "Postgres");
  assert.equal(d?.options.length, 5);
});

test("reads a permission prompt, cursor on the default", () => {
  const d = parsePaneDialog(PERMISSION);
  assert.equal(d?.highlighted, 1);
  assert.equal(d?.options.length, 3);
  assert.equal(d?.options[2]?.label, "No");
});

test("reads the two-row trust check", () => {
  const d = parsePaneDialog(TRUST);
  assert.equal(d?.options.length, 2);
  assert.equal(d?.highlighted, 1);
});

test("the cursor is read, never assumed to be row 1", () => {
  assert.equal(parsePaneDialog(CURSOR_ON_THIRD)?.highlighted, 3);
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
`);
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
`),
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
`),
    null,
  );
});

test("a block that never reaches row 1 is not a menu", () => {
  assert.equal(parsePaneDialog("\n❯ 3. Third\n  4. Fourth\n"), null);
});

test("no pane, no menu", () => {
  assert.equal(parsePaneDialog(null), null);
  assert.equal(parsePaneDialog(""), null);
});

test("a shell prompt carrying a digit is not a row", () => {
  // `✗ 1 ❯ claude --model haiku` is what the pane shows once Claude has exited - the
  // scrollback above it still holds the menu it died on.
  const d = parsePaneDialog(`
 ❯ 1. Yes, I trust this folder
   2. No, exit

✗ 1 ❯ claude --model haiku
`);
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
  const menu = parsePaneDialog(PERMISSION)!;
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
  const menu = parsePaneDialog(PERMISSION)!;
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
  const menu = parsePaneDialog(PERMISSION)!;
  assert.equal(optionRowMiss(menu, { number: 1, label: "  yes  " }), null, "normalized, still exact");
  assert.equal(
    optionRowMiss(menu, { number: 2, label: "Yes, and don't ask again for: curl -s https://example.com" }),
    null,
    "an ASCII apostrophe against the pane's typographic one is still exact",
  );
});

test("a wrapped label still confirms its row - the ambiguity check doesn't cost the wrap handling", () => {
  const menu = parsePaneDialog(ASK_USER_QUESTION)!;
  assert.equal(optionRowMiss(menu, { number: 2, label: "SQLite" }), null);
});

test("optionRowMiss names how the screen failed, so each caller can word it", () => {
  const menu = parsePaneDialog(TRUST)!;
  assert.equal(optionRowMiss(menu, { number: 9, label: "Yes, I trust this folder" }), "no-such-row");
  assert.equal(optionRowMiss(menu, { number: 2, label: "Yes, I trust this folder" }), "label-differs");
});

// The question and the per-row descriptions. Both are DISPLAY-only reads, added so the
// dashboard can render a dialog the human can actually answer: `optionRowMiss` still
// verifies a selection by label alone, so nothing below can widen what a click confirms.

test("the question above the rows is read, so the dashboard shows what is being asked", () => {
  assert.equal(parsePaneDialog(ASK_USER_QUESTION)?.prompt, "Which database would you like to use?");
  assert.equal(parsePaneDialog(PERMISSION)?.prompt, "Do you want to proceed?");
  assert.equal(parsePaneDialog(CURSOR_ON_THIRD)?.prompt, "Which holder policy do you want?");
});

test("the question wins over nearer text that isn't one", () => {
  // The trust check renders a "Security guide" line BETWEEN the question and the rows.
  // Taking the closest block would label the control with it - confident and wrong.
  assert.equal(
    parsePaneDialog(TRUST)?.prompt,
    "Quick safety check: Is this a project you created or one you trust?",
  );
});

test("a row's description is carried alongside its label, never folded into it", () => {
  const d = parsePaneDialog(ASK_USER_QUESTION);
  assert.equal(d?.options[0]?.label, "Postgres");
  assert.match(d?.options[0]?.detail ?? "", /^Open-source relational database/);
  // The label stays exactly the row's own text - it is what a selection is checked against.
  assert.equal(optionRowMiss(d!, { number: 1, label: "Postgres" }), null);
});

test("the trailing rows carry no description, and the footer is not mistaken for one", () => {
  const d = parsePaneDialog(ASK_USER_QUESTION);
  // "Type something." is followed by a rule, "Chat about this" by the blank line above
  // the footer - neither has prose of its own, and the footer belongs to no row.
  assert.equal(d?.options[3]?.detail, undefined);
  assert.equal(d?.options[4]?.detail, undefined);
});

test("a dialog with no descriptions reports none rather than inventing them", () => {
  const d = parsePaneDialog(PERMISSION);
  assert.ok(d?.options.every((o) => o.detail === undefined));
});
