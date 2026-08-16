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
 * A conductor-driven agent, carded - and told apart from an ordinary one.
 *
 * WHAT IS AT STAKE. Mission Control cards any tty agent process with daemon ancestry, and
 * ai-conductor spawns its agents into a real pane in `--print` mode. So the fleet grows a card
 * that looks EXACTLY like an agent waiting for the operator's next instruction, live composer
 * and all, writing into a process that reads nothing at all. Every unit layer in this
 * repository can see one piece of the fix - the projection (`test/pipeline-correlation.test.ts`),
 * the fold (`test/pipeline-attention.test.ts`), the markup (`test/pipeline-session-card.test.ts`)
 * - and none of them can see a real agent process land in a real worktree, get discovered by a
 * real sweep, correlated against ANOTHER PROGRAM's files, and come back down the event stream
 * as a card that refuses to be typed at. That whole chain is what an operator is trusting, and
 * every link in it belongs to a different program.
 *
 * ## Why this spec is built like `session-interrupt-terminal.spec.ts`
 *
 * A terminal-runtime session cannot be dispatched into existence - `runtime: "terminal"` is
 * stamped in exactly one place (`registry.ts:mergeDiscovered`), so passive discovery is the
 * only door - and the suite turns discovery off everywhere else (`MISSION_POLL_MS: "0"`,
 * `daemon.ts`) because a machine-wide sweep adopts whatever agents the developer happens to be
 * running. This file turns it back on for its own daemon and pays for it by never asserting on
 * the fleet as a whole: it addresses its own cards by the tmux session names it generated.
 *
 * That is not a workaround here, it is the subject. The correlation exists BECAUSE the process
 * arrives through discovery rather than through dispatch, so a spec that faked a session would
 * be testing the one path the hazard cannot reach.
 *
 * The agent in each pane is a symlink to `node` NAMED `claude`, which is not a trick played on
 * the detector but the shape it is built to recognise - `harnessOf` matches argv0's basename
 * against each harness's declared `detect.commands`. It reads nothing and never exits, which
 * is a fair imitation of a `--print` turn seen from outside.
 *
 * No model tokens: nothing here launches a real agent, and the only engine involved is the
 * fake `conduct-ts` that `e2e/fixtures/conductor.ts` installs.
 */

/**
 * Discovery on and brisk, and the engine's files read at the fastest cadence the daemon
 * allows. This file's daemon only - see the header for why that is safe, and
 * `settings-conductor.spec.ts` for why a shared override would be a cost fifty specs pay.
 */
test.use({ daemonEnv: { MISSION_POLL_MS: "400", MISSION_PIPELINE_TICK_MS: "1000" } });

const EVIDENCE = artifactsDir("session-driven-by-engine");
/** Long enough for two discovery sweeps and a watch pass, short enough to fail rather than hang. */
const SETTLE = 25_000;

/**
 * Skipped rather than failed when tmux is absent, so a contributor without it is not blocked
 * by a spec about someone else's multiplexer. CI installs tmux for this suite, which is what
 * stops the skip from quietly turning this file into decoration.
 */
const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;

/** The pane-side agent: reads nothing, exits never. What a `--print` turn looks like from outside. */
const PANE_AGENT = "setInterval(() => {}, 1 << 30);\n";

interface Pane {
  session: string;
  cleanup: () => void;
}

/**
 * A real tmux session running something the daemon will discover as a Claude session, in `cwd`.
 *
 * The session name is unique per test so a parallel worker's pane - or a stray one from an
 * earlier run - can never be the card this spec drives.
 */
