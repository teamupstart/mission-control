import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";

// `instrumented` vs `hooksSeen`: a freshness window vs an installation fact.
//
// They look interchangeable, and conflating them cost a whole batch of work. Only
// a hook refreshes the overlay, so a healthy instrumented session that goes quiet -
// which is exactly what an agent parked waiting on a human IS - ages out and rebuilds
// as `instrumented: false`. Anything that reads that as "the integrations aren't
// installed" fires on the most ordinary state the work queue has.

const home = mkdtempSync(join(tmpdir(), "fleet-hooks-seen-"));
process.env.FLEET_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

/** Longer than the registry's OVERLAY_TTL_MS (30 min), which is deliberately private. */
const PAST_THE_TTL = 31 * 60 * 1000;

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%1" },
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

test("a session that has never reported a hook has neither flag", () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "bare-1" })]);
  const s = registry.getSession("bare-1");
  assert.equal(s?.instrumented, false);
  assert.equal(s?.hooksSeen, false, "no hook has ever arrived - the integrations really are absent");
});

test("a hook sets both flags", () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "hooked-1" })]);
  registry.applyHook({
    event: "Stop",
    sessionId: "agent-1",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%1" },
  });
  const s = registry.getSession("hooked-1");
  assert.equal(s?.instrumented, true);
  assert.equal(s?.hooksSeen, true);
});

test("going QUIET past the overlay TTL clears `instrumented` but never `hooksSeen`", async (t) => {
  // The bug, isolated. Half an hour of silence is not an uninstall.
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });

  const registry = new Registry();
  const d = mkDiscovered({ syntheticId: "quiet-1", tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%9" } });
  registry.applyDiscovery([d]);
  registry.applyHook({
    event: "Stop",
    sessionId: "agent-9",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%9" },
  });
  assert.equal(registry.getSession("quiet-1")?.instrumented, true);

  // Nobody types. No hook fires. The overlay ages out.
  t.mock.timers.tick(PAST_THE_TTL);
  registry.applyDiscovery([d]);

  const s = registry.getSession("quiet-1");
  assert.equal(s?.instrumented, false, "the overlay is stale - hook-sourced state is no longer current");
  assert.equal(s?.hooksSeen, true, "but the integrations are still installed, and still working");
});

test("`hooksSeen` survives a daemon RESTART - overlays don't, and that's the point", () => {
  // Overlays are in-memory, so on restart a live, healthy, quiet, hook-instrumented
  // session is indistinguishable from one with no integrations at all - and every
  // rule that punishes the latter would fire on the former. The hook is on record in
  // `session_events`, keyed by the synthetic id (tty+pid+start), which is stable for
  // the same agent process across a restart.
  const first = new Registry();
  const d = mkDiscovered({ syntheticId: "restart-1", tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%7" } });
  first.applyDiscovery([d]);
  first.applyHook({
    event: "Stop",
    sessionId: "agent-7",
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: "%7" },
  });
  assert.equal(first.getSession("restart-1")?.hooksSeen, true);

  // The daemon restarts: a brand-new Registry, an empty overlay map.
  const restarted = new Registry();
  restarted.applyDiscovery([d]);
  const s = restarted.getSession("restart-1");
  assert.equal(s?.instrumented, false, "no overlay survived the restart");
  assert.equal(s?.hooksSeen, true, "read back from the DB - this session has hooks");

  // And a session that never reported one is still correctly bare after a restart.
  restarted.applyDiscovery([d, mkDiscovered({ syntheticId: "restart-bare", pid: 2, tty: "ttys2" })]);
  assert.equal(restarted.getSession("restart-bare")?.hooksSeen, false);
});
