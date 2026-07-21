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
 * kill; Ghostty scripts through AppleScript rather than a CLI and can neither read its own
 * screen nor retitle a tab. A flat interface with fifteen required methods would make every
 * one of those a stub, and a stub that returns a plausible empty value is how a new
 * backend degrades silently instead of visibly.
 *
 * The discipline that keeps a null honest: declare one only after pointing the capability
 * at a real backend. Every null below has been. Ghostty is why the sentence above no longer
 * reads "has no scripting CLI at all, so it can be launched into but never enumerated or
 * captured" - that was written from release notes, and three of its four claims were false.
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
 * The backend IDS and the TARGET/HANDLE types are shared (`@shared/terminal.ts`): a
 * `Session` carries its handles and the dashboard reasons about them. What stays here is
 * everything that can only run in the daemon - enumeration, writes, captures, spawns.
 */

/**
 * The ids and the address types live in `@shared/terminal.ts`, not here, and re-exporting
 * them keeps every server call site reaching them where it always has.
 *
 * They moved for the same purity reason twice over: `NameSource` and `Session.terminals` are
 * fields the dashboard renders, and the web bundle cannot import this module, whose `list`
 * spawns a subprocess. Adding an id there still fails typecheck HERE, in
 * `Record<MultiplexerId, Multiplexer>`, until a complete adapter exists, which is the
 * enforcement that matters: "I forgot copy-mode exists" stops being a possible outcome.
 */
export type {
  EmulatorId,
  EmulatorTarget,
  MultiplexerId,
  MuxTarget,
  TerminalBackendId,
} from "@shared/terminal.ts";

import type { EmulatorId, EmulatorTarget, MultiplexerId, MuxTarget } from "@shared/terminal.ts";

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

/** One pane, as a multiplexer enumerates it. */
export interface MuxPane extends MuxTarget {
  /**
   * The session's HUMAN name - what a card is titled, as opposed to what `session` addresses.
   *
   * These are one string in tmux, where a session name is also its target spec, and that
   * coincidence is why this field did not exist until a second multiplexer needed it. cmux
   * separates them and cannot be made not to: a workspace has a UUID that is stable for its
   * lifetime and a title that defaults to whatever the shell reports, so the title changes
   * as someone cds and two workspaces sitting at `~` share one. Naming cards by the id is
   * unreadable; addressing by the title makes `kill` a coin flip between two sessions.
   *
   * `EmulatorPane` had this split from the start (`tabId` addresses, `tabTitle` displays);
   * this is the multiplexer side catching up. A backend where the two genuinely are one
   * string sets both to it, which is what tmux does.
   */
  sessionName: string;
  windowName: string;
  /**
   * The pane's root process, usually the shell, or null when the backend does not report it.
   *
   * Null is a declaration, and a cheap one to get wrong: nothing joins on this. The tty is
   * what links a pane to the process in it (`correlate.ts`), and the pid is here because
   * tmux hands it over in the same format string for free. A backend that would have to buy
   * it separately says null instead of paying - cmux answers it only from a resource-sampling
   * call that walks every process in every surface, which is not a thing to spend on the
   * 1500ms discovery tick for a field no reader consults.
   */
  panePid: number | null;
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
  /**
   * Controlling tty without the `/dev/` prefix, or null.
   *
   * The STRONGEST correlation key, and for a long time the only one - see `HostProcessSpec`
   * for why null here is a real state and not a broken adapter. When set it is exact and
   * nothing else is consulted.
   */
  tty: string | null;
  /**
   * A plain filesystem path - wezterm's `file://` URL is resolved by its adapter.
   *
   * Also the WEAK correlation key, consulted only for a pane whose `tty` is null. It is weak
   * because two tabs open on one directory are indistinguishable by it, which is why the
   * matcher requires uniqueness rather than taking a first hit (`discovery/correlate.ts`).
   */
  cwd: string | null;
}

