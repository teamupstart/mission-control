import { POLL_INTERVAL_MS } from "../config.ts";
import type { Registry } from "../registry.ts";
import { discover } from "./correlate.ts";

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
    } catch (err) {
      console.error("[poller] sweep failed:", err);
    }
    if (stopped) return;
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
