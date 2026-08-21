import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The two silences a stuck repair round used to keep, and the sentences that end them.
 *
 * Reported together, because an operator hits them together: "Grant 2 more rounds does not
 * seem to work anymore - nothing happens, but the button changes to Resume review, which
 * appears to restart the prior round."
 *
 * Both halves of that report were true, and neither was a broken button.
 *
 * - The grant raised the run's own repair budget and left the run `blocked`. The resumption
 *   observer only ever looks at `waiting_for_session`, so on an `auto`/`live` workflow - the
 *   posture every built-in review ships with - the run it had just paid for could not be
 *   picked back up by anything except a human clicking the resume. Nothing on the page said
 *   the budget had moved either, so the click genuinely did look like a no-op.
 * - The resume then re-ran the graph from the Session node against a repository that had not
 *   moved a byte since the last round, spent a repair round doing it, and returned the same
 *   verdicts. It read as "restart the prior round" because that is materially what it was.
 *
 * Only a browser proves either fix. The unit tests assert the derivations given a detail, and
 * the SSR test asserts the markup given one - but neither can tell whether the DAEMON puts
 * `resumption` on the detail that reaches the browser, nor whether the grant route actually
 * hands an `auto`/`live` run back to the observer, which is the half of the fix that lives in
 * SQL and in a fifteen-second sweep.
 *
 * No model tokens: every verdict here comes from the scripted `E2E_FAIL_VERDICT` reviewer,
 * and the fake agents never write to the repository - which is precisely what makes the
 * unchanged-repository refusal deterministic rather than incidental.
 */

const EVIDENCE = artifactsDir("workflow-grant-and-parked-repair");

async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // pointer is still on whichever primary the assertion above just clicked.
  await page.mouse.move(0, 0);
  await page.locator("header.wf-run-head").screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-grant-and-parked-repair/${name}.png`);
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
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 of HTML is the SPA fallback answering for a path no route claimed.
    throw new Error(`${path} answered ${response.status} with non-JSON: ${text.slice(0, 160)}`);
  }
}

/** A POST whose refusal is the point - the round-limit 409 is how the run gets blocked. */
async function post(
  daemon: DaemonHandle,
  path: string,
  body: unknown,
): Promise<{ status: number; code: string }> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, code: (JSON.parse(text) as { code?: string }).code ?? "" };
  } catch {
    return { status: response.status, code: text.slice(0, 120) };
  }
}

const runState = async (
  daemon: DaemonHandle,
  runId: string,
): Promise<{ status: string; round: number; maxRepairRounds: number }> => {
  const detail = await api<{
    summary: { round: number };
    run: { status: string; maxRepairRounds: number };
  }>(daemon, `/api/workflow-runs/${runId}`);
  return {
    status: detail.run.status,
    round: detail.summary.round,
    maxRepairRounds: detail.run.maxRepairRounds,
  };
};

/**
 * A real run parked in `waiting_for_session` under the posture the built-in reviews ship with.
 *
 * `auto` and `live` are both stated rather than defaulted. They are what makes the grant's
 * restore reachable at all - a `manual` version or a `preview` binding has no observer to be
 * handed back to, and the grant correctly leaves those runs blocked for a human to resume.
 */
async function seedParkedRun(
  dashboard: Page,
  daemon: DaemonHandle,
  options: { name: string; maxRepairRounds?: number },
): Promise<{ runId: string; sessionId: string }> {
  // Live delivery is refused outright without both of these, so a spec that wants the
  // self-resuming posture grants it the same way an operator does.
  await api(
    daemon,
    "/api/workflows/config",
    { liveEnabled: true, repoAllowlist: [daemon.repo] },
    "PUT",
  );

  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((session) => session.id),
  );
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(`hold a ${options.name} run`);
  await dialog.locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // The daemon's own word for "the launch turn is over", which no DOM poll substitutes for.
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => !before.has(session.id) && session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle to idle", timeout: 60_000 }).toBe("idle");

  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `Never satisfied ${options.name}`,
    guidanceMarkdown: `# Never satisfied ${options.name}\n\nE2E_FAIL_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: options.name,
    resumptionPolicy: "auto",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
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
    ...(options.maxRepairRounds === undefined ? {} : { maxRepairRounds: options.maxRepairRounds }),
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `e2e-parked-${options.name}` },
  );
  await expect.poll(async () => (await runState(daemon, submitted.run.id)).status, {
    message: "round 1 should park on the scripted fail verdict",
    timeout: 60_000,
  }).toBe("waiting_for_session");
  return { runId: submitted.run.id, sessionId };
}

/**
 * The half of the report that read as "it restarts the prior round", because it did.
 *
 * The fake agent never touches the repository, so the tree behind this run is byte-identical
 * to the one round 1 already reviewed - which is the exact condition the daemon now checks
 * BEFORE it captures anything. The refusal has to cost nothing: no submission, no round, and
 * a durable phase the page can offer a way out of after a reload.
 */
