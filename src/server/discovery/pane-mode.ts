import type { AgentType, PermissionMode } from "@shared/types.ts";
import { paneToken } from "@shared/pane.ts";
import type { DiscoveredSession } from "./correlate.ts";
import { forgetPanesExcept, paneReadLost, paneReadOk } from "./capture-tolerance.ts";
import { capturePaneText, type PaneHandles } from "./pane-capture.ts";
import { parsePaneDialog } from "./pane-dialog.ts";
import { dialogSpecFor, modeLineSpecFor } from "../harness/index.ts";
import type { ModeLineSpec } from "../harness/types.ts";

/**
 * Read a session's permission mode off its terminal pane.
 *
 * The agent offers no way to *query* the mode: Claude's hooks carry `permission_mode` but
 * only fire on activity, and nothing fires when Shift+Tab changes it. The one
 * always-current source is the pane itself - Claude prints the mode on the last
 * line, below the input box and below any statusLine the user configured:
 *
 *     ZZZ-MY-STATUSLINE-ZZZ            <- the user's `statusLine` command
 *     ⏸ manual mode on · ← 3 agents    <- Claude's own line, always present
 *
 * That line is native to Claude, not a statusLine widget, so every user has it
 * whatever their settings say. Reading it makes the mode an *observation* rather
 * than a remembered guess, which is what lets us drive the mode to a chosen
 * target (see `setPermissionMode`) instead of only blind-cycling it.
 *
 * Two cases legitimately yield no line, and both are reported as "unknown" so a
 * caller falls back to the hook-reported mode rather than inventing one:
 *   - a dialog or menu is foreground (it replaces the footer entirely), or
 *   - Claude is older than v2.1.203, which drew no line for `manual`.
 */

/** A mode line as read off a pane. */
export interface PaneModeLine {
  /**
   * The mode's wording, glyph and trailing `· 1 shell · ← 3 agents` stripped.
   * Identifies a cycle position even when `mode` is null, so a walk can detect
   * having come all the way around by text alone.
   */
  text: string;
  /** The mode it names, or null for a mode line this build doesn't recognize. */
  mode: PermissionMode | null;
}

/**
 * Find the agent's mode line in a pane capture, or null when it isn't showing one
 * (a dialog is up, or it's a pre-2.1.203 Claude sitting in `manual`).
 *
 * Scans upward from the bottom so the footer wins over anything above it, and
 * requires the wording to start the line - transcript prose that merely mentions
 * "plan mode on" reads as a sentence, not as a line beginning with it.
 *
 * The scan is machinery; the wording is the harness's (`ModeLineSpec`).
 */
export function parsePaneModeLine(paneText: string | null, spec: ModeLineSpec): PaneModeLine | null {
  if (!paneText) return null;
  const lines = paneText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-spec.scanLines);

  for (const line of lines.reverse()) {
    // Normalize the typographic apostrophe Claude renders in "don't ask".
    const body = line.replace(spec.glyphs, "").replace(/’/g, "'").toLowerCase();
    const hadGlyph = spec.glyphs.test(line);
    for (const [re, mode] of spec.modes) {
      const m = re.exec(body);
      if (m) return { text: m[0], mode };
    }
    const unknown = hadGlyph ? spec.unknownMode.exec(body) : null;
    if (unknown) return { text: unknown[0], mode: null };
  }
  return null;
}

/**
 * Read a session's mode line straight off its pane, or null when this harness has no
 * permission modes to read.
 */
export async function readPaneModeLine(
  session: PaneHandles & { agent: AgentType },
): Promise<PaneModeLine | null> {
  const spec = modeLineSpecFor(session.agent);
  if (!spec) return null;
  return parsePaneModeLine(await capturePaneText(session), spec);
}

