import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * The stage layout the shipped No-Mistakes Review draws, and the one place that owns it.
 *
 * This spec opens the built-in from the Workflows list, which draws its CURRENT version -
 * whatever that is on the build under test. It was called `no-mistakes-review-v10.spec.ts`
 * and titled for v10 while asserting no version at all, and that mismatch is what let
 * version 11 break it: a reader looking for the spec that covers the current graph had no
 * reason to open a file named after an older version. The name now says what it reads.
 *
 * When a version appends a stage or a member, this is the file to update. Membership is
 * asserted HERE and nowhere else, so `code-design-reviewer.spec.ts` covers that role's own
 * surface - the rail row, read-only, its guidance - and does not restate the graph.
 */

const EVIDENCE = artifactsDir("no-mistakes-review-stages");

test("the shipped No-Mistakes Review gates on intent and test coverage before deeper review", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /No-Mistakes Review/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  await expect(pipeline).toBeVisible();
  const stages = pipeline.locator("section.wf-pipeline-stage");
  await expect(stages).toHaveCount(5);

  const stage2 = stages.nth(1);
  await expect(stage2.locator(".wf-pipeline-stage-name")).toHaveText("Stage 2");
  await expect(stage2.locator(".wf-pipeline-reviewer-name")).toHaveText([
    "Intent Conformance Judge",
    "Test Coverage Judge",
  ]);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({
      path: `${EVIDENCE}stage-2-intent-and-test-coverage.png`,
      fullPage: true,
    });
  }

  const stage3 = stages.nth(2);
  await expect(stage3.locator(".wf-pipeline-stage-name")).toHaveText("Stage 3");
  await expect(stage3.locator(".wf-pipeline-reviewer-name")).toHaveText([
    "Code Risk Reviewer",
    "Code Quality Judge",
    "Code Design Reviewer",
  ]);

  const stage4 = stages.nth(3);
  await expect(stage4.locator(".wf-pipeline-stage-name")).toHaveText("Stage 4");
  await expect(stage4.locator(".wf-pipeline-reviewer-name")).toHaveText([
    "Test Evidence Auditor",
    "Documentation Steward",
    "Slop Filter",
  ]);

  const pullRequest = stages.nth(4);
  await expect(pullRequest.locator(".wf-pipeline-stage-name")).toHaveText("Pull Request");
  await expect(pipeline.locator(".wf-pipeline-inspector")).toHaveCount(0);

  await dashboard.getByRole("button", { name: /Version 15/ }).click();
  const currentVersion = dashboard.locator(".workflow-version-detail");
  await expect(currentVersion).toBeVisible();
  const firstReviewer = currentVersion.locator("details.workflow-version-persona").first();
  await firstReviewer.locator("summary").click();
  await expect(firstReviewer.getByText("codex · gpt-5.6-terra")).toBeVisible();
  const coverageReviewer = currentVersion
    .locator("details.workflow-version-persona")
    .filter({ hasText: "Test Coverage Judge" });
  await coverageReviewer.locator("summary").click();
  await expect(coverageReviewer.getByText("codex · gpt-5.6-terra")).toBeVisible();
  const designReviewer = currentVersion
    .locator("details.workflow-version-persona")
    .filter({ hasText: "Code Design Reviewer" });
  await designReviewer.locator("summary").click();
  await expect(designReviewer.getByText("codex · gpt-5.6-sol")).toBeVisible();

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({
      path: `${EVIDENCE}version-15-codex-models.png`,
      fullPage: true,
    });
  }

  // Each three-member stage still has to FIT. A card that overflows its strip is drawn, passes
  // every membership assertion above, and is unreadable - which is the one fault no graph or
  // markup check can see.
  await stage3.evaluate((element) => {
    const strip = element.closest(".wf-pipeline-strip");
    if (!(strip instanceof HTMLElement)) throw new Error("Stage 3 left its pipeline strip");
    strip.scrollLeft += element.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  });
  const contained = await stage3.evaluate((element) => {
    const strip = element.closest(".wf-pipeline-strip");
    if (!(strip instanceof HTMLElement)) throw new Error("Stage 3 left its pipeline strip");
    const card = element.getBoundingClientRect();
    const bounds = strip.getBoundingClientRect();
    return card.left >= bounds.left && card.right <= bounds.right;
  });
  expect(contained, "stage 3 overflows its pipeline strip").toBe(true);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({
      path: `${EVIDENCE}stage-3-code-review.png`,
      fullPage: true,
    });
  }

  await stage4.evaluate((element) => {
    const strip = element.closest(".wf-pipeline-strip");
    if (!(strip instanceof HTMLElement)) throw new Error("Stage 4 left its pipeline strip");
    strip.scrollLeft += element.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  });
  const stage4Contained = await stage4.evaluate((element) => {
    const strip = element.closest(".wf-pipeline-strip");
    if (!(strip instanceof HTMLElement)) throw new Error("Stage 4 left its pipeline strip");
    const card = element.getBoundingClientRect();
    const bounds = strip.getBoundingClientRect();
    return card.left >= bounds.left && card.right <= bounds.right;
  });
  expect(stage4Contained, "stage 4 overflows its pipeline strip").toBe(true);

  if (!process.env.MC_E2E_EVIDENCE) return;
  await dashboard.screenshot({
    path: `${EVIDENCE}stage-4-before-pull-request.png`,
    fullPage: true,
  });
});
