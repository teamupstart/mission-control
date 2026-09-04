import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The dashboard symptom from the reported run, through the real built daemon.
 *
 * Round 1 spends the affected workflow's one `test` Command run and then parks on a
 * Persona objection. A second workflow starts real `build` and `lint` processes that hold
 * both shared Command slots. The operator opens repair round 2 from the run page while those
 * processes are still alive. Since `test` can only become `budget_spent`, it must render as
 * Skipped immediately instead of sitting at Queued until an execution slot opens.
 *
 * No model tokens: the Persona is answered by the fake agent, and every Command is `sh`.
 */

const EVIDENCE = artifactsDir("workflow-spent-check-queue");
const AFFECTED = {
  session: "affected-session",
  check: "affected-test",
  persona: "affected-persona",
  join: "affected-join",
  end: "affected-end",
};
const BLOCKER = {
  session: "blocker-session",
  build: "blocker-build",
  lint: "blocker-lint",
  join: "blocker-join",
  end: "blocker-end",
};

interface RunDetail {
  run: { status: string };
  summary: { round: number };
  submissions: Array<{ id: string; round: number }>;
  attempts: Array<{
    submissionId: string;
    nodeId: string;
    state: string;
    output: unknown;
  }>;
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Dispatch through the same modal an operator uses and return only the new idle session. */
async function dispatch(page: Page, daemon: DaemonHandle, task: string): Promise<string> {
  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((session) => session.id),
  );
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const created = sessions.find((session) => !before.has(session.id));
    sessionId = created?.id ?? "";
    return created?.state ?? "";
  }, { message: `${task} should settle before its workflow is bound` }).toBe("idle");
  return sessionId;
}

async function publish(
  daemon: DaemonHandle,
  name: string,
  draft: Record<string, unknown>,
): Promise<string> {
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name,
    draft,
  });
  return (await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  )).version.id;
}

async function submit(
  daemon: DaemonHandle,
  workflowVersionId: string,
  sessionId: string,
  requestId: string,
): Promise<string> {
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId,
    sessionId,
    deliveryMode: "preview",
    maxRepairRounds: 3,
  });
  return (await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId },
  )).run.id;
}

async function shoot(page: Page, observed: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  const seen = (await observed.innerText()).split("\n").map((line) => `  | ${line}`).join("\n");
  // eslint-disable-next-line no-console
  console.log(
    `CAPTURED e2e/.artifacts/workflow-spent-check-queue/${name}.png\n`
    + `OBSERVED ${name}, as the browser rendered it while both other Commands were running:\n${seen}`,
  );
}

