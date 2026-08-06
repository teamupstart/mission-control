import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A blocked run's header, driven the way an operator meets it.
 *
 * This is the state the whole run-controls redesign was reported from: a run whose bound session
 * disappeared, with the reason hidden in the tooltip of a control that refuses. The header used
 * to answer it with nine controls, two of which did anything, and the one that resolved the run
 * sat last and furthest right. It now answers with a SENTENCE and Cancel run.
 *
 * A resubmission is still offered for `blocked` - that part has not regressed and the next-move
 * unit table pins it - but not HERE, because here the daemon would refuse it. The difference this
 * spec exists to prove is what a refusal produces: prose in the page, not a dead button.
 *
 * No other layer sees this. The SSR render tests assert markup for a detail handed to them, and
 * only a browser against a live daemon proves the run REACHES this state and repaints into it.
 * The state is reached the way it is reached in production - the bound session goes away,
 * `session_remove` orphans the binding, and the active run is blocked underneath it.
 */

const EVIDENCE = fileURLToPath(
  new URL("../../docs/evidence/workflow-run-next-move/", import.meta.url),
);

/**
 * Photograph a state this spec has already asserted on.
 *
 * `toHaveCount(0)` proves the submissions and the disabled `Open PR` are unreachable, and the
 * text assertions prove the sentence is there. Neither shows a reader what the header now READS
 * like - a paragraph in the identity block and one destructive control, where the reported
 * screenshot had nine peers and the reason inside a tooltip. Behind `MC_E2E_EVIDENCE` like every
 * other capture in the suite, so an ordinary run does not rewrite a binary for no added signal.
 */
async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED docs/evidence/workflow-run-next-move/${name}.png`);
}

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

test("a run whose session disappeared explains itself in prose, with no dead controls", async ({
  dashboard,
  daemon,
}) => {
  const { runId, sessionId } = await seedFailedRun(dashboard, daemon);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  const primary = header.locator("button.btn-primary");

  // While the run is parked with its session there IS a move, and exactly one. Pinned here so
  // the assertions after the kill are about a control that was genuinely reachable before it.
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText("Preview fresh evidence");
  await expect(primary).toBeEnabled();
  await expect(header.locator("p.wf-run-why")).toHaveCount(0);
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the header
  // being photographed is what the pointer was last over.
  await dashboard.mouse.move(0, 0);
  await shoot(header, "01-waiting-one-primary");

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

  /*
   * The headline: the reason arrives as a sentence a person reads, in the identity block beside
   * the run's own facts. It used to be the `title` of a greyed-out button, which is a place an
   * operator finds a reason only by hovering the control that just refused them.
   *
   * Read off the DOM text rather than an accessible description, because there is deliberately
   * no longer a control here to carry one.
   */
  const why = header.locator("p.wf-run-why");
  await expect(why).toBeVisible({ timeout: 40_000 });
  await expect(why).toContainText("The session this run was reviewing is gone,");
  await expect(why).toContainText("so it cannot take another round.");
  // And it names the move that IS available, which the old tooltip never did.
  await expect(why).toContainText("Cancelling clears it from your queue");

  // No primary, and no disabled stand-in for one. Absence is the claim, so it is asserted as a
  // count on controls that were provably present a moment ago rather than as a bare negative.
  await expect(primary).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Preview fresh evidence" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Preview unchanged" })).toHaveCount(0);
  // Nor an Open PR pointing nowhere: this run has no pull-request concept at all.
  await expect(header.getByRole("button", { name: "Open PR" })).toHaveCount(0);
  await expect(header.getByRole("link", { name: "Open PR" })).toHaveCount(0);

  // Cancel run stays exactly where it was, in the danger group this change did not touch.
  await expect(
    header.locator(".wf-run-actions-danger").getByRole("button", { name: "Cancel run" }),
  ).toBeVisible();

  await dashboard.mouse.move(0, 0);
  await shoot(header, "02-blocked-says-why");

  // And the daemon agrees about why, so the sentence above is describing the real refusal.
  const detail = await api<{
    run: { status: string; currentPhase: string };
    binding: { state: string; sessionId: string | null };
  }>(daemon, `/api/workflow-runs/${runId}`);
  expect(detail.run.currentPhase).toBe("session_disappeared");
  expect(detail.binding.state).toBe("orphaned");
  expect(detail.binding.sessionId).toBeNull();
});
