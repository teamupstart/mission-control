import { POLL_INTERVAL_MS } from "../config.ts";
import type { Registry } from "../registry.ts";
import { unref } from "../util/timers.ts";
import { gitInfo } from "../util/git.ts";
import { discover } from "./correlate.ts";

/**
 * Re-read the live Git facts for every driver-run session's checkout, and adopt them.
 *
 * Runs on the discovery cadence rather than a timer of its own because it answers the same
 * questions the sweep already answers for pane-backed sessions - "what branch is this cwd
 * on now, and is its repository gated by no-mistakes?" - through the same `gitInfo`, which
 * is pure filesystem and explicitly cheap enough to run for every session every poll. One
 * cadence and one reader is what keeps the two runtimes from disagreeing about Git state.
 *
 * Kept out of `applyDiscovery`: that takes what the process sweep found, and widening it to
 * carry sessions no process table can produce is exactly the scope creep its own comments
 * warn off. The registry does the reconciling, this does the reading - the same split
 * `discover()` / `applyDiscovery()` already makes. `read` is injected so a test can drive
 * the real reconciliation with no repository on disk.
 */
export function refreshDriverGit(
  registry: Registry,
  read: (cwd: string) => { branch: string | null; nomistakesGated: boolean } = gitInfo,
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

  // Driver-run sessions have no process on a tty, so their filesystem refresh must not
  // depend on terminal discovery succeeding.
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

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // Refresh after the sweep attempt, so a rediscovered pane-backed session and one the
    // daemon runs itself are both current before the PR poller reads either.
    await pollOnce(registry);
    if (stopped) return;
    timer = unref(setTimeout(tick, POLL_INTERVAL_MS));
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
