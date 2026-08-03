import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level end-to-end tests, run separately from `npm test`.
 *
 * Separate on purpose. Everything under `test/` runs against `src/` and must pass on a
 * fresh checkout; this suite drives the BUILT dashboard served by the BUILT daemon, so it
 * needs `npm run build` first. That is the same reason `scripts/smoke-bundles.mjs` is not a
 * `node:test` file, and the same line is drawn here.
 */
export default defineConfig({
  testDir: "./specs",
  // Each spec boots its own daemon on a per-worker port, so files are safe to parallelise;
  // the cost is one daemon process per worker, which is why this is not unbounded.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
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
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
