import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  conductorWorktree,
  seedConductorDaemon,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";

/**
 * The phase meter on a real board card, driven end to end.
 *
 * WHAT ONLY THIS LAYER CAN SEE. `test/pipeline-phase-meter.test.ts` proves the fold and the
 * markup shape, and `test/board-card-items.test.ts` proves the registry gate exists. Neither
 * can see the chain this feature actually rests on: a real agent process lands in ANOTHER
 * PROGRAM's worktree, a real sweep discovers it, the daemon correlates it against that
 * program's files, the run's whole step list arrives over SSE as a separate collection, and
 * the browser joins the two on `(provider, repoRoot, slug)` to paint a bar. Every link in that
 * is owned by a different process, and the join is the only untyped hop in the dashboard.
 *
 * Nor can they see a POPOVER. The bubble is portalled to the body and painted only while a
 * segment is hovered or focused, so `renderToStaticMarkup` never renders one - which makes
 * this the one layer where "hovering a phase shows that phase's steps" is a checkable claim.
 *
 * Built like `session-driven-by-engine.spec.ts`, and for its reasons: a correlated session
 * cannot be dispatched into existence - the correlation exists BECAUSE the process arrives
 * through passive discovery - so the pane is real, discovery is on for this daemon only, and
 * nothing here asserts on the fleet as a whole. The agent in each pane is a symlink to `node`
 * NAMED `claude`, which is the shape `harnessOf` is built to recognise rather than a trick
 * played on it; it reads nothing and never exits, which is a fair imitation of a `--print`
 * turn seen from outside.
 *
 * No model tokens: nothing here launches a real agent, and the only engine involved is the
 * fake `conduct-ts` that `e2e/fixtures/conductor.ts` installs.
 */

/** Discovery on and brisk, and the engine's files read at the fastest cadence allowed. */
test.use({ daemonEnv: { MISSION_POLL_MS: "400", MISSION_PIPELINE_TICK_MS: "1000" } });

const EVIDENCE = artifactsDir("board-card-phase-meter");
/** Long enough for two discovery sweeps and a watch pass, short enough to fail rather than hang. */
const SETTLE = 25_000;

const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;

/** The pane-side agent: reads nothing, exits never. */
const PANE_AGENT = "setInterval(() => {}, 1 << 30);\n";

interface Pane {
  session: string;
  cleanup: () => void;
}

function startPane(cwd: string, tag: string): Pane {
  const dir = mkdtempSync(join(tmpdir(), "mc-e2e-meter-"));
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  symlinkSync(execPath, join(bin, "claude"));
  const script = join(dir, "agent.mjs");
  writeFileSync(script, PANE_AGENT);

  const session = `mc-e2e-${tag}-${process.pid}-${Date.now()}`;
  execFileSync(
    "tmux",
    [
      "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", cwd,
      `${join(bin, "claude")} ${script}`,
    ],
    { stdio: "pipe" },
  );
  return {
    session,
    cleanup: () => {
      spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function shoot(page: Page, target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-card-phase-meter/${name}.png`);
}

/**
 * Three features as the engine writes them, and the consent that makes them readable.
 *
 * A BUILDING one and TWO HALTED ones, because the meter's whole claim is that a halted feature
 * and a working one no longer look alike from across a board - and before it they did not.
 * `add-widgets` also carries a skipped step, so the hatch that tells "done" from "done, 1
 * skipped" apart is exercised on a real projection rather than only in a fixture.
 *
 * The two halts are deliberately different SHAPES, not two examples of one: `rate-limit-tuning`
 * halted with a step marked `failed`, and `slow-migration` halted DURING a step that is still
 * `in_progress`. Only the second one distinguishes "the meter states the halt" from "the meter
 * happens to have a red phase".
 */
async function seed(daemon: DaemonHandle): Promise<void> {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: {
      worktree: "done",
      memory: "done",
      explore: "done",
      complexity: "done",
      prd: "done",
      architecture_diagram: "skipped",
      architecture_review: "done",
      stories: "in_progress",
      conflict_check: "pending",
      plan: "pending",
      build: "pending",
      finish: "pending",
    },
    lastStep: "stories",
    tier: "M",
    track: "product",
  });
  seedConductorRun(daemon.repo, "rate-limit-tuning", {
    steps: {
      worktree: "done",
      memory: "done",
      explore: "done",
      plan: "done",
      acceptance_specs: "done",
      build: "done",
      wiring_check: "skipped",
      test_suite: "done",
      build_review: "failed",
      finish: "pending",
    },
    lastStep: "build_review",
    tier: "L",
    track: "technical",
    halt: "the build review found two blocking defects",
    haltClass: "needs-human",
  });
  // The THIRD run is the one the unit fixtures can only assert about: it halted DURING a step,
  // so its halting step is still `in_progress` and NO step is marked `failed`. The meter's
  // first cut hung the halt sentence off a phase whose tone had resolved to `failed`, which
  // made this run read as work in progress and said nothing about the halt anywhere. Seeded as
  // real engine files so the daemon's own reader is what produces the shape, rather than a
  // hand-built `PipelineRun` asserting the reachability it is trying to prove.
  seedConductorRun(daemon.repo, "slow-migration", {
    steps: {
      worktree: "done",
      memory: "done",
      explore: "done",
      plan: "done",
      acceptance_specs: "done",
      build: "in_progress",
      test_suite: "pending",
      finish: "pending",
    },
    lastStep: "build",
    tier: "M",
    track: "technical",
    halt: "the scope widened past the approved plan",
    haltClass: "needs-human",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });

  const response = await fetch(`${daemon.baseURL}/api/pipelines/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: daemon.repo, enabled: true }],
    }),
  });
  expect(response.ok, "the consent route should accept the seeded repository").toBeTruthy();

  await expect
    .poll(
      async () => {
        const view = (await (await fetch(`${daemon.baseURL}/api/pipelines/config`)).json()) as {
          status: { runs: number }[];
        };
        return view.status.reduce((total, repo) => total + repo.runs, 0);
      },
      { message: "all three seeded features should be projected first", timeout: SETTLE },
    )
    .toBe(3);
}

