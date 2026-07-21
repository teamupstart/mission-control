import type { PermissionMode } from "@shared/types.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import { paneToken } from "@shared/pane.ts";
import type { DiscoveredSession } from "./correlate.ts";
import { forgetPanesExcept, paneReadLost, paneReadOk } from "./capture-tolerance.ts";
import { capturePaneText, type PaneHandles } from "./pane-capture.ts";
import { parsePaneDialog } from "./pane-dialog.ts";

/**
 * Read a Claude session's permission mode off its terminal pane.
 *
 * Claude offers no way to *query* the mode: hooks carry `permission_mode` but
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

/**
 * How many trailing non-empty lines may hold the mode line. It is the last one
 * in practice; the small margin absorbs any trailing notice Claude adds without
 * opening the window wide enough for transcript prose to be misread as a mode.
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
 * A glyph-prefixed line naming a mode this build doesn't recognize - a newer
 * Claude's wording, or a mode gated behind a flag we couldn't observe. We can't
 * label it, but it's still a real position in the Shift+Tab cycle, so the walk
 * in `setPermissionMode` must be able to step *through* it rather than give up.
 */
const UNKNOWN_MODE_LINE = /^[a-z' ]{3,24} on\b/;

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
 * Find Claude's mode line in a pane capture, or null when it isn't showing one
 * (a dialog is up, or it's a pre-2.1.203 Claude sitting in `manual`).
 *
 * Scans upward from the bottom so the footer wins over anything above it, and
 * requires the wording to start the line - transcript prose that merely mentions
 * "plan mode on" reads as a sentence, not as a line beginning with it.
 */
export function parsePaneModeLine(paneText: string | null): PaneModeLine | null {
  if (!paneText) return null;
  const lines = paneText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-FOOTER_SCAN_LINES);

  for (const line of lines.reverse()) {
    // Normalize the typographic apostrophe Claude renders in "don't ask".
    const body = line.replace(MODE_GLYPHS, "").replace(/’/g, "'").toLowerCase();
    const hadGlyph = MODE_GLYPHS.test(line);
    for (const [re, mode] of FOOTER_MODES) {
      const m = re.exec(body);
      if (m) return { text: m[0], mode };
    }
    const unknown = hadGlyph ? UNKNOWN_MODE_LINE.exec(body) : null;
    if (unknown) return { text: unknown[0], mode: null };
  }
  return null;
}

/** Read a session's mode line straight off its pane. */
export async function readPaneModeLine(session: PaneHandles): Promise<PaneModeLine | null> {
  return parsePaneModeLine(await capturePaneText(session));
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
 * Skipped for a harness with no `permissionModes` capability: there is no footer mode line
 * to find, so the capture would buy nothing. Note that the DIALOG half rides along on that
 * same guard - `parsePaneDialog` is Claude's menu grammar, and it will move to its own
 * `tui` capability when that slot lands (see the plan's "Fixes found along the way": a
 * Codex session parked on a prompt currently reads as idle). Gating both on
 * `permissionModes` is exactly today's behaviour, restated as a capability rather than as
 * an agent id.
 */
export async function annotatePaneState(sessions: DiscoveredSession[]): Promise<void> {
  // The token IS the handle check: a session with no pane has no token, and one without
  // a token has nothing to capture and nothing to count misses against.
  const keyed = sessions.flatMap((s) => {
    if (!capabilitiesFor(s.agent).permissionModes) return [];
    const key = paneToken(s);
    return key ? [{ s, key }] : [];
  });
  forgetPanesExcept(new Set(keyed.map((k) => k.key)));
  await Promise.all(
    keyed.map(async ({ s, key }) => {
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
      const line = parsePaneModeLine(text);
      if (line?.mode) s.permissionMode = line.mode;
      s.paneDialog = parsePaneDialog(text);
    }),
  );
}