/**
 * Read what a Claude session's pane is showing, for every session we can see one of: its
 * permission mode, so a card's chip reflects the terminal rather than the last value a
 * hook happened to carry, and the option dialog it is parked on, so the dashboard can
 * offer the rows as buttons.
 *
 * ONE capture feeding both parses, deliberately. The capture is a `tmux capture-pane`
 * subprocess per session per tick and was already being paid for the mode line alone,
 * with the text thrown away straight after; the dialog is a second pure parse over that
 * same string, so board-wide dialog buttons cost no new processes. Two captures would
 * also be two different screens - the pair would disagree on any tick where a dialog
 * opened between them, which is exactly the tick that matters.
 *
 * The two reads are complementary rather than redundant: a foreground dialog REPLACES
 * Claude's footer, so the ticks where the mode line is missing are the ticks where the
 * dialog is there. Mode is therefore only overwritten when actually read (a dialog must
 * not blank the chip), while the dialog is written unconditionally on a successful
 * capture - including as null, which is how a dismissed menu clears the card.
 *
 * Which of the two a given session gets is the HARNESS's answer, not an agent check. It
 * used to be `s.agent !== "claude"`, and that guard was wrong in the most expensive
 * direction: Codex renders the same numbered menus and, at the time, pushed no hooks at
 * all - so the one signal that could ever have shown a Codex session as blocked was the
 * one the guard skipped, and because it skipped it, nobody found out for the life of the
 * parser. Codex reports hooks now, but only on a launch the dashboard instrumented, so
 * for an operator-started Codex session the read below is still the whole story. A
 * harness that genuinely draws nothing readable declares `dialog: null` and takes the same
 * path, but it has to SAY so.
 *
 * The guard this replaces had already been restated once, as
 * `capabilitiesFor(s.agent).permissionModes`, with a note that the dialog half was riding
 * along on it until this slot landed. That restatement changed no behaviour and could not:
 * Codex had no mode-line capability, so gating the DIALOG on it skipped exactly the
 * sessions whose dialogs were the only signal they could produce. The two screen grammars
 * are now asked for separately, which stays correct now that Codex also has a menu-based
 * permission control.
 */
export async function annotatePaneState(sessions: DiscoveredSession[]): Promise<void> {
  // The token IS the handle check: a session with no pane has no token, and one without
  // a token has nothing to capture and nothing to count misses against.
  //
  // A session whose harness can read NEITHER a mode line nor a dialog is dropped here
  // rather than captured and thrown away: the capture is a subprocess per session per
  // tick, and there is nothing either parse could tell us about it.
  const keyed = sessions.flatMap((s) => {
    const dialog = dialogSpecFor(s.agent);
    const modeLine = modeLineSpecFor(s.agent);
    if (!dialog && !modeLine) return [];
    const key = paneToken(s);
    return key ? [{ s, key, dialog, modeLine }] : [];
  });
  forgetPanesExcept(new Set(keyed.map((k) => k.key)));
  await Promise.all(
    keyed.map(async ({ s, key, dialog, modeLine }) => {
      const text = await capturePaneText(s);
      // A failed capture is not "no dialog" - it is no information, and saying null here
      // would clear a live menu off the card on one flaky tmux call. So the last dialog
      // rides forward (the registry keeps it when this leaves the field undefined) - but
      // only for a few ticks. Unbounded, one pane that never reads again pins its menu
      // for the life of the session, and the card goes on offering rows against a screen
      // nobody can see: the click is refused every time, and the refusal is the only
      // place it shows. Better to admit we have lost the pane than to keep drawing it.
      if (text === null) {
        if (paneReadLost(key)) s.paneDialog = null;
        return;
      }
      paneReadOk(key);
      if (modeLine) {
        const line = parsePaneModeLine(text, modeLine);
        if (line?.mode) s.permissionMode = line.mode;
      }
      // Left UNTOUCHED - not set to null - for a harness that draws no readable menus, so
      // the field keeps the registry's "no news" meaning rather than this tick asserting
      // "there is no menu" about a screen we never asked a question of.
      if (dialog) s.paneDialog = parsePaneDialog(text, dialog);
    }),
  );
}
