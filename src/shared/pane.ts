import type {
  EmulatorHandle,
  MuxHandle,
  TerminalBackendId,
  TerminalHandle,
} from "./terminal.ts";

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
 * They spanned both processes and every layout: the Send box, the mode picker, Rename, the
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
      .map((handle) => handle.kind === "multiplexer" ? handle.session : handle.tabTitle)
      .filter(Boolean),
  );
}
