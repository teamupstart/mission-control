import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { Session } from "../../src/shared/types.ts";

// A real fake-agent rollout, real ingestion and SSE, and the card from the bug report.
// Only the fixture's disposable home is written; no provider call or live state is used.
test.use({ daemonEnv: { MISSION_USAGE_POLL_MS: "100" } });

test("Astra usage reaches the session chip and fleet, alongside Claude and older OpenAI models", async ({ dashboard, daemon }) => {
  const created = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title: "Astra pricing regression", intent: "Check pricing", agent: "codex", workflowId: null }),
  });
  expect(created.ok, await created.clone().text()).toBe(true);
  let session: Session | undefined;
  await expect.poll(async () => {
    const sessions = await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as Session[];
    session = sessions.find((item) => item.agent === "codex" && item.agentSessionId);
    return session?.state;
  }).toBe("idle");
  const root = join(daemon.home, ".codex", "sessions");
  const rollout = readdirSync(root, { recursive: true }).map(String)
    .find((path) => path.endsWith(`${session!.agentSessionId}.jsonl`));
  expect(rollout).toBeTruthy();
  appendFileSync(join(root, rollout!), [
    { type: "turn_context", timestamp: new Date().toISOString(), payload: { model: "gpt-6-astra", effort: "high", cwd: session!.cwd } },
    { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: 6_000, cached_input_tokens: 2_000, cache_write_input_tokens: 3_000,
      output_tokens: 400, reasoning_output_tokens: 100,
    } } } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const chip = dashboard.locator(".console-detail .cost-chip");
  await expect(chip).toHaveText("≈$0.07");
  await expect(dashboard.locator(".console-detail").getByText("GPT-6 Astra", { exact: true })).toBeVisible();
  await chip.hover();
  await expect(dashboard.locator(".tooltip").filter({ hasText: "API-equivalent estimate" })).toContainText("gpt-6-astra");
  await expect(dashboard.getByRole("button", { name: /^Spend - / })).toContainText("≈$0.07");
  if (process.env.MC_E2E_EVIDENCE === "1") {
    const dir = artifactsDir("model-pricing");
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: join(dir, "astra-session.png") });
  }

  // The same price owner values headless work; Claude's supplied dollars remain authoritative.
  for (const [runner, modelId, reportedCostUsd] of [
    ["codex", "gpt-5.4-mini", null], ["claude", "claude-fable-5", 0.25],
  ] as const) {
    const response = await fetch(`${daemon.baseURL}/api/usage/automation`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "foreman:review", runner, runId: modelId, ts: Date.now(), models: [{
        modelId, input: 1_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoningOutput: 0, reportedCostUsd,
      }] }),
    });
    expect(response.ok).toBe(true);
  }
  await dashboard.getByRole("button", { name: /^Spend - / }).click();
  await expect(dashboard.getByRole("dialog", { name: "Spend today" }).locator(".spend-row", { hasText: "Automation" })).toContainText("≈$0.25");
});
