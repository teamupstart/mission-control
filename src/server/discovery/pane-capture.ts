import type { PaneHandles } from "@shared/pane.ts";
import { bindSession } from "../terminal/registry.ts";

/**
 * Reading a terminal pane's visible text - the one primitive every "what is this session
 * actually showing?" question is built on.
 *
 * Its own module rather than a member of either reader because BOTH of them need it and
 * they need each other: `pane-mode` parses the footer, `pane-dialog` parses the menu, and
 * `annotatePaneState` feeds one capture to both (a dialog replaces the footer, so the two
 * parses are complementary reads of the same screen). Left in `pane-mode`, that pairing is
 * an import cycle between the two parsers - which ESM would tolerate today and break on
 * the first module-level statement anyone adds to either file.
 */

/**
 * The pane handles we can capture text from - the SAME type `paneToken` keys on, so
 * "what can be captured" and "what can be addressed" cannot drift into two answers.
 * Re-exported so this module's importers keep reaching it where they always have.
 */
export type { PaneHandles } from "@shared/pane.ts";

/**
 * Capture a pane's visible text, or null when there is none to be had.
 *
 * Null covers three different situations, and collapsing them further would be the bug:
 * the session has no pane, the backend holding it cannot screen-scrape at all (Ghostty has
 * no scripting CLI, so `capture` is a declared null), or the read was attempted and failed.
 * What they share is that nothing was SEEN, and every caller here already treats that as
 * evidence in neither direction rather than as a blank screen: `annotatePaneState` rides
 * the last dialog forward for a few ticks and then admits it has lost the pane,
 * `awaitPasteSubmitted` refuses to read a null as a cleared composer, and the pane route
 * hands the dashboard a null. Returning `""` instead - which is what a stubbed-out capture
 * would naturally produce - would tell all three that the screen is empty, which reads as
 * "no dialog", "the paste was submitted" and "this session is showing nothing".
 *
 * Which backend answers is `bindPane`'s decision, not this function's: the multiplexer pane
 * is the agent's real one, and the emulator handle addresses the client displaying it.
 */
export async function capturePaneText(session: PaneHandles): Promise<string | null> {
  const pane = bindSession(session);
  if (!pane?.capture) return null;
  return pane.capture();
}
