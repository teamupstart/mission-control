import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import {
  readConductorInvocations,
  seedConductorDaemon,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

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

test("SDK pipeline dispatch invokes Engineer directly and stays provider-owned", async ({
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
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: daemon.repo,
        slug: "build-the-sdk-hosted-pipeline-route",
      },
    });
  await expect
    .poll(() => codexPrompts(daemon)[0], {
      message: "the SDK host should receive the direct Engineer command as turn one",
    })
    .toBe(`$engineer - run this skill now. ${intent}`);
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

test("terminal pipeline normalizes a stale non-Claude agent before dispatch", async ({
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

  await expect
    .poll(
      async () =>
        (
          await request<Array<{ agent: string; kind: string; status: string }>>(
            daemon,
            "/api/tasks",
          )
        ).find((task) => task.kind === "pipeline"),
      { message: "the terminal pipeline task should carry the normalized Claude host" },
    )
    .toMatchObject({ agent: "claude", kind: "pipeline", status: "running" });
});

test("an open pipeline dispatch follows a live host runtime change", async ({
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

  await expect(dialog.getByText(/Terminal is Claude-only/)).toBeVisible();
  await expect(agent).toBeDisabled();
  await expect(agent).toHaveValue("claude");
  await shoot(dashboard, "07-terminal-pipeline-live-runtime-normalized", dialog);

  await dialog
    .getByPlaceholder("What should this agent do?")
    .fill("Follow the live terminal pipeline host setting");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(
      async () =>
        (
          await request<Array<{ agent: string; kind: string; status: string }>>(
            daemon,
            "/api/tasks",
          )
        ).find((task) => task.kind === "pipeline"),
      { message: "the live runtime change should dispatch the normalized Claude host" },
    )
    .toMatchObject({ agent: "claude", kind: "pipeline", status: "running" });
});

test("guided dispatch offers pipeline only in an enabled repo and launches a real terminal home", async ({
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
  await expect(dialog.getByText(/Terminal is Claude-only and opens conduct-ts engineer --idea/)).toBeVisible();
  await expect(dialog.getByText(/live stdin and removes the inherited Claude nesting marker/)).toBeVisible();
  await expect(dialog.getByText(/provider projection owns task completion/)).toBeVisible();
  await shoot(dashboard, "01-pipeline-dispatch", dialog);

  const intent = "Ship the phase six pipeline weave";
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(
      async () =>
        (
          await request<Array<{
            kind: string;
            status: string;
            sessionId: string | null;
            homeName: string | null;
            pipelineRun: { provider: string; repoRoot: string; slug: string } | null;
          }>>(
            daemon,
            "/api/tasks",
          )
        ).find((task) => task.kind === "pipeline"),
      { message: "the pipeline task should own a running terminal home" },
    )
    .toMatchObject({
      kind: "pipeline",
      status: "running",
      sessionId: null,
      homeName: expect.any(String),
      pipelineRun: {
        provider: "ai-conductor",
        repoRoot: daemon.repo,
        slug: "ship-the-phase-six-pipeline-weave",
      },
    });

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
