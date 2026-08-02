import { pollIntervalMs } from "../config.ts";
import type { Registry } from "../registry.ts";
import { unref } from "../util/timers.ts";
import { gitInfo } from "../util/git.ts";
import { discover } from "./correlate.ts";

/**
 * Re-read the live Git facts for every driver-run session's checkout, and adopt them.
 *
 * Runs on the discovery cadence rather than a timer of its own because it answers the same
 * question the sweep already answers for pane-backed sessions - "what branch is this cwd
 * on now?" - through the same `gitInfo`, which
 * is pure filesystem and explicitly cheap enough to run for every session every poll. One
 * cadence and one reader is what keeps the two runtimes from disagreeing about Git state.
 *
 * Kept out of `applyDiscovery`: that takes what terminal discovery found, and widening it to
 * carry sessions the process sweep deliberately excludes is exactly the scope creep its own
 * comments warn off. The registry does the reconciling, this does the reading - the same split
 * `discover()` / `applyDiscovery()` already makes. `read` is injected so a test can drive
 * the real reconciliation with no repository on disk.
 */
export function refreshDriverGit(
  registry: Registry,
  read: (cwd: string) => { branch: string | null } = gitInfo,
): void {
  const targets = registry.driverGitTargets();
  if (targets.length === 0) return;
  registry.applyDriverGit(new Map(targets.map((t) => [t.id, read(t.cwd)])));
}

export async function pollOnce(
  registry: Registry,
  find: typeof discover = discover,
  refresh: (registry: Registry) => void = refreshDriverGit,
): Promise<void> {
  try {
    const sessions = await find();
    registry.applyDiscovery(sessions);
  } catch (err) {
    console.error("[poller] sweep failed:", err);
  }

  // Driver-run sessions are not represented by terminal discovery: any agent subprocesses
  // they own are excluded with the rest of the daemon's subtree. Their filesystem refresh
  // therefore must not depend on terminal discovery succeeding.
  try {
    refresh(registry);
  } catch (err) {
    console.error("[poller] driver Git refresh failed:", err);
  }
}

/**
 * Drive passive discovery on a fixed interval. Each tick sweeps the OS, then
 * reconciles the registry (which emits SSE events for anything that changed).
 * Ticks never overlap: a slow sweep just delays the next one.
 */
export function startPoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // `MISSION_POLL_MS=0` switches passive discovery off entirely - not one sweep, none. The
  // first tick fires immediately, so a check that only skipped the RESCHEDULE would still
  // walk every process on the machine once and card whatever it found, which is the whole
  // thing the off switch exists to prevent.
  const interval = pollIntervalMs();
  if (interval === null) {
    // Off is a FINAL answer about terminal sessions, not a pending one, and it has to be
    // reported as such. Everything gated on `sessionsObserved()` - the workflow engine's
    // start, delivery recovery, binding reconciliation - waits for the first completed
    // sweep so it does not act on a session map that is still filling in; with polling
    // disabled that sweep would never come, and a daemon that could capture workflow
    // submissions but never review them is what actually shipped (found by the browser
    // e2e suite, whose daemon runs with discovery off). An empty COMPLETED sweep is the
    // truthful translation: no terminal session will ever be discovered here, and the
    // eviction loop it drives is scoped to `runtime === "terminal"`, so daemon-owned SDK
    // sessions are untouched by construction.
    registry.applyDiscovery([]);
    return () => {};
  }

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // Refresh after the sweep attempt, so a rediscovered pane-backed session and one the
    // daemon runs itself are both current before the PR poller reads either.
    await pollOnce(registry);
    if (stopped) return;
    timer = unref(setTimeout(tick, interval));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
