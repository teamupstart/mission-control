import { normTty } from "../discovery/tty.ts";
import { binEnv, resolveBin, WEZTERM_BIN } from "./bin.ts";
import { defaultExec, toResult, type TerminalExec } from "./exec.ts";
import { PLAIN_NAMES } from "./names.ts";
import type {
  EmulatorPane,
  EmulatorTarget,
  Key,
  SpawnResult,
  TabSpec,
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
 * Enumeration moved in first, then pane I/O, and the lifecycle item brought the last three -
 * focus, spawn and retitle - in from `discovery/wezterm.ts`, which is now gone. Everything
 * this backend does goes through `cli` below, which carries the two operational facts that
 * took a while to learn: `--no-auto-start`, which turns a 2.5s block into a fast failure when
 * no GUI is running, and the inherited `WEZTERM_UNIX_SOCKET` that goes stale when a GUI
 * restarts (now `WEZTERM_BIN.dropEnv`, so tmux gets the same treatment for the same reason).
 *
 * Routing the pane I/O through them was a DELIBERATE behavior change rather than a move -
 * the commit that did it should be read as one. The inline call sites it replaced (in
 * `actions.ts` and `discovery/pane-capture.ts`) used neither `--no-auto-start` nor a scrubbed
 * environment, so they inherited `WEZTERM_UNIX_SOCKET` and could auto-start a mux, while the
 * pane ids they were given came from `list` below, which drops it. A write could therefore
 * address a different mux than the one its id came from. The lifecycle commit closed the same
 * gap for focus and retitle, which had the identical split.
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

/** Convert wezterm's `file://host/path` cwd URL to a plain filesystem path. */
export function weztermCwdToPath(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const u = new URL(cwd);
    if (u.protocol === "file:") return decodeURIComponent(u.pathname);
  } catch {
    /* fall through */
  }
  return cwd || null;
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

  /**
   * Set a tab's explicit title - the value `cli list` reports back as `tab_title` and
   * discovery reads as the card name.
   *
   * `--` ends flag parsing so a title like "-wip" is read as the title rather than as a flag
   * bundle. Shared by `retitle` and by `spawn`, which stamps the new tab on the way out.
   */
  const setTabTitle = (paneId: string, title: string) =>
    cmd(["set-tab-title", "--pane-id", paneId, "--", title], "wezterm set-tab-title failed");

  return {
    id: "wezterm",
    label: "WezTerm",
    bin: WEZTERM_BIN,

    list,

    // Null because `cli list --format json` reports `tty_name` on every pane, so the strong
    // correlation key is always available and a process-ancestry fallback would only be a
    // second, weaker way to reach an answer we already have. Not "wezterm has no GUI
    // process" - `wezterm-gui` is right there in the process table.
    hostProcess: null,

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
      // The tab decides which pane the window shows; the pane decides which of that tab's
      // splits has the cursor. Both, in that order - raising the tab alone lands the human
      // on whichever split they left focused, which for a dispatched session is the shell.
      raise: async (t) => {
        const tab = await cmd(["activate-tab", "--tab-id", t.tabId], "wezterm activate-tab failed");
        if (!tab.ok) return tab;
        return cmd(["activate-pane", "--pane-id", t.paneId], "wezterm activate failed");
      },
    },

    spawn: {
      async tab(spec: TabSpec): Promise<SpawnResult> {
        const result = await cli([
          "spawn",
          ...(spec.cwd ? ["--cwd", spec.cwd] : []),
          "--",
          ...spec.argv,
        ]);
        // The spawn's own outcome, never a guess. A `wezterm cli spawn` that was killed
        // rather than answering may have died AFTER the compositor opened the tab, and
        // reporting that as a clean failure is how the focus fallback opens a second one.
        if (result.code !== 0) {
          return { ...toResult(result, "wezterm could not open a tab"), target: null };
        }
        const paneId = Number(result.stdout.trim());
        // Exit 0 with an unreadable id is the `SpawnResult` split doing its job: a tab
        // opened, and nothing may be typed into it - including, note, the title, which is
        // set through the pane.
        if (!Number.isInteger(paneId)) return { ok: true, outcomeUnknown: false, target: null };
        if (spec.title) await setTabTitle(String(paneId), spec.title);
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

    retitle: (t, title) => setTabTitle(t.paneId, title),

    // A wezterm tab title is display text: nothing parses it, so nothing constrains it
    // beyond what any name has to survive. Declared rather than assumed - see `NameRules`.
    names: PLAIN_NAMES,
  };
}