test("a repair round on unmoved work is refused before it costs one, and offers the override", async ({
  dashboard,
  daemon,
}) => {
  const { runId } = await seedParkedRun(dashboard, daemon, { name: "E2E unchanged repair" });

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  const primary = header.locator("button.btn-primary");

  /*
   * The label is asserted because the old one was a promise the server never made. It read
   * "Resume review" over a tooltip that said "resume this run where it stalled", while
   * `manager.resubmit` computes `latest.round + 1` and re-runs every reviewer from the top.
   */
  await expect(primary).toHaveText("Start repair round 2", { timeout: 40_000 });
  await primary.click();

  const confirm = dashboard.getByRole("dialog", { name: "Start repair round 2" });
  await expect(confirm).toBeVisible();
  // The cost, and the refusal, stated before the click rather than discovered after it.
  await expect(confirm).toContainText("It spends one repair round.");
  await expect(confirm).toContainText("If the repository has not moved since the last round");
  await confirm.getByRole("button", { name: "Start round 2" }).click();
  await expect(confirm).toBeHidden();

  /*
   * And the refusal lands where a person can act on it. Not a toast: `manager.resubmit`
   * writes the refusal as a run phase, so this affordance survives the reload an operator
   * reaches for when a click appears to have done nothing.
   */
  const anyway = header.getByRole("button", { name: "Review it anyway" });
  await expect(anyway).toBeVisible({ timeout: 20_000 });
  await shoot(dashboard, "01-unmoved-work-is-refused");

  // Nothing was spent. This is the whole point of probing before capturing rather than
  // comparing after: round 1 is still the run's last round, and no submission was written.
  const refused = await runState(daemon, runId);
  expect(refused.round, "the refused round must not have been spent").toBe(1);
  expect(refused.status).toBe("waiting_for_session");
  const submissionsAfterRefusal = await api<{ submissions: unknown[] }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  expect(submissionsAfterRefusal.submissions.length).toBe(1);

  await dashboard.reload();
  await expect(header.getByRole("button", { name: "Review it anyway" })).toBeVisible({ timeout: 40_000 });

  /*
   * The override is a real way through, not a dead end dressed as one. It exists for the
   * operator whose evidence IS the transcript - a manual verification with no diff - and it
   * says so, and then it works.
   */
  await header.getByRole("button", { name: "Review it anyway" }).click();
  const override = dashboard.getByRole("dialog", { name: "Review unchanged work" });
  await expect(override).toBeVisible();
  await expect(override).toContainText("has not changed since round 1");
  await expect(override).toContainText("spends one repair round");
  await expect(override).toContainText("transcript itself is the evidence");
  await override.getByRole("button", { name: "Review it anyway" }).click();
  await expect(override).toBeHidden();

  await expect.poll(async () => (await runState(daemon, runId)).round, {
    message: "the override should actually open the round the refusal withheld",
    timeout: 60_000,
  }).toBe(2);
});

/**
 * The other half: the grant that "did nothing".
 *
 * Two separate silences, asserted separately because they had separate causes. The page said
 * nothing about the budget it had just raised, and the daemon left an `auto`/`live` run in a
 * status its own resumption observer does not look at.
 */
test("the grant says what it bought and hands a self-resuming run back to its observer", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  const { runId } = await seedParkedRun(dashboard, daemon, {
    name: "E2E grant restore",
    maxRepairRounds: 1,
  });

  /*
   * Spend the budget the way production spends it, through the manager. `resubmitUnchanged`
   * steps over the repository guard the first test is about: this test is about the ROUND
   * budget, and the scripted reviewer objects without the session changing a byte.
   */
  await api(daemon, `/api/workflow-runs/${runId}/resubmit`, {
    requestId: "e2e-grant-restore-2",
    resubmitUnchanged: true,
  });
  await expect.poll(async () => (await runState(daemon, runId)).status, {
    message: "round 2 should park on the scripted fail verdict",
    timeout: 60_000,
  }).toBe("waiting_for_session");
  const refused = await post(daemon, `/api/workflow-runs/${runId}/resubmit`, {
    requestId: "e2e-grant-restore-3",
    resubmitUnchanged: true,
  });
  expect(refused.status).toBe(409);
  expect(refused.code).toBe("workflow_round_limit");
  await expect.poll(async () => (await runState(daemon, runId)).status, {
    message: "the round-limit refusal should block the run",
    timeout: 20_000,
  }).toBe("blocked");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  const grant = header.getByRole("button", { name: /Grant \d+ more rounds/ });
  await expect(grant).toBeVisible({ timeout: 40_000 });
  await grant.click();
  const confirm = dashboard.getByRole("dialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Grant the rounds" }).click();
  await expect(confirm).toBeHidden();

  /*
   * The first silence. The grant's only visible consequence used to be the disappearance of
   * the button that caused it, which is indistinguishable from a button that crashed.
   */
  await expect(header.locator("p.wf-run-granted"))
    .toHaveText("Repair budget raised to 3 rounds.", { timeout: 20_000 });

  /*
   * The second, and the one that made the report say "nothing happens". A blocked run is
   * invisible to `sweepResumptions`, so before the fix the grant bought rounds that only a
   * human could spend - on the exact workflow posture that is supposed to spend them itself.
   */
  await expect.poll(async () => (await runState(daemon, runId)).status, {
    message: "the grant should hand a self-resuming run back to its resumption observer",
    timeout: 30_000,
  }).toBe("waiting_for_session");
  const granted = await runState(daemon, runId);
  expect(granted.maxRepairRounds, "the grant moves the run's own snapshot, not the binding's default")
    .toBe(3);
  expect(granted.round, "restoring the wait must not spend one of the rounds it just bought")
    .toBe(2);

  /*
   * And now that it IS being watched, the page says what the watcher is waiting on. This is
   * the sentence that turns "nothing happens" into a state: the observer looked, found the
   * repository exactly as round 2 left it, and declined to spend a round on it.
   */
  await expect(header.locator("p.wf-run-parked"))
    .toContainText("the repository has not changed since round 2", { timeout: 60_000 });
  await expect(header.locator("p.wf-run-parked")).toContainText("no round has been spent");
  await shoot(dashboard, "02-grant-restores-the-watch");

  // The dead end is gone rather than merely annotated: the grant retires itself, and the run
  // carries an ordinary next round again.
  await expect(grant).toHaveCount(0);
  await expect(header.locator("button.btn-primary")).toHaveText("Start repair round 3");
});
