// The terminal backend vocabulary - which multiplexers and emulators exist - plus the
// handles a session holds on them.
//
// In `shared`, and holding no mechanism, for the same purity reason `HARNESS_CAPABILITIES`
// is split from `HARNESSES`: `nameSource` and the handle list are `Session` fields the
// dashboard renders and reasons about, so "which backend named this session" and "is there
// a pane to type into" are questions the BROWSER asks - and the browser cannot import an
// adapter whose `list` spawns a subprocess. The mechanism stays server-side in
// `src/server/terminal/`, which imports these ids and is enforced against them by
// `Record<MultiplexerId, Multiplexer>` / `Record<EmulatorId, TerminalEmulator>`.
//
// So: an id is added HERE and nowhere else, and it then fails to typecheck in the two
// registries until a complete adapter exists.

/**
 * Multiplexers we can drive - named persistent sessions holding panes that outlive any
 * window. (tmux, Herdr, cmux)
 *
 * A tuple rather than a bare union because the ORDER is load-bearing, not incidental:
 * discovery correlates backends in this order and the FIRST one holding a pane on a
 * session's tty is the one that names it (`nameSource`). With one multiplexer that is
 * unobservable; with two, moving an entry renames every session hosted by both.
 *
 * tmux before Herdr before cmux, by the same nesting rule that ranks every multiplexer above
 * every emulator: tmux can run inside a Herdr pane, while cmux is the outer self-hosting GUI
 * fallback. cmux is a terminal that hosts shells, so `tmux` can run INSIDE a cmux surface
 * and is then the inner, more specific answer. The two rarely collide in practice - tmux
 * mints a fresh pty per pane, so an agent under tmux-in-cmux sits on a tty cmux does not
 * report - but the order is what decides it if they ever do, and it should not be decided by
 * which line came first.
 */
export const MULTIPLEXER_IDS = ["tmux", "herdr", "cmux"] as const;

export type MultiplexerId = (typeof MULTIPLEXER_IDS)[number];

/**
 * Terminal emulators we can drive - windows and tabs, with nothing that survives them
 * closing. (wezterm, Ghostty, iTerm2, kitty)
 *
 * Ordered like `MULTIPLEXER_IDS`, and ranked BELOW every multiplexer for naming: a tmux
 * pane lives inside a wezterm pane, so the multiplexer is the inner, more specific answer
 * to "what is this session's terminal home?". That is today's tmux-beats-wezterm precedence
 * stated once as a rule rather than open-coded as a branch.
 */
export const EMULATOR_IDS = ["wezterm", "ghostty", "iterm"] as const;

export type EmulatorId = (typeof EMULATOR_IDS)[number];

/**
 * Any terminal backend, either axis.
 *
 * This is what opens `NameSource` up: it was the closed union `"tmux" | "wezterm" |
 * "process"`, written out in `shared/types.ts` where nothing connected it to the registries,
 * so a third backend would name sessions with a string the type did not admit and the UI
 * did not recognise.
 */
export type TerminalBackendId = MultiplexerId | EmulatorId;

/**
 * Every backend id, multiplexers first.
 *
 * The order is `MULTIPLEXER_IDS` then `EMULATOR_IDS` for the reason stated above, and it is
 * the order the conversation pane's terminal menu draws in - a list nobody chose an order
 * for is a list that reorders when someone edits an unrelated array.
 */
export const TERMINAL_BACKEND_IDS = [...MULTIPLEXER_IDS, ...EMULATOR_IDS] as const;

/** Narrow a stored or wire value without teaching a caller the backend list again. */
export function isTerminalBackendId(value: unknown): value is TerminalBackendId {
  return (
    typeof value === "string" &&
    TERMINAL_BACKEND_IDS.includes(value as TerminalBackendId)
  );
}

/**
 * A stored terminal preference narrowed for this build.
 *
 * `null` is Automatic. An unknown string also runs as Automatic, but remains reportable so
 * the settings card can say that it ignored a preference written by a newer build instead of
 * presenting the fallback as the operator's own choice.
 */
export function resolveTerminalBackend(value: string | null | undefined): {
  backend: TerminalBackendId | null;
  unknown: string | null;
} {
  if (value == null) return { backend: null, unknown: null };
  return isTerminalBackendId(value)
    ? { backend: value, unknown: null }
    : { backend: null, unknown: value };
}

/** Narrow a stored or wire value to a TERMINAL APP specifically. */
export function isEmulatorId(value: unknown): value is EmulatorId {
  return typeof value === "string" && EMULATOR_IDS.includes(value as EmulatorId);
}

