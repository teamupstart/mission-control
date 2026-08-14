import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const EVIDENCE = artifactsDir("foreman-planner-health");

async function request(
  daemon: DaemonHandle,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${daemon.baseURL}${path}`, init);
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  }
  return response;
}

test("a degraded backlog planner is diagnosable and retryable without restarting", async ({
  dashboard,
  daemon,
}) => {
  // No Foreman process and no model call. A leased synthetic leader reports the exact
  // bounded projection the real worker posts after its third failure.
  await request(daemon, "PUT", "/api/foreman/config", {
    enabled: true,
    mode: "live",
    autoBacklog: true,
    runner: "codex",
    backlogModel: "gpt-5.6-terra",
  });
  await request(daemon, "POST", "/api/foreman/heartbeat", { workerId: "e2e-planner" });
  await request(daemon, "POST", "/api/foreman/planner/health", {
    workerId: "e2e-planner",
    state: "degraded",
    runner: "codex",
    model: "gpt-5.6-terra",
    failureCount: 3,
    lastError: "codex exited 1: schema validation failed: missing tasks",
    nextRetryAt: Date.now() + 600_000,
  });

  await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
  const popover = dashboard.getByRole("dialog", { name: "Foreman settings" });
  const health = popover.getByRole("status", { name: "Backlog dependency planner health" });
  await expect(health).toBeVisible({ timeout: 20_000 });
  await expect(health).toContainText("Dependency planner");
  await expect(health).toContainText("degraded");
  await expect(health).toContainText("codex · gpt-5.6-terra · 3 failures");
  await expect(health).toContainText("codex exited 1: schema validation failed: missing tasks");
  await expect(health).toContainText(/Automatic retry in \d+m/);

  if (process.env.MC_E2E_EVIDENCE) {
    await health.hover();
    await dashboard.waitForTimeout(150);
    mkdirSync(EVIDENCE, { recursive: true });
    await popover.screenshot({ path: `${EVIDENCE}degraded-planner.png` });
  }

  await health.getByRole("button", { name: "Retry planner now" }).click();
  await expect(health.getByRole("button", { name: "Retry requested" })).toBeDisabled();
  await expect.poll(async () => {
    const response = await request(daemon, "GET", "/api/foreman/planner/control");
    return ((await response.json()) as { retryGeneration: number }).retryGeneration;
  }).toBeGreaterThan(0);

  // A failed probe changes the reported circuit state and rearms the operator control.
  await request(daemon, "POST", "/api/foreman/planner/health", {
    workerId: "e2e-planner",
    state: "degraded",
    runner: "codex",
    model: "gpt-5.6-terra",
    failureCount: 4,
    lastError: "codex exited 1: schema validation still failed: missing tasks",
    nextRetryAt: Date.now() + 600_000,
  });
  await expect(health.getByRole("button", { name: "Retry planner now" })).toBeEnabled();

  // The durable settings say which side of the provider/model divide owns each choice.
  await dashboard.goto(`${daemon.baseURL}/#/settings/foreman`);
  await dashboard.getByRole("tab", {
    name: "Models",
    description: /Show Foreman Models settings/,
  }).click();
  await expect(dashboard.getByText(/Foreman Provider controls all four model roles/)).toBeVisible();
  await dashboard.getByRole("tab", {
    name: "Launches",
    description: /Show Foreman Launches settings/,
  }).click();
  await expect(dashboard.getByText(/launch models are unrelated to the Backlog dependency planner/))
    .toBeVisible();
  await expect(dashboard.getByText(/degraded · codex\/gpt-5.6-terra · 4 failures/))
    .toBeVisible({ timeout: 20_000 });

  // The circuit snapshot remains available for recovery, but an inactive autopilot must
  // not present that snapshot as a planner that is actively degraded.
  await request(daemon, "PUT", "/api/foreman/config", { autoBacklog: false });
  await expect(dashboard.getByText(/idle \(autopilot off\) · codex\/gpt-5.6-terra/))
    .toBeVisible({ timeout: 20_000 });
  await expect(dashboard.getByText(/degraded · codex\/gpt-5.6-terra/)).toHaveCount(0);
});
