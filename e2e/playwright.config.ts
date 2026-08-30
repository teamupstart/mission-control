import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

/**
 * Browser-level end-to-end tests, run separately from `npm test`.
 *
 * Separate on purpose. Everything under `test/` runs against `src/` and must pass on a
 * fresh checkout; this suite drives the BUILT dashboard served by the BUILT daemon, so it
 * needs `npm run build` first. That is the same reason `scripts/smoke-bundles.mjs` is not a
 * `node:test` file, and the same line is drawn here.
 */
export default defineConfig({
  // Keep these anchored to this file so the same config is safe when it is re-exported by
  // the repository-root entrypoint used by bare `playwright test` commands.
  testDir: fileURLToPath(new URL("./specs", import.meta.url)),
  // One user-scoped host lease is acquired before Playwright starts workers. Linked
  // worktrees therefore queue full or focused runs instead of multiplying this cap.
  globalSetup: fileURLToPath(new URL("./global-setup.ts", import.meta.url)),
  // Each spec boots its own daemon on a per-worker port, so files are safe to parallelise;
  // the cost is one daemon process per worker, which is why this is not unbounded.
  fullyParallel: true,
  // CI and local runs use four workers. In CI that matches each selected 4-core runner;
  // increasing shards provides parallelism without oversubscribing any one machine.
  workers: 4,
  // A dispatch waits on a real subprocess launching, so the default 30s is tight on a cold
  // CI runner. Two minutes leaves room for a loaded runner while a real hang still fails.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    // Traces are most of the reason this suite uses @playwright/test rather than driving
    // playwright-core from node:test. On a failure this is the difference between a number
    // and a replayable recording of what the browser did.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Off, not `retain-on-failure`. Both settings record every test and throw the
    // recording away when it passes, so a green run pays for artifacts nobody reads -
    // measured on a CI shard, trace costs 24s and video costs a further 16s of a 126s
    // run. Trace earns its 24s for the reason above. Video does not: it shows what a
    // trace already shows, with less of it, and the trace viewer replays the same frames.
    //
    // The alternative was `on-first-retry` for both, which is 6s cheaper still and was
    // rejected: with `retries: 1`, it captures nothing for the attempt that actually
    // failed, and a flake that passes on retry is exactly the case this suite has needed
    // to diagnose before.
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
