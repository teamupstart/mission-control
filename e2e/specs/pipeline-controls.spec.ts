import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import {
  conductorWorktree,
  readConductorInvocations,
  seedConductorDaemon,
  seedConductorRun,
  writeConductorProjects,
} from "../fixtures/conductor.ts";
import { pipelineRepoKey } from "../../src/shared/pipeline.ts";

/**
 * Acting on a pipeline from the dashboard, rather than only watching one.
 *
 * What only a browser can prove. `test/pipeline-control.test.ts` pins the stdout predicates
 * against a fake CLI, and `test/pipeline-http.test.ts` pins the routes and their refusals -
 * but neither can see a click reach a route, a route spawn the engine, the engine write a
 * marker, the projection re-read it and the row change under an operator who never reloaded.
 * That chain is the whole feature, and every link in it belongs to a different program.
 *
 * Nine claims:
 *
 *  1. A verb pressed in the attention inbox reaches the engine's own CLI, in the argv and the
 *     working directory the engine requires - and the row leaves the inbox when the halt it
 *     was about clears.
 *  2. The daemon chip follows the engine's pidfile and PAUSED marker, through the verbs, with
 *     no reload.
 *  3. The grant picker never offers `plan`, and says why rather than leaving a gap - and the
 *     verb itself is offered only where a halt asked for it.
 *  4. The reseal ceremony opens a HOSTED TERMINAL running the engine's own command, because
 *     the engine refuses to re-seal without one.
 *  5. A shipped feature's cost is the engine's own committed figure, on the run detail.
 *  6. A verb the engine did not confirm shows the command that was run and what the engine
 *     printed, and stays on screen until it is dismissed.
 *  7. An artifact path that leaves the feature's worktree is refused, and no terminal opens.
 *  8. A verb that moved the engine and did not say so still moves the daemon chip, now.
 *  9. A shipped feature the engine could not price reads as unpriced, never as $0.00.
 *
 * No model tokens: nothing here dispatches an agent, and the only engine is the fake
 * `conduct-ts` that `e2e/fixtures/conductor.ts` installs - which writes the same marker files
 * the real one writes, so the projection below is reacting to files rather than to a fixture.
 */

// The fastest watch cadence the daemon allows, so a marker written by a verb is projected
// while the spec is still looking. Per file, for `runs-pipelines-tab.spec.ts`' reason.
test.use({ daemonEnv: { MISSION_PIPELINE_TICK_MS: "1000" } });

