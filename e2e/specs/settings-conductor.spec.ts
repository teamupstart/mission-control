import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import {
  FAKE_CONDUCTOR_VERSION,
  seedConductorDaemon,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";

/**
 * Consenting to an external SDLC engine, in the panel an operator actually uses.
 *
 * What only this layer can prove. `test/conductor-panel.test.ts` pins the panel's markup and
 * its three "which of these is false" sentences, and `test/pipeline-http.test.ts` pins the
 * route's refusals - but neither can see a click reach the daemon, a probe spawn, a watch
 * pass read the engine's files, and a health line come back with what it found. That whole
 * chain is what an operator is actually trusting when they flip a switch here.
 *
 * Three claims:
 *
 *  1. Everything ARRIVES OFF. Detection is automatic and consent is not: the engine is found
 *     and its repositories are listed while nothing at all is being read.
 *  2. Enabling is consent, and it takes effect. One switch, and the daemon starts reading
 *     that repository's state files - the health line names the engine daemon's state and
 *     counts the runs it found, including the halted one.
 *  3. Disabling returns it to inert, in the same request rather than on some later tick.
 *
 * No model tokens: nothing here dispatches an agent, and the only subprocess the daemon
 * spawns is the fake `conduct-ts` that `e2e/fixtures/conductor.ts` installs.
 */

// The fastest watch cadence the daemon allows - the value is floored at 1000ms, so asking
// for less would be a number this file states and the daemon ignores. Per file rather than
// in the shared list: this is the only spec that waits for a pipeline pass, and 5x the
// background polling in every other worker's daemon is a cost fifty specs would pay for
// this one.
test.use({ daemonEnv: { MISSION_PIPELINE_TICK_MS: "1000" } });

const EVIDENCE = artifactsDir("settings-conductor");

/** Photograph a state this spec has already asserted on. Behind `MC_E2E_EVIDENCE`. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-conductor/${name}.png`);
}

test("the engine is detected, arrives off, and one switch starts observing it", async ({
  page,
  daemon,
}) => {
  // The engine says it manages the seeded repository. Written before the panel is opened,
  // because the daemon caches its probe and the first read is what fills that cache.
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
  // Two features in flight, one of them halted, under a live engine daemon. This is the
  // tree the daemon's readers will meet - written by the same fixture the unit tests use,
  // so a reader that passes there is reading the shape it meets here.
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", memory: "done", explore: "in_progress" },
    lastStep: "explore",
    tier: "M",
    track: "product",
  });
  seedConductorRun(daemon.repo, "fix-the-thing", {
    steps: { worktree: "done", build: "done" },
    lastStep: "build",
    halt: "the build review found two blocking defects",
    haltClass: "needs-human",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });

  await page.goto(`${daemon.baseURL}/#/settings/conductor`);

  // Detection is automatic: the engine is found, at the path and version the fake installs,
  // and it says which repositories it manages.
  await expect(page.getByText(/Installed at .*conduct-ts/)).toBeVisible();
  await expect(page.getByText(new RegExp(`version ${FAKE_CONDUCTOR_VERSION}`))).toBeVisible();
  await expect(page.getByText(/1 repository registered/)).toBeVisible();

  // And consent is not. Everything arrives off, and the panel says which of the two switches
  // is the reason nothing is being read.
  // The master switch is a `ConsoleSwitch`: a real checkbox with `appearance: none`, whose
  // visible track is a sibling span that takes the pointer. So the STATE is read off the
  // input and the CLICK lands on the label - the same split `trust-workflows-grant.spec.ts`
  // makes, and the reason the input is a checkbox at all rather than a div with an onClick.
  const master = page.getByRole("checkbox", { name: "Observe conductor pipelines" });
  const masterLabel = page.locator('.sc-card[data-anchor="conductor/enabled"] label.sc-switch');
  await expect(master).not.toBeChecked();
  const repoSwitch = page.getByRole("checkbox", { name: "Observe pipelines in demo-repo" });
  await expect(repoSwitch).toBeVisible();
  await expect(repoSwitch).not.toBeChecked();
  await expect(page.getByText("Off - no pipeline state is being read.")).toBeVisible();
  await expect(
    page.getByText("Not observed - switch this repository on to project its pipelines."),
  ).toBeVisible();
  await shoot(page, "01-detected-and-off");

  // Nothing is being read, and the daemon says so from its own side rather than from the
  // panel's optimistic view - which is the difference between a switch that looks off and a
  // daemon that IS off.
  const config = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
  expect((await config.json()).config).toMatchObject({ enabled: false, repos: [] });

  // Consent, in two acts: the master switch, then the repository.
  await masterLabel.click();
  await expect(master).toBeChecked();
  await expect(page.getByText(/On, but no repository is switched on/)).toBeVisible();
  await repoSwitch.check();
  await expect(page.getByText("On - reading 1 repository.")).toBeVisible();

  // And now the whole chain: the daemon reads the engine's files and reports what it found.
  // Polled rather than awaited on a locator, because the first pass has to happen and the
  // panel has to poll it back - two round trips, neither of which the DOM can wait on.
  await expect(page.getByText(/engine daemon running · 2 pipelines, 1 halted/)).toBeVisible({
    timeout: 15_000,
  });
  await shoot(page, "02-observing");

  // The projection reached the browser over SSE too, not just the panel's own poll - which
  // is what phases 2 and 3 will render from.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
        return (await res.json()).status?.[0]?.runs ?? 0;
      },
      { message: "the daemon should be projecting both features" },
    )
    .toBe(2);

  // Withdrawing consent returns it to inert, and does so in the write itself.
  await repoSwitch.uncheck();
  await expect(page.getByText(/On, but no repository is switched on/)).toBeVisible();
  await expect(
    page.getByText("Not observed - switch this repository on to project its pipelines."),
  ).toBeVisible();
  await shoot(page, "03-withdrawn");

  // The choice survives the master switch, which is the whole reason it is a separate
  // control: turning it back on must restore the set an operator chose, not an empty one.
  await repoSwitch.check();
  await expect(page.getByText("On - reading 1 repository.")).toBeVisible();
  await masterLabel.click();
  await expect(master).not.toBeChecked();
  await expect(page.getByText("Off - no pipeline state is being read.")).toBeVisible();
  await expect(repoSwitch).toBeChecked();

  // And it survives a fresh page, which is what an operator comes back to tomorrow.
  //
  // The daemon's own answer is waited for first, and that is not belt and braces: saves are
  // applied optimistically and serialized, so the last click's PUT can still be in flight
  // when the reload cancels it - which made this pass alone and fail under the slower
  // evidence run. Reading the route is what says the write LANDED, as against being drawn.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/pipelines/config`);
        return (await res.json()).config;
      },
      { message: "the daemon should hold the master switch off with the repository still chosen" },
    )
    .toMatchObject({ enabled: false, repos: [{ repoRoot: daemon.repo, enabled: true }] });

  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Observe conductor pipelines" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Observe pipelines in demo-repo" })).toBeChecked();
});

test.describe("with no engine installed", () => {
  // The plan's criterion, in a browser: "an operator without conductor installed sees
  // nothing new". Keyed on INSTALLED rather than on enabled - a Settings row offering to
  // observe an engine somebody does not have is a new thing on their screen however off it
  // ships.
  //
  // Reached by pointing the daemon's resolution at a path that is not there, rather than by
  // mocking a response: what is under test is the daemon deciding this operator has nothing
  // to do with a pipeline engine, and a mocked body would assert that the rail renders a
  // shape the daemon might never send.
  test.use({ daemonEnv: { MISSION_CONDUCTOR_BIN: "/nonexistent/conduct-ts" } });

  test("no Conductor row, no panel, and the hash is not a back door", async ({
    page,
    daemon,
  }) => {
    await page.goto(`${daemon.baseURL}/#/settings`);
    // Waited for rather than assumed: the rail is what proves the page has painted and the
    // snapshot has landed, so the absences below are read after the daemon has answered
    // rather than before it.
    await expect(page.getByRole("tab", { name: /Task sources/ })).toBeVisible();

    await expect(page.getByRole("tab", { name: /Conductor/ })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Observe conductor pipelines" })).toHaveCount(0);
    await expect(page.getByText(/Not installed/)).toHaveCount(0);
    await expect(page.getByText(/never starts or stops a pipeline/)).toHaveCount(0);

    // A stale bookmark lands on the default category rather than on an empty pane, which is
    // what an unknown category already does - and it must not start the Conductor hook
    // behind that fallback either. Watched from here, because "no new UI" and "no new
    // behaviour" are different claims and only one of them is visible on screen: the hook
    // polls the pipelines route, and that route is what starts the daemon's engine probe.
    const pipelineReads: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/pipelines/")) pipelineReads.push(req.url());
    });

    await page.goto(`${daemon.baseURL}/#/settings/conductor`);
    // Asserted on the RAIL rather than on the Display panel's contents: what is under test
    // is where the route resolved, and the selected tab says that without depending on what
    // any particular panel happens to render.
    await expect(page.getByRole("tab", { name: /Display/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: /Conductor/ })).toHaveCount(0);
    await expect(page.getByText(/never starts or stops a pipeline/)).toHaveCount(0);
    // The headline artifact, taken HERE: the rail an operator without the engine actually
    // gets, after the stale hash has resolved, with nothing overlaying it. Captured before
    // the palette below opens - an earlier cut of this spec shot it afterwards and produced
    // a frame of a dimmed page behind a dialog, which shows the reviewer nothing.
    await shoot(page, "04-no-conductor-row");

    // Long enough to cover more than one turn of the hook's 4s poll, so this is "it never
    // started" rather than "it had not got round to it yet".
    await page.waitForTimeout(5000);
    expect(pipelineReads, "a stale hash must not start the Conductor poll").toEqual([]);

    // And it is absent from the one other place a panel is reachable from. The palette may
    // only target routes the app publishes, so a hidden category offered here would be the
    // criterion holding everywhere except the search box.
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog", { name: "Search everything" })).toBeVisible();
    const query = page.getByRole("combobox", { name: "Search everything" });
    // First a query that DOES land, so the absence below is a filtered palette rather than a
    // broken one - "assert nothing is there" proves nothing when nothing is ever there.
    await query.fill("display");
    await expect(page.getByRole("option", { name: /Display settings/ })).toBeVisible();
    await query.fill("conductor");
    await expect(page.getByRole("option", { name: /Conductor/ })).toHaveCount(0);
    // The second artifact, and the palette IS its subject - so this one is taken with the
    // dialog open on purpose.
    await shoot(page, "05-not-in-the-palette");
  });
});
