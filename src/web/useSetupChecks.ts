import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupChecksView } from "@shared/setup-catalog.ts";
import { fetchSetupChecks } from "./lib/api.ts";

export interface SetupChecksState {
  view: SetupChecksView | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

/** Mount-time and operator-requested reads only. Machine setup has no polling side effects. */
export function useSetupChecks(enabled: boolean): SetupChecksState {
  const [view, setView] = useState<SetupChecksView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const request = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    const next = await fetchSetupChecks();
    if (!alive.current || id !== request.current) return;
    setLoading(false);
    if (next) setView(next);
    else setError("Mission Control could not inspect this machine's setup.");
  }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  return { view, loading, error, refresh };
}
