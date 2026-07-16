import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePaneDialog, sameOptionLabel } from "../src/server/discovery/pane-dialog.ts";

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
