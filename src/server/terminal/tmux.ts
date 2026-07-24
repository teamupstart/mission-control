import { normTty } from "../discovery/tty.ts";
import { binEnv, resolveBin, TMUX_BIN } from "./bin.ts";
import { defaultExec, toResult, type TerminalExec } from "./exec.ts";
import { plainName, plainValidate } from "./names.ts";
import type {
  DetachedSessionSpec,
  Key,
  MuxClient,
  MuxPane,
  MuxTarget,
  Multiplexer,
  NameRules,
  TerminalResult,
} from "./types.ts";

/**
 * tmux behind the `Multiplexer` interface.
 *
 * Mechanism only. The copy-mode REFUSAL, the pane lock, the paste settle and the submit
 * read-back stay in `actions.ts` where they belong - they are decisions about when to
 * write, and they are the same decisions for every backend. What lives here is the part
 * that is tmux's alone: its key names, its format strings, its target grammar, its buffer
 * dance.
 *
 * Enumeration moved in from `discovery/tmux.ts`, which is gone: discovery now asks the
 * registry what each backend can see rather than importing two vendors by name. The two
 * format strings came with their comments, which carry hard-won detail about what does and
 * does not survive a non-UTF-8 locale.
 *
 * Pane I/O came next: every keystroke, paste and capture aimed at a session now arrives
 * through `write` and `capture` below rather than being open-coded at a call site. The
 * remaining inline `run("tmux", …)` calls - focus, rename and kill in `actions.ts`, spawn
 * and teardown in `dispatcher.ts` - are the following migration item, and they are what
 * this file's `bin()` and `env()` exist to end: none of them resolves a binary or
 * sanitizes the environment, so they can address a different tmux server than the one the
 * pane ids they are given were enumerated on.
 */

/**
 * tmux takes key NAMES, which it resolves to the terminal's own sequences. `BTab` is
 * back-tab (Shift+Tab); the arrows and Enter are named as-is.
 *
 * A `Record<Key, string>` and not a lookup with a fallback: an unrendered key must fail
 * typecheck, because the fallback for a key nobody mapped is to type its name as literal
 * text into someone's session.
 */
const KEY_NAMES: Record<Key, string> = {
  enter: "Enter",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  "shift-up": "S-Up",
  "shift-down": "S-Down",
  "shift-tab": "BTab",
};

/** Capturing a pane is on the poll path - keep it well under the tick interval. */
const CAPTURE_TIMEOUT_MS = 1000;
/** Session teardown and creation are user-visible actions, not poll work. */
const SESSION_TIMEOUT_MS = 10000;

const PANE_FMT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_tty}",
  "#{pane_current_path}",
].join("\x1f"); // unit separator: safe against spaces in names/paths

const CLIENT_FMT = ["#{client_tty}", "#{client_session}"].join("\x1f");

/**
 * A SPACE, not the unit separator the two `-F` formats use, and the difference is
 * load-bearing.
 *
 * tmux sanitizes non-printable bytes out of its own argv - a `\x1f` arrives at the
 * server as `_` - unless the client's locale is UTF-8. A daemon started by launchd, or
 * a CI runner, frequently has no `LANG` at all, and there the separator never survives
 * the round trip: the probe below fails to parse, reads as "not in a mode", and the
 * guard it exists to power silently stops guarding on exactly those machines.
 *
 * The `-F` formats above get away with `\x1f` because they are read back off stdout rather
 * than passed through the same sanitizer, and because a session name or path may legitimately
 * contain a space. Neither field HERE can - `pane_in_mode` is `0` or `1`, and tmux's mode
 * names are single words (`copy-mode`, `view-mode`, ...) - so nothing is lost, and the parse
 * below rejoins the tail anyway rather than assuming that stays true.
 */
const MODE_FMT = ["#{pane_in_mode}", "#{pane_mode}"].join(" ");

/** Split one `-F` line on the unit separator, or null when it is blank or short. */
function fields(line: string, want: number): string[] | null {
  if (!line.trim()) return null;
  const f = line.split("\x1f");
  return f.length < want ? null : f;
}

