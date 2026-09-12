import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalsConfig, TerminalsConfigPatch } from "@shared/protocol.ts";
import { readIsCurrent } from "./harnesses-reconcile.ts";
import { api, fetchTerminalsConfig } from "./lib/api.ts";

// The "Terminals" config: which terminal app each multiplexer's detached sessions are
// focused into. Owned by the Setup panel, which is the only surface that renders it.
//
// Deliberately the same three rules `useHarnesses` follows, because this panel is optimistic
// for the same reason: the chooser shows a value before the daemon has confirmed it.
//
//  - the patch merges the way the daemon merges it, per multiplexer key, so choosing tmux's
//    terminal cannot blank the Herdr row beside it;
//  - a refused write is TAKEN BACK, so the control never shows a preference that is not in
//    force;
//  - every read that lands is dropped if an edit started while it was in flight
//    (`readIsCurrent`), so a slow response cannot reinstate a value already changed away from.
//
// No SSE event and no poll. The harnesses config is read by a dispatch modal that may be open
// in another tab, which is what earned it both; this one is read only here and by the daemon
// at focus time, so a second tab's edit is picked up on the next mount.

const EMPTY = "That change didn't stick.";

/** One short sentence, the way `useHarnesses` frames a rejection. */
function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return EMPTY;
  return `That change didn't stick: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
}

/** Merge a patch over what the panel is showing, the way `setTerminalsConfig` merges it. */
export function mergeTerminalsPatch(
  before: TerminalsConfig,
  patch: TerminalsConfigPatch,
): TerminalsConfig {
  return {
    ...before,
    ...patch,
    multiplexerTerminal: { ...before.multiplexerTerminal, ...patch.multiplexerTerminal },
  };
}

export interface TerminalsConfigState {
  /** Null until the first answer arrives. */
  config: TerminalsConfig | null;
  update: (patch: TerminalsConfigPatch) => Promise<void>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

/**
 * @param revision Bumped by a caller that has just asked for a re-read. A failed mount read
 * otherwise leaves `config` null for the life of the mount, which disables every chooser -
 * so the retry has to come from somewhere.
 */
export function useTerminalsConfig(revision = 0): TerminalsConfigState {
  const [config, setConfigState] = useState<TerminalsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<TerminalsConfig | null>(null);
  const editSeq = useRef(0);
  /**
   * The tail of the writes this panel has issued, so at most one `PUT` is ever in flight.
   *
   * The ordering guard below is about RESPONSES, and that is a different problem from this
   * one. It stops a stale response being applied to the panel; it cannot stop a stale
   * REQUEST being applied to the database. Two clicks on the same multiplexer issued
   * concurrently can reach the daemon in either order, and the loser is whichever the network
   * delivers second - so the per-key merge on the other end can persist the FIRST choice
   * while this panel shows the second, and the next Focus opens a terminal nobody chose.
   *
   * Chaining is the whole fix and it is one line of state: a write starts only once its
   * predecessor has settled, so the daemon sees them in the order the operator made them.
   * The optimistic value is still applied immediately, so nothing about the panel slows down.
   *
   * What this does NOT close is two BROWSER TABS editing the same row at once, which no
   * client-side queue can; that needs a revision on the route, and it is the same window
   * every other settings route in this app leaves open.
   */
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  const setConfig = useCallback((next: TerminalsConfig | null): void => {
    configRef.current = next;
    setConfigState(next);
  }, []);

  useEffect(() => {
    let alive = true;
    const seq = editSeq.current;
    void fetchTerminalsConfig().then((next) => {
      if (!alive || !readIsCurrent(seq, editSeq.current)) return;
      // A failed READ is reported like a failed write. Without this the chooser sits disabled
      // with nothing said, and nothing short of reloading the page would try again.
      if (!next) {
        setError("Mission Control could not read the terminal preferences. Re-check to try again.");
        return;
      }
      setError(null);
      setConfig(next);
    });
    return () => {
      alive = false;
    };
  }, [setConfig, revision]);

  const update = useCallback(
    (patch: TerminalsConfigPatch): Promise<void> => {
      const before = configRef.current;
      if (!before) return Promise.resolve();
      const seq = ++editSeq.current;
      // Applied NOW, ahead of the queue. Waiting for a predecessor to settle before drawing
      // the operator's own click would turn a queue meant to fix ordering into a stutter.
      setConfig(mergeTerminalsPatch(before, patch));
      const sent = writes.current.then(async () => {
        const res = await api.setTerminalsConfig(patch);
        if (!res.ok) {
          setError(whyItFailed(res.error));
          // Only while this is still the newest edit - a later one has already replaced what
          // `before` holds, and its own confirming read corrects this one's optimistic value.
          //
          // And the DAEMON's answer rather than `before`, because `before` can itself be an
          // optimistic value: when two writes fail, the first skips its rollback as stale and
          // the second restores the snapshot it took mid-flight, leaving the panel showing an
          // edit the daemon never accepted. Falling back to `before` keeps a failed re-read
          // no worse than it was.
          if (readIsCurrent(seq, editSeq.current)) {
            const confirmed = await fetchTerminalsConfig();
            if (readIsCurrent(seq, editSeq.current)) setConfig(confirmed ?? before);
          }
          return;
        }
        setError(null);
        const next = await fetchTerminalsConfig();
        if (next && readIsCurrent(seq, editSeq.current)) setConfig(next);
      });
      // ONE caught promise, used as both the queue tail and the caller's handle. `api`
      // reduces a failed request to a result rather than throwing, so this is for the
      // unforeseen kind - and it has to be absorbed twice over: a rejecting tail would wedge
      // every later write on this panel, and a rejecting return value would be an unhandled
      // rejection, since callers read failure off `error` and none of them attaches a
      // handler to this.
      const settled = sent.catch(() => {});
      writes.current = settled;
      return settled;
    },
    [setConfig],
  );

  return { config, update, error };
}
