import { mkdirSync } from "node:fs";

import type { Page, Route } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * When an ensemble's detail and an artifact's diff load, as the Ensembles page drives them.
 *
 * Two effects decide this and both had their dependency lists rewritten:
 *
 * - An artifact row opens and fetches its diff when the Result section's Evidence button asks
 *   for it, and only then. Its own Show/Hide toggle changes `open` without being a new request,
 *   so collapsing the row must leave it collapsed rather than have the request re-fire.
 * - The run detail refetches when the selection changes, and the cleanup retires the previous
 *   selection's in-flight read. A slow reply for a run the operator already left must never
 *   replace the run they are now looking at.
 *
 * The runs are real: created through the public route and failed by withdrawing their fixture
 * members, so no model tokens are spent and their summaries stop changing. What a real run
 * cannot supply without an evaluator is a ready artifact with a comparison naming it, so the
 * first test adds one to the detail reply in the browser and answers its diff from the browser
 * too, which is also what lets it count the diff requests. The second test only holds one real
 * reply back.
 */

async function json<T>(
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
  expect(response.ok, `${path} answered ${response.status}: ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

interface Detail {
  run: { id: string; status: string; title: string };
  members: Array<{ id: string; status: string }>;
  attempts: Array<{ id: string }>;
  artifacts: unknown[];
  evaluations: unknown[];
}

/** A best-of-N run that ends `failed` once its fixture members are withdrawn. */
async function failedEnsemble(daemon: DaemonHandle, title: string, sourceKey: string): Promise<string> {
  const created = await json<{ run: { id: string } }>(daemon, "/api/ensembles", {
    sourceKey,
    title,
    intent: "Exercise the Ensembles page's loads without asking a model to compare anything.",
    repoRoot: daemon.repo,
    strategyId: "best_of_n",
    strategyConfig: { members: [{}, {}] },
  });
  const id = created.run.id;
  await expect
    .poll(
      async () =>
        (await json<Detail>(daemon, `/api/ensembles/${id}`)).members.filter((m) => m.status === "active")
          .length,
      { message: "both fixture members should be withdrawable", timeout: 60_000 },
    )
    .toBe(2);
  // Withdrawing the first member can already end a two-candidate run, which ends the other
  // member with it; re-read between withdrawals and tolerate only that refusal.
  for (;;) {
    const detail = await json<Detail>(daemon, `/api/ensembles/${id}`);
    if (detail.run.status === "failed") break;
    const active = detail.members.find((m) => m.status === "active");
    if (!active) break;
    const response = await fetch(`${daemon.baseURL}/api/ensembles/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "withdraw_member", memberId: active.id }),
    });
    if (!response.ok) {
      expect(await response.text()).toContain("ensemble_action_invalid");
      break;
    }
  }
  await expect
    .poll(async () => (await json<Detail>(daemon, `/api/ensembles/${id}`)).run.status, {
      message: "an impossible two-candidate barrier should fail the run",
      timeout: 60_000,
    })
    .toBe("failed");
  return id;
}

const isPath = (path: string) => (url: URL) => url.pathname === path;

const EVIDENCE = artifactsDir("ensemble-detail-loads");

