import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isProviderOwnedTask, lostTasks } from "../src/shared/session.ts";
import { LostTasksControl, LostTasksPanel, lostTasksCopy } from "../src/web/components/LostTasksControl.tsx";
import { lostTaskDetail } from "../src/web/components/ReportPanel.tsx";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";

/**
 * What is at stake: the fleet pulse's `lost` segment is an alarm, and Sitrep's Lost tasks
 * section is where it sends the operator. Both read `lostTasks`, so a Pipeline run that is
 * sessionless by design must never count, and the card the segment opens must carry a real
 * Open Sitrep button rather than only naming the shortcut.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

const conductorRun = { provider: "ai-conductor" as const, repoRoot: "/repo", slug: "run-1" };

test("lostTasks keeps sessionless running tasks and leaves provider-owned runs out", () => {
  const tasks = [
    mkTask({ id: "null", status: "running", sessionId: null, dispatchedAt: 2 }),
    mkTask({ id: "gone", status: "running", sessionId: "missing", dispatchedAt: 1 }),
    mkTask({ id: "live", status: "running", sessionId: "live" }),
    mkTask({ id: "run", kind: "pipeline", status: "running", sessionId: null, pipelineRun: conductorRun }),
    mkTask({ id: "commissioned", kind: "pipeline", status: "running", sessionId: null, pipelineCommissionId: "c1" as never }),
    mkTask({ id: "launching", status: "dispatching", sessionId: null }),
  ];
  assert.deepEqual(lostTasks(tasks, [mkSession({ id: "live" })]).map((t) => t.id), ["gone", "null"]);
});

test("isProviderOwnedTask reads either Pipeline link", () => {
  assert.equal(isProviderOwnedTask({ pipelineRun: null, pipelineCommissionId: null }), false);
  assert.equal(isProviderOwnedTask({ pipelineRun: null }), false);
  assert.equal(isProviderOwnedTask({ pipelineRun: conductorRun, pipelineCommissionId: null }), true);
  assert.equal(isProviderOwnedTask({ pipelineRun: null, pipelineCommissionId: "c1" as never }), true);
});

test("the copy agrees with the count", () => {
  assert.equal(lostTasksCopy(1).headline, "1 task is running with no session");
  assert.equal(lostTasksCopy(1).trigger, "1 lost task - running with no session");
  assert.match(lostTasksCopy(1).body, /Its agent session ended without closing it/);
  assert.equal(lostTasksCopy(3).headline, "3 tasks are running with no session");
  assert.equal(lostTasksCopy(3).trigger, "3 lost tasks - running with no session");
  assert.match(lostTasksCopy(3).body, /Review and cancel them in Sitrep\./);
});

test("the pulse segment is a collapsed trigger that names the count", () => {
  const html = renderToStaticMarkup(createElement(LostTasksControl, { count: 2, onOpenSitrep: () => {} }));
  assert.match(html, /aria-label="2 lost tasks - running with no session"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /class="pulse-n">2</);
  assert.match(html, />lost</);
  // Closed by default: the card only appears once the segment is clicked.
  assert.doesNotMatch(html, /Open Sitrep/);
});

test("the card explains the state and carries an Open Sitrep button", () => {
  const html = renderToStaticMarkup(createElement(LostTasksPanel, { count: 2, onOpenSitrep: () => {} }));
  assert.match(html, /role="dialog" aria-label="Lost tasks"/);
  assert.match(html, /2 tasks are running with no session/);
  assert.match(html, /<button[^>]*class="btn btn-primary lost-pop-open"[^>]*>Open Sitrep/);
});

test("a lost row says why, how long ago, and whether a worktree is held", () => {
  const now = 10 * 86_400_000;
  const held = mkTask({ status: "running", sessionId: null, dispatchedAt: now - 5 * 86_400_000, worktreePath: "/w/t", repoRoot: "/repo" });
  assert.equal(lostTaskDetail(held, now), "No session attached · dispatched 5d ago · holds a worktree");
  const bare = mkTask({ status: "running", sessionId: null, dispatchedAt: null, createdAt: now - 3_600_000, worktreePath: null, homeName: null });
  assert.equal(lostTaskDetail(bare, now), "No session attached · dispatched 1h ago");
});
