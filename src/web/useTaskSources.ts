import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskSourcesConfigPatch } from "@shared/protocol.ts";
import type { SweepReport, TaskSourceInstance, TaskSourcesView } from "@shared/task-source.ts";
import { api, fetchTaskSources } from "./lib/api.ts";
import { readIsCurrent } from "./harnesses-reconcile.ts";

// The "Task sources" settings section: what pulls work INTO the backlog, and how each one
// is doing. Owned locally by SettingsPage (like useSkills / useHarnesses), because
// nothing outside the panel reads it - unlike Foreman, whose state the topbar shares.
//
// Polled rather than streamed, for the reason the other config hooks are: it is coarse,
// rarely-edited chrome, not worth another SSE channel. The poll is doing slightly more
// work here than elsewhere, though - it is also what makes `lastSweepAt` / `lastError`
// move while you watch, and what reconciles a background sweep that landed under you.

const POLL_MS = 4000;

/**
 * Frame a rejection as one short sentence. A bad patch comes back as zod's raw
 * multi-line JSON, which would render as a wall of braces in this panel - so flatten
 * and clamp it. Mirrors `useHarnesses`'s `whyItFailed`.
 */
function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick.";
  return `That change didn't stick: ${flat.length > 120 ? `${flat.slice(0, 119)}…` : flat}`;
}

export interface TaskSourcesState {
  view: TaskSourcesView | null;
  /** Write the whole set. Applied optimistically, reverted if the server refuses. */
  save: (sources: TaskSourceInstance[]) => Promise<boolean>;
  /** Sweep one source now, and refresh. Returns what it filed. */
  sweep: (id: string) => Promise<SweepReport | null>;
  /** Ask whether a source could run at all. Null means it can. */
  preflight: (id: string) => Promise<string | null>;
  /** Forget what a source has filed, so it can file it again. */
  forget: (id: string) => Promise<void>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useTaskSources(): TaskSourcesState {
  const [view, setViewState] = useState<TaskSourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The view as last seen, readable without making the callbacks depend on it (which
  // would rebuild every one of them on each poll). This is what a revert restores.
  const viewRef = useRef<TaskSourcesView | null>(null);
  /**
   * How many edits this panel has STARTED, so a read that left before one cannot land after
   * it - `readIsCurrent`, the same guard `useHarnesses` carries, and here for the same
   * reason plus a worse one.
   *
   * The flash is the obvious half: this hook polls every 4 seconds and every response used
   * to be written into state unconditionally, so a GET that left before a save came back
   * carrying the pre-save config and snapped the field back to the value the operator had
   * just changed away from, while the daemon held the new one.
   *
   * The half that is not a flash: a kind's fields write the WHOLE config blob composed from
   * what is on screen (`{...cfg, jql}`), so once a stale read had put the old value back,
   * the very next field's commit persisted it. Editing the Jira site and then the JQL filter
   * saved the filter and silently reverted the site. Found by
   * `settings-task-sources-jira.spec.ts` failing under the full suite's load, and pinned
   * there deterministically by holding a read open.
   */
  const editSeq = useRef(0);

  const setView = useCallback((v: TaskSourcesView | null): void => {
    viewRef.current = v;
    setViewState(v);
  }, []);

  /**
   * Read the route, and apply the result only if it can still be the whole truth.
   *
   * `seqAtRequest` is which edit this read is entitled to reflect, and a caller that is
   * CONFIRMING a particular save must pass that save's own sequence rather than let this snapshot
   * the latest one. The difference is a real lost write:
   *
   *  - save A goes out; edit B is made and queues behind it;
   *  - A's confirming read defaults to the CURRENT sequence, which is already B's;
   *  - the response contains only A, `readIsCurrent(B, B)` says yes, and B's optimistic value is
   *    wiped from the view before B has even been sent;
   *  - the operator now edits C from that reverted view, so C's whole-config blob has no B in it,
   *    and C - queued last - overwrites B on the daemon for good.
   *
   * Defaulting to `editSeq.current` is right for the POLL, which is entitled to whatever is
   * current when it leaves. It is wrong for a confirming read, which is answering an older
   * question. `save` passes its own.
   */
  const refresh = useCallback(
    async (seqAtRequest: number = editSeq.current): Promise<void> => {
      const v = await fetchTaskSources();
      if (v && readIsCurrent(seqAtRequest, editSeq.current)) setView(v);
    },
    [setView],
  );

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      if (alive) await refresh();
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refresh]);