const EVIDENCE = artifactsDir("pipeline-controls");

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  if ("mouse" in target) await target.mouse.move(0, 0);
  await target.screenshot({
    path: `${EVIDENCE}${name}.png`,
    ...("mouse" in target ? { fullPage: true } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/pipeline-controls/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** Consent to the daemon's own repository, and wait for the seeded features to be projected. */
async function observe(daemon: DaemonHandle, runs: number): Promise<void> {
  writeConductorProjects(daemon.home, [{ name: "demo-repo", path: daemon.repo }]);
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
        const view = await api<{ status: { runs: number }[] }>(daemon, "/api/pipelines/config");
        return view.status.reduce((total, repo) => total + repo.runs, 0);
      },
      { message: "the seeded features should be projected", timeout: 15_000 },
    )
    .toBe(runs);
}

/**
 * A terminal backend takes ONE shell string, so the engine's argv reaches it quoted twice:
 * once by the hold-open script the daemon composes, and once by the backend's own
 * `--command`. Undoing the outer layer's `'"'"'` seam leaves the inner argv legible, so the
 * assertions below can read as the command a person would have typed.
 */
function unquoteOnce(command: string): string {
  return command.replaceAll(`'"'"'`, "'");
}

/** Every terminal the fake cmux backend was asked to open, newest last. */
function terminals(daemon: DaemonHandle): string[] {
  if (!existsSync(daemon.recordDir)) return [];
  return readdirSync(daemon.recordDir)
    .filter((name) => name.startsWith("cmux-"))
    .sort()
    .map((name) => {
      const body = JSON.parse(readFileSync(join(daemon.recordDir, name), "utf8")) as {
        argv: string[];
      };
      return body.argv.join(" ");
    });
}

test("a halted run's verb reaches the engine, and the row leaves when the halt clears", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "fix-the-thing", {
    steps: { worktree: "done", build: "done", build_review: "failed" },
    lastStep: "build_review",
    halt: "the build review found two blocking defects",
    haltClass: "needs-human",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid, parked: ["fix-the-thing"] });
  await observe(daemon, 1);

  // The inbox is where a halt is drained: the run has no session behind it, so this is the
  // one place an operator meets it without going looking.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: /to answer/ }).click();
  const inbox = dashboard.getByRole("dialog", { name: "Attention inbox" });
  const row = inbox.locator("section.inbox-halt");
  await expect(row).toContainText("fix-the-thing");
  await expect(row).toContainText("Needs a human");

  // The verbs this halt's own class calls for - and not the repository-wide ones, which
  // would stop every feature in the checkout from a row about one of them.
  await expect(row.getByRole("button", { name: "Unpark" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Grant DECIDE re-entry" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Stop daemon" })).toHaveCount(0);
  await shoot(dashboard, "01-inbox-verbs");

  await row.getByRole("button", { name: "Unpark" }).click();

  // The engine's own words, restated: the flash is what the daemon parsed out of the CLI's
  // stdout, not a hopeful sentence composed here.
  await expect(row.locator(".pipelines-flash")).toContainText("unparked");

  // What actually reached the engine. The argv shape is the half that a green flash cannot
  // prove: `daemon unpark` takes a BARE POSITIONAL, and the verb must run in the MAIN
  // checkout, because the engine joins `.daemon/` onto its own working directory.
  const asked = readConductorInvocations(daemon.home);
  const unpark = asked.find((call) => call.argv[1] === "unpark");
  expect(unpark?.argv).toEqual(["daemon", "unpark", "fix-the-thing"]);
  expect(unpark?.cwd).toBe(daemon.repo);
  // And the engine really removed the marker, which is what makes the projection change.
  expect(existsSync(join(daemon.repo, ".daemon", "parked", "fix-the-thing"))).toBe(false);

  // The row stays until the HALT does, which is the honest behaviour: unparking lets the
  // engine dispatch again, and it is the engine getting past the gate that resolves this.
  // Clearing the file is this fixture standing in for that next dispatch.
  await expect(row).toBeVisible();
  rmSync(join(conductorWorktree(daemon.repo, "fix-the-thing"), ".pipeline", "HALT"), {
    force: true,
  });
  await expect(inbox.locator("section.inbox-halt")).toHaveCount(0, { timeout: 15_000 });
  await expect(inbox.getByText("You are all clear.")).toBeVisible();
  await shoot(dashboard, "02-inbox-drained");
});

