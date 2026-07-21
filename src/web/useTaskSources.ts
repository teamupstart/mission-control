import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskSourcesConfigPatch } from "@shared/protocol.ts";
import type { SweepReport, TaskSourceInstance, TaskSourcesView } from "@shared/task-source.ts";
import { api, fetchTaskSources } from "./lib/api.ts";

// The "Task sources" settings section: what pulls work INTO the backlog, and how each one
// is doing. Owned locally by SettingsModal (like useSkills / useHarnesses), because
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

  const setView = useCallback((v: TaskSourcesView | null): void => {
    viewRef.current = v;
    setViewState(v);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const v = await fetchTaskSources();
    if (v) setView(v);
  }, [setView]);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const v = await fetchTaskSources();
      if (alive && v) setView(v);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setView]);

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
      setView({ ...before, sources });
      const patch: TaskSourcesConfigPatch = { sources };
      const res = await api.setTaskSources(patch);
      if (!res.ok) {
        setView(before);
        setError(whyItFailed(res.error));
        return false;
      }
      setError(null);
      await refresh();
      return true;
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
