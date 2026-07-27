import { normTty } from "../discovery/tty.ts";
import { binEnv, resolveBin } from "./bin.ts";
import { defaultExec, toResult, type TerminalExec } from "./exec.ts";
import { plainName, plainValidate } from "./names.ts";
import { shellCommand } from "./shell.ts";
import type {
  BinSpec,
  DetachedSessionSpec,
  Key,
  MuxPane,
  MuxTarget,
  Multiplexer,
  TerminalResult,
} from "./types.ts";

/**
 * cmux behind the `Multiplexer` interface - the phase 5 acceptance test for that interface.
 *
 * cmux (https://cmux.com, verified against 0.64.20) is a native macOS terminal with named
 * workspaces, splits, and a Unix-socket control API. It was picked as the multiplexer-axis
 * proof BECAUSE it is a near neighbour of tmux: named sessions, panes, splits. A backend
 * that different would have justified any amount of interface churn; a backend that similar
 * only fails where the interface encoded a tmux FACT as a universal one.
 *
 * It found three of those, all fixed in `types.ts` rather than worked around here, and each
 * one is a place tmux's CLI grammar had been mistaken for a capability:
 *
 *   - **`MuxPane.sessionName`** - tmux's session name IS its address, so `MuxTarget.session`
 *     was doing both jobs. cmux separates them, and so does every backend with stable ids
 *     and mutable titles. See `sessionName` below.
 *   - **`MuxSessions.attachArgv` is nullable** - "a session needs a terminal to attach to it"
 *     is true of tmux and false of any multiplexer that draws its own window. See
 *     `attachArgv` below.
 *   - **`MuxPane.panePid` is nullable** - the tty is the join key; the pid was tmux offering
 *     it for free. See `panePid` below.
 *
 * Nothing else needed changing: discovery, `bindPane`, the copy-mode refusal, the pane lock,
 * the paste settle and the submit read-back all drive this adapter unmodified.
 *
 * ## Everything is addressed by UUID
 *
 * cmux accepts three target forms - a UUID, a short ref (`workspace:2`), or an index - and
 * only the first is safe to hold across a poll tick:
 *
 *   - **refs are positional and renumber.** Closing one workspace and opening another during
 *     this session moved the same workspace from `workspace:2` to `workspace:3` to
 *     `workspace:4`. A ref captured on one tick addresses a different workspace on the next.
 *   - **titles are the shell's.** A cmux workspace title defaults to what the shell reports,
 *     so it changes as someone cds, and two workspaces sitting at `~` have the SAME title.
 *     `kill` resolving a title is `kill` picking one of them.
 *
 * So `MuxTarget.session` is a workspace UUID and `MuxPane.paneId` is a surface UUID, both
 * stable for the life of the thing they name, and `sessionName` carries the human title
 * separately. This is the whole reason that field had to exist.
 */

/**
 * The cmux CLI ships inside the app bundle and is NOT symlinked onto PATH by the cask, so
 * the bundle path is a real candidate rather than a convenience - on a stock install the
 * bare name resolves to nothing.
 *
 * `dropEnv` carries the three ids cmux exports into every terminal it opens. They are the
 * `TMUX` / `WEZTERM_UNIX_SOCKET` hazard in its cmux spelling, and worse in one specific way:
 * they do not pick a different SERVER (there is one socket either way), they supply a
 * default TARGET. `cmux send "text"` with no `--surface` types into whatever
 * `CMUX_WORKSPACE_ID` names, so a daemon launched from inside a cmux terminal would aim
 * every untargeted command at the one workspace it happened to be started in. Verified:
 * the same `cmux send` landed on `workspace:1` bare and on `workspace:2` with the variable
 * set.
 *
 * Every command this adapter runs names its target explicitly, so the drop is defence in
 * depth rather than the thing that makes it work - which is the right side to err on for a
 * variable whose effect is to silently redirect a write.
 *
 * `CMUX_SOCKET_PATH` is deliberately NOT dropped: unlike wezterm's socket pin it does not go
 * stale, and if the daemon was started inside cmux it names the very instance whose panes we
 * want.
 */
export const CMUX_BIN: BinSpec = {
  env: "CMUX_BIN",
  candidates: ["/Applications/cmux.app/Contents/Resources/bin/cmux", "cmux"],
  dropEnv: ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TAB_ID"],
};

