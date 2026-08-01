// What is at stake: everything gated on `sessionsObserved()` - the workflow engine's
// start, delivery recovery, binding reconciliation - waits for the first COMPLETED
// discovery sweep. `MISSION_POLL_MS=0` disables sweeping entirely, and before this fix
// that left the gate closed forever: a discovery-off daemon (a container, CI, the e2e
// suite) could capture workflow submissions but never review them, because the engine
// behind them never started. Off must therefore be reported as a final, empty, completed
// sweep rather than as a sweep that has not happened yet.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "poller-discovery-off-"));
process.env.MISSION_HOME = home;
process.env.MISSION_POLL_MS = "0";
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { startPoller } = await import("../src/server/discovery/poller.ts");

test("MISSION_POLL_MS=0 reports discovery as complete instead of never observed", () => {
  const registry = new Registry();
  assert.equal(registry.sessionsObserved(), false, "precondition: nothing has swept yet");

  let observed = false;
  registry.onSessionsObserved(() => (observed = true));
  const stop = startPoller(registry);
  stop();

  // The off switch is an empty FINAL sweep: observers fire, the flag flips, and the
  // session map stays empty - nothing was walked, nothing was carded.
  assert.equal(observed, true, "the sessions_observed gate must open when polling is off");
  assert.equal(registry.sessionsObserved(), true);
  assert.deepEqual(registry.snapshot().sessions, []);
});
