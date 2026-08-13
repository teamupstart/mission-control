import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const NODE = {
  check: "skipped-check",
  persona: "passing-persona",
};

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for skipped workflow status coverage");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }).toBe("idle");
  return sessionId;
}

/** A real full-workflow round with one unconfigured check and one earned Persona pass. */
async function seedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Passing reviewer",
    guidanceMarkdown: "# Passing reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E skipped status",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.check, kind: "check", slot: "test", position: { x: 220, y: 0 } },
        {
          id: NODE.persona,
          kind: "persona",
          personaId: persona.id,
          position: { x: 440, y: 0 },
        },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 660, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: NODE.check, targetPort: "activate" },
        { id: "check-pass", source: NODE.check, sourcePort: "pass", target: NODE.persona, targetPort: "activate" },
        { id: "check-fail", source: NODE.check, sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
        { id: "persona-pass", source: NODE.persona, sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "persona-fail", source: NODE.persona, sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
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
    { requestId: "e2e-skipped-status" },
  );
  await expect.poll(async () =>
    (await api<{ run: { status: string } }>(
      daemon,
      `/api/workflow-runs/${submitted.run.id}`,
    )).run.status,
  { timeout: 40_000 }).toBe("completed");
  return submitted.run.id;
}

test("skipped checks stay amber while prior passes turn green in an Inspector repair", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const pipeline = dashboard.locator(".wf-pipeline-strip");
  const check = pipeline.locator("li.wf-pipeline-reviewer").filter({ hasText: "test" });
  const checkStatus = check.locator(".wf-pipeline-status");

  // The real full-workflow response: the command did not exist, so its status is amber and
  // its hover text explains the configuration gap.
  await expect(checkStatus).toHaveClass(/workflow-waiting/);
  await expect(check).toContainText("Skipped");
  await checkStatus.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(
    "Skipped because this machine configures nothing for this Command.",
  );

  // Inspector-only submissions are normally created after a live GitHub finding and a new
  // PR head. This isolated daemon intentionally has no GitHub authority, so intercept only
  // the detail read and append that durable submission shape to the real completed run. The
  // built dashboard still reads the real graph, prior attempts, check outcome and styles.
  await dashboard.route(`**/api/workflow-runs/${runId}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      summary: Record<string, unknown>;
      run: Record<string, unknown>;
      submissions: Array<Record<string, unknown>>;
    };
    const previous = body.submissions.at(-1)!;
    body.submissions.push({
      ...previous,
      id: "inspector-only-e2e",
      round: Number(previous.round) + 1,
      mode: "inspector_only",
      status: "completed",
      context: {
        bypassReason: "Published Inspector-only findings policy",
        failedHeadSha: "old-head",
        newHeadSha: "new-head",
      },
      createdAt: Number(previous.createdAt) + 1,
      updatedAt: Number(previous.updatedAt) + 1,
      completedAt: Number(previous.updatedAt) + 1,
    });
    body.summary = {
      ...body.summary,
      round: Number(previous.round) + 1,
      bypassedPersonaReview: true,
    };
    await route.fulfill({ response, json: body });
  });
  await dashboard.reload();

  const repairedCheck = pipeline.locator("li.wf-pipeline-reviewer").filter({ hasText: "test" });
  const persona = pipeline.locator("li.wf-pipeline-reviewer").filter({ hasText: "Passing reviewer" });
  const repairedCheckStatus = repairedCheck.locator(".wf-pipeline-status");
  const personaStatus = persona.locator(".wf-pipeline-status");

  // The unconfigured check inherits its prior outcome and stays amber, while the Persona's
  // real prior pass earns the green Inspector-repair skip.
  await expect(repairedCheckStatus).toHaveClass(/workflow-waiting/);
  await expect(repairedCheck).toContainText("Skipped");
  await repairedCheckStatus.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(
    "Skipped because this machine configures nothing for this Command.",
  );

  await expect(personaStatus).toHaveClass(/workflow-passed/);
  await expect(persona).toContainText("Skipped");
  await personaStatus.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(
    "Skipped because this stage passed in the prior full workflow round. This Inspector repair round only rechecks Inspector.",
  );
});
