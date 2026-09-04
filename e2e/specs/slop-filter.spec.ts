import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * Slop Filter on the Persona surface used to inspect and duplicate the shipped role.
 *
 * Stage membership belongs to `no-mistakes-review-stages.spec.ts`. This spec proves that the
 * role itself reaches a fresh install, remains read-only, and carries all six requested review
 * categories plus the evidence boundary that prevents speculative API findings.
 */

const EVIDENCE = artifactsDir("slop-filter");
const SLOP_FILTER = "Slop Filter";

const CATEGORIES = [
  "Redundant comments",
  "Defensive and error-handling cruft",
  "Hallucinated APIs or imports",
  "Tests that only validate mocks",
  "Trivial or tautological tests",
  "Padded, generic AI-style prose",
];

test("Slop Filter ships read-only with all six evidence-bound categories", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.setViewportSize({ width: 1440, height: 1000 });
  await dashboard.goto(`${daemon.baseURL}/#/library/personas`);

  const rail = dashboard.getByRole("complementary", { name: "Persona library" });
  const row = rail.getByRole("button", { name: new RegExp(SLOP_FILTER) });
  await expect(row).toBeVisible();
  await row.click();

  const fields = dashboard.locator("section.persona-fields");
  await expect(fields.getByLabel("Name")).toHaveValue(SLOP_FILTER);
  await expect(fields.getByLabel("Name")).toHaveAttribute("readonly", "");
  await expect(dashboard.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: "Duplicate to edit" })).toBeVisible();

  const guidance = dashboard.getByRole("region", { name: "Persona guidance" });
  await guidance.getByRole("button", { name: "Preview" }).click();
  for (const category of CATEGORIES) {
    await expect(guidance.getByRole("heading", { name: category })).toBeVisible();
  }
  await expect(guidance).toContainText(
    "Do not call an API hallucinated without supplied evidence that contradicts it.",
  );

  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await dashboard.mouse.move(0, 0);
  await dashboard.screenshot({
    path: `${EVIDENCE}builtin-slop-filter.png`,
    fullPage: true,
  });
  // eslint-disable-next-line no-console
  console.log("CAPTURED e2e/.artifacts/slop-filter/builtin-slop-filter.png");
});
