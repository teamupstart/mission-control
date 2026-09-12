import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { mkSession } from "../../test/helpers/session-fixture.ts";

// The usage-poller integration test proves JSONL -> ledger -> session cost. Here the
// browser receives that projection through SSE and proves the Pi card and queue UI.
test("Pi renders reported spend while terminal Work Queue is refused", async ({ dashboard, daemon }) => {
  const stream = await fetch(`${daemon.baseURL}/events`);
  expect(stream.ok).toBe(true);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SSE closed before its snapshot");
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  const data = text.split("\n").find((line) => line.startsWith("data: "))!;
  const snapshot = JSON.parse(data.slice(6));
  const session = mkSession({
    id: "pi-priced", agent: "pi", agentSessionId: "pi-native", runtime: "terminal",
    name: "Pi cost check", cwd: daemon.repo, repoRoot: daemon.repo, gitRoot: daemon.repo,
    hooksSeen: false, meta: null,
    cost: {
      costUsd: 0.0109, basis: "api-equivalent", pricingModels: ["local-meter/metered"],
      pricingVersions: ["pi-reported-v3"], input: 5500, output: 2700,
      cacheRead: 0, cacheWrite: 0, reasoningOutput: 0, updatedAt: Date.now(),
    },
  });
  await dashboard.route("**/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `data: ${JSON.stringify({ ...snapshot, sessions: [session] })}\n\n`,
  }));
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  await expect(detail.locator(".cost-chip")).toHaveText("≈$0.01");
  await dashboard.getByRole("tab", { name: "Work queue" }).click();
  await expect(detail.locator(".wq-blocked")).toHaveText(
    "Pi Work Queue requires a managed Agent SDK session.",
  );
  await expect(detail.getByPlaceholder(/Queue work for this session/)).toHaveCount(0);
  const dir = artifactsDir("pi-cost-capabilities");
  mkdirSync(dir, { recursive: true });
  await detail.screenshot({ path: join(dir, "pi-cost-and-queue.png") });
  // An uninstrumented hand-run Pi has no proven identity or priced projection. This card must
  // stop showing dollars, rather than turning absence into an invented zero-dollar cost.
  session.agentSessionId = null;
  session.cost = null;
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await expect(dashboard.locator(".console-detail")).toBeVisible();
  await expect(dashboard.locator(".console-detail .cost-chip")).toHaveCount(0);
});
