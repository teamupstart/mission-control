import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Run-scoped Persona controls, driven the way an operator drives them. A reviewer click
 * opens the critical feedback editor; save travels through the daemon into SQLite, comes
 * back through the SSE summary bump and detail refetch, then changes that Persona's next
 * provider prompt. Disable remains in the adjacent actions menu.
 *
 * Both reviewers are steered through the fake `claude` binary. Their published guidance
 * carries `E2E_FAIL_VERDICT`; only a prompt beginning with the critical directive and
 * carrying `E2E_DIRECTIVE_PASS_VERDICT` changes that answer. This proves both scoping and
 * prompt placement without spending model tokens.
 */

/** Ids this spec authors into the draft, so API assertions can name exact nodes. */
const NODE = { blocking: "judge-blocking", docs: "judge-docs" };

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

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the workflow spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * A run parked in `waiting_for_session` with two authored reviewers: the first failed
 * round 1, the second was never reached. Built through the same routes the dashboard uses.
 */
async function seedFailedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  await dispatch(page, daemon);
  // Wait for IDLE, not merely alive: evidence capture aborts with `conversation_changed`
  // if the transcript moves under it, and the dispatch's seeded first turn is being
  // answered by the fake agent right after the card appears.
  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    }, { message: "the dispatched session should settle to idle before evidence capture" })
    .toBe("idle");

  const blocking = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Blocking reviewer",
    guidanceMarkdown: "# Blocking reviewer\n\nE2E_FAIL_VERDICT",
  });
  const docs = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Docs steward",
    guidanceMarkdown: "# Docs steward\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E disable toggle",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.blocking, kind: "persona", personaId: blocking.id, position: { x: 220, y: 0 } },
        { id: NODE.docs, kind: "persona", personaId: docs.id, position: { x: 440, y: 0 } },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 660, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: NODE.blocking, targetPort: "activate" },
        { id: "e-b-pass", source: NODE.blocking, sourcePort: "pass", target: NODE.docs, targetPort: "activate" },
        { id: "e-b-fail", source: NODE.blocking, sourcePort: "fail", target: "session-node", targetPort: "return_for_changes" },
        { id: "e-d-pass", source: NODE.docs, sourcePort: "pass", target: "end-node", targetPort: "terminal" },
        { id: "e-d-fail", source: NODE.docs, sourcePort: "fail", target: "session-node", targetPort: "return_for_changes" },
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
    { requestId: "e2e-submit-1" },
  );
  const runId = submitted.run.id;

  // Round 1 settles: the blocking reviewer's scripted fail returns the round to Session.
  // On a miss the daemon's own log tail is attached, because the seeding failure that
  // matters here is server-side (capture, compaction, the engine) and invisible to a trace.
  try {
    await expect
      .poll(
        async () =>
          (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
        { message: "round 1 should park in waiting_for_session on the scripted fail verdict", timeout: 40_000 },
      )
      .toBe("waiting_for_session");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return runId;
}

async function previewUnchanged(page: Page): Promise<void> {
  // The first press asks for fresh evidence. Its expected refusal changes the one primary
  // action into the explicit unchanged-evidence recovery, which then requires confirmation.
  const primary = page.locator("header.wf-run-head button.btn-primary");
  await expect(primary).toHaveText("Preview fresh evidence");
  await primary.click();
  await expect(primary).toHaveText("Preview unchanged", { timeout: 40_000 });
  await primary.click();
  await page.getByRole("dialog").getByRole("button", { name: "Preview unchanged" }).click();
}

test("critical feedback follows one Persona through every later round of this run", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedFailedRun(dashboard, daemon);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const pipeline = dashboard.locator(".wf-pipeline-strip");
  const row = (name: string) =>
    pipeline.locator("li.wf-pipeline-reviewer").filter({ hasText: name });

  // Round 1's truth, before any directive.
  await expect(row("Blocking reviewer")).toContainText("Changes requested");
  await expect(row("Docs steward")).toContainText("Not started");

  // The row itself is the feedback affordance. The editor states its two locked dimensions
  // and persistence before accepting the instruction.
  await row("Blocking reviewer")
    .getByRole("button", { name: /^Blocking reviewer/ })
    .click();
  const editor = dashboard.getByRole("dialog", { name: "Guide this reviewer's future rounds" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Locked feedback scope")).toContainText("E2E disable toggle");
  await expect(editor.getByLabel("Locked feedback scope")).toContainText("Blocking reviewer");
  await expect(editor).toContainText("Repeats until removed");
  await editor.getByLabel("Feedback for Blocking reviewer").fill(
    "E2E_DIRECTIVE_PASS_VERDICT. Treat the operator exception as controlling.",
  );
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.screenshot({
      path: fileURLToPath(new URL("../evidence/workflow-persona-directive.png", import.meta.url)),
      fullPage: true,
    });
  }
  await editor.getByRole("button", { name: "Save for future rounds" }).click();
  await expect(row("Blocking reviewer")).toContainText("Critical feedback active");
  await expect(row("Docs steward")).not.toContainText("Critical feedback active");
  await expect(editor).toBeHidden();

  // Round 2 proves the directive beats the target Persona's still-failing published guidance,
  // while the sibling Persona receives no directive and keeps its original fail behavior.
  await previewUnchanged(dashboard);

  await expect(row("Blocking reviewer")).toContainText("Passed", { timeout: 40_000 });
  await expect(row("Docs steward")).toContainText("Changes requested", { timeout: 40_000 });
  await expect(dashboard.locator(".wf-run-scrubber")).toContainText("Round 2");

  // It remains active without another save. Round 3 makes the same target pass again and
  // reaches the same unmodified sibling failure.
  await previewUnchanged(dashboard);
  await expect(dashboard.locator(".wf-run-scrubber")).toContainText("Round 3", { timeout: 40_000 });
  await expect(row("Blocking reviewer")).toContainText("Passed", { timeout: 40_000 });
  await expect(row("Docs steward")).toContainText("Changes requested", { timeout: 40_000 });

  const after = await api<{
    run: { status: string; personaDirectives: Array<{ nodeId: string; revision: number }> };
    submissions: Array<{ id: string; round: number }>;
    attempts: Array<{
      submissionId: string;
      nodeId: string;
      operatorDirective?: { feedback: string; revision: number } | null;
    }>;
    events: Array<{ kind: string }>;
  }>(daemon, `/api/workflow-runs/${runId}`);
  expect(after.run.status).toBe("waiting_for_session");
  expect(after.run.personaDirectives).toEqual([expect.objectContaining({
    nodeId: NODE.blocking,
    revision: 1,
  })]);
  for (const roundNumber of [2, 3]) {
    const submissionId = after.submissions.find((item) => item.round === roundNumber)?.id;
    expect(after.attempts.find((item) =>
      item.submissionId === submissionId && item.nodeId === NODE.blocking)?.operatorDirective,
    ).toEqual(expect.objectContaining({ revision: 1 }));
    expect(after.attempts.find((item) =>
      item.submissionId === submissionId && item.nodeId === NODE.docs)?.operatorDirective ?? null,
    ).toBeNull();
  }
  expect(after.events.some((event) => event.kind === "persona_directive_set")).toBe(true);
});

test("a stage actions menu disables every member of the stage at once", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedFailedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const pipeline = dashboard.locator(".wf-pipeline-strip");

  // Each authored reviewer is its own single-member stage. The header now opens critical
  // feedback, so the stage-grain destructive toggle lives in its actions menu.
  const docsStage = pipeline.locator("section.wf-pipeline-stage").filter({ hasText: "Docs steward" });
  await docsStage.locator(".wf-pipeline-stage-actions")
    .getByRole("button", { name: "Actions for Docs steward" }).click();
  await docsStage.locator(".wf-pipeline-stage-actions")
    .getByRole("menuitem", { name: "Disable for this run" }).click();
  await expect(docsStage).toHaveClass(/is-disabled/);
  await expect(docsStage.locator("li.wf-pipeline-reviewer")).toHaveClass(/is-disabled/);
  await expect(docsStage.locator("li.wf-pipeline-reviewer")).toContainText("Disabled");

  const detail = await api<{ run: { disabledNodeIds: string[] } }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  expect(detail.run.disabledNodeIds).toEqual([NODE.docs]);

  await docsStage.locator(".wf-pipeline-stage-actions")
    .getByRole("button", { name: "Actions for Docs steward" }).click();
  await docsStage.locator(".wf-pipeline-stage-actions")
    .getByRole("menuitem", { name: "Enable for this run" }).click();
  await expect(docsStage).not.toHaveClass(/is-disabled/);
  const cleared = await api<{ run: { disabledNodeIds: string[] } }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  expect(cleared.run.disabledNodeIds).toEqual([]);
});
