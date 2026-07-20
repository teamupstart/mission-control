import {
  activateWeztermPane,
  listWeztermPanes,
  setWeztermTabTitle,
  spawnWeztermTabResult,
  weztermCwdToPath,
  weztermEnv,
  type WeztermPane,
} from "../discovery/wezterm.ts";
import { resolveBin, WEZTERM_BIN } from "./bin.ts";
import { defaultExec, toResult, type TerminalExec } from "./exec.ts";
import type {
  EmulatorPane,
  EmulatorTarget,
  Key,
  TerminalEmulator,
} from "./types.ts";

/**
 * WezTerm behind the `TerminalEmulator` interface.
 *
 * WezTerm is the capable end of the emulator axis - it lists, captures, writes, raises and
 * spawns - which makes it the wrong thing to design the interface around on its own. Read
 * this beside the null-heavy shape the interface admits (see `TerminalEmulator`); if a
 * Ghostty adapter, which can do none of the above but launch and raise, needs a field
 * added, this file was allowed to dictate the boundary.
 *
 * Enumeration, focus, spawn and retitle delegate to `discovery/wezterm.ts`, which carries
 * the two operational facts that took a while to learn: the inherited
 * `WEZTERM_UNIX_SOCKET` that goes stale when a GUI restarts, and `--no-auto-start`, which
 * turns a 2.5s block into a fast failure when no GUI is running. Duplicating those into a
 * second copy is how one of them gets fixed and the other does not. Writing and capturing
 * are implemented here because they have no existing home - today they are inline in
 * `actions.ts` and `pane-capture.ts`.
 *
 * Which means routing writes and captures through here is a DELIBERATE behavior change, not
 * a move, and the migration commit should be read as one: the inline call sites in
 * `actions.ts` and `discovery/pane-capture.ts` use neither `--no-auto-start` nor
 * `weztermEnv()`, so they inherit `WEZTERM_UNIX_SOCKET` and may auto-start a mux. The pane
 * ids they are given come from `listWeztermPanes`, which already drops that socket - so
 * today a write can address a different mux than the one the id came from. Sending every
 * command down the same socket the ids were enumerated on is the point of doing it here.
 */

/**
 * WezTerm takes raw escape SEQUENCES, not key names: `send-text` writes bytes to the pane's
 * pty and nothing interprets them for us. CSI Z is the standard back-tab (Shift+Tab); the
 * arrows are the ordinary CSI codes and Enter is a carriage return.
 *
 * The contrast with tmux's `KEY_NAMES` is the whole reason `Key` exists. A caller that
 * knew either convention would be writing a vendor into itself.
 */
const KEY_SEQS: Record<Key, string> = {
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  "shift-tab": "\x1b[Z",
};

/** Capturing a pane is on the poll path - keep it well under the tick interval. */
const CAPTURE_TIMEOUT_MS = 1000;

/**
 * Normalize one enumerated wezterm pane: numeric ids to strings, and the `file://` URL
 * wezterm reports as a cwd to a plain path.
 *
 * Both conversions exist today, scattered - `String(session.wezterm.paneId)` at every
 * write site, `weztermCwdToPath` at the one place that reads a cwd. Doing them at the
 * boundary is what lets a caller hold a pane id without knowing whose it is.
 */
export function toEmulatorPane(p: WeztermPane): EmulatorPane {
  return {
    paneId: String(p.paneId),
    tabId: String(p.tabId),
    windowId: String(p.windowId),
    tabTitle: p.tabTitle,
    windowTitle: p.windowTitle,
    isActive: p.isActive,
    tty: p.tty,
    cwd: weztermCwdToPath(p.cwd),
  };
}

export function weztermEmulator(exec: TerminalExec = defaultExec): TerminalEmulator {
  const bin = () => resolveBin(WEZTERM_BIN);
  /** Every `wezterm cli` call: live default mux, no auto-start, inherited socket dropped. */
  const cli = (args: string[], opts: { timeoutMs?: number } = {}) =>
    exec(bin(), ["cli", "--no-auto-start", ...args], { ...opts, env: weztermEnv() });
  const cmd = async (args: string[], fail: string) => toResult(await cli(args), fail);

  const sendText = (target: EmulatorTarget, text: string, literal: boolean, fail: string) =>
    cmd(
      // Omitting `--no-paste` is what makes wezterm send the text as a bracketed paste, so
      // the flag is the difference between typing and pasting rather than a formality.
      //
      // `--` ends flag parsing. wezterm's CLI is clap-based, so a body starting with a dash
      // ("-v is what broke it") is otherwise read as an option bundle and the write fails
      // with a usage dump instead of being typed.
      ["send-text", "--pane-id", target.paneId, ...(literal ? ["--no-paste"] : []), "--", text],
      fail,
    );

  return {
    id: "wezterm",
    label: "WezTerm",
    bin: WEZTERM_BIN,

    list: async () => (await listWeztermPanes()).map(toEmulatorPane),

    write: {
      text: (t, text) => sendText(t, text, true, "wezterm send-text failed"),
      keys: (t, keys) =>
        sendText(t, keys.map((k) => KEY_SEQS[k]).join(""), true, "wezterm send-text failed"),
      paste: (t, text) => sendText(t, text, false, "wezterm send-text failed"),
    },

    capture: async (t) => {
      const r = await cli(["get-text", "--pane-id", t.paneId], { timeoutMs: CAPTURE_TIMEOUT_MS });
      return r.code === 0 ? r.stdout : null;
    },

    focus: {
      granularity: "pane",
      raise: async (t) =>
        toResult(await activateWeztermPane(Number(t.tabId), Number(t.paneId)), "wezterm activate failed"),
    },

    spawn: {
      async tab(argv, title) {
        const { paneId, result } = await spawnWeztermTabResult([...argv], title);
        // The spawn's own outcome, never a guess. A `wezterm cli spawn` that was killed
        // rather than answering may have died AFTER the compositor opened the tab, and
        // reporting that as a clean failure is how the focus fallback opens a second one.
        if (result.code !== 0) {
          return { ...toResult(result, "wezterm could not open a tab"), target: null };
        }
        // Exit 0 with an unreadable id is the `SpawnResult` split doing its job: a tab
        // opened, and nothing may be typed into it.
        if (paneId === null) return { ok: true, outcomeUnknown: false, target: null };
        // wezterm's spawn reports only the pane. Resolving its tab costs one more `list`
        // and is what makes the returned target addressable - `focus` raises tabs, so a
        // target without one could not be brought forward by the caller that just made it.
        const tab = (await listWeztermPanes()).find((p) => p.paneId === paneId);
        return {
          ok: true,
          outcomeUnknown: false,
          target: tab ? { paneId: String(tab.paneId), tabId: String(tab.tabId) } : null,
        };
      },
    },

    retitle: async (t, title) =>
      toResult(await setWeztermTabTitle(Number(t.paneId), title), "wezterm set-tab-title failed"),
  };
}
