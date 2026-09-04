import type {
  EmulatorHandle,
  MuxHandle,
  TerminalBackendId,
  TerminalHandle,
} from "./terminal.ts";
import type { SessionPipelineLink } from "./pipeline.ts";
import type { SessionRuntime } from "./types.ts";

/**
 * What a session's pane is called, which pane that is, and whether there is one at all.
 *
 * ## The token
 *
 * ONE function, because there were four - `actions.ts` (the write lock),
 * `discovery/pane-mode.ts` (the capture-miss counter), `registry.ts` (the hook
 * overlay), and `foreman/queue-apply.ts` (the pane-recreated guard) - in TWO
 * spellings, `wezterm:` and `wez:`. Each subsystem only ever compared the token
 * against itself, so the two namespaces never met and there was no live defect;
 * the fifth copy, written for a third backend, is where one starts.
 *
 * Keyed on the PANE and not on `session.id`: the id is synthetic for an
 * uninstrumented session and churns as pids/ttys change, so two reads of "the same
 * session" can key differently while addressing one pane.
 *
 * No token is persisted anywhere - overlays, locks and miss counts are all
 * in-memory maps rebuilt on start (see `hooksEverSeen` in `db.ts`, which exists
 * precisely because overlays are not durable) - so the spelling is free to change.
 * That stops being true the moment one is written to the DB or sent over the wire.
 */

/** The token for one backend's pane. A backend id IS its token prefix; nothing else is. */
export function backendPaneToken(backend: TerminalBackendId, paneId: number | string): string {
  return `${backend}:${paneId}`;
}

/**
 * The token for a tmux pane id (`"%3"`), and for a wezterm pane id.
 *
 * These two spell a VENDOR because their one caller does: `overlayKeyFromEnv` reads
 * `TMUX_PANE` / `WEZTERM_PANE` off a hook's captured environment, and those variable names
 * are the vendors' own. Everything that holds a handle instead goes through `paneToken`.
 */
export function tmuxPaneToken(paneId: string): string {
  return backendPaneToken("tmux", paneId);
}

export function weztermPaneToken(paneId: number | string): string {
  return backendPaneToken("wezterm", paneId);
}

/**
 * iTerm2 exports the same globally unique session id through AppleScript and
 * `ITERM_SESSION_ID`. Trim transport whitespace and reject empty or ambiguous values so
 * discovery and hook ingestion share one exact identity rule.
 */
export function normalizeItermSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || /\s/.test(normalized)) return null;
  return normalized;
}

export function itermPaneToken(sessionId: string): string | null {
  const normalized = normalizeItermSessionId(sessionId);
  return normalized ? backendPaneToken("iterm", normalized) : null;
}

/** The pane handles every session-shaped thing carries: `Session`, `DiscoveredSession`. */
export interface PaneHandles {
  /**
   * Every terminal pane this session is reachable through, in the order the backends were
   * enumerated (multiplexers before emulators - see `MULTIPLEXER_IDS`). At most one per
   * backend.
   */
  terminals: readonly TerminalHandle[];
}

/**
 * The pane a session's writes and captures address, or null when it has none.
 *
 * The innermost handle wins: the agent's real pane is the multiplexer pane, and the
 * emulator handle addresses the client showing it, so typing there types at whatever that
 * client currently displays. Decided by the handle's AXIS rather than by its position in
 * the list, because the list's order is a naming priority and reading one as the other is
 * how a re-ordered registry would silently re-aim every write on the machine.
 *
 * Null is meaningful and must not be collapsed to a shared sentinel: two handleless
 * sessions have no pane to protect and no state to share, so keying both under one token
 * makes each claim the other's conflicts.
 */
export function innermostPane(s: PaneHandles): TerminalHandle | null {
  return (
    s.terminals.find((h) => h.kind === "multiplexer") ??
    s.terminals.find((h) => h.kind === "emulator") ??
    null
  );
}

/** The pane token for a session, or null when it has no handle at all. */
export function paneToken(s: PaneHandles): string | null {
  const pane = innermostPane(s);
  return pane ? backendPaneToken(pane.backend, pane.paneId) : null;
}

/**
 * True when this session has a terminal pane we can drive - the one question ~20 call sites
 * were asking as `Boolean(s.tmux || s.wezterm)`.
 *
 * They spanned both processes and every layout: the Send box, the mode picker, the
 * work-queue's delivery check, Foreman's `canSend`, the reset preview's "will this clear
 * context". None of them was about tmux or wezterm; each was about whether there is a
 * composer to type into, and each restated the handle list to ask it - so a third backend
 * would have been discovered, named, drawn on a card, and then quietly refused a Send by
 * twenty independent booleans.
 *
 * Presence of a HANDLE decides, not truthiness of an id - a wezterm pane may legitimately
 * be pane 0. Whether that pane's backend can be typed into AT ALL is a capability question
 * (`BoundPane.write`, which an emulator with no scripting CLI declares null) and it is
 * answered server-side at the moment of writing; a handle only ever exists for a backend
 * that enumerated the pane, and every shipped one can also write to it.
 */
export function canWriteTo(s: PaneHandles): boolean {
  return innermostPane(s) !== null;
}

