import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  appendConductorEngineerEvent,
  seedDirectConductorEngineerSuccessor,
  writeConductorProjects,
} from "../fixtures/conductor.ts";
import { expect, test } from "../fixtures/test.ts";

test.use({
  daemonEnv: {
    MC_E2E_CONDUCTOR_ENGINEER_MODE: "supported",
    MC_E2E_CONDUCTOR_READINESS: "blocked-until-marker",
    MISSION_PIPELINE_TICK_MS: "500",
  },
});

async function request(
  daemon: DaemonHandle,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  return fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("provider readiness blocks model launch and rechecks the same attempt", async ({
  dashboard,
  daemon,
}) => {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  const configured = await request(daemon, "/api/pipelines/config", "PUT", {
    enabled: true,
    launchRuntime: "agent-sdk",
    foremanMechanicalTriage: false,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });
  expect(configured.ok, await configured.text()).toBe(true);
  await dashboard.reload();

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await dialog.getByPlaceholder("What should this agent do?").fill("Prove provider readiness");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();

  await expect.poll(async () => {
    const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{
      kind: string;
      status: string;
      sessionId: string | null;
      pipelineCommissionId: string | null;
    }>;
    const task = tasks.find((candidate) => candidate.kind === "pipeline");
    return task ? { status: task.status, sessionId: task.sessionId, commission: task.pipelineCommissionId } : null;
  }).toEqual({ status: "running", sessionId: null, commission: expect.any(String) });

  await dashboard.getByRole("button", { name: /to answer/ }).click();
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox.getByRole("heading", { name: "Pipeline lifecycle" })).toBeVisible();
  await expect(inbox).toContainText("GitHub authentication is required");
  await inbox.getByRole("button", { name: "Open Pipeline" }).click();
  const lifecycle = dashboard.getByRole("region", { name: "Provider lifecycle" });
  await expect(lifecycle.getByText("Launch blocked", { exact: true })).toBeVisible();
  await expect(lifecycle).toContainText("GitHub authentication is required");
  await expect(lifecycle).toContainText("Authenticate GitHub, then check again");
  await lifecycle.getByText("Provider diagnostic", { exact: true }).click();
  await expect(lifecycle).toContainText("gh auth status failed");

  const evidenceDir = join("e2e", ".artifacts", "pipeline-provider-readiness");
  mkdirSync(evidenceDir, { recursive: true });
  await dashboard.screenshot({ path: join(evidenceDir, "blocked-readiness.png") });

  mkdirSync(join(daemon.repo, ".daemon"), { recursive: true });
  writeFileSync(join(daemon.repo, ".daemon", "READY"), "ready\n");
  await lifecycle.getByRole("button", { name: "Check again" }).click();
  await expect(lifecycle.getByText("Ready", { exact: true })).toBeVisible();
  const afterRecheck = await (await request(daemon, "/api/tasks")).json() as Array<{
    kind: string;
    sessionId: string | null;
  }>;
  expect(afterRecheck.find((candidate) => candidate.kind === "pipeline")?.sessionId).toBeNull();
  await lifecycle.getByRole("button", { name: "Start Engineer" }).click();
  await expect.poll(async () => {
    const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{
      kind: string;
      status: string;
      sessionId: string | null;
      error: string | null;
    }>;
    return tasks.find((candidate) => candidate.kind === "pipeline") ?? null;
  }, { timeout: 60_000 }).toMatchObject({
    status: "running",
    sessionId: expect.any(String),
    error: null,
  });
  await dashboard.screenshot({ path: join(evidenceDir, "ready-after-recheck.png") });
});

