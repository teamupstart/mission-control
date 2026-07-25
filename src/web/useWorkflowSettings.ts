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

/** One completed poll's two reads. `null` is a read that FAILED, not one that is pending. */
export interface WorkflowPollReads {
  config: WorkflowConfig | null;
  status: WorkflowStatus | null;
}

/**
 * What a completed poll does to the two displayed readings.
 *
 * The rule is that **a failed read is "unknown", and unknown REPLACES the last good
 * reading rather than deferring to it.** Keeping the previous value on a failure is the
 * more natural-looking code (`if (next) set(next)`) and it is wrong in the direction that
 * matters here: the panel goes on presenting queue depths, a last-sweep time and a
 * Live-delivery switch as the daemon's current answer while the daemon is not answering at
 * all. Every "the daemon has not said" affordance this panel draws - the unknown banner,
 * the disabled controls, the unavailable-health line - is reached from a null, so a null
 * that never arrives is an affordance that never shows.
 *
 * The ONE exception is the config read losing a race with a write: a `PUT` that landed
 * after this poll's `GET` left holds the newer truth, so its value stands and the poll's is
 * dropped - including a poll whose read failed, which must not null out a config the
 * operator just successfully saved. Status is never raced, because nothing here writes it.
 *
 * Pure and exported because the hook's own effect cannot be driven without a DOM, and this
 * is the decision inside it worth pinning.
 */
export function applyWorkflowPoll(
  reads: WorkflowPollReads,
  racedByWrite: boolean,
  displayedConfig: WorkflowConfig | null,
): WorkflowPollReads {
  return {
    config: racedByWrite ? displayedConfig : reads.config,
    status: reads.status,
  };
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
      const [config, status] = await Promise.all([
        // A refusal is not thrown at the operator: it becomes a null reading, which is what
        // every "the daemon has not said" affordance in the panel is keyed on. 503 while the
        // manager is starting is the ordinary case, and the next tick asks again.
        workflowRequest<WorkflowConfig>("/api/workflows/config").catch(() => null),
        workflowRequest<WorkflowStatus>("/api/workflows/status").catch(() => null),
      ]);
      if (!alive) return;
      const next = applyWorkflowPoll(
        { config, status },
        writes.current !== at,
        configRef.current,
      );
      setStatus(next.status);
      setConfig(next.config);
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
