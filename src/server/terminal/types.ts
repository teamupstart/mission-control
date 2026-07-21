/**
 * The two terminal integration points, and why there are two of them.
 *
 * A tmux pane lives INSIDE a wezterm pane. They are not peers and one flat `Terminal`
 * interface would be a lie: `registry.ts:hostPanesFor` exists solely to join the two by
 * shared tty, and focus for a tmux-hosted session is a COMPOSITION -
 * select-pane, select-window, find the wezterm tab hosting a client, raise it, else spawn
 * `tmux attach` in a fresh tab. Folding that into one interface would either force every
 * emulator to pretend it has named sessions or force every multiplexer to pretend it can
 * raise a window.
 *
 * So:
 *   - `Multiplexer`   - named persistent sessions, panes, splits, detach/reattach,
 *                       copy-mode. Addresses a pane; generally CANNOT raise a window.
 *                       (tmux, zellij, screen, cmux)
 *   - `TerminalEmulator` - windows and tabs, focus/raise, spawn, tab titles. No
 *                       persistence, no session names. (wezterm, Ghostty, iTerm2, kitty)
 *
 * See `registry.ts` for the composition rule that binds the two.
 *
 * ## Meaningful nulls, not stubs
 *
 * Every optional capability is `T | null`, and null is a DECLARATION rather than a gap.
 * The candidate backends genuinely differ: tmux has a copy-mode probe and wezterm has no
 * such concept; wezterm can raise a window and tmux cannot; wezterm has no session to
 * kill; Ghostty has no scripting CLI at all, so it can be launched into but never
 * enumerated or captured. A flat interface with fifteen required methods would make every
 * one of those a stub, and a stub that returns a plausible empty value is how a new
 * backend degrades silently instead of visibly.
 *
 * The payoff is mechanical: `if (session.tmux) … else if (session.wezterm) …` becomes
 * `if (!pane.mode) …`, which states WHY it is skipping rather than which vendor it
 * recognised - and a third backend gets the identical, already-tested path.
 *
 * ## What is normalized here, and why
 *
 * The two existing backends disagree about the representation of the same things, and
 * every disagreement is currently resolved at the call site (or not at all):
 *
 *   - pane id: wezterm's is a `number`, tmux's is a string (`"%3"`). One `string` here.
 *   - cwd: wezterm reports a `file://` URL, tmux a plain path. Plain path here.
 *   - keys: tmux takes key NAMES (`BTab`, `Up`), wezterm takes escape SEQUENCES
 *     (`\x1b[Z`, `\x1b[A`), and a third backend will use a third convention. Callers name
 *     a `Key`; the adapter renders it.
 *   - client tty: tmux reports `/dev/ttys028`, wezterm reports `ttys012`. Both normalized
 *     through `normTty`, so the composition join is an equality test rather than a strip.
 *
 * The backend IDS are already shared (`@shared/terminal.ts`), because `NameSource` derives
 * from them. The handle TYPES stay server-side until phase 3 promotes them, which is when
 * `Session.tmux` / `Session.wezterm` become one list.
 */

/**
 * The backend ids live in `@shared/terminal.ts`, not here, and re-exporting them keeps every
 * server call site reaching them where it always has.
 *
 * They moved because `NameSource` - a `Session` field the dashboard renders - is now derived
 * from them, and the web bundle cannot import this module: `list` spawns a subprocess.
 * Adding an id there still fails typecheck HERE, in `Record<MultiplexerId, Multiplexer>`,
 * until a complete adapter exists, which is the enforcement that matters: "I forgot
 * copy-mode exists" stops being a possible outcome.
 */
export type { EmulatorId, MultiplexerId, TerminalBackendId } from "@shared/terminal.ts";

import type { EmulatorId, MultiplexerId } from "@shared/terminal.ts";

