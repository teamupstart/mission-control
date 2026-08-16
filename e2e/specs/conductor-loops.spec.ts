import { mkdirSync } from "node:fs";

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
): Promise<void> {
  writeConductorProjects(daemon.home, [
    { name: "demo-repo", path: daemon.repo },
    { name: "second-repo", path: daemon.secondRepo },
  ]);
  await request(daemon, "/api/pipelines/config", "PUT", {
    enabled: true,
    foremanMechanicalTriage,
    repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
  });
}

test("guided dispatch offers pipeline only in an enabled repo and launches a real terminal home", async ({
  dashboard,
  daemon,
}) => {
  await enablePipelines(daemon);

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  const repo = dialog.getByPlaceholder("search repos or type a path…");
  const kind = dialog.getByRole("combobox", { name: "Kind", exact: true });

  await repo.fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(0);

  await repo.fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await expect(kind.locator('option[value="pipeline"]')).toHaveCount(1);

  await dialog.getByRole("switch", { name: "Guided" }).click();
  await expect(repo).toBeFocused();
  await dashboard.keyboard.press("Enter");
  const choices = dialog.getByRole("listbox", { name: "What kind of run is this?" });
  await expect(choices.getByRole("option", { name: /^pipeline/ })).toBeVisible();
  await choices.getByRole("option", { name: /^pipeline/ }).click();

  await expect(dialog.getByRole("navigation", { name: "Guided dispatch" })).toHaveCount(0);
  await expect(kind).toHaveValue("pipeline");
  await expect(dialog.getByRole("combobox", { name: "Agent", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "Model", exact: true })).toBeDisabled();
  await expect(dialog.getByText(/always launch conductor in a real terminal/)).toBeVisible();
  await expect(dialog.getByText(/refuses nested SDK sessions/)).toBeVisible();
  await shoot(dashboard, "01-pipeline-dispatch", dialog);

  const intent = "Ship the phase six pipeline weave";
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(
      async () =>
        (
          await request<Array<{ kind: string; status: string; homeName: string | null }>>(
            daemon,
            "/api/tasks",
          )
        ).find((task) => task.kind === "pipeline"),
      { message: "the pipeline task should own a running terminal home" },
    )
    .toMatchObject({ kind: "pipeline", status: "running", homeName: expect.any(String) });

});

test("a projected pipeline pull request is adopted under pipeline provenance and appears in Shipped", async ({
  dashboard,
  daemon,
}) => {
  const url = "https://github.com/example/pipeline-demo/pull/606";
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
