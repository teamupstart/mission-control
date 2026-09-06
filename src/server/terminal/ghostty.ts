import { GHOSTTY_BIN } from "./bin.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { defaultExec, toResult, type TerminalExec } from "./exec.ts";
import { PLAIN_NAMES } from "./names.ts";
import { shellCommand } from "./shell.ts";
import { appleScriptString } from "./applescript.ts";
import type {
  EmulatorPane,
  EmulatorTarget,
  Key,
  SpawnResult,
  TabSpec,
  TerminalEmulator,
} from "./types.ts";

/**
 * Ghostty behind the `TerminalEmulator` interface - the emulator axis's acceptance test.
 *
 * Read this beside `wezterm.ts`. WezTerm is the capable end of the axis and the wrong thing
 * to shape an interface around; Ghostty was queued as the opposite pole, on the belief that
 * it "can be launched into and neither listed nor captured nor typed into". **That belief
 * was wrong**, and finding out is most of what this adapter is worth. It is the
 * `HARNESSES.codex.tui` lesson repeating: a capability declared absent, a comment asserting
 * why, and no one ever pointing it at a real install. Everything below was measured against
 * Ghostty 1.3.1 - the transcript is `todo/ghostty-emulator.md`.
 *
 * ## Not a CLI
 *
 * `ghostty +new-window` answers "not supported on this platform" and the bundled binary is
 * built `app runtime: .none`; `--help` says outright that launching the emulator from the
 * CLI is unsupported on macOS. So `GHOSTTY_BIN` answers *is it installed* and is never run -
 * the first backend where "which binary proves it is here" and "what do we execute" have
 * different answers. The GUI is driven through Apple Events, which is exactly the shape
 * `exec.ts` promised the interface would admit ("an adapter is not obliged to be a
 * subprocess - iTerm2 scripts through AppleScript").
 *
 * ## The nulls, each pointed at the real app first
 *
 *   - `capture`: null. `get properties of terminal` returns `id`, `name`,
 *     `working directory` and nothing else, and no command returns screen text. The only
 *     route would be `select_all` + `copy_to_clipboard` + read the pasteboard, which
 *     clobbers the operator's clipboard and their selection to service a 1500ms poll. That
 *     is not a capture, it is a side effect wearing one.
 *   - `retitle`: null. `name` is `access="r"` on every class in the dictionary.
 *   - `hostProcess`: NOT null, and it is the reason this adapter exists. See below.
 *
 * ## Why `hostProcess` had to be added to the interface
 *
 * Ghostty can fill every field of `EmulatorPane` except `tty` - which `types.ts` calls "the
 * join key to everything else", and which `correlate.ts` indexed by exclusively. So an
 * adapter that enumerated perfectly enumerated into a void. Declaring `list: null` would
 * have recorded a false reason ("cannot enumerate") for a true outcome ("cannot correlate")
 * and left this whole file decorative. Ruled out by measurement, not assumption: injected
 * env vars are unreadable (`ps -E` is SIP-restricted), and a surface spawned with a raw
 * `command` reports an EMPTY working directory, so cwd alone cannot carry it either.
 */

/**
 * Ghostty's own key vocabulary, and it is a THIRD convention - which is the case `Key`
 * exists for. tmux takes names (`BTab`), wezterm takes escape sequences (`\x1b[Z`), and
 * Ghostty takes both depending on the key, through two different commands.
 *
 * Every value below was verified by recording raw bytes off a real surface's pty, the way
 * the tmux and wezterm write paths were. `send key` accepts only a small table of named
 * special keys - `up`, `arrow_up`, `page_up` are all rejected with "Unknown key name", and a
 * plain character is accepted and then silently does NOTHING, which is the trap here. The
 * arrows are therefore sent as the CSI sequences they are, through `perform action "csi:X"`,
 * which emits exactly `ESC [ X`.
 *
 * Shift+Tab is in the `csi` group deliberately even though `send key "tab" modifiers "shift"`
 * also works: both were measured emitting the identical `ESC [ Z`, and one mechanism for
 * every sequence key is worth more than matching the dictionary's shape.
 */
