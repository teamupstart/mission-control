import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Whose move a run is on, stated where the operator is looking, and never argued with.
 *
 * The report this answers: a parked repair round showed "Waiting for the session" in the
 * chip, "the session is still working" in small muted text, and a filled primary reading
 * "Start repair round 2" - the brightest control on the page, during exactly the state where
 * clicking it interrupts the session's repair and spends a round the observer was about to
 * open for free. Nothing said plainly that no action was needed.
 *
 * The posture banner (`runPosture`) is the fix, and only a browser proves the half of it
 * that matters: the daemon's fifteen-second resumption sweep writes the withheld ledger the
 * banner reads, the event stream repaints it live, and the SAME derivation demotes the
 * primary to a labelled override while the loop is closing itself. This spec drives one run
 * through every posture the report names:
 *
 *  1. reviewers RUNNING - the banner says no action is needed and the header offers no
 *     resubmission at any weight;
 *  2. parked and settled over unmoved work - "Your move", full-weight primary;
 *  3. parked with the session working - "No action needed", the primary demoted to a
 *     labelled override, and the override CLICKED: the daemon answers the forced round with
 *     its free unchanged-repository refusal, spending nothing;
 *  4. settled again - the refusal's own recovery is promoted back to the primary, and taking
 *     it forces a real round 2, whose reviewers-running posture is asserted again before the
 *     round number is read off the daemon.
 *
 * `E2E_SLOW_FAIL_VERDICT` is what makes the running posture reachable at all - the instant
 * verdict answers before a page can open. The spec waits on outcomes rather than on that
 * delay. No model tokens: the reviewer is scripted, and the busy window is the fake agent's
 * own held-turn directive rather than real work.
 */

const EVIDENCE = artifactsDir("workflow-run-posture");

/**
 * The fake agent holds this turn open for fifteen seconds. With the observer's ten-second
 * settle window on top, the session reads as busy for ~25 seconds - longer than one full
 * fifteen-second sweep interval, which is what makes the "No action needed" state land
 * deterministically rather than by winning a race.
 */