test("typed failure refuses task completion and retries once on a fresh host", async ({
  dashboard,
  daemon,
}) => {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  mkdirSync(join(daemon.repo, ".daemon"), { recursive: true });
  writeFileSync(join(daemon.repo, ".daemon", "READY"), "ready\n");
  const configured = await request(daemon, "/api/pipelines/config", "PUT", {
    enabled: true,
    launchRuntime: "agent-sdk",
    foremanMechanicalTriage: false,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });
  expect(configured.ok, await configured.text()).toBe(true);
  const board = await request(daemon, "/api/ui/config", "PUT", { layout: "board" });
  expect(board.ok, await board.text()).toBe(true);
  await dashboard.reload();
  const evidenceDir = join("e2e", ".artifacts", "pipeline-provider-readiness");
  mkdirSync(evidenceDir, { recursive: true });

  const intent = "Expose typed provider failure";
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();

  let taskId = "";
  let sessionId = "";
  await expect.poll(async () => {
    const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{
      id: string;
      intent: string;
      sessionId: string | null;
    }>;
    const task = tasks.find((candidate) => candidate.intent === intent);
    taskId = task?.id ?? "";
    sessionId = task?.sessionId ?? "";
    if (!sessionId) return null;
    const sessions = await (await request(daemon, "/api/sessions")).json() as Array<{
      id: string;
      state: string;
    }>;
    return sessions.find((session) => session.id === sessionId)?.state ?? null;
  }, { timeout: 60_000 }).toBe("idle");

  const card = dashboard.locator(".tile").filter({ hasText: /Expose Typed Provider Failure/i });
  await expect(card).toHaveClass(/tone-idle/);
  appendConductorEngineerEvent(daemon.home, "engineer_run_started");
  appendConductorEngineerEvent(daemon.home, "engineer_run_failed", {
    error: "gh auth status failed",
    class: "authentication",
    code: "authentication_required",
    summary: "Provider authentication failed",
    retryable: true,
    remedy: "Authenticate GitHub",
    diagnostic: "gh auth status failed",
  });

  await expect(card).toHaveClass(/tone-attention/);
  const reviewStage = dashboard
    .getByRole("navigation", { name: "The Line" })
    .getByRole("button", { name: /^Review,/ });
  await expect(reviewStage).toHaveAttribute("aria-label", /1 Pipeline needs you/);
  await dashboard.getByRole("button", { name: /to answer/ }).click();
  let inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox).toContainText("Provider authentication failed");
  await expect(inbox).toContainText("Authenticate GitHub");
  await dashboard.screenshot({ path: join(evidenceDir, "typed-failure-attention.png") });
  await inbox.getByRole("button", { name: "Close (esc)" }).click();

  const consoleLayout = await request(daemon, "/api/ui/config", "PUT", { layout: "console" });
  expect(consoleLayout.ok, await consoleLayout.text()).toBe(true);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Fleet", exact: true }).click();
  const rail = dashboard.locator("button.rail-row").filter({ hasText: /Expose Typed Provider Failure/i });
  await expect(rail.locator(".rail-state")).toHaveText("Provider authentication failed");
  await rail.click();
  const detail = dashboard.locator(".cdetail");
  await expect(detail).toHaveClass(/tone-attention/);
  await expect(detail.locator(".badge")).toContainText("Provider authentication failed");

  const completed = await request(daemon, `/api/tasks/${taskId}/complete`, "POST", {
    outcome: "Must not overwrite provider lifecycle",
  });
  expect(completed.status, await completed.text()).toBe(409);
  await expect(rail.locator(".rail-state")).toHaveText("Provider authentication failed");

  const boardAgain = await request(daemon, "/api/ui/config", "PUT", { layout: "board" });
  expect(boardAgain.ok, await boardAgain.text()).toBe(true);
  await dashboard.reload();
  const attentionColumn = dashboard.locator(".board-col.tone-attention");
  await expect(
    attentionColumn.locator(".tile").filter({ hasText: /Expose Typed Provider Failure/i }),
  ).toBeVisible();
  await dashboard.getByRole("button", { name: /to answer/ }).click();
  inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox).toContainText("Provider authentication failed");
  await inbox.getByRole("button", { name: "Open Pipeline" }).click();
  const recovery = dashboard.getByRole("region", { name: "Provider lifecycle" });
  await expect(recovery.getByRole("button", { name: "Retry Engineer" })).toBeVisible();
  const oldSessionId = sessionId;
  await recovery.getByRole("button", { name: "Retry Engineer" }).click();
  await expect.poll(async () => {
    const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{
      id: string;
      sessionId: string | null;
      status: string;
    }>;
    const task = tasks.find((candidate) => candidate.id === taskId);
    return task?.sessionId && task.sessionId !== oldSessionId
      ? { sessionId: task.sessionId, status: task.status }
      : null;
  }, { timeout: 60_000 }).toMatchObject({ sessionId: expect.any(String), status: "running" });
  const attempts = dashboard.getByRole("group", { name: "Engineer attempts" });
  await expect(attempts).toContainText("Attempt 1");
  await expect(attempts).toContainText("Attempt 2");
  await expect(attempts).toContainText("Mission Control attempt");
  await expect.poll(async () => {
    const sessions = await (await request(daemon, "/api/sessions")).json() as Array<{ id: string }>;
    return sessions.some((session) => session.id === oldSessionId);
  }, { timeout: 20_000 }).toBe(false);
  await dashboard.screenshot({ path: join(evidenceDir, "retry-fresh-host.png") });
});