test("the daemon chip follows the engine's own pidfile and pause marker", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  await observe(daemon, 1);

  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/add-widgets`);
  const rail = dashboard.locator("aside.pipelines-rail");
  const reader = dashboard.locator("div.pipelines-reader");
  await expect(rail.getByText("daemon running", { exact: true })).toBeVisible();

  // A run that has not stopped is offered no grant. A grant authorizes the engine to re-enter
  // a DECIDE step unattended, and it is the answer to a refusal - offered to a feature that
  // never met one, it is the next gate spent before it is reached.
  await expect(reader.getByRole("button", { name: "Park" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Grant DECIDE re-entry" })).toHaveCount(0);

  // Pause: the engine writes PAUSED, the chip follows, and the verbs on offer change with it
  // - an operator is never shown a button whose only outcome is "already paused".
  await reader.getByRole("button", { name: "Pause daemon" }).click();
  await expect(reader.locator(".pipelines-flash")).toContainText("paused");
  expect(existsSync(join(daemon.repo, ".daemon", "PAUSED"))).toBe(true);
  await expect(rail.getByText("daemon paused", { exact: true })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Resume daemon" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Pause daemon" })).toHaveCount(0);
  await shoot(dashboard, "03-daemon-paused");

  // Resume, and back again - no reload anywhere in this test.
  await reader.getByRole("button", { name: "Resume daemon" }).click();
  await expect(rail.getByText("daemon running", { exact: true })).toBeVisible();
  expect(existsSync(join(daemon.repo, ".daemon", "PAUSED"))).toBe(false);

  // Stop: the engine removes its pidfile. This is the case a naive implementation gets wrong,
  // because a successful `daemon stop` prints NOTHING - silence is its confirmation.
  await reader.getByRole("button", { name: "Stop daemon" }).click();
  await expect(reader.locator(".pipelines-flash")).toContainText("stopped");
  await expect(rail.getByText("daemon stopped", { exact: true })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Start daemon" })).toBeVisible();

  // And start, which puts a live pidfile back.
  await reader.getByRole("button", { name: "Start daemon" }).click();
  await expect(rail.getByText("daemon running", { exact: true })).toBeVisible();
  // Every CONTROL verb the engine was asked for, in order and with nothing else among them:
  // the daemon's state is read from the engine's own files, so a control surface that polled
  // the CLI for it would show up here as a fifth call. `engineer projects` is the detection
  // probe phase 1 already spawns, and is not a control verb.
  const control = readConductorInvocations(daemon.home)
    .filter((call) => call.argv[0] === "daemon")
    .map((call) => call.argv.join(" "));
  expect(control).toEqual(["daemon pause", "daemon resume", "daemon stop", "daemon start -D"]);
});

test("the grant picker offers every DECIDE step except the one the engine never grants", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "fix-the-thing", {
    steps: { worktree: "done", prd: "done", plan: "done", build_review: "failed" },
    lastStep: "build_review",
    halt: "the DECIDE gate refused a second autonomous entry",
    haltClass: "needs-human",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  await observe(daemon, 1);

  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/fix-the-thing`);
  const reader = dashboard.locator("div.pipelines-reader");
  await reader.getByRole("button", { name: "Grant DECIDE re-entry" }).click();

  const form = reader.getByRole("form", { name: "Grant DECIDE re-entry" });
  const step = form.getByLabel("Step");
  await expect(step).toBeVisible();
  const offered = await step.locator("option").allTextContents();
  expect(offered).toContain("PRD");
  expect(offered).toContain("Explore");
  // Never `plan`, and never a BUILD or SHIP step: the engine grants re-entry to DECIDE only,
  // and refuses `plan` in four places of its own.
  expect(offered).not.toContain("Plan");
  expect(offered).not.toContain("Build");
  // Absence alone would read as a build that has fallen behind the engine, so the reason is
  // printed under the picker.
  await expect(form).toContainText("never grants re-entry to 'plan'");

  // The rationale is required, because it is the whole audit trail of why an autonomous
  // re-entry was allowed - and Mission Control will not forge one.
  const grant = form.getByRole("button", { name: "Grant", exact: true });
  await expect(grant).toBeDisabled();
  await form.getByLabel("Why you are allowing it").fill("the PRD's assumption changed");
  await shoot(dashboard, "04-grant-form");
  await expect(grant).toBeEnabled();

  await step.selectOption({ label: "PRD" });
  await grant.click();
  await expect(reader.locator(".pipelines-flash")).toContainText("may enter prd once");

  // Exactly the three flags the engine's detector wants, each once, each with a value.
  const asked = readConductorInvocations(daemon.home).find((call) => call.argv[0] === "decide-grant");
  expect(asked?.argv).toEqual([
    "decide-grant",
    "--slug",
    "fix-the-thing",
    "--step",
    "prd",
    "--reason",
    "the PRD's assumption changed",
  ]);
  // And the engine recorded it where it records grants, in the main checkout.
  expect(existsSync(join(daemon.repo, ".daemon", "grants", "fix-the-thing.json"))).toBe(true);
});

