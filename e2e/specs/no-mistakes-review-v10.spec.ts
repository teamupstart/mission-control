import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("no-mistakes-review-v10");

test("No-Mistakes Review v10 groups code review before evidence and documentation", async ({
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

  const stage3 = stages.nth(2);
  await expect(stage3.locator(".wf-pipeline-stage-name")).toHaveText("Stage 3");
  await expect(stage3.locator(".wf-pipeline-reviewer-name")).toHaveText([
    "Code Risk Reviewer",
    "Code Quality Judge",
  ]);

  const stage4 = stages.nth(3);
  await expect(stage4.locator(".wf-pipeline-stage-name")).toHaveText("Stage 4");
  await expect(stage4.locator(".wf-pipeline-reviewer-name")).toHaveText([
    "Test Evidence Auditor",
    "Documentation Steward",
  ]);

  const pullRequest = stages.nth(4);
  await expect(pullRequest.locator(".wf-pipeline-stage-name")).toHaveText("Pull Request");
  await expect(pipeline.locator(".wf-pipeline-inspector")).toHaveCount(0);

  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await dashboard.mouse.move(0, 0);
  await stage3.evaluate((element) => {
    const strip = element.closest(".wf-pipeline-strip");
    if (!(strip instanceof HTMLElement)) throw new Error("Stage 3 left its pipeline strip");
    strip.scrollLeft += element.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  });
  await dashboard.screenshot({
    path: `${EVIDENCE}stage-3-code-review.png`,
    fullPage: true,
  });

  await stage4.evaluate((element) => {
    const strip = element.closest(".wf-pipeline-strip");
    if (!(strip instanceof HTMLElement)) throw new Error("Stage 4 left its pipeline strip");
    strip.scrollLeft += element.getBoundingClientRect().left - strip.getBoundingClientRect().left;
  });
  await dashboard.screenshot({
    path: `${EVIDENCE}stage-4-before-pull-request.png`,
    fullPage: true,
  });
});
