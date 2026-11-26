import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Issue #1733: a restart during a session action blocked the run as `session_lost`, the session
 * came back, and the run offered only Cancel once its repair rounds were spent.
 *
 * The daemon now waits out a grace window before blocking and re-checks the action by itself
 * when the session returns, both of which the `node:test` runtime suite drives. What only a
 * browser against a live daemon proves is the operator's half: a run stranded in the block shows
 * a round-free next move, clicking it goes through the real `retry` route, and the page repaints
 * out of the block.
 *
 * The block itself is written behind the daemon, the way `workflow-closed-pr-recheck.spec.ts`
 * seeds its closed gate: reaching it for real takes ten minutes of a session being away. So is
 * the absence: the binding is pointed at a session id the registry does not hold, which is what
 * the daemon sees while a restored session has not come back yet. Everything after that - the
 * recovery projection, the refusal, the automatic re-check and the repaint - is the daemon's.
 */

const EVIDENCE = artifactsDir("workflow-session-lost-recheck");
const PROMPT = "# Open the pull request\n\nPublish the reviewed work.\n";

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/workflow-session-lost-recheck/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface RunDetail {
  run: { status: string; currentPhase: string };
  attempts: Array<{ id: string; nodeId: string; state: string }>;
  deliveries: Array<{ state: string }>;
  events: Array<{ kind: string }>;
}

const detail = (daemon: DaemonHandle, runId: string): Promise<RunDetail> =>
  api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);

/** A Preview run parked on its action with the packet prepared, bound to a live session. */
async function seedWaitingAction(
  page: Page,
  daemon: DaemonHandle,
): Promise<{ runId: string; sessionId: string }> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the lost-session spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle to idle", timeout: 60_000 }).toBe("idle");

  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Open the PR after a restart",
    description: "Publish the reviewed work",
    promptMarkdown: PROMPT,
    completion: { kind: "pull_request" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E lost session recheck",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: "action-node", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "action-node", targetPort: "activate" },
        { id: "e-complete", source: "action-node", sourcePort: "complete", target: "end-node", targetPort: "terminal" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id, sessionId, deliveryMode: "preview", triggerMode: "manual",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "e2e-session-lost-recheck" },
  );
  const runId = submitted.run.id;
  try {
    await expect.poll(async () => {
      const current = await detail(daemon, runId);
      const waiting = current.attempts.some((attempt) => attempt.state === "waiting");
      return `${current.run.status}/${waiting}/${current.deliveries.map((d) => d.state).join(",")}`;
    }, { message: "the action should park with its packet prepared", timeout: 60_000 })
      .toBe("waiting_for_action/true/prepared");
  } catch (caught) {
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return { runId, sessionId };
}

/**
 * Leave the run exactly as `blockSessionActionAttempt` writes a `session_lost` block, with its
 * binding naming `boundSessionId`.
 */
function strandAsSessionLost(daemon: DaemonHandle, runId: string, boundSessionId: string): void {
  const detailText = "The bound session stayed unavailable after this action was sent, so its turn "
    + "could not be observed.";
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    const attempt = db.prepare(
      `SELECT a.id, a.node_id, a.output_json FROM workflow_node_attempts a
         JOIN workflow_submissions s ON s.id = a.submission_id
        WHERE s.run_id = ? AND a.state = 'waiting'`,
    ).get(runId) as { id: string; node_id: string; output_json: string } | undefined;
    if (!attempt) throw new Error(`no waiting action attempt on ${runId}`);
    const state = JSON.parse(attempt.output_json) as Record<string, unknown>;
    db.prepare(
      `UPDATE workflow_bindings SET session_id = ?
        WHERE id = (SELECT binding_id FROM workflow_runs WHERE id = ?)`,
    ).run(boundSessionId, runId);
    db.prepare(
      `UPDATE workflow_node_attempts
          SET state = 'error', output_json = ?, error = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify({ ...state, blocked: { code: "session_lost", detail: detailText } }),
      `session_lost: ${detailText}`, now, now, attempt.id,
    );
    db.prepare(
      `UPDATE workflow_runs SET status = 'blocked', current_phase = 'session_action_blocked',
              gate_state_json = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify({ nodeId: attempt.node_id, attemptId: attempt.id, code: "session_lost", detail: detailText }),
      now, runId,
    );
  });
}

/** Point the run's binding back at the session it was armed on, as a restore would. */
function sessionReturns(daemon: DaemonHandle, runId: string, sessionId: string): void {
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `UPDATE workflow_bindings SET session_id = ?
        WHERE id = (SELECT binding_id FROM workflow_runs WHERE id = ?)`,
    ).run(sessionId, runId);
  });
}