/**
 * cmux takes key NAMES like tmux, and its spelling happens to be this interface's own -
 * lowercase, hyphenated, `shift-tab` written out.
 *
 * Still a `Record<Key, string>` and not an identity pass-through. The agreement is a
 * coincidence of two vocabularies, not a rule cmux promises, and writing it out is what
 * makes a future `Key` fail typecheck here instead of being sent as a name cmux rejects.
 * `btab` - tmux's spelling - is an `Unknown key` error on this backend, which is exactly the
 * failure a shared vocabulary would have produced.
 */
const KEY_NAMES: Record<Key, string> = {
  enter: "enter",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  "shift-up": "shift-up",
  "shift-down": "shift-down",
  "shift-tab": "shift-tab",
};

/** Capturing is on the poll path - keep it well under the tick interval. */
const CAPTURE_TIMEOUT_MS = 1000;
/** Workspace creation and teardown are user-visible actions, not poll work. */
const SESSION_TIMEOUT_MS = 10000;

/**
 * Bracketed paste, written out here because cmux has no verb for it.
 *
 * `terminal.paste` looks like the one and is not: it answers `{"submitted": true}` and
 * delivers the text followed by a CR, which is paste-AND-send. `PaneWrite.paste` must leave
 * the composer holding a multi-line block, so this wraps the markers itself and lets
 * `send_text` carry them - verified byte-for-byte against a recorder on the far side of a
 * real cmux surface.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** One surface, as `system.tree` reports it. Browser surfaces are in here too. */
interface TreeSurface {
  id?: string;
  tty?: string | null;
  title?: string | null;
  type?: string;
}

interface TreePane {
  id?: string;
  index?: number;
  surfaces?: TreeSurface[];
}

interface TreeWorkspace {
  id?: string;
  title?: string | null;
  panes?: TreePane[];
}

interface TreeWindow {
  ref?: string;
  workspaces?: TreeWorkspace[];
}

/**
 * Parse whatever JSON a cmux command printed, tolerating a leading notice line.
 *
 * cmux prints a deprecation notice on stdout when a legacy command alias is used
 * (`list-workspaces` is now `workspace list`). Every call below uses the modern spelling and
 * sets `CMUX_QUIET`, so this should never fire - it is here because the failure it prevents
 * is every card on the machine vanishing for a tick, and the cost of preventing it is
 * finding one brace.
 */
function parseJson<T>(stdout: string): T | null {
  const at = stdout.indexOf("{");
  if (at < 0) return null;
  try {
    return JSON.parse(stdout.slice(at)) as T;
  } catch {
    return null;
  }
}

/**
 * Parse `cmux tree --all --json --id-format both` into panes.
 *
 * Exported so the JSON-to-panes round trip is testable against verbatim cmux output rather
 * than against a running app, which is the only way this asserts anything on a machine with
 * no cmux installed.
 *
 * `cwds` maps a workspace UUID to the directory it was opened at - see `list` for why that
 * arrives separately and what it is worth.
 *
 * ## A tty is reported only from a workspace holding ONE terminal surface
 *
 * cmux 0.64.20 mis-attributes ttys the moment a workspace holds two. Reproduced from a
 * clean state, against `ps` as ground truth:
 *
 *   - `new-workspace --command "sleep 12345"` -> the process really runs on `ttys031`, and
 *     cmux reports `ttys031`. Correct.
 *   - `new-split` into that same workspace -> the process is STILL on `ttys031`, and cmux
 *     now reports `ttys032` for it (the split's own tty) and `nil` for the split.
 *
 * `debug-terminals` shows the same values, so it is cmux's tracking rather than its
 * rendering, and no other command exposes a second opinion.
 *
 * The tty is the ONLY join between a process and a pane (`correlate.ts`), so a wrong one is
 * not a cosmetic error: the agent's card binds to a surface the agent is not in, and the
 * next prompt is typed into someone's shell. A null costs the card - the session falls back
 * to `nameSource: "process"` and is still listed - which is the same trade every other null
 * in this file makes, and the only one available here.
 *
 * Counted over terminal surfaces per WORKSPACE because that is the scope the displacement
 * was observed within, and browser surfaces hold no pty to displace one with (a browser
 * added to an already-broken workspace changed nothing).
 */
