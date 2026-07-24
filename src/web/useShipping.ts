import { useCallback, useEffect, useRef, useState } from "react";
import type { ShippingConfig, ShippingConfigPatch } from "@shared/protocol.ts";
import type { InspectorInspection } from "@shared/types.ts";
import { api, fetchInspectorPrs, fetchShippingConfig } from "./lib/api.ts";

// YOLO mode's config plus the adopted-PR ledger it acts on. Polled rather than streamed,
// for the same reason the Inspector's is: coarse, low-frequency control-panel chrome.
//
// The ledger is the INSPECTOR'S route, deliberately reused rather than duplicated - a
// PR's merge block is a column on the row that says we opened it, and a second route
// returning the same rows under another name is how the two eventually disagree about
// which PRs exist.

const POLL_MS = 4000;

function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick - the daemon refused it.";
  return `That change didn't stick: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
}

export interface ShippingState {
  config: ShippingConfig | null;
  /** Adopted PRs, newest activity first - the ones YOLO mode is deciding about. */
  inspections: InspectorInspection[];
  /**
   * Apply a patch, resolving to whether the daemon accepted it. Callers editing a field
   * ignore the boolean; Trust waits on it so it retires a staged repo only once its first
   * merge grant here has actually landed (see `ForemanState.update`).
   */
  update: (patch: ShippingConfigPatch) => Promise<boolean>;
  /** Why the last edit didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

export function useShipping(): ShippingState {
  const [config, setConfigState] = useState<ShippingConfig | null>(null);
  const [inspections, setInspections] = useState<InspectorInspection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<ShippingConfig | null>(null);
  /**
   * Bumped by every write; a poll discards its answer if a write started while it was in
   * flight. Same guard as `useInspector`, and it matters here for the same reason: the
   * switch it protects decides whether pull requests merge without anyone watching, and a
   * toggle that visibly snaps back is a toggle nobody can trust they clicked.
   */
  const writes = useRef(0);

  const setConfig = useCallback((c: ShippingConfig | null): void => {
    configRef.current = c;
    setConfigState(c);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const at = writes.current;
      const [c, prs] = await Promise.all([fetchShippingConfig(), fetchInspectorPrs()]);
      if (!alive) return;
      if (prs) setInspections(prs);
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
   * Apply a config change optimistically, and TAKE IT BACK if the server refuses.
   *
   * The revert is the same one `useInspector` does, and the argument for it is stronger
   * here by exactly the difference between a comment and a merge: a panel reading "YOLO
   * off" while the daemon has it on is the state in which somebody walks away.
   */
  const update = useCallback(
    async (patch: ShippingConfigPatch): Promise<boolean> => {
      const before = configRef.current;
      if (!before) return false;
      writes.current += 1;
      setConfig({ ...before, ...patch });
      const res = await api.setShippingConfig(patch);
      if (!res.ok) {
        setConfig(before);
        setError(whyItFailed(res.error));
        return false;
      }
      setError(null);
      const at = (writes.current += 1);
      const c = await fetchShippingConfig();
      if (c && writes.current === at) setConfig(c);
      return true;
    },
    [setConfig],
  );

  return { config, inspections, update, error };
}
