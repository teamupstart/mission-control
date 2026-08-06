import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The one derived next move, driven the way an operator drives it.
 *
 * The run header used to offer every control a run might accept, side by side and all the same
 * weight - including `Submit unchanged`, which only ever answers a `workflow_unchanged_evidence`
 * refusal and was rendered as a co-equal twin before any refusal had happened. `runNextMove`
 * replaces the row with one primary, and this spec walks the sequence that proves it is derived
 * rather than assembled: a waiting run offers the fresh resubmission alone, the daemon refuses it
 * because the snapshot has not moved, and the SAME single primary becomes the recovery for that
 * exact refusal.
 *
 * The second half is also the only place the request-id contract is observable. Replaying the
 * refused submission's own id revives it INSIDE the round it already opened; minting a fresh one
 * silently burns a repair round. Both outcomes look identical in the browser, so the round number
 * is read off the daemon at the end - it is the only witness.
 *
 * No other layer reaches this. The unit table decides the move from a detail handed to it; only a
 * browser against a live daemon proves the refusal round-trips and the primary repaints into its
 * successor.
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

interface RunProbe {
  summary: { round: number };
  run: { status: string; currentPhase: string };
}

const probe = (daemon: DaemonHandle, runId: string): Promise<RunProbe> =>
  api<RunProbe>(daemon, `/api/workflow-runs/${runId}`);

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the next-move spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** A run parked in `waiting_for_session` on a scripted failing verdict. */
async function seedFailedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  await dispatch(page, daemon);
  // Wait for IDLE, not merely alive: evidence capture aborts with `conversation_changed` if the
  // transcript moves under it, and the dispatch's seeded first turn is still being answered by
  // the fake agent right after the card appears. It matters twice over here, because the
  // transcript's size is part of the evidence fingerprint this spec needs to stay still.
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
    name: "E2E next move",
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
    // Preview, so no repair packet is delivered to the session. That is what keeps the evidence
    // snapshot still between rounds, which is what makes the refusal below deterministic.
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-next-move-submit-1" },
  );
  const runId = submitted.run.id;

  try {
    await expect
      .poll(async () => (await probe(daemon, runId)).run.status, {
        message: "round 1 should park in waiting_for_session on the scripted fail verdict",
        timeout: 40_000,
      })
      .toBe("waiting_for_session");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return runId;
}

test("the header offers one derived move, and it becomes the recovery for its own refusal", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedFailedRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const header = dashboard.locator("header.wf-run-head");
  const primary = header.locator("button.btn-primary");

  // One primary, and only one. The row this replaced put five controls of equal weight here.
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText("Preview fresh evidence");
  await expect(header.getByRole("button", { name: "Preview unchanged" })).toHaveCount(0);
  // A run with a move needs no paragraph explaining itself.
  await expect(header.locator("p.wf-run-why")).toHaveCount(0);

  expect((await probe(daemon, runId)).summary.round).toBe(1);

  /*
   * Clicking it advances the run, and the advance the daemon actually makes is a refusal: the
   * repair round is opened, its evidence is captured, and the fingerprint matches round 1's
   * because nothing was ever delivered to the session. That parks the run in
   * `unchanged_evidence` - a phase, persisted, which is why the affordance below survives a
   * reload rather than living in component state.
   */
  await primary.click();
  await expect
    .poll(async () => (await probe(daemon, runId)).run.currentPhase, {
      message: "the fresh resubmission should be refused for an unmoved evidence snapshot",
      timeout: 40_000,
    })
    .toBe("unchanged_evidence");

  const refused = await probe(daemon, runId);
  expect(refused.run.status).toBe("waiting_for_session");
  // The refusal opened round 2 and failed its submission. Round 2 is the round the recovery below
  // has to stay inside.
  expect(refused.summary.round).toBe(2);

  // The SAME single primary is now the recovery, in the operator's language rather than the
  // route's. Still one control, not two.
  await expect(primary).toHaveText("Preview unchanged", { timeout: 40_000 });
  await expect(primary).toHaveCount(1);
  await expect(header.getByRole("button", { name: "Preview fresh evidence" })).toHaveCount(0);

  // It confirms first, because running every reviewer again against an unmoved snapshot spends
  // model tokens on evidence the operator has been told has not changed.
  await primary.click();
  const confirm = dashboard.getByRole("dialog");
  await expect(confirm).toContainText("nothing about the work under review has changed");
  await confirm.getByRole("button", { name: "Preview unchanged" }).click();

  /*
   * The reviewer runs again and fails again, so the run comes back to the session.
   *
   * Waited for as status AND phase together, because the revived submission passes through
   * `running` on its way - and `running` is not `unchanged_evidence`, so a poll on the phase
   * alone settles mid-review and reads a round that has not finished moving.
   */
  await expect
    .poll(async () => {
      const state = await probe(daemon, runId);
      return `${state.run.status}/${state.run.currentPhase}`;
    }, {
      message: "confirming the unchanged snapshot should re-run the review and park it again",
      timeout: 60_000,
    })
    .toMatch(/^waiting_for_session\/(?!unchanged_evidence)/);

  /*
   * The witness for the request-id contract.
   *
   * Round 2 is REVIVED, so the run is still on round 2. Had the click minted a fresh request id
   * the daemon would have found no prior submission, taken the repair path, and opened round 3 -
   * a repair round spent on nothing, with no visible difference in the browser at all. This
   * number is the only place that mistake is observable.
   */
  const after = await probe(daemon, runId);
  expect(after.summary.round).toBe(2);
  expect(after.run.status).toBe("waiting_for_session");
  await expect(dashboard.locator(".wf-run-scrubber")).toContainText("Round 2");
});
