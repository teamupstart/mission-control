import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * What a restart and a dead provider each cost an ensemble, as the operator reads it.
 *
 * The defect these cover destroyed a real run. A review stage's attempt budget is a promise
 * about how many times a MODEL may answer badly, but a daemon that exited mid-comparison used
 * to be recorded as a failed attempt, so two restarts exhausted a default budget of two without
 * a model having answered once - and the run threw away every candidate agent it had already
 * paid for. The counter on the pipeline told the same story backwards, counting attempt ROWS
 * against a budget of answers, so a retried review could read "attempt 3 of 2".
 *
 * Only this layer can prove the fix: the run has to survive a real daemon death with its
 * durable rows, a real recovery has to re-drive the review from them, a real provider failure
 * has to park the run rather than end it, and every one of those has to come back over SSE as
 * something a person can act on. The engine tests pin the budget arithmetic and the projection
 * tests pin the strings; neither can kill a daemon or draw a screen.
 *
 * No model tokens are spent. Both comparisons are answered by the fake `claude`, steered by a
 * marker in the run's intent: one it never answers (so a comparison is genuinely in flight when
 * the daemon is killed), one it dies on (so the run meets an unreachable provider).
 */

/** The markers `fake-claude.mjs` steers an ensemble comparison with. */
const HOLD_REVIEW = "E2E_HOLD_ENSEMBLE_REVIEW";
const FAIL_REVIEW = "E2E_FAIL_ENSEMBLE_REVIEW";
/**
 * Down until the review parks, then in flight and staying there. The nonce keys the fake's
 * call counter, so two workers running this file never share one.
 */
const FAIL_THEN_HOLD_REVIEW = "E2E_FAIL_THEN_HOLD_ENSEMBLE_REVIEW";

const EVIDENCE = artifactsDir("ensemble-review-pause");

/**
 * Photograph one pipeline state, for the review that cannot be settled by a class name.
 *
 * `is-blocked` versus `is-failed` is a claim about what a PERSON sees - amber "waiting for you"
 * against red "this is over" - and an assertion on a class attribute describes the tree rather
 * than the picture. The pair these produce is the comparison: the same component, the same
 * viewport and the same run, photographed on either side of the presses that spend it.
 *
 * Taken AFTER this test's assertions, on purpose and for the reason `library.spec.ts` gives
 * about its own captures: the image is only worth anything if the measurements around it passed
 * on the same run, so the two cannot drift apart. Behind `MC_E2E_EVIDENCE` like every other
 * capture here, because an ordinary `npm run test:e2e` would rewrite the binaries for no signal.
 */
async function shootPipeline(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control: a resting pointer portals a tooltip over the thing being photographed.
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  // One frame for the step row to settle after the resize.
  await page.waitForTimeout(300);
  await page.getByRole("region", { name: "Run pipeline" }).screenshot({
    path: `${EVIDENCE}${name}-pipeline.png`,
  });
  await page.screenshot({ path: `${EVIDENCE}${name}-page.png` });
  // eslint-disable-next-line no-console
  console.log(
    `CAPTURED e2e/.artifacts/ensemble-review-pause/${name}-pipeline.png and ${name}-page.png`,
  );
}

interface EnsembleDetail {
  run: { id: string; status: string };
  members: Array<{ id: string; status: string }>;
  stageAttempts: Array<{ stageId: string; attempt: number; status: string; driverKind: string }>;
  artifacts: Array<{ status: string }>;
}

async function detail(daemon: DaemonHandle, runId: string): Promise<EnsembleDetail> {
  const res = await fetch(`${daemon.baseURL}/api/ensembles/${runId}`);
  expect(res.ok, "the ensemble detail route should answer").toBe(true);
  return (await res.json()) as EnsembleDetail;
}

function reviewAttempts(snapshot: EnsembleDetail) {
  return snapshot.stageAttempts.filter((attempt) => attempt.driverKind === "review");
}

/**
 * Launch a two-candidate Best of N carrying `marker`, and submit both candidates.
 *
 * Created over the API rather than through the launch modal: these specs are about what happens
 * to a review AFTER the candidates are in, and the modal has its own coverage. Two ready
 * artifacts is the barrier the review stage waits on, so this returns with the comparison about
 * to start.
 */
async function launchTwoCandidates(
  daemon: DaemonHandle,
  sourceKey: string,
  marker: string,
): Promise<string> {
  const created = await fetch(`${daemon.baseURL}/api/ensembles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceKey,
      title: sourceKey,
      intent: `Improve the README. ${marker}`,
      repoRoot: daemon.repo,
      strategyId: "best_of_n",
      strategyConfig: { members: [{}, {}] },
    }),
  });
  expect(created.status, `create should launch the run: ${await created.clone().text()}`).toBe(201);
  const runId = ((await created.json()) as { run: { id: string } }).run.id;

  await expect
    .poll(
      async () => (await detail(daemon, runId)).members.filter((m) => m.status === "active").length,
      { message: "both members should reach a live worktree", timeout: 60_000 },
    )
    .toBe(2);
  for (const member of (await detail(daemon, runId)).members) {
    const submitted = await fetch(
      `${daemon.baseURL}/api/ensembles/${runId}/members/${member.id}/submit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          result: { summary: `candidate ${member.id}`, checks: ["typecheck"], testEvidence: null },
        }),
      },
    );
    expect(submitted.ok, `member ${member.id} should submit: ${await submitted.clone().text()}`).toBe(
      true,
    );
  }
  return runId;
}

