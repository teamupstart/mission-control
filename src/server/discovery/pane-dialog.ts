import type { PaneDialog, PaneOption } from "@shared/types.ts";
import type { DialogSpec } from "../harness/types.ts";

/**
 * Read an agent's option dialog - a permission prompt, an `AskUserQuestion` menu, a
 * folder-trust check - off its terminal pane.
 *
 * The GRAMMAR here is harness-neutral machinery and the vendor's tokens arrive in a
 * `DialogSpec`, which is the same split `transcript.ts` makes: a numbered block with one
 * cursor on it, a question wrapped across a viewport's width, and a label compared across
 * a hard wrap are facts about TERMINALS, not about whose agent drew them. Measured rather
 * than assumed - pointed at real `codex-cli` captures this parser needed exactly one token
 * changed, the cursor glyph, to read all three (`test/fixtures/codex-panes.ts`).
 *
 * This exists because prose is not an answer to a menu. Foreman's reply reaches a child
 * through `sendText`, which types the text and presses Enter; measured against live
 * sessions, a dialog SWALLOWS the typed characters entirely (they are not keybindings and
 * there is no text field focused), leaving the cursor wherever it started - so the Enter
 * confirms the DEFAULT row. The reviewer's actual judgment never reaches the child, and
 * what it gets instead is whatever Claude happened to highlight first, delivered under the
 * human's name. That is not a degraded answer, it is a different one:
 *
 *     reviewer said "Use option 2: make the tray uninstall durable"
 *     child recorded  "Revert it; rely on master switch"      <- option 1, the default
 *
 * The child then acted on the revert and the fix shipped. Nothing in the system noticed,
 * because every layer had done its job: the model judged, the send succeeded, the note
 * stamped "answered". Only the pane knew.
 *
 * So a menu has to be answered the way a human answers one - by moving the cursor onto a
 * row and pressing Enter (`selectPaneOption`) - and that needs the screen parsed into the
 * rows Claude is actually offering. Reading it off the pane rather than modelling Claude's
 * dialogs keeps this honest about a TUI we don't own and can't query: the rows are whatever
 * is on screen right now, in the order shown.
 */

/**
 * The shapes live in `@shared/types.ts` because the dashboard renders these rows for the
 * human to click, so the browser needs them too; re-exported here because this module is
 * where they are PARSED, and every server-side caller already reaches for them by this
 * name.
 */
export type { PaneDialog, PaneOption } from "@shared/types.ts";

/**
 * An option row: an optional cursor, the number Claude prints, an optional checkbox, then
 * the label.
 *
 * The label is required to be non-empty so a bare "1." in prose can't open a block, and
 * the number is bounded to two digits because a dialog's rows are few - an unbounded `\d+`
 * would let a transcript's "2024. was the year" read as row 2024.
 *
 * The checkbox is what a MULTI-SELECT `AskUserQuestion` renders, captured live:
 *
 *     ❯ 1. [✔] Alpha
 *       2. [ ] Beta
 *
 * It is a separate group rather than part of the label because it is STATE, not identity:
 * it flips every time the row is toggled, and the label is what a selection is verified
 * against (`optionRowMiss`). Left in the label, a row the human was shown as "[ ] Beta"
 * reads "[✔] Beta" the moment anything ticks it, so their click is refused as a screen
 * change - see `multiSelect` below for why that made a sitting form permanently
 * unanswerable.
 */
function optionRowFor(cursor: string): RegExp {
  return new RegExp(`^\\s*(${cursor})?\\s*(\\d{1,2})\\.\\s+(?:\\[([ ✔✓xX])\\]\\s+)?(\\S.*?)\\s*$`, "u");
}

/**
 * One compiled row matcher per cursor glyph.
 *
 * Cached because `parsePaneDialog` runs once per session per poll tick, and there are as
 * many distinct matchers as there are harnesses - two - not as many as there are calls.
 * Keyed by the glyph itself so two harnesses that happen to share one share the regex.
 */
const OPTION_ROWS = new Map<string, RegExp>();
function optionRow(cursor: string): RegExp {
  let re = OPTION_ROWS.get(cursor);
  if (!re) OPTION_ROWS.set(cursor, (re = optionRowFor(cursor)));
  return re;
}

/**
 * Parse the option dialog a pane is showing, or null when it isn't showing one.
 *
 * Scans UPWARD from the bottom and takes the first complete block, because the dialog is
 * the foreground - anything numbered above it is scrollback (an earlier menu, a numbered
 * list in the agent's own prose) and must lose to what is on screen now.
 *
 * A block is only accepted when it is numbered exactly 1..N and exactly one row carries the
 * `❯` cursor. Both conditions are what separate a menu from prose that merely looks like
 * one, and the cursor is load-bearing twice over: it is the discriminator, and it is the
 * only way to know where an Enter would land - a caller can't navigate from an unknown
 * position. A menu we can see but can't locate the cursor on is therefore reported as no
 * menu at all, which routes the caller to its safe path rather than to a blind keystroke.
 *
 * Rows need not be adjacent: `AskUserQuestion` prints a description under each row and a
 * separator above its trailing "Chat about this", and those lines are simply not rows.
 */