test("a broken seal offers the ceremony, in a terminal, running the engine's own command", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "fix-the-thing", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
    halt: "docs/decisions/fix-the-thing.md changed under a sealed approval",
    haltClass: "protected-artifact",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  await observe(daemon, 1);

  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/fix-the-thing`);
  const reader = dashboard.locator("div.pipelines-reader");
  // This halt's way out is the ceremony, and only the ceremony. A grant beside it would offer
  // to authorize a DECIDE re-entry for a run that stopped over a broken seal, which no
  // decision gate refused - the header reads the same halt-class table the inbox does.
  await expect(reader.getByRole("button", { name: "Grant DECIDE re-entry" })).toHaveCount(0);
  await reader.getByRole("button", { name: "Reseal an artifact" }).click();

  const form = reader.getByRole("group", { name: "Reseal a protected artifact" });
  const open = form.getByRole("button", { name: "Open reseal terminal" });
  // Nothing to re-seal, and no reason: the engine records both, and neither is invented here.
  await expect(open).toBeDisabled();
  await form.getByLabel("Artifacts, one path per line").fill(
    ".docs/decisions/fix-the-thing.md\n.docs/prd/fix-the-thing.md",
  );
  await form.getByLabel("Why they changed").fill("the decision moved after review");
  await expect(open).toBeEnabled();
  // The halt this raised is pre-answered for the run that is in that state.
  await expect(form.getByLabel("Also clear the halt this raised")).toBeChecked();
  await shoot(dashboard, "05-reseal-form");

  await open.click();
  // The backend chooser is the session launchers' own, so a pipeline console opens wherever
  // an operator's terminals are - cmux being the one this suite installs.
  await reader.getByRole("menu", { name: "Open reseal terminal" }).getByRole("menuitem", {
    name: /cmux/,
  }).click();
  await expect(reader.locator(".pipelines-flash")).toContainText("Opened in");

  // A hosted TERMINAL, running the engine's own verb - the engine refuses to re-seal without
  // one, and this is what the daemon asked a terminal to run.
  await expect.poll(() => terminals(daemon).length, { timeout: 10_000 }).toBe(1);
  const command = unquoteOnce(terminals(daemon)[0] ?? "");
  expect(command).toContain("'reseal' '--slug' 'fix-the-thing'");
  expect(command).toContain("'--path' '.docs/decisions/fix-the-thing.md'");
  expect(command).toContain("'--path' '.docs/prd/fix-the-thing.md'");
  expect(command).toContain("'--reason' 'the decision moved after review'");
  expect(command).toContain("'--clear-halt'");
  // Held open after the verb returns, because the ceremony prints one line and exits - and a
  // window that closed with it would take the outcome with it.
  expect(command).toContain("read -r _");

  // The daemon console is the other hosted terminal, and it attaches without a tmux target
  // because Mission Control hosts the window itself.
  await reader.getByRole("button", { name: "Open daemon console" }).click();
  await reader.getByRole("menu", { name: "Open daemon console" }).getByRole("menuitem", {
    name: /cmux/,
  }).click();
  await expect.poll(() => terminals(daemon).length, { timeout: 10_000 }).toBe(2);
  const console_ = unquoteOnce(terminals(daemon)[1] ?? "");
  expect(console_).toContain("'daemon' 'connect'");
  expect(console_).not.toContain("--attach-into");
});

test("a shipped feature shows the engine's own committed cost", async ({ dashboard, daemon }) => {
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", finish: "done" },
    lastStep: "finish",
    done: true,
    prUrl: "https://github.com/acme/demo/pull/9",
    // What the engine's rollup committed when the feature shipped. Deliberately different
    // from the running tail below it, so a surface that kept accumulating would show 60.
    events: [{ type: "step_completed", step: "build", tokenUsage: { input: 40, output: 20 } }],
    shipped: { input: 12_000, output: 3400, cacheRead: 900, cacheWrite: 100, costUsd: 0.42 },
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  await observe(daemon, 1);

  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/add-widgets`);
  const reader = dashboard.locator("div.pipelines-reader");
  // 12,000 + 3,400 + 900 + 100 - the engine's own figure, not the 60 its event ledger has
  // mentioned so far. The chip rounds, so the exact figure is asserted through the tooltip
  // that carries it: 16k could have come from anywhere, 16,400 could not.
  // A finished feature offers the repository's verbs and none of its own: the engine accepts
  // a park or a grant on a slug it has already processed and prints a success line for it,
  // and a button whose only effect is that sentence is one an operator learns to distrust.
  await expect(reader.getByRole("button", { name: "Pause daemon" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Park" })).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Grant DECIDE re-entry" })).toHaveCount(0);

  const tokens = reader.getByText("16k tokens", { exact: true });
  await expect(tokens).toBeVisible();
  await tokens.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(
    "ai-conductor attributes 16,400 tokens to this feature",
  );
  await shoot(dashboard, "06-run-cost");

  // And the same figure reaches the fleet's own spend surface, as automation rather than as
  // session spend: nobody sat and watched this, and folding it into "Fleet today" would make
  // a figure about work an operator asked for move on its own.
  const chip = dashboard.getByRole("button", { name: /^Spend - / });
  await expect(chip).toBeVisible();
  await chip.click();
  const popover = dashboard.getByRole("dialog", { name: "Spend today" });
  await expect(popover.locator(".spend-row", { hasText: "Automation" })).toContainText("≈$0.42");
  await expect(popover.locator(".spend-sub")).toContainText("ai-conductor pipelines $0.42");
  await shoot(dashboard, "07-spend-popover");
});

