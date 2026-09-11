import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "@playwright/test";

/**
 * V8 coverage of the code the BROWSER runs, sampled so a navigation cannot erase it.
 *
 * A JSX event handler and a dependency-injection adapter execute nowhere else: node's own
 * coverage watches a module render but never a click, so a handler these specs press on every
 * run still reads as unexercised. `scripts/changed-coverage.mjs --browser` maps what this writes
 * back through the built bundle's source map and merges it with the node run.
 *
 * SAMPLED rather than read once at the end, which is the whole reason this exists instead of
 * `page.coverage`. `Profiler.takePreciseCoverage` resets the counters it reports, and a reload
 * throws away the counts of the document it replaced - so a single read at the end returns only
 * what the LAST document did. That is not a small loss: a spec that reloads twice and clicks
 * re-stage in between reported that button as never pressed while passing every assertion about
 * what pressing it did. Counts are therefore drained on a timer and added up, which is exactly
 * how they compose: each read returns what happened since the previous one.
 */
type Range = { startOffset: number; endOffset: number; count: number };

export async function startBrowserCoverage(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  const arm = (): Promise<unknown> =>
    cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  await arm();
  // Re-armed for every document, because counting does not survive one. A reload compiles the
  // bundle again, and V8 hands the new scripts no counters unless precise coverage is switched
  // on for them - so a spec that reloads once and then does its real work would report every
  // handler it pressed afterwards as untouched.
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.executionContextCreated", () => void arm().catch(() => {}));
  // Per script INSTANCE, because a reload compiles the bundle again under a new id and the two
  // are different runs of the same code. Their totals add; their ranges do not overwrite.
  const totals = new Map<string, { url: string; ranges: Map<string, Range> }>();
  const drain = async (): Promise<void> => {
    const { result } = await cdp.send("Profiler.takePreciseCoverage");
    for (const script of result) {
      if (!script.url.includes("/assets/")) continue;
      let entry = totals.get(script.scriptId);
      if (!entry) {
        entry = { url: script.url, ranges: new Map() };
        totals.set(script.scriptId, entry);
      }
      for (const fn of script.functions) {
        for (const range of fn.ranges) {
          const key = `${range.startOffset}:${range.endOffset}`;
          const seen = entry.ranges.get(key);
          if (seen) seen.count += range.count;
          else entry.ranges.set(key, { ...range });
        }
      }
    }
  };
  const timer = setInterval(() => void drain().catch(() => {}), 400);
  return async () => {
    clearInterval(timer);
    try {
      await drain();
      await cdp.detach();
    } catch {
      // A page torn down before the last read still has everything sampled up to that point.
    }
    const dir = process.env.MC_COVERAGE_DIR ?? "/tmp/mc-browser-coverage";
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `coverage-${process.pid}-${randomUUID()}.json`),
      JSON.stringify([...totals.values()].map((entry) => ({
        url: entry.url,
        functions: [{ ranges: [...entry.ranges.values()] }],
      }))),
    );
  };
}