/**
 * Parse `list-panes -a -F PANE_FMT`.
 *
 * Exported so the argv-to-panes round trip is testable against verbatim tmux output rather
 * than against a real server, which is the only way this asserts anything on a machine with
 * no tmux installed.
 */
export function parsePanes(stdout: string): MuxPane[] {
  const panes: MuxPane[] = [];
  for (const line of stdout.split("\n")) {
    const f = fields(line, 7);
    if (!f) continue;
    panes.push({
      session: f[0] ?? "",
      // The same string, and that is the whole reason `sessionName` had to become its own
      // field: in tmux a session's name IS its target spec, so nothing here had ever needed
      // to tell "what a human calls it" apart from "what `-t` resolves". A backend whose
      // sessions carry an id and a mutable title cannot set both from one value.
      sessionName: f[0] ?? "",
      windowIndex: Number(f[1] ?? 0),
      windowName: f[2] ?? "",
      paneId: f[3] ?? "",
      panePid: Number(f[4] ?? 0),
      tty: normTty(f[5] ?? ""),
      // A plain path already, unlike wezterm's `file://` URL - the normalization the
      // interface promises is a no-op on this backend, and empty becomes null rather than "".
      cwd: f[6] || null,
    });
  }
  return panes;
}

/**
 * Parse `list-clients -F CLIENT_FMT`.
 *
 * tmux reports `/dev/ttys028` while wezterm reports `ttys012`, and the join between them is
 * the only link from a session to the window showing it. Normalizing here is what turns the
 * inline `.replace(/^\/dev\//, "")` the old join did into an equality test that a third
 * backend cannot get wrong by reporting the prefix.
 */
export function parseClients(stdout: string): MuxClient[] {
  const clients: MuxClient[] = [];
  for (const line of stdout.split("\n")) {
    const f = fields(line, 2);
    if (!f) continue;
    const tty = normTty(f[0] ?? "");
    if (!tty) continue;
    clients.push({ tty, session: f[1] ?? "" });
  }
  return clients;
}

/**
 * The tmux mode a pane is sitting in (`copy-mode`, `view-mode`, ...), or null when it is in
 * none and keystrokes reach the child normally.
 *
 * This exists for the writers in `actions.ts`, which cannot tell the difference on
 * their own: a pane in a mode routes every key to tmux's OWN key table, so `send-keys`
 * and `paste-buffer` still exit 0 while the child receives nothing.
 *
 * Null is also the answer when the question can't be asked - no tmux, no such pane, or
 * a tmux too old to know these formats. That direction is deliberate. A probe that
 * cannot see a mode is not evidence of one, and treating an unrecognized probe as
 * "blocked" would refuse every write on such a system - a far worse failure than the
 * swallowed keystroke this exists to catch. Only an explicit `1` blocks.
 *
 * `actions.ts` reaches this only as `Multiplexer.paneMode` now. It stays exported for its
 * own tests, which drive the PARSE - what tmux's probe prints back, including the versions
 * that print nothing useful - against verbatim output rather than against a live server,
 * and which assert against a real pane on a machine that has one.
 */
export async function readTmuxPaneMode(
  paneId: string,
  exec: TerminalExec = defaultExec,
): Promise<string | null> {
  const res = await exec(resolveBin(TMUX_BIN), ["display-message", "-p", "-t", paneId, MODE_FMT], {
    env: binEnv(TMUX_BIN),
  });
  if (res.code !== 0) return null;
  const [inMode, ...rest] = res.stdout.trim().split(" ");
  if (inMode !== "1") return null;
  const mode = rest.join(" ");
  // `pane_mode` is empty on tmux versions that predate it. The pane is still in a mode,
  // so the flag alone has to be enough to block; naming it copy-mode is a guess, but it
  // is the one a person can act on (and the one it nearly always is) where "unknown mode"
  // would leave them nothing to clear.
  return mode.trim() || "copy-mode";
}

