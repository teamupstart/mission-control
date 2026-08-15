import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  seedConductorDaemon,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";
import { pipelineRepoKey } from "../../src/shared/pipeline.ts";

/**
 * The Runs page's Pipelines tab: what an external SDLC engine is driving, read in Mission
 * Control.
 *
 * What only a browser can prove here. `test/pipeline-runs-view.test.ts` pins the projections
 * and the markup shape from hand-built runs, and `test/pipeline-http.test.ts` pins the routes'
 * refusals - but neither can see a consent reach the daemon, a watch pass read another
 * program's files, a projection cross the event stream, and a rail come back with the run
 * grouped under the repository it came from. That whole chain is what an operator is trusting
 * when they open this tab, and every link in it is a different program's.
 *
 * Four claims:
 *
 *  1. The tab is EARNED. It appears when a repository is being observed and not before.
 *  2. The rail groups per repository, under the engine daemon's own state - which is the
 *     distinction between "give it a moment" and "nothing is running to advance this".
 *  3. The detail is the run: its phase and position, its steps in the engine's order, its
 *     gate verdicts, and the attempt a kickback opened.
 *  4. It degrades rather than breaks. A step this build has never heard of is drawn in the
 *     state the engine reported, and a skipped one is not drawn as a pass.
 *
 * No model tokens: nothing here dispatches an agent, and the only engine involved is the fake
 * `conduct-ts` that `e2e/fixtures/conductor.ts` installs.
 */

// The fastest watch cadence the daemon allows, so a seeded feature is projected while the
// spec is still looking. Per file rather than in the shared list, for the reason
// `settings-conductor.spec.ts` states: five times the background polling in every other
// worker's daemon is a cost fifty specs would pay for two.
test.use({ daemonEnv: { MISSION_PIPELINE_TICK_MS: "1000" } });

const EVIDENCE = artifactsDir("runs-pipelines-tab");

/**
 * Photograph a state this spec has already asserted on. Behind `MC_E2E_EVIDENCE`.
 *
 * A page is shot `fullPage`, because the subject here is a horizontal strip inside a
 * scrolling reader: a viewport crop cuts the pull-request terminus off every frame, and the
 * Spec terminus is centred against the tallest card, which puts it below 720px too. A frame
 * that shows neither end of the pipeline is not evidence that the pipeline is drawn.
 */