function startPane(cwd: string, tag: string): Pane {
  const dir = mkdtempSync(join(tmpdir(), "mc-e2e-engine-"));
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  // argv0's basename is what `harnessOf` matches, so the LINK's name is the whole disguise.
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

/** Photograph a state this spec has already asserted on. Behind `MC_E2E_EVIDENCE`. */
async function shoot(page: Page, target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it lands
  // on top of the chip being photographed.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/session-driven-by-engine/${name}.png`);
}

/**
 * Two features, exactly as the engine writes them, and the consent that makes them readable.
 *
 * The halted one is a DIFFERENT feature from the one the panes sit in, deliberately: a halt is
 * a fact about a RUN, and the agent that hit the gate has usually exited by the time anyone
 * looks - so the inbox row must not depend on there being a card behind it.
 */
async function seed(daemon: DaemonHandle): Promise<void> {
  // Written before the panel or the watch is asked for anything: the daemon caches its probe,
  // and the first read is what fills that cache.
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: {
      worktree: "done",
      memory: "done",
      explore: "done",
      prd: "done",
      plan: "done",
      build: "in_progress",
    },
    lastStep: "build",
    tier: "M",
    track: "product",
    gates: { prd: { satisfied: true, reason: "the product requirements are complete" } },
  });
  seedConductorRun(daemon.repo, "fix-the-thing", {
    steps: { worktree: "done", build: "done", build_review: "failed" },
    lastStep: "build_review",
    tier: "L",
    track: "technical",
    halt: "the build review found two blocking defects",
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
      {
        message: "both seeded features should be projected before the page is read",
        timeout: SETTLE,
      },
    )
    .toBe(2);
}

/**
 * Put the dashboard in one of the three layouts.
 *
 * Written to the daemon rather than to `localStorage`, because the web store hydrates from
 * `GET /api/ui/config` at boot and overwrites the local cache - the same idiom
 * `console-tabs-toolbar.spec.ts` uses.
 */
async function useLayout(page: Page, daemon: DaemonHandle, layout: string): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout }),
  });
  expect(((await response.json()) as { config?: { layout?: string } }).config?.layout).toBe(layout);
  await page.reload();
}

