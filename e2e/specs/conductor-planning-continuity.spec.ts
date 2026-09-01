import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  appendConductorEngineerEvent,
  readConductorEngineerRuns,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";
import { expect, test } from "../fixtures/test.ts";

test.use({
  daemonEnv: {
    MC_E2E_CONDUCTOR_ENGINEER_MODE: "supported",
    MISSION_POLL_MS: "400",
    MISSION_PIPELINE_TICK_MS: "500",
  },
});

const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;

interface ProviderWorker {
  name: string;
  cleanup: () => void;
}

/** Quote one argv word for the shell tmux uses to launch its command. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Start a provider-owned worker in the run worktree, exactly where discovery joins it. */
function startProviderWorker(cwd: string): ProviderWorker {
  const dir = mkdtempSync(join(tmpdir(), "mc-e2e-pipeline-worker-"));
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  symlinkSync(execPath, join(bin, "claude"));
  const script = join(dir, "worker.mjs");
  writeFileSync(script, "setInterval(() => {}, 1 << 30);\n");

  const name = `mc-e2e-pipeline-worker-${process.pid}-${Date.now()}`;
  execFileSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      "120",
      "-y",
      "40",
      "-c",
      cwd,
      `${shellWord(join(bin, "claude"))} ${shellWord(script)}`,
    ],
    { stdio: "pipe" },
  );

  return {
    name,
    cleanup: () => {
      spawnSync("tmux", ["kill-session", "-t", name], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

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

async function enablePipelines(daemon: DaemonHandle): Promise<void> {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  const response = await request(daemon, "/api/pipelines/config", "PUT", {
    enabled: true,
    launchRuntime: "agent-sdk",
    foremanMechanicalTriage: false,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });
  expect(response.ok, await response.text()).toBe(true);
}

test("a commissioned Pipeline card is immediate and an authoring checkout is not a run", async ({
  dashboard,
  daemon,
}) => {
  test.skip(tmuxMissing, "tmux is required to observe the provider-owned worker session");
  await enablePipelines(daemon);
  const layout = await request(daemon, "/api/ui/config", "PUT", { layout: "board" });
  expect(layout.ok, await layout.text()).toBe(true);
  await dashboard.reload();

  const authoring = join(daemon.repo, ".worktrees", "engineer-card-gap");
  mkdirSync(join(authoring, ".pipeline"), { recursive: true });

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await dialog
    .getByPlaceholder("What should this agent do?")
    .fill("Keep planning progress visible across workers");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();

  const card = dashboard.locator(".tile").filter({
    hasText: "Keep Planning Progress Visible Across Workers",
  });
  await expect(card).toBeVisible();
  await expect(card.getByRole("group", { name: /pipeline phases$/ })).toBeVisible();
  await expect(card.getByText("Starting Engineer")).toBeVisible();
  await expect(card.locator(".phase-segment.current")).toHaveCount(0);

  await expect
    .poll(async () => {
      const tasks = (await (await request(daemon, "/api/tasks")).json()) as Array<{
        id: string;
        kind: string;
        pipelineCommissionId: string | null;
      }>;
      const task = tasks.find((candidate) => candidate.kind === "pipeline");
      return task ? { id: task.id, pipelineCommissionId: task.pipelineCommissionId } : null;
    })
    .toMatchObject({ id: expect.any(String), pipelineCommissionId: expect.any(String) });
  const commissionedTask = (
    (await (await request(daemon, "/api/tasks")).json()) as Array<{
      id: string;
      kind: string;
      pipelineCommissionId: string | null;
    }>
  ).find((candidate) => candidate.kind === "pipeline")!;

  await card.click();
  await expect(dashboard.locator(".cdetail").getByPlaceholder(/^Reply to this session/)).toBeVisible();
  await dashboard.keyboard.press("Escape");

  const evidenceDir = join("e2e", ".artifacts", "conductor-planning-continuity");
  mkdirSync(evidenceDir, { recursive: true });
  await dashboard.screenshot({ path: join(evidenceDir, "board-immediate-normal.png") });
  await dashboard.setViewportSize({ width: 820, height: 900 });
  await expect(card).toBeVisible();
  await dashboard.screenshot({ path: join(evidenceDir, "board-immediate-narrow.png") });
  await dashboard.setViewportSize({ width: 1440, height: 900 });

  await dashboard.getByRole("button", { name: "Runs", exact: true }).click();
  await dashboard.getByRole("tab", { name: /Pipelines 1/ }).click();
  await expect(dashboard.getByText("engineer-card-gap", { exact: true })).toHaveCount(0);
  await expect(dashboard.getByRole("heading", { name: "Engineer planning" })).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "Engineer attempts" })).toBeVisible();

  appendConductorEngineerEvent(daemon.home, "engineer_run_started");
  appendConductorEngineerEvent(daemon.home, "engineer_step_started", {
    step: "architecture_review",
    stepAttempt: 1,
    provider: "openai",
    model: "gpt-5",
  });
  await expect(dashboard.getByText("Architecture Review", { exact: true }).first()).toBeVisible();
  await dashboard.getByRole("button", { name: "Fleet" }).click();
  await expect(card.getByText("Architecture Review", { exact: true })).toBeVisible();
  await dashboard.getByRole("button", { name: "Runs", exact: true }).click();
  await dashboard.getByRole("tab", { name: /Pipelines 1/ }).click();
  appendConductorEngineerEvent(daemon.home, "engineer_step_completed", {
    step: "architecture_review",
    stepAttempt: 1,
    completion: "accepted_result",
  });
  appendConductorEngineerEvent(daemon.home, "engineer_step_skipped", {
    step: "prd",
    stepAttempt: 1,
    reason: "technical track",
  });
  appendConductorEngineerEvent(daemon.home, "engineer_step_skipped", {
    step: "coherence_check",
    stepAttempt: 1,
    reason: "medium tier",
  });
  appendConductorEngineerEvent(daemon.home, "engineer_land_reconciled", {
    planSlug: "visible-pipeline-continuity",
    track: "technical",
    tier: "M",
    completed: ["architecture_review", "plan"],
    skipped: ["prd", "coherence_check"],
  });
  appendConductorEngineerEvent(daemon.home, "engineer_spec_handoff", {
    planSlug: "visible-pipeline-continuity",
    branch: "plan/visible-pipeline-continuity",
    prUrl: "https://github.com/example/demo/pull/42",
    outcome: "pr_opened",
    state: "awaiting_spec_merge",
  });
  appendConductorEngineerEvent(daemon.home, "engineer_run_settled", {
    outcome: "awaiting_spec_merge",
  });
  await expect(dashboard.getByText("Awaiting spec merge", { exact: true }).first()).toBeVisible();
  await expect(
    dashboard.getByRole("link", { name: "Open specification pull request" }),
  ).toHaveAttribute("href", "https://github.com/example/demo/pull/42");

  await daemon.crash();
  await daemon.restart();
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Runs", exact: true }).click();
  await dashboard.getByRole("tab", { name: /Pipelines 1/ }).click();
  await expect(dashboard.getByText("Awaiting spec merge", { exact: true }).first()).toBeVisible();

  const implementationWorktree = seedConductorRun(daemon.repo, "visible-pipeline-continuity", {
    tier: "M",
    track: "technical",
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  await expect
    .poll(
      async () => {
        const view = (await (await request(daemon, "/api/pipelines/config")).json()) as {
          status: Array<{ runs: number }>;
        };
        return view.status.reduce((total, repo) => total + repo.runs, 0);
      },
      {
        message: "the implementation run should be projected before its commission is read",
        timeout: 15_000,
      },
    )
    .toBe(1);
  const pipelineRail = dashboard.locator("aside.pipelines-rail");
  await expect(
    pipelineRail.getByRole("button", { name: /visible-pipeline-continuity/i }),
  ).toHaveCount(2);
  await pipelineRail
    .locator(".pipelines-repo")
    .filter({ hasText: "Planning" })
    .getByRole("button", { name: /visible-pipeline-continuity/i })
    .click();
  const commissionReader = dashboard.getByRole("region", { name: "Pipeline commission detail" });
  await expect(commissionReader.locator(".tpm-now")).toHaveText("BUILD · Build · step 13 of 22");
  await expect(
    commissionReader.getByText("Awaiting spec merge", { exact: true }),
  ).toHaveCount(0);
  await dashboard.screenshot({ path: join(evidenceDir, "runs-continuation.png") });

  const resumedTask = (
    (await (await request(daemon, "/api/tasks")).json()) as Array<{
      id: string;
      status: string;
      pipelineCommissionId: string | null;
      pipelineRun: { provider: string; repoRoot: string; slug: string } | null;
    }>
  ).find((candidate) => candidate.id === commissionedTask.id);
  expect(resumedTask).toMatchObject({
    id: commissionedTask.id,
    status: "running",
    pipelineCommissionId: commissionedTask.pipelineCommissionId,
    pipelineRun: {
      provider: "ai-conductor",
      repoRoot: daemon.repo,
      slug: "visible-pipeline-continuity",
    },
  });

  // The continuation is a later provider worker, not the managed planning host coming back.
  // Its real cwd is the exact projected run worktree, so passive process discovery must stamp
  // Session.pipeline from provider truth and use that link to recover the original task.
  const worker = startProviderWorker(implementationWorktree);
  try {
    await expect
      .poll(
        async () => {
          const sessions = (await (await request(daemon, "/api/sessions")).json()) as Array<{
            name: string;
            runtime: string;
            pipeline: {
              provider: string;
              repoRoot: string;
              slug: string;
              step: string | null;
            } | null;
            task: {
              id: string;
              pipelineCommissionId: string | null;
              pipelineRun: { provider: string; repoRoot: string; slug: string } | null;
            } | null;
          }>;
          const session = sessions.find((candidate) => candidate.name === worker.name);
          return session
            ? {
                runtime: session.runtime,
                pipeline: session.pipeline,
                task: session.task && {
                  id: session.task.id,
                  pipelineCommissionId: session.task.pipelineCommissionId,
                  pipelineRun: session.task.pipelineRun,
                },
              }
            : null;
        },
        {
          message: "the later provider worker should join the exact run and original task",
          timeout: 25_000,
        },
      )
      .toEqual({
        runtime: "terminal",
        pipeline: {
          provider: "ai-conductor",
          repoRoot: daemon.repo,
          slug: "visible-pipeline-continuity",
          step: "build",
        },
        task: {
          id: commissionedTask.id,
          pipelineCommissionId: commissionedTask.pipelineCommissionId,
          pipelineRun: {
            provider: "ai-conductor",
            repoRoot: daemon.repo,
            slug: "visible-pipeline-continuity",
          },
        },
      });

    await dashboard.getByRole("button", { name: "Fleet", exact: true }).click();
    const workerCard = dashboard.getByRole("button", {
      name: `Open ${worker.name}`,
      exact: true,
    });
    await expect(workerCard).toBeVisible();
    await workerCard.press("Enter");
    const detail = dashboard.locator(".cdetail");
    await expect(
      detail.getByRole("button", { name: "visible-pipeline-continuity · Build" }),
    ).toBeVisible();
    await expect(
      detail.getByText("Driven by ai-conductor - act through its run in Runs"),
    ).toBeVisible();
    await expect(detail.getByPlaceholder(/^Reply to this session/)).toHaveCount(0);
    await detail.screenshot({ path: join(evidenceDir, "worker-continuation.png") });

    const consoleLayout = await request(daemon, "/api/ui/config", "PUT", { layout: "console" });
    expect(consoleLayout.ok, await consoleLayout.text()).toBe(true);
    await dashboard.reload();
    await dashboard.getByRole("button", { name: "Fleet", exact: true }).click();
    const commissionProgress = "BUILD · Build · step 13 of 22. Open the complete commission in Runs.";
    await expect(
      dashboard.getByRole("button", { name: commissionProgress }).first(),
    ).toBeVisible();
    await dashboard.locator("button.rail-row").filter({ hasText: worker.name }).click();
    const consoleDetail = dashboard.locator(".cdetail");
    await expect(
      consoleDetail.getByRole("button", { name: commissionProgress }),
    ).toBeVisible();
    await consoleDetail.screenshot({ path: join(evidenceDir, "console-continuation.png") });
  } finally {
    worker.cleanup();
  }
});

test("a recoverable Engineer land refusal is visible everywhere until provider recovery", async ({
  dashboard,
  daemon,
}) => {
  await enablePipelines(daemon);
  const layout = await request(daemon, "/api/ui/config", "PUT", { layout: "board" });
  expect(layout.ok, await layout.text()).toBe(true);
  await dashboard.reload();

  const title = "Make Recoverable Engineer Refusals Visible";
  const refusal =
    "artifact stem hello-endpoint does not match reserved feature engineer-20260831-hello-endpoint";
  const refusalDescription =
    `Halted - Unclassified. ${refusal}. ` +
    "The engine recorded no class, so nothing here guesses one.";
  const evidenceDir = join("e2e", ".artifacts", "conductor-planning-continuity");
  mkdirSync(evidenceDir, { recursive: true });

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
  await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
  await dialog.getByPlaceholder("What should this agent do?").fill(title);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();

  const card = dashboard.locator(".tile").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect
    .poll(() => {
      try {
        return readConductorEngineerRuns(daemon.home).length;
      } catch {
        return 0;
      }
    }, {
      message: "the fake provider should reserve the Engineer run before events are emitted",
    })
    .toBe(1);

  appendConductorEngineerEvent(daemon.home, "engineer_run_started");
  appendConductorEngineerEvent(daemon.home, "engineer_step_started", {
    step: "architecture_review",
    stepAttempt: 1,
    provider: "openai",
    model: "gpt-5",
  });
  await expect(card.getByText("Architecture Review", { exact: true })).toBeVisible();

  appendConductorEngineerEvent(daemon.home, "engineer_land_refused", { reason: refusal });
  await expect(card.getByText("Engineer land refused", { exact: true })).toBeVisible();
  const boardHalt = card.getByText("halted", { exact: true });
  await expect(boardHalt).toBeVisible();
  await expect(boardHalt).toHaveAccessibleDescription(refusalDescription);
  await boardHalt.focus();
  await expect(dashboard.locator(".tooltip").getByText(refusal, { exact: true })).toBeVisible();
  await dashboard.screenshot({ path: join(evidenceDir, "recoverable-land-refusal-board.png") });

  await boardHalt.blur();
  await dashboard.setViewportSize({ width: 820, height: 900 });
  await expect(card).toBeVisible();
  await boardHalt.focus();
  await expect(dashboard.locator(".tooltip").getByText(refusal, { exact: true })).toBeVisible();
  await dashboard.screenshot({
    path: join(evidenceDir, "recoverable-land-refusal-board-narrow.png"),
  });
  await boardHalt.blur();
  await dashboard.setViewportSize({ width: 1440, height: 900 });

  await dashboard.getByRole("button", { name: "Runs", exact: true }).click();
  await dashboard.getByRole("tab", { name: /Pipelines 1/ }).click();
  const runsReader = dashboard.locator(".pipelines-reader");
  await expect(
    runsReader.locator(".tpm-now").getByText("Engineer land refused", { exact: true }),
  ).toBeVisible();
  const runsHalt = runsReader.getByText("halted", { exact: true });
  await expect(runsHalt).toHaveAccessibleDescription(refusalDescription);
  await runsHalt.focus();
  await expect(dashboard.locator(".tooltip").getByText(refusal, { exact: true })).toBeVisible();
  await dashboard.screenshot({ path: join(evidenceDir, "recoverable-land-refusal-runs.png") });

  const consoleLayout = await request(daemon, "/api/ui/config", "PUT", { layout: "console" });
  expect(consoleLayout.ok, await consoleLayout.text()).toBe(true);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Fleet", exact: true }).click();
  await dashboard.locator("button.rail-row").filter({ hasText: title }).click();
  const consoleDetail = dashboard.locator(".cdetail");
  const consoleMeter = consoleDetail.getByRole("group", { name: /pipeline phases$/ });
  await expect(
    consoleMeter.getByText("Engineer land refused", { exact: true }),
  ).toBeVisible();
  const consoleHalt = consoleMeter.getByText("halted", { exact: true });
  await expect(consoleHalt).toHaveAccessibleDescription(refusalDescription);
  await consoleHalt.focus();
  await expect(dashboard.locator(".tooltip").getByText(refusal, { exact: true })).toBeVisible();
  await dashboard.screenshot({
    path: join(evidenceDir, "recoverable-land-refusal-console.png"),
  });

  appendConductorEngineerEvent(daemon.home, "engineer_step_retried", {
    step: "architecture_review",
    stepAttempt: 2,
    reason: "provider access restored",
  });
  await expect(consoleMeter.getByText("Architecture Review", { exact: true })).toBeVisible();
  await expect(consoleMeter.getByText("Engineer land refused", { exact: true })).toHaveCount(0);
  await expect(consoleMeter.getByText("halted", { exact: true })).toHaveCount(0);
  await expect(dashboard.locator(".tt-desc").filter({ hasText: refusal })).toHaveCount(0);

  const boardLayout = await request(daemon, "/api/ui/config", "PUT", { layout: "board" });
  expect(boardLayout.ok, await boardLayout.text()).toBe(true);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Fleet", exact: true }).click();
  await expect(card.getByText("Architecture Review", { exact: true })).toBeVisible();
  await expect(card.getByText("halted", { exact: true })).toHaveCount(0);
  await dashboard.getByRole("button", { name: "Fleet", exact: true }).blur();
  await dashboard.screenshot({ path: join(evidenceDir, "provider-recovered-board.png") });

  await dashboard.getByRole("button", { name: "Runs", exact: true }).click();
  await dashboard.getByRole("tab", { name: /Pipelines 1/ }).click();
  await expect(
    runsReader.locator(".tpm-now").getByText("Architecture Review", { exact: true }),
  ).toBeVisible();
  await expect(runsReader.getByText("halted", { exact: true })).toHaveCount(0);
  await expect(dashboard.locator(".tt-desc").filter({ hasText: refusal })).toHaveCount(0);
});