/** Gated behind `MC_E2E_EVIDENCE`: the rendered state the assertions beside it just passed on. */
async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/ensemble-detail-loads/${name}.png`);
}

const ARTIFACT_ID = "e2e-evidence-artifact";
const PATCH_TEXT = "diff --git a/src/lexer.ts b/src/lexer.ts\n+export const evidenceMarker = true;\n";

/** The real detail, plus one ready artifact and a succeeded comparison that names it. */
function withEvidence(detail: Detail): Detail {
  const attemptId = detail.attempts[0]?.id ?? "e2e-attempt";
  return {
    ...detail,
    artifacts: [
      {
        id: ARTIFACT_ID,
        runId: detail.run.id,
        attemptId,
        kind: "commit",
        formatVersion: 1,
        attempt: 1,
        status: "ready",
        locator: { ref: `refs/mission-control/ensembles/${detail.run.id}/${ARTIFACT_ID}`, snapshotSha: "1111111111" },
        digest: "deadbeef00",
        metadata: {
          reported: { summary: "Adds the evidence marker", checks: ["npm test"] },
          observed: { filesChanged: 1, insertions: 1, deletions: 0 },
        },
        error: null,
        createdAt: 1200,
        readyAt: 1300,
      },
    ],
    evaluations: [
      {
        id: "e2e-evaluation",
        runId: detail.run.id,
        stageAttemptId: "e2e-stage",
        attempt: 1,
        method: "comparative_review",
        runnerId: "claude",
        modelId: "fixture",
        inputFingerprint: "fp",
        subjectArtifactIds: [ARTIFACT_ID],
        result: {
          payloadVersion: 1,
          body: {
            version: 1,
            recommendedArtifactId: ARTIFACT_ID,
            comparison: "Only one candidate produced a snapshot.",
            caveats: [],
            scorecards: [
              {
                artifactId: ARTIFACT_ID,
                score: 80,
                rank: 1,
                strengths: ["small"],
                risks: [],
                rationale: "the only snapshot",
                confidence: 0.6,
              },
            ],
            evidenceTruncated: false,
          },
        },
        status: "succeeded",
        error: null,
        createdAt: 1400,
        updatedAt: 1500,
        finishedAt: 1500,
      },
    ],
  };
}

async function routeEvidence(page: Page, runId: string): Promise<{ patchRequests: () => number }> {
  let patchRequests = 0;
  await page.route(isPath(`/api/ensembles/${runId}`), async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const detail = (await response.json()) as Detail;
    await route.fulfill({ response, json: withEvidence(detail) });
  });
  await page.route(isPath(`/api/ensembles/${runId}/artifacts/${ARTIFACT_ID}/patch`), async (route) => {
    patchRequests++;
    await route.fulfill({
      json: {
        files: [{ path: "src/lexer.ts", oldPath: null, insertions: 1, deletions: 0, binary: false }],
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
        patchPaths: null,
        patch: PATCH_TEXT,
        truncated: false,
        omittedBytes: 0,
      },
    });
  });
  return { patchRequests: () => patchRequests };
}

test("Evidence opens and loads an artifact once, and its own toggle does not re-open it", async ({
  dashboard,
  daemon,
}) => {
  const title = "Artifact evidence loads on request";
  const runId = await failedEnsemble(daemon, title, "e2e-ensemble-artifact-auto-open");
  const { patchRequests } = await routeEvidence(dashboard, runId);

  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${runId}`);
  await expect(dashboard.getByRole("heading", { name: title, level: 3 })).toBeVisible();
  const artifacts = dashboard.getByRole("region", { name: "Artifacts" });
  const show = artifacts.getByRole("button", { name: "Show diff" });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  // Rendering the row is not a request: nothing is fetched until something asks.
  expect(patchRequests()).toBe(0);

  // The external request: the Result section's Evidence button opens the row and loads it.
  await dashboard.getByRole("region", { name: "Result" }).getByRole("button", { name: "Evidence" }).click();
  const hide = artifacts.getByRole("button", { name: "Hide diff" });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(artifacts.getByText("evidenceMarker", { exact: false })).toBeVisible();
  expect(patchRequests()).toBe(1);

  // The row's own toggle closes it. The open request is still standing, so an effect that
  // re-ran on `open` would re-open the row here; it must stay closed, with no second load.
  await hide.click();
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect(artifacts.getByText("evidenceMarker", { exact: false })).toHaveCount(0);
  // A beat for any re-run to land: a re-opened row would be back by now.
  await dashboard.waitForTimeout(500);
  await expect(show).toHaveAttribute("aria-expanded", "false");
  expect(patchRequests()).toBe(1);

  // Opening it again by hand shows the diff it already has, without fetching it again.
  await show.click();
  await expect(artifacts.getByText("evidenceMarker", { exact: false })).toBeVisible();
  expect(patchRequests()).toBe(1);
});

test("a slow detail reply for the run the operator left never replaces the run they chose", async ({
  dashboard,
  daemon,
}) => {
  const slowTitle = "Slow detail run";
  const chosenTitle = "Chosen detail run";
  const slowId = await failedEnsemble(daemon, slowTitle, "e2e-ensemble-detail-slow");
  const chosenId = await failedEnsemble(daemon, chosenTitle, "e2e-ensemble-detail-chosen");

  // Hold the slow run's detail reply until the operator has moved on.
  let releaseSlow!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let slowRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    slowRequested = resolve;
  });
  await dashboard.route(isPath(`/api/ensembles/${slowId}`), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    slowRequested();
    await released;
    await route.continue();
  });

  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${slowId}`);
  await requested;
  // A failed run's button leads with its "Needs attention" mark, so match the title anywhere.
  const runs = dashboard.locator(".ensemble-run-buttons");
  await expect(runs.getByRole("button", { name: new RegExp(chosenTitle) })).toBeVisible();

  await runs.getByRole("button", { name: new RegExp(chosenTitle) }).click();
  const chosen = dashboard.getByRole("heading", { name: chosenTitle, level: 3 });
  await expect(chosen).toBeVisible();

  // Now let the left run's reply arrive. It is a real, successful answer, and it is stale.
  const slowReply = dashboard.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/ensembles/${slowId}`,
  );
  releaseSlow();
  expect((await slowReply).ok()).toBe(true);
  await dashboard.waitForTimeout(500);
  await expect(chosen).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: slowTitle, level: 3 })).toHaveCount(0);
  await expect(runs.getByRole("button", { name: new RegExp(chosenTitle) })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(dashboard).toHaveURL(new RegExp(`#/ensembles/${chosenId}$`));
});

