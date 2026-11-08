import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ATTENTION_DISMISSAL_LIMITS, type AttentionDismissalKey } from "@shared/protocol.ts";
import { api } from "./lib/api.ts";
import {
  applyDismissalRead,
  beginDismissalWrite,
  createDismissalSender,
  createRevisionLedger,
  effectiveDismissals,
  INITIAL_DISMISSAL_STATE,
  readRetryDelay,
  settleDismissalWrite,
  shouldRetryRead,
} from "./lib/attention-dismissal-state.ts";

export interface AttentionDismissalsState {
  /**
   * Dismissed attention-inbox rows, item id to the occurrence each was dismissed at: what the
   * daemon has stored, plus this window's own dismissals a read has not confirmed yet. Feed it
   * to `foldAttention` as `dismissed`.
   *
   * NULL until the first read succeeds, which means UNKNOWN, not "nothing dismissed". After a
   * reload the snapshot usually lands before that read, and folding over an empty map in that
   * gap drew every dismissed row - and counted it - until the read caught up, or for good when
   * that read failed. The caller shows no inbox rows while this is null.
   */
  dismissed: ReadonlyMap<string, string> | null;
  /**
   * True while `dismissed` is null BECAUSE a read failed - not merely because the first one is
   * still on its way - so the caller can say the inbox is unavailable rather than imply it is
   * clear. Cleared by the first read that succeeds.
   */
  unreadable: boolean;
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
 * dismissed, and on a dropped connection that claim would bring every dismissed row back. Until
 * the first read succeeds nothing is known at all, so `dismissed` stays null. Any failed read -
 * the first, or a refresh another window's dismissal prompted - is retried with backoff rather
 * than left until some later event happens to ask again, and the last known set stays in force
 * meanwhile.
 */
export function useAttentionDismissals(revision: number): AttentionDismissalsState {
  const [state, setState] = useState(INITIAL_DISMISSAL_STATE);
  const [unreadable, setUnreadable] = useState(false);
  const readsStarted = useRef(0);
  const writesStarted = useRef(0);
  const [ledger] = useState(createRevisionLedger);
  // Called at the click, so each write's basis is what this window had seen then - plus its own
  // earlier write of the row - and never what other windows did while it waited in the queue.
  const [send] = useState(() =>
    createDismissalSender((writes) => api.dismissAttentionItems(writes), ledger),
  );

  /** The newest read applied, mirrored for the read callback, which cannot see `state`. */
  const newestApplied = useRef(0);
  const failuresInARow = useRef(0);
  /** The one waiting retry, and the read whose failure it is repairing. */
  const retry = useRef<{ timer: ReturnType<typeof setTimeout>; after: number } | null>(null);

  const read = useCallback((): void => {
    const number = ++readsStarted.current;
    void api.listAttentionDismissals().then((body) => {
      if (!body) {
        if (newestApplied.current === 0) setUnreadable(true);
        // A lost read is repaired by reading again, not by waiting for a change event that may
        // never come - the one that prompted this read has already been spent.
        if (!shouldRetryRead(number, newestApplied.current, retry.current !== null)) return;
        const timer = setTimeout(() => {
          retry.current = null;
          read();
        }, readRetryDelay(failuresInARow.current++));
        retry.current = { timer, after: number };
        return;
      }
      failuresInARow.current = 0;
      newestApplied.current = Math.max(newestApplied.current, number);
      setUnreadable(false);
      // A read that started after the lost one has answered for it.
      if (retry.current && number > retry.current.after) {
        clearTimeout(retry.current.timer);
        retry.current = null;
      }
      ledger.learn(body.dismissals);
      setState((current) => applyDismissalRead(current, number, body.dismissals));
    });
  }, [ledger]);

  useEffect(() => read(), [revision, read]);
  useEffect(() => () => {
    if (retry.current) clearTimeout(retry.current.timer);
  }, []);

  const dismiss = useCallback(async (keys: readonly AttentionDismissalKey[]): Promise<string | null> => {
    // Said here, plainly, rather than as the daemon's validation error: the row stays, and why.
    if (keys.length > ATTENTION_DISMISSAL_LIMITS.keysPerRequest) {
      return `Could not dismiss: this row holds more than ${ATTENTION_DISMISSAL_LIMITS.keysPerRequest} questions - answer or dismiss some of them on their cards first`;
    }
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

  const dismissed = useMemo(
    () => (state.appliedRead > 0 ? effectiveDismissals(state) : null),
    [state],
  );
  return { dismissed, unreadable, dismiss };
}
