import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupChecksView } from "@shared/setup-catalog.ts";
import { api, fetchSetupChecks } from "./lib/api.ts";

export interface SetupChecksState {
  view: SetupChecksView | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** Persist the banner's current acknowledgement, returning a sentence on refusal. */
  dismissBanner(): Promise<string | null>;
}

const INSPECTION_ERROR = "Mission Control could not inspect this machine's setup.";

export interface SetupChecksRead {
  view: SetupChecksView | null;
  error: string | null;
}

/** Keep a rejected optional read inside the panel's ordinary error state. */
export async function readSetupChecks(
  fetcher: () => Promise<SetupChecksView | null> = fetchSetupChecks,
): Promise<SetupChecksRead> {
  try {
    const view = await fetcher();
    return view ? { view, error: null } : { view: null, error: INSPECTION_ERROR };
  } catch {
    return { view: null, error: INSPECTION_ERROR };
  }
}

/** Mount-time and operator-requested reads only. Machine setup has no polling side effects. */
export function useSetupChecks(enabled: boolean): SetupChecksState {
  const [view, setView] = useState<SetupChecksView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const request = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    const next = await readSetupChecks();
    if (!alive.current || id !== request.current) return;
    setLoading(false);
    setView(next.view);
    setError(next.error);
  }, []);
  const dismissBanner = useCallback(async (): Promise<string | null> => {
    const current = viewRef.current;
    if (!current) return "Machine setup has not finished loading.";
    const result = await api.dismissSetupBanner(current.banner.attentionRowIds);
    if (!result.ok) return result.error ?? "The setup reminder could not be dismissed.";
    if (alive.current) {
      setView((latest) => latest === current
        ? { ...current, banner: { ...current.banner, visible: false } }
        : latest);
    }
    return null;
  }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  return { view, loading, error, refresh, dismissBanner };
}