/**
 * What a tmux session may be called, in both directions - see `NameRules`.
 *
 * Exported because these rules are asserted directly rather than through a live server:
 * they are the whole of what tmux's target grammar forbids, and a test that had to have
 * tmux installed to check them would not run on CI.
 *
 * This is one rule set where there were two halves. `validateSessionName` (`actions.ts`)
 * held the rejections and `sessionLabel` (`dispatcher.ts`) held the coercion, and they had
 * already drifted: the coercion also stripped a leading `=` and `{`, the rejection did not,
 * so a name a dispatch would never have produced could still be typed in. Both halves are
 * here now, and the drift is a diff rather than a discovery.
 */
export const TMUX_NAMES: NameRules = {
  validate: (name) => {
    // The shared half first - see `plainValidate`. Every backend's rules are its own
    // grammar ON TOP OF what no display name can hold, never instead of it.
    const plain = plainValidate(name);
    if (plain) return plain;
    // Both are separators in a tmux target spec (`session:window.pane`), so
    // `rename-session` refuses them outright.
    if (/[.:]/.test(name)) return "a tmux session name can't contain '.' or ':'";
    // A leading '$' is tmux's session-ID sigil: `-t '$0'` resolves by ID and never falls
    // back to a name lookup, so a session named `$0` would make focus and kill target
    // whichever session holds ID 0 instead of this one.
    if (/^\$/.test(name)) return "a tmux session name can't start with '$'";
    return null;
  },
  /**
   * Keeps the text's spaces and capitals - a session name is what the card is titled, so it
   * should read like a heading rather than a slug - and strips only what a tmux name
   * genuinely cannot hold.
   *
   * The leading-sigil strip reaches slightly further than `validate` does, and deliberately:
   * `=` (exact-match), `$` (session ID) and `{` (special token) all lead a tmux target spec,
   * and a name starting with one makes every `-t` we ever aim at it - `has-session`,
   * `kill-session`, the `name:0.0` split and select - resolve to the wrong session or to
   * none. `validate` bars only `$` because that is the one tmux itself will not refuse, and
   * widening a rejection a human sees is a behaviour change; widening a coercion nobody sees
   * is free.
   */
  sanitize: (text) =>
    plainName(
      text
        .replace(/[.:]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[=${]+/, ""),
    ),
};

/** The tmux target spec for a pane. Pane ids are globally unique, so the session is implied. */
function paneTarget(t: MuxTarget): string {
  return t.paneId;
}

/**
 * A buffer name derived from the pane, so two concurrent pastes cannot read each other's
 * text. Non-alphanumerics are stripped because `%3` is a perfectly ordinary pane id and a
 * perfectly bad buffer name.
 */
function pasteBuffer(t: MuxTarget): string {
  return `harness-${t.paneId.replace(/[^a-zA-Z0-9]/g, "")}`;
}

export function tmuxMultiplexer(exec: TerminalExec = defaultExec): Multiplexer {
  const bin = () => resolveBin(TMUX_BIN);
  /**
   * Every tmux command, with the inherited socket pin dropped. Uniform on purpose: the
   * enumeration and the writes have to reach the SAME server, or a pane id from one is
   * addressed against another.
   */
  const tmux = (args: string[], opts: { timeoutMs?: number; input?: string } = {}) =>
    exec(bin(), args, { ...opts, env: binEnv(TMUX_BIN) });
  const cmd = async (
    args: string[],
    fail: string,
    opts: { timeoutMs?: number; input?: string } = {},
  ): Promise<TerminalResult> => toResult(await tmux(args, opts), fail);

  /**
   * Put `text` in this pane's buffer and hand it to the pane - the shape BOTH write verbs
   * take, differing only in the flag that says whether it is being typed or pasted.
   *
   * The payload rides on stdin because tmux imposes its own command-length limit below the
   * operating system's argv ceiling. `load-buffer -b <buf> -` avoids that limit and was
   * verified with 200,000 bytes against tmux 3.6b.
   *
   * The refusal was at least LOUD - `paste-buffer` never ran, so nothing partial reached the
   * pane - and that property is kept: `load-buffer` failing returns before the paste, so a
   * caller reading `ok: false` still knows the composer was not touched.
   *
   * Chunking `send-keys` is not equivalent: it trades one atomic refusal for partial
   * delivery with no way to identify the prefix that landed.
   */
  const viaBuffer = async (
    t: MuxTarget,
    text: string,
    pasteFlags: string[],
    fail: string,
  ): Promise<TerminalResult> => {
    // An empty payload writes nothing, and has to SUCCEED at writing nothing. The old
    // `send-keys -l -- ""` was a no-op that exited 0; the buffer form is not, and the
    // asymmetry is silent - measured against 3.6b, `load-buffer` with empty stdin exits 0
    // but creates no buffer at all, so the `paste-buffer` behind it fails `no buffer
    // harness-…`. Without this line every empty write would start reporting a failure it
    // never used to, which reads to a caller as a pane it could not reach.
    if (text === "") return { ok: true, outcomeUnknown: false };
    const buf = pasteBuffer(t);
    // `-` is the stdin form. No `--` terminator is needed or possible here: the payload is
    // not an argument any more, which is exactly what makes a body starting with a dash
    // safe by construction rather than by remembering a terminator.
    const loaded = await cmd(["load-buffer", "-b", buf, "-"], "tmux load-buffer failed", {
      input: text,
    });
    if (!loaded.ok) return loaded;
    // tmux resolves both the buffer and the pane BEFORE writing, so a non-zero exit here
    // means nothing reached the pane - the one thing a caller most needs to be true.
    // -d: drop the buffer after, so a pane's buffer never outlives the write.
    const pasted = await cmd(
      ["paste-buffer", ...pasteFlags, "-d", "-b", buf, "-t", paneTarget(t)],
      fail,
    );
    if (!pasted.ok) {
      // A failed paste never reached -d, so the buffer would otherwise outlive the write.
      await cmd(["delete-buffer", "-b", buf], "tmux delete-buffer failed");
    }
    return pasted;
  };

  return {
    id: "tmux",
    label: "tmux",
    bin: TMUX_BIN,

    // Returns [] when tmux isn't running (no server / no sessions), which is the common case
    // on a fresh machine. Discovery must degrade silently: the product works fine with a
    // wezterm-only or bare-terminal setup, so an absent backend is not an error.
    list: async () => {
      const res = await tmux(["list-panes", "-a", "-F", PANE_FMT]);
      return res.code === 0 ? parsePanes(res.stdout) : [];
    },

    // Same contract: [] when tmux isn't running or nothing is attached.
    clients: async () => {
      const res = await tmux(["list-clients", "-F", CLIENT_FMT]);
      return res.code === 0 ? parseClients(res.stdout) : [];
    },

    write: {
      /**
       * Type `text` literally, where a newline SUBMITS - `PaneWrite.text`'s contract.
       *
       * tmux offers no stdin form for `send-keys -l`, so the buffer is the only way to keep
       * literal payload bytes out of the size-limited command.
       *
       * **`-r` is what keeps this `text` rather than `paste`, and it is two claims, both
       * measured** against tmux 3.6b at the far end of a real pane holding a byte recorder:
       *
       *   - `-r` means "do not replace LF with CR". Without it `paste-buffer` rewrites every
       *     newline, so `AB\nCD` arrives as `AB\rCD` - a CR is what pressing Enter sends, so
       *     dropping the flag would silently change what a multi-line body does in a
       *     composer. With it, the bytes are `AB\nCD`, exactly what `send-keys -l` delivers.
       *   - omitting `-p` means no bracketed-paste markers, *even when the receiving
       *     application has requested that mode* - which an agent TUI does. Checked
       *     explicitly rather than assumed, by recording against a pty with DECSET 2004 on:
       *     `-r` delivered bare `AB\nCD` while `-p` delivered
       *     `ESC[200~AB\rCD ESC[201~`. Had the markers leaked in, every literal write would
       *     have become a paste and a queue item would sit unsubmitted in the composer.
       *
       * The full hostile payload - UTF-8, an ESC byte, a tab, a bare CR, a leading dash -
       * came back byte-identical between the two forms, which is the assertion that made
       * this substitution safe rather than merely plausible.
       */
      text: (t, text) => viaBuffer(t, text, ["-r"], "tmux paste-buffer failed"),
      // Still `send-keys`, and no `-l`, for the mirrored reason: these ARE key names, which
      // tmux resolves to the terminal's own sequences. Bounded by `Key` - eight short words,
      // never a payload - so the size limit that drove `text` onto the buffer cannot be
      // reached here, and routing them through a paste buffer would send the NAMES as text.
      keys: (t, keys) =>
        cmd(
          ["send-keys", "-t", paneTarget(t), "--", ...keys.map((k) => KEY_NAMES[k])],
          "tmux send-keys failed",
        ),
      // -p: bracketed paste, so embedded newlines do not submit. That flag and `text`'s `-r`
      // are the entire difference between the two verbs now.
      paste: (t, text) => viaBuffer(t, text, ["-p"], "tmux paste-buffer failed"),
    },

    capture: async (t) => {
      const r = await tmux(["capture-pane", "-p", "-t", paneTarget(t)], {
        timeoutMs: CAPTURE_TIMEOUT_MS,
      });
      return r.code === 0 ? r.stdout : null;
    },

    paneMode: (t) => readTmuxPaneMode(t.paneId, exec),

    select: async (t) => {
      const selected = await cmd(["select-pane", "-t", paneTarget(t)], "tmux select-pane failed");
      if (!selected.ok) return selected;
      // Best-effort: the pane is already selected, and a window index that no longer
      // resolves is not worth failing a focus over.
      await cmd(["select-window", "-t", `${t.session}:${t.windowIndex}`], "tmux select-window failed");
      return selected;
    },

    sessions: {
      async spawnDetached(spec: DetachedSessionSpec) {
        // tmux joins the trailing arguments with spaces and runs the result through a
        // shell rather than exec'ing the argv, so anything carrying a quote or a glob is
        // interpreted rather than passed. Callers constrain their argv upstream
        // (`ModelIdSchema`); this comment is here so the next one knows to.
        //
        // `--` for the same reason as `send-keys`: the shell command is a trailing
        // argument, so a binary or flag-first argv beginning with a dash would be parsed as
        // a flag of `new-session` itself.
        const created = await cmd(
          ["new-session", "-d", "-s", spec.name, "-c", spec.cwd, "--", ...spec.argv],
          "tmux new-session failed",
          { timeoutMs: SESSION_TIMEOUT_MS },
        );
        if (!created.ok || !spec.sidePane) return created;
        const agentPane = `${spec.name}:0.0`;
        // A shell pane beside the agent, sized to a third so the agent TUI keeps most of
        // the width. Best-effort by contract - the session is what was asked for.
        await cmd(
          ["split-window", "-h", "-l", "33%", "-t", agentPane, "-c", spec.cwd],
          "tmux split-window failed",
          { timeoutMs: SESSION_TIMEOUT_MS },
        );
        // Leave the agent pane focused so attaching lands on it, not the shell.
        await cmd(["select-pane", "-t", agentPane], "tmux select-pane failed", { timeoutMs: SESSION_TIMEOUT_MS });
        return created;
      },
      // Resolved through `bin`, not the bare name: this argv is handed to an emulator to
      // spawn, so it is the one place a tmux outside PATH matters most and the one place a
      // literal would silently ignore whatever `TMUX_BIN` lists. (It lists only the bare
      // name today, and there is no env override - see `bin.ts` - so this is identical for
      // now and stays right when that spec grows a candidate.)
      attachArgv: (session) => [bin(), "attach", "-t", session],
      // `--` ends flag parsing so a name like "-wip" is read as the new name rather than as
      // a flag bundle (which surfaces an arg-parser dump behind a 500).
      rename: (from, to) => cmd(["rename-session", "-t", from, "--", to], "tmux rename-session failed"),
      // A tmux session IS a killable group - every window and pane in it goes at once,
      // which is what stops a dispatched agent's shell pane outliving the agent.
      kill: (session) =>
        cmd(["kill-session", "-t", session], "tmux kill-session failed", { timeoutMs: SESSION_TIMEOUT_MS }),
      names: TMUX_NAMES,
    },
  };
}
