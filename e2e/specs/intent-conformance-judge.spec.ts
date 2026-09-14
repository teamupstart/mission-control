import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Inspect the shipped guidance through the built daemon and dashboard. No agent is launched.
test("intent guidance allows implementation flexibility while keeping explicit requirements", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 1100 });
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);
  await dashboard.getByRole("complementary", { name: "Persona library" })
    .getByRole("button", { name: /Intent Conformance Judge/ }).click();
  const guidance = dashboard.getByRole("region", { name: "Persona guidance" });
  await guidance.getByRole("button", { name: "Preview" }).click();
  await expect(guidance).toContainText("Your priority is that the original requested feature is present");
  await expect(guidance).toContainText("A different implementation or set of modified files can satisfy the same request.");
  await expect(guidance).toContainText("Extra tests are not scope drift.");
  await expect(guidance).toContainText("Read the supplied comments, recorded discussion, and submission notes");
  await expect(guidance).toContainText("Bug fixes are acceptable inclusions even when the bugs are unrelated to the original feature.");
  await expect(guidance).toContainText("Do not require a separate feature, task, or pull request for those fixes.");
  await expect(guidance).toContainText("A similar outcome does not excuse a missing required interface.");

  if (process.env.MC_E2E_EVIDENCE) {
    const evidence = artifactsDir("intent-conformance-judge");
    mkdirSync(evidence, { recursive: true });
    await guidance.screenshot({ path: `${evidence}intent-guidance.png` });
  }

  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /No-Mistakes Review/ }).click();
  await dashboard.getByRole("button", { name: /Version 17/ }).click();
  const detail = dashboard.locator(".workflow-version-detail");
  const intent = detail.locator("details.workflow-version-persona")
    .filter({ hasText: "Intent Conformance Judge" });
  await intent.locator("summary").click();
  await expect(intent).toContainText("Extra tests are not scope drift.");
  await expect(intent).toContainText("A similar outcome does not excuse a missing required interface.");

  await dashboard.getByRole("button", { name: /Version 16/ }).click();
  // The disclosure may remain open when the selected version changes.
  if (await intent.getAttribute("open") === null) await intent.locator("summary").click();
  await expect(intent).toContainText("does this change contradict the acceptance criteria the human actually stated?");
  await expect(intent).not.toContainText("Extra tests are not scope drift.");
});
