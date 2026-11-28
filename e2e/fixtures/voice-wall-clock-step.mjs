// Only this isolated daemon changes its wall clock. SSE, clock probes and card
// deadlines all read the same clock. Timers and the browser's clock stay monotonic.
import { existsSync } from "node:fs";
import { join } from "node:path";

if (process.env.MISSION_HOME && process.argv[1]?.endsWith("/dist/server/index.mjs")) {
  const marker = join(process.env.MISSION_HOME, "step-voice-clock-back");
  const now = Date.now;
  Date.now = () => {
    if (!existsSync(marker)) return now();
    Date.now = () => now() - 60_000;
    return Date.now();
  };
}
