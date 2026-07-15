import type { PermissionMode, Session } from "@shared/types.ts";
import { resolveWeztermBin } from "../config.ts";
import { run } from "../util/exec.ts";
import type { DiscoveredSession } from "./correlate.ts";

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

/** The pane handles we can capture text from; both Session and DiscoveredSession have these. */
type PaneHandles = Pick<Session, "tmux" | "wezterm">;

/** Capturing a pane is on the poll path - keep it well under the tick interval. */
const CAPTURE_TIMEOUT_MS = 1000;

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

/** Capture a pane's visible text, or null when it has no handle / the capture fails. */
export async function capturePaneText(session: PaneHandles): Promise<string | null> {
  // tmux wins when both exist: the agent's real pane is the tmux pane, and the
  // wezterm handle would be the outer client showing it. Mirrors `sendText`.
  if (session.tmux) {
    const r = await run("tmux", ["capture-pane", "-p", "-t", session.tmux.paneId], {
      timeoutMs: CAPTURE_TIMEOUT_MS,
    });
    return r.code === 0 ? r.stdout : null;
  }
  if (session.wezterm) {
    const r = await run(
      resolveWeztermBin(),
      ["cli", "get-text", "--pane-id", String(session.wezterm.paneId)],
      { timeoutMs: CAPTURE_TIMEOUT_MS },
    );
    return r.code === 0 ? r.stdout : null;
  }
  return null;
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
 * Fill in `permissionMode` for every Claude session we can see a pane for, so a
 * card's chip reflects what the terminal actually shows rather than the last
 * value a hook happened to carry. Sessions we can't read are left undefined -
 * the registry keeps their hook-reported mode instead.
 *
 * Codex has no permission-mode concept, so it's skipped entirely.
 */
export async function annotatePermissionModes(sessions: DiscoveredSession[]): Promise<void> {
  const claude = sessions.filter((s) => s.agent === "claude" && (s.tmux || s.wezterm));
  await Promise.all(
    claude.map(async (s) => {
      const line = await readPaneModeLine(s);
      if (line?.mode) s.permissionMode = line.mode;
    }),
  );
}