async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  if ("mouse" in target) await target.mouse.move(0, 0);
  await target.screenshot({
    path: `${EVIDENCE}${name}.png`,
    ...("mouse" in target ? { fullPage: true } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/runs-pipelines-tab/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Two repositories of features, seeded exactly as the engine writes them.
 *
 * The second repository has no engine daemon alive, which is what makes the rail's daemon
 * chip say something: its features are `waiting` rather than `eligible`, and those two look
 * identical in the state file.
 */
async function seedFleet(daemon: DaemonHandle): Promise<void> {
  writeConductorProjects(daemon.home, [
    { name: "demo-repo", path: daemon.repo },
    { name: "second-repo", path: daemon.secondRepo },
  ]);

  // Real epoch milliseconds, minutes apart, rather than the 1-and-2 sentinels that would
  // order these just as well. The engine dates a verdict with `Date.now()`, and a surface
  // reading that number in the wrong unit renders every verdict in 1970 - which two
  // sentinels near the epoch cannot tell apart from a correct one. These also keep the
  // evidence frames honest: "answered 34m ago" is what an operator sees.
  const answered = Date.now();
  const PRD_AT = answered - 34 * 60_000;
  const PLAN_AT = answered - 11 * 60_000;

  // Mid-flight, with a gate that sent it back - so the detail has an attempt to draw.
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: {
      worktree: "done",
      memory: "done",
      explore: "done",
      complexity: "done",
      prd: "done",
      plan: "stale",
      build: "in_progress",
    },
    lastStep: "build",
    tier: "M",
    track: "product",
    gates: {
      prd: {
        satisfied: true,
        reason: "the product requirements are complete",
        checkedAt: PRD_AT,
      },
      plan: {
        satisfied: true,
        reason: "approved",
        checkedAt: PLAN_AT,
        kickbackFrom: "build_review",
      },
    },
  });
  // Halted, which is the state that wants a human and the one the rail leads with.
  seedConductorRun(daemon.repo, "fix-the-thing", {
    steps: { worktree: "done", build: "done", build_review: "failed" },
    lastStep: "build_review",
    tier: "L",
    track: "technical",
    halt: "the build review found two blocking defects",
    haltClass: "needs-human",
    gates: {
      build_review: { satisfied: false, reason: "two blocking defects", checkedAt: PLAN_AT },
    },
  });
  // Tier S: the engine records the ceremony it skipped as a satisfied gate with a `skipped:`
  // reason, and a surface reading `satisfied` alone would credit it with nine it never ran.
  // Plus a step this build's frozen table has never heard of.
  seedConductorRun(daemon.repo, "tiny-tweak", {
    steps: {
      worktree: "done",
      complexity: "skipped",
      architecture_review: "skipped",
      build: "done",
      vibe_check: "in_progress",
    },
    lastStep: "build",
    tier: "S",
    track: "technical",
    gates: {
      complexity: { satisfied: true, reason: "skipped: tier S", checkedAt: PRD_AT },
    },
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });

  seedConductorRun(daemon.secondRepo, "over-here", {
    steps: { worktree: "done", memory: "in_progress" },
    lastStep: "memory",
  });

  const response = await fetch(`${daemon.baseURL}/api/pipelines/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      repos: [
        { provider: "ai-conductor", repoRoot: daemon.repo, enabled: true },
        { provider: "ai-conductor", repoRoot: daemon.secondRepo, enabled: true },
      ],
    }),
  });
  expect(response.ok, "the consent route should accept both seeded repositories").toBeTruthy();

  await expect.poll(
    async () => {
      const view = await api<{ status: { runs: number }[] }>(daemon, "/api/pipelines/config");
      return view.status.reduce((total, repo) => total + repo.runs, 0);
    },
    { message: "every seeded feature should be projected before the page is read", timeout: 15_000 },
  ).toBe(4);
}

test("the tab is earned, and its rail groups the engine's features per repository", async ({
  dashboard,
  daemon,
}) => {
  await seedFleet(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/runs`);

  // Earned: the tab exists because a repository is being observed, and it counts what is
  // behind it.
  const tab = dashboard.getByRole("tab", { name: /Pipelines/ });
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText("Pipelines 4");
  await expect(tab).toHaveAttribute("aria-selected", "false");

  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  // The tab is an address, so the surface survives a reload and a shared link.
  expect(new URL(dashboard.url()).hash).toBe("#/runs/pipeline");
  // `exact` for the same reason the Workflows assertion below carries it: this page's empty
  // state, "No pipelines yet", contains the title under a substring name match.
  await expect(dashboard.getByRole("heading", { name: "Pipelines", exact: true })).toBeVisible();

  // Grouped per repository, under what the engine's own daemon is doing there. The second
  // repository has none running, which is why its features read `Waiting` rather than
  // `Ready` - the distinction an operator acts on, and the one the state file cannot make.
  await expect(dashboard.getByText("daemon running", { exact: true })).toBeVisible();
  await expect(dashboard.getByText("daemon stopped", { exact: true })).toBeVisible();
  await expect(dashboard.getByText("3 pipelines", { exact: true })).toBeVisible();
  await expect(dashboard.getByText("1 pipeline", { exact: true })).toBeVisible();

  // Halted leads: it is the only group waiting on a person.
  const rail = dashboard.locator("aside.pipelines-rail");
  await expect(rail.getByText(/^Halted 1$/)).toBeVisible();
  await expect(rail.getByText(/^Building 2$/)).toBeVisible();
  await expect(rail.getByText(/^Waiting 1$/)).toBeVisible();

  // And the tab opens on what needs somebody, rather than on nothing.
  await expect(dashboard.getByRole("heading", { name: "fix-the-thing" })).toBeVisible();
  await expect(dashboard.getByText("the build review found two blocking defects").first())
    .toBeVisible();
  await expect(dashboard.getByText("Needs a human")).toBeVisible();
  await shoot(dashboard, "01-rail-and-halt");

  // The workflow surface is one press away, and it is the page it always was - here, a
  // fleet that has never run a workflow, which is its own zero state rather than an empty
  // pipelines rail wearing a different title.
  await dashboard.getByRole("tab", { name: /Workflows/ }).click();
  expect(new URL(dashboard.url()).hash).toBe("#/runs");
  // `exact` because the page title and this fleet's empty state are both headings and the
  // second one CONTAINS the first: "No workflow runs yet" matches a substring name match, so
  // without it this reads as a strict-mode violation the moment both are on screen - which is
  // exactly the state the next line is here to assert.
  await expect(dashboard.getByRole("heading", { name: "Workflow runs", exact: true }))
    .toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "No workflow runs yet" })).toBeVisible();
  await expect(dashboard.getByRole("group", { name: /^Pipeline for/ })).toHaveCount(0);
});

