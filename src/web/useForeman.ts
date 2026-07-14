import { useCallback, useEffect, useState } from "react";
import type { ForemanConfig, ForemanConfigPatch } from "@shared/protocol.ts";
import type { ForemanStatus } from "@shared/types.ts";
import { api, fetchForemanConfig, fetchForemanStatus } from "./lib/api.ts";

// Foreman config + live status for the topbar control and the per-card notes.
// Config is edited rarely (a control-panel poll is plenty); status carries the
// derived queue depth + counts. Polled rather than streamed because it's coarse,
// low-frequency dashboard chrome - not worth another SSE channel.

const POLL_MS = 4000;

export interface ForemanState {
  config: ForemanConfig | null;
  status: ForemanStatus | null;
  update: (patch: ForemanConfigPatch) => Promise<void>;
}

export function useForeman(): ForemanState {
  const [config, setConfig] = useState<ForemanConfig | null>(null);
  const [status, setStatus] = useState<ForemanStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const [c, s] = await Promise.all([fetchForemanConfig(), fetchForemanStatus()]);
      if (!alive) return;
      if (c) setConfig(c);
      if (s) setStatus(s);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const update = useCallback(async (patch: ForemanConfigPatch): Promise<void> => {
    setConfig((cur) => (cur ? { ...cur, ...patch } : cur)); // optimistic
    const res = await api.setForemanConfig(patch);
    if (res.ok) {
      const c = await fetchForemanConfig();
      if (c) setConfig(c);
    }
  }, []);

  return { config, status, update };
}
