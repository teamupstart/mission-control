import type { PermissionMode } from "@shared/types.ts";
import type { DialogFormSpec, DialogSpec, ModeLineSpec, TuiSpec } from "../types.ts";

// How Claude Code's screen reads. Every token below was matched off a real capture rather
// than modelled from documentation, because this is a TUI we do not own and cannot query -
// see `test/fixtures/claude-panes.ts` for the captures the parser is pinned against.
//
// PARSING only. How a turn is delivered is `control`'s question.

/**
 * How many trailing non-empty lines may hold the mode line. It is the last one in practice;
 * the small margin absorbs any trailing notice Claude adds without opening the window wide
 * enough for transcript prose to be misread as a mode.
 */
const FOOTER_SCAN_LINES = 3;

/** The glyphs Claude prefixes the mode line with (`⏸` when passive, `⏵⏵` when acting). */
const MODE_GLYPHS = /^[⏸⏵]+\s*/u;

/** Claude's footer wording for each mode, matched after the glyph is stripped. */
const FOOTER_MODES: ReadonlyArray<readonly [RegExp, PermissionMode]> = [
  [/^manual mode on\b/, "default"],
  [/^accept edits on\b/, "acceptEdits"],
  [/^plan mode on\b/, "plan"],
  [/^auto mode on\b/, "auto"],
  [/^bypass permissions on\b/, "bypassPermissions"],
  [/^don't ask on\b/, "dontAsk"],
];

/**
 * A glyph-prefixed line naming a mode this build doesn't recognize - a newer Claude's
 * wording, or a mode gated behind a flag we couldn't observe. We can't label it, but it's
 * still a real position in the Shift+Tab cycle, so the walk in `setPermissionMode` must be
 * able to step *through* it rather than give up.
 */
const UNKNOWN_MODE_LINE = /^[a-z' ]{3,24} on\b/;

/** How long to wait for the TUI to repaint after a Shift+Tab before calling it swallowed. */
const REPAINT_TIMEOUT_MS = 900;

/**
 * Cap on Shift+Tabs per request. The longest cycle Claude has is five
 * (manual, accept edits, plan, bypass, auto), so anything beyond six steps means
 * loop detection already should have fired - this is a backstop, not a budget.
 */
const MAX_CYCLE_STEPS = 6;

const CLAUDE_MODE_LINE: ModeLineSpec = {
  scanLines: FOOTER_SCAN_LINES,
  glyphs: MODE_GLYPHS,
  modes: FOOTER_MODES,
  unknownMode: UNKNOWN_MODE_LINE,
  maxCycleSteps: MAX_CYCLE_STEPS,
};

/**
 * Claude's multi-select `AskUserQuestion` vocabulary.
 *
 * Note this survives the ask channel (`src/server/ask-channel.ts`), which disallows the
 * built-in `AskUserQuestion` on sessions the harness DISPATCHES. A session a human started
 * never gets those flags, so it still renders these forms, and every permission prompt on
 * every session still renders a menu regardless. The grammar is not dead code.
 */
const CLAUDE_FORM: DialogFormSpec = {
  /**
   * Two, not one. A real multi-select always clears it - `AskUserQuestion` appends its own
   * "Type something" row with a box of its own, so even a one-option question renders two -
   * while a lone `[ ]` is as likely to be a permission prompt quoting a command that
   * contains one. Getting that wrong is not cosmetic: it would strip the brackets out of a
   * label the human is asked to confirm, and route their click down the form path.
   *
   * That trailing row is counted here and only here: it is what proves the screen is a
   * form, but `freeTextRow` keeps it out of the ANSWERABLE rows, so a one-option question
   * still parses as a form with exactly one box to tick.
   */
  minCheckboxRows: 2,
  checkedBox: /[✔✓xX]/u,
  submitRow: /^submit answers$/i,
  /**
   * Claude's trailing row on a multi-select - the one that opens a text field. It renders a
   * box like every other row, and it is NOT a box: ticking it selects nothing. Measured
   * live, a form with it ticked and no text typed still met "You have not answered all
   * questions" on the review tab.
   */
  freeTextRow: /^type something\.?$/i,
  unansweredWarning: /have not answered all questions/i,
};

/** U+276F, the row an Enter would land on. */
const CLAUDE_DIALOG: DialogSpec = { cursor: "❯", form: CLAUDE_FORM };

export const claudeTui: TuiSpec = {
  repaintTimeoutMs: REPAINT_TIMEOUT_MS,
  modeLine: CLAUDE_MODE_LINE,
  dialog: CLAUDE_DIALOG,
};
