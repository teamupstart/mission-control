import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttentionDismissalKey } from "@shared/protocol.ts";
import { api } from "./lib/api.ts";
import {
  applyDismissalRead,
  beginDismissalWrite,
  createDismissalSender,
  createRevisionLedger,
  effectiveDismissals,
  INITIAL_DISMISSAL_STATE,
  settleDismissalWrite,
} from "./lib/attention-dismissal-state.ts";

export interface AttentionDismissalsState {
  /**
   * Dismissed attention-inbox rows, item id to the occurrence each was dismissed at: what the
   * daemon has stored, plus this window's own dismissals a read has not confirmed yet. Feed it
   * to `foldAttention` as `dismissed`.
   */
  dismissed: ReadonlyMap<string, string>;
  /**
   * True once the daemon's stored set has been read at least once. Until then `dismissed` holds
   * only this window's own clicks, so a fold over it cannot say what is still hidden.
   */
  loaded: boolean;
  /**
   * Dismiss one row's keys (`attentionDismissalKeys`). The row leaves at once; the promise
   * resolves to null once the daemon stored it, or to an error, in which case the row is back.
   */
  dismiss: (keys: readonly AttentionDismissalKey[]) => Promise<string | null>;
}

/**
 * The attention-inbox dismissals, read from the daemon and kept current.
 *
 * Re-read whenever `revision` moves - `useEventStream`'s `attentionDismissalsRevision`, which
 * moves on every (re)connect and on every `attention_dismissals_changed` - so a dismissal in
 * another window, or one made while this stream was down, reaches this one. Held in ONE hook
 * that `App` owns, beside the fold it filters, so the topbar count and the inbox list read the
 * same set.
 *
 * Overlapping requests are ordered by `lib/attention-dismissal-state.ts`: reads are numbered as
 * they start and only a newer one replaces the copy, a write's answer never does, and a stored
 * write's rows stay hidden by this window until a read started after it lands. So two quick
 * dismissals whose answers arrive out of order both stay dismissed. And a row's writes are sent
 * one after another, so a row dismissed twice - because it came back reporting something new -
 * is stored with the newer dismissal, never overwritten by the older one landing late. Across
 * windows the daemon keeps that order: each write names the newest revision of its row this
 * window had seen when the operator clicked (or its own earlier write's), and one made without
 * seeing another window's newer dismissal is refused.
 *
 * A failed read keeps what was already known. An empty set is a claim that nothing is
 * dismissed, and on a dropped connection that claim would bring every dismissed row back.
 */
export function useAttentionDismissals(revision: number): AttentionDismissalsState {
  const [state, setState] = useState(INITIAL_DISMISSAL_STATE);
  const readsStarted = useRef(0);
  const writesStarted = useRef(0);
  const [ledger] = useState(createRevisionLedger);
  // Called at the click, so each write's basis is what this window had seen then - plus its own
  // earlier write of the row - and never what other windows did while it waited in the queue.
  const [send] = useState(() =>
    createDismissalSender((writes) => api.dismissAttentionItems(writes), ledger),
  );

  const read = useCallback((): void => {
    const number = ++readsStarted.current;
    void api.listAttentionDismissals().then((body) => {
      if (!body) return;
      ledger.learn(body.dismissals);
      setState((current) => applyDismissalRead(current, number, body.dismissals));
    });
  }, [ledger]);

  useEffect(() => read(), [revision, read]);

  const dismiss = useCallback(async (keys: readonly AttentionDismissalKey[]): Promise<string | null> => {
    const write = ++writesStarted.current;
    setState((current) => beginDismissalWrite(current, keys, write));
    const result = await send(keys);
    // Captured before the read below starts: that read, and any later one, began after the
    // daemon stored this write, so applying it is what lets the overlay let go.
    const readsAtAck = readsStarted.current;
    setState((current) => settleDismissalWrite(current, keys, write, result.ok, readsAtAck));
    if (!result.ok) {
      // Superseded by another window: catch up now rather than waiting on its change event.
      if (result.status === 409) read();
      return `Could not dismiss: ${result.error ?? "the daemon refused"}`;
    }
    // Not left to the change event alone: a dropped stream would otherwise keep this window's
    // overlay until the next reconnect.
    read();
    return null;
  }, [read, send]);

  const dismissed = useMemo(() => effectiveDismissals(state), [state]);
  return { dismissed, loaded: state.appliedRead > 0, dismiss };
}

/**
 * How often an open dashboard repeats an unchanged sighting report. Far shorter than the
 * daemon's one-week retention, so a dismissal that is still hiding its row is re-confirmed many
 * times before it could ever expire, and a resolved one is retired within an hour of its week.
 */
const SIGHTING_HEARTBEAT_MS = 60 * 60 * 1000;

/**
 * Tell the daemon which dismissals this dashboard's inbox is hiding right now - the fold's
 * `hidden` - whenever that set changes and once an hour while it does not.
 *
 * This is the only way a dismissal is ever forgotten (`recordAttentionSightings`), so it is
 * sent only from a fold that can be trusted to show everything: `ready` must say the event
 * stream has delivered its full snapshot AND the stored dismissals have been read. A fold built
 * before either would hide nothing and so report every dismissal absent. Even then a single
 * wrong report retires nothing - a dismissal goes only after a week of being reported absent,
 * and the next report that sees its row clears that clock.
 */
export function useReportAttentionSightings(hidden: readonly string[], ready: boolean): void {
  // The set, not the array: the fold rebuilds the array on every frame, and only a change in
  // what is hidden is worth a request.
  const key = useMemo(() => [...new Set(hidden)].sort().join("\n"), [hidden]);
  useEffect(() => {
    if (!ready) return;
    const itemIds = key === "" ? [] : key.split("\n");
    const report = (): void => void api.reportAttentionSightings(itemIds);
    report();
    const heartbeat = setInterval(report, SIGHTING_HEARTBEAT_MS);
    return () => clearInterval(heartbeat);
  }, [ready, key]);
}