/**
 * The outcome of one terminal operation.
 *
 * Deliberately not `RunResult`: an adapter need not be a subprocess at all (iTerm2 scripts
 * via AppleScript/Python, and an in-process API is conceivable), so the interface must not
 * hand callers an exit code to interpret.
 *
 * `outcomeUnknown` is REQUIRED for the reason `RunResult.outcomeUnknown` is: a write that
 * died rather than answering may still have reached the pane, and "it was refused" and "we
 * never found out" call for opposite recoveries. `injectPrompt` is the caller that proves
 * it - it re-pastes only on positive evidence of non-delivery, so a timed-out
 * `paste-buffer` reported as a clean failure is how a prompt gets pasted twice and mangled.
 * An optional flag would default that decision to whoever forgot it.
 */
export interface TerminalResult {
  ok: boolean;
  error?: string;
  outcomeUnknown: boolean;
}

/**
 * The key vocabulary a caller may name. Derived from an object rather than written as a
 * union so `ALL_KEYS` cannot drift from `Key`.
 *
 * Every adapter renders these through a `Record<Key, string>`, so adding one here fails
 * typecheck in each backend until it says what that key looks like in its own convention.
 */
const KEYS = {
  enter: true,
  up: true,
  down: true,
  left: true,
  right: true,
  "shift-tab": true,
} as const;

export type Key = keyof typeof KEYS;

/** Every `Key`, for callers that must iterate the vocabulary (and for its tests). */
export const ALL_KEYS = Object.keys(KEYS) as readonly Key[];

/** What a multiplexer operation addresses. A pane, plus the session/window that reach it. */
export interface MuxTarget {
  session: string;
  windowIndex: number;
  /** Normalized to a string; tmux's own form is already one (`"%3"`). */
  paneId: string;
}

/** What an emulator operation addresses. The tab is needed because raising is tab-level. */
export interface EmulatorTarget {
  paneId: string;
  tabId: string;
}

/** One pane, as a multiplexer enumerates it. */
export interface MuxPane extends MuxTarget {
  windowName: string;
  /** The pane's root process, usually the shell. */
  panePid: number;
  /** Controlling tty without the `/dev/` prefix, or null. The join key to everything else. */
  tty: string | null;
  /** A plain filesystem path, never a URL. */
  cwd: string | null;
}

/**
 * One client attached to a multiplexer session.
 *
 * This is the composition primitive, not a curiosity: a terminal tab running
 * `tmux attach` shares its tty with the tmux CLIENT, while the agent inside sits on a
 * tmux PANE tty. That shared client tty is the only link between a multiplexer session and
 * the window showing it, so anything that needs the visible tab - raising it, retitling it
 * - comes through here.
 */
export interface MuxClient {
  /** Normalized like `MuxPane.tty`, so the join against an emulator pane is `===`. */
  tty: string | null;
  session: string;
}

/** One pane, as an emulator enumerates it. */
export interface EmulatorPane extends EmulatorTarget {
  windowId: string;
  tabTitle: string;
  windowTitle: string;
  isActive: boolean;
  /** Controlling tty without the `/dev/` prefix, or null. */
  tty: string | null;
  /** A plain filesystem path - wezterm's `file://` URL is resolved by its adapter. */
  cwd: string | null;
}

/**
 * Writing to a pane. The three verbs are not interchangeable and callers must not
 * substitute one for another:
 *
 *   - `text` types literally. A newline in it SUBMITS, which is correct for a one-line
 *     reply and wrong for a prompt.
 *   - `keys` presses named keys, rendered to the backend's own convention.
 *   - `paste` delivers one bracketed paste, which agent TUIs treat as a single block. It
 *     is the only way to put a multi-line prompt in a composer without submitting it at
 *     every newline, so a backend that lacks it declares null and its callers refuse
 *     multi-line delivery rather than shredding it into submissions.
 *
 * Policy lives above this: the copy-mode refusal, the pane lock, the post-paste settle and
 * the submit read-back are decisions about WHEN to write, and they compose these verbs.
 * An adapter only knows how.
 */
