import { useCallback, useEffect, useRef, useState } from "react";
import type { InspectorConfig, InspectorConfigPatch } from "@shared/protocol.ts";
import type { InspectorInspection } from "@shared/types.ts";
import type { ResolvedModel } from "@shared/model-choice.ts";
import type { ResolvedLlmRunner } from "@shared/llm.ts";
import {
  api,
  fetchInspectorConfig,
  fetchInspectorPrs,
  fetchInspectorStatus,
} from "./lib/api.ts";

// Inspector config plus the recent-inspections list. Polled rather than streamed for the
// same reason Foreman's is: coarse, low-frequency control-panel chrome, not worth another
// SSE channel. The per-card chip DOES ride SSE, on the session it belongs to.

const POLL_MS = 4000;

function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick - GitHub Inspector refused it.";
  return `That change didn't stick: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
}

export interface InspectorState {
  config: InspectorConfig | null;
  /** Adopted PRs, newest activity first. What makes dry-run legible. */
  inspections: InspectorInspection[];
  /**
   * The model the daemon will actually spawn with, and which layer chose it. Null until
   * the daemon answers - the field falls back to showing the shipped default, which is
   * the same thing an unreachable daemon does to every other control here.
   */
  model: ResolvedModel | null;
  /**
   * The provider the review call resolves to, and which layer chose it. Null until the
   * daemon answers.
   *
   * From the daemon rather than from `config.runner`, because an unset value now inherits
   * the app-wide ladder and the env layer under it is invisible here - reading the config
   * would print a provider the Inspector is not using.
   */
  runner: ResolvedLlmRunner | null;
  /**
   * Apply a patch, resolving to whether the daemon accepted it. Callers editing a field
   * ignore the boolean; Trust waits on it so it retires a staged repo only once its first
   * grant here has actually landed (see `ForemanState.update`).
   */
  update: (patch: InspectorConfigPatch) => Promise<boolean>;
  /** Re-read config and status now, for a change made to a blob this hook does not own. */
  refresh: () => Promise<void>;
  /**
   * Close the findings on one pull request, and refresh the list so the row says so.
   *
   * Not optimistic, unlike `update`. A finding count is evidence about a public pull
   * request rather than the state of a control the operator is holding: showing it at zero
   * before the daemon has agreed would be claiming the review is settled when it may not
   * be. The refetch is awaited instead, so the number changes when it is true.
   */
  resolveFindings: (prKey: string) => Promise<boolean>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useInspector(): InspectorState {
  const [config, setConfigState] = useState<InspectorConfig | null>(null);
  const [inspections, setInspections] = useState<InspectorInspection[]>([]);
  const [model, setModel] = useState<ResolvedModel | null>(null);
  const [runner, setRunner] = useState<ResolvedLlmRunner | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The config as last written, readable without making `update` depend on it (which
  // would rebuild the callback on every keystroke). This is what a revert restores.
  const configRef = useRef<InspectorConfig | null>(null);
  /**
   * Bumped by every write. A poll reads it before its request and again after, and
   * discards its answer if a write started in between.
   *
   * Without it, a tick that left just before the operator clicks "Live" lands after the
   * click and overwrites the new state with the pre-write config: the radio visibly
   * snaps back to Dry run and the live warning disappears for a second while the daemon
   * is going live. The same stale value can become `before`, so a rejected write would
   * then "revert" to a config that was never in force.
   */
  const writes = useRef(0);

  const setConfig = useCallback((c: InspectorConfig | null): void => {
    configRef.current = c;
    setConfigState(c);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const at = writes.current;
      const [c, prs, status] = await Promise.all([
        fetchInspectorConfig(),
        fetchInspectorPrs(),
        fetchInspectorStatus(),
      ]);
      if (!alive) return;
      // The inspections list is a read-only display and cannot be raced with, so it is
      // applied regardless; only the config a write may have just changed is dropped.
      if (prs) setInspections(prs);
      // The resolved model IS raced by a write - it is derived from the config a `PUT`
      // may have just changed - so it takes the same guard, or committing a model would
      // flash the old id back for a poll interval.
      if (status && writes.current === at) {
        setModel(status.model);
        setRunner(status.runner);
      }
      if (c && writes.current === at) setConfig(c);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setConfig]);

  /**
   * Re-read config and status now, without writing anything.
   *
   * The Inspector's resolved provider and model now follow the app-wide picker when it has
   * chosen nothing of its own, and that picker lives in another blob behind another hook - so
   * moving it changes this row with no Inspector write to hang a re-read on.
   */
  const reread = useCallback(async (): Promise<void> => {
    const at = (writes.current += 1);
    const [c, status] = await Promise.all([fetchInspectorConfig(), fetchInspectorStatus()]);
    if (writes.current !== at) return;
    if (status) {
      setModel(status.model);
      setRunner(status.runner);
    }
    if (c) setConfig(c);
  }, [setConfig]);

  /**
   * Apply a config change optimistically, and TAKE IT BACK if the server refuses.
   *
   * The revert matters more here than in any other panel: these switches decide whether
   * something writes to a public pull request. A toggle that reads "live" while the
   * daemon has it off is a lie in the harmless direction; one that reads "dry-run" while
   * the daemon is live is the whole ballgame.
   */
  const update = useCallback(
    async (patch: InspectorConfigPatch): Promise<boolean> => {
      const before = configRef.current;
      if (!before) return false;
      writes.current += 1;
      setConfig({ ...before, ...patch });
      const res = await api.setInspectorConfig(patch);
      if (!res.ok) {
        setConfig(before);
        setError(whyItFailed(res.error));
        return false;
      }
      setError(null);
      // The status comes back with the config, not on the next poll: a committed model
      // has to re-resolve NOW, or the source line under the box goes on saying "Shipped
      // default" for up to `POLL_MS` after you typed an override into it. A newer write that
      // supersedes the refetch drops it; the write itself still committed on the server, so
      // it succeeded from this caller's point of view.
      await reread();
      return true;
    },
    [reread, setConfig],
  );

  const resolveFindings = useCallback(async (prKey: string): Promise<boolean> => {
    const res = await api.resolveInspectorFindings(prKey);
    if (!res.ok) {
      setError(whyItFailed(res.error));
      return false;
    }
    setError(null);
    const prs = await fetchInspectorPrs();
    if (prs) setInspections(prs);
    return true;
  }, []);

  return { config, inspections, model, runner, update, refresh: reread, resolveFindings, error };
}
