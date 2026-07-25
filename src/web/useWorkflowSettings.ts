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

/**
 * A reading of the write clock: taken when a poll's requests go out, and again when they
 * come back.
 */
export interface WriteClock {
  /** Writes that have FINISHED, success or refusal. */
  completed: number;
  /** Writes in flight at this instant. */
  inFlight: number;
}

/**
 * Whether a write overlapped the poll that ran between these two clock readings.
 *
 * A single "generation" counter bumped per write is the obvious shape and it does not
 * work, because the window that matters opens before the counter moves. A `PUT` that is
 * still in flight has not changed anything the counter can see, so a poll issued just
 * after the save started reads the PRE-write config from the daemon, finds the counter
 * exactly where it left it, and applies that read over the operator's optimistic value -
 * the Live-delivery switch snaps back to off for the length of the write and then flips on
 * again when the `PUT` lands. Measured at 7 seconds against a deliberately slowed write.
 *
 * So the question is not "did anything change" but "was a write anywhere near this poll",
 * and the three disjuncts are the three ways it can be, each unreachable by the others:
 * a write was already in flight when the reads went out; a write started while they were
 * out and is still going; or a write began AND finished entirely inside the poll's window,
 * which leaves `inFlight` at zero on both readings and is visible only in `completed`.
 *
 * Erring towards "raced" costs one poll interval of slightly older data, which the next
 * tick corrects. Erring the other way is the snap-back.
 */
export function pollRacedByWrite(before: WriteClock, after: WriteClock): boolean {
  return before.inFlight > 0 || after.inFlight > 0 || after.completed !== before.completed;
}

/**
 * Whether a poll that has just come back is still the newest one to have done so.
 *
 * The interval starts a tick whether or not the previous one's requests are still out, so
 * two polls can be in flight at once and they do not have to land in the order they left.
 * An older one landing last repaints what IT read - the panel showed Live delivery come on
 * and then go off again for nearly three seconds against a held response - and the value it
 * restores is not merely displayed: every save on this panel spreads the config it is
 * holding, so an operator acting during that window writes the obsolete blob back.
 *
 * An id per poll, and a completion older than the newest applied is dropped. The
 * alternative - refusing to start a tick while one is in flight - rules the reorder out
 * structurally but has a worse failure: `fetch` has no timeout, so one request that never
 * settles would stop the panel polling for good, leaving exactly the stale-reading-shown-as-
 * current state the null handling above exists to prevent. Asking again on schedule and
 * discarding what arrives out of order keeps a wedged request from becoming a wedged panel.
 */
export function pollIsLatest(id: number, lastApplied: number): boolean {
  return id > lastApplied;
}

export function useWorkflowSettings(): WorkflowSettingsState {
  const [config, setConfigState] = useState<WorkflowConfig | null>(null);
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<WorkflowConfig | null>(null);
  /**
   * The write clock a poll is checked against, in two refs so `pollRacedByWrite` can see
   * an unfinished write as well as a finished one. Refs rather than state: a poll in
   * flight has to read the value that is true NOW, not the one its closure captured.
   */
  const writesCompleted = useRef(0);
  const writesInFlight = useRef(0);
  /** Ids handed out to polls, and the newest whose reads reached the screen. */
  const pollsStarted = useRef(0);
  const pollApplied = useRef(0);
  const readClock = useCallback(
    (): WriteClock => ({
      completed: writesCompleted.current,
      inFlight: writesInFlight.current,
    }),
    [],
  );

  const setConfig = useCallback((next: WorkflowConfig | null): void => {
    configRef.current = next;
    setConfigState(next);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const id = ++pollsStarted.current;
      const before = readClock();
      const [config, status] = await Promise.all([
        // A refusal is not thrown at the operator: it becomes a null reading, which is what
        // every "the daemon has not said" affordance in the panel is keyed on. 503 while the
        // manager is starting is the ordinary case, and the next tick asks again.
        workflowRequest<WorkflowConfig>("/api/workflows/config").catch(() => null),
        workflowRequest<WorkflowStatus>("/api/workflows/status").catch(() => null),
      ]);
      if (!alive) return;
      // A poll that has been overtaken is dropped whole - both readings, not just the
      // config: the status counters are as old as the config that came back with them.
      if (!pollIsLatest(id, pollApplied.current)) return;
      pollApplied.current = id;
      // The second clock reading sits directly after the await with nothing between them,
      // so no write can slip in unseen between the reads landing and being judged.
      const next = applyWorkflowPoll(
        { config, status },
        pollRacedByWrite(before, readClock()),
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
  }, [setConfig, readClock]);

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
      // Marked in flight BEFORE the request goes out, which is the whole point: the window
      // a poll has to be kept out of opens at the click, not when the daemon answers.
      writesInFlight.current += 1;
      setConfig(next);
      try {
        const saved = await workflowRequest<WorkflowConfig>("/api/workflows/config", {
          method: "PUT",
          body: JSON.stringify(next),
        });
        setConfig(saved);
        setError(null);
        return true;
      } catch (caught) {
        setConfig(before);
        setError(why(caught, "Could not save Workflow settings"));
        return false;
      } finally {
        // Both halves in a `finally`, so a refused write closes its window too - otherwise
        // one failed save leaves `inFlight` above zero and every later poll is discarded as
        // raced, which is a panel that quietly stops updating.
        writesInFlight.current -= 1;
        writesCompleted.current += 1;
      }
    },
    [setConfig],
  );

  return { config, status, update, error };
}