test("a verb the engine did not confirm shows the command and its own words, until dismissed", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  await observe(daemon, 1);

  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/add-widgets`);
  const rail = dashboard.locator("aside.pipelines-rail");
  const reader = dashboard.locator("div.pipelines-reader");
  await expect(rail.getByText("daemon running", { exact: true })).toBeVisible();

  // The case the whole stdout posture exists for, armed: from here every verb answers the way
  // the real engine answers an invocation its argv detectors rejected - a sentence about a
  // subcommand nobody asked for, printed to stdout, behind EXIT CODE 0, having done nothing.
  writeFileSync(join(daemon.repo, ".daemon", "REFUSE"), "");
  await reader.getByRole("button", { name: "Pause daemon" }).click();

  const flash = reader.locator(".pipelines-flash");
  await expect(flash).toHaveAttribute("role", "alert");
  await expect(flash).toContainText("exited cleanly without confirming");
  // Our sentence is true and, alone, useless: "it did not confirm" reads the same for a
  // version skew, a wrong working directory and a feature the engine never heard of. These
  // two lines are what tells them apart, which is why the failure carries them.
  await expect(flash.locator(".pipelines-transcript.is-command")).toContainText("daemon pause");
  await expect(flash.locator(".pipelines-transcript").last()).toContainText(
    "the inline SDLC pipeline now runs under the `inline` subcommand",
  );
  await shoot(dashboard, "08-refused-verb");

  // Nothing was assumed to have happened: no marker, and the chip still reads the engine's own
  // state rather than the state the button was named after.
  expect(existsSync(join(daemon.repo, ".daemon", "PAUSED"))).toBe(false);
  await expect(rail.getByText("daemon running", { exact: true })).toBeVisible();

  // A success clears itself after 3.5s. A transcript must NOT - one that vanished while
  // somebody was reading it would be worse than none - so it is still here well past that,
  // and it goes when the operator says so.
  await dashboard.waitForTimeout(4500);
  await expect(flash).toBeVisible();
  await flash.getByRole("button", { name: "Dismiss" }).click();
  await expect(reader.locator(".pipelines-flash")).toHaveCount(0);
});

test("a shipped feature the engine could not price reads as unpriced, not as free", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", finish: "done" },
    lastStep: "finish",
    done: true,
    // Real tokens, no price line. The engine writes exactly this when its rollup could price
    // nothing - a Codex-backed feature, or a release older than the line - and the tokens are
    // as real as any other feature's.
    shipped: { input: 12_000, output: 3400, cacheRead: 900, cacheWrite: 100, costUsd: null },
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  await observe(daemon, 1);

  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/add-widgets`);
  // The tokens still reach the feature, because those the engine did count.
  await expect(
    dashboard.locator("div.pipelines-reader").getByText("16k tokens", { exact: true }),
  ).toBeVisible();

  // And the fleet's spend surface says it has no price for them, rather than the $0.00 a
  // defaulted field would have produced - a figure indistinguishable, on this row, from a
  // feature that genuinely cost nothing.
  const chip = dashboard.getByRole("button", { name: /^Spend - / });
  await expect(chip).toBeVisible();
  await chip.click();
  const popover = dashboard.getByRole("dialog", { name: "Spend today" });
  await expect(popover.locator(".spend-sub")).toContainText("ai-conductor pipelines unpriced");
  await expect(popover.locator(".spend-sub")).not.toContainText("$0.00");
  await shoot(dashboard, "10-unpriced-feature");
});

