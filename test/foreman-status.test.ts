import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionNote } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// Isolate the db in a throwaway home before config.ts resolves the state dir.
const home = mkdtempSync(join(tmpdir(), "mission-fstatus-"));
process.env.HARNESS_HOME = home;
const { openDb, upsertSessionNote } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { foremanStatus } = await import("../src/server/foreman/config.ts");

after(() => rmSync(home, { recursive: true, force: true }));

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

  const { autopilot } = foremanStatus(r);
  const backlog = r.listTasks().filter((t) => t.status === "backlog").length;
  assert.equal(autopilot.disabled, 1);
  assert.equal(autopilot.blocked, 1, "only the item an unmet dependency holds up");
  assert.equal(autopilot.ready, 2, "the free item and the one it waits on");
  assert.equal(autopilot.ready + autopilot.blocked + autopilot.disabled, backlog);
});