export function parsePaneDialog(paneText: string | null, spec: DialogSpec): PaneDialog | null {
  if (!paneText) return null;
  const lines = paneText.split("\n");
  const row = optionRow(spec.cursor);

  // Collected bottom-up, so `rows` runs N..1 and reverses into the rendered order.
  const rows: Array<{
    number: number;
    label: string;
    /** The box glyph as rendered, or undefined on a row that carries no checkbox. */
    box: string | undefined;
    cursor: boolean;
    line: number;
  }> = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = row.exec(lines[i]!);
    if (!m) continue;
    const number = Number(m[2]);
    // The next row up must continue the run downward (N, N-1, ...). Anything else means
    // this block never reached 1 and what we're looking at is two unrelated numberings -
    // an old menu above a new one, say. Restart the block here rather than splice them.
    const expected = rows.length === 0 ? number : rows[rows.length - 1]!.number - 1;
    if (number !== expected) {
      rows.length = 0;
      if (number !== 1) continue;
    }
    rows.push({
      number,
      label: m[4]!.replace(/\s+/g, " "),
      box: m[3],
      cursor: Boolean(m[1]),
      line: i,
    });
    if (number === 1) break;
  }

  if (rows.length === 0 || rows[rows.length - 1]!.number !== 1) return null;
  const options = rows.reverse();
  const cursors = options.filter((o) => o.cursor);
  if (cursors.length !== 1) return null;
  // A harness with no form vocabulary has no multi-select to detect: every dialog it draws
  // is single-select, so a bracketed row is the row's own text and stays in the label. That
  // is the same path a Claude permission prompt quoting a `[ ]` already takes.
  const form = spec.form;
  const multiSelect =
    form !== null && options.filter((o) => o.box !== undefined).length >= form.minCheckboxRows;
  const prompt = readPrompt(lines, options[0]!.line);
  return {
    options: options.map((o, k) => {
      const detail = readDetail(lines, o.line, options[k + 1]?.line ?? lines.length);
      // A checkbox is only READ as one on a form that has several - see `minCheckboxRows`.
      // Anywhere else the brackets are the row's own text and belong in the label, which
      // keeps every single-select dialog parsing byte-for-byte as it did before.
      const onForm = multiSelect && o.box !== undefined;
      // ...and the free-text row is on a form without being answerable on one, so it comes
      // out of the label like any other box but is reported with no `checked` at all.
      const boxed = onForm && !form!.freeTextRow.test(o.label);
      return {
        number: o.number,
        label: onForm ? o.label : restoreBox(o),
        ...(detail ? { detail } : {}),
        ...(boxed ? { checked: form!.checkedBox.test(o.box!) } : {}),
      };
    }),
    highlighted: cursors[0]!.number,
    ...(multiSelect ? { multiSelect: true } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

/** Put a box back into the label, for a row parsed on a dialog that isn't a form. */
function restoreBox(row: { label: string; box: string | undefined }): string {
  return row.box === undefined ? row.label : `[${row.box}] ${row.label}`;
}

/** A horizontal rule - `AskUserQuestion` draws one above its trailing "Chat about this". */
const RULE = /^[\s─━―—–_=-]+$/u;

/**
 * How far above the rows the question may sit. Bounded because everything further up is
 * the transcript: an unbounded walk turns the agent's last paragraph into the "question",
 * which is worse than showing none - it reads as authoritative and is merely nearby.
 */
const PROMPT_SCAN_LINES = 8;

/**
 * The question the rows are answering, read off the lines above them, or undefined when
 * there is nothing that looks like one.
 *
 * Display only, and deliberately so - `optionRowMiss` verifies a selection by LABEL alone,
 * so nothing here can widen or narrow what a click is allowed to confirm. It exists
 * because the labels by themselves frequently aren't an answerable question: a permission
 * prompt's rows read "Yes" / "Yes, and don't ask again" / "No", which tells a human
 * nothing about what they'd be approving.
 *
 * Anchored on the question mark rather than on proximity, because the nearest text above
 * the rows is routinely NOT the question. The folder-trust check renders
 *
 *     Quick safety check: Is this a project you created or one you trust? (Like your own
 *     code, a well-known open source project, or work from your team). If not, take a
 *     moment to review what's in this folder first.
 *
 *     Claude Code'll be able to read, edit, and execute files here.
 *
 *     Security guide
 *
 *     ❯ 1. Yes, I trust this folder
 *
 * where a walk that simply took the closest non-blank block would announce "Security
 * guide" as the question - a confident, wrong label on the one control that matters.
 *
 * The `?` may sit ANYWHERE in the line, not just at its end, because the pane hard-wraps:
 * on a real terminal the trust question breaks mid-sentence, so no line ends with `?` at
 * all and an end-anchored scan finds nothing - falling through to the adjacent block and
 * captioning the dialog "Security guide", the exact label this anchor exists to avoid.
 * Matching anywhere finds the line; `joinBlock` is what makes it readable, because the
 * line the `?` lands on is a FRAGMENT of the question rather than the question.
 *
 * Falling back to the adjacent block only when there is no `?` keeps a question worded as
 * an instruction from yielding nothing.
 */
function readPrompt(lines: string[], firstRow: number): string | undefined {
  const top = Math.max(0, firstRow - PROMPT_SCAN_LINES);
  for (let i = firstRow - 1; i >= top; i--) {
    if (lines[i]!.includes("?")) return joinBlock(lines, i, top, firstRow) || undefined;
  }
  let i = firstRow - 1;
  while (i >= top && !lines[i]!.trim()) i--;
  return i >= top ? joinBlock(lines, i, top, firstRow) || undefined : undefined;
}

/**
 * The whole wrapped paragraph that line `at` belongs to, joined back into one string.
 *
 * Expanded in BOTH directions from the anchor, to the paragraph's own bounds - a blank line
 * or a rule on either side. The pane is a viewport, so a question reaches us broken across
 * however many lines the terminal's width forced; the `?` lands on whichever fragment
 * happened to contain it, which is as likely to be "...take a moment to" as anything
 * answerable. Reassembling the paragraph is what turns that back into the question a human
 * is being asked.
 *
 * Bounded by `top` above and by the first option row below, so it can neither climb into
 * the transcript nor swallow the menu it is captioning.
 */
function joinBlock(lines: string[], at: number, top: number, end: number): string {
  let start = at;
  while (start - 1 >= top && isProse(lines[start - 1]!)) start--;
  let stop = at;
  while (stop + 1 < end && isProse(lines[stop + 1]!)) stop++;
  return lines
    .slice(start, stop + 1)
    .map((l) => l.trim())
    .join(" ");
}

/** Whether a line is part of a paragraph rather than one of the bounds of one. */
function isProse(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && !RULE.test(trimmed);
}

/**
 * The description Claude prints beneath a row, or undefined when it prints none.
 *
 * Bounded by the next row and by the first blank line, which is what keeps the LAST row's
 * description from swallowing the footer ("Enter to select · ↑/↓ to navigate") - there is
 * no next row to stop it. Rules are skipped rather than collected for the same reason they
 * aren't rows: the one above "Chat about this" is chrome, not text about an option.
 */
function readDetail(lines: string[], row: number, nextRow: number): string | undefined {
  const block: string[] = [];
  for (let i = row + 1; i < nextRow; i++) {
    const line = lines[i]!.trim();
    if (!line) break;
    if (RULE.test(line)) continue;
    block.push(line);
  }
  return block.length ? block.join(" ") : undefined;
}

/**
 * A multi-select `AskUserQuestion` is a FORM, and a form is not sent by answering it.
 *
 * Ticking boxes commits nothing; the answers leave for Claude only when the last tab -
 * "✔ Submit", reached with `→` from the last question - is confirmed:
 *
 *     ←  ☒ Features  ✔ Submit  →
 *
 *     Review your answers
 *      ● Which features would you like to enable?
 *        → Beta, Alpha
 *
 *     Ready to submit your answers?
 *     ❯ 1. Submit answers
 *       2. Cancel
 *
 * The two readers below are how the submit walk knows it has ARRIVED there (rather than
 * on the next question's tab) and whether it may press the row when it has. Both are
 * matched on the agent's OWN words - the tab is a screen we can see and not a state we can
 * query - so they arrive on `DialogFormSpec` rather than being spelled here, and a harness
 * whose menus are all single-select declares `form: null` instead of inheriting nouns from
 * an agent whose chrome it does not share.
 */

/**
 * The review tab's send row, or null when this dialog is not the review tab (or this
 * harness has no forms, in which case there is no such row by declaration).
 */
export function submitAnswersRow(dialog: PaneDialog, spec: DialogSpec): PaneOption | null {
  const form = spec.form;
  if (!form) return null;
  return dialog.options.find((o) => form.submitRow.test(o.label.trim())) ?? null;
}

/**
 * Whether the review tab is saying some question still has no answer.
 *
 * Read off the raw pane rather than the parsed dialog because it is a banner above the
 * rows, outside the question `readPrompt` captures. It is a REFUSAL condition for the
 * submit walk: the agent will happily send a half-filled form, and a walk that pressed
 * through this would answer, in the human's name, questions they were never shown.
 *
 * A harness with no forms answers false: it has no such banner, and inventing one from
 * another agent's wording is how a screen nobody can produce becomes a refusal nobody can
 * clear.
 */
export function hasUnansweredWarning(paneText: string | null, spec: DialogSpec): boolean {
  const form = spec.form;
  if (!form || paneText === null) return false;
  return form.unansweredWarning.test(paneText);
}

/**
 * Whether a row's rendered label and the label a caller is aiming at are the same option.
 *
 * Compared by normalized prefix rather than equality because the pane is a VIEWPORT: it
 * hard-wraps, so a long row ("Yes, and don't ask again for: curl -s https://...") reaches
 * us cut at the terminal's width, while the caller's copy of it may be whole - or the other
 * way round, when the caller quotes only the part it read. Either can be the prefix.
 *
 * Typographic apostrophes are folded to ASCII: Claude renders "don't" with U+2019, and a
 * model quoting the row back in JSON routinely types the ASCII one. That difference is not
 * a different option, but a strict compare would call it one - and the caller's fail-safe
 * on a mismatch is to send nothing, so this would read as Foreman going quiet.
 */
export function sameOptionLabel(rendered: string, wanted: string): boolean {
  const a = norm(rendered);
  const b = norm(wanted);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Fold a label to the form the compares below use: ASCII apostrophes, one space, no case. */
function norm(s: string): string {
  return s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Why a target row is not the row the menu is showing, in the caller's own words. */
export type OptionRowMiss =
  /** The menu has no row with that number. */
  | "no-such-row"
  /** The row is there, but it doesn't read like the label the caller is aiming at. */
  | "label-differs"
  /** The label fits more than one row, so it can't tell which one was meant. */
  | "label-ambiguous";

/**
 * Whether a target row is the row this menu is showing at that number, and if not, why.
 *
 * One home for the rule because two callers apply it to the same screen and must agree:
 * `menuMismatch` decides whether an answer can be delivered at all, and `selectPaneOption`
 * re-checks it against a fresh read before the Enter. Duplicated, it is a rule that can drift
 * in one place and not the other - and the half that drifts loose is the half that confirms a
 * row nobody chose.
 *
 * An INEXACT label matching more than one row is refused. The prefix compare in
 * `sameOptionLabel` is there for wrapping, but a real permission prompt offers exactly this
 * pair:
 *
 *     1. Yes
 *     2. Yes, and don't ask again for: curl -s https://...
 *
 * so a caller that miscounts between those two rows has its label AGREE with the wrong one -
 * precisely the miscount the label is carried to catch. When a partial label cannot tell the
 * rows apart it has confirmed nothing, and nothing is not enough to answer with. Refusing is
 * the quiet failure (the menu stays up for a human); confirming would be the wrong one.
 *
 * An EXACT match is unambiguous by construction, and is let through before that count is even
 * taken. The prefix compare exists ONLY to tolerate a wrap, so a label that needed no
 * tolerance was read whole off the row it names: a caller meaning row 2 above cannot quote
 * row 1's label exactly, because row 2's rendered text is not "Yes". Without this the two
 * rows that pair is FOR - the approve rows - are both unanswerable, which is every Bash
 * permission prompt on the dashboard: quiet on an ambiguous miscount is the trade this makes,
 * quiet on an exact, correct answer would be Foreman unable to approve anything at all.
 */
export function optionRowMiss(
  menu: PaneDialog,
  target: { number: number; label: string },
): OptionRowMiss | null {
  const row = menu.options.find((o) => o.number === target.number);
  if (!row) return "no-such-row";
  if (!sameOptionLabel(row.label, target.label)) return "label-differs";
  if (norm(row.label) === norm(target.label)) return null;
  if (menu.options.filter((o) => sameOptionLabel(o.label, target.label)).length > 1) {
    return "label-ambiguous";
  }
  return null;
}

/**
 * Say which way the dialog failed to be the one the caller was told to answer.
 *
 * Beside the predicate rather than beside either caller, now that there are two answering
 * paths: the pane walk re-reads a screen, the driver path re-reads the request the card was
 * drawn from, and both owe the human the same sentence. "The screen changed" is deliberately
 * neutral about which of the two it was - what the reader needs to know is that nothing was
 * pressed and the question is still theirs to answer.
 */
export function describeOptionRowMiss(
  miss: OptionRowMiss,
  dialog: PaneDialog,
  target: { number: number; label: string },
): string {
  switch (miss) {
    case "no-such-row":
      return `this menu has no option ${target.number}`;
    case "label-differs": {
      const row = dialog.options.find((o) => o.number === target.number);
      return `option ${target.number} now reads "${row?.label}" - the screen changed`;
    }
    case "label-ambiguous":
      return `"${target.label}" reads the same as another row on this menu`;
  }
}