test("a restart mid-comparison costs the review none of its attempts", async ({
  dashboard,
  daemon,
}) => {
  // 1. Two candidates in, on a run whose comparison the fake will hold open.
  const runId = await launchTwoCandidates(daemon, "e2e-ensemble-restart", HOLD_REVIEW);

  // 2. The comparison is genuinely in flight - one running attempt, held open by the fake.
  await expect
    .poll(async () => reviewAttempts(await detail(daemon, runId)).map((a) => a.status), {
      message: "the first comparison should be running",
      timeout: 60_000,
    })
    .toEqual(["running"]);

  // 3. The daemon dies with no orderly shutdown, and a successor comes up on the same home.
  await daemon.crash();
  await daemon.restart();

  // 4. Recovery settles the attempt nobody was watching as `interrupted` - not `failed` - and
  //    opens the NEXT attempt number against the same immutable subjects. Two rows, and the
  //    budget of two is untouched.
  await expect
    .poll(async () => reviewAttempts(await detail(daemon, runId)).map((a) => a.status), {
      message: "the interrupted comparison should be retried, not charged",
      timeout: 60_000,
    })
    .toEqual(["interrupted", "running"]);
  expect((await detail(daemon, runId)).run.status).toBe("evaluating");

  // 5. What the operator reads. The stage is on attempt row two, and says "attempt 1 of 2":
  //    the numerator is the budget it has spent, and a restart spent none of it. Before the
  //    fix this read "attempt 2 of 2" - one more restart from a dead run.
  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${runId}`);
  const pipeline = dashboard.getByRole("region", { name: "Run pipeline" });
  await expect(pipeline).toBeVisible();
  const review = pipeline.getByRole("listitem").filter({ hasText: "Review" });
  await expect(review).toContainText("attempt 1 of 2");
  await expect(review).not.toContainText("attempt 2 of 2");
  // Still working, not drawn as a dead stage: a retry is coming.
  await expect(review).toHaveAttribute("aria-current", "step");
});

test("a dead provider parks the review for the operator instead of ending the run", async ({
  dashboard,
  daemon,
}) => {
  // 1. Two candidates in, on a run whose comparison the fake will die on.
  const runId = await launchTwoCandidates(daemon, "e2e-ensemble-blocked", FAIL_REVIEW);

  // 2. Three infrastructure failures, spaced by a real backoff, and then the engine stops
  //    trying. The evaluator's budget of two was never touched: no model ever answered.
  await expect
    .poll(async () => reviewAttempts(await detail(daemon, runId)).map((a) => a.status), {
      message: "the provider should fail its bounded infrastructure budget",
      timeout: 60_000,
    })
    .toEqual(["failed", "failed", "failed"]);

  // 3. The run is PARKED, not over: still non-terminal, and every candidate it paid for is
  //    still on disk. This is the whole point of blocking rather than failing.
  const parked = await detail(daemon, runId);
  expect(parked.run.status, "a provider outage must not end the run").toBe("evaluating");
  expect(parked.artifacts.filter((a) => a.status === "ready").length).toBe(2);

  // 4. And the screen says so. Amber rather than red, the reason in words, and the one control
  //    that resumes it - because a person who reads "failed" here would believe the candidate
  //    work was gone at the moment it is intact and waiting for them.
  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${runId}`);
  const review = dashboard
    .getByRole("region", { name: "Run pipeline" })
    .getByRole("listitem")
    .filter({ hasText: "Review" });
  await expect(review).toContainText("paused after 3 infrastructure errors");
  await expect(review).toContainText("attempt 1 of 2");
  await expect(review).toHaveClass(/is-blocked/);
  await expect(review).not.toHaveClass(/is-failed/);
  const retry = dashboard.getByRole("button", { name: "Retry stage" });
  await expect(retry).toBeVisible();

  // The amber half of the evidence pair.
  await shootPipeline(dashboard, "blocked-amber");

  // 5. The door is real and it stays open. Each press grants exactly one more attempt against a
  //    provider that is still dead, and the run comes back to the same parked state rather than
  //    being spent by trying - because a daemon must never decide that a run holding intact
  //    candidate work is over. Driven through the button rather than the API, because the door
  //    being real is half of what "parks for the operator" means.
  for (const rows of [4, 5]) {
    // The door closes while the attempt it granted is in flight and reopens when that attempt
    // settles, so each press waits for the previous one to land rather than for a row to exist.
    await expect(retry).toBeVisible();
    await retry.click();
    await expect
      .poll(
        async () =>
          reviewAttempts(await detail(daemon, runId))
            .map((a) => a.status)
            .join(","),
        { message: `press ${rows - 3} should settle attempt row ${rows}`, timeout: 60_000 },
      )
      .toBe(Array.from({ length: rows }, () => "failed").join(","));
    expect(
      (await detail(daemon, runId)).run.status,
      "retrying a parked review must never be what ends the run",
    ).toBe("evaluating");
  }
  await expect(review).toHaveClass(/is-blocked/);
  await expect(review).toContainText("paused after 5 infrastructure errors");
  expect((await detail(daemon, runId)).artifacts.filter((a) => a.status === "ready").length).toBe(2);

  // 6. So a PERSON ends it. That is the whole shape of this change: the run is not spent by
  //    failing to reach a model, it waits, and the operator is the one who calls it. Cancelling
  //    keeps every submitted snapshot, which is why it is a safe answer to a dead provider.
  await dashboard.getByRole("button", { name: "Cancel run…" }).click();
  await dashboard
    .getByRole("group", { name: "Confirm cancel" })
    .getByRole("button", { name: "Cancel run", exact: true })
    .click();
  await expect
    .poll(async () => (await detail(daemon, runId)).run.status, {
      message: "the operator's cancel is what ends a parked run",
      timeout: 60_000,
    })
    .toBe("cancelled");

  // Over, and drawn as over: red, no explanation to act on, and no door left. The same component
  // and the same page as the amber frame above, which is what makes the pair a comparison rather
  // than two pictures.
  await expect(review).toHaveClass(/is-failed/);
  await expect(review).not.toHaveClass(/is-blocked/);
  await expect(retry).toHaveCount(0);

  // The red half of the evidence pair.
  await shootPipeline(dashboard, "failed-red");
});