const HELD_TURN = "hold the current turn open for queued review setup";

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.locator("header.wf-run-head").screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-run-posture/${name}.png`);
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
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
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the posture spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * A LIVE run submitted against a deliberating reviewer, returned BEFORE it parks.
 *
 * Deliberately not waited to `waiting_for_session` here: the reviewers-running posture is
 * one of the states under test, and it only exists between this submit and the slow
 * verdict's objection.
 */
async function seedRunningRun(
  page: Page,
  daemon: DaemonHandle,
): Promise<{ runId: string; sessionId: string }> {
  // Live delivery is refused outright without both of these, so a spec that wants the
  // self-resuming posture grants it the same way an operator does.
  await api(
    daemon,
    "/api/workflows/config",
    { liveEnabled: true, repoAllowlist: [daemon.repo] },
    "PUT",
  );
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

  // The deliberating reviewer: objects after a scripted delay, which is what holds the run
  // in `running` long enough for a browser to look at it - in round 1 and again in the
  // forced round 2.
  const reviewer = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Deliberating reviewer",
    guidanceMarkdown: "# Deliberating reviewer\n\nE2E_SLOW_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E run posture",
    // Stated rather than defaulted: `auto` plus `live` is the self-resuming posture under
    // test, and a `manual` version would turn every parked assertion below into "Your move".
    resumptionPolicy: "auto",
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
    deliveryMode: "live",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-posture-submit-1" },
  );
  return { runId: submitted.run.id, sessionId };
}

test("the posture banner says whose move it is, demotes the primary while the run moves itself, and the override still works", async ({
  dashboard,
  daemon,
}) => {
  const { runId, sessionId } = await seedRunningRun(dashboard, daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  const header = dashboard.locator("header.wf-run-head");
  const banner = header.getByRole("status");
  const primary = header.locator("button.btn-primary");
  const override = header.locator("button.wf-run-override");

  /*
   * Reviewers RUNNING. The deliberating reviewer holds its verdict, so the run sits in
   * `running` while this page opens - the state the report described as "tests are running
   * or a persona is currently executing". The banner says no action is needed, and the
   * header offers no resubmission at any weight: a run that is moving needs no button
   * telling you to hurry it.
   */
  await expect(banner).toContainText("Reviewers and commands are running", { timeout: 30_000 });
  await expect(banner).toContainText("No action needed");
  await expect(primary).toHaveCount(0);
  await expect(override).toHaveCount(0);
  await shoot(dashboard, "00-reviewers-running-no-action");

  /*
   * Settled state next. The reviewer objects, the repair packet is typed into the session,
   * the fake agent answers without touching the repository, and the observer's sweep finds
   * it settled over unmoved work - the one parked state that genuinely IS the operator's,
   * so the banner must say so rather than promising a resumption that is never coming.
   */
  await expect(banner).toContainText("Your move", { timeout: 90_000 });
  await expect(banner).toContainText("the repository has not changed since round 1");
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText("Start repair round 2");
  await expect(override).toHaveCount(0);
  await shoot(dashboard, "01-settled-session-is-your-move");

  /*
   * Send the session back to work. This is the reported state: feedback delivered, session
   * addressing it, and the old header still shouting "Start repair round 2" from a filled
   * primary. The observer's next sweep records `session_busy`, the stream repaints, and the
   * page must now say no action is needed - with the SAME move still reachable, demoted to
   * a labelled override.
   */
  await api(daemon, `/api/sessions/${encodeURIComponent(sessionId)}/send`, {
    text: HELD_TURN,
    submit: true,
  });
  await expect(banner).toContainText("No action needed", { timeout: 40_000 });
  await expect(banner).toContainText("The session is still working");
  await expect(override).toHaveCount(1);
  await expect(override).toContainText("Start repair round 2");
  // The tag is what a reader who never hovers still sees.
  await expect(override.locator(".wf-run-override-tag")).toHaveText("override");
  // And there is no filled primary anywhere in the header while the run moves itself.
  await expect(primary).toHaveCount(0);
  await shoot(dashboard, "02-working-session-needs-no-action");

  /*
   * The override is a real control, not an ornament: click it while the session is still
   * working. The confirm carries the round it would spend, and the daemon answers the
   * forced round with the honest outcome for THIS repository - the free pre-capture
   * refusal, because nothing has changed since round 1. The click demonstrably reached the
   * daemon, and the protection cost nothing: the refusal is a run phase, the header draws
   * its sentence, and round 1 is still the run's last round.
   */
  await override.click();
  const forceConfirm = dashboard.getByRole("dialog", { name: "Start repair round 2" });
  await expect(forceConfirm).toContainText("spends one repair round");
  await forceConfirm.getByRole("button", { name: "Start round 2" }).click();
  await expect
    .poll(async () => (await probe(daemon, runId)).run.currentPhase, {
      message: "the forced round should be refused for an unmoved repository",
      timeout: 40_000,
    })
    .toBe("unchanged_repository");
  expect((await probe(daemon, runId)).summary.round).toBe(1);
  await expect(header.locator("p.wf-run-refused")).toContainText("nothing was spent");

  /*
   * The refusal's own recovery, taken once the session settles: the banner hands the move
   * back, the recovery is promoted to the full-weight primary, and confirming it is the
   * force that actually works - round 2 opens against the snapshot the operator was told
   * has not moved.
   */
  await expect(banner).toContainText("Your move", { timeout: 90_000 });
  await expect(primary).toHaveText("Review it anyway", { timeout: 15_000 });
  await primary.click();
  const reviewConfirm = dashboard.getByRole("dialog", { name: "Review unchanged work" });
  await expect(reviewConfirm).toContainText("spends one repair round");
  await reviewConfirm.getByRole("button", { name: "Review it anyway" }).click();

  /*
   * And the forced round's own reviewers-running posture, reached through a real user
   * interaction this time: the deliberating reviewer holds round 2 open long enough for the
   * banner to be read again, with no resubmission offered at any weight while it runs.
   */
  await expect(banner).toContainText("Reviewers and commands are running", { timeout: 60_000 });
  await expect(banner).toContainText("No action needed");
  await expect(primary).toHaveCount(0);
  await expect(override).toHaveCount(0);
  await shoot(dashboard, "03-forced-round-reviewers-running");

  /*
   * The witness for what the whole circle cost: the free refusal spent nothing, and the one
   * force the operator confirmed spent exactly one round. The run parks again on the slow
   * verdict, at round 2.
   */
  await expect
    .poll(async () => (await probe(daemon, runId)).run.status, {
      message: "round 2 should park on the deliberating reviewer's objection",
      timeout: 60_000,
    })
    .toBe("waiting_for_session");
  expect((await probe(daemon, runId)).summary.round).toBe(2);
});
