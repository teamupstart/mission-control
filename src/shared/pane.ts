import type { TmuxInfo, WeztermInfo } from "./types.ts";

/**
 * The token that names the pane a session's writes land on, and the key every
 * pane-scoped map in the daemon is keyed by.
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
 * tmux wins when a session has both handles, exactly as every write resolves its
 * target: the agent's real pane is the tmux pane, and the wezterm handle is the
 * outer client showing it.
 *
 * No token is persisted anywhere - overlays, locks and miss counts are all
 * in-memory maps rebuilt on start (see `hooksEverSeen` in `db.ts`, which exists
 * precisely because overlays are not durable) - so the spelling is free to change.
 * That stops being true the moment one is written to the DB or sent over the wire.
 */

const TMUX = "tmux";
const WEZTERM = "wezterm";

/** The token for a tmux pane id (`"%3"`). */
export function tmuxPaneToken(paneId: string): string {
  return `${TMUX}:${paneId}`;
}

/** The token for a wezterm pane id, which is a number everywhere but a hook's env. */
export function weztermPaneToken(paneId: number | string): string {
  return `${WEZTERM}:${paneId}`;
}

/** The pane handles every session-shaped thing carries: `Session`, `DiscoveredSession`. */
export interface PaneHandles {
  tmux: TmuxInfo | null;
  wezterm: WeztermInfo | null;
}

/**
 * The pane token for a session, or null when it has no handle at all.
 *
 * Null is meaningful and must not be collapsed to a shared sentinel: two handleless
 * sessions have no pane to protect and no state to share, so keying both under one
 * token makes each claim the other's conflicts.
 *
 * Presence of the HANDLE decides, not truthiness of the id - a wezterm pane may
 * legitimately be pane 0.
 */
export function paneToken(s: PaneHandles): string | null {
  if (s.tmux) return tmuxPaneToken(s.tmux.paneId);
  if (s.wezterm) return weztermPaneToken(s.wezterm.paneId);
  return null;
}
