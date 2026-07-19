// VERBATIM `tmux capture-pane` output from real Claude sessions - not hand-written
// approximations of a TUI we don't own.
//
// Shared rather than copied per test file on purpose. Two suites read these captures
// (the dialog parser and the drawer's one-line preview), and the whole class of bug they
// guard against is our model of Claude's chrome drifting away from Claude's chrome. Two
// copies means one gets recaptured and the other quietly goes on certifying the old
// shape. Recapture them here, once, when Claude's chrome moves.

/**
 * `AskUserQuestion`, captured live. The shape that produced the production bug: rows carry
 * a description underneath, Claude appends its own "Type something." / "Chat about this"
 * rows, and a separator rule sits between them - so the rows are NOT adjacent lines.
 */
export const ASK_USER_QUESTION = `
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
export const PERMISSION = `
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

/**
 * The folder-trust check, captured live at tmux width 180 - the two-row shape, cursor on
 * the default.
 *
 * The question WRAPS here, which is the point: the terminal breaks it mid-sentence, so the
 * `?` sits in the middle of a line and the line itself trails off at "...take a moment to".
 * An earlier hand-written version of this fixture put the question on one tidy line ending
 * in `?`, which is exactly the fixture-agrees-with-the-parser failure the header above
 * warns about - it passed while the real terminal captioned this dialog "Security guide".
 */
export const TRUST = `
 Accessing workspace:

 /private/var/folders/1c/djbypfjn4px99pjhhdj8xhyc0000gn/T/tmp.FrDjmgBVzT

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to
 review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

/**
 * The same dialog captured at width 400, where the question fits on one line.
 *
 * Kept alongside the wrapped capture because the two ends of the range fail differently:
 * this one never wrapped, and STILL does not end in `?` - the sentence continues past it
 * to "...folder first." So the question mark being the last character on its line is not
 * something either width delivers, and a scan anchored on the end of a line reads neither.
 */
export const TRUST_UNWRAPPED = `
 Accessing workspace:

 /private/var/folders/1c/djbypfjn4px99pjhhdj8xhyc0000gn/T/tmp.soBSopFaYg

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

/** What both captures above are asking, however the terminal happened to break it. */
export const TRUST_QUESTION =
  "Quick safety check: Is this a project you created or one you trust? (Like your own code, " +
  "a well-known open source project, or work from your team). If not, take a moment to " +
  "review what's in this folder first.";

/**
 * A live-fleet menu whose cursor rests on the LAST row, not the first. Claude does not
 * always default to row 1, which is why navigation is computed from the cursor we read
 * rather than assumed to start at the top.
 */
export const CURSOR_ON_THIRD = `
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
