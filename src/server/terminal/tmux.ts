import { listTmuxClients, listTmuxPanes, readTmuxPaneMode } from "../discovery/tmux.ts";
import type { TmuxClient, TmuxPane } from "../discovery/tmux.ts";
import { normTty } from "../discovery/tty.ts";
import { resolveBin, TMUX_BIN } from "./bin.ts";
import { defaultExec, toResult, type TerminalExec } from "./exec.ts";
import type {
  DetachedSessionSpec,
  Key,
  MuxClient,
  MuxPane,
  MuxTarget,
  Multiplexer,
  TerminalResult,
} from "./types.ts";

/**
 * tmux behind the `Multiplexer` interface.
 *
 * Mechanism only. The copy-mode REFUSAL, the pane lock, the paste settle and the submit
 * read-back stay in `actions.ts` where they belong - they are decisions about when to
 * write, and they are the same decisions for every backend. What lives here is the part
 * that is tmux's alone: its key names, its target grammar, its buffer dance.
 *
 * Enumeration delegates to `discovery/tmux.ts` rather than reparsing its format strings;
 * that module's `FMT`/`MODE_FMT` comments carry hard-won detail (the unit separator that
 * does not survive a non-UTF-8 locale) which must not be duplicated into a second copy
 * that drifts. The command surfaces are written here because they have no existing home -
 * today they are inline `run("tmux", …)` calls at ~19 sites in `actions.ts`,
 * `dispatcher.ts` and `pane-capture.ts`, which the following migration items delete as
 * they route through this adapter.
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
  "shift-tab": "BTab",
};

/** Capturing a pane is on the poll path - keep it well under the tick interval. */
const CAPTURE_TIMEOUT_MS = 1000;
/** Session teardown and creation are user-visible actions, not poll work. */
const SESSION_TIMEOUT_MS = 10000;

/** Normalize one enumerated tmux pane. The ids are already strings; the tty and cwd are not. */
export function toMuxPane(p: TmuxPane): MuxPane {
  return {
    session: p.session,
    windowIndex: p.windowIndex,
    windowName: p.windowName,
    paneId: p.paneId,
    panePid: p.panePid,
    tty: p.tty,
    cwd: p.currentPath || null,
  };
}

/**
 * Normalize one attached client.
 *
 * tmux reports `/dev/ttys028` while wezterm reports `ttys012`, and the join between them is
 * the only link from a session to the window showing it. Normalizing here is what turns
 * `findSessionHostPanes`'s inline `.replace(/^\/dev\//, "")` into an equality test that a
 * third backend cannot get wrong by reporting the prefix.
 */
export function toMuxClient(c: TmuxClient): MuxClient {
  return { tty: normTty(c.tty), session: c.session };
}

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
  const cmd = async (args: string[], fail: string, timeoutMs?: number): Promise<TerminalResult> =>
    toResult(await exec(bin(), args, timeoutMs ? { timeoutMs } : undefined), fail);

  return {
    id: "tmux",
    label: "tmux",
    bin: TMUX_BIN,

    async list() {
      return (await listTmuxPanes()).map(toMuxPane);
    },

    clients: async () => (await listTmuxClients()).map(toMuxClient),

    write: {
      // `-l` sends the text literally, so a body containing something that looks like a key
      // name is typed rather than pressed.
      text: (t, text) =>
        cmd(["send-keys", "-t", paneTarget(t), "-l", text], "tmux send-keys failed"),
      // No `-l` here, for the mirrored reason: these ARE key names.
      keys: (t, keys) =>
        cmd(
          ["send-keys", "-t", paneTarget(t), ...keys.map((k) => KEY_NAMES[k])],
          "tmux send-keys failed",
        ),
      paste: async (t, text) => {
        const buf = pasteBuffer(t);
        const set = await cmd(["set-buffer", "-b", buf, "--", text], "tmux set-buffer failed");
        if (!set.ok) return set;
        // -p: bracketed paste, so embedded newlines do not submit. -d: drop the buffer after.
        // tmux resolves both the buffer and the pane BEFORE writing, so a non-zero exit here
        // means nothing reached the pane - the one thing a caller most needs to be true.
        return cmd(
          ["paste-buffer", "-p", "-d", "-b", buf, "-t", paneTarget(t)],
          "tmux paste-buffer failed",
        );
      },
    },

    capture: async (t) => {
      const r = await exec(bin(), ["capture-pane", "-p", "-t", paneTarget(t)], {
        timeoutMs: CAPTURE_TIMEOUT_MS,
      });
      return r.code === 0 ? r.stdout : null;
    },

    // Delegated, and it resolves `"tmux"` itself rather than through `bin()`. Identical
    // today, since that is the only candidate - but the probe moves in here with the rest
    // of `discovery/tmux.ts` when the migration reaches it, rather than growing a second
    // way to find the binary now.
    paneMode: (t) => readTmuxPaneMode(t.paneId, (b, a) => exec(b, a)),

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
        const created = await cmd(
          ["new-session", "-d", "-s", spec.name, "-c", spec.cwd, ...spec.argv],
          "tmux new-session failed",
          SESSION_TIMEOUT_MS,
        );
        if (!created.ok || !spec.sidePane) return created;
        const agentPane = `${spec.name}:0.0`;
        // A shell pane beside the agent, sized to a third so the agent TUI keeps most of
        // the width. Best-effort by contract - the session is what was asked for.
        await cmd(
          ["split-window", "-h", "-l", "33%", "-t", agentPane, "-c", spec.cwd],
          "tmux split-window failed",
          SESSION_TIMEOUT_MS,
        );
        // Leave the agent pane focused so attaching lands on it, not the shell.
        await cmd(["select-pane", "-t", agentPane], "tmux select-pane failed", SESSION_TIMEOUT_MS);
        return created;
      },
      attachArgv: (session) => ["tmux", "attach", "-t", session],
      // `--` ends flag parsing so a name like "-wip" is read as the new name rather than as
      // a flag bundle (which surfaces an arg-parser dump behind a 500).
      rename: (from, to) => cmd(["rename-session", "-t", from, "--", to], "tmux rename-session failed"),
      kill: (session) =>
        cmd(["kill-session", "-t", session], "tmux kill-session failed", SESSION_TIMEOUT_MS),
      validateName: (name) => {
        // Both are separators in a tmux target spec (`session:window.pane`), so
        // `rename-session` refuses them outright.
        if (/[.:]/.test(name)) return "a tmux session name can't contain '.' or ':'";
        // A leading '$' is tmux's session-ID sigil: `-t '$0'` resolves by ID and never
        // falls back to a name lookup, so a session named `$0` would make focus and kill
        // target whichever session holds ID 0 instead of this one.
        if (/^\$/.test(name)) return "a tmux session name can't start with '$'";
        return null;
      },
    },
  };
}