test("one run's detail is drawn in the workflow diagram's grammar, from the engine's files", async ({
  dashboard,
  daemon,
}) => {
  await seedFleet(daemon);
  // Straight to the run, through the address later phases will link with.
  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/add-widgets`);

  await expect(dashboard.getByRole("tab", { name: /Pipelines/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The header: the live eyebrow naming the phase and the position, the engine's own key for
  // the feature as the title, and the facts it reported about it.
  await expect(dashboard.getByRole("heading", { name: "add-widgets" })).toBeVisible();
  await expect(dashboard.getByText(/BUILD · Build · step 13 of 22/)).toBeVisible();
  await expect(dashboard.getByText("Building", { exact: true }).first()).toBeVisible();
  await expect(dashboard.getByText("Tier M", { exact: true })).toBeVisible();
  await expect(dashboard.getByText("product", { exact: true })).toBeVisible();

  // The strip: both termini, every phase, and the wires saying what they cross.
  const strip = dashboard.getByRole("group", { name: "Pipeline for add-widgets" });
  await expect(strip).toBeVisible();
  for (const card of ["Spec", "SETUP", "UNDERSTAND", "DECIDE", "BUILD", "SHIP", "Pull request"]) {
    await expect(strip.getByText(card, { exact: true })).toBeVisible();
  }
  await expect(strip.getByText("spec approved")).toBeVisible();
  // A step's own state, and its gate's answer beside it.
  await expect(strip.getByText("PRD", { exact: true })).toBeVisible();
  await expect(strip.getByText("Gate passed").first()).toBeVisible();
  await expect(strip.getByText("Stale")).toBeVisible();

  // The kickback rule, stated once under the strip rather than drawn as four return edges.
  await expect(dashboard.getByText(/A refused gate sends the run back to/)).toBeVisible();

  // The attempt a recorded kickback opened, where the workflow reader puts its rounds.
  await expect(dashboard.getByRole("heading", { name: "Attempts" })).toBeVisible();
  await expect(dashboard.getByText("Attempt 2", { exact: true })).toBeVisible();
  await expect(dashboard.getByText("Build Review sent it back to Plan")).toBeVisible();

  // The gate evidence, read from the engine's own files at the moment it was asked for.
  const verdicts = dashboard.getByLabel("Gate verdicts");
  await expect(dashboard.getByRole("heading", { name: "Gate verdicts" })).toBeVisible();
  await expect(
    verdicts.getByText("the product requirements are complete", { exact: true }),
  ).toBeVisible();
  await expect(verdicts.getByText("Re-opened by Build Review", { exact: true })).toBeVisible();
  // The engine dates a verdict in epoch MILLISECONDS. Asserting the rendered age rather than
  // merely that some time is shown is what makes a unit mix-up fail here: seconds read as
  // milliseconds put every verdict in 1970, which renders perfectly happily as "20680d ago".
  // One minute of tolerance because `relativeTime` floors, so a slow seed tips 34m to 35m -
  // and a range this tight still fails by four orders of magnitude on the bug it is for.
  await expect(verdicts.getByText(/^answered 3[45]m ago$/)).toBeVisible();
  await expect(verdicts.getByText(/^answered 1[12]m ago$/)).toBeVisible();
  await shoot(dashboard, "02-run-detail");

  // No control on a read-only surface: the header's action slot is reserved for the verbs a
  // later phase adds, and a greyed-out button that cannot do anything is worse than none.
  const reader = dashboard.locator("div.pipelines-reader");
  await expect(reader.getByRole("button")).toHaveCount(0);
});

test("a tier-S run draws what it skipped, and an unknown step is drawn rather than dropped", async ({
  dashboard,
  daemon,
}) => {
  await seedFleet(daemon);
  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/tiny-tweak`);

  await expect(dashboard.getByRole("heading", { name: "tiny-tweak" })).toBeVisible();
  await expect(dashboard.getByText("Tier S", { exact: true })).toBeVisible();

  // A skipped step keeps its slot and wears the disabled treatment a command that cannot run
  // wears - dashed, with the same mark. Hiding it would leave a strip that does not match the
  // engine's own state file.
  const complexity = dashboard.locator("li.wf-pipeline-reviewer", { hasText: "Complexity" });
  await expect(complexity).toHaveClass(/is-disabled/);
  await expect(complexity.getByText("Skipped").first()).toBeVisible();
  // And the gate it wrote for that skip is not read as a pass, though the engine records
  // both as `satisfied: true`.
  await expect(complexity.getByText("Gate skipped")).toBeVisible();

  // A step this build's frozen table has never heard of: drawn, named, in the state the
  // engine reported, after every step it does know.
  await expect(dashboard.getByText("Unknown steps")).toBeVisible();
  const unknown = dashboard.locator("li.wf-pipeline-reviewer", { hasText: "vibe_check" });
  await expect(unknown.getByText("Unknown step")).toBeVisible();
  await expect(unknown.getByText("Running")).toBeVisible();
  await shoot(dashboard, "03-tier-s-and-unknown");
});

