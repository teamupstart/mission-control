/**
 * Spot a paste that is sitting in Claude's composer unsubmitted.
 *
 * Claude collapses a MULTI-LINE paste into a placeholder instead of echoing the
 * body, and prints it where the prompt text would be:
 *
 *     ❯ [Pasted text #1 +3 lines]
 *
 * That placeholder is the one honest, on-screen answer to "did the Enter we sent
 * actually submit?". `injectPrompt` cannot learn it any other way: tmux reports
 * that the bytes were written, never what the TUI did with them, and a pty
 * swallows an Enter as happily as it delivers one.
 *
 * Reading it is what lets the submit retry be gated on POSITIVE evidence. An
 * unconditional second Enter is the hazard `reload.ts` documents at length - if a
 * dialog is foreground, Enter answers it on the operator's behalf. Seeing the
 * placeholder proves the composer (not a dialog) is what has focus, so the only
 * thing a second Enter can do is submit the text we just pasted.
 *
 * A single-line paste is never collapsed, so it never produces a placeholder -
 * and it is also never affected by the coalescing window this guards against.
 * "No placeholder" therefore reads as "nothing pending", which is correct for
 * both cases.
 */

/**
 * How many trailing non-empty lines may hold the composer. The placeholder sits
 * just above Claude's footer; the margin covers the mode line and a notice or
 * two without opening the window wide enough for transcript prose to match.
 */
const COMPOSER_SCAN_LINES = 8;

/**
 * Claude's collapsed-paste placeholder. The number is the paste's index within
 * the turn, so it climbs as pastes accumulate and cannot be pinned to 1.
 */
const PASTED_PLACEHOLDER = /\[Pasted text #\d+/;

/**
 * Whether a pane capture shows a collapsed paste still waiting in the composer.
 *
 * Null (a capture that failed, or a session with no pane) reads as false: with
 * nothing on screen there is no evidence, and this gates a keystroke that must
 * fire only on evidence.
 */
export function hasPendingPaste(paneText: string | null): boolean {
  if (!paneText) return false;
  return composerLines(paneText).some((l) => PASTED_PLACEHOLDER.test(l));
}

/**
 * Whether a slash command we typed is still sitting in the composer, unacted on.
 *
 * The caller that needs this is a `/clear` with a prompt queued up behind it. `sendText`
 * returns as soon as tmux has taken the keystrokes, which says nothing about whether
 * Claude has processed the command yet - and a `/clear` processed AFTER the next prompt
 * is pasted wipes that prompt off the screen, leaving a task marked running with nothing
 * running it. Seeing the command leave the composer is the only on-screen evidence that
 * the agent actually acted on it.
 *
 * Scoped to the composer lines for the same reason `hasPendingPaste` is: the command
 * being ECHOED somewhere up in the transcript is history, not a pending keystroke, and
 * treating it as pending would mean the wait could never end.
 */
export function hasPendingCommand(paneText: string | null, command: string): boolean {
  if (!paneText) return false;
  return composerLines(paneText).some((l) => l.endsWith(command));
}

/** The trailing non-empty lines that may hold the composer. See `COMPOSER_SCAN_LINES`. */
function composerLines(paneText: string): string[] {
  return paneText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-COMPOSER_SCAN_LINES);
}
