import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The per-run disable toggle, driven the way an operator drives it: a click on a reviewer
 * row in the Runs monitor travels `POST /api/workflow-runs/:id/set-nodes-disabled` into
 * SQLite, comes back through the SSE summary bump and the detail refetch, and repaints the
 * row - and on the next round the engine honours the set by auto-passing the gate. No
 * other layer covers that loop: the SSR render tests assert markup for a given detail, the
 * HTTP tests assert the route against an in-process app, and neither ever connects the
 * click to the refetch to the engine.
 *
 * The scenario is the feature's own headline: a reviewer keeps failing a run, the operator
 * clicks it off, resubmits, and the round goes PAST it. Both reviewers are steered through
 * the fake `claude` binary - their Persona guidance carries `E2E_FAIL_VERDICT`, which the
 * fake answers with a fixed failing verdict - so every state this spec waits for is a
 * stable one (`waiting_for_session`), never a mid-review race.
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
        { message: "round 1 should park in waiting_for_session on the scripted fail verdict", timeout: 20_000 },
      )
      .toBe("waiting_for_session");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return runId;
}

test("clicking a reviewer disables it for this run, and the next round auto-passes it", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedFailedRun(dashboard, daemon);

  await dashboard.goto(`${daemon.baseURL}/#/workflows/runs/${runId}`);
  const pipeline = dashboard.locator(".wf-pipeline-strip");
  const row = (name: string) =>
    pipeline.locator("li.wf-pipeline-reviewer").filter({ hasText: name });

  // Round 1's truth, before any toggle.
  await expect(row("Blocking reviewer")).toContainText("Changes requested");
  await expect(row("Docs steward")).toContainText("Not started");

  // Clicking the unreached reviewer turns its row red with the Disabled chip and a pressed
  // toggle - the full loop: click -> POST -> DB -> SSE bump -> refetch -> repaint.
  await row("Docs steward").getByRole("button").click();
  await expect(row("Docs steward")).toHaveClass(/is-disabled/);
  await expect(row("Docs steward").getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(row("Docs steward")).toContainText("Disabled");

  // The same click re-enables it.
  await row("Docs steward").getByRole("button").click();
  await expect(row("Docs steward").getByRole("button")).toHaveAttribute("aria-pressed", "false");
  await expect(row("Docs steward")).not.toHaveClass(/is-disabled/);
  await expect(row("Docs steward")).toContainText("Not started");

  // Disabling the reviewer that already FAILED this round marks the row red but keeps the
  // recorded outcome on its chip: the toggle is a promise about future work, not an eraser.
  await row("Blocking reviewer").getByRole("button").click();
  await expect(row("Blocking reviewer")).toHaveClass(/is-disabled/);
  await expect(row("Blocking reviewer").getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(row("Blocking reviewer")).toContainText("Changes requested");

  // The set is durable, run-scoped, and names exactly the node that was clicked.
  const disabled = await api<{ run: { disabledNodeIds: string[] } }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  expect(disabled.run.disabledNodeIds).toEqual([NODE.blocking]);

  // The headline: resubmit against the same evidence. Round 2 must auto-pass the disabled
  // blocker and reach the second reviewer, whose scripted fail becomes the round's REAL
  // objection - proof the run went PAST the switched-off gate.
  await dashboard.getByRole("button", { name: "Preview unchanged" }).click();
  await dashboard.getByRole("dialog").getByRole("button", { name: "Preview unchanged" }).click();

  await expect(row("Blocking reviewer")).toContainText("Disabled", { timeout: 20_000 });
  await expect(row("Docs steward")).toContainText("Changes requested", { timeout: 20_000 });
  await expect(dashboard.locator(".wf-run-scrubber")).toContainText("Round 2");

  // And the daemon's durable record agrees: the round advanced, the auto-pass is an audited
  // event, and the run is back with the session rather than completed or stuck.
  const after = await api<{
    run: { status: string };
    events: Array<{ kind: string }>;
  }>(daemon, `/api/workflow-runs/${runId}`);
  expect(after.run.status).toBe("waiting_for_session");
  expect(after.events.some((event) => event.kind === "disabled_node_auto_passed")).toBe(true);
});

test("a stage header click disables every member of the stage at once", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedFailedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/workflows/runs/${runId}`);
  const pipeline = dashboard.locator(".wf-pipeline-strip");

  // Each authored reviewer is its own single-member stage, so its header carries the
  // stage-grain toggle. Click the SECOND stage's header: its one member is the unreached
  // Docs steward, and the whole card takes the disabled treatment.
  const docsStage = pipeline.locator("section.wf-pipeline-stage").filter({ hasText: "Docs steward" });
  await docsStage.locator(".wf-pipeline-stage-hit").click();
  await expect(docsStage).toHaveClass(/is-disabled/);
  await expect(docsStage.locator("li.wf-pipeline-reviewer")).toHaveClass(/is-disabled/);
  await expect(docsStage.locator("li.wf-pipeline-reviewer")).toContainText("Disabled");

  const detail = await api<{ run: { disabledNodeIds: string[] } }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  expect(detail.run.disabledNodeIds).toEqual([NODE.docs]);

  // The header click is a toggle too: the same click re-enables the stage.
  await docsStage.locator(".wf-pipeline-stage-hit").click();
  await expect(docsStage).not.toHaveClass(/is-disabled/);
  const cleared = await api<{ run: { disabledNodeIds: string[] } }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  expect(cleared.run.disabledNodeIds).toEqual([]);
});
