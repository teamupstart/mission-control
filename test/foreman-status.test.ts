import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNote } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { ForemanHealthTracker } from "../src/server/foreman/health.ts";

// Isolate the db in a throwaway home before config.ts resolves the state dir.
const home = mkdtempSync(join(tmpdir(), "mission-fstatus-"));
process.env.HARNESS_HOME = home;
const { openDb, upsertSessionNote } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { foremanStatus } = await import("../src/server/foreman/config.ts");
const { claimForemanLease, recordForemanHealth, releaseForemanLease, LEASE_TTL_MS } =
  await import("../src/server/foreman/config.ts");
const { foremanInstructionsView, updateForemanInstructions } =
  await import("../src/server/foreman/instructions.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("Foreman health is leader-owned, ordered, and separate from liveness", () => {
  openDb();
  const registry = new Registry();
  const tracker = new ForemanHealthTracker();
  const context = { operation: "review" as const, runner: "codex" as const, model: "test-model" };
  claimForemanLease("health-leader", 1000);
  tracker.failure(context, "Usage limit reached", 1001);
  const failed = { workerId: "health-leader", health: tracker.snapshot() };
  assert.equal(recordForemanHealth({ ...failed, workerId: "standby" }, 1002), false);
  assert.equal(recordForemanHealth(failed, 1003), true);
  assert.equal(foremanStatus(registry, 1004).running, true);
  assert.equal(foremanStatus(registry, 1004).health?.issues[0]?.error, "Usage limit reached");
  claimForemanLease("health-leader", 1005);
  assert.equal(foremanStatus(registry, 1006).health?.issues.length, 1, "heartbeats are not recovery");
  assert.equal(foremanStatus(registry, 1006 + LEASE_TTL_MS).health?.current, false);
  tracker.success(context);
  assert.equal(recordForemanHealth({ ...failed, health: tracker.snapshot() }, 1007), true);
  assert.equal(recordForemanHealth(failed, 1008), true, "stale reports are harmless no-ops");
  assert.equal(foremanStatus(registry, 1009).health?.issues.length, 0);
  releaseForemanLease("health-leader");
  assert.equal(recordForemanHealth(failed, 1010), false);
  assert.equal(foremanStatus(registry, 1011).health?.current, false);
  claimForemanLease("successor", 1012);
  assert.equal(recordForemanHealth({ workerId: "successor", health: new ForemanHealthTracker().snapshot() }, 1013), true);
  assert.equal(foremanStatus(registry, 1014).health?.current, true);
  releaseForemanLease("successor");
});

function mkNote(over: Partial<SessionNote> = {}): SessionNote {
  return {
    noteKey: "gone-agent",
    purpose: "long gone",
    brief: null,
    recommendation: null,
    disposition: "answered",
    lastAction: null,
    handledMarker: null,
    updatedAt: 5000,
    ...over,
  };
}

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "n",
    nameSource: "process",
    cwd: "/wt/a",
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

test("foremanStatus counts only notes belonging to currently-live sessions", () => {
  openDb();
  // A note for a session that no longer exists - it rehydrates into a fresh
  // Registry from the DB but has no matching live session.
  upsertSessionNote(mkNote());
  const r = new Registry();
  r.applyDiscovery([mkDiscovered({ syntheticId: "live-1", cwd: "/wt/live" })]);
  const s = r.snapshot().sessions.find((x) => x.id === "live-1")!;
  r.upsertNote(s.id, { purpose: "active draft", disposition: "pending" });

  const status = foremanStatus(r, 10_000);
  assert.equal(status.counts.pending, 1, "the live session's draft is counted");
  assert.equal(status.counts.answered, 0, "the gone session's note is excluded");
  assert.equal(
    status.lastActionAt,
    r.getNote(s.id)!.updatedAt,
    "lastActionAt reflects the live note, not the gone one",
  );
  assert.equal(status.planner.state, "healthy");
  assert.equal(status.planner.runner, status.runner);
  assert.equal(status.planner.model, status.models.backlog.id);
});

test("foremanStatus projects only the standing-guidance source", () => {
  openDb();
  const r = new Registry();
  const reset = updateForemanInstructions({
    expectedEtag: foremanInstructionsView().etag,
    reset: true,
  });
  assert.ok(reset.ok);

  const builtin = foremanStatus(r);
  assert.equal(builtin.instructionsSource, "builtin");
  assert.equal("text" in builtin, false);
  assert.equal("defaultText" in builtin, false);
  assert.equal("etag" in builtin, false);

  const custom = updateForemanInstructions({
    expectedEtag: reset.view.etag,
    text: "Exact custom guidance\r\n",
  });
  assert.ok(custom.ok);
  assert.equal(foremanStatus(r).instructionsSource, "custom");

  const cleared = updateForemanInstructions({ expectedEtag: custom.view.etag, text: "" });
  assert.ok(cleared.ok);
  assert.equal(foremanStatus(r).instructionsSource, "none");

  const restored = updateForemanInstructions({ expectedEtag: cleared.view.etag, reset: true });
  assert.ok(restored.ok);
});


test("the autopilot readout partitions the backlog: ready + blocked + disabled", () => {
  // The three numbers are read as a whole - "5 ready · 2 blocked" is how an operator
  // decides whether a quiet autopilot is stuck or simply out of work - so they have to
  // add up to the backlog. Counting a parked item as blocked was the tempting shortcut
  // (`blocked = backlog - ready` already existed) and it reports a dependency problem
  // nobody can find, on an item whose fix is the switch the operator themselves set.
  openDb();
  const r = new Registry();
  r.upsertTask(mkTask({ id: "auto-dep", title: "Lay the base" }));
  r.upsertTask(mkTask({ id: "auto-ready", title: "Free" }));
  r.upsertTask(
    mkTask({
      id: "auto-blocked",
      title: "Waits",
      dependencies: [
        {
          type: "task",
          taskId: "auto-dep",
          title: "Lay the base",
          sessionId: null,
          episodeId: null,
          agentSessionId: null,
          branch: null,
          prUrl: null,
          selectedAt: 1,
          satisfiedAt: null,
        },
      ],
    }),
  );
  r.upsertTask(mkTask({ id: "auto-off", title: "Parked", enabled: false }));
  r.upsertTask(
    mkTask({
      id: "auto-retry",
      title: "Retry manually",
      error: "git fetch origin failed: Permission denied (publickey)",
    }),
  );

  const { autopilot } = foremanStatus(r);
  const backlog = r.listTasks().filter((t) => t.status === "backlog").length;
  assert.equal(autopilot.disabled, 1);
  assert.equal(autopilot.blocked, 2, "dependency and manual-retry gates are not ready");
  assert.equal(autopilot.ready, 2, "the free item and the one it waits on");
  assert.equal(autopilot.ready + autopilot.blocked + autopilot.disabled, backlog);
});