test("an action's detail reload lands on its own run, and a late one never replaces the run chosen next", async ({
  dashboard,
  daemon,
}) => {
  const firstTitle = "Action reload stays on its run";
  const secondTitle = "Action reload left behind";
  const firstId = await failedEnsemble(daemon, firstTitle, "e2e-ensemble-action-reload-first");
  const secondId = await failedEnsemble(daemon, secondTitle, "e2e-ensemble-action-reload-second");
  const runs = dashboard.locator(".ensemble-run-buttons");
  const runButton = (title: string) => runs.getByRole("button", { name: new RegExp(title) });
  const actionPosted = (runId: string) =>
    dashboard.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/ensembles/${runId}/actions` &&
        response.request().method() === "POST",
    );

  // While the run stays selected, the action's reload brings its result onto the page: the
  // failure is acknowledged, so Dismiss retires and the run keeps only its delete control.
  await dashboard.goto(`${daemon.baseURL}/#/ensembles/${firstId}`);
  await expect(dashboard.getByRole("heading", { name: firstTitle, level: 3 })).toBeVisible();
  const firstReload = dashboard.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/ensembles/${firstId}` &&
      response.request().method() === "GET",
  );
  const firstPosted = actionPosted(firstId);
  await dashboard.getByRole("button", { name: "Dismiss failure" }).click();
  expect((await firstPosted).ok()).toBe(true);
  expect((await firstReload).ok()).toBe(true);
  await expect(dashboard.getByRole("button", { name: "Dismiss failure" })).toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: "Delete run…" })).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: firstTitle, level: 3 })).toBeVisible();
  await expect(runButton(firstTitle)).toHaveAttribute("aria-current", "true");
  await dashboard.getByRole("region", { name: "Actions" }).scrollIntoViewIfNeeded();
  await capture(dashboard, "run-detail-after-dismiss-failure");

  // On the second run, hold every detail read that follows its action: the action's own
  // reload, and any reload the SSE revision of the same change asks for.
  let holding = false;
  let releaseReloads!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseReloads = resolve;
  });
  let reloadRequested!: () => void;
  const reloadSeen = new Promise<void>((resolve) => {
    reloadRequested = resolve;
  });
  await dashboard.route(isPath(`/api/ensembles/${secondId}/actions`), async (route) => {
    holding = true;
    await route.continue();
  });
  await dashboard.route(isPath(`/api/ensembles/${secondId}`), async (route) => {
    if (route.request().method() !== "GET" || !holding) return route.fallback();
    reloadRequested();
    await released;
    await route.continue();
  });

  await runButton(secondTitle).click();
  await expect(dashboard.getByRole("heading", { name: secondTitle, level: 3 })).toBeVisible();
  const secondPosted = actionPosted(secondId);
  await dashboard.getByRole("button", { name: "Dismiss failure" }).click();
  expect((await secondPosted).ok()).toBe(true);
  // The action answered while its run was still selected, so its reload has been issued.
  await reloadSeen;

  // Move on before that reload answers, then let it answer. It is real and successful, and stale.
  await runButton(firstTitle).click();
  await expect(dashboard.getByRole("heading", { name: firstTitle, level: 3 })).toBeVisible();
  const lateReload = dashboard.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/ensembles/${secondId}` &&
      response.request().method() === "GET",
  );
  releaseReloads();
  expect((await lateReload).ok()).toBe(true);
  await dashboard.waitForTimeout(500);
  await expect(dashboard.getByRole("heading", { name: firstTitle, level: 3 })).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: secondTitle, level: 3 })).toHaveCount(0);
  await expect(runButton(firstTitle)).toHaveAttribute("aria-current", "true");
  await expect(runButton(secondTitle)).not.toHaveAttribute("aria-current", "true");
  await expect(dashboard).toHaveURL(new RegExp(`#/ensembles/${firstId}$`));
  await capture(dashboard, "chosen-run-after-late-action-reload");
});
