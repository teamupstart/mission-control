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
   * ---- The one rule this hook is built on ----
   *
   * A response may be written into the view ONLY IF the client's picture of the world has not
   * moved since that response was requested. Everything below is that sentence, and the reason it
   * needs saying once rather than being re-derived per call site is that four separate defects here
   * were all the same mistake wearing different clothes.
   *
   * Why it bites at all: this panel polls every 4 seconds, applies edits optimistically, and a
   * kind's fields compose the WHOLE config blob from what is on screen (`{...cfg, jql}`). So a
   * response applied over a value the operator has moved past is not a flash - the very next
   * field's commit persists the reverted blob, and the edit is gone from the daemon for good.
   *
   * The picture moves for two different reasons, which is why there are two counters:
   *
   *  - `editSeq` - an edit has STARTED. A read that left before it cannot describe it.
   *  - `writeGen` - a write has LANDED. A read that left before that write describes an older
   *    server, even if no new edit began in between.
   *
   * Both are needed, and one is not the other. Editing B while A is in flight moves `editSeq`
   * only; B's own PUT landing moves `writeGen` only. A poll that left after B's edit but before
   * B's PUT arrived carries B's `editSeq` and yet holds a pre-B server, which is exactly how the
   * fourth defect got in: `readIsCurrent(B, B)` said yes and restored the stale value after B's
   * own confirming read had already applied the right one.
   */
  const editSeq = useRef(0);
  const writeGen = useRef(0);

  const setView = useCallback((v: TaskSourcesView | null): void => {
    viewRef.current = v;
    setViewState(v);
  }, []);

  /**
   * Read the route, and apply the result only if it can still be the whole truth - the rule above.
   *
   * BOTH counters are checked, and each catches a case the other cannot:
   *
   *  - a later EDIT means this response cannot describe what is now on screen;
   *  - a later landed WRITE means this response describes an older server than the one the client
   *    has already been told about, which is the poll-versus-confirming-read race.
   *
   * `seqAtRequest` is which edit this read is entitled to reflect. A caller CONFIRMING a particular
   * save passes that save's own sequence rather than letting this snapshot the latest one, because
   * defaulting there wipes an edit queued behind it: A's confirming read would carry B's sequence,
   * pass its own guard, and remove B from the view before B had even been sent - after which the
   * operator's next edit composes a blob without B and overwrites it for good. The POLL keeps the
   * default, because whatever is current when a poll leaves is exactly what a poll is asking about.
   */
  const refresh = useCallback(
    async (seqAtRequest: number = editSeq.current): Promise<void> => {
      const genAtRequest = writeGen.current;
      const v = await fetchTaskSources();
      if (!v) return;
      if (!readIsCurrent(seqAtRequest, editSeq.current)) return;
      if (!readIsCurrent(genAtRequest, writeGen.current)) return;
      setView(v);
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
        // The server has moved, so every read already in flight is describing an older one. This
        // is what invalidates a poll that left after this edit but before this write arrived -
        // without it, such a poll carries this edit's sequence, passes the edit check, and puts
        // the pre-write config back on top of the confirming read below.
        writeGen.current += 1;
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