/** Put the dashboard in the Board layout, where the cards this spec is about are drawn. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon accepted the Board layout").toBe(true);
  // A RELOAD, not a hash navigation: the web store hydrates from `GET /api/ui/config` at boot
  // and paints from its `localStorage` mirror before that lands.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

/** The tile of the card whose pane is `session`, wherever the board put it. */
function tileFor(page: Page, session: string): Locator {
  return page.locator("main.board .tile").filter({ hasText: session });
}

test.describe("the phase meter on a board card", () => {
  test.skip(tmuxMissing, "tmux is not installed on this machine");

  const panes: Pane[] = [];
  test.afterEach(() => {
    for (const pane of panes.splice(0)) pane.cleanup();
  });

  test("a driven card shows how far its run has got, and a halted one is told apart", async ({
    dashboard,
    daemon,
  }) => {
    await seed(daemon);
    // Launched into the ENGINE's own worktrees, and nothing about either process says so -
    // only its working directory does.
    const building = startPane(conductorWorktree(daemon.repo, "add-widgets"), "building");
    panes.push(building);
    const halted = startPane(conductorWorktree(daemon.repo, "rate-limit-tuning"), "halted");
    panes.push(halted);

    await useBoardLayout(dashboard, daemon);
    const buildingTile = tileFor(dashboard, building.session);
    const haltedTile = tileFor(dashboard, halted.session);
    await expect(buildingTile).toHaveCount(1, { timeout: SETTLE });
    await expect(haltedTile).toHaveCount(1, { timeout: SETTLE });

    // (1) THE METER IS THERE, named by the run it is about, on the card rather than on a page
    // somebody has to navigate to.
    const meter = buildingTile.getByRole("group", { name: "add-widgets pipeline phases" });
    await expect(meter).toBeVisible({ timeout: SETTLE });
    // Five segments, one per phase of the engine's own sequence.
    await expect(meter.locator(".tpm-seg")).toHaveCount(5);
    // The phase word and the count, both read off the run rather than off the session's link -
    // the link carries a step and nothing else, so a card that could say this at all is a card
    // that performed the join.
    await expect(meter.locator(".tpm-now")).toHaveText("DECIDE");
    // 22, not the twelve steps the fixture's state file names: the daemon's projection fills
    // in every sequential step the provider has, so an unstarted one is `pending` rather than
    // absent. That is the shape a real card meets, and it is why the counts and the segment
    // widths are read off `run.steps` rather than off the state file.
    await expect(meter.locator(".tpm-count")).toHaveText("7/22");
    // No extras marker: this run carries no unplaceable and no out-of-band step, and an empty
    // marker would be a control that says nothing on the ordinary run.
    await expect(meter.locator(".tpm-extras")).toHaveCount(0);

    // (2) A HALTED RUN LOOKS DIFFERENT FROM A WORKING ONE, which is the failure the board
    // could not show before: both cards used to say one word each.
    const haltedMeter = haltedTile.getByRole("group", {
      name: "rate-limit-tuning pipeline phases",
    });
    await expect(haltedMeter).toBeVisible({ timeout: SETTLE });
    await expect(haltedMeter.locator(".tpm-now")).toHaveText("BUILD");
    // The failing phase is the ringed one AND the red one, from the shared tone vocabulary.
    await expect(haltedMeter.locator(".tpm-seg.workflow-failed.is-now")).toHaveCount(1);
    await expect(meter.locator(".tpm-seg.workflow-failed")).toHaveCount(0);
    // And the meter did not take the halt's attention mark for itself. A halt is a fact about
    // the RUN, so it asks for a person on the cluster head - which is not on the display
    // customization list at all, precisely so no setting can make a feature that needs you
    // look like one that does not. The meter is progress beside that, never instead of it.
    const haltedHead = dashboard
      .locator("button.board-pipeline-head")
      .filter({ hasText: "rate-limit-tuning" });
    await expect(haltedHead).toHaveClass(/needs-you/);
    await expect(haltedHead).toContainText("halted");
    await expect(
      dashboard.locator("button.board-pipeline-head").filter({ hasText: "add-widgets" }),
    ).not.toHaveClass(/needs-you/);

    await dashboard.mouse.move(0, 0);
    await shoot(dashboard, buildingTile, "01-building-card");
    await shoot(dashboard, haltedTile, "02-halted-card");

    // (3) HOVERING A SEGMENT OPENS THAT PHASE'S STEPS. The bubble is portalled to the body, so
    // it is addressed there rather than inside the tile.
    const decide = meter.locator(".tpm-seg").nth(2);
    await decide.hover();
    const popover = dashboard.locator(".tooltip.tt-rich");
    await expect(popover).toBeVisible();
    // Discovery can move a board card after hover. Keep the detailed assertions on the
    // supported keyboard-focus path so a stationary pointer cannot switch phase targets.
    await dashboard.mouse.move(0, 0);
    await decide.focus();
    await expect(popover).toContainText("DECIDE");
    await expect(popover).toContainText("Running");
    // Per-step states, which is the whole reason this has a popover and not a plain title:
    // one running, several done, and one the engine skipped for this run's tier.
    await expect(popover.locator(".tpm-pop-row")).toHaveCount(9);
    await expect(popover.locator(".tpm-pop-row.is-skipped")).toContainText("Architecture Diagram");
    await expect(popover.locator(".tpm-pop-row").filter({ hasText: "Stories" }))
      .toContainText("current");
    await shoot(dashboard, dashboard, "03-decide-popover");

    // The halted run's BUILD popover carries the halt's own sentence, so the reason a feature
    // stopped is readable from the board without opening anything.
    await decide.blur();
    await expect(popover).toHaveCount(0);
    const haltedBuild = haltedMeter.locator(".tpm-seg").nth(3);
    await haltedBuild.hover();
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Failed");
    await dashboard.mouse.move(0, 0);
    await haltedBuild.focus();
    await expect(popover.locator(".tpm-pop-foot")).toContainText(
      "Needs a human - the build review found two blocking defects",
    );
    await shoot(dashboard, dashboard, "04-halted-build-popover");

    // (4) AT A NARROW COLUMN. The bar is the one element on the card with no text to ellipsis,
    // so a width it cannot survive would be a squashed graphic rather than a truncated string.
    await dashboard.mouse.move(0, 0);
    await haltedBuild.blur();
    await dashboard.setViewportSize({ width: 900, height: 900 });
    await expect(meter.locator(".tpm-seg")).toHaveCount(5);
    // Every segment is still wide enough to aim at, which is what the `min-width` floor is
    // for: SETUP and UNDERSTAND hold one step each against DECIDE's nine.
    for (let index = 0; index < 5; index += 1) {
      const box = await meter.locator(".tpm-seg").nth(index).boundingBox();
      expect(box?.width ?? 0, `segment ${index} collapsed at a narrow column width`)
        .toBeGreaterThanOrEqual(8);
    }
    await shoot(dashboard, buildingTile, "05-building-card-narrow");
    await shoot(dashboard, haltedTile, "06-halted-card-narrow");
  });

  test("a run that halted mid-step says so, though no phase of it resolves to failed", async ({
    dashboard,
    daemon,
  }) => {
    // The repair this round is about, at the only layer that can prove the SHAPE is real
    // rather than merely permitted by the type. `slow-migration` halted while `build` was
    // running, so the daemon's own reader produces `halt !== null` beside an `in_progress`
    // step and no `failed` one - which is the case `classifyGroup` names as the reason
    // `halted` outranks `building`: "drawing it as `building` would say work is happening
    // that stopped." The meter used to say exactly that.
    await seed(daemon);
    const pane = startPane(conductorWorktree(daemon.repo, "slow-migration"), "midstep");
    panes.push(pane);
    await useBoardLayout(dashboard, daemon);

    const tile = tileFor(dashboard, pane.session);
    await expect(tile).toHaveCount(1, { timeout: SETTLE });
    const meter = tile.getByRole("group", { name: "slow-migration pipeline phases" });
    await expect(meter).toBeVisible({ timeout: SETTLE });

    // The precondition, asserted rather than assumed: nothing on this bar is red by the phase
    // fold's own reckoning, because no step is failed. A run that silently arrived with a
    // failed step would pass the rest of this test while proving nothing.
    await expect(meter.locator(".tpm-seg.workflow-failed")).toHaveCount(0);
    await expect(meter.locator(".tpm-seg.workflow-running.is-now")).toHaveCount(1);

    // And the card says HALTED anyway - as a word, so it does not depend on anyone seeing the
    // difference between blue and red, and on the caption, because the halt is a fact about
    // the run rather than about a phase.
    const halted = meter.locator(".tpm-halt");
    await expect(halted).toHaveText("halted");
    await expect(meter.locator(".tpm-now.workflow-failed")).toHaveText("BUILD");
    await shoot(dashboard, tile, "07-halted-mid-step-card");

    // Hovering it gives the class, the reason, and what that class means for whoever has to
    // clear it - the same three facts the attention inbox leads with.
    await halted.hover();
    const popover = dashboard.locator(".tooltip.tt-rich");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Halted");
    await expect(popover).toContainText("Needs a human");
    await expect(popover).toContainText("the scope widened past the approved plan");
    await expect(popover.locator(".tpm-pop-foot")).toContainText(
      "Only an operator can clear this one",
    );
    await shoot(dashboard, dashboard, "08-halted-mid-step-popover");

    // The phase the run stopped in repeats the sentence, since no phase failed to claim it -
    // so an operator who opens the ringed segment first still finds the reason there.
    await dashboard.mouse.move(0, 0);
    await expect(popover).toHaveCount(0);
    await meter.locator(".tpm-seg").nth(3).hover();
    await expect(popover.locator(".tpm-pop-foot")).toContainText(
      "Needs a human - the scope widened past the approved plan",
    );
  });

  test("unchecking the display item removes the meter and leaves the run's frame alone", async ({
    dashboard,
    daemon,
  }) => {
    // The meter is progress, so it is operator-toggleable like the workflow ladder beside it.
    // What must NOT go with it is the cluster head that names the run, or the attention flag
    // on a halted card: no setting may make a session that needs you look like one that does
    // not, and that is the line the registry draws.
    await seed(daemon);
    const pane = startPane(conductorWorktree(daemon.repo, "add-widgets"), "toggle");
    panes.push(pane);
    await useBoardLayout(dashboard, daemon);

    const tile = tileFor(dashboard, pane.session);
    await expect(tile).toHaveCount(1, { timeout: SETTLE });
    await expect(tile.locator(".tile-phase-meter")).toHaveCount(1, { timeout: SETTLE });
    // The head above it, which is what makes the removal below a claim about one region.
    await expect(dashboard.locator("button.board-pipeline-head")).toHaveCount(1);

    await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
    const item = dashboard.getByRole("checkbox", { name: "Pipeline phases", exact: true });
    await expect(item).toBeChecked();
    // The preview draws it too, so the checkbox is visibly connected to something rather than
    // looking like a dead control on a fixture that cannot populate it.
    const preview = dashboard.locator(".board-card-preview-stage .tile");
    await expect(preview.locator(".tile-phase-meter")).toHaveCount(1);
    await item.uncheck();
    await expect(preview.locator(".tile-phase-meter")).toHaveCount(0);

    // Back to the board: the preference is stored in the daemon, so it has to survive the
    // navigation rather than living in the settings page's React state.
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    await expect(tile).toHaveCount(1);
    await expect(tile.locator(".tile-phase-meter")).toHaveCount(0);
    await expect(tile.locator(".tpm-seg")).toHaveCount(0);
    // Still a card, still framed by its run.
    await expect(tile.locator(".tile-name")).toHaveCount(1);
    await expect(dashboard.locator("button.board-pipeline-head")).toHaveCount(1);

    // And back, which is the half that proves this is a preference rather than a one-way trim.
    await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
    await dashboard.getByRole("checkbox", { name: "Pipeline phases", exact: true }).check();
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    await expect(tile.locator(".tile-phase-meter")).toHaveCount(1);
  });
});