export function parseTree(stdout: string, cwds: ReadonlyMap<string, string>): MuxPane[] {
  const tree = parseJson<{ windows?: TreeWindow[] }>(stdout);
  if (!tree?.windows) return [];
  const panes: MuxPane[] = [];
  for (const win of tree.windows) {
    for (const ws of win.workspaces ?? []) {
      const session = ws.id;
      if (!session) continue;
      const surfaces = (ws.panes ?? []).flatMap((pane) =>
        // A cmux workspace can hold browser surfaces beside its terminals. They have a URL
        // where a terminal has a tty, so they are not panes anything here can address - and
        // dropping them by TYPE says that, where letting the null tty drop them later would
        // leave one looking like a terminal we failed to read.
        (pane.surfaces ?? [])
          .filter((s) => s.type === "terminal" && s.id)
          .map((surface) => ({ pane, surface })),
      );
      const ttyIsTrustworthy = surfaces.length === 1;
      for (const { pane, surface } of surfaces) {
        panes.push({
          session,
          sessionName: ws.title ?? "",
          // cmux nests window > workspace > pane > surface, so its "pane" is the split
          // region and its "surface" is the tab inside one. The surface is what a write
          // addresses, which makes it this interface's pane; the split region is the
          // closest thing to a tmux window, which makes it the index.
          windowIndex: pane.index ?? 0,
          windowName: surface.title ?? "",
          paneId: surface.id as string,
          // See the field's own doc: cmux answers this only from a resource-sampling call.
          panePid: null,
          // Already `/dev/`-stripped by cmux (`ttys022`), so `normTty` is a no-op here -
          // called anyway, because the interface promises the normalization and the next
          // cmux release is not obliged to keep agreeing with it by accident.
          tty: ttyIsTrustworthy ? normTty(surface.tty ?? "") : null,
          cwd: cwds.get(session) ?? null,
        });
      }
    }
  }
  return panes;
}

/** Every window ref in a tree, for the per-window `cwd` sweep `list` has to do. */
export function windowRefs(stdout: string): string[] {
  const tree = parseJson<{ windows?: TreeWindow[] }>(stdout);
  return (tree?.windows ?? []).map((w) => w.ref).filter((r): r is string => Boolean(r));
}

/** Parse one window's `workspace list` into workspace UUID -> opening directory. */
export function parseCwds(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  const listed = parseJson<{ workspaces?: { id?: string; current_directory?: string | null }[] }>(
    stdout,
  );
  for (const ws of listed?.workspaces ?? []) {
    if (ws.id && ws.current_directory) out.set(ws.id, ws.current_directory);
  }
  return out;
}

