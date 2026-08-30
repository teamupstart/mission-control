import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import {
  conductorWorktree,
  readConductorInvocations,
  readConductorEngineerRuns,
  seedConductorDaemon,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expect, test } from "../fixtures/test.ts";
import { PIPELINE_CALLER_CREDENTIAL_HEADER } from "../../src/shared/pipeline.ts";

/**
 * The three loops added around an external pipeline: dispatch, Inspector adoption, and
 * Foreman triage. The provider and terminal are both fakes, while every Mission Control
 * route, projection, worker decision, SQLite write, and browser surface is real.
 */
test.use({
  daemonEnv: {
    CLAUDECODE: "nested-e2e-parent",
    MISSION_PIPELINE_TICK_MS: "1000",
  },
});

const EVIDENCE = artifactsDir("conductor-loops");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/conductor-loops/${name}.png`);
}

async function request<T>(
  daemon: DaemonHandle,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function enablePipelines(
  daemon: DaemonHandle,
  foremanMechanicalTriage = false,
  launchRuntime: "agent-sdk" | "terminal" = "agent-sdk",
): Promise<void> {
  writeConductorProjects(daemon.home, [
    { name: "demo-repo", path: daemon.repo },
    { name: "second-repo", path: daemon.secondRepo },
  ]);
  await request(daemon, "/api/pipelines/config", "PUT", {
    enabled: true,
    launchRuntime,
    foremanMechanicalTriage,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });
}

test("concurrent duplicate Pipeline dispatches reserve only one Engineer run", async ({
  daemon,
}) => {
  await enablePipelines(daemon);
  const intent = "Keep duplicate Engineer work exclusive";
  const dispatch = (title: string) =>
    request<{ id: string }>(daemon, "/api/tasks", "POST", {
      repoRoot: daemon.repo,
      intent,
      title,
      kind: "pipeline",
      agent: "codex",
      backlog: false,
      workflowId: null,
    });

  await Promise.all([dispatch("Duplicate Pipeline one"), dispatch("Duplicate Pipeline two")]);

  await expect
    .poll(async () => {
      const tasks = (
        await request<Array<{
          intent: string;
          status: string;
          error: string | null;
          pipelineCommissionId: string | null;
        }>>(daemon, "/api/tasks")
      ).filter((task) => task.intent === intent);
      return {
        statuses: tasks.map((task) => task.status).sort(),
        activeCommissionCount: tasks.filter(
          (task) => task.status === "running" && task.pipelineCommissionId !== null,
        ).length,
        duplicateError: tasks.find((task) => task.status === "failed")?.error ?? null,
        engineerRuns: existsSync(join(daemon.home, "conductor-engineer-state.json"))
          ? readConductorEngineerRuns(daemon.home).length
          : 0,
      };
    })
    .toEqual({
      statuses: ["failed", "running"],
      activeCommissionCount: 1,
      duplicateError: expect.stringMatching(/already owned by active task/),
      engineerRuns: 1,
    });
});

const TERMINAL_COMMISSION_REFUSAL =
  "this provider version cannot deliver a reserved Engineer run through Terminal; use Managed Agent SDK";

async function expectTerminalCommissionRefused(
  daemon: DaemonHandle,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await request<Array<{
            kind: string;
            status: string;
            error: string | null;
            sessionId: string | null;
            homeName: string | null;
            pipelineRun: { provider: string; repoRoot: string; slug: string } | null;
          }>>(daemon, "/api/tasks")
        ).find((task) => task.kind === "pipeline"),
      { message },
    )
    .toMatchObject({
      kind: "pipeline",
      status: "failed",
      error: TERMINAL_COMMISSION_REFUSAL,
      sessionId: null,
      homeName: null,
      pipelineRun: null,
    });
}

/** User prompts recorded by the cost-free Codex SDK fixture. */
function codexPrompts(daemon: DaemonHandle): string[] {
  const sessions = join(daemon.home, ".codex", "sessions");
  try {
    return readdirSync(sessions, { recursive: true })
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => readFileSync(join(sessions, name), "utf8").trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        type?: string;
        payload?: { type?: string; message?: unknown };
      })
      .filter((entry) => entry.type === "event_msg" && entry.payload?.type === "user_message")
      .map((entry) => entry.payload?.message)
      .filter((message): message is string => typeof message === "string");
  } catch {
    return [];
  }
}

/** Opaque capability the daemon handed only to this fake managed host's MCP registration. */
function codexPipelineCallerCredential(daemon: DaemonHandle): string | null {
  const records = recordsIn<{ argv?: string[] }>(join(daemon.recordDir, "codex"));
  for (const record of records) {
    for (const arg of record.argv ?? []) {
      const match = arg.match(/"MISSION_PIPELINE_CALLER_CREDENTIAL"="([A-Za-z0-9_-]{43})"/);
      if (match) return match[1]!;
    }
  }
  return null;
}

const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;

/** A cost-free provider worker whose cwd lets the real discovery pass correlate it. */
function startProviderWorker(cwd: string): { name: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mc-e2e-pipeline-adoption-"));
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  symlinkSync(execPath, join(bin, "claude"));
  const script = join(dir, "worker.mjs");
  writeFileSync(script, "setInterval(() => {}, 1 << 30);\n");
  const name = `mc-e2e-adopt-worker-${process.pid}-${Date.now()}`;
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
      `${join(bin, "claude")} ${script}`,
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

test("SDK pipeline dispatch tracks the Engineer workspace without becoming provider-owned", async ({
  dashboard,
  daemon,
}) => {
  await enablePipelines(daemon);

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const repo = dialog.getByPlaceholder("search repos or type a path…");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  await repo.fill(daemon.repo);
  await dashboard.keyboard.press("Escape");

  await dialog.getByRole("button", { name: "Add another repo" }).click();
  await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Attach repo" }).click();
  const agent = dialog.getByRole("combobox", { name: "Agent", exact: true });
  await agent.selectOption("pi");
  await kind.selectOption("pipeline");

  await expect
    .poll(async () => ({
      enabled: await agent.isEnabled(),
      agents: await agent.locator("option").evaluateAll((options) =>
        options.map((option) => option.getAttribute("value") ?? "").sort(),
      ),
    }))
    .toEqual({ enabled: true, agents: ["claude", "codex"] });
  await agent.selectOption("codex");
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: /Effort/ })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "After work", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add another repo" })).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` }),
  ).toHaveCount(0);
  await expect(dialog.getByText(/Managed Agent SDK starts the selected Claude or Codex host/)).toBeVisible();
  await expect(dialog.getByText(/harness's configured defaults/)).toBeVisible();
  await expect(dialog.getByText(/provider projection owns task completion/)).toBeVisible();
  await expect(dialog.getByText(/does not fall back to Terminal/)).toBeVisible();
  await expect(dialog.getByText(/background build daemon keeps its own tmux supervision/)).toBeVisible();
  await shoot(dashboard, "04-sdk-pipeline-dispatch", dialog);

  const desktopViewport = dashboard.viewportSize();
  await dashboard.setViewportSize({ width: 420, height: 900 });
  const narrowBox = await dialog.boundingBox();
  expect(narrowBox).not.toBeNull();
  expect(narrowBox!.x).toBeGreaterThanOrEqual(0);
  expect(narrowBox!.x + narrowBox!.width).toBeLessThanOrEqual(420);
  await shoot(dashboard, "05-sdk-pipeline-dispatch-narrow", dialog);
  if (desktopViewport) await dashboard.setViewportSize(desktopViewport);

  const intent = "Build the SDK-hosted pipeline route";
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(
      async () =>
        (
          await request<Array<{
            agent: string;
            kind: string;
            status: string;
            sessionId: string | null;
            homeName: string | null;
            pipelineCommissionId: string | null;
            pipelineRun: { provider: string; repoRoot: string; slug: string } | null;
          }>>(daemon, "/api/tasks")
        ).find((task) => task.kind === "pipeline"),
      { message: "the pipeline task should own a running SDK session" },
    )
    .toMatchObject({
      agent: "codex",
      kind: "pipeline",
      status: "running",
      sessionId: expect.stringMatching(/^sdk:/),
      homeName: null,
      pipelineCommissionId: expect.any(String),
      pipelineRun: null,
    });
  const tasks = await request<Array<{
    id: string;
    kind: string;
    sessionId: string | null;
  }>>(daemon, "/api/tasks");
  const task = tasks.find((candidate) => candidate.kind === "pipeline");
  expect(task?.sessionId).toMatch(/^sdk:/);
  let engineerRunId = "";
  await expect
    .poll(() => {
      engineerRunId = readConductorEngineerRuns(daemon.home).at(-1)?.engineerRunId ?? "";
      return engineerRunId;
    })
    .toMatch(/^engineer-e2e-/);
  await expect
    .poll(() => codexPrompts(daemon)[0], {
      message: "the SDK host should receive the direct Engineer command as turn one",
    })
    .toBe(
      `$engineer - run this skill now. ${intent}\n\n` +
      `[Pipeline Engineer lifecycle context: the provider reserved Engineer run ${engineerRunId}. ` +
      "Pass that exact id as --engineer-run-id when creating the authoring worktree. " +
      "After Engineer creates or enters that worktree, call report_pipeline_workspace with " +
      "its absolute path before editing files there.]",
    );

  // Engineer authors the spec outside the host's fixed SDK cwd. This is the real shape
  // behind the regression: the interactive session remains in the main checkout while the
  // skill moves all Git-visible work into a provider-owned authoring worktree.
  const authoring = join(daemon.repo, ".worktrees", "engineer-sdk-hosted-pipeline-route");
  mkdirSync(join(daemon.repo, ".worktrees"), { recursive: true });
  execFileSync(
    "git",
    [
      "-C",
      daemon.repo,
      "worktree",
      "add",
      "-b",
      "spec/sdk-hosted-pipeline-route",
      authoring,
      "HEAD",
    ],
    { stdio: "pipe" },
  );
  writeFileSync(join(authoring, "pipeline-change.html"), "<h1>Pipeline workspace</h1>\n");

  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  let callerCredential: string | null = null;
  await expect
    .poll(() => {
      callerCredential = codexPipelineCallerCredential(daemon);
      return callerCredential;
    })
    .toMatch(/^[A-Za-z0-9_-]{43}$/);
  const reported = await fetch(`${daemon.baseURL}/mcp/pipelines/workspace`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": token,
      [PIPELINE_CALLER_CREDENTIAL_HEADER]: callerCredential!,
    },
    body: JSON.stringify({ path: authoring }),
  });
  expect(reported.status, await reported.text()).toBe(200);

  let hostName = "";
  await expect
    .poll(async () => {
      const sessions = await request<Array<{
        id: string;
        name: string;
        cwd: string | null;
        workspaceRoot?: string | null;
        pipeline: unknown;
      }>>(daemon, "/api/sessions");
      const host = sessions.find((candidate) => candidate.id === task!.sessionId);
      hostName = host?.name ?? "";
      return host && {
        cwd: host.cwd,
        workspaceRoot: host.workspaceRoot,
        pipeline: host.pipeline,
      };
    })
    .toEqual({ cwd: daemon.repo, workspaceRoot: authoring, pipeline: null });

  await request(daemon, "/api/ui/config", "PUT", { layout: "console" });
  await dashboard.reload();
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .filter({ hasText: hostName })
    .click();

  const detail = dashboard.locator(".console-detail");
  await expect(detail.locator(".detail-sub dd.mono").first()).toContainText(
    "engineer-sdk-hosted-pipeline-route",
  );
  const tabs = detail.getByRole("tablist", { name: "Session detail" });
  await tabs.getByRole("tab", { name: /Diff$/ }).click();
  const changed = detail.getByRole("navigation", { name: "Changed files" });
  await changed.getByRole("button", { name: /pipeline-change\.html/ }).click();
  await detail.getByRole("button", { name: "Open in Files" }).click();
  await expect(tabs.getByRole("tab", { name: /Files$/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    detail
      .getByRole("listbox", { name: "Session files" })
      .getByRole("option", { name: "pipeline-change.html" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    detail.frameLocator('iframe[title="Preview of pipeline-change.html"]').getByRole("heading", {
      name: "Pipeline workspace",
    }),
  ).toBeVisible();
  await shoot(dashboard, "10-managed-workspace-files", detail);
});

test.describe("managed Pipeline worker separation", () => {
  test.use({
    daemonEnv: {
      CLAUDECODE: "nested-e2e-parent",
      MISSION_PIPELINE_TICK_MS: "1000",
      // Passive terminal discovery, back ON for this block alone - the provider worker it
      // adopts is a real tmux session, and nothing else can see it.
      //
      // But SLOWLY. Discovery is a machine-wide sweep: two full `ps` reads plus a cwd
      // inspection per pid, and at 400ms that is two and a half of them a second inside the
      // daemon this test is also asking to launch an Agent SDK host. Under a loaded box the
      // host loses that race and exits during its own startup, which the task correctly
      // reports as "the managed Agent SDK host ended before Conductor created pipeline run"
      // - a real failure of a test that only ever meant to watch an adoption.
      //
      // It is also the reason a trace of this failing showed a REAL `claude` session from the
      // developer's machine carded inside this throwaway daemon, which is exactly what the
      // fixture's own `MISSION_POLL_MS: "0"` says to avoid. Discovery still has to run here,
      // so it cannot be zero. Give the managed host a wide startup window between sweeps;
      // the test waits for the worker's first observation before launching that host.
      MISSION_POLL_MS: "10000",
    },
  });
  test.skip(tmuxMissing, "tmux is not installed on this machine");

  test("an unrelated existing run does not turn the commissioned host into a worker", async ({
    dashboard,
    daemon,
  }) => {
    const adoptedSlug = "deploy-health-and-rds-connectivity";
    seedConductorRun(daemon.repo, adoptedSlug, {
      steps: { worktree: "done", build: "in_progress" },
      lastStep: "build",
      tier: "M",
      track: "technical",
    });
    seedConductorDaemon(daemon.repo, { pid: process.pid });
    await enablePipelines(daemon);
    const worker = startProviderWorker(conductorWorktree(daemon.repo, adoptedSlug));

    try {
      await expect
        .poll(
          async () => {
            const sessions = await request<Array<{
              name: string;
              pipeline: { slug: string } | null;
            }>>(daemon, "/api/sessions");
            return sessions.find((candidate) => candidate.name === worker.name)?.pipeline?.slug;
          },
          {
            message: "the provider worker should be observed before the managed host starts",
            timeout: 20_000,
          },
        )
        .toBe(adoptedSlug);

      await dashboard.getByRole("button", { name: "Dispatch" }).click();
      const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
      await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
      await dashboard.keyboard.press("Escape");
      await dialog.getByRole("combobox", { name: "Kind", exact: true }).selectOption("pipeline");
      await dialog.getByRole("combobox", { name: "Agent", exact: true }).selectOption("codex");
      await dialog
        .getByPlaceholder("What should this agent do?")
        .fill("Resume the managed deployment health run");
      await dialog.getByRole("button", { name: "Dispatch now" }).click();
      await expect(dialog).toBeHidden();

      type PipelineLink = { provider: string; repoRoot: string; slug: string };
      type PipelineTask = {
        id: string;
        kind: string;
        status: string;
        sessionId: string | null;
        pipelineCommissionId: string | null;
        pipelineRun: PipelineLink | null;
      };
      type PipelineSession = {
        id: string;
        name: string;
        runtime: string;
        state: string;
        cwd: string | null;
        agentSessionId: string | null;
        pipeline: (PipelineLink & { step: string | null }) | null;
        task: { id: string; pipelineRun: PipelineLink | null } | null;
      };

      let task: PipelineTask | undefined;
      let host: PipelineSession | undefined;
      let providerWorker: PipelineSession | undefined;
      await expect
        .poll(
          async () => {
            task = (
              await request<PipelineTask[]>(daemon, "/api/tasks")
            ).find((candidate) => candidate.kind === "pipeline");
            const sessions = await request<PipelineSession[]>(daemon, "/api/sessions");
            host = sessions.find((candidate) => candidate.id === task?.sessionId);
            providerWorker = sessions.find((candidate) => candidate.name === worker.name);
            return {
              task: task && {
                status: task.status,
                commissionId: task.pipelineCommissionId,
                slug: task.pipelineRun?.slug ?? null,
              },
              host: host && {
                runtime: host.runtime,
                state: host.state,
                pipeline: host.pipeline,
              },
              worker: providerWorker && {
                slug: providerWorker.pipeline?.slug ?? null,
                taskId: providerWorker.task?.id ?? null,
              },
            };
          },
          {
            message: "the commission host and unrelated provider worker should remain distinct",
            timeout: 30_000,
          },
        )
        .toEqual({
          task: { status: "running", commissionId: expect.any(String), slug: null },
          host: { runtime: "sdk", state: expect.stringMatching(/^(working|idle)$/), pipeline: null },
          worker: { slug: adoptedSlug, taskId: null },
        });

      expect(task).toBeDefined();
      expect(host).toBeDefined();
      expect(providerWorker).toBeDefined();

      await request(daemon, "/api/ui/config", "PUT", { layout: "board" });
      await dashboard.reload();
      const hostTile = dashboard.locator("div.tile").filter({ hasText: host!.name });
      await expect(hostTile).toBeVisible();
      await expect(
        dashboard.locator("div.board-cluster").filter({ hasText: providerWorker!.name }),
      ).toHaveCount(1);
      await expect(
        dashboard.locator("div.board-cluster").filter({ hasText: host!.name }),
      ).toHaveCount(0);

      await request(daemon, "/api/ui/config", "PUT", { layout: "console" });
      await dashboard.reload();
      const hostRow = dashboard
        .getByRole("navigation", { name: "Sessions" })
        .locator("button.rail-row")
        .filter({ hasText: host!.name });
      await hostRow.click();
      const detail = dashboard.locator(".console-detail");
      await expect(detail.getByPlaceholder(/^Reply to this session/)).toBeVisible();
      await expect(detail.locator("button.pipeline-chip")).toHaveCount(0);
      await expect
        .poll(async () => {
          const sessions = await request<PipelineSession[]>(daemon, "/api/sessions");
          return {
            host: sessions.find((candidate) => candidate.id === host!.id)?.pipeline ?? null,
            worker:
              sessions.find((candidate) => candidate.id === providerWorker!.id)?.pipeline?.slug ??
              null,
            workerTask:
              sessions.find((candidate) => candidate.id === providerWorker!.id)?.task?.id ?? null,
          };
        })
        .toEqual({ host: null, worker: adoptedSlug, workerTask: null });
    } finally {
      worker.cleanup();
    }
  });
});

test("guided managed Agent SDK pipeline asks for an eligible harness", async ({
  dashboard,
  daemon,
}) => {
  await enablePipelines(daemon);

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByRole("switch", { name: "Guided" }).click();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Enter");
  const kinds = dialog.getByRole("listbox", { name: "What kind of run is this?" });
  await kinds.getByRole("option", { name: /^pipeline/ }).click();

  const harnesses = dialog.getByRole("listbox", { name: "Which harness runs it?" });
  await expect
    .poll(async () => ({
      active: await harnesses.isVisible(),
      claude: await harnesses.getByRole("option", { name: /^Claude Code/ }).count(),
      codex: await harnesses.getByRole("option", { name: /^Codex/ }).count(),
      pi: await harnesses.getByRole("option", { name: /^Pi/ }).count(),
      total: await harnesses.getByRole("option").count(),
    }))
    .toEqual({ active: true, claude: 1, codex: 1, pi: 0, total: 2 });
  await harnesses.getByRole("option", { name: /^Codex/ }).click();
  await expect(harnesses).toBeHidden();
  await expect(dialog.getByRole("combobox", { name: "Agent", exact: true })).toHaveValue("codex");
  await expect(dialog.getByRole("combobox", { name: "After work", exact: true })).toBeDisabled();
});

test("terminal pipeline normalizes a stale non-Claude agent and refuses before spawn", async ({
  dashboard,
  daemon,
}) => {
  await enablePipelines(daemon, false, "terminal");

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const agent = dialog.getByRole("combobox", { name: "Agent", exact: true });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");

  await agent.selectOption("codex");
  await kind.selectOption("pipeline");

  await expect(agent).toBeDisabled();
  await expect(agent).toHaveValue("claude");
  await shoot(dashboard, "06-terminal-pipeline-agent-normalized", dialog);

  await dialog.getByPlaceholder("What should this agent do?").fill("Run the terminal pipeline host");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await expectTerminalCommissionRefused(
    daemon,
    "the terminal pipeline task should fail before launching the normalized Claude host",
  );
});

test("an open pipeline dispatch follows a live runtime change and refuses Terminal", async ({
  dashboard,
  daemon,
}) => {
  await enablePipelines(daemon);

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const agent = dialog.getByRole("combobox", { name: "Agent", exact: true });
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");

  await kind.selectOption("pipeline");
  await agent.selectOption("codex");
  await expect(agent).toBeEnabled();
  await expect(agent).toHaveValue("codex");

  await enablePipelines(daemon, false, "terminal");

  await expect(dialog.getByText(/cannot deliver a reserved Engineer run through Terminal/)).toBeVisible();
  await expect(agent).toBeDisabled();
  await expect(agent).toHaveValue("claude");
  await shoot(dashboard, "07-terminal-pipeline-live-runtime-normalized", dialog);

  await dialog
    .getByPlaceholder("What should this agent do?")
    .fill("Follow the live terminal pipeline host setting");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await expectTerminalCommissionRefused(
    daemon,
    "the live Terminal runtime should refuse before launching the normalized Claude host",
  );
});

test("guided dispatch offers pipeline only in an enabled repo and refuses commissioned Terminal", async ({
  dashboard,
  daemon,
}) => {
  await enablePipelines(daemon, false, "terminal");

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const repo = dialog.getByPlaceholder("search repos or type a path…");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });
  const agent = dialog.getByRole("combobox", { name: "Agent", exact: true });

  await repo.fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(0);

  await repo.fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(1);

  await dialog.getByRole("button", { name: "Add another repo" }).click();
  await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Attach repo" }).click();
  await expect(
    dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` }),
  ).toBeVisible();
  await agent.selectOption("pi");
  await expect(agent).toHaveValue("pi");

  await dialog.getByRole("switch", { name: "Guided" }).click();
  await expect(repo).toBeFocused();
  await dashboard.keyboard.press("Enter");
  const choices = dialog.getByRole("listbox", { name: "What kind of run is this?" });
  await expect(choices.getByRole("option", { name: /^pipeline/ })).toBeVisible();
  await choices.getByRole("option", { name: /^pipeline/ }).click();

  await expect(dialog.getByRole("navigation", { name: "Guided dispatch" })).toHaveCount(0);
  await expect(kind).toHaveValue("pipeline");
  await expect(
    dialog.getByRole("button", { name: `Detach repo: ${daemon.secondRepo}` }),
  ).toHaveCount(0);
  await expect(agent).toBeDisabled();
  await expect(agent).toHaveValue("claude");
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: /Effort/ })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "After work", exact: true })).toBeDisabled();
  await expect(dialog.getByText(/cannot deliver a reserved Engineer run through Terminal/)).toBeVisible();
  await expect(dialog.getByText(/new Pipeline dispatches refuse before spawn/)).toBeVisible();
  await expect(
    dialog.getByText(/Conductor still owns downstream agent, model, effort, and task completion/),
  ).toBeVisible();
  await shoot(dashboard, "01-pipeline-dispatch", dialog);

  const intent = "Ship the phase six pipeline weave";
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await expectTerminalCommissionRefused(
    daemon,
    "guided Terminal dispatch should refuse before creating a host or commission",
  );
});

test("a projected pipeline pull request is adopted under pipeline provenance and appears in Shipped", async ({
  dashboard,
  daemon,
}) => {
  const url = "https://github.com/example/pipeline-demo/pull/606";
  const fixtureOrigin = execFileSync(
    "git",
    ["-C", daemon.repo, "remote", "get-url", "origin"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  execFileSync(
    "git",
    [
      "-C",
      daemon.repo,
      "remote",
      "set-url",
      "origin",
      "https://github.com/example/pipeline-demo.git",
    ],
    { stdio: "pipe" },
  );
  try {
    seedConductorRun(daemon.repo, "ship-phase-six", {
      steps: { worktree: "done", ship: "done" },
      lastStep: "ship",
      prUrl: url,
      complete: true,
    });
    seedConductorDaemon(daemon.repo, { pid: process.pid });
    await enablePipelines(daemon);

    await expect
      .poll(async () => request<Array<{ url: string; source: string }>>(daemon, "/api/inspector/prs"), {
        message: "Inspector should adopt the projected pull request",
        timeout: 15_000,
      })
      .toContainEqual(expect.objectContaining({ url, source: "pipeline" }));

    await dashboard.goto(`${daemon.baseURL}/#/shipped`);
    const row = dashboard.getByRole("listitem").filter({ hasText: "#606" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link")).toHaveAttribute("href", url);
    await shoot(dashboard, "02-pipeline-pr-in-shipped", row);
  } finally {
    execFileSync(
      "git",
      ["-C", daemon.repo, "remote", "set-url", "origin", fixtureOrigin],
      { stdio: "pipe" },
    );
  }
});

test("Foreman acts on a mechanical halt through the provider route and leaves needs-human with the operator", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "retry-build", {
    steps: { worktree: "done", build: "failed" },
    lastStep: "build",
    halt: "the local build cache needs another pass",
    haltClass: "mechanical",
  });
  seedConductorRun(daemon.repo, "choose-product-scope", {
    steps: { worktree: "done", prd: "failed" },
    lastStep: "prd",
    halt: "the product boundary needs an operator decision",
    haltClass: "needs-human",
  });
  seedConductorDaemon(daemon.repo, {
    pid: process.pid,
    parked: ["retry-build", "choose-product-scope"],
  });
  await enablePipelines(daemon);

  await expect
    .poll(
      async () => {
        const view = await request<{ status: Array<{ runs: number }> }>(daemon, "/api/pipelines/config");
        return view.status.reduce((total, status) => total + status.runs, 0);
      },
      { message: "both halted runs should be projected", timeout: 15_000 },
    )
    .toBe(2);

  await dashboard.goto(`${daemon.baseURL}/#/settings/conductor`);
  const triage = dashboard.getByRole("checkbox", { name: "Triage mechanical pipeline halts" });
  const triageLabel = dashboard.locator(
    '.sc-card[data-anchor="conductor/foreman-triage"] label.sc-switch',
  );
  await expect(triage).not.toBeChecked();
  await triageLabel.click();
  await expect(triage).toBeChecked();
  await expect
    .poll(
      async () => {
        const view = await request<{ config: { foremanMechanicalTriage: boolean } }>(
          daemon,
          "/api/pipelines/config",
        );
        return view.config.foremanMechanicalTriage;
      },
      { message: "the default-off triage permission should persist before Foreman starts" },
    )
    .toBe(true);

  // Pipeline triage is a second permission under Foreman's own master switch. This spec
  // proves the new gate; the Foreman settings specs cover the master control itself.
  await request(daemon, "/api/foreman/config", "PUT", { enabled: true });
  await expect
    .poll(
      async () => request(daemon, "/api/pipelines/foreman"),
      { message: "the daemon should expose both current halts to the opted-in worker" },
    )
    .toMatchObject({
      enabled: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          handled: false,
          run: expect.objectContaining({
            slug: "retry-build",
            halt: expect.objectContaining({ class: "mechanical" }),
          }),
        }),
        expect.objectContaining({
          handled: false,
          run: expect.objectContaining({
            slug: "choose-product-scope",
            halt: expect.objectContaining({ class: "needs-human" }),
          }),
        }),
      ]),
    });
  await daemon.startForeman();
  try {
    await expect
      .poll(
        () =>
          readConductorInvocations(daemon.home)
            .filter((call) => call.argv[0] === "daemon" && call.argv[1] === "unpark")
            .map((call) => call.argv[2]),
        {
          message: "Foreman should drive exactly the mechanical halt through the action route",
          timeout: 15_000,
        },
      )
      .toEqual(["retry-build"]);
  } catch (error) {
    const episodes = await request(daemon, "/api/foreman/episodes");
    throw new Error(`${String(error)}\nForeman/daemon log:\n${daemon.readLog()}\nEpisodes: ${JSON.stringify(episodes)}`);
  }

  await expect
    .poll(async () => {
      const rows = await request<Array<{ classification: string; disposition: string }>>(
        daemon,
        "/api/foreman/episodes",
      );
      return rows.some(
        (episode) =>
          episode.classification === "mechanical" && episode.disposition === "answered",
      );
    }, { message: "the daemon should commit Foreman's answered pipeline episode" })
    .toBe(true);
  const episodes = await request<
    Array<{ id: number; classification: string; disposition: string }>
  >(daemon, "/api/foreman/episodes");
  const pipelineEpisode = episodes.find(
    (episode) => episode.classification === "mechanical" && episode.disposition === "answered",
  );
  expect(pipelineEpisode).toBeDefined();
  await expect(
    request<{ surface: string }>(daemon, `/api/foreman/episodes/${pipelineEpisode!.id}`),
  ).resolves.toMatchObject({ surface: "pipeline" });

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: /to answer/ }).click();
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  const human = inbox.locator("section.inbox-halt").filter({ hasText: "choose-product-scope" });
  await expect(human).toContainText("Needs a human");
  await expect(human).toContainText("the product boundary needs an operator decision");
  expect(
    readConductorInvocations(daemon.home).some(
      (call) => call.argv[0] === "daemon" && call.argv[1] === "unpark" && call.argv[2] === "choose-product-scope",
    ),
  ).toBe(false);
  await shoot(dashboard, "03-needs-human-stays-inbox", human);
});