test("a restart during an operator's retry leaves the parked review still asking for them", async ({
  dashboard,
  daemon,
}) => {
  // The two halves of this change meeting each other. A parked review is one the daemon will NOT
  // re-drive - the walk stops at it - so the only thing that moves it is a person pressing Retry
  // stage. If a restart interrupts the attempt that press granted, the newest attempt row is
  // `interrupted`, and every screen that reads a review's state from that row alone concludes a
  // retry is coming. Nothing is coming. Before the fix this drew as a live attempt with no amber,
  // no reason, and no button - a run parked forever with nothing on it to press.
  //
  // Only this layer can prove it: it needs a real park, a real operator press, a real daemon
  // death while the granted attempt is in flight, and a real recovery, and then it has to ask
  // what a person can actually see and reach.
  const runId = await launchTwoCandidates(
    daemon,
    "e2e-ensemble-parked-restart",
    `${FAIL_THEN_HOLD_REVIEW}:${Date.now().toString(36)}`,
  );

  // 1. Park it: the provider is down for the whole infrastructure budget.
  await expect
    .poll(async () => reviewAttempts(await detail(daemon, runId)).map((a) => a.status), {
      message: "the provider should spend the infrastructure budget",
      timeout: 60_000,
    })
    .toEqual(["failed", "failed", "failed"]);

  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${runId}`);
  const review = dashboard
    .getByRole("region", { name: "Run pipeline" })
    .getByRole("listitem")
    .filter({ hasText: "Review" });
  await expect(review).toHaveClass(/is-blocked/);

  // 2. The operator presses the door, and this time the call stays in flight.
  await dashboard.getByRole("button", { name: "Retry stage" }).click();
  await expect
    .poll(async () => reviewAttempts(await detail(daemon, runId)).length, {
      message: "the press should grant a fourth attempt",
      timeout: 60_000,
    })
    .toBe(4);
  await expect
    .poll(async () => reviewAttempts(await detail(daemon, runId)).at(-1)?.status, {
      message: "and that attempt should be genuinely running when the daemon dies",
      timeout: 60_000,
    })
    .toBe("running");

  // 3. The daemon dies under it, and a successor comes up on the same home.
  await daemon.crash();
  await daemon.restart();
  await expect
    .poll(async () => reviewAttempts(await detail(daemon, runId)).map((a) => a.status), {
      message: "recovery settles the granted attempt as interrupted and does NOT re-drive a parked stage",
      timeout: 60_000,
    })
    .toEqual(["failed", "failed", "failed", "interrupted"]);
  expect((await detail(daemon, runId)).run.status).toBe("evaluating");

  // 4. What a person sees has to still be the truth: parked, amber, saying why, with the one
  //    control that moves it. An `interrupted` newest row must not make any of that disappear.
  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${runId}`);
  const parked = dashboard
    .getByRole("region", { name: "Run pipeline" })
    .getByRole("listitem")
    .filter({ hasText: "Review" });
  await expect(parked).toHaveClass(/is-blocked/);
  await expect(parked).toContainText("paused after 3 infrastructure errors");
  await expect(dashboard.getByRole("button", { name: "Retry stage" })).toBeVisible();
});
