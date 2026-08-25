import test from "node:test";
import assert from "node:assert/strict";
import { missingTaskRepoRoots, taskReposAllowlisted } from "@shared/allowlist.ts";
import {
  backlogTaskNotice,
  backlogTrustHold,
  backlogTrustNoticeText,
  backlogTrustSummary,
  type BacklogTrustView,
} from "../src/web/lib/backlog-copy.ts";
import type { TaskRepoEntry } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

const live: BacklogTrustView = {
  enabled: true,
  mode: "live",
  running: true,
  autoBacklog: true,
  repoAllowlist: [],
};

function repoEntry(repoRoot: string): TaskRepoEntry {
  return {
    repoRoot,
    worktreePath: null,
    branch: null,
    provider: null,
    worktreeLeaseId: null,
    baseSha: null,
    prUrl: null,
    prState: null,
    mergedAt: null,
  };
}

test("the shared allowlist owner returns missing task repositories in dispatch order", () => {
  const task = {
    repoRoot: "/work/calendar-buddy/",
    extraRepos: [{ repoRoot: "/work/shared-ui" }, { repoRoot: "/vendor/ledger" }],
  };

  assert.deepEqual(missingTaskRepoRoots(task, ["/work/"]), ["/vendor/ledger"]);
  assert.equal(taskReposAllowlisted(task, ["/work/", "/vendor/ledger/"]), true);
  // A path prefix without a boundary is not consent for a similarly named repository.
  assert.deepEqual(missingTaskRepoRoots(task, ["/work/calendar", "/work/shared-ui"]), [
    "/work/calendar-buddy/",
    "/vendor/ledger",
  ]);
  // An allowlisted nested root covers that repository without widening to its siblings.
  assert.deepEqual(missingTaskRepoRoots(task, ["/work/calendar-buddy", "/vendor/ledger"]), [
    "/work/shared-ui",
  ]);
});

test("the trust hold appears only for live, running, armed autopilot", () => {
  const task = mkTask({ repoRoot: "/repos/calendar-buddy" });
  assert.deepEqual(backlogTrustHold(task, live), ["/repos/calendar-buddy"]);

  const suppressed: Array<BacklogTrustView | null> = [
    null,
    { ...live, enabled: false },
    { ...live, mode: "dry-run" },
    { ...live, mode: "semi-auto" },
    { ...live, running: false },
    { ...live, autoBacklog: false },
  ];
  for (const view of suppressed) assert.equal(backlogTrustHold(task, view), null);
  assert.equal(backlogTrustHold(task, { ...live, repoAllowlist: ["/repos/"] }), null);
});

test("parked, failed-to-launch, non-backlog, and non-automatable tasks keep their own explanation", () => {
  assert.equal(backlogTrustHold(mkTask({ enabled: false }), live), null);
  assert.equal(backlogTrustHold(mkTask({ error: "Dispatch failed before an agent started" }), live), null);
  assert.equal(backlogTrustHold(mkTask({ status: "running" }), live), null);
  assert.equal(backlogTrustHold(mkTask({ kind: "chat" }), live), null);
  assert.equal(backlogTrustHold(mkTask({ kind: "pipeline" }), live), null);
});

test("dependencies coexist with trust, and multi-repo holds name only missing grants", () => {
  const task = mkTask({
    repoRoot: "/repos/calendar-buddy",
    dependencies: [{
      type: "task",
      taskId: "phase-1",
      title: "Phase 1",
      sessionId: null,
      episodeId: null,
      agentSessionId: null,
      branch: null,
      prUrl: null,
      selectedAt: null,
      satisfiedAt: null,
    }],
    extraRepos: [
      repoEntry("/repos/shared-ui"),
      repoEntry("/vendor/ledger"),
    ],
  });
  assert.deepEqual(
    backlogTrustHold(task, { ...live, repoAllowlist: ["/repos/calendar-buddy", "/vendor"] }),
    ["/repos/shared-ui"],
  );
});

test("trust copy is singular, plural, and stable across surfaces", () => {
  const one = ["/work/calendar-buddy"];
  const many = ["/work/calendar-buddy", "/vendor/shared-ui", "/elsewhere/ledger"];
  assert.equal(backlogTrustSummary(one), "calendar-buddy is not trusted for Foreman");
  assert.equal(
    backlogTrustNoticeText(one),
    "Autopilot cannot schedule this task: calendar-buddy is not trusted for Foreman. Manual launch still works.",
  );
  assert.equal(
    backlogTrustSummary(many),
    "calendar-buddy, shared-ui, and ledger are not trusted for Foreman",
  );
  assert.equal(backlogTrustNoticeText(many),
    "Autopilot cannot schedule this task: calendar-buddy, shared-ui, and ledger are not trusted for Foreman. Manual launch still works.");
});

test("persisted task errors win the one task-notification slot", () => {
  const errorTask = mkTask({
    repoRoot: "/repos/calendar-buddy",
    error: "Dispatch stopped before an agent started",
  });
  assert.deepEqual(backlogTaskNotice(errorTask, live), {
    kind: "error",
    message: "Dispatch stopped before an agent started",
    missingRoots: null,
  });

  const trustTask = mkTask({ repoRoot: "/repos/calendar-buddy" });
  assert.deepEqual(backlogTaskNotice(trustTask, live), {
    kind: "trust",
    message: "Autopilot cannot schedule this task: calendar-buddy is not trusted for Foreman. Manual launch still works.",
    missingRoots: ["/repos/calendar-buddy"],
  });
});