test("a run blocked by a lost session offers a round-free re-check and leaves the block when the session returns", async ({
  dashboard,
  daemon,
}) => {
  const { runId, sessionId } = await seedWaitingAction(dashboard, daemon);
  strandAsSessionLost(daemon, runId, `${sessionId}-not-restored`);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  await expect(header.getByText("Blocked", { exact: true })).toBeVisible();
  const recheck = header.getByRole("button", { name: "Check the action again" });
  await expect(recheck).toBeVisible();
  await expect(recheck).toBeEnabled();
  // The provider-call wording belongs to a different block and must not leak onto this one.
  await expect(header.getByRole("button", { name: "Retry the failed call" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Cancel run" })).toBeVisible();
  // The banner says the block recovers by itself, not that the review is stopped for good.
  const banner = dashboard.getByText("This action stopped because its session was away.", { exact: false });
  await expect(banner.first()).toBeVisible();
  await expect(dashboard.getByText("will not restart on its own")).toHaveCount(0);
  // The action's own sentence says the block recovers by itself and costs no round.
  await expect(dashboard.getByText("It is checked again when the session is running").first()).toBeVisible();
  await dashboard.mouse.move(0, 0);
  await shoot(header, "01-blocked-offers-recheck");

  // The session has not come back yet: the daemon refuses, and says what to do instead.
  await recheck.click();
  await expect(dashboard.getByText("The bound session is not running yet").first()).toBeVisible();
  expect((await detail(daemon, runId)).run.status).toBe("blocked");
  await dashboard.mouse.move(0, 0);
  await shoot(dashboard, "02-recheck-refused-while-away");

  // The session is back. Its next update re-checks the action with nobody clicking anything,
  // and the open page repaints out of the block.
  sessionReturns(daemon, runId, sessionId);
  await expect.poll(async () => (await detail(daemon, runId)).run.status, {
    message: "the returning session should re-check the blocked action",
    timeout: 30_000,
  }).toBe("waiting_for_action");
  await expect(recheck).toHaveCount(0);
  await expect(header.getByText("Blocked", { exact: true })).toHaveCount(0);
  await expect(header).toContainText("Waiting for a session action");
  const after = await detail(daemon, runId);
  expect(after.attempts.filter((attempt) => attempt.state === "waiting")).toHaveLength(1);
  expect(after.events.some((event) => event.kind === "session_action_rechecked")).toBe(true);
  // Preview still typed nothing: the re-check observes, it never re-sends.
  expect(after.deliveries.map((delivery) => delivery.state)).toEqual(["prepared"]);
  await dashboard.mouse.move(0, 0);
  await shoot(header, "03-rechecked-back-to-waiting");
});

/**
 * Spend the run's whole repair budget the way the report found it: round 11 of a cap of 10.
 * The current round is the highest submission round, so the one submission is moved to round
 * 11 and the run's cap set to 10. Written behind the daemon for the reason the block is: eleven
 * real rounds are eleven model reviews.
 */
function exhaustRepairRounds(daemon: DaemonHandle, runId: string): void {
  withDaemonDb(daemon, (db) => {
    db.prepare("UPDATE workflow_submissions SET round = 11 WHERE run_id = ?").run(runId);
    db.prepare("UPDATE workflow_runs SET max_repair_rounds = 10 WHERE id = ?").run(runId);
  });
}

interface RecoveryDetail extends RunDetail {
  summary: {
    round: number;
    maxRepairRounds: number;
    recovery?: { operations: string[]; primary: string | null; resubmit: { refusal: string | null } | null };
  };
  submissions: Array<{ id: string; round: number }>;
}

test("with every repair round spent, a lost-session block still offers Check the action again and costs no round", async ({
  dashboard,
  daemon,
}) => {
  const { runId, sessionId } = await seedWaitingAction(dashboard, daemon);
  strandAsSessionLost(daemon, runId, `${sessionId}-not-restored`);
  exhaustRepairRounds(daemon, runId);

  // The daemon's own answer: no round left to resubmit with, and the re-check offered anyway.
  const before = await api<RecoveryDetail>(daemon, `/api/workflow-runs/${runId}`);
  expect(`${before.summary.round}/${before.summary.maxRepairRounds}`).toBe("11/10");
  expect(before.summary.recovery?.primary).toBe("retry");
  expect(before.summary.recovery?.operations).toContain("retry");
  expect(before.summary.recovery?.resubmit?.refusal).toMatch(/used every repair round/);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  // The header counts rounds, not repairs: a cap of 10 repair rounds is 11 rounds, and this is
  // the last of them.
  await expect(header).toContainText(/round 11 of 11/i);
  await expect(header.getByText("Blocked", { exact: true })).toBeVisible();
  const recheck = header.getByRole("button", { name: "Check the action again" });
  await expect(recheck).toBeVisible();
  await expect(recheck).toBeEnabled();
  await expect(dashboard.getByText("This action stopped because its session was away.", { exact: false }).first()).toBeVisible();
  await dashboard.mouse.move(0, 0);
  await shoot(header, "11-exhausted-offers-recheck");

  // The control reaches its route even with no round left. The session is not back yet, so
  // the daemon answers with its reason rather than a round-limit refusal.
  const retried = dashboard.waitForResponse((r) =>
    r.url().endsWith(`/api/workflow-runs/${encodeURIComponent(runId)}/retry`) && r.request().method() === "POST");
  await recheck.click();
  const response = await retried;
  expect(response.status()).toBe(404);
  expect(((await response.json()) as { code: string }).code).toBe("workflow_session_unavailable");
  await expect(dashboard.getByText("The bound session is not running yet").first()).toBeVisible();
  expect((await api<RecoveryDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status).toBe("blocked");
  await dashboard.mouse.move(0, 0);
  await shoot(dashboard, "12-exhausted-recheck-route-answered");

  // The session returns: the action is re-checked on its own, still in round 11, with no new
  // submission and nothing re-sent.
  sessionReturns(daemon, runId, sessionId);
  await expect.poll(async () => (await api<RecoveryDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: "the returning session should re-check the blocked action",
    timeout: 30_000,
  }).toBe("waiting_for_action");
  await expect(recheck).toHaveCount(0);
  await expect(header).toContainText("Waiting for a session action");
  await expect(header).toContainText(/round 11 of 11/i);
  const after = await api<RecoveryDetail>(daemon, `/api/workflow-runs/${runId}`);
  expect(after.summary.round).toBe(11);
  expect(after.submissions).toHaveLength(1);
  expect(after.deliveries.map((delivery) => delivery.state)).toEqual(["prepared"]);
  expect(after.events.some((event) => event.kind === "session_action_rechecked")).toBe(true);
  await dashboard.mouse.move(0, 0);
  await shoot(header, "13-exhausted-rechecked-still-round-11");
});