test.describe("a session an external engine is driving", () => {
  test.skip(tmuxMissing, "tmux is not installed on this machine");

  const panes: Pane[] = [];
  test.afterEach(() => {
    for (const pane of panes.splice(0)) pane.cleanup();
  });

  test("it is badged and cannot be typed at, while the agent beside it is untouched", async ({
    dashboard,
    daemon,
  }) => {
    await seed(daemon);

    // The whole point: this agent is launched into the engine's own worktree, and nothing
    // about the PROCESS says so. Only its working directory does.
    const driven = startPane(conductorWorktree(daemon.repo, "add-widgets"), "driven");
    panes.push(driven);
    // The control, in the SAME repository but outside every worktree. It is what makes the
    // badge the correlation's doing rather than the repository's.
    const ordinary = startPane(daemon.repo, "ordinary");
    panes.push(ordinary);

    // Find OUR cards by the tmux session names we generated. Never "the only card":
    // discovery is on, so the developer's own agents are on this fleet too.
    const drivenCard = dashboard.locator("article.card").filter({ hasText: driven.session });
    const ordinaryCard = dashboard.locator("article.card").filter({ hasText: ordinary.session });
    await expect(drivenCard).toHaveCount(1, { timeout: SETTLE });
    await expect(ordinaryCard).toHaveCount(1, { timeout: SETTLE });
    // The runtime is the precondition of the whole spec, and the card states it by naming the
    // pane it is bound to. Asserted rather than assumed: a build where discovery quietly
    // produced something else would leave every claim below testing a different path.
    await expect(drivenCard).toContainText(/tmux · %\d+/);

    // (1) THE BADGE, naming the run and the step - so two engine-driven agents on one board
    // are told apart by the feature they are on rather than by their pane ids.
    const chip = drivenCard.getByRole("button", { name: "add-widgets · Build" });
    await expect(chip).toBeVisible({ timeout: SETTLE });
    await expect(ordinaryCard.locator("button.pipeline-chip")).toHaveCount(0);

    // (2) THE POSTURE IS STILL DRAWN, and is no longer a control. An engine-driven agent must
    // not look SAFER than it is just because nobody can change its mode from here - and the
    // ordinary card proves the gate is the correlation's, because its picker is still a button.
    await expect(drivenCard.locator("span.mode")).toHaveCount(1);
    await expect(drivenCard.locator("button.mode-btn")).toHaveCount(0);
    await expect(ordinaryCard.locator("button.mode-btn")).toHaveCount(1);

    // (3) NO COMPOSER, and a sentence in its place. A DISABLED box says "not right now", which
    // is what a busy agent's looks like, so an operator waits for it to come back; this one
    // never does, and the card says who to act through instead.
    await drivenCard.click();
    await drivenCard.getByRole("button", { name: "Expand conversation" }).click();
    await expect(
      drivenCard.getByText("Driven by ai-conductor - act through its run in Runs"),
    ).toBeVisible();
    await expect(drivenCard.locator("textarea.transcript-input")).toHaveCount(0);
    await expect(drivenCard.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    // The way out is an ADDRESS, so it survives a middle click into a second window.
    await expect(drivenCard.getByRole("link", { name: "Open its run" })).toHaveAttribute(
      "href",
      /^#\/runs\/pipeline\/.+\/add-widgets$/,
    );
    await shoot(dashboard, drivenCard, "01-badged-card-no-composer");

    // (4) THE CONTROL, again: an agent in the same repository, outside every worktree, keeps
    // the composer exactly where it was. This is the fail-open guarantee on the surface an
    // operator with no engine installed looks at all day.
    await ordinaryCard.getByRole("button", { name: "Expand conversation" }).click();
    await expect(ordinaryCard.getByPlaceholder(/^Reply to this session/)).toBeVisible();
    await expect(ordinaryCard.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  });

  test("it groups under its run, on the board and in the console rail", async ({
    dashboard,
    daemon,
  }) => {
    await seed(daemon);
    const driven = startPane(conductorWorktree(daemon.repo, "add-widgets"), "grouped");
    panes.push(driven);
    await expect(
      dashboard.locator("article.card").filter({ hasText: driven.session }),
    ).toHaveCount(1, { timeout: SETTLE });

    // The board frames the sessions of one run and heads the frame with the run itself, which
    // is where "which feature is this agent on" is answered at a glance - the same frame an
    // ensemble's members get, because it is the same question.
    await useLayout(dashboard, daemon, "board");
    const frame = dashboard.locator("div.board-cluster").filter({ hasText: driven.session });
    await expect(frame).toHaveCount(1, { timeout: SETTLE });
    const head = frame.locator("button.board-pipeline-head");
    await expect(head).toContainText("add-widgets");
    // What the head knows comes from the RUN rather than from the session's link: the group it
    // is in, and the step it is on.
    await expect(head).toContainText("Building · Build");
    await shoot(dashboard, frame, "02-grouped-under-its-run");

    // And the same grouping at rail density, where the head is one line.
    await useLayout(dashboard, daemon, "console");
    const railGroup = dashboard.locator("button.rail-pipeline-group");
    await expect(railGroup).toHaveCount(1, { timeout: SETTLE });
    await expect(railGroup).toContainText("add-widgets");
  });

  test("its Workflows tab is the pipeline ladder, on the step the engine is running", async ({
    dashboard,
    daemon,
  }) => {
    await seed(daemon);
    const driven = startPane(conductorWorktree(daemon.repo, "add-widgets"), "ladder");
    panes.push(driven);
    await expect(
      dashboard.locator("article.card").filter({ hasText: driven.session }),
    ).toHaveCount(1, { timeout: SETTLE });

    // Into the conversation window, chosen off the rail the way a person chooses one.
    await useLayout(dashboard, daemon, "console");
    await dashboard
      .getByRole("navigation", { name: "Sessions" })
      .getByRole("button", { name: new RegExp(driven.session) })
      .click();
    const detail = dashboard.locator(".cdetail");
    await expect(detail).toBeVisible();
    await detail.getByRole("tab", { name: /Workflows/ }).click();

    const ladder = detail.locator("section.pipeline-ladder");
    await expect(ladder).toBeVisible({ timeout: SETTLE });
    await expect(ladder).toContainText("add-widgets");
    await expect(ladder).toContainText("ai-conductor");
    // The eyebrow the Runs page draws, in the pane beside the conversation: where in the
    // engine's own 22 steps this agent has got to.
    await expect(ladder).toContainText(/BUILD · Build · step \d+ of \d+/);

    // Every phase of the sequence, so what has not started is VISIBLE rather than absent.
    for (const phase of ["SETUP", "UNDERSTAND", "DECIDE", "BUILD", "SHIP"]) {
      await expect(ladder.locator("li.wf-ladder-rung").filter({ hasText: phase })).toHaveCount(1);
    }

    // The current step is haloed, and says so in a WORD - the single fact this pane exists to
    // deliver has to survive a reader who never sees the stylesheet. Its phase is the one that
    // arrives open, because a 22-step engine drawn flat is longer than the conversation.
    const current = ladder.locator("li.pipeline-ladder-step.is-current");
    await expect(current).toHaveCount(1);
    await expect(current).toContainText("Build");
    await expect(current).toContainText("current");

    // A gate's answer is read from the engine's own files and drawn beside the step that
    // earned it, in a phase the run has already walked past.
    const decide = ladder.locator("li.wf-ladder-rung").filter({ hasText: "DECIDE" });
    await decide.locator("summary").click();
    await expect(
      decide.locator("li.pipeline-ladder-step").filter({ hasText: "PRD" }),
    ).toContainText("Gate passed");

    // Photographed with both DECIDE and BUILD open, on a pane tall enough to hold the whole
    // ladder. The default viewport clips it around Build Review, and a frame that shows
    // neither the SHIP terminus nor the way out is not evidence that the ladder is drawn.
    await dashboard.setViewportSize({ width: 1440, height: 1200 });
    await expect(ladder.getByRole("button", { name: "Open in Runs" })).toBeInViewport();
    await shoot(dashboard, ladder, "03-pipeline-ladder");

    // The way out is the phase 2 address, so this ladder and the Runs page cannot disagree
    // about which run they are drawing.
    await ladder.getByRole("button", { name: "Open in Runs" }).click();
    await expect(dashboard.getByRole("tab", { name: /Pipelines/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      dashboard.locator("div.pipelines-reader").getByRole("heading", { name: "add-widgets" }),
    ).toBeVisible();
  });

  test("a halt reaches the attention inbox, with its class, its blocker and its runbook", async ({
    dashboard,
    daemon,
  }) => {
    // No pane at all in this one. A halt is the one obligation on the machine with no session
    // behind it - the engine stops dispatching, so the agent that hit the gate has exited -
    // and before this it was the most definitively stuck thing the drain could not show.
    await seed(daemon);

    const opener = dashboard.locator("button.pulse-seg", { hasText: "to answer" });
    await expect(opener).toBeVisible({ timeout: SETTLE });
    await opener.click();

    const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
    await expect(inbox.getByRole("heading", { name: "Pipeline halts" })).toBeVisible();
    // The subtitle enumerates the sections below it, so it had to grow when one did: a panel
    // headed "answers, decisions and stuck finalizations" over a halt reads as a panel showing
    // you less than it has.
    await expect(inbox.getByText("· answers, decisions, halts and stuck finalizations"))
      .toBeVisible();
    const row = inbox.locator("section.inbox-halt");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("fix-the-thing");
    await expect(row).toContainText("ai-conductor · Needs a human");
    await expect(row).toContainText("the build review found two blocking defects");
    await expect(row).toContainText("Only an operator can clear this one");
    await expect(row.locator("p.inbox-runbook")).toContainText(
      "Stalled or stuck feature - The halt refused a DECIDE entry",
    );
    // The verbs this halt's own class calls for, and only those: a `needs-human` halt is
    // cleared by an operator, so the row offers the grant and the unpark and never a
    // repository-wide daemon verb, which would stop every feature in the checkout from a row
    // about one of them. `e2e/specs/pipeline-controls.spec.ts` owns what pressing one does.
    await expect(row.getByRole("button", { name: "Unpark" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Grant DECIDE re-entry" })).toBeVisible();
    await expect(row.getByRole("button")).toHaveCount(2);
    await shoot(dashboard, inbox, "04-halt-in-the-inbox");

    // The link lands on the run's own detail, which is where the evidence is - and it closes
    // the inbox behind it, because a modal left standing would cover what the click asked for.
    await row.getByRole("link", { name: "Open run" }).click();
    await expect(inbox).toHaveCount(0);
    await expect(
      dashboard.locator("div.pipelines-reader").getByRole("heading", { name: "fix-the-thing" }),
    ).toBeVisible();
    await expect(
      dashboard.getByText("the build review found two blocking defects").first(),
    ).toBeVisible();
  });

  test("withdrawing consent gives the session back and takes the halt off the drain", async ({
    dashboard,
    daemon,
  }) => {
    // The fail-open guarantee exercised the way an operator would reach it: through the switch.
    // What has to come back is not "most of" the ordinary card - it is the COMPOSER, because a
    // session Mission Control has stopped correlating is one it may type at again.
    await seed(daemon);
    const driven = startPane(conductorWorktree(daemon.repo, "add-widgets"), "consent");
    panes.push(driven);

    const card = dashboard.locator("article.card").filter({ hasText: driven.session });
    await expect(card).toHaveCount(1, { timeout: SETTLE });
    await expect(card.locator("button.pipeline-chip")).toHaveCount(1, { timeout: SETTLE });

    await dashboard.goto(`${daemon.baseURL}/#/settings/conductor`);
    const repoSwitch = dashboard.getByRole("checkbox", { name: "Observe pipelines in demo-repo" });
    await expect(repoSwitch).toBeChecked();
    await repoSwitch.uncheck();
    await expect(dashboard.getByText(/On, but no repository is switched on/)).toBeVisible();

    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    const back = dashboard.locator("article.card").filter({ hasText: driven.session });
    await expect(back).toHaveCount(1, { timeout: SETTLE });
    // The badge is gone and NOTHING ELSE about the session moved: same card, same pane, and a
    // mode chip that is a control again.
    await expect(back.locator("button.pipeline-chip")).toHaveCount(0, { timeout: SETTLE });
    await expect(back).toContainText(/tmux · %\d+/);
    await expect(back.locator("button.mode-btn")).toHaveCount(1);
    await back.getByRole("button", { name: "Expand conversation" }).click();
    await expect(back.getByPlaceholder(/^Reply to this session/)).toBeVisible();
    await expect(back.locator("p.compose-notice")).toHaveCount(0);

    // And the halt is off the drain - because the daemon is no longer observing the repository
    // that holds it, not because the inbox learned a second rule about consent.
    //
    // Read THROUGH the segment rather than asserting the segment is gone: this fleet has a
    // discovered agent on it, and a spec that demanded an empty drain would be asserting on
    // that agent's state as much as on the halt.
    const opener = dashboard.locator("button.pulse-seg", { hasText: "to answer" });
    await expect
      .poll(
        async () => {
          if ((await opener.count()) === 0) return 0;
          await opener.click();
          const halts = await dashboard.locator("section.inbox-halt").count();
          await dashboard.keyboard.press("Escape");
          return halts;
        },
        {
          message: "the halt should leave the drain with the consent that made it readable",
          timeout: SETTLE,
        },
      )
      .toBe(0);
  });
});