export interface PaneWrite<T> {
  text(target: T, text: string): Promise<TerminalResult>;
  keys(target: T, keys: readonly Key[]): Promise<TerminalResult>;
  paste: ((target: T, text: string) => Promise<TerminalResult>) | null;
}

/** A detached session to create: what to run, where, and under what name. */
export interface DetachedSessionSpec {
  name: string;
  cwd: string;
  /**
   * The agent binary and its arguments. The agent must land in the pane discovery binds to.
   *
   * NOT guaranteed to be exec'd as an argv, and callers must constrain the values upstream
   * (as `ModelIdSchema` does) rather than rely on quoting here. How it is delivered is
   * backend-dependent and that is a real divergence, not an implementation detail: tmux
   * joins the trailing arguments with spaces and runs the result through a SHELL, so a
   * value carrying a quote, a glob or a `;` is interpreted; a zellij adapter would exec the
   * argv directly and pass the same value through untouched.
   */
  argv: readonly string[];
  /**
   * Also open a plain shell pane beside the agent, rooted at the same directory.
   * Best-effort by contract: a backend that cannot split must still report the session it
   * did create as a success, because a convenience pane is not worth failing a dispatch.
   */
  sidePane: boolean;
}

/**
 * The named-session lifecycle - the half of a multiplexer an emulator has no answer for.
 * Null for a multiplexer that only ever attaches to what is already running.
 */
export interface MuxSessions {
  spawnDetached(spec: DetachedSessionSpec): Promise<TerminalResult>;
  /**
   * The argv that attaches a terminal to `session`. Not a command we run: it is handed to
   * an emulator's `spawn` so a session with no window gets one. Pure, so the focus walk
   * can build it without shelling out.
   */
  attachArgv(session: string): readonly string[];
  rename(from: string, to: string): Promise<TerminalResult>;
  kill(session: string): Promise<TerminalResult>;
  /**
   * Reject a name this backend's own target grammar cannot express, returning the reason
   * or null when the name is fine. Null capability means anything goes.
   *
   * tmux is why this exists: `.` and `:` are separators in `session:window.pane` and a
   * leading `$` is its session-ID sigil, so `-t '$0'` silently resolves to whichever
   * session holds ID 0. Those rules are open-coded in `validateSessionName` today, which
   * is exactly the shape of thing a second multiplexer gets wrong.
   */
  validateName: ((name: string) => string | null) | null;
}

/**
 * A multiplexer: named persistent sessions holding panes that outlive any window.
 *
 * `list` and `write` are required. A multiplexer we cannot enumerate can never be
 * discovered, so it has no panes to talk about; a multiplexer we cannot type into is not
 * one this product can use. Everything else is a declared capability.
 */
export interface Multiplexer {
  id: MultiplexerId;
  /** Human label for UI and error text ("tmux"). */
  label: string;
  bin: BinSpec;
  list(): Promise<MuxPane[]>;
  write: PaneWrite<MuxTarget>;
  /** Null when the backend cannot report who is attached - focus then cannot walk outward. */
  clients: (() => Promise<MuxClient[]>) | null;
  /** The pane's visible text, or null when the read fails. Null capability = no screen scraping. */
  capture: ((target: MuxTarget) => Promise<string | null>) | null;
  /**
   * The mode this pane is sitting in (`copy-mode`, `view-mode`, ...), or null when it is in
   * none. Null CAPABILITY means the backend has no such concept - which is not the same
   * claim, and callers must not read one as the other.
   *
   * It exists because a pane in a mode routes every key to the multiplexer's own key table:
   * the write still exits 0 and the child receives nothing. Reporting that as success is the
   * one lie this layer must never tell.
   */
  paneMode: ((target: MuxTarget) => Promise<string | null>) | null;
  /**
   * Select this pane and its window INSIDE the multiplexer. Deliberately not called
   * "focus": it raises no window, so on its own it only decides what the session shows if
   * someone looks at it. See the composition rule in `registry.ts`.
   */
  select: ((target: MuxTarget) => Promise<TerminalResult>) | null;
  sessions: MuxSessions | null;
}

