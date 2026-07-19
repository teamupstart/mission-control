import type { Session } from "@shared/types.ts";
import { resolveWeztermBin } from "../config.ts";
import { run } from "../util/exec.ts";

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

/** The pane handles we can capture text from; both Session and DiscoveredSession have these. */
export type PaneHandles = Pick<Session, "tmux" | "wezterm">;

/** Capturing a pane is on the poll path - keep it well under the tick interval. */
const CAPTURE_TIMEOUT_MS = 1000;

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
