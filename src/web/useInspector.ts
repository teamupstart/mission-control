import { useCallback, useEffect, useRef, useState } from "react";
import type { InspectorConfig, InspectorConfigPatch } from "@shared/protocol.ts";
import type { InspectorInspection } from "@shared/types.ts";
import { api, fetchInspectorConfig, fetchInspectorPrs } from "./lib/api.ts";

// Inspector config plus the recent-inspections list. Polled rather than streamed for the
// same reason Foreman's is: coarse, low-frequency control-panel chrome, not worth another
// SSE channel. The per-card chip DOES ride SSE, on the session it belongs to.

const POLL_MS = 4000;

function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick - the Inspector refused it.";
  return `That change didn't stick: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
}

export interface InspectorState {
  config: InspectorConfig | null;
  /** Adopted PRs, newest activity first. What makes dry-run legible. */
  inspections: InspectorInspection[];
  update: (patch: InspectorConfigPatch) => Promise<void>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useInspector(): InspectorState {
  const [config, setConfigState] = useState<InspectorConfig | null>(null);
  const [inspections, setInspections] = useState<InspectorInspection[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The config as last written, readable without making `update` depend on it (which
  // would rebuild the callback on every keystroke). This is what a revert restores.
  const configRef = useRef<InspectorConfig | null>(null);

  const setConfig = useCallback((c: InspectorConfig | null): void => {
    configRef.current = c;
    setConfigState(c);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const [c, prs] = await Promise.all([fetchInspectorConfig(), fetchInspectorPrs()]);
      if (!alive) return;
      if (c) setConfig(c);
      if (prs) setInspections(prs);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
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
    async (patch: InspectorConfigPatch): Promise<void> => {
      const before = configRef.current;
      if (!before) return;
      setConfig({ ...before, ...patch });
      const res = await api.setInspectorConfig(patch);
      if (!res.ok) {
        setConfig(before);
        setError(whyItFailed(res.error));
        return;
      }
      setError(null);
      const c = await fetchInspectorConfig();
      if (c) setConfig(c);
    },
    [setConfig],
  );

  return { config, inspections, update, error };
}
