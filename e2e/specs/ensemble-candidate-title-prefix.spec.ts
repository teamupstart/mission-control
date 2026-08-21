import { expect, test } from "../fixtures/test.ts";

test("Best-of-N member task titles start with their ordered candidate labels", async ({
  dashboard,
  daemon,
}) => {
  const response = await fetch(`${daemon.baseURL}/api/ensembles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceKey: "e2e-ensemble-candidate-title-prefix",
      title: "Prefix ensemble task",
      intent: "Compare three approaches without spending model tokens.",
      repoRoot: daemon.repo,
      strategyId: "best_of_n",
      strategyConfig: { members: [{}, {}, {}] },
    }),
  });
  if (!response.ok) {
    throw new Error(`ensemble creation answered ${response.status}: ${await response.text()}`);
  }

  const sessionRows = dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row");
  await expect(sessionRows.locator(".rail-name")).toHaveText(
    [
      /^Candidate 1 - Prefix ensemble task/,
      /^Candidate 2 - Prefix ensemble task/,
      /^Candidate 3 - Prefix ensemble task/,
    ],
    { timeout: 60_000 },
  );
});