/**
 * The emulator-only sibling of `resolveTerminalBackend`, for the questions a multiplexer
 * cannot answer.
 *
 * A multiplexer id arriving here is `unknown` on the same terms as a string this build has
 * never heard of: Automatic, but still reportable, so a row can say it ignored a stored
 * preference rather than presenting the fallback as the operator's choice.
 */
export function resolveEmulatorBackend(value: string | null | undefined): {
  backend: EmulatorId | null;
  unknown: string | null;
} {
  if (value == null) return { backend: null, unknown: null };
  return isEmulatorId(value)
    ? { backend: value, unknown: null }
    : { backend: null, unknown: value };
}

/**
 * One backend, as the browser is told about it.
 *
 * The shape `OpenTargetView` has, for the same reason: what a backend IS can be answered
 * without leaving the process, but whether it can be used RIGHT NOW cannot - it needs the
 * filesystem, and on one axis it needs a second backend to exist. So the whole row is
 * composed by the daemon and the browser only renders it.
 */
export interface TerminalTargetView {
  id: TerminalBackendId;
  /** The menu row's title, from the adapter. */
  label: string;
  /** Leading glyph. A character, never an image and never a vendor logo. */
  glyph: string;
  /** One line saying what pressing it produces. */
  blurb: string;
  /** The argv fragment, when nameable ("cli spawn --cwd"). Null when there isn't one. */
  detail: string | null;
  /**
   * Null when this backend can be used right now; else WHY NOT, as a sentence.
   *
   * Never a boolean. "tmux is not installed" and "tmux is installed but no emulator can
   * raise its session" are different things for a human to do, and a `false` collapses them
   * into a greyed row that explains neither.
   */
  unavailable: string | null;
  /** One line describing what a background dispatch creates on this backend. */
  dispatchBlurb?: string;
  /**
   * Null when this backend can host a dispatched session; else why it cannot.
   *
   * This differs from `unavailable` for a detached multiplexer. A user-opened terminal
   * needs an emulator to raise the detached session into a visible window, while a
   * background dispatch only needs the persistent session itself.
   */
  dispatchUnavailable?: string | null;
  /**
   * For a MULTIPLEXER: whether its sessions need a terminal app to be seen at all.
   * Absent on an emulator row, which is the terminal app.
   *
   * An adapter fact, never a name. `attachArgv: null` is how a backend declares that its
   * sessions are never without a window - cmux draws its own workspace - and the browser
   * cannot import an adapter to read it. So the daemon reports it here and the Setup panel
   * offers a terminal chooser to exactly the rows that say `true`, which is what keeps a
   * future self-hosting multiplexer from needing a UI edit.
   */
  needsTerminalApp?: boolean;
}

/**
 * What a multiplexer operation addresses. A pane, plus the session/window that reach it.
 *
 * Here rather than in `server/terminal/types.ts` because a `Session` now carries these: the
 * handle types were server-side while `Session.tmux` / `Session.wezterm` were the wire
 * format, and phase 3 of `docs/plans/pluggable-integrations/plan.md` promoted them when
 * those two fields became one list. Still pure data - a target is where to write, never how.
 */
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

/**
 * A multiplexer pane a session sits on: which backend, how to address it there, and the
 * few facts about it a card renders.
 */
export interface MuxHandle extends MuxTarget {
  kind: "multiplexer";
  backend: MultiplexerId;
  sessionName: string;
  /** The window's own name, as the backend reports it. */
  windowName: string;
}

/** An emulator pane a session sits on, on the same terms as `MuxHandle`. */
export interface EmulatorHandle extends EmulatorTarget {
  kind: "emulator";
  backend: EmulatorId;
  windowId: string;
  tabTitle: string;
  isActive: boolean;
}

/**
 * One terminal pane a session is reachable through.
 *
 * A DISCRIMINATED UNION on the axis, not on the vendor, and that is the whole point of the
 * shape: `Session.tmux` / `Session.wezterm` were two named nullable siblings, so "how many
 * backends are there" was a fact of the type - a third one had no field to land in, and
 * every consumer had to be taught a vendor's name to ask a question that was never about a
 * vendor ("can we type here?", "what should Kill tear down?").
 *
 * The axis survives that collapse because it is real: a multiplexer pane lives INSIDE an
 * emulator pane, which is why writes prefer the innermost handle and focus walks outward
 * (see `innermostPane` in `@shared/pane.ts`, and the composition rule in
 * `server/terminal/registry.ts`). A session may hold one handle per axis and both at once.
 */
export type TerminalHandle = MuxHandle | EmulatorHandle;
