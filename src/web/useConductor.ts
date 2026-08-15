import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelinesConfig, PipelinesView } from "@shared/pipeline.ts";
import { api, fetchPipelines } from "./lib/api.ts";
import { readIsCurrent } from "./harnesses-reconcile.ts";

// The "Conductor" settings section: whether an external SDLC engine is installed, which
// repositories it manages, and which of them this operator has consented to observe.
// Owned locally by SettingsPage (like `useTaskSources` / `useSkills`), because nothing
// outside the panel reads it.
//
// Polled rather than streamed, for the reason the other config hooks are: coarse,
// rarely-edited chrome is not worth another SSE channel. The poll also carries the health
// line, so a repository's run count and daemon state move while you watch.
//
// The read/write race discipline below is `useTaskSources`' verbatim, and it is not
// defensive copying - this panel has the identical hazard. It polls, it applies edits
// optimistically, and every save PUTs the WHOLE config, so a response applied over a value
// the operator has moved past is not a flash: the next switch composes its blob from the
// reverted view and persists it. The two counters and the write queue are what stop that.
// See `useTaskSources` for the four defects that wrote this rule.

const POLL_MS = 4000;

/** Flatten a rejection to one clamped sentence. Mirrors `useTaskSources`'s twin. */
function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick.";
  return `That change didn't stick: ${flat.length > 120 ? `${flat.slice(0, 119)}…` : flat}`;
}

export interface ConductorState {
  /** Null until the first read lands. Null is UNKNOWN, never "nothing is enabled". */
  view: PipelinesView | null;
  /** Write the whole consent config. Applied optimistically, reverted if refused. */
  save: (config: PipelinesConfig) => Promise<boolean>;
  /** Re-run the engine probe now, bypassing the daemon's TTL cache. */
  recheck: () => Promise<void>;
  /** True while a forced re-check is in flight, so the control can say so. */
  checking: boolean;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

/**
 * @param active Whether the Conductor category is the one on screen.
 *
 * Gated, unlike its neighbours in this directory, and for a reason particular to this
 * subject: a read can start an engine PROBE, which is a subprocess. Every other settings
 * hook polls a route that reads config, so paying for all of them on every category is
 * cheap; paying for a `fork` + `execve` on a page that is mostly about other things is not
 * - and it would be paid on a fleet that has this feature switched off entirely, which is
 * the one bill this phase promises nobody receives.
 */
export function useConductor(active: boolean): ConductorState {
  const [view, setViewState] = useState<PipelinesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const viewRef = useRef<PipelinesView | null>(null);
  /** An edit has STARTED: a read that left before it cannot describe what is on screen. */
  const editSeq = useRef(0);
  /** A write has LANDED: a read that left before it describes an older server. */
  const writeGen = useRef(0);

  const setView = useCallback((v: PipelinesView | null): void => {
    viewRef.current = v;
    setViewState(v);
  }, []);

  const refresh = useCallback(
    async (
      seqAtRequest: number = editSeq.current,
      { force = false }: { force?: boolean } = {},
    ): Promise<void> => {
      const genAtRequest = writeGen.current;
      const v = await fetchPipelines(force);
      if (!v) return;
      if (!readIsCurrent(seqAtRequest, editSeq.current)) return;
      if (!readIsCurrent(genAtRequest, writeGen.current)) return;
      setView(v);
    },
    [setView],
  );

  useEffect(() => {
    if (!active) return;
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
  }, [active, refresh]);

  /** The write already in flight, so the next one waits rather than racing it. */
  const writing = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * Apply a change optimistically, and TAKE IT BACK if the daemon refuses.
   *
   * The contract matters more here than in most panels because the switch IS the consent:
   * a repository reading "on" while the daemon has it off is a page claiming to be
   * watching something nothing is reading, and the operator's only evidence would be a run
   * list that never fills in.
   */
  const save = useCallback(
    async (config: PipelinesConfig): Promise<boolean> => {
      const before = viewRef.current;
      if (!before) return false;
      const seq = ++editSeq.current;
      setView({ ...before, config });

      const queued = writing.current;
      const attempt = (async (): Promise<boolean> => {
        await queued;
        // Superseded while queued: a later edit composed its blob from this one's
        // optimistic view, so sending this older body after it would overwrite it.
        if (!readIsCurrent(seq, editSeq.current)) return true;
        const res = await api.setPipelines(config);
        if (!res.ok) {
          setError(whyItFailed(res.error));
          if (readIsCurrent(seq, editSeq.current)) setView(before);
          return false;
        }
        setError(null);
        writeGen.current += 1;
        await refresh(seq);
        return true;
      })();
      writing.current = attempt.catch(() => {});
      return attempt;
    },
    [refresh, setView],
  );

  /**
   * Ask the daemon to probe the engine again, right now.
   *
   * The one call that sets `force`. An operator who has just installed the engine, or just
   * registered a repository with it, is asking a question the TTL cache would answer with
   * yesterday's news - and "I installed it and the panel still says it is missing" is
   * exactly the state this control exists to end.
   */
  const recheck = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      await refresh(editSeq.current, { force: true });
    } finally {
      setChecking(false);
    }
  }, [refresh]);

  return { view, save, recheck, checking, error };
}