test("an exact direct provider successor is reviewed and adopted without rewriting attempt one", async ({
  dashboard,
  daemon,
}) => {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  mkdirSync(join(daemon.repo, ".daemon"), { recursive: true });
  writeFileSync(join(daemon.repo, ".daemon", "READY"), "ready\n");
  const configured = await request(daemon, "/api/pipelines/config", "PUT", {
    enabled: true,
    launchRuntime: "agent-sdk",
    foremanMechanicalTriage: false,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });
  expect(configured.ok, await configured.text()).toBe(true);
  await dashboard.reload();

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await dialog.getByPlaceholder("What should this agent do?").fill("Adopt one exact successor");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();

  let taskId = "";
  let predecessorSessionId = "";
  await expect.poll(async () => {
    const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{
      id: string;
      intent: string;
      sessionId: string | null;
    }>;
    const task = tasks.find((candidate) => candidate.intent === "Adopt one exact successor");
    taskId = task?.id ?? "";
    predecessorSessionId = task?.sessionId ?? "";
    return predecessorSessionId || null;
  }, { timeout: 60_000 }).toEqual(expect.any(String));

  appendConductorEngineerEvent(daemon.home, "engineer_run_started");
  appendConductorEngineerEvent(daemon.home, "engineer_run_failed", {
    error: "provider failed",
    class: "provider",
    code: "provider_failed",
    summary: "Provider failed",
    retryable: true,
    remedy: "Choose retry or adopt the direct successor",
    diagnostic: null,
  });
  seedDirectConductorEngineerSuccessor(daemon.home);

  await dashboard.getByRole("button", { name: /to answer/ }).click();
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  await expect(inbox).toContainText("Provider failed");
  await inbox.getByRole("button", { name: "Open Pipeline" }).click();
  const lifecycle = dashboard.getByRole("region", { name: "Provider lifecycle" });
  await lifecycle.getByText("Review successor attempt 2", { exact: true }).click();
  await expect(lifecycle.getByRole("button", { name: "Adopt exact successor" })).toBeVisible({
    timeout: 60_000,
  });
  const [adoptedResponse] = await Promise.all([
    dashboard.waitForResponse((response) =>
      response.url().endsWith(`/api/tasks/${taskId}/pipeline/successor/adopt`)),
    lifecycle.getByRole("button", { name: "Adopt exact successor" }).click(),
  ]);
  expect(adoptedResponse.ok(), await adoptedResponse.text()).toBe(true);
  const attempts = dashboard.getByRole("group", { name: "Engineer attempts" });
  await expect(attempts).toContainText("Attempt 1");
  await expect(attempts).toContainText("Attempt 2");
  await expect(attempts).toContainText("Reconciled provider attempt");
  await expect.poll(async () => {
    const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{
      id: string;
      sessionId: string | null;
    }>;
    return tasks.find((candidate) => candidate.id === taskId)?.sessionId;
  }).toBeNull();
  await expect(lifecycle.getByRole("button", { name: "Adopt exact successor" })).toHaveCount(0);
  await expect(lifecycle.getByText("Recovery adoption replaying", { exact: true })).toHaveCount(0);
  await expect.poll(async () => {
    const sessions = await (await request(daemon, "/api/sessions")).json() as Array<{ id: string }>;
    return sessions.some((session) => session.id === predecessorSessionId);
  }, { timeout: 20_000 }).toBe(false);
  const evidenceDir = join("e2e", ".artifacts", "pipeline-provider-readiness");
  mkdirSync(evidenceDir, { recursive: true });
  await dashboard.screenshot({ path: join(evidenceDir, "adopt-direct-successor.png") });
});

test.describe("mixed-version provider", () => {
  test.use({
    daemonEnv: {
      MC_E2E_CONDUCTOR_ENGINEER_MODE: "legacy-lifecycle",
      MISSION_PIPELINE_TICK_MS: "500",
    },
  });

  test("legacy lifecycle remains explicit and exposes no recovery action", async ({
    dashboard,
    daemon,
  }) => {
    writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
    const configured = await request(daemon, "/api/pipelines/config", "PUT", {
      enabled: true,
      launchRuntime: "agent-sdk",
      foremanMechanicalTriage: false,
      repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
    });
    expect(configured.ok, await configured.text()).toBe(true);
    await dashboard.reload();

    await dashboard.getByRole("button", { name: "Dispatch" }).click();
    const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
    await dashboard.keyboard.press("Escape");
    await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
    await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
    await dialog.getByPlaceholder("What should this agent do?").fill("Keep legacy lifecycle honest");
    await dialog.getByRole("button", { name: "Dispatch now" }).click();

    await expect.poll(async () => {
      const tasks = await (await request(daemon, "/api/tasks")).json() as Array<{
        kind: string;
        sessionId: string | null;
      }>;
      return tasks.find((task) => task.kind === "pipeline")?.sessionId ?? null;
    }).not.toBeNull();
    await dashboard.getByRole("button", { name: "Runs", exact: true }).click();
    await dashboard.getByRole("tab", { name: /Pipelines 1/ }).click();
    const lifecycle = dashboard.getByRole("region", { name: "Provider lifecycle" });
    await expect(lifecycle).toContainText("Ownership legacy provider");
    await expect(lifecycle).toContainText("Legacy provider - no readiness gate advertised.");
    await expect(lifecycle.getByRole("button", { name: /Retry Engineer/ })).toHaveCount(0);
    await expect(lifecycle.getByRole("button", { name: /Check again/ })).toHaveCount(0);
    const evidenceDir = join("e2e", ".artifacts", "pipeline-provider-readiness");
    mkdirSync(evidenceDir, { recursive: true });
    await dashboard.screenshot({ path: join(evidenceDir, "legacy-lifecycle.png") });
  });
});
