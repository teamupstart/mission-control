import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportPanel } from "../src/web/components/ReportPanel.tsx";
import { TASK_WORKTREE_RETENTION_DAYS } from "../src/shared/types.ts";
import type { Task, TaskRepoEntry } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

/**
 * What Recent outcomes says about a task that still holds a checkout.
 *
 * Three separate promises live in this markup and each of them was wrong before this phase:
 *
 *  - **Clean up reaches every survivor.** The control was gated on the PRIMARY worktree path,
 *    so a task whose primary tree was released and whose attached repository's tree is still
 *    on disk had no cleanup affordance at all - and, since the same primary-only reading kept
 *    it out of memory and out of restart reconciliation, no other way back either.
 *  - **Retry is only offered to a task with nothing left.** Under the same primary-only
 *    reading, that half-released task was also offered Retry, which re-dispatches onto a
 *    checkout the previous attempt still holds.
 *  - **The policy is stated where the choice is made.** Cleanup is now automatic after 30
 *    inactive days, and an operator deciding whether to click Clean up should not have to
 *    read the docs to learn that leaving it alone is also a decision.
 *
 * And one thing that must NOT happen: a maintenance retry replacing the task's own outcome or
 * failure reason, which is the only account of what the run produced.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

const noop = (): void => {};

const attached = (worktreePath: string | null): TaskRepoEntry => ({
  repoRoot: "/repo/attached",
  worktreePath,
  branch: "b",
  provider: "git",
  worktreeLeaseId: null,
  baseSha: null,
  prUrl: null,
  prState: null,
  mergedAt: null,
});

function panel(tasks: Task[]): string {
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(ReportPanel, {
        sessions: [],
        tasks,
        backlogPlan: null,
        onClose: noop,
        onOpenReviews: noop,
        onEditTask: noop,
      }),
    ),
  );
}

test("an attached-only survivor still offers Clean up and is not offered Retry", () => {
  const html = panel([
    mkTask({
      id: "attached-only",
      title: "Half released",
      status: "failed",
      error: "the second repository would not release",
      worktreePath: null,
      provider: null,
      extraRepos: [attached("/pool/attached/1")],
      completedAt: 5,
    }),
  ]);
  assert.ok(html.includes("Clean up"), "the survivor can still be reclaimed by hand");
  assert.ok(
    !html.includes(">Retry<"),
    "a task still holding an attached checkout is not resource-free",
  );
});

test("a task whose home outlived its last checkout offers Clean up, never Retry", () => {
  // The shape an unfinished cleanup leaves: every tree came back, the terminal home did not.
  // `taskHasWorktrees` is false here, so gating Retry on it would offer to re-dispatch a task
  // that still owns a resource - and start a reschedule against a cleanup still retrying.
  const html = panel([
    mkTask({
      id: "home-survivor",
      title: "Home survived",
      status: "failed",
      error: "the agent gave up",
      worktreePath: null,
      provider: null,
      extraRepos: [attached(null)],
      homeName: "mission-home-1",
      terminalResourceId: "term-1",
      automaticCleanup: {
        state: "retrying",
        detail: "the terminal home would not stop",
        retryAt: 9,
      },
      completedAt: 5,
    }),
  ]);
  assert.ok(
    !html.includes(">Retry<"),
    "a task still holding a terminal home is not resource-free",
  );
  assert.ok(html.includes("Clean up"), "and the operator is left a way to release it by hand");
});

test("a fully released failed task is offered Retry and no cleanup", () => {
  const html = panel([
    mkTask({
      id: "clean-failure",
      title: "Cleanly failed",
      status: "failed",
      error: "the agent gave up",
      worktreePath: null,
      provider: null,
      extraRepos: [attached(null)],
      completedAt: 5,
    }),
  ]);
  assert.ok(html.includes(">Retry<"));
  assert.ok(!html.includes("Clean up"), "there is nothing left to clean up");
});

test("the cleanup control states the retention policy in words", () => {
  const html = panel([
    mkTask({ id: "policy", title: "Held", status: "done", worktreePath: "/pool/held", completedAt: 5 }),
  ]);
  assert.ok(
    html.includes(`removed automatically after ${TASK_WORKTREE_RETENTION_DAYS} days without a change`),
    "the operator is told that leaving it alone is also a decision",
  );
});

test("a retrying automatic cleanup explains itself without touching outcome or error", () => {
  const html = panel([
    mkTask({
      id: "retrying",
      title: "Shipped but stuck",
      status: "done",
      outcome: "opened PR #7",
      worktreePath: "/pool/stuck",
      completedAt: 5,
      automaticCleanup: {
        state: "retrying",
        retryAt: 1_800_000_000_000,
        detail: "could not release this task's resources (EACCES)",
      },
    }),
    mkTask({
      id: "retrying-failed",
      title: "Failed and stuck",
      status: "failed",
      error: "the agent ran out of budget",
      worktreePath: "/pool/stuck-2",
      completedAt: 6,
      automaticCleanup: { state: "retrying", retryAt: null, detail: null },
    }),
  ]);
  assert.ok(html.includes("automatic cleanup is retrying"));
  assert.ok(html.includes("could not release this task&#x27;s resources (EACCES)"));
  assert.ok(html.includes("opened PR #7"), "the task's own outcome is still its own");
  assert.ok(html.includes("the agent ran out of budget"), "and so is its failure reason");
});

test("an ordinary task says nothing about automatic cleanup", () => {
  const html = panel([
    mkTask({ id: "quiet", title: "Quiet", status: "done", worktreePath: "/pool/quiet", completedAt: 5 }),
  ]);
  assert.ok(!html.includes("automatic cleanup"), "null is the ordinary case and it is silent");
});