export function cmuxMultiplexer(exec: TerminalExec = defaultExec): Multiplexer {
  const bin = () => resolveBin(CMUX_BIN);
  /**
   * Every cmux command, with the inherited default-target ids dropped and notices silenced.
   *
   * `CMUX_QUIET` is set rather than parsed around: the notices go to STDOUT, in front of the
   * JSON, and a backend that answers `[]` for a tick because it warned about a command name
   * is a backend that drops every card on the machine.
   */
  const cmux = (args: string[], opts: { timeoutMs?: number } = {}) =>
    exec(bin(), args, { ...opts, env: { ...binEnv(CMUX_BIN), CMUX_QUIET: "1" } });
  const cmd = async (args: string[], fail: string, timeoutMs?: number): Promise<TerminalResult> =>
    toResult(await cmux(args, timeoutMs ? { timeoutMs } : {}), fail);

  /**
   * A socket method with JSON params.
   *
   * The CLI's own subcommands are used everywhere they are safe, and `rpc` where they are
   * not: `cmux send` runs its argument through an escape scanner (see `write.text`), and the
   * lifecycle verbs answer with a REF on stdout where the method answers with the UUID that
   * is still valid a tick later.
   *
   * **The payload rides in argv here, and unlike tmux's and WezTerm's it has nowhere else to
   * go.** `cmux rpc <method> [json-params]` and `cmux send [flags] [--] <text>` both take
   * their body as an argument, and neither help output on the installed 0.64.20 mentions
   * stdin. This backend therefore retains the operating system's `ARG_MAX` ceiling.
   *
   * It is deliberately NOT worked around here. The cmux app was not running on the machine
   * where the rest of this change was measured, so a chunking scheme or a temp-file dance
   * could not be pointed at a real install. `run` (`util/exec.ts`) still turns a synchronous
   * E2BIG into an ordinary refusal with `outcomeUnknown: false`: no process ran, so nothing
   * reached the pane and the caller may retry.
   *
   * The trade is that a socket method takes its params UNVALIDATED. cmux does not reject an
   * unrecognized key, it falls back to the caller's default target - `{"surface":<id>}`
   * instead of `{"surface_id":<id>}` reports success having typed into a completely
   * different pane, and `system.tree` with `all` instead of `all_windows` quietly answers
   * for one window. Both were hit while writing this. Every param name below was verified
   * against a running 0.64.20 by checking WHICH target came back, not that the call
   * succeeded; anything with a documented CLI flag uses the flag for exactly that reason.
   */
  const rpc = (
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ) => cmux(["rpc", method, JSON.stringify(params)], opts);

  return {
    id: "cmux",
    label: "cmux",
    // Stacked panes, mirrored: same axis as tmux, different backend.
    glyph: "▥",
    bin: CMUX_BIN,

    /**
     * Returns [] when the cmux app is not running - the socket only exists while it is - and
     * when it is running but refuses us. Both degrade silently, for the reason tmux's `list`
     * does: the product works fine for someone who does not use cmux.
     *
     * The refusal is worth knowing about because it is cmux's DEFAULT and it is not a bug:
     * `automation.socketControlMode` ships as `cmuxOnly`, which admits only processes started
     * inside cmux, and the daemon is not one. An operator who wants their cmux sessions on
     * the board sets that to `allowAll` in `~/.config/cmux/cmux.json`. Nothing here can
     * detect the difference between "not running" and "not permitted" without spending a
     * second call per tick to ask, and the answer would be the same `[]`.
     *
     * Two calls, not one, and the second is per cmux window: `system.tree` is the only thing
     * that spans windows, and it does not carry a directory; `workspace list` carries one and
     * is scoped to a single window (verified - with two windows up it returned 1 of 4
     * workspaces). They are issued together, so the tick costs the slower rather than the sum.
     */
    list: async () => {
      const tree = await cmux(["tree", "--all", "--json", "--id-format", "both"]);
      if (tree.code !== 0) return [];
      const refs = windowRefs(tree.stdout);
      const perWindow = await Promise.all(
        refs.map((ref) =>
          cmux(["workspace", "list", "--json", "--id-format", "both", "--window", ref]),
        ),
      );
      const cwds = new Map<string, string>();
      for (const res of perWindow) {
        if (res.code !== 0) continue;
        for (const [id, dir] of parseCwds(res.stdout)) cwds.set(id, dir);
      }
      return parseTree(tree.stdout, cwds);
    },

    /**
     * Null: nothing attaches to a cmux workspace over a tty.
     *
     * This is the capability that tells the focus walk whether an outer terminal is showing
     * this session, and it exists because a tmux session is invisible until some emulator
     * runs `tmux attach` - the client tty being the only link between the two. A cmux
     * workspace is drawn by cmux. There is no client, so there is no tty to join on, and a
     * join against `TerminalEmulator.list` would be asking which wezterm tab is displaying a
     * window wezterm does not own.
     *
     * Null here is therefore "there is never anything to find", not "we cannot look" - and
     * `hostPanesFor` returning nothing is the correct answer rather than a degraded one. See
     * `attachArgv` for the other half, and for what focus still owes this backend.
     */
    clients: null,

    write: {
      /**
       * `rpc surface.send_text`, and NOT `cmux send`, which cannot express literal text.
       *
       * `cmux send` scans its argument for the two-character sequences `\n`, `\r` and `\t`
       * and replaces them - `\n` and `\r` with a CR, which in an agent composer is Enter.
       * There is no escape: `\\n` does not collapse to `\n`, it delivers a backslash AND
       * the CR (verified on 0.64.20 across single, double and quadruple backslashes). So a
       * reply containing `printf("\n")` submits itself halfway through, and one containing a
       * Windows path silently loses characters.
       *
       * That is the same class of defect as tmux's getopt eating a dash-leading reply, and
       * one layer worse: tmux refused the command loudly, this delivers corrupted text and
       * exits 0. The socket method takes its text as a JSON string and applies no scanner -
       * the two-character `\n` arrives as two characters.
       *
       * A REAL newline (0x0A) still arrives as CR, on both paths. That is the terminal
       * convention for typing Enter rather than a cmux quirk (tmux's `paste-buffer` does the
       * same by default), and it is why a multi-line prompt goes through `paste` below.
       */
      text: async (t, text) =>
        toResult(
          await rpc("surface.send_text", { surface_id: t.paneId, text }),
          "cmux surface.send_text failed",
        ),

      keys: async (t, keys) => {
        // One call per key: the method takes a single `key`. They are awaited in order
        // rather than raced, because the only reason to send two keys is that their order is
        // the point (Escape then Enter, an arrow walk through a menu).
        for (const k of keys) {
          const res = toResult(
            await rpc("surface.send_key", { surface_id: t.paneId, key: KEY_NAMES[k] }),
            "cmux surface.send_key failed",
          );
          if (!res.ok) return res;
        }
        return { ok: true, outcomeUnknown: false };
      },

      /**
       * Bracketed paste, composed from `send_text` and the markers.
       *
       * cmux has no paste verb that leaves the composer unsubmitted - `terminal.paste` sends
       * a trailing CR and reports `submitted` - so the markers are written here. One call, so
       * unlike tmux's buffer-load-then-paste sequence there is no window in which half of it has
       * happened: either the whole block reached the pane or none of it did.
       */
      paste: async (t, text) =>
        toResult(
          await rpc("surface.send_text", {
            surface_id: t.paneId,
            text: `${PASTE_START}${text}${PASTE_END}`,
          }),
          "cmux bracketed paste failed",
        ),
    },

    capture: async (t) => {
      const r = await cmux(["read-screen", "--surface", t.paneId], {
        timeoutMs: CAPTURE_TIMEOUT_MS,
      });
      return r.code === 0 ? r.stdout : null;
    },

    /**
     * Null CAPABILITY: cmux has no copy-mode, and says so itself.
     *
     * `cmux copy-mode` exits non-zero with `copy-mode is not supported yet in cmux CLI parity
     * mode`, so there is no state a pane can be sitting in that swallows the keystrokes this
     * adapter writes. That is the same claim wezterm's null makes and NOT the claim "we asked
     * and this pane is in no mode" - the two are different, `BoundPane.mode` keeps them
     * apart, and reading this one as the other is how a real multiplexer's swallowed writes
     * would start being reported as delivered.
     *
     * The word to watch is cmux's own: "not supported YET". If a release adds it, this stops
     * being a declaration and becomes a gap, and the writes above go unguarded until it is
     * implemented here.
     */
    paneMode: null,

    /**
     * Select the workspace, then the surface inside it.
     *
     * Two calls because they are two questions in cmux as in tmux, and the second is
     * best-effort for the same reason `select-window` is there: the workspace is already
     * selected, and a surface that has since closed is not worth failing a focus over.
     *
     * Deliberately raises nothing. cmux CAN raise its own window, which no multiplexer this
     * interface was built for could - see `attachArgv` for why that capability is not being
     * invented here.
     */
    select: async (t) => {
      const selected = await cmd(
        ["select-workspace", "--workspace", t.session],
        "cmux select-workspace failed",
      );
      if (!selected.ok) return selected;
      await cmd(["focus-panel", "--panel", t.paneId], "cmux focus-panel failed");
      return selected;
    },

    sessions: {
      /**
       * `new-workspace`, unfocused, running the agent.
       *
       * "Detached" is the interface's word for tmux's `new-session -d`, and cmux's nearest
       * honest equivalent is `--focus false` - the workspace is created and the app does not
       * switch to it. It is NOT detached in tmux's sense and cannot be: cmux workspaces do
       * not outlive the app. Verified by killing it - the workspace list comes back from a
       * snapshot on relaunch, with fresh shells, and every child process is gone. Anything
       * that needs a session to survive its window still needs tmux, which is exactly what
       * cmux's own `surface resume --kind tmux --shell "tmux attach -t work"` is for.
       *
       * The CLI rather than `workspace.create`, against the preference everywhere else in
       * this file, because the method silently ignores the two params that matter: called
       * with `{name, cwd, command, focus}` it honours `cwd` and `focus`, drops `name` (the
       * workspace came back titled "Terminal") and drops `command` (nothing ran - no such
       * process, and the surface had no pty until it was first displayed). The CLI flags are
       * documented and were verified end to end, by reading the bytes the spawned process
       * received. Paying a ref for that is the right trade; it is used once, immediately.
       *
       * cmux accepts one `--command` string and runs it through a shell, so the argv is
       * encoded as shell words before it crosses that boundary.
       */
      async spawnDetached(spec: DetachedSessionSpec) {
        // `--` is NOT used, and that is not an oversight: cmux parses the trailing operand
        // itself, so a dash-leading value arrives intact without one (verified), and the
        // flags below each take their own argument.
        const created = await cmd(
          [
            "new-workspace",
            "--name",
            spec.name,
            "--cwd",
            spec.cwd,
            "--command",
            shellCommand(spec.argv),
            "--focus",
            "false",
          ],
          "cmux new-workspace failed",
          SESSION_TIMEOUT_MS,
        );
        // `sidePane` is deliberately not honoured, and this is the one refusal here that
        // costs a feature rather than declaring an absence. cmux can split - `new-split`
        // works - but a second terminal surface in a workspace is what triggers the tty
        // mis-attribution documented on `parseTree`, and a workspace whose tty cannot be
        // trusted is a workspace whose agent never gets a card. Trading the session for a
        // convenience shell is not a trade to make, and the contract already says a backend
        // that cannot deliver the side pane still reports the session it created as success.
        // When cmux fixes the attribution, this and the `parseTree` guard lift together.
        return created;
      },

      /**
       * Null: a cmux workspace is never detached from a window, so there is nothing to
       * attach to it.
       *
       * **This is the field that had to change shape**, and the reason is worth stating
       * because it is the interface's one tmux-shaped assumption that a near neighbour still
       * broke. `attachArgv` is handed to `EmulatorSpawn.tab(...)` at the end of the focus
       * walk - the step that opens a terminal window running `tmux attach` when a session
       * has no window showing it. It assumes a multiplexer session can EXIST with nothing
       * displaying it, which is true of tmux, screen and zellij, and false of cmux: a
       * workspace is drawn by the cmux app from the moment it is created.
       *
       * Every value that could go here is a lie with a different cost. `cmux
       * select-workspace --workspace <id>` is the closest, and handing it to another
       * emulator's `spawn.tab` opens a wezterm tab that selects a cmux workspace and exits,
       * leaving a stray empty tab beside a window that was already on screen.
       *
       * So the slot is nullable and this backend declares it, in the same register as every
       * other null here: nothing to attach, rather than an attach we could not build.
       *
       * What that leaves open, deliberately: focus for a self-hosting multiplexer. The walk
       * is select -> find a host tab -> spawn an attach, and cmux answers null to the last
       * two while being perfectly able to raise its own window (`focus-window`, plus
       * activating the app). Expressing that needs a capability the interface does not have
       * and this adapter must not invent one - `docs/plans/pluggable-integrations/plan.md`
       * puts it on the focus/spawn/kill item, which is the phase that rewrites the walk and
       * the phase that will have a caller for it. Adding a null slot nobody has designed is
       * the thing that plan's harness work explicitly refused to do.
       */
      attachArgv: null,

      rename: (from, to) =>
        cmd(["rename-workspace", "--workspace", from, to], "cmux rename-workspace failed"),

      kill: (session) =>
        cmd(
          ["close-workspace", "--workspace", session],
          "cmux close-workspace failed",
          SESSION_TIMEOUT_MS,
        ),

      /**
       * cmux rejects exactly one thing: a title that is blank or only whitespace
       * (`rename-workspace requires a title`).
       *
       * Everything tmux forbids is legal here, and that is not laxness on cmux's part - it is
       * what the difference between the two backends' target grammars actually is. `.` and
       * `:` are separators in `session:window.pane` and a leading `$` is tmux's session-ID
       * sigil, so tmux has to refuse them or `-t` resolves somewhere else. A cmux title is
       * never parsed as a target by this adapter, because everything here is addressed by
       * UUID, so `a.b`, `a:b`, `$0` and `-wip` are all just names. Verified: all accepted,
       * and read back unchanged.
       *
       * The one that LOOKS like it should be refused is a title spelled like a ref
       * (`workspace:1`) or a bare index (`0`) - cmux accepts both as titles, and both are
       * also target forms it accepts. That collision is real and it is exactly what
       * addressing by UUID makes unreachable, so refusing them here would be inventing a rule
       * to protect against a lookup this adapter never does. If anything ever resolves a cmux
       * workspace by title, this is the comment that says the rule has to come back.
       */
      names: {
        validate: (name) => {
          // The shared half first - see `plainValidate`. Every backend's rules are its own
          // grammar ON TOP OF what no display name can hold, never instead of it: a control
          // character is meaningless in a cmux title bar too.
          const plain = plainValidate(name);
          if (plain) return plain;
          if (!name.trim()) return "a cmux workspace title can't be blank";
          return null;
        },
        /**
         * Nothing to strip beyond the shared half, which is the same finding as `validate`
         * read in the other direction: a cmux title is never parsed as a target, so there is
         * no grammar to coerce text into. `plainName` still collapses control characters and
         * caps the length - and its non-empty fallback is what makes the one rule above
         * unreachable from a dispatch, which is the round trip `terminal-name-rules.test.ts`
         * pins for every backend.
         */
        sanitize: plainName,
      },
    },
  };
}