/**
 * True when Mission Control can DELIVER A TURN to this session - by typing into its pane,
 * or by handing it to the driver that is running it.
 *
 * Split from `canWriteTo` because ~20 call sites were using that predicate to ask this
 * question, and once a session can exist with no pane at all the two answers diverge. They
 * are genuinely different questions:
 *
 *  - `canMessage` is about a CONVERSATION: may the Send box be enabled, may the work queue
 *    hand this session an item, will a reset be able to clear its context, may Foreman
 *    reply. None of those care how the bytes land.
 *  - `canWriteTo` is about a PANE: focus and raise it, take the write lock on it, press
 *    Shift+Tab in it, tolerate a capture miss on it. Every one of those is meaningless
 *    without a pane, and an SDK session must NOT be admitted to any of them - so the
 *    literal predicate keeps its literal meaning rather than being widened underneath its
 *    callers.
 *
 * Takes `runtime` as well as the handles because a `DiscoveredSession` has no runtime to
 * ask about: discovery only ever produces pane-backed sessions, so its consumers stay on
 * `canWriteTo` by construction rather than by remembering to.
 *
 * An ENGINE-DRIVEN session is refused outright, ahead of both. See `messageBlockReason`.
 */
export function canMessage(s: Messageable): boolean {
  return messageBlockReason(s) === null;
}

/** What a session's turn delivery needs to be asked about, beyond its panes. */
export type Messageable = PaneHandles & {
  runtime: SessionRuntime;
  /**
   * Optional rather than required so the predicate stays callable with anything
   * session-shaped, and so a caller that has never heard of pipelines is unchanged: absent
   * and null are the same answer, which is the answer on every fleet observing no engine.
   */
  pipeline?: SessionPipelineLink | null;
};

/**
 * WHY a turn cannot be delivered, for the surfaces that have to say so - or null when it can.
 *
 * `canMessage` is the boolean twenty call sites ask; this is the sentence three of them
 * print, and it lives here so they cannot each invent their own. The reply box's
 * placeholder, the Send button's tooltip and the notice drawn in the composer's place were
 * all spelling "No pane to send to", which became a lie the moment a session could be
 * refused for a second reason.
 *
 * `pipeline` outranks the pane question, and the order is the whole point rather than a
 * tidiness preference: an engine-driven agent HAS a pane - the engine spawns it non-detached
 * into a real tty, which is why Mission Control cards it at all - and it is running under
 * `--print`, so it reads nothing that pane receives. Answering "no pane" there would be
 * false; answering "there is a pane" and enabling the box would be worse, because the text
 * goes nowhere and the operator has no way to find that out.
 */
export function messageBlockReason(s: Messageable): "pipeline" | "no-pane" | null {
  if (s.pipeline) return "pipeline";
  return canWriteTo(s) || s.runtime === "sdk" ? null : "no-pane";
}

/**
 * True when this session has somewhere a NAME can live that Mission Control can move.
 *
 * The third question that used to be spelled `canWriteTo`, and the one that was wrong for
 * longest. Rename reads as a pane mechanic because of HOW it is implemented on the terminal
 * axis - there is no name field on a session, so moving a name means moving the multiplexer
 * session's name (or an emulator tab's title) and letting the next discovery sweep read it
 * back onto the card. That makes a pane genuinely necessary THERE. It is not what the
 * question is:
 *
 *  - a terminal session's name is its home's name, so no handle means no name to move; but
 *  - an SDK session's name is a column on the row the supervisor already keeps for it, and
 *    that row outlives the process. Nothing about it needs a pane.
 *
 * Left on `canWriteTo`, the title on every dispatched card silently stopped being a click
 * target the moment dispatch started producing SDK sessions - the affordance was still
 * built, still styled and still tested, and simply never rendered. So this is its own
 * predicate rather than a widened `canWriteTo`: focus and Shift+Tab still mean the pane.
 *
 * Deliberately NOT `canMessage`, which today has the same body. They agree by coincidence
 * of the two runtimes that exist, not by construction - naming a session and delivering a
 * turn to it are different capabilities, and a third runtime is free to have one without
 * the other. Sharing the predicate would make the next author's rename gate a guess.
 */
export function canRename(s: PaneHandles & { runtime: SessionRuntime }): boolean {
  return canWriteTo(s) || s.runtime === "sdk";
}

/**
 * This session's multiplexer handle, and its emulator handle.
 *
 * These two exist for the questions that really ARE about one axis, and only those: what a
 * named session Kill tears down and Rename moves is a multiplexer concept with no emulator
 * equivalent, and raising a tab is the reverse. Reaching for one to answer "can we type
 * here?" is the thing `canWriteTo` exists to stop - that question was never about an axis
 * either, which is how it came to be spelled as a list of vendors twenty times over.
 *
 * At most one handle per backend per session, so "the multiplexer handle" is unambiguous.
 */
export function muxHandle(s: PaneHandles): MuxHandle | null {
  return s.terminals.find((h) => h.kind === "multiplexer") ?? null;
}

export function emulatorHandle(s: PaneHandles): EmulatorHandle | null {
  return s.terminals.find((h) => h.kind === "emulator") ?? null;
}

export function terminalHomeNames(s: PaneHandles): Set<string> {
  return new Set(
    s.terminals
      .map((handle) => handle.kind === "multiplexer" ? handle.sessionName : handle.tabTitle)
      .filter(Boolean),
  );
}

export function terminalResourceId(handle: TerminalHandle): string {
  return handle.kind === "multiplexer"
    ? `${handle.kind}:${handle.backend}:${handle.session}`
    : `${handle.kind}:${handle.backend}:${handle.paneId}`;
}

export function terminalResourceIds(s: PaneHandles): Set<string> {
  return new Set(s.terminals.map(terminalResourceId));
}

export function innermostTerminalResourceId(s: PaneHandles): string | null {
  const handle = innermostPane(s);
  return handle ? terminalResourceId(handle) : null;
}
