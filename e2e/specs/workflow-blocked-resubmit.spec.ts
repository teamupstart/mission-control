import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A blocked run's header, driven the way an operator meets it.
 *
 * `manager.resubmit` has always accepted a `blocked` run, and the header offered the control
 * to `waiting_for_session` alone - so a run blocked on a fault that had since cleared showed
 * nothing but Cancel run and read as terminal. The two resubmissions now render for `blocked`
 * too, and carry the server's own refusal when it would reject the call.
 *
 * No other layer sees this: the SSR render tests assert markup for a detail handed to them,
 * and only a browser against a live daemon proves the run REACHES this state and repaints
 * into it. The state is reached the way it is reached in production - the bound session goes
 * away, `session_remove` orphans the binding, and the active run is blocked underneath it.
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

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the blocked-run spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** A run parked in `waiting_for_session`, plus the id of the session holding it there. */
async function seedFailedRun(
  page: Page,
  daemon: DaemonHandle,
): Promise<{ runId: string; sessionId: string }> {
  await dispatch(page, daemon);
  // Wait for IDLE, not merely alive: evidence capture aborts with `conversation_changed` if
  // the transcript moves under it, and the dispatch's seeded first turn is still being
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

  const reviewer = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Blocking reviewer",
    guidanceMarkdown: "# Blocking reviewer\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E blocked resubmit",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: reviewer.id, position: { x: 220, y: 0 } },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "e-pass", source: "reviewer", sourcePort: "pass", target: "end-node", targetPort: "terminal" },
        { id: "e-fail", source: "reviewer", sourcePort: "fail", target: "session-node", targetPort: "return_for_changes" },
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
    { requestId: "e2e-blocked-submit-1" },
  );
  const runId = submitted.run.id;

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
  return { runId, sessionId };
}

test("a blocked run still offers the resubmissions, carrying the reason they cannot run", async ({
  dashboard,
  daemon,
}) => {
  const { runId, sessionId } = await seedFailedRun(dashboard, daemon);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const fresh = dashboard.getByRole("button", { name: "Preview fresh evidence" });
  const unchanged = dashboard.getByRole("button", { name: "Preview unchanged" });

  // While the run is parked with its session, both are live. This is the state the header
  // has always handled, pinned here so the blocked assertions below mean something.
  await expect(fresh).toBeEnabled();
  await expect(unchanged).toBeEnabled();

  // The session goes away. `session_remove` orphans the binding and blocks the active run -
  // the exact production route into a blocked run, not a state written behind the daemon.
  await api(daemon, `/api/sessions/${sessionId}/kill`, {});
  await expect
    .poll(
      async () =>
        (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
      { message: "killing the bound session should block the active run", timeout: 60_000 },
    )
    .toBe("blocked");

  // The headline: the controls are still THERE. Before this they vanished with the status
  // change, leaving Cancel run as the only thing an operator could reach.
  await expect(fresh).toBeVisible({ timeout: 40_000 });
  await expect(unchanged).toBeVisible();

  // Present, refused, and legible about which of the server's refusals applies - rather than
  // enabled onto a call that answers 409, or absent with no explanation at all.
  await expect(fresh).toBeDisabled();
  await expect(unchanged).toBeDisabled();
  await expect(fresh).toHaveAccessibleDescription(
    "The bound session is gone, so no further round can be prepared",
  );

  // Cancel run stays reachable beside them: a blocked run is still a run to close.
  await expect(dashboard.getByRole("button", { name: "Cancel run" })).toBeVisible();

  // And the daemon agrees about why, so the copy above is describing the real refusal.
  const detail = await api<{
    run: { status: string; currentPhase: string };
    binding: { state: string; sessionId: string | null };
  }>(daemon, `/api/workflow-runs/${runId}`);
  expect(detail.run.currentPhase).toBe("session_disappeared");
  expect(detail.binding.state).toBe("orphaned");
  expect(detail.binding.sessionId).toBeNull();
});
