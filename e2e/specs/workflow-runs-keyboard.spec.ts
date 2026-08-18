import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Keyboard selection on the Workflow Runs rail.
 *
 * The route and the reader are both part of the claim. A highlighted row alone would leave a
 * keyboard user looking at stale evidence on the right, while a detail fetch alone would leave
 * no visible cursor in the history. This drives two real completed runs and checks all three
 * pieces move together on one arrow press: selected row, URL, and reader heading.
 *
 * No model tokens: the Persona uses the fixed `E2E_PASS_VERDICT` response from the fake agent.
 */

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for workflow run keyboard navigation");
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
  }, { message: "the session should be idle before evidence is captured" }).toBe("idle");
  return sessionId;
}

async function archiveBinding(daemon: DaemonHandle, bindingId: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/workflow-bindings/${bindingId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`archiving ${bindingId} answered ${response.status}: ${await response.text()}`);
  }
}

async function completedRun(
  daemon: DaemonHandle,
  sessionId: string,
  personaIds: readonly [string, string],
  name: string,
  requestId: string,
): Promise<{ runId: string; bindingId: string }> {
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name,
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        {
          id: "first-reviewer",
          kind: "persona",
          personaId: personaIds[0],
          position: { x: 220, y: 0 },
        },
        {
          id: "second-reviewer",
          kind: "persona",
          personaId: personaIds[1],
          position: { x: 440, y: 0 },
        },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 660, y: 0 } },
      ],
      edges: [
        {
          id: "submit",
          source: "session",
          sourcePort: "submitted",
          target: "first-reviewer",
          targetPort: "activate",
        },
        {
          id: "first-pass",
          source: "first-reviewer",
          sourcePort: "pass",
          target: "second-reviewer",
          targetPort: "activate",
        },
        {
          id: "first-fail",
          source: "first-reviewer",
          sourcePort: "fail",
          target: "session",
          targetPort: "return_for_changes",
        },
        {
          id: "second-pass",
          source: "second-reviewer",
          sourcePort: "pass",
          target: "end",
          targetPort: "terminal",
        },
        {
          id: "second-fail",
          source: "second-reviewer",
          sourcePort: "fail",
          target: "session",
          targetPort: "return_for_changes",
        },
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
    { requestId },
  );
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(
      daemon,
      `/api/workflow-runs/${submitted.run.id}`,
    )
  ).run.status, {
    message: `${name} should finish before the rail is opened`,
    timeout: 40_000,
  }).toBe("completed");
  return { runId: submitted.run.id, bindingId: binding.id };
}

test("keyboard moves from runs into stages and loads completed stage detail", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  const sessionId = await dispatch(dashboard, daemon);
  const persona = async (name: string): Promise<string> => (
    await api<{ id: string }>(daemon, "/api/personas", {
      name,
      guidanceMarkdown: `# ${name}\n\nE2E_PASS_VERDICT`,
    })
  ).id;
  const personas = [
    await persona("Keyboard first reviewer"),
    await persona("Keyboard second reviewer"),
  ] as const;
  const older = await completedRun(
    daemon,
    sessionId,
    personas,
    "E2E keyboard older",
    "e2e-keyboard-older",
  );
  await archiveBinding(daemon, older.bindingId);
  await completedRun(
    daemon,
    sessionId,
    personas,
    "E2E keyboard newer",
    "e2e-keyboard-newer",
  );

  const history = await api<{
    items: Array<{ id: string; workflowName: string }>;
  }>(daemon, "/api/workflow-runs?limit=50");
  expect(history.items).toHaveLength(2);
  const [first, second] = history.items;
  expect(first).toBeDefined();
  expect(second).toBeDefined();

  await dashboard.goto(`${daemon.baseURL}/#/runs/${first!.id}`);
  const list = dashboard.getByRole("list", { name: "Workflow runs" });
  const firstRow = list.getByRole("button", { name: new RegExp(first!.workflowName) });
  const secondRow = list.getByRole("button", { name: new RegExp(second!.workflowName) });
  await expect(firstRow).toHaveAttribute("aria-current", "true");
  await expect(dashboard.locator(".wf-run-reader").getByRole("heading", {
    name: first!.workflowName,
  })).toBeVisible();

  await dashboard.keyboard.press("ArrowDown");

  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${second!.id}$`));
  await expect(secondRow).toHaveAttribute("aria-current", "true");
  await expect(secondRow).toBeFocused();
  await expect(dashboard.locator(".wf-run-reader").getByRole("heading", {
    name: second!.workflowName,
  })).toBeVisible();

  await dashboard.keyboard.press("ArrowUp");

  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${first!.id}$`));
  await expect(firstRow).toHaveAttribute("aria-current", "true");
  await expect(firstRow).toBeFocused();
  await expect(dashboard.locator(".wf-run-reader").getByRole("heading", {
    name: first!.workflowName,
  })).toBeVisible();

  // Tab leaves the selected run row for the first authored stage. More Tabs and arrows walk
  // stage headers instead of returning to the run rail.
  await dashboard.keyboard.press("Tab");
  const stages = dashboard.locator(".wf-run-reader .wf-pipeline-stage-head");
  await expect(stages).toHaveCount(2);
  await expect(stages.nth(0)).toBeFocused();
  await dashboard.keyboard.press("Tab");
  await expect(stages.nth(1)).toBeFocused();
  await dashboard.keyboard.press("ArrowLeft");
  await expect(stages.nth(0)).toBeFocused();
  await dashboard.keyboard.press("ArrowRight");
  await expect(stages.nth(1)).toBeFocused();

  // Enter on the completed second stage selects its own verdict in the worklist and loads
  // that verdict's detail. No click and no extra Enter is needed.
  await dashboard.keyboard.press("Enter");
  const worklist = dashboard.getByRole("region", { name: "Review worklist" });
  await expect(worklist.locator(".wf-run-worklist-row.active"))
    .toContainText("Keyboard second reviewer");
  await expect(worklist.locator(".wf-run-worklist-detail"))
    .toContainText("Keyboard second reviewer");
  await expect(worklist.locator(".wf-run-worklist-detail"))
    .not.toContainText("Keyboard first reviewer");
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${first!.id}$`));
});