test("a verb that moved the engine and did not confirm it still moves the chip, now", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "add-widgets", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  await observe(daemon, 1);

  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/add-widgets`);
  const rail = dashboard.locator("aside.pipelines-rail");
  const reader = dashboard.locator("div.pipelines-reader");
  await expect(rail.getByText("daemon running", { exact: true })).toBeVisible();

  // Half a verb: the engine writes PAUSED and then says the wrong thing about it. That is not
  // a contrived state - a verb's confirmation and its side effect are not one atomic act, and
  // conductor prints its park line before work that can still throw - and it is the only case
  // where the daemon's answer and the daemon's own files disagree.
  writeFileSync(join(daemon.repo, ".daemon", "HALFWAY"), "");

  // Anchored on a poll landing, which is what makes the timing below an assertion rather than
  // a coincidence: the rail re-reads this route every four seconds, so waiting for one to
  // arrive puts the next one a full four seconds out. Anything the chip does inside the window
  // afterwards came from the refresh this verb fired, not from the cadence.
  await dashboard.waitForResponse(
    (response) => response.url().includes("/api/pipelines/repos") && response.request().method() === "GET",
  );
  await reader.getByRole("button", { name: "Pause daemon" }).click();

  // Reported honestly - nothing here claims the pause worked...
  await expect(reader.locator(".pipelines-flash.is-error")).toContainText(
    "exited cleanly without confirming",
  );
  // ...and yet it did, which is exactly why the surface cannot stop reading after a failure.
  expect(existsSync(join(daemon.repo, ".daemon", "PAUSED"))).toBe(true);
  await expect(rail.getByText("daemon paused", { exact: true })).toBeVisible({ timeout: 2500 });
  // The verbs move with it: an operator looking at a paused daemon is offered Resume, with the
  // failure still on screen beside it.
  await expect(reader.getByRole("button", { name: "Resume daemon" })).toBeVisible({ timeout: 2500 });
  await expect(reader.locator(".pipelines-flash.is-error")).toBeVisible();
});

test("an artifact path that leaves the feature's worktree is refused, and opens nothing", async ({
  dashboard,
  daemon,
}) => {
  seedConductorRun(daemon.repo, "fix-the-thing", {
    steps: { worktree: "done", build: "in_progress" },
    lastStep: "build",
    halt: "docs/decisions/fix-the-thing.md changed under a sealed approval",
    haltClass: "protected-artifact",
  });
  seedConductorDaemon(daemon.repo, { pid: process.pid });
  await observe(daemon, 1);

  const repoKey = encodeURIComponent(pipelineRepoKey("ai-conductor", daemon.repo));
  await dashboard.goto(`${daemon.baseURL}/#/runs/pipeline/${repoKey}/fix-the-thing`);
  const reader = dashboard.locator("div.pipelines-reader");
  await reader.getByRole("button", { name: "Reseal an artifact" }).click();

  const form = reader.getByRole("group", { name: "Reseal a protected artifact" });
  // A path that is well under every length bound and points at ANOTHER feature's sealed
  // decision. `reseal` breaks a cryptographic seal and can be told to clear the halt that
  // seal raised, so the only thing standing between the loopback API and somebody else's
  // artifact is where this path resolves to.
  await form.getByLabel("Artifacts, one path per line").fill("../other-feature/.docs/decisions/x.md");
  await form.getByLabel("Why they changed").fill("the decision moved after review");
  await form.getByRole("button", { name: "Open reseal terminal" }).click();
  await reader.getByRole("menu", { name: "Open reseal terminal" }).getByRole("menuitem", {
    name: /cmux/,
  }).click();

  const flash = reader.locator(".pipelines-flash");
  await expect(flash).toContainText("points outside this feature's worktree");
  await shoot(dashboard, "09-reseal-refused");
  // Refused BEFORE argv was composed, so there is no window in which the ceremony sat waiting
  // for a person to notice what it had been pointed at.
  expect(terminals(daemon)).toEqual([]);

  // And the refusal is about that path rather than about resealing: the same form, with a
  // path inside the worktree, opens the ceremony.
  await flash.getByRole("button", { name: "Dismiss" }).click();
  await form.getByLabel("Artifacts, one path per line").fill(".docs/decisions/fix-the-thing.md");
  await form.getByRole("button", { name: "Open reseal terminal" }).click();
  await reader.getByRole("menu", { name: "Open reseal terminal" }).getByRole("menuitem", {
    name: /cmux/,
  }).click();
  await expect(reader.locator(".pipelines-flash")).toContainText("Opened in");
  await expect.poll(() => terminals(daemon).length, { timeout: 10_000 }).toBe(1);
  expect(unquoteOnce(terminals(daemon)[0] ?? "")).toContain(
    "'--path' '.docs/decisions/fix-the-thing.md'",
  );
});