test("a spent repair-round Command skips while both execution slots are occupied", async ({
  dashboard,
  daemon,
}) => {
  const release = join(daemon.home, "release-blocking-commands");
  const buildStarted = join(daemon.home, "build-command-started");
  const lintStarted = join(daemon.home, "lint-command-started");
  const waitCommand = (started: string): string[] => [
    "sh",
    "-c",
    "touch \"$1\"; while [ ! -f \"$2\" ]; do sleep 0.05; done",
    "blocking-command",
    started,
    release,
  ];

  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    checksEnabled: true,
    repoAllowlist: [daemon.repo],
    defaultWorkflowId: null,
    checkCommands: [
      { repoRoot: daemon.repo, slot: "test", command: ["sh", "-c", "printf 'test passed\\n'"] },
      { repoRoot: daemon.repo, slot: "build", command: waitCommand(buildStarted) },
      { repoRoot: daemon.repo, slot: "lint", command: waitCommand(lintStarted) },
    ],
  }, "PUT");

  const affectedSession = await dispatch(
    dashboard,
    daemon,
    "hold the workflow whose spent check must not queue",
  );
  const reviewer = await api<{ id: string }>(daemon, "/api/personas", {
    name: "E2E repair reviewer",
    guidanceMarkdown: "# E2E repair reviewer\n\nE2E_FAIL_VERDICT",
  });
  const affectedVersion = await publish(daemon, "E2E spent Command queue", {
    nodes: [
      { id: AFFECTED.session, kind: "session", position: { x: 0, y: 0 } },
      { id: AFFECTED.check, kind: "check", slot: "test", position: { x: 220, y: 0 } },
      {
        id: AFFECTED.persona,
        kind: "persona",
        personaId: reviewer.id,
        position: { x: 220, y: 140 },
      },
      { id: AFFECTED.join, kind: "all_pass", position: { x: 440, y: 70 } },
      { id: AFFECTED.end, kind: "end", outcome: "Approved", position: { x: 660, y: 70 } },
    ],
    edges: [
      { id: "affected-check", source: AFFECTED.session, sourcePort: "submitted", target: AFFECTED.check, targetPort: "activate" },
      { id: "affected-persona", source: AFFECTED.session, sourcePort: "submitted", target: AFFECTED.persona, targetPort: "activate" },
      { id: "affected-check-pass", source: AFFECTED.check, sourcePort: "pass", target: AFFECTED.join, targetPort: "result" },
      { id: "affected-check-fail", source: AFFECTED.check, sourcePort: "fail", target: AFFECTED.join, targetPort: "result" },
      { id: "affected-persona-pass", source: AFFECTED.persona, sourcePort: "pass", target: AFFECTED.join, targetPort: "result" },
      { id: "affected-persona-fail", source: AFFECTED.persona, sourcePort: "fail", target: AFFECTED.join, targetPort: "result" },
      { id: "affected-join-pass", source: AFFECTED.join, sourcePort: "pass", target: AFFECTED.end, targetPort: "terminal" },
      { id: "affected-join-fail", source: AFFECTED.join, sourcePort: "fail", target: AFFECTED.session, targetPort: "return_for_changes" },
    ],
  });
  const affectedRun = await submit(
    daemon,
    affectedVersion,
    affectedSession,
    "e2e-spent-command-round-1",
  );
  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${affectedRun}`)).run.status,
  { message: "round 1 should spend test and park on the Persona objection", timeout: 60_000 })
    .toBe("waiting_for_session");
  const roundOne = await api<RunDetail>(daemon, `/api/workflow-runs/${affectedRun}`);
  expect((roundOne.attempts.find((attempt) => attempt.nodeId === AFFECTED.check)?.output as {
    status?: string;
  })?.status).toBe("passed");

  const blockerSession = await dispatch(
    dashboard,
    daemon,
    "hold both workflow Command execution slots",
  );
  const blockerVersion = await publish(daemon, "E2E Command capacity blocker", {
    nodes: [
      { id: BLOCKER.session, kind: "session", position: { x: 0, y: 70 } },
      { id: BLOCKER.build, kind: "check", slot: "build", position: { x: 220, y: 0 } },
      { id: BLOCKER.lint, kind: "check", slot: "lint", position: { x: 220, y: 140 } },
      { id: BLOCKER.join, kind: "all_pass", position: { x: 440, y: 70 } },
      { id: BLOCKER.end, kind: "end", outcome: "Approved", position: { x: 660, y: 70 } },
    ],
    edges: [
      { id: "blocker-build", source: BLOCKER.session, sourcePort: "submitted", target: BLOCKER.build, targetPort: "activate" },
      { id: "blocker-lint", source: BLOCKER.session, sourcePort: "submitted", target: BLOCKER.lint, targetPort: "activate" },
      { id: "blocker-build-pass", source: BLOCKER.build, sourcePort: "pass", target: BLOCKER.join, targetPort: "result" },
      { id: "blocker-build-fail", source: BLOCKER.build, sourcePort: "fail", target: BLOCKER.join, targetPort: "result" },
      { id: "blocker-lint-pass", source: BLOCKER.lint, sourcePort: "pass", target: BLOCKER.join, targetPort: "result" },
      { id: "blocker-lint-fail", source: BLOCKER.lint, sourcePort: "fail", target: BLOCKER.join, targetPort: "result" },
      { id: "blocker-join-pass", source: BLOCKER.join, sourcePort: "pass", target: BLOCKER.end, targetPort: "terminal" },
      { id: "blocker-join-fail", source: BLOCKER.join, sourcePort: "fail", target: BLOCKER.session, targetPort: "return_for_changes" },
    ],
  });
  const blockerRun = await submit(
    daemon,
    blockerVersion,
    blockerSession,
    "e2e-command-capacity-blocker",
  );

  const blockersRunning = async (): Promise<string> => {
    const detail = await api<RunDetail>(daemon, `/api/workflow-runs/${blockerRun}`);
    const state = (nodeId: string): string =>
      detail.attempts.find((attempt) => attempt.nodeId === nodeId)?.state ?? "missing";
    return `${state(BLOCKER.build)}/${state(BLOCKER.lint)}`;
  };

  try {
    await expect.poll(async () =>
      `${await blockersRunning()}/${existsSync(buildStarted)}/${existsSync(lintStarted)}`,
    { message: "both real Commands should hold the two shared execution slots", timeout: 60_000 })
      .toBe("running/running/true/true");

    await dashboard.goto(`${daemon.baseURL}/#/runs/${affectedRun}`);
    const primary = dashboard.locator("header.wf-run-head button.btn-primary");
    await expect(primary).toHaveText("Preview fresh evidence");
    await primary.click();
    await dashboard.getByRole("dialog", { name: "Preview fresh evidence" })
      .getByRole("button", { name: "Preview fresh evidence" })
      .click();
    await expect(primary).toHaveText("Preview unchanged", { timeout: 40_000 });
    await primary.click();
    await dashboard.getByRole("dialog")
      .getByRole("button", { name: "Preview unchanged" })
      .click();

    await expect(dashboard.locator(".wf-run-scrubber"))
      .toContainText("Round 2", { timeout: 10_000 });
    const testTile = dashboard.locator(".wf-pipeline-strip li.wf-pipeline-reviewer")
      .filter({ hasText: "test" });
    await expect(testTile).toContainText("Skipped", { timeout: 5_000 });
    await expect(testTile).not.toContainText("Queued");

    const status = testTile.locator(".wf-pipeline-status");
    await status.hover();
    await expect(dashboard.locator(".tooltip", {
      hasText: "Already ran the most times this run allows.",
    })).toContainText("Change the limit in Library › Commands.");

    const roundTwo = await api<RunDetail>(daemon, `/api/workflow-runs/${affectedRun}`);
    const newest = roundTwo.submissions.find((submission) => submission.round === 2);
    const testAttempt = roundTwo.attempts.find((attempt) =>
      attempt.submissionId === newest?.id && attempt.nodeId === AFFECTED.check);
    expect((testAttempt?.output as { status?: string } | null)?.status).toBe("budget_spent");
    expect(await blockersRunning()).toBe("running/running");
    expect(existsSync(release)).toBe(false);

    await dashboard.mouse.move(0, 0);
    await shoot(dashboard, dashboard.locator(".wf-pipeline-strip"), "repair-round-skipped");
  } finally {
    writeFileSync(release, "release\n");
    await expect.poll(async () =>
      (await api<RunDetail>(daemon, `/api/workflow-runs/${blockerRun}`)).run.status,
    { message: "released blocker Commands should finish", timeout: 60_000 }).toBe("completed");
  }
});
