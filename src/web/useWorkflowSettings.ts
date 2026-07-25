import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowConfig, WorkflowStatus } from "@shared/workflow.ts";
import { workflowRequest } from "./workflows/workflowApi.ts";

// The Workflow subsystem's config plus its health counters, for the Workflows settings
// category. Polled rather than streamed, on the `useInspector` precedent: coarse,
// low-frequency control-panel chrome that is only on screen while the settings page is
// open, and not worth another SSE channel.
//
// The floating drawer this replaced fetched the config ONCE on mount and the health only
// when it was opened, which is why it needed a Refresh health button - a panel whose
// numbers were as old as the click that opened it. Both come from the same tick here, so
// the queue depths and the last sweep move while you are looking at them, and the button
// that used to compensate for that is gone rather than reduced to decoration.

const POLL_MS = 5000;

export interface WorkflowSettingsState {
  /** Null until the daemon answers - "unknown", never "these are the defaults in force". */
  config: WorkflowConfig | null;
  /** Health counters, or null when the manager is unavailable or has not answered yet. */
  status: WorkflowStatus | null;
  /**
   * Write the whole config, resolving to whether the daemon accepted it. The route is a
   * PUT of the complete blob (not a patch), so callers spread the config they were handed.
   */
  update: (next: WorkflowConfig) => Promise<boolean>;
  /** Why the last write didn't stick, or null. Cleared by the next one that does. */
  error: string | null;
}

function why(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

export function useWorkflowSettings(): WorkflowSettingsState {
  const [config, setConfigState] = useState<WorkflowConfig | null>(null);
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<WorkflowConfig | null>(null);
  /**
   * Bumped by every write, and read by a poll before its request and again after. Without
   * it a tick that left just before the operator enables Live delivery lands after the
   * click and paints the pre-write config back: the switch visibly snaps off while the
   * daemon is going live, which is the one direction this particular toggle must never
   * lie in.
   */
  const writes = useRef(0);

  const setConfig = useCallback((next: WorkflowConfig | null): void => {
    configRef.current = next;
    setConfigState(next);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const at = writes.current;
      const [nextConfig, nextStatus] = await Promise.all([
        workflowRequest<WorkflowConfig>("/api/workflows/config").catch(() => null),
        // 503 while the manager is starting, which is not an error to shout about - the
        // panel says health is unavailable and the next tick asks again.
        workflowRequest<WorkflowStatus>("/api/workflows/status").catch(() => null),
      ]);
      if (!alive) return;
      // Health is a read-only display and cannot be raced by a write, so it always lands;
      // only the config a PUT may have just changed is dropped.
      if (nextStatus) setStatus(nextStatus);
      if (nextConfig && writes.current === at) setConfig(nextConfig);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setConfig]);

  /**
   * Apply a config change optimistically, and TAKE IT BACK if the daemon refuses.
   *
   * The revert matters here for the Inspector's reason in a local key: this config decides
   * whether Mission Control may paste into someone's live agent session. A switch reading
   * "off" while the daemon has Live enabled is the failure that matters, so a refused write
   * must not leave the optimistic value on screen.
   */
  const update = useCallback(
    async (next: WorkflowConfig): Promise<boolean> => {
      const before = configRef.current;
      writes.current += 1;
      setConfig(next);
      try {
        const saved = await workflowRequest<WorkflowConfig>("/api/workflows/config", {
          method: "PUT",
          body: JSON.stringify(next),
        });
        writes.current += 1;
        setConfig(saved);
        setError(null);
        return true;
      } catch (caught) {
        setConfig(before);
        setError(why(caught, "Could not save Workflow settings"));
        return false;
      }
    },
    [setConfig],
  );

  return { config, status, update, error };
}
