import { POLL_INTERVAL_MS } from "../config.ts";
import type { Registry } from "../registry.ts";
import { unref } from "../util/timers.ts";
import { gitInfo } from "../util/git.ts";
import { discover } from "./correlate.ts";

/**
 * Re-read the branch every driver-run session's checkout is on, and adopt it.
 *
 * Runs on the discovery cadence rather than a timer of its own because it answers the same
 * question the sweep already answers for pane-backed sessions - "what branch is this cwd on
 * now?" - through the same `gitInfo`, which is pure filesystem and explicitly cheap enough
 * to run for every session every poll. One cadence and one reader is what keeps the two
 * runtimes from disagreeing about a session's branch.
 *
 * Kept out of `applyDiscovery`: that takes what the process sweep found, and widening it to
 * carry sessions no process table can produce is exactly the scope creep its own comments
 * warn off. The registry does the reconciling, this does the reading - the same split
 * `discover()` / `applyDiscovery()` already makes. `read` is injected so a test can drive
 * the real reconciliation with no repository on disk.
 */
export function refreshDriverBranches(
  registry: Registry,
  read: (cwd: string) => string | null = (cwd) => gitInfo(cwd).branch,
): void {
  const targets = registry.driverGitTargets();
  if (targets.length === 0) return;
  registry.applyDriverBranches(new Map(targets.map((t) => [t.id, read(t.cwd)])));
}

/**
 * Drive passive discovery on a fixed interval. Each tick sweeps the OS, then
 * reconciles the registry (which emits SSE events for anything that changed).
 * Ticks never overlap: a slow sweep just delays the next one.
 */
export function startPoller(registry: Registry): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const sessions = await discover();
      registry.applyDiscovery(sessions);
      // After the sweep, so a session that has just been rediscovered on the process table
      // and one the daemon runs itself are both current before the PR poller reads either.
      refreshDriverBranches(registry);
    } catch (err) {
      console.error("[poller] sweep failed:", err);
    }
    if (stopped) return;
    timer = unref(setTimeout(tick, POLL_INTERVAL_MS));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
