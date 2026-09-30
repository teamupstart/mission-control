import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Every member of a run's stage, and the stage itself, says how long it ran.
 *
 * The clock counts from the moment the round launched the member and freezes the moment it
 * settles, so an operator can read off which component a round spent its time in. The
 * Command below really runs and blocks on a file this spec controls, which is the only way to
 * watch a clock tick live and then watch it stop - a command that finished before the page
 * loaded would prove only the frozen half.
 *
 * No model tokens: the Persona is answered by the fake agent, and the Command is `sh`.
 */

const NODE = {
  session: "session-node",
  check: "check-node",
  persona: "persona-node",
  join: "join-node",
  end: "end-node",
};
const REVIEWER = "E2E clocked reviewer";
const EVIDENCE = "e2e/.artifacts/workflow-elapsed-clock/";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the elapsed clock spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    }, { message: "the dispatched session should settle before evidence capture" })
    .toBe("idle");
  return sessionId;
}

/** One stage: a `test` Command that holds until `gate` exists, beside a passing Persona. */
async function seedRun(page: Page, daemon: DaemonHandle, gate: string): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    checksEnabled: true,
    repoAllowlist: [daemon.repo],
    defaultWorkflowId: null,
    checkCommands: [{
      repoRoot: daemon.repo,
      slot: "test",
      command: ["sh", "-c", `while [ ! -f '${gate}' ]; do sleep 0.2; done`],
    }],
  }, "PUT");

  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: REVIEWER,
    guidanceMarkdown: `# ${REVIEWER}\n\nE2E_PASS_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E elapsed clock",
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.check, kind: "check", slot: "test", position: { x: 220, y: 0 } },
        { id: NODE.persona, kind: "persona", personaId: persona.id, position: { x: 220, y: 140 } },
        { id: NODE.join, kind: "all_pass", position: { x: 440, y: 70 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 660, y: 70 } },
      ],
      edges: [
        { id: "e-check", source: NODE.session, sourcePort: "submitted", target: NODE.check, targetPort: "activate" },
        { id: "e-persona", source: NODE.session, sourcePort: "submitted", target: NODE.persona, targetPort: "activate" },
        { id: "e-check-pass", source: NODE.check, sourcePort: "pass", target: NODE.join, targetPort: "result" },
        { id: "e-check-fail", source: NODE.check, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        { id: "e-persona-pass", source: NODE.persona, sourcePort: "pass", target: NODE.join, targetPort: "result" },
        { id: "e-persona-fail", source: NODE.persona, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        { id: "e-join-pass", source: NODE.join, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
        { id: "e-join-fail", source: NODE.join, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-elapsed-clock" },
  );
  return submitted.run.id;
}

/** Whole seconds a clock's visible text reads: "7s" -> 7, "1m 04s" -> 64. */
function seconds(text: string): number {
  const match = /^(?:(\d+)m )?(\d+)s$/.exec(text.trim());
  if (!match) throw new Error(`not a clock reading: ${JSON.stringify(text)}`);
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

test("each member and its stage show a live clock that freezes when it finishes", async ({
  dashboard,
  daemon,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), "mc-e2e-clock-"));
  const gate = join(scratch, "release");
  try {
    const runId = await seedRun(dashboard, daemon, gate);
    await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

    const strip = dashboard.locator(".wf-pipeline-strip");
    const command = strip.locator("li.wf-pipeline-reviewer.is-check");
    const reviewer = strip.locator("li.wf-pipeline-reviewer").filter({ hasText: REVIEWER });
    const stageHead = strip.locator(".wf-pipeline-stage-head");
    const commandClock = command.locator(".wf-pipeline-elapsed");
    const reviewerClock = reviewer.locator(".wf-pipeline-elapsed");
    const stageClock = stageHead.locator(".wf-pipeline-elapsed");

    // The Command is blocked on the gate, so it is running and its clock is live - and the
    // stage it holds open is live with it.
    await expect(command.locator(".wf-pipeline-status")).toHaveText("Running", { timeout: 40_000 });
    await expect(commandClock).toHaveClass(/is-live/);
    await expect(commandClock).toContainText("Running for");
    await expect(stageClock).toHaveClass(/is-live/);

    // The Persona settles on its own while the Command is still going: its clock freezes and
    // says what it took, even though the stage around it is still counting.
    await expect(reviewer.locator(".wf-pipeline-status")).toHaveText("Passed", { timeout: 40_000 });
    await expect(reviewerClock).toHaveClass(/is-frozen/);
    await expect(reviewerClock).toContainText("Took");
    await expect(stageClock).toHaveClass(/is-live/);

    // Live means it ticks. Read the visible time and wait for it to move forward.
    const commandTime = commandClock.locator("time");
    const before = seconds(await commandTime.innerText());
    await expect.poll(async () => seconds(await commandTime.innerText()), {
      message: "a running member's clock should advance",
      timeout: 5_000,
    }).toBeGreaterThan(before);

    if (process.env.MC_E2E_EVIDENCE === "1") {
      mkdirSync(EVIDENCE, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await strip.locator(".wf-pipeline-stage").screenshot({ path: `${EVIDENCE}01-running.png` });
      // eslint-disable-next-line no-console
      console.log(`CAPTURED ${EVIDENCE}01-running.png`);
    }

    // Release the Command. It passes, and every clock in the stage freezes.
    writeFileSync(gate, "");
    await expect(command.locator(".wf-pipeline-status")).toHaveText("Passed", { timeout: 40_000 });
    await expect(commandClock).toHaveClass(/is-frozen/);
    await expect(commandClock).toContainText("Took");
    await expect(stageClock).toHaveClass(/is-frozen/);
    await expect(strip.locator(".wf-pipeline-elapsed.is-live")).toHaveCount(0);

    // Frozen means it stays put: the reading does not move across more than two ticks.
    const frozen = await commandTime.innerText();
    const frozenStage = await stageClock.locator("time").innerText();
    expect(seconds(frozen)).toBeGreaterThanOrEqual(before);
    await dashboard.waitForTimeout(2_500);
    await expect(commandTime).toHaveText(frozen);
    await expect(stageClock.locator("time")).toHaveText(frozenStage);
    // The stage ran from its first launch to its last finish, so it is at least as long as
    // the slowest member it contains.
    expect(seconds(frozenStage)).toBeGreaterThanOrEqual(seconds(frozen));

    if (process.env.MC_E2E_EVIDENCE === "1") {
      await dashboard.mouse.move(0, 0);
      await strip.locator(".wf-pipeline-stage").screenshot({ path: `${EVIDENCE}02-finished.png` });
      // eslint-disable-next-line no-console
      console.log(`CAPTURED ${EVIDENCE}02-finished.png`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * `Session -> session action -> End`, delivered live into the dispatched session.
 *
 * The action's Markdown carries the fake agent's hold marker, so the session keeps the action's
 * turn open until this spec writes the release file. That is what makes the WAITING half
 * observable at all: an ordinary fake turn settles before the page could read a ticking clock.
 */
async function seedActionRun(page: Page, daemon: DaemonHandle): Promise<{ runId: string; actionName: string }> {
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");
  const sessionId = await dispatch(page, daemon);
  const actionName = "E2E clocked action";
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: actionName,
    description: "Holds its turn until the spec releases it",
    promptMarkdown: "# Clocked action\n\nE2E_HOLD_TURN_UNTIL_RELEASED\n",
    completion: { kind: "session_turn" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E elapsed clock action",
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: "action-node", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: NODE.session, sourcePort: "submitted", target: "action-node", targetPort: "activate" },
        { id: "e-complete", source: "action-node", sourcePort: "complete", target: NODE.end, targetPort: "terminal" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "live",
    triggerMode: "manual",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-elapsed-clock-action" },
  );
  return { runId: submitted.run.id, actionName };
}

test("a session action's clock ticks while it waits and freezes when it completes", async ({
  dashboard,
  daemon,
}) => {
  const { runId, actionName } = await seedActionRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const strip = dashboard.locator(".wf-pipeline-strip");
  const action = strip.locator("li.wf-pipeline-reviewer.is-session_action").filter({ hasText: actionName });
  const actionClock = action.locator(".wf-pipeline-elapsed");
  const actionTime = actionClock.locator("time");
  // `has` matches INSIDE each stage, so its locator must not be rooted at the strip above it.
  const actionStage = strip.locator(".wf-pipeline-stage").filter({
    has: dashboard.locator("li.wf-pipeline-reviewer.is-session_action", { hasText: actionName }),
  });
  const stageClock = actionStage.locator(".wf-pipeline-stage-head .wf-pipeline-elapsed");

  // The action is waiting on the session's held turn: not a verdict, not done, and counting.
  await expect(actionClock).toHaveClass(/is-live/, { timeout: 60_000 });
  await expect(actionClock).toContainText("Running for");
  await expect(stageClock).toHaveClass(/is-live/);
  await expect(action.locator(".wf-pipeline-status")).not.toHaveText("Complete");
  const before = seconds(await actionTime.innerText());
  await expect.poll(async () => seconds(await actionTime.innerText()), {
    message: "a waiting action's clock should advance",
    timeout: 5_000,
  }).toBeGreaterThan(before);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await actionStage.screenshot({ path: `${EVIDENCE}03-action-waiting.png` });
    // eslint-disable-next-line no-console
    console.log(`CAPTURED ${EVIDENCE}03-action-waiting.png`);
  }

  // Release the session's turn. The action completes, the run continues on a fresh segment,
  // and the action's clock - carried onto that segment with its status - is frozen.
  writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  await expect(action.locator(".wf-pipeline-status")).toHaveText("Complete", { timeout: 120_000 });
  await expect(actionClock).toHaveClass(/is-frozen/);
  await expect(actionClock).toContainText("Took");
  await expect(stageClock).toHaveClass(/is-frozen/);

  const frozen = await actionTime.innerText();
  expect(seconds(frozen)).toBeGreaterThanOrEqual(before);
  await dashboard.waitForTimeout(2_500);
  await expect(actionTime).toHaveText(frozen);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    await dashboard.mouse.move(0, 0);
    await actionStage.screenshot({ path: `${EVIDENCE}04-action-complete.png` });
    // eslint-disable-next-line no-console
    console.log(`CAPTURED ${EVIDENCE}04-action-complete.png`);
  }
});
