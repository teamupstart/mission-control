import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { WorkflowConfig, WorkflowRunDetail } from "../../src/shared/workflow.ts";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

// The real settings write controls real workflow rounds; all model calls hit the fixture CLI.
const EVIDENCE = artifactsDir("workflow-judge-passes");
async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}
async function shoot(page: Page, name: string, keepHover = false): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  if (!keepHover) await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
}

test("judge-pass checkbox defaults on, persists changes, and leads the reordered repository section", async ({ dashboard, daemon }) => {
  await dashboard.setViewportSize({ width: 1440, height: 1200 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  const checkbox = dashboard.getByRole("checkbox", { name: "Skip judges that already passed" });
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  const judges = dashboard.locator('[data-anchor="workflows/judge-passes"]');
  const commands = dashboard.locator('[data-anchor="workflows/checks"]');
  const repositories = dashboard.locator('[data-anchor="workflows/allowlist"]');
  const boxes = await Promise.all([judges.boundingBox(), commands.boundingBox(), repositories.boundingBox()]);
  expect(boxes[0]!.y + boxes[0]!.height).toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y + boxes[1]!.height).toBeLessThan(boxes[2]!.y);
  await expect(repositories.getByRole("button", { name: /Manage in Trust/ })).toBeVisible();
  await checkbox.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(
    "Keep earned judge passes across repair rounds. Turn off to review every judge again.",
  );
  await expect(dashboard.locator(".tooltip")).toBeVisible();
  await shoot(dashboard, "settings-tooltip", true);
  await shoot(dashboard, "settings-default");
  await checkbox.uncheck();
  await expect.poll(async () => (await api<WorkflowConfig>(daemon, "/api/workflows/config")).skipPassedJudges).toBe(false);
  await dashboard.reload();
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect.poll(async () => (await api<WorkflowConfig>(daemon, "/api/workflows/config")).skipPassedJudges).toBe(true);
});

for (const { enabled, changedFeedback } of [
  { enabled: true, changedFeedback: false },
  { enabled: false, changedFeedback: false },
  { enabled: true, changedFeedback: true },
]) {
  const reuse = enabled && !changedFeedback;
  const behavior = changedFeedback ? "rerun a passed judge after changed feedback"
    : enabled ? "skip the passed judge" : "rerun judges when unchecked";
  test(`repair rounds ${behavior}`, async ({ dashboard, daemon }) => {
    if (reuse) await dashboard.request.put(`${daemon.baseURL}/api/telemetry/config`, { data: { enabled: true } });
    await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
    const checkbox = dashboard.getByRole("checkbox", { name: "Skip judges that already passed" });
    await expect(checkbox).toBeEnabled();
    await checkbox.setChecked(enabled);
    await expect.poll(async () => (await api<WorkflowConfig>(daemon, "/api/workflows/config")).skipPassedJudges).toBe(enabled);
    await api(daemon, "/api/tasks", {
      repoRoot: daemon.repo, title: "Judge pass repair", intent: "Hold a session for review",
      agent: "claude", workflowId: null,
    });
    let sessionId = "";
    await expect.poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      sessionId = sessions[0]?.id ?? "";
      return sessions[0]?.state;
    }).toBe("idle");
    const first = await api<{ id: string }>(daemon, "/api/personas", {
      name: "First judge", guidanceMarkdown: "# First judge\n\nE2E_PASS_VERDICT",
    });
    const second = await api<{ id: string }>(daemon, "/api/personas", {
      name: "Second judge", guidanceMarkdown: "# Second judge\n\nE2E_FAIL_VERDICT",
    });
    const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
      name: "Cumulative judge review",
      draft: {
        nodes: [
          { id: "session", kind: "session", position: { x: 0, y: 0 } },
          { id: "first", kind: "persona", personaId: first.id, position: { x: 200, y: 0 } },
          { id: "second", kind: "persona", personaId: second.id, position: { x: 400, y: 0 } },
          { id: "end", kind: "end", outcome: "Approved", position: { x: 600, y: 0 } },
        ],
        edges: [
          { id: "s-first", source: "session", sourcePort: "submitted", target: "first", targetPort: "activate" },
          { id: "first-pass", source: "first", sourcePort: "pass", target: "second", targetPort: "activate" },
          { id: "first-fail", source: "first", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
          { id: "second-pass", source: "second", sourcePort: "pass", target: "end", targetPort: "terminal" },
          { id: "second-fail", source: "second", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
        ],
      },
    });
    await dashboard.goto(`${daemon.baseURL}/#/library/workflows/${workflow.workflow.id}`);
    await expect(dashboard.locator(".wf-pipeline-repair")).toHaveText(
      "Any fail returns the submission to Session for repair, then a new round starts.",
    );
    const published = await api<{ version: { id: string } }>(daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
    const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
      workflowVersionId: published.version.id, sessionId, deliveryMode: "preview",
    });
    const { run } = await api<WorkflowRunDetail>(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "round-1" });
    const probe = () => api<WorkflowRunDetail>(daemon, `/api/workflow-runs/${run.id}`);
    await expect.poll(async () => (await probe()).run.status, { timeout: 40_000 }).toBe("waiting_for_session");
    const original = (await probe()).attempts.find((attempt) => attempt.nodeId === "first")!;
    if (changedFeedback) {
      await api(daemon, `/api/workflow-runs/${run.id}/set-persona-directive`, {
        requestId: "recheck-first", nodeId: "first", feedback: "E2E_DIRECTIVE_PASS_VERDICT",
      });
    }
    await api(daemon, `/api/workflow-runs/${run.id}/set-persona-directive`, {
      requestId: "fix-second", nodeId: "second", feedback: "E2E_DIRECTIVE_PASS_VERDICT",
    });
    await api(daemon, `/api/workflow-runs/${run.id}/resubmit`, { requestId: "round-2", resubmitUnchanged: true });
    await expect.poll(async () => (await probe()).run.status, { timeout: 40_000 }).toBe("completed");
    const detail = await probe();
    const repair = detail.submissions.find((submission) => submission.round === 2)!;
    const judges = detail.attempts.filter((attempt) => attempt.submissionId === repair.id && attempt.persona);
    expect(judges.find((attempt) => attempt.nodeId === "first")?.runner).toBe(reuse ? null : "claude");
    expect(judges.find((attempt) => attempt.nodeId === "second")?.runner).toBe("claude");
    if (reuse) expect(judges.find((attempt) => attempt.nodeId === "first")?.output).toEqual({ outcome: "pass", reusedPassAttemptId: original.id });
    if (changedFeedback) expect(judges.find((attempt) => attempt.nodeId === "first")?.operatorDirective?.feedback).toBe("E2E_DIRECTIVE_PASS_VERDICT");
    await dashboard.setViewportSize({ width: 1800, height: 1100 });
    await dashboard.goto(`${daemon.baseURL}/#/runs/${run.id}`);
    await expect(dashboard.getByText("Any fail returns the submission to Session for repair, then a new round starts.", { exact: true })).toBeVisible();
    const pipeline = dashboard.locator(".wf-pipeline-strip");
    const row = pipeline.locator("li.wf-pipeline-reviewer").filter({ hasText: "First judge" });
    if (reuse) {
      await expect(row).toContainText("Not re-run");
      await expect(pipeline.getByRole("button", { name: /Passed in Round 1.*Show that round/ }).first()).toBeVisible();
      await shoot(dashboard, "repair-skips-passed-judge");
      await pipeline.getByRole("button", { name: /Passed in Round 1.*Show that round/ }).first().click();
      await expect(row).toContainText("Passed");
      // Filtering exists only when the ledger contains a packet from a different round.
      // This real repair has a round-one packet and a completed second round.
      await dashboard.getByRole("group", { name: "Select a round" }).getByRole("button", { name: /^Round 2/ }).click();
      const selections = () => withDaemonDb(daemon, (db) => db.prepare("SELECT COUNT(*) AS n FROM telemetry_journal WHERE name = 'mission.feature.entry' AND json_extract(facts_json, '$.feature') = 'runs' AND json_extract(facts_json, '$.action') = 'select'").get()!.n as number);
      const selected = selections();
      // The automatic first selection is already visible. Clicking it pins local state,
      // but only moving to the next item represents another feature-use outcome.
      await dashboard.clock.install();
      await dashboard.locator("button.wf-run-worklist-row[aria-current='true']").click();
      await dashboard.getByRole("button", { name: "Next item", exact: true }).click();
      await dashboard.clock.runFor(200);
      await expect.poll(selections).toBe(selected + 1);
      await dashboard.locator("button.wf-run-worklist-row[aria-current='true']").click();
      await dashboard.clock.runFor(200);
      expect(selections()).toBe(selected + 1);
      await dashboard.getByRole("tab", { name: /^Deliveries/ }).click();
      await dashboard.clock.runFor(200);
      await dashboard.getByRole("button", { name: "Show round 2 only" }).click();
      await expect(dashboard.getByText(/Showing round 2's 0 of/)).toBeVisible();
      await dashboard.getByRole("button", { name: "Show every round" }).click();
      await dashboard.clock.runFor(200);
      await expect(dashboard.getByText(/Showing all .* packets, every round/)).toBeVisible();
      const filters = () => withDaemonDb(daemon, (db) => db.prepare("SELECT COUNT(*) AS n FROM telemetry_journal WHERE name = 'mission.feature.entry' AND json_extract(facts_json, '$.feature') = 'runs' AND json_extract(facts_json, '$.action') = 'filter'").get()!.n as number);
      await expect.poll(filters).toBe(2);
    } else {
      await expect(row).toContainText("Passed");
      await expect(row).not.toContainText("Not re-run");
    }
  });
}