/**
 * The bare tab opens on the run that needs somebody, wherever on the fleet it is.
 *
 * Its own fleet rather than `seedFleet`'s, because the arrangement IS the subject: the halted
 * run has to live in a repository that is NOT first in the operator's list, with the earlier
 * repository holding something merely in flight. `seedFleet` cannot catch this - its halted
 * run is in the first repository, so a surface that simply took the first row it found would
 * pass it - and that is exactly the gap this covers.
 */
test("the tab opens on the halted run even when an earlier repository is busy", async ({
  dashboard,
  daemon,
}) => {
  writeConductorProjects(daemon.home, [
    { name: "demo-repo", path: daemon.repo },
    { name: "second-repo", path: daemon.secondRepo },
  ]);
  // First in the list, and nothing here wants a person.
  seedConductorRun(daemon.repo, "quietly-building", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  // Second in the list, and this is the one somebody has to look at.
  seedConductorRun(daemon.secondRepo, "stopped-for-a-human", {
    steps: { worktree: "done", build: "done", build_review: "failed" },
    lastStep: "build_review",
    halt: "the build review found a blocking defect",
    haltClass: "needs-human",
  });
  seedConductorDaemon(daemon.secondRepo, { pid: process.pid });

  const response = await fetch(`${daemon.baseURL}/api/pipelines/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      repos: [
        { provider: "ai-conductor", repoRoot: daemon.repo, enabled: true },
        { provider: "ai-conductor", repoRoot: daemon.secondRepo, enabled: true },
      ],
    }),
  });
  expect(response.ok, "the consent route should accept both seeded repositories").toBeTruthy();
  await expect.poll(
    async () => {
      const view = await api<{ status: { runs: number }[] }>(daemon, "/api/pipelines/config");
      return view.status.reduce((total, repo) => total + repo.runs, 0);
    },
    { message: "both seeded features should be projected", timeout: 15_000 },
  ).toBe(2);

  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline`);

  // The rail still lists the repositories in the operator's own order...
  const rail = dashboard.locator("aside.pipelines-rail");
  await expect(rail.locator("div.pipelines-repo").first()).toContainText("demo-repo");
  // ...and the reader still opened on the one that stopped, in the second of them.
  const reader = dashboard.locator("div.pipelines-reader");
  await expect(reader.getByRole("heading", { name: "stopped-for-a-human" })).toBeVisible();
  await expect(reader.getByText("the build review found a blocking defect")).toBeVisible();
  await expect(reader.getByRole("heading", { name: "quietly-building" })).toHaveCount(0);
});

test("a link to a pipeline that is no longer observed says so", async ({ dashboard, daemon }) => {
  await seedFleet(daemon);
  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/never-existed`);

  await expect(dashboard.getByRole("tab", { name: /Pipelines/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    dashboard.getByRole("heading", { name: "That pipeline is not being observed" }),
  ).toBeVisible();
  // With the way to find out why, which is the panel that owns detection and consent.
  await dashboard.locator("div.pipelines-reader")
    .getByRole("button", { name: /Conductor settings/ }).click();
  await expect(dashboard.getByRole("tab", { name: /Conductor/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
