import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupChecksSnapshot } from "@shared/setup-catalog.ts";
import { api, fetchSetupChecks } from "./lib/api.ts";

export interface SetupChecksState {
  view: SetupChecksSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** Persist the banner's current acknowledgement, returning a sentence on refusal. */
  dismissBanner(): Promise<string | null>;
}

const INSPECTION_ERROR = "Mission Control could not inspect this machine's setup.";

export interface SetupChecksRead {
  view: SetupChecksSnapshot | null;
  error: string | null;
}

/** Keep a rejected optional read inside the panel's ordinary error state. */
export async function readSetupChecks(
  fetcher: () => Promise<SetupChecksSnapshot | null> = fetchSetupChecks,
): Promise<SetupChecksRead> {
  try {
    const view = await fetcher();
    return view ? { view, error: null } : { view: null, error: INSPECTION_ERROR };
  } catch {
    return { view: null, error: INSPECTION_ERROR };
  }
}

/**
 * Whether a Setup reading must be read again for the live flags, and the key that is now settled.
 *
 * `readWith` is the key the daemon stamped on the reading; an older daemon sends none, and then
 * the first key seen is taken as the one it read under, so only a later change re-reads. A key is
 * asked for once: a reading that still disagrees (a window whose own flags are stale) is not read
 * again until the live key moves.
 */
export function setupFlagsRefresh(
  settled: string | null,
  live: string,
  readWith: string | undefined,
): { settled: string; refresh: boolean } {
  if ((readWith ?? settled ?? live) === live) return { settled: live, refresh: false };
  if (settled === live) return { settled, refresh: false };
  return { settled: live, refresh: true };
}

/**
 * Mount-time and operator-requested reads only. Machine setup has no polling side effects.
 *
 * `flagsKey` is the live state of the preview flags Setup reads (`setupFlagsKey`), or null before
 * the first snapshot. When a reading was taken under other flags it is read again, once per live
 * key (`setupFlagsRefresh`), so a family that follows a flag appears with its rows and a row about
 * flags reads the switch just made - including a switch between the mount read and the snapshot.
 */
export function useSetupChecks(enabled: boolean, flagsKey: string | null = null): SetupChecksState {
  const [view, setView] = useState<SetupChecksSnapshot | null>(null);
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
    const result = await api.dismissSetupBanner(current.snapshotToken, current.banner.attentionRowIds);
    if (!result.ok) return result.error ?? "The setup reminder could not be dismissed.";
    if (alive.current) {
      setView((latest) => latest === current
        ? { ...current, banner: { ...current.banner, visible: false } }
        : latest);
    }
    return null;
  }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  const settledFlags = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || flagsKey === null || view === null || loading) return;
    const next = setupFlagsRefresh(settledFlags.current, flagsKey, view.flagsKey);
    settledFlags.current = next.settled;
    if (next.refresh) void refresh();
  }, [flagsKey, enabled, view, loading, refresh]);
  return { view, loading, error, refresh, dismissBanner };
}
