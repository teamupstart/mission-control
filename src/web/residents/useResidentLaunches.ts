import { useCallback, useEffect, useRef, useState } from "react";
import type { ResidentProfile } from "@shared/residents.ts";
import { launchResident, residentLaunchControlReport } from "./launch.ts";

/** How often a still-starting launch is replayed - the same request id - to read its outcome. */
const PENDING_REPLAY_MS = 1_500;
/**
 * How long a launch keeps being replayed while it is still starting before it stops and hands
 * the choice back. A stalled startup must not leave Launch disabled indefinitely; the request
 * id is kept, so the next Launch checks the same launch.
 */
export const DOCK_PENDING_LIMIT_MS = 60_000;

/** One profile's launch, kept while the dock or drawer is shut so a retry replays it. */
export interface ResidentLaunchState {
  /** The id the next NEW launch will use. An outstanding launch replays its own instead. */
  requestId: string;
  /**
   * Exactly what an outstanding launch sent - sent, with no definitive answer yet: still
   * starting, stopped at the replay limit, or its answer lost. Every retry replays this, not the
   * profile as it reads now. The daemon compares a reused id with the input it recorded, so a
   * default repository edited mid-launch would turn the replay into a refused "different
   * launch", and the fresh id that follows could start a second resident. Cleared only by a
   * definitive answer.
   */
  outstanding: { requestId: string; repoRoot: string } | null;
  busy: boolean;
  error: string | null;
  /** The launch reached its session; cleared on the next launch. */
  launched: boolean;
  /**
   * Still starting when replaying stopped (`DOCK_PENDING_LIMIT_MS`). The request id is kept,
   * so Launch checks this same launch again rather than starting another.
   */
  stillStarting: boolean;
  /**
   * The launch reached its session without the session control its profile asks for, or with it
   * still pending, or null when there is nothing to say.
   */
  controlReport: "pending" | "not-granted" | null;
}

export interface ResidentLaunches {
  launches: Readonly<Record<string, ResidentLaunchState>>;
  /**
   * Launch a profile in its default repository, or replay its outstanding launch. Answers
   * `"needs-repository"` without sending anything when the profile has no default repository
   * and nothing is outstanding: the caller opens Dispatch > Resident on it instead.
   */
  launch: (profile: ResidentProfile) => Promise<"needs-repository" | void>;
}

/**
 * The one launch-state source for the Residents dock and the Residents drawer.
 *
 * Owned once by App rather than by whichever surface is mounted, so switching placement, or
 * closing the drawer while a launch is starting, keeps its request id: launching again replays
 * that launch, never a second. A launch goes through `launchResident()`, the one browser launch
 * call.
 */
export function useResidentLaunches(): ResidentLaunches {
  const [launches, setLaunches] = useState<Record<string, ResidentLaunchState>>({});
  // Read by `launch` through a ref so the callback stays stable while state moves under it.
  const launchesRef = useRef(launches);
  launchesRef.current = launches;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const patchLaunch = useCallback((profileId: string, patch: Partial<ResidentLaunchState>): void => {
    setLaunches((prev) => {
      const current = prev[profileId] ?? freshLaunch();
      return { ...prev, [profileId]: { ...current, ...patch } };
    });
  }, []);

  const launch = useCallback(async (profile: ResidentProfile): Promise<"needs-repository" | void> => {
    const current = launchesRef.current[profile.id];
    // An outstanding launch is replayed exactly as it was sent, whatever the profile says now.
    const outstanding = current?.outstanding ?? null;
    const repoRoot = outstanding?.repoRoot ?? profile.settings.workspace.defaultRepoRoot?.trim();
    if (!repoRoot) return "needs-repository";
    const requestId = outstanding?.requestId ?? current?.requestId ?? crypto.randomUUID();
    const sent = { requestId, repoRoot };
    // Recorded BEFORE it is sent: from here until a definitive answer, this is the launch.
    patchLaunch(profile.id, {
      requestId,
      outstanding: sent,
      busy: true,
      error: null,
      launched: false,
      stillStarting: false,
      controlReport: null,
    });
    const input = { repoRoot, requestId };
    const startedAt = Date.now();
    // Still inside the Launch click: the one call that may arm session control for this run.
    let answer = await launchResident(profile.id, input, { profile });
    // Still starting: replay the SAME request id until it settles. A replay reads the one run
    // this id reserved and never starts another. Bounded, so a stalled startup gives Launch
    // back - with the id kept - instead of holding the row busy indefinitely.
    while (answer.state === "pending") {
      if (!mounted.current) return;
      if (Date.now() - startedAt >= DOCK_PENDING_LIMIT_MS) {
        patchLaunch(profile.id, { busy: false, error: null, launched: false, stillStarting: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, PENDING_REPLAY_MS));
      if (!mounted.current) return;
      answer = await launchResident(profile.id, input);
    }
    if (!mounted.current) return;
    switch (answer.state) {
      case "launched":
        patchLaunch(profile.id, {
          ...freshLaunch(),
          launched: true,
          controlReport: residentLaunchControlReport(answer.run, false),
        });
        return;
      case "failed":
        // Definitive: the next attempt is a new launch.
        patchLaunch(profile.id, { ...freshLaunch(), error: `Did not start: ${answer.error}` });
        return;
      case "refused":
        // No answer at all keeps the outstanding launch, so a retry replays what the daemon may
        // hold; a refusal created nothing, and reusing its id would be a conflict.
        patchLaunch(profile.id, answer.code === "unavailable"
          ? { busy: false, error: answer.error }
          : { requestId: crypto.randomUUID(), outstanding: null, busy: false, error: answer.error });
        return;
    }
  }, [patchLaunch]);

  return { launches, launch };
}

function freshLaunch(): ResidentLaunchState {
  return {
    requestId: crypto.randomUUID(),
    outstanding: null,
    busy: false,
    error: null,
    launched: false,
    stillStarting: false,
    controlReport: null,
  };
}