const KEY_FORMS: Record<Key, { via: "csi"; final: string } | { via: "named"; name: string }> = {
  // Enter is a bare CR, which has no CSI form; `send key` is the only way to send one.
  enter: { via: "named", name: "enter" },
  /**
   * Escape is a bare ESC, so it is in the `named` group for exactly Enter's reason:
   * `perform action "csi:X"` emits `ESC [ X`, and there is no final byte that reduces that
   * to the single 0x1B this key IS.
   *
   * The spelling was measured, not inferred, because this table rejects what it does not
   * know: `send key "escape"` exits 0 and delivers one 0x1B, while `esc`, `ESCAPE` and
   * `escape_key` are each `Unknown key name (-1700)`. Note the case sensitivity - the
   * capitalized form tmux wants is an error here, which is the whole reason `Key` exists.
   */
  escape: { via: "named", name: "escape" },
  up: { via: "csi", final: "A" },
  down: { via: "csi", final: "B" },
  left: { via: "csi", final: "D" },
  right: { via: "csi", final: "C" },
  tab: { via: "named", name: "tab" },
  "shift-up": { via: "csi", final: "1;2A" },
  "shift-down": { via: "csi", final: "1;2B" },
  "shift-tab": { via: "csi", final: "Z" },
};

/** Apple Events are not free (~150ms each). Keep enumeration well under the poll tick. */
const LIST_TIMEOUT_MS = 2500;
const WRITE_TIMEOUT_MS = 4000;

/** Field and record separators for the enumeration script - control codes a tab title cannot contain. */
const US = "";
const RS = "";

/**
 * Ghostty's bundle id, used instead of the application NAME.
 *
 * `tell application "Ghostty"` resolves by name and would match any app so called; the
 * bundle id is what the running instance actually is.
 */
const BUNDLE_ID = "com.mitchellh.ghostty";

/**
 * Quote a string for embedding in an AppleScript literal.
 *
 * Only backslash and double-quote are special inside an AppleScript string. Newlines cannot
 * be embedded literally, so they are written as an escape and rejoined by the script - which
 * is why `text` below never passes a multi-line body through here in one piece.
 */
export function asQuote(s: string): string {
  return appleScriptString(s);
}

/**
 * The enumeration script. One Apple Event, no liveness check of its own.
 *
 * The check matters enormously - a `tell application` against an app that is NOT running
 * launches it, so an unguarded version of this would open a terminal window on the
 * operator's desktop every 1500ms - and it deliberately does not live here.
 * `enumerateTerminals` answers it from `hostProcess` against the process table discovery has
 * already read. The alternative, asking System Events from inside this script, was written
 * and measured first: ~160ms per tick, for a question a table we already hold answers for
 * free. A backend must not grow a private second way to ask whether its own app is up.
 *
 * Nested `try` blocks around the per-surface reads rather than one around the whole walk: a
 * surface that cannot answer for its own working directory must cost that one field, not the
 * entire enumeration - which on this backend is every card it hosts.
 */
function listScript(): string {
  return `
set out to ""
tell application id "${BUNDLE_ID}"
  repeat with w in windows
    repeat with t in tabs of w
      set ft to ""
      try
        set ft to id of (focused terminal of t)
      end try
      repeat with s in terminals of t
        set cwd to ""
        try
          set cwd to (working directory of s)
        end try
        set act to "0"
        if ((selected of t) and ((id of s) = ft)) then set act to "1"
        set out to out & (id of s) & "${US}" & (id of t) & "${US}" & (id of w) & "${US}" & (name of t) & "${US}" & (name of w) & "${US}" & cwd & "${US}" & act & "${RS}"
      end repeat
    end repeat
  end repeat
end tell
return out`;
}

/**
 * Parse the enumeration script's output into normalized panes.
 *
 * `tty` is ALWAYS null, and that is this adapter's whole finding rather than an oversight -
 * see the header. `correlate.ts` pairs these against ttys hosted by the Ghostty GUI.
 *
 * Returns [] for anything unparseable, matching `parsePanes` in `wezterm.ts`: a caller has
 * no more to do with half a pane list than with none, and discovery must degrade silently.
 */
export function parseSurfaces(stdout: string): EmulatorPane[] {
  const panes: EmulatorPane[] = [];
  for (const record of stdout.split(RS)) {
    if (!record.trim()) continue;
    const f = record.split(US);
    // Seven fields, or the script changed and we should not guess which is which.
    if (f.length < 7) continue;
    const [paneId, tabId, windowId, tabTitle, windowTitle, cwd, active] = f;
    if (!paneId) continue;
    panes.push({
      paneId,
      tabId: tabId ?? "",
      windowId: windowId ?? "",
      tabTitle: (tabTitle ?? "").trim(),
      windowTitle: (windowTitle ?? "").trim(),
      isActive: active?.trim() === "1",
      // Ghostty exposes no tty on any class. The one field it cannot answer.
      tty: null,
      cwd: (cwd ?? "").trim() || null,
    });
  }
  return panes;
}