/**
 * How far an emulator can be aimed.
 *
 * `pane` raises a specific tab. `app` brings the application forward with no idea which tab
 * it will be showing - the honest answer for something with no scripting CLI, and one a UI
 * can report as "brought Ghostty forward" rather than pretending it focused a session.
 */
export type EmulatorFocus =
  | { granularity: "pane"; raise(target: EmulatorTarget): Promise<TerminalResult> }
  | { granularity: "app"; raise(): Promise<TerminalResult> };

/**
 * What opening a tab produced. Two questions, deliberately separate:
 *
 *   - `ok` - did a tab open?
 *   - `target` - can we address what opened?
 *
 * They are not the same question, and collapsing them into a nullable id (which is what
 * `spawnWeztermTab` returns today, and what the focus fallback reads as failure) makes an
 * emulator that opens tabs perfectly well but cannot say what it made - Ghostty - look
 * broken. Null `target` with `ok: true` is a complete, honest answer: the human got their
 * window, and nothing may be typed into it.
 */
export interface SpawnResult extends TerminalResult {
  target: EmulatorTarget | null;
}

export interface EmulatorSpawn {
  /** Open a new tab running `argv` under `title`. */
  tab(argv: readonly string[], title: string): Promise<SpawnResult>;
}

/**
 * A terminal emulator: windows and tabs, here and now, with nothing that survives it
 * closing.
 *
 * EVERY capability is nullable, including enumeration and writing, and that is the design
 * under test. Ghostty has no scripting CLI: it can be launched into and brought forward,
 * and it can be neither listed nor captured nor typed into. If that adapter needs a field
 * added to this interface, the interface was shaped around `wezterm cli` rather than around
 * terminal emulators.
 */
export interface TerminalEmulator {
  id: EmulatorId;
  /** Human label for UI and error text ("WezTerm"). */
  label: string;
  bin: BinSpec;
  list: (() => Promise<EmulatorPane[]>) | null;
  write: PaneWrite<EmulatorTarget> | null;
  capture: ((target: EmulatorTarget) => Promise<string | null>) | null;
  focus: EmulatorFocus | null;
  spawn: EmulatorSpawn | null;
  /** Rename the tab a pane lives in - the value `list` reports back as `tabTitle`. */
  retitle: ((target: EmulatorTarget, title: string) => Promise<TerminalResult>) | null;
}

/**
 * How to reach a backend's CLI: which binary, and in what environment.
 *
 * One shape because there is one behavior, and it was written once (for wezterm) and assumed
 * away everywhere else - `"tmux"` is a literal at ~19 call sites, so a tmux outside PATH is
 * unreachable with no way to say so, and nothing sanitized tmux's inherited environment at
 * all.
 */
export interface BinSpec {
  /** Env var that overrides everything, or null when the backend has no such convention. */
  env: string | null;
  /**
   * Candidates tried in order. The last is conventionally the bare name, i.e. "hope it is
   * on PATH" - the answer when nothing else matched, not a match itself.
   */
  candidates: readonly string[];
  /**
   * Inherited env vars to DROP before running this backend's CLI.
   *
   * Both shipped backends need this and for the same reason: each has a var that pins its
   * CLI to ONE server instance, and the daemon inherits whichever one it happened to be
   * launched inside. `WEZTERM_UNIX_SOCKET` pins wezterm to a GUI's mux socket; `TMUX` pins
   * tmux to a socket path. A daemon started from inside `tmux -L work` then enumerates only
   * that server's panes and is blind to every session on the default socket - which is the
   * wezterm bug, unfixed, on the other backend.
   *
   * DATA rather than a scrub function, for the reason `DetectSpec` is data rather than a
   * predicate: a rule hidden inside a callback cannot be audited, and this is exactly the
   * kind of rule a third backend gets wrong silently. `binEnv` (`bin.ts`) applies it.
   */
  dropEnv: readonly string[];
}