/**
 * How to recognise this emulator's GUI process in the process table.
 *
 * The second correlation key, and it exists because an emulator can be fully capable and
 * still be unable to say which tty a pane is on. Ghostty is the case that forced it,
 * measured rather than assumed (`todo/ghostty-emulator.md`): its AppleScript dictionary
 * enumerates surfaces, focuses them, spawns them and types into them, and
 * `get properties of terminal` returns exactly `id`, `name` and `working directory`. No tty.
 * No pid. So every field of `EmulatorPane` is answerable except the one that makes a pane
 * findable, and an adapter with `list` implemented enumerated into a void.
 *
 * Declaring `list: null` instead would record a false REASON ("cannot enumerate") for a true
 * OUTCOME ("cannot correlate") - the same conflation `HARNESSES.codex.transcript.messages`
 * is null rather than `[]` to avoid.
 *
 * DATA rather than a predicate, for the reason `DetectSpec` is: a rule hidden inside a
 * callback cannot be audited, and the audit is the point. `correlate.ts` owns the ancestry
 * walk and names no vendor; an adapter only says what its GUI is called.
 *
 * Null is the other real answer, and it is what both shipped backends declare: a pane whose
 * tty the backend already reports needs no fallback. Note a multiplexer has no slot for this
 * at all - it owns its ptys, so its panes always carry a tty, and its server is reparented
 * away from its clients so ancestry would say nothing anyway. That last fact is load-bearing
 * in the other direction too: a tmux session hosted inside a Ghostty window does NOT walk up
 * to Ghostty, so the multiplexer keeps the pane and the two axes cannot fight over it.
 */