export function ghosttyEmulator(exec: TerminalExec = defaultExec): TerminalEmulator {
  /**
   * Every Apple Event goes through here. `osascript` is at a fixed path on every macOS, and
   * on a machine without it this whole adapter is unreachable anyway - `binPresent` gates on
   * the app bundle, which only exists on macOS.
   */
  /**
   * **The script - payload and all - is one argv entry, so this backend retains the
   * operating system's `ARG_MAX` ceiling.** `typeLiterally` builds a single `tell` block
   * holding every line of the body.
   *
   * Left on `-e` deliberately. `osascript` does read a script from stdin when given neither
   * `-e` nor a file - verified on this machine - so the transport swap is available and
   * cheap. What is NOT available is evidence that Ghostty still behaves after it: the app was
   * not running where this was measured, and driving it needs an Automation permission grant
   * that only a human at the keyboard can give. This file's own rule is that a claim about a
   * backend is worth what the capture behind it is worth, so the ceiling remains documented
   * instead of moving without verification.
   *
   * The failure MODE is fixed even though the limit is not: `run` (`util/exec.ts`) used to
   * let `spawn`'s synchronous E2BIG escape as a promise rejection, and now reports it as an
   * ordinary refusal that delivered nothing.
   */
  const osa = (script: string, timeoutMs: number) =>
    exec(FIXED_OS_EXECUTABLES.osascript, ["-e", script], { timeoutMs });

  /** A surface, addressed at application level - `terminal` is an element of `application`. */
  const surface = (t: EmulatorTarget) =>
    `(first terminal of application id "${BUNDLE_ID}" whose id is ${asQuote(t.paneId)})`;

  const cmd = async (script: string, fail: string) =>
    toResult(await osa(script, WRITE_TIMEOUT_MS), fail);

  /**
   * Type `text` literally, where a newline SUBMITS - `PaneWrite.text`'s contract.
   *
   * This is assembled rather than sent as one command because neither primitive does it
   * alone, and picking either one on its own would be a silent correctness bug:
   *
   *   - `input text` is a BRACKETED PASTE. Measured: it arrives wrapped in
   *     `ESC[200~ … ESC[201~`, so an agent TUI takes it as one block and an embedded newline
   *     does not submit. That makes it the right implementation of `paste` and the wrong one
   *     of `text`.
   *   - `perform action "text:…"` types literally, and interprets BACKSLASH ESCAPES while it
   *     does. Measured: `text:a\nb` arrives as `a<LF>b`. So a reply containing a literal
   *     backslash-n would submit itself halfway through - the class of defect that corrupts
   *     a prompt already delivered.
   *
   * So: the body goes through the byte-exact path in single-line chunks (which no TUI
   * collapses - `ControlSpec.collapses` only fires on multi-line), and each newline becomes
   * a real Enter. The result is byte-for-byte what typing produces.
   */
  const typeLiterally = async (t: EmulatorTarget, text: string) => {
    const lines = text.split("\n");
    const steps: string[] = [];
    lines.forEach((line, i) => {
      if (i > 0) steps.push(`send key "enter" to ${surface(t)}`);
      if (line !== "") steps.push(`input text ${asQuote(line)} to ${surface(t)}`);
    });
    if (steps.length === 0) return { ok: true, outcomeUnknown: false };
    return cmd(
      `tell application id "${BUNDLE_ID}"\n${steps.join("\n")}\nend tell`,
      "ghostty input text failed",
    );
  };

  const pressKeys = (t: EmulatorTarget, keys: readonly Key[]) => {
    const steps = keys.map((k) => {
      const form = KEY_FORMS[k];
      return form.via === "csi"
        ? `perform action ${asQuote(`csi:${form.final}`)} on ${surface(t)}`
        : `send key ${asQuote(form.name)} to ${surface(t)}`;
    });
    return cmd(
      `tell application id "${BUNDLE_ID}"\n${steps.join("\n")}\nend tell`,
      "ghostty send key failed",
    );
  };

  return {
    id: "ghostty",
    label: "Ghostty",
    // An outlined window - an emulator, distinct from WezTerm at a glance.
    glyph: "◫",
    bin: GHOSTTY_BIN,

    list: async () => {
      const r = await osa(listScript(), LIST_TIMEOUT_MS);
      // Non-zero covers the states this must degrade silently through: Ghostty not running,
      // and Automation permission not granted (osascript exits 1 with -1743). Neither is an
      // error the operator can act on from a card, and both resolve themselves.
      return r.code === 0 ? parseSurfaces(r.stdout) : [];
    },

    /**
     * The slot this adapter forced onto the interface. Ghostty's GUI process is the only
     * thing that can tell us which tty one of its surfaces is on, and it tells us by being
     * that tty's ancestor.
     */
    hostProcess: { commands: ["ghostty"] },

    write: {
      text: typeLiterally,
      keys: pressKeys,
      // `input text` is a real bracketed paste, verified against a pty with paste mode on,
      // so a multi-line prompt reaches the composer as one block instead of being shredded
      // into a submission per line.
      paste: (t, text) =>
        cmd(`tell application id "${BUNDLE_ID}" to input text ${asQuote(text)} to ${surface(t)}`,
          "ghostty input text failed"),
    },

    // No property or command in the dictionary returns screen text. See the header for the
    // clipboard route and why it is not one.
    capture: null,

    focus: {
      // `pane`, not `app`. The `granularity: "app"` variant was added to this interface FOR
      // Ghostty, on the assumption it could only be brought forward wholesale; the
      // dictionary focuses one surface. The variant stays because it is still the honest
      // answer for some emulator, but it is not the honest answer for this one.
      granularity: "pane",
      raise: (t) =>
        cmd(
          `tell application id "${BUNDLE_ID}"\n` +
            `activate\n` +
            `focus ${surface(t)}\n` +
            `end tell`,
          "ghostty could not raise that surface",
        ),
    },

    spawn: {
      async tab(spec: TabSpec): Promise<SpawnResult> {
        // `initial working directory` is set whenever a cwd is asked for, and NOT quietly
        // skipped when it is absent from the dictionary, because `TabSpec.cwd` says an
        // emulator that cannot honour one must fail rather than open the tab elsewhere: a
        // dispatched agent in the wrong checkout commits to the wrong branch. Ghostty can
        // honour it, so this is the easy case; the hard one is that the failure has to stay
        // a failure, which is why there is no `?? ""` here.
        const script =
          `tell application id "${BUNDLE_ID}"\n` +
          `set cfg to new surface configuration\n` +
          `set command of cfg to ${asQuote(shellCommand(spec.argv))}\n` +
          (spec.cwd ? `set initial working directory of cfg to ${asQuote(spec.cwd)}\n` : "") +
          `set w to new window with configuration cfg\n` +
          `return id of (first terminal of (first tab of w)) & "${US}" & id of (first tab of w)\n` +
          `end tell`;
        const r = await osa(script, WRITE_TIMEOUT_MS);
        if (r.code !== 0) {
          return { ...toResult(r, "ghostty could not open a window"), target: null };
        }
        const [paneId, tabId] = r.stdout.trim().split(US);
        // `spec.title` is dropped, and this is the one place that absence is felt rather
        // than merely declared: every other backend stamps the new tab on the way out, and
        // Ghostty's `name` is read-only on window, tab and terminal alike, so a tab it opens
        // carries whatever the shell reports. `retitle: null` is the same fact, said where a
        // caller can branch on it; there is no third state to invent here.
        // Exit 0 with an unreadable id is `SpawnResult`'s split doing its job - the human
        // got their window and nothing may be typed into it.
        if (!paneId) return { ok: true, outcomeUnknown: false, target: null };
        return { ok: true, outcomeUnknown: false, target: { paneId, tabId: tabId ?? "" } };
      },
    },

    // `name` is read-only on window, tab and terminal alike. A tab titled by us is not on
    // offer, so the rename path refuses by capability rather than appearing to succeed.
    retitle: null,

    // Declared even though nothing here can set a title, which is exactly the case the slot
    // was written for: `spawn` is handed one regardless, so a backend with no `retitle` can
    // still be given a name it cannot express. `PLAIN_NAMES` is the honest answer - a
    // Ghostty tab title is display text with no target grammar behind it, so the only rules
    // are the neutral ones every name obeys. Saying so beats inheriting it by omission.
    names: PLAIN_NAMES,
  };
}