  /**
   * The write already in flight, so the next one can wait for it.
   *
   * Every save PUTs the WHOLE source list, so two of them in flight together are decided by
   * arrival rather than by intent: if the first is delayed past the second, it lands last and
   * puts its older blob back, dropping the newer field. `editSeq` does not help - it guards
   * reads and local reverts, and a request already on the wire is neither.
   *
   * Serialized rather than fixed with a server-side revision, which would be a new wire
   * contract and a persisted field for one panel's benefit. The client is the only writer of
   * this config in practice, and it can simply take its turn. Two tabs writing at once remain
   * last-write-wins, as they are for every config in the app.
   */
  const writing = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * Apply a change optimistically, and TAKE IT BACK if the server refuses - so a switch
   * never shows a state that isn't in force. That contract matters more here than in most
   * panels: a source reading "on" while the daemon has it off means work you believe is
   * being swept is silently not, which looks exactly like an empty upstream.
   */
  const save = useCallback(
    async (sources: TaskSourceInstance[]): Promise<boolean> => {
      const before = viewRef.current;
      if (!before) return false;
      const seq = ++editSeq.current;
      // Optimistically and IMMEDIATELY, outside the queue: what an operator sees when they
      // finish typing must not wait on somebody else's round trip.
      setView({ ...before, sources });

      const queued = writing.current;
      const attempt = (async (): Promise<boolean> => {
        await queued;
        // Superseded while queued. A later edit composed its blob from this one's optimistic
        // view, so it already carries this change - and sending this older body after it would
        // overwrite the newer field with a value the operator has moved past.
        if (!readIsCurrent(seq, editSeq.current)) return true;
        const patch: TaskSourcesConfigPatch = { sources };
        const res = await api.setTaskSources(patch);
        if (!res.ok) {
          // Say so either way - a refusal the operator never sees is how a panel comes to
          // disagree with the daemon silently. But only REVERT while this is still the newest
          // edit: a later one has already replaced what `before` holds, and its own confirming
          // read is what corrects this one's optimistic value.
          setError(whyItFailed(res.error));
          if (readIsCurrent(seq, editSeq.current)) setView(before);
          return false;
        }
        setError(null);
        // THIS save's sequence, not whatever is current: a response that predates a queued edit
        // must not be applied over it. See `refresh`.
        await refresh(seq);
        return true;
      })();
      // Never a rejected link in the chain: one failed write must not stop the next one from
      // taking its turn.
      writing.current = attempt.catch(() => {});
      return attempt;
    },
    [refresh, setView],
  );

  const sweep = useCallback(
    async (id: string): Promise<SweepReport | null> => {
      const res = await api.sweepTaskSource(id);
      // Refreshed either way: a failed sweep still moves `lastError`, and that is the
      // thing the operator needs to read.
      await refresh();
      if (!res.ok) {
        setError(whyItFailed(res.error));
        return null;
      }
      setError(null);
      return res;
    },
    [refresh],
  );

  const preflight = useCallback(async (id: string): Promise<string | null> => {
    const res = await api.preflightTaskSource(id);
    if (!res.ok) return res.error ?? "the preflight could not run";
    return res.problem;
  }, []);

  const forget = useCallback(
    async (id: string): Promise<void> => {
      await api.forgetTaskSourceSeen(id);
      await refresh();
    },
    [refresh],
  );

  return { view, save, sweep, preflight, forget, error };
}
