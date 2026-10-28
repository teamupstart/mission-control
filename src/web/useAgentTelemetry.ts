import { useCallback, useEffect, useState } from "react";
import type { AgentTelemetryPatch, AgentTelemetryStatus } from "@shared/agent-telemetry.ts";
import { api, fetchAgentTelemetry } from "./lib/api.ts";

// Settings > Agent telemetry's state. Read when the panel opens and after every save, never
// polled: it changes only when someone edits it here, or when device management changes,
// which a reopen picks up.

export interface AgentTelemetryState {
  status: AgentTelemetryStatus | null;
  /** True once the first read settled, whether or not it succeeded. */
  loaded: boolean;
  error: string | null;
  saving: boolean;
  save: (patch: AgentTelemetryPatch) => Promise<boolean>;
}

export function useAgentTelemetry(active: boolean): AgentTelemetryState {
  const [status, setStatus] = useState<AgentTelemetryStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void fetchAgentTelemetry().then((next) => {
      if (!alive) return;
      if (next) setStatus(next);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [active]);

  const save = useCallback(async (patch: AgentTelemetryPatch): Promise<boolean> => {
    setSaving(true);
    setError(null);
    const res = await api.setAgentTelemetry(patch);
    setSaving(false);
    if (!res.ok) {
      const flat = (res.error ?? "").replace(/\s+/g, " ").trim();
      setError(`That change didn't stick${flat ? `: ${flat.length > 160 ? `${flat.slice(0, 159)}…` : flat}` : "."}`);
      return false;
    }
    const { ok: _ok, status: _status, error: _error, ...rest } = res;
    setStatus(rest as AgentTelemetryStatus);
    return true;
  }, []);

  return { status, loaded, error, saving, save };
}
