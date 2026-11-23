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
const {
  claimForemanLease, dismissForemanHealthIssues, recordForemanHealth, releaseForemanLease, LEASE_TTL_MS,
} = await import("../src/server/foreman/config.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { FOREMAN_HEALTH_MAX_ISSUES } = await import("../src/shared/foreman-health.ts");
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

test("a dismissed Foreman error stays hidden until it happens again", () => {
  openDb();
  const registry = new Registry();
  const tracker = new ForemanHealthTracker();
  const review = { operation: "review" as const, runner: "codex" as const, model: "test-model" };
  const triage = { operation: "triage" as const, runner: "claude" as const, model: "haiku" };
  claimForemanLease("dismiss-leader", 2000);
  tracker.failure(review, "Usage limit reached", 2001);
  tracker.failure(triage, "Claude Agent SDK one-shot timed out", 2002);
  const publish = (at: number): boolean =>
    recordForemanHealth({ workerId: "dismiss-leader", health: tracker.snapshot() }, at);
  assert.equal(publish(2003), true);
  const shown = (at: number) => foremanStatus(registry, at).health!.issues
    .map(({ id, occurrenceId }) => ({ id, occurrenceId }));
  assert.equal(shown(2004).length, 2);

  assert.equal(dismissForemanHealthIssues([{ id: "not-reported", occurrenceId: "never-reported" }]), 0,
    "only reported groups can be dismissed");
  const triageIssue = foremanStatus(registry, 2004).health!.issues
    .find((issue) => issue.operation === "triage")!;
  const triageId = triageIssue.id;
  const triageSeen = { id: triageId, occurrenceId: triageIssue.occurrenceId };
  assert.equal(dismissForemanHealthIssues([triageSeen]), 1);
  assert.deepEqual(foremanStatus(registry, 2005).health!.issues.map((issue) => issue.operation), ["review"]);
  // A republish of the SAME occurrence (the heartbeat does this) does not bring it back.
  assert.equal(publish(2006), true);
  assert.deepEqual(foremanStatus(registry, 2007).health!.issues.map((issue) => issue.operation), ["review"]);

  // It failing again is news, so it returns with its full history.
  tracker.failure(triage, "Claude Agent SDK one-shot timed out", 2008);
  assert.equal(publish(2009), true);
  const returned = foremanStatus(registry, 2010).health!.issues.find((issue) => issue.id === triageId);
  assert.equal(returned?.count, 2);

  // Dismissing the occurrence the operator saw BEFORE it recurred hides nothing: the newer
  // occurrence landed between display and dismissal, and nobody has read it yet.
  assert.equal(dismissForemanHealthIssues([triageSeen]), 0);
  assert.equal(foremanStatus(registry, 2010).health!.issues.length, 2);

  // A recurrence inside the SAME millisecond leaves `lastSeenAt` unchanged; the occurrence id
  // still moves, and it alone must be enough to keep the unseen occurrence on screen.
  const beforeSameMs = shown(2010);
  tracker.failure(triage, "Claude Agent SDK one-shot timed out", 2008);
  assert.equal(publish(2010), true);
  const sameMs = foremanStatus(registry, 2010).health!.issues.find((issue) => issue.id === triageId)!;
  assert.equal(sameMs.lastSeenAt, 2008);
  assert.equal(sameMs.count, 3);
  assert.equal(dismissForemanHealthIssues(beforeSameMs), 1, "only the unchanged review group hides");
  assert.deepEqual(foremanStatus(registry, 2010).health!.issues.map((issue) => issue.id), [triageId]);
  // Dismissed, then the same millisecond again: the hidden group comes back too.
  assert.equal(dismissForemanHealthIssues(shown(2010)), 1);
  assert.equal(foremanStatus(registry, 2010).health!.issues.length, 0);
  tracker.failure(triage, "Claude Agent SDK one-shot timed out", 2008);
  assert.equal(publish(2010), true);
  assert.deepEqual(foremanStatus(registry, 2010).health!.issues.map((issue) => issue.id), [triageId]);

  assert.equal(dismissForemanHealthIssues(shown(2010)), 1);
  assert.equal(foremanStatus(registry, 2011).health!.issues.length, 0);

  // Recovery retires the group; a later failure under the same id is a new incident.
  tracker.success(review);
  assert.equal(publish(2012), true);
  tracker.failure(review, "Usage limit reached", 2013);
  assert.equal(publish(2014), true);
  assert.deepEqual(foremanStatus(registry, 2015).health!.issues.map((issue) => issue.operation), ["review"]);
  releaseForemanLease("dismiss-leader");
});

test("a capped group failing again inside the same millisecond is still a new occurrence", () => {
  openDb();
  const registry = new Registry();
  claimForemanLease("capped-leader", 4000);
  // `count` at its cap and `lastSeenAt` unchanged: only the occurrence id tells these apart.
  const issue = {
    id: "capped-group", operation: "triage" as const, runner: "claude" as const, model: "haiku",
    error: "Claude Agent SDK one-shot timed out", count: 1_000_000, occurrenceId: "seen",
    firstSeenAt: 4001, lastSeenAt: 4002, sessions: [], sessionsTruncated: false,
  };
  const report = (revision: number, occurrenceId: string) => ({
    workerId: "capped-leader",
    health: { revision, truncated: false, issues: [{ ...issue, occurrenceId }] },
  });
  assert.equal(recordForemanHealth(report(1, "seen"), 4003), true);
  // Recurs after the popover drew it, before the dismissal lands: nothing is hidden.
  assert.equal(recordForemanHealth(report(2, "unseen"), 4004), true);
  assert.equal(dismissForemanHealthIssues([{ id: "capped-group", occurrenceId: "seen" }]), 0);
  assert.equal(foremanStatus(registry, 4005).health!.issues.length, 1);
  // Dismissed, then it recurs identically again: it comes back.
  assert.equal(dismissForemanHealthIssues([{ id: "capped-group", occurrenceId: "unseen" }]), 1);
  assert.equal(foremanStatus(registry, 4006).health!.issues.length, 0);
  assert.equal(recordForemanHealth(report(3, "newer"), 4007), true);
  assert.equal(foremanStatus(registry, 4008).health!.issues.length, 1);
  releaseForemanLease("capped-leader");
});

test("the dismiss route refuses an empty, oversized or unmarked list and accepts the maximum", async () => {
  openDb();
  const registry = new Registry();
  const app = buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks: new TaskManager(registry),
    queues: new QueueManager(registry),
  });
  const tracker = new ForemanHealthTracker();
  claimForemanLease("route-leader", 3000);
  for (let i = 0; i < FOREMAN_HEALTH_MAX_ISSUES; i++) {
    tracker.failure({ operation: "review", runner: "codex", model: `model-${i}` }, `Failure ${i}`, 3001 + i);
  }
  assert.equal(recordForemanHealth({ workerId: "route-leader", health: tracker.snapshot() }, 3100), true);
  const seen = foremanStatus(registry, 3101).health!.issues
    .map(({ id, occurrenceId }) => ({ id, occurrenceId }));
  assert.equal(seen.length, FOREMAN_HEALTH_MAX_ISSUES);
  const dismiss = (body: unknown): Promise<Response> => Promise.resolve(app.request("/api/foreman/health/dismiss", {
    method: "POST",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  const empty = await dismiss({ issues: [] });
  assert.equal(empty.status, 400, "an empty list is refused");
  assert.match(((await empty.json()) as { error: string }).error, /too_small/);
  const oversized = await dismiss({ issues: [...seen, { id: "one-more", occurrenceId: "one-more" }] });
  assert.equal(oversized.status, 400, "a list past the maximum is refused");
  assert.match(((await oversized.json()) as { error: string }).error, /too_big/);
  assert.equal(foremanStatus(registry, 3102).health!.issues.length, FOREMAN_HEALTH_MAX_ISSUES,
    "a refused request dismisses nothing");

  const unmarked = await dismiss({ issues: seen.map(({ id }) => ({ id })) });
  assert.equal(unmarked.status, 400, "a group without the occurrence it acknowledges is refused");
  const timed = await dismiss({ issues: seen.map(({ id }) => ({ id, lastSeenAt: 3100, count: 1 })) });
  assert.equal(timed.status, 400, "a timestamp and count cannot stand in for the occurrence id");

  const maximum = await dismiss({ issues: seen });
  assert.equal(maximum.status, 200);
  assert.deepEqual(await maximum.json(), { dismissed: FOREMAN_HEALTH_MAX_ISSUES });
  assert.equal(foremanStatus(registry, 3103).health!.issues.length, 0);
  releaseForemanLease("route-leader");
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
