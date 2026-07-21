import {
  activateWeztermPane,
  setWeztermTabTitle,
  spawnWeztermTabResult,
  weztermCwdToPath,
} from "../discovery/wezterm.ts";
import { normTty } from "../discovery/tty.ts";
import { binEnv, resolveBin, WEZTERM_BIN } from "./bin.ts";
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
 * Enumeration moved in from `discovery/wezterm.ts`, so discovery asks the registry what each
 * backend can see rather than importing two vendors by name. Focus, spawn and retitle still
 * delegate there - they are the next migration item, and `actions.ts` calls them directly
 * today. Both sides go through `cli` below, which carries the two operational facts that
 * took a while to learn: `--no-auto-start`, which turns a 2.5s block into a fast failure
 * when no GUI is running, and the inherited `WEZTERM_UNIX_SOCKET` that goes stale when a GUI
 * restarts (now `WEZTERM_BIN.dropEnv`, so tmux gets the same treatment for the same reason).
 * Writing and capturing are implemented here because they have no existing home - today they
 * are inline in `actions.ts` and `pane-capture.ts`.
 *
 * Which means routing writes and captures through here will be a DELIBERATE behavior change,
 * not a move, and that migration commit should be read as one: the inline call sites still
 * left in `actions.ts` and `discovery/pane-capture.ts` use neither `--no-auto-start` nor a
 * scrubbed environment, so they inherit `WEZTERM_UNIX_SOCKET` and may auto-start a mux. The
 * pane ids they are given come from `list` below, which drops that socket - so today such a
 * write can address a different mux than the one the id came from. Sending every command
 * down the same socket the ids were enumerated on is the point of doing it here.
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

/** Field names in wezterm's `cli list --format json` are snake_case; this is the subset we use. */
interface RawPane {
  window_id: number;
  tab_id: number;
  pane_id: number;
  tab_title?: string;
  window_title?: string;
  cwd?: string;
  tty_name?: string;
  is_active?: boolean;
}

/**
 * Parse `cli list --format json` into normalized panes: numeric ids to strings, and the
 * `file://` URL wezterm reports as a cwd to a plain path.
 *
 * Both conversions used to be scattered - `String(session.wezterm.paneId)` at every write
 * site, `weztermCwdToPath` at the one place that read a cwd. Doing them at the boundary is
 * what lets a caller hold a pane id without knowing whose it is.
 *
 * Returns [] for output that is not the JSON array we asked for, which is the same answer as
 * "wezterm isn't running": a caller has no more to do with a half-parsed pane list than with
 * none, and discovery must degrade silently on a machine with no wezterm at all.
 */
export function parsePanes(stdout: string): EmulatorPane[] {
  if (!stdout.trim()) return [];
  let raw: RawPane[];
  try {
    raw = JSON.parse(stdout) as RawPane[];
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => ({
    paneId: String(p.pane_id),
    tabId: String(p.tab_id),
    windowId: String(p.window_id),
    tabTitle: (p.tab_title ?? "").trim(),
    windowTitle: (p.window_title ?? "").trim(),
    isActive: Boolean(p.is_active),
    tty: normTty(p.tty_name),
    cwd: weztermCwdToPath(p.cwd ?? ""),
  }));
}

export function weztermEmulator(exec: TerminalExec = defaultExec): TerminalEmulator {
  const bin = () => resolveBin(WEZTERM_BIN);
  /** Every `wezterm cli` call: live default mux, no auto-start, inherited socket dropped. */
  const cli = (args: string[], opts: { timeoutMs?: number } = {}) =>
    exec(bin(), ["cli", "--no-auto-start", ...args], { ...opts, env: binEnv(WEZTERM_BIN) });
  const cmd = async (args: string[], fail: string) => toResult(await cli(args), fail);

  /**
   * Returns [] when wezterm isn't running or the CLI isn't reachable - the product works
   * fine with tmux-only or bare terminals, so this must degrade silently.
   *
   * Named rather than inlined on the interface because `spawn.tab` needs it too, and a
   * second `cli list` written there would be the one that forgets `--no-auto-start`.
   */
  const list = async (): Promise<EmulatorPane[]> => {
    const res = await cli(["list", "--format", "json"]);
    return res.code === 0 ? parsePanes(res.stdout) : [];
  };

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

    list,

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
        const tab = (await list()).find((p) => p.paneId === String(paneId));
        return {
          ok: true,
          outcomeUnknown: false,
          target: tab ? { paneId: tab.paneId, tabId: tab.tabId } : null,
        };
      },
    },

    retitle: async (t, title) =>
      toResult(await setWeztermTabTitle(Number(t.paneId), title), "wezterm set-tab-title failed"),
  };
}