export interface HostProcessSpec {
  /**
   * argv0 basenames of the GUI process, matched exactly. Not substrings: a command line
   * carrying an operator's paths must never be read as a terminal (the lesson
   * `DetectSpec.background` learned the expensive way).
   */
  commands: readonly string[];
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

/**
 * What a name may be on one backend, in both directions.
 *
 * Two verbs rather than one because the product asks the question twice and gets to
 * answer differently each time: a human typing a rename must be REFUSED with a reason
 * they can act on, while a dispatch cutting a session name out of a task title must
 * always end up with something usable and so has to COERCE. Splitting them is what stops
 * "reject a leading `$`" and "strip a leading `$`" drifting apart, which is exactly what
 * happened while `validateSessionName` (`actions.ts`) and `sessionLabel` (`dispatcher.ts`)
 * each held half of tmux's target grammar: the second one also stripped `=` and `{`, the
 * first did not, and nothing connected them.
 *
 * These belong to the ADAPTER and not to shared validation. `.` and `:` are separators in
 * `session:window.pane` and a leading `$` is tmux's session-ID sigil - facts about one
 * backend's target grammar, invisible to anything else, and precisely the kind of rule a
 * second multiplexer gets wrong by inheriting.
 */
export interface NameRules {
  /**
   * The reason this name cannot be expressed on this backend, or null when it is fine.
   * Reads as a sentence for a human, since it reaches them as a 400.
   */
  validate(name: string): string | null;
  /**
   * Coerce arbitrary text into a name this backend can hold. Never refuses: the result is
   * always usable, falling back to a placeholder when nothing survives.
   */
  sanitize(text: string): string;
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
   *
   * Null when this multiplexer's sessions are never without a window - a claim tmux, screen
   * and zellij cannot make and a GUI multiplexer cannot avoid. It was required until cmux,
   * on the assumption every multiplexer is invisible until something attaches to it; a cmux
   * workspace is drawn by cmux from the moment it exists, so the honest answer is that there
   * is nothing to attach rather than an attach command we failed to find. Every candidate
   * value was a lie: the nearest, `cmux select-workspace`, opens a stray empty tab in a
   * FOREIGN terminal beside a window that was already on screen.
   *
   * A null here is not the end of focus for such a backend, it is the end of this walk for
   * it. Raising its own window is a capability this interface does not yet have a slot for,
   * and it arrives with the focus/spawn/kill migration item rather than as an undesigned
   * placeholder - see `docs/plans/pluggable-integrations/plan.md`.
   */
  attachArgv: ((session: string) => readonly string[]) | null;
  rename(from: string, to: string): Promise<TerminalResult>;
  /**
   * Kill the whole named session - every window and pane in it - or null when this
   * backend's sessions are not a group anything can kill at once.
   *
   * Explicit rather than the implicit `else` it used to be. `kill` (`actions.ts`) signals
   * the leaf agent and then tore down "the tmux session, if there is one"; a multiplexer
   * that cannot do that would have silently inherited the emulator path and left the
   * session's other panes running with nothing saying why. A null here is the same claim
   * an emulator makes by having no `sessions` at all: the signal stands alone, which is a
   * complete answer rather than half of a missing one.
   */
  kill: ((session: string) => Promise<TerminalResult>) | null;
  /**
   * How a session name is spelled on this backend - see `NameRules`. Required, because a
   * backend with named sessions necessarily has an answer, even if that answer is "any
   * text" (`PLAIN_NAMES`).
   */
  names: NameRules;
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
 * `spawnWeztermTab` used to return, and what the focus fallback read as failure) makes an
 * emulator that opens tabs perfectly well but cannot say what it made - Ghostty - look
 * broken. Null `target` with `ok: true` is a complete, honest answer: the human got their
 * window, and nothing may be typed into it.
 */
export interface SpawnResult extends TerminalResult {
  target: EmulatorTarget | null;
}

/** A tab to open: what to run, what to call it, and where to root it. */
export interface TabSpec {
  argv: readonly string[];
  title: string;
  /**
   * Working directory for the new tab, or null to inherit the daemon's.
   *
   * Nullable rather than absent because the two callers genuinely differ, and the one that
   * needs it is why this is a spec rather than two positional arguments: the focus fallback
   * opens `<mux> attach -t <name>`, which lands wherever the session already is, while a
   * DISPATCH onto a machine with no multiplexer must root the agent in the worktree that
   * was just cut for it. An emulator that cannot honour a cwd must say so by failing, never
   * by opening the tab somewhere else - a dispatched agent in the wrong checkout commits to
   * the wrong branch.
   */
  cwd: string | null;
}

export interface EmulatorSpawn {
  /** Open a new tab, per `TabSpec`. */
  tab(spec: TabSpec): Promise<SpawnResult>;
}

/**
 * A terminal emulator: windows and tabs, here and now, with nothing that survives it
 * closing.
 *
 * EVERY capability is nullable, including enumeration and writing, and that is the design
 * under test.
 *
 * Ghostty was the test, and it corrected this doc rather than confirming it. The claim here
 * used to be that Ghostty "has no scripting CLI: it can be launched into and brought
 * forward, and it can be neither listed nor captured nor typed into". The first clause is
 * true - `+new-window` answers "not supported on this platform" and the bundled binary is
 * built `app runtime: .none`. Everything after it was wrong, and wrong in the way this
 * codebase has been burned by before (`HARNESSES.codex.tui`): a capability asserted absent
 * by a comment that guaranteed nobody would ever check. Ghostty 1.3.1 ships an AppleScript
 * dictionary that lists windows/tabs/surfaces, focuses ONE surface (so the
 * `granularity: "app"` variant below was the interface guessing low), spawns with a command
 * and a cwd, and types. Measured live in `todo/ghostty-emulator.md`.
 *
 * What it genuinely cannot do is `capture` and `retitle` - no property or command returns
 * screen text, and `name` is read-only on every class - and, the finding that actually
 * shaped this interface, it cannot put a tty on a pane. See `HostProcessSpec`.
 *
 * The rule the acceptance test was for still stands: if an adapter needs a field added
 * here, the interface was shaped around `wezterm cli` rather than around terminal
 * emulators. `hostProcess` is that field, added for that reason, and said out loud.
 */
export interface TerminalEmulator {
  id: EmulatorId;
  /** Human label for UI and error text ("WezTerm"). */
  label: string;
  bin: BinSpec;
  list: (() => Promise<EmulatorPane[]>) | null;
  /**
   * How to find this emulator's GUI in the process table, for panes it cannot put a tty on.
   * Null when its panes carry their own - see `HostProcessSpec`.
   */
  hostProcess: HostProcessSpec | null;
  write: PaneWrite<EmulatorTarget> | null;
  capture: ((target: EmulatorTarget) => Promise<string | null>) | null;
  focus: EmulatorFocus | null;
  spawn: EmulatorSpawn | null;
  /** Rename the tab a pane lives in - the value `list` reports back as `tabTitle`. */
  retitle: ((target: EmulatorTarget, title: string) => Promise<TerminalResult>) | null;
  /**
   * What a TAB TITLE may be on this backend - see `NameRules`.
   *
   * Required for the same reason `MuxSessions.names` is, and declared even by a backend
   * with no `retitle`: `spawn` stamps a title too, so an emulator that cannot rename a tab
   * can still be handed one it cannot express. Both shipped answers are `PLAIN_NAMES` -
   * a tab title is display text with no target grammar behind it - and the point of the
   * slot is that this is a backend SAYING so rather than a caller assuming it.
   */
  names: NameRules;
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
