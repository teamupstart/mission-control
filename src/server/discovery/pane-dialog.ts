import { capturePaneText } from "./pane-mode.ts";
import type { Session } from "@shared/types.ts";

/**
 * Read a Claude option dialog - a permission prompt, an `AskUserQuestion` menu, the
 * folder-trust check - off its terminal pane.
 *
 * This exists because prose is not an answer to a menu. Foreman's reply reaches a child
 * through `sendText`, which types the text and presses Enter; measured against the live
 * fleet, a dialog SWALLOWS the typed characters entirely (they are not keybindings and
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

/** One selectable row of an option dialog, as rendered. */
export interface PaneOption {
  /** The number Claude prints on the row (1-based, and its position in the list). */
  number: number;
  /** The row's visible label, whitespace-collapsed. Never the description beneath it. */
  label: string;
}

/** An option dialog as read off a pane. */
export interface PaneDialog {
  /** Every row, ascending. Includes Claude's own trailing rows ("Type something."). */
  options: PaneOption[];
  /** The row the `❯` cursor sits on - where an Enter would land right now. */
  highlighted: number;
}

/**
 * An option row: an optional cursor, the number Claude prints, then the label.
 *
 * The label is required to be non-empty so a bare "1." in prose can't open a block, and
 * the number is bounded to two digits because a dialog's rows are few - an unbounded `\d+`
 * would let a transcript's "2024. was the year" read as row 2024.
 */
const OPTION_ROW = /^\s*(❯)?\s*(\d{1,2})\.\s+(\S.*?)\s*$/u;

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
export function parsePaneDialog(paneText: string | null): PaneDialog | null {
  if (!paneText) return null;
  const lines = paneText.split("\n");

  // Collected bottom-up, so `rows` runs N..1 and reverses into the rendered order.
  const rows: Array<{ number: number; label: string; cursor: boolean }> = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPTION_ROW.exec(lines[i]!);
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
    rows.push({ number, label: m[3]!.replace(/\s+/g, " "), cursor: Boolean(m[1]) });
    if (number === 1) break;
  }

  if (rows.length === 0 || rows[rows.length - 1]!.number !== 1) return null;
  const options = rows.reverse();
  const cursors = options.filter((o) => o.cursor);
  if (cursors.length !== 1) return null;
  return {
    options: options.map((o) => ({ number: o.number, label: o.label })),
    highlighted: cursors[0]!.number,
  };
}

/** Read the option dialog a session's pane is showing, or null when it isn't showing one. */
export async function readPaneDialog(session: Pick<Session, "tmux" | "wezterm">): Promise<PaneDialog | null> {
  return parsePaneDialog(await capturePaneText(session));
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
  const norm = (s: string): string => s.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  const a = norm(rendered);
  const b = norm(wanted);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
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
 * A label matching MORE THAN ONE row is refused. The prefix compare in `sameOptionLabel` is
 * there for wrapping, but a real permission prompt offers exactly this pair:
 *
 *     1. Yes
 *     2. Yes, and don't ask again for: curl -s https://...
 *
 * so a caller that miscounts between those two rows has its label AGREE with the wrong one -
 * precisely the miscount the label is carried to catch. When the label cannot tell the rows
 * apart it has confirmed nothing, and nothing is not enough to answer with. Refusing is the
 * quiet failure (the menu stays up for a human); confirming would be the wrong one.
 */
export function optionRowMiss(
  menu: PaneDialog,
  target: { number: number; label: string },
): OptionRowMiss | null {
  const row = menu.options.find((o) => o.number === target.number);
  if (!row) return "no-such-row";
  if (!sameOptionLabel(row.label, target.label)) return "label-differs";
  if (menu.options.filter((o) => sameOptionLabel(o.label, target.label)).length > 1) {
    return "label-ambiguous";
  }
  return null;
}
