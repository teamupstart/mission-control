import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Line's drawers, end to end: a stage click opens a panel in place, the board moves down
 * and comes back, and the escalation out of it lands on the re-homed routes.
 *
 * This is the only layer that can see any of it. The reducer's unit test proves the state
 * machine, the markup tests prove the rows, and the Electron test proves the cap in pixels -
 * and none of the three can see whether clicking the strip actually opens anything, whether
 * `esc` reaches the handler through the fleet's key ladder, or whether "Open run" arrives at
 * a page that renders. A spec that only rendered the drawer and read its rows would pass on a
 * build whose stage buttons were wired to nothing.
 *
 * No model tokens. The seeded states are reached through the task, schedule and workflow
 * routes; the one dispatched session runs against the fake agent like every other spec here.
 */

const EVIDENCE = fileURLToPath(new URL("../../docs/evidence/line-drawers/", import.meta.url));

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE` for the reason the Line strip's captures are: an ordinary run
 * would rewrite the binaries for no added signal. Inside the regression tests rather than in
 * a staged capture spec, because the point of the picture is that the assertions around it
 * passed on the same run.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // strip is six adjacent buttons.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED docs/evidence/line-drawers/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

const stage = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "The Line" }).getByRole("button", { name: new RegExp(`^${name},`) });

const drawer = (page: Page, name: string): Locator =>
  page.getByRole("region", { name: `${name} drawer` });

/** Any drawer at all, so "exactly one is showing" is assertable. */
const anyDrawer = (page: Page): Locator => page.locator(".line-drawer");

/**
 * A bounding box read only once it has genuinely stopped moving.
 *
 * A freshly dispatched session keeps changing shape for a second or two after its card
 * appears - the titler renames it, the driver reports its model, the branch line arrives -
 * and each of those can add a line to the card. Comparing a box taken mid-settle against one
 * taken after it is a test that fails on a loaded machine and blames the drawer for the
 * titler, which is exactly what it did: 358px against an expected 339, one line's worth.
 *
 * TWO consecutive identical reads is not enough, and that was the first cut's mistake. The
 * mutations arrive from a subprocess over SSE, so a card can sit quiet for one poll interval
 * and then grow. This wants a QUIET WINDOW - several consecutive identical reads at a fixed
 * interval - and the caller gates on the session reaching `idle` first, so the window is
 * waiting out stragglers rather than the whole launch.
 */
const QUIET_READS = 5;
const QUIET_INTERVAL_MS = 250;

async function settledBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = JSON.stringify(await locator.boundingBox());
  let stable = 0;
  await expect.poll(async () => {
    const next = JSON.stringify(await locator.boundingBox());
    stable = next === last ? stable + 1 : 0;
    last = next;
    return stable;
  }, {
    // A fixed cadence, so "five reads" is a known ~1.25s of quiet rather than whatever
    // `expect.poll`'s backoff happened to produce.
    intervals: Array.from({ length: 120 }, () => QUIET_INTERVAL_MS),
    timeout: 60_000,
  }).toBeGreaterThanOrEqual(QUIET_READS);
  return JSON.parse(last) as { x: number; y: number; width: number; height: number };
}

async function sessionIds(daemon: DaemonHandle): Promise<Set<string>> {
  const sessions = await api<Array<{ id: string }>>(daemon, "/api/sessions");
  return new Set(sessions.map((session) => session.id));
}

/**
 * The daemon's own word for "the launch turn is over", which no DOM poll can substitute for.
 *
 * `before` is the set of session ids that existed when the dispatch was fired, and it is what
 * makes this safe to call more than once on a fleet: "the first session that is not exited"
 * returns the PREVIOUS session while it is still winding down, so a second seeded run would
 * bind to a conversation that already has a binding and the daemon would answer 409. Naming
 * the new one explicitly costs one extra read and removes the race entirely.
 */
async function waitForIdleSession(
  daemon: DaemonHandle,
  before: ReadonlySet<string> = new Set(),
): Promise<string> {
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) =>
      !before.has(session.id) && session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  return sessionId;
}

/** A recurring mission, which files a backlog task on a cadence and never launches an agent. */
async function seedMission(daemon: DaemonHandle, name: string): Promise<void> {
  await api(daemon, "/api/schedules", {
    name,
    expression: "0 3 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title: `${name} task`,
      intent: `Whatever ${name} is for.`,
      repoRoot: daemon.repo,
    },
  });
}

test("a stage opens its drawer in place, and three gestures close it again", async ({
  dashboard,
}) => {
  const review = stage(dashboard, "Review");
  const decide = stage(dashboard, "Decide");

  // Closed is the resting state, and an expandable stage says so before it is pressed.
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(review).toHaveAttribute("aria-expanded", "false");
  // Working navigates rather than opening: it must not advertise a panel it cannot produce.
  await expect(stage(dashboard, "Working")).not.toHaveAttribute("aria-expanded", /.*/);

  // ---- open ----
  await review.click();
  await expect(drawer(dashboard, "Review")).toBeVisible();
  await expect(review).toHaveAttribute("aria-expanded", "true");
  await expect(review).toHaveAttribute("aria-controls", "line-drawer");
  // The keyboard went in with it, which is the half that makes `esc` reachable at all.
  await expect(drawer(dashboard, "Review")).toBeFocused();

  // ---- a second click on the same stage closes ----
  await review.click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(review).toHaveAttribute("aria-expanded", "false");

  // ---- esc closes, and hands the keyboard back to the stage that opened it ----
  await review.click();
  await expect(drawer(dashboard, "Review")).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(review).toBeFocused();

  // ---- the close button closes ----
  await review.click();
  await dashboard.getByRole("button", { name: "Close the Review drawer" }).click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(review).toBeFocused();

  // ---- a different stage swaps the content in place ----
  await review.click();
  await decide.click();
  await expect(drawer(dashboard, "Decide")).toBeVisible();
  await expect(drawer(dashboard, "Review")).toHaveCount(0);
  // One drawer, ever. Two would break the cap that keeps the board on screen.
  await expect(anyDrawer(dashboard)).toHaveCount(1);
  await expect(review).toHaveAttribute("aria-expanded", "false");
  await expect(decide).toHaveAttribute("aria-expanded", "true");

  // ---- and the other three are reachable the same way ----
  await stage(dashboard, "Intake").click();
  await expect(drawer(dashboard, "Intake")).toBeVisible();
  await expect(anyDrawer(dashboard)).toHaveCount(1);

  // Backlog is the newest, and the one that used to open the SITREP - a whole-fleet panel
  // OVER the board rather than a drawer in it. Swapping to it from another open drawer is the
  // gesture a half-done flip fails loudest on: the old target would have dropped a modal on
  // top of the strip while the Intake drawer stayed open underneath.
  const backlogStage = stage(dashboard, "Backlog");
  await backlogStage.click();
  await expect(drawer(dashboard, "Backlog")).toBeVisible();
  await expect(drawer(dashboard, "Intake")).toHaveCount(0);
  await expect(anyDrawer(dashboard)).toHaveCount(1);
  await expect(dashboard.getByRole("dialog", { name: "Sitrep" })).toHaveCount(0);
  await expect(backlogStage).toHaveAttribute("aria-expanded", "true");
  await expect(backlogStage).toHaveAttribute("aria-controls", "line-drawer");
  await expect(drawer(dashboard, "Backlog")).toBeFocused();

  await backlogStage.click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await backlogStage.click();
  await dashboard.keyboard.press("Escape");
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(backlogStage).toBeFocused();

  // Shipped is the fourth, and the one that used to NAVIGATE. Swapping to it from another
  // open drawer is the gesture that would have failed loudest on a build where the flip was
  // half done: the old target would have left the fleet mid-swap.
  const shippedStage = stage(dashboard, "Shipped");
  await shippedStage.click();
  await expect(drawer(dashboard, "Shipped")).toBeVisible();
  await expect(drawer(dashboard, "Intake")).toHaveCount(0);
  await expect(anyDrawer(dashboard)).toHaveCount(1);
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");
  await expect(shippedStage).toHaveAttribute("aria-expanded", "true");
  await expect(shippedStage).toHaveAttribute("aria-controls", "line-drawer");

  // It toggles and takes `esc` like the other three - the frame's promises are the frame's,
  // and a fourth body must not have needed its own copy of any of them.
  await shippedStage.click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await shippedStage.click();
  await dashboard.keyboard.press("Escape");
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(shippedStage).toBeFocused();
});

test("the drawer pushes the board down and hands the space back, and never resizes a card", async ({
  dashboard,
  daemon,
}) => {
  // One real session, because the promise being checked is about the CARD: no data changes,
  // no layout changes, no resizing in any drawer state.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a card for the drawer");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // Idle first, then quiet. The card's height is a function of content still arriving from a
  // subprocess, and no amount of polling the DOM can tell "quiet" from "not started yet".
  await waitForIdleSession(daemon);
  const card = dashboard.locator(".card").first();
  await expect(card).toBeVisible();
  const before = await settledBox(card);

  await stage(dashboard, "Review").click();
  await expect(drawer(dashboard, "Review")).toBeVisible();
  const open = await settledBox(card);
  const panel = (await drawer(dashboard, "Review").boundingBox())!;
  await shoot(dashboard, "board-pushed-down");

  // The board is still there, below the drawer, with the card in it - the drawer is a
  // sibling of the layout and not an overlay over it.
  await expect(card).toBeVisible();
  expect(open.y).toBeGreaterThan(panel.y + panel.height - 1);
  // It moved DOWN, by about the drawer's height. A drawer that overlaid would move it none.
  expect(open.y).toBeGreaterThan(before.y);
  // And the card is the same card: same size, in every state.
  expect(open.width).toBe(before.width);
  expect(open.height).toBe(before.height);

  // Closing hands the space back, exactly.
  await dashboard.keyboard.press("Escape");
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  const after = await settledBox(card);
  expect(after.y).toBe(before.y);
  await shoot(dashboard, "board-returned");
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
});

test("past three rows the drawer caps and scrolls inside itself, never burying the board", async ({
  dashboard,
  daemon,
}) => {
  // Five missions: cheap, deterministic, and the Intake drawer lists every one of them.
  for (const name of ["Nightly audit", "Weekly sweep", "Docs check", "Dep bump", "Link check"]) {
    await seedMission(daemon, name);
  }

  await stage(dashboard, "Intake").click();
  const intake = drawer(dashboard, "Intake");
  await expect(intake).toBeVisible();
  const rows = intake.locator(".line-drawer-rows > li");
  await expect(rows).toHaveCount(5);

  // Every row is in the DOM - the cap is on the panel, not on the list, so nothing is
  // silently dropped from a triage surface.
  await expect(intake.getByText("Nightly audit")).toBeAttached();
  await expect(intake.getByText("Link check")).toBeAttached();

  const body = intake.locator(".line-drawer-body");
  const scroll = await body.evaluate((el) => ({
    client: el.clientHeight,
    content: el.scrollHeight,
    viewport: window.innerHeight,
  }));
  // Bounded, and bounded well under the viewport: the whole point is that the board stays
  // on screen. 38vh is the ceiling the stylesheet states.
  expect(scroll.client).toBeLessThan(scroll.viewport * 0.4);
  // And it genuinely scrolls rather than clipping the tail off: content exceeds the box.
  expect(scroll.content).toBeGreaterThan(scroll.client);

  // Scrolling the body reaches the rows the cap hid, and moves nothing else.
  const drawerTopBefore = (await intake.boundingBox())!.y;
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(intake.getByText("Link check")).toBeInViewport();
  expect((await intake.boundingBox())!.y).toBe(drawerTopBefore);
  await body.evaluate((el) => el.scrollTo(0, 0));
  await shoot(dashboard, "intake-capped");
});

test("a task-source read that fails says so, instead of reporting an empty intake", async ({
  dashboard,
}) => {
  const intake = () => drawer(dashboard, "Intake");

  // The CONTROL first, and it is not optional: the assertion below is that a sentence is
  // absent, and a sentence that could never appear here would make it pass through the exact
  // regression it names. On a fleet with no missions and a healthy (empty) sources read, the
  // drawer does claim nothing files work on its own.
  await stage(dashboard, "Intake").click();
  await expect(intake()).toContainText("Nothing files work on its own yet");
  await expect(intake().locator(".line-drawer-count")).toContainText("0 sources");
  await stage(dashboard, "Intake").click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);

  // Now break the read the drawer makes when it opens. `fetchJson` swallows every failure and
  // resolves null, so this is the shape a real outage takes: not an exception, just an absence.
  await dashboard.route("**/api/task-sources/config", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));

  await stage(dashboard, "Intake").click();
  await expect(intake()).toBeVisible();

  // It must not claim an absence it cannot know about - this is the defect: four configured
  // sources behind a failing route would have reported as a tidy, healthy, empty intake.
  await expect(intake()).not.toContainText("Nothing files work on its own yet");
  // The header stops printing a number it does not have, and counts the unknown as needing
  // a look, because unknown health is not health.
  await expect(intake().locator(".line-drawer-count")).toContainText("sources unavailable");
  await expect(intake().locator(".line-drawer-count")).not.toContainText("0 sources");
  await expect(intake().locator(".line-drawer-att")).toContainText("1 needs a look");
  // And it says what to go and look at, in the place a broken source row would be.
  const row = intake().locator(".line-intake-row").first();
  await expect(row).toContainText("Task sources");
  await expect(row).toContainText("could not be read");
  await expect(row).toHaveClass(/is-waiting/);
  await expect(row.getByRole("button", { name: "Settings" })).toBeVisible();
});

interface SeededRun {
  runId: string;
  sessionId: string;
  /** The title the BINDING captured, which is what a Review row must print. */
  sessionName: string;
  /** The conversation GUID, which is what a Review row must not print in its place. */
  noteKey: string;
}

/**
 * One real run, held in `waiting_for_session` by a Persona with a known opinion.
 *
 * The same deterministic seeding `workflow-run-disable.spec.ts` uses, and the reason the fake
 * answers `E2E_FAIL_VERDICT` at all. The binding's own two identity fields come back with it,
 * because reading them from the daemon is what stops the row assertions from being a
 * restatement of the fixture.
 */
async function seedReviewRun(
  dashboard: Page,
  daemon: DaemonHandle,
  intent: string,
  name: string,
  /**
   * A published version to reuse. Three runs of ONE workflow is what a real pile looks like,
   * and it is three fewer publishes than a workflow each.
   */
  reuse: string | null = null,
): Promise<SeededRun> {
  const before = await sessionIds(daemon);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  const sessionId = await waitForIdleSession(daemon, before);

  const versionId = reuse ?? await publishFailingWorkflow(daemon, name);
  const binding = await api<{ id: string; sessionName: string; noteKey: string }>(
    daemon,
    "/api/workflow-bindings",
    { workflowVersionId: versionId, sessionId, deliveryMode: "preview" },
  );
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `e2e-line-drawer-${name}` },
  );
  const runId = submitted.run.id;
  await expect.poll(async () =>
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
  { timeout: 60_000 }).toBe("waiting_for_session");
  return {
    runId,
    sessionId,
    sessionName: binding.sessionName,
    noteKey: binding.noteKey,
  };
}

/** One published workflow whose only reviewer always fails, and its immutable version id. */
async function publishFailingWorkflow(daemon: DaemonHandle, name: string): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `Strict reviewer ${name}`,
    guidanceMarkdown: "# Strict reviewer\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name,
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  return published.version.id;
}

/**
 * Kill a session and wait for the run bound to it to reach `blocked:session_disappeared`.
 *
 * The state under test cannot be seeded by writing SQLite: run summaries are served from an
 * in-memory map on the Registry rather than re-read per request, so a direct UPDATE never
 * reaches the browser. The daemon has to do it - kill the session and let `session_remove`
 * reach `orphanBinding`, which is the exact path all 31 blocked runs on the real fleet took.
 *
 * `EXIT_LINGER_MS` is a hardcoded 8s between the session exiting and `session_remove` firing,
 * and it is not env-tunable - so the poll gets its own explicit budget rather than the 20s
 * `expect` default. Killing several sessions FIRST and waiting afterwards spends one linger
 * window on the whole set instead of one each, which is what keeps a three-run pile inside
 * the per-spec timeout.
 */
async function waitForOrphanedRun(daemon: DaemonHandle, runId: string): Promise<void> {
  await expect.poll(async () => {
    const detail = await api<{ run: { status: string; currentPhase: string } }>(
      daemon,
      `/api/workflow-runs/${runId}`,
    );
    return `${detail.run.status}:${detail.run.currentPhase}`;
  }, { timeout: 60_000 }).toBe("blocked:session_disappeared");
}

test("the Review drawer reads a live run and escalates to it at #/runs/:id", async ({
  dashboard,
  daemon,
}) => {
  const { runId } = await seedReviewRun(
    dashboard,
    daemon,
    "hold a session for the Review drawer",
    "Drawer review",
  );

  await stage(dashboard, "Review").click();
  const review = drawer(dashboard, "Review");
  await expect(review).toBeVisible();

  // The row is a projection of the SSE summary: the run's workflow, its round, and the
  // reviewer chip that failed it. No detail was fetched to draw any of it.
  const row = review.locator(".line-run-row").first();
  await expect(row).toContainText("Drawer review v1");
  await expect(row).toContainText("1 reviewer failed");
  await expect(review.locator(".line-drawer-count")).toContainText("1 run live");
  await shoot(dashboard, "review-open");

  // Escalation: the full reader is one click deeper, at the re-homed route.
  await row.getByRole("button", { name: "Open run" }).click();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${runId}$`));
  await expect(dashboard.getByRole("heading", { level: 2, name: "Workflow runs" })).toBeVisible();
  await expect(dashboard.locator(".wf-run-reader")).toContainText("Drawer review");

  // The strip is fleet chrome: it did not follow us, and neither did the drawer.
  await expect(dashboard.getByRole("navigation", { name: "The Line" })).toBeHidden();
  await expect(anyDrawer(dashboard)).toHaveCount(0);

  // "All runs →" is the other escalation, and it lands on the unfiltered list.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await stage(dashboard, "Review").click();
  await dashboard.getByRole("button", { name: /^All runs/ }).click();
  await expect(dashboard).toHaveURL(/#\/runs$/);
});

test("a run whose session was removed says who it is, why it stopped, and dismisses from the row", async ({
  dashboard,
  daemon,
}) => {
  const seeded = await seedReviewRun(
    dashboard,
    daemon,
    "hold a session that is about to be killed",
    "Orphan review",
  );
  // The fixture has to be able to fail, or the assertions below are decoration: a title that
  // was never captured, or a note key that happened to equal it, would let a drawer printing
  // GUIDs pass this spec.
  expect(seeded.sessionName.length).toBeGreaterThan(0);
  expect(seeded.sessionName).not.toBe(seeded.noteKey);

  // Kill the session and let `session_remove` reach `orphanBinding` - see
  // `waitForOrphanedRun` for why this state cannot be seeded any other way.
  await api(daemon, `/api/sessions/${seeded.sessionId}/kill`, {});
  await waitForOrphanedRun(daemon, seeded.runId);

  // A SECOND run, still live, so the drawer holds one row with a remedy and one without. That
  // mix is the whole shape of the real fleet, and it is the only way to see whether the state
  // column is still a column once some rows carry an extra control.
  const live = await seedReviewRun(
    dashboard,
    daemon,
    "hold a session that keeps running",
    "Live review",
  );

  await stage(dashboard, "Review").click();
  const review = drawer(dashboard, "Review");
  await expect(review).toBeVisible();
  await expect(review.locator(".line-run-row")).toHaveCount(2);
  const row = review.locator(".line-run-row").filter({ hasText: seeded.sessionName });
  const liveRow = review.locator(".line-run-row").filter({ hasText: live.sessionName });

  // WHO. The binding's captured title, which outlived the session - and not the conversation
  // GUID that used to be the second and only fallback.
  await expect(row.locator("strong")).toHaveText(seeded.sessionName);
  await expect(row).not.toContainText(seeded.noteKey);

  // A run that is still working is offered nothing, and the two rows still line up. Only a
  // laid-out browser can see this: the remedy makes the trailing column wider, and without a
  // floor under it the row above and the row below print their cause at different indents.
  await expect(liveRow.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  const causeX = async (target: Locator): Promise<number> =>
    (await target.locator(".line-run-state").boundingBox())!.x;
  expect(await causeX(row)).toBe(await causeX(liveRow));

  // WHY. The cause, beside the status word that used to be the whole sentence.
  await expect(row.locator(".line-run-state")).toHaveText("Blocked · session gone");
  // Stopped, not "your turn": the two used to share one amber edge.
  await expect(row).toHaveClass(/is-blocked/);
  await expect(row).not.toHaveClass(/is-waiting/);
  // And the reviewer chip is untouched by the tone change, because this reviewer did not stop
  // - it returned a failing verdict before the session died, and it keeps the blame it
  // earned. ("Reviewers stopped" is the chip for attempts `orphanBinding` cancelled while
  // they were still queued, which is a pure derivation over a summary and is pinned in
  // `test/line-drawer.test.ts` rather than raced for here.)
  await expect(row).toContainText("1 reviewer failed");
  await shoot(dashboard, "review-blocked");

  // WHAT TO DO. The remedy is reachable by role and name, and it confirms before it fires -
  // this control can end a run from a panel one keystroke off the strip.
  const dismiss = row.getByRole("button", { name: "Dismiss" });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  const confirm = dashboard.getByRole("dialog", { name: "Cancel this run" });
  await expect(confirm).toBeVisible();
  // It names what is being stopped in the words the row used, not by id.
  await expect(confirm).toContainText(seeded.sessionName);
  await expect(confirm).toContainText("Orphan review v1");

  // Escape backs out of the confirm and leaves the drawer - and the run - exactly as they
  // were. The modal registers with the overlay stack, which is the only reason one Escape
  // peels one layer here.
  await dashboard.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(review).toBeVisible();
  await expect(row).toBeVisible();

  // A drawer that can act has to be able to say it failed, and that is not assertable by
  // hoping: break the route first, so the alert has something real to report. The row must
  // survive - a triage surface that drops a row on a refused request has lied about the fleet.
  await dashboard.route(`**/api/workflow-runs/${seeded.runId}/cancel`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: '{"error":"The run changed before it could be cancelled"}',
    }));
  await dismiss.click();
  await dashboard.getByRole("button", { name: "Cancel run" }).click();
  const alert = review.getByRole("alert");
  await expect(alert).toContainText("The run changed before it could be cancelled");
  await expect(row).toBeVisible();
  // Outside the capped, scrolling body - an error the list can scroll away from is an error
  // nobody reads.
  await expect(alert).not.toHaveClass(/line-drawer-body/);
  await expect(review.locator(".line-drawer-body")).not.toContainText(
    "The run changed before it could be cancelled",
  );

  await dashboard.unroute(`**/api/workflow-runs/${seeded.runId}/cancel`);
  await dismiss.click();
  await dashboard.getByRole("button", { name: "Cancel run" }).click();

  // The round trip the drawer never used to make: a POST to a run route, the daemon's own
  // publish, and the row leaving over SSE with no refetch and no reload. The live run stays -
  // the remedy acted on the run it was on and on nothing else.
  await expect(row).toHaveCount(0);
  await expect(liveRow).toBeVisible();
  await expect(review.locator(".line-drawer-count")).toContainText("1 run live");
  await expect.poll(async () =>
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${seeded.runId}`)).run.status,
  ).toBe("cancelled");
  expect(
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${live.runId}`)).run.status,
  ).toBe("waiting_for_session");
});

test("runs that stopped for one reason fold into one bar, and the strip stops calling them yours", async ({
  dashboard,
  daemon,
}) => {
  // Three runs of ONE workflow, which is what the real pile is: 31 runs of No-Mistakes Review
  // whose sessions were removed. Publishing once means the bar's workflow line is a real
  // claim about all three rather than an artefact of three separately-named fixtures.
  const version = await publishFailingWorkflow(daemon, "Pile review");
  const seeded: SeededRun[] = [];
  /**
   * One more run on the pile: dispatch, bind, submit, kill, and wait for the block.
   *
   * SEQUENTIAL, and that is a constraint of the fake rather than a preference. `fake-claude`
   * reports one fixed conversation id per daemon (`MC_E2E_SESSION_ID`), so every session it
   * launches shares a note key - and `createBinding` allows one active binding per note key.
   * Two live bindings at once is a 409, so each session has to be orphaned (which releases
   * its binding) before the next can be bound. The cost is one `EXIT_LINGER_MS` window each,
   * which is why this spec seeds three and not thirty-one.
   */
  const pile = async (nth: string): Promise<void> => {
    const run = await seedReviewRun(
      dashboard,
      daemon,
      `hold the ${nth} session in the pile`,
      `Pile ${nth}`,
      version,
    );
    // The fixture has to be able to fail: a title that was never captured, or one that
    // happened to equal the note key, would let a bar listing GUIDs pass this spec.
    expect(run.sessionName.length).toBeGreaterThan(0);
    expect(run.sessionName).not.toBe(run.noteKey);
    await api(daemon, `/api/sessions/${run.sessionId}/kill`, {});
    await waitForOrphanedRun(daemon, run.runId);
    seeded.push(run);
  };

  // ---- two is two rows ----
  await pile("first");
  await pile("second");

  await stage(dashboard, "Review").click();
  const review = drawer(dashboard, "Review");
  await expect(review).toBeVisible();
  // A pair is not a pile. Two blocked runs sharing a reason stay two ordinary rows, with
  // their chips, their round counters and a `Dismiss` each - a bar here would save one line
  // and cost all six of those facts.
  await expect(review.locator(".line-run-row")).toHaveCount(2);
  await expect(review.locator(".line-group")).toHaveCount(0);
  await shoot(dashboard, "review-pair-not-a-pile");

  // ---- three is one bar ----
  // The drawer stays open across the third seeding, which needs the fleet: closing it keeps
  // the dispatch dialog reachable and reopening it is what the assertions below read.
  await stage(dashboard, "Review").click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await pile("third");
  await stage(dashboard, "Review").click();
  await expect(review).toBeVisible();

  const bar = review.locator(".line-group");
  await expect(bar).toHaveCount(1);
  // The reason once, the count once. And not one of the three rows it replaced: the drawer
  // that used to make a person scroll thirty-one identical sentences now says it on one line.
  await expect(bar).toContainText("3 runs · session gone");
  await expect(review.locator(".line-run-row")).toHaveCount(0);
  // The members are named by the binding titles that outlived their sessions, never by the
  // conversation GUIDs - the bar resolves identity through the same three steps a row does.
  for (const run of seeded) await expect(bar).toContainText(run.sessionName);
  for (const run of seeded) await expect(bar).not.toContainText(run.noteKey);
  await shoot(dashboard, "review-grouped");

  // ---- the strip and the drawer say the same two numbers ----
  // This is the headline: three dead runs are not three decisions waiting on a person. The
  // strip's accessible name is built from the same fold the header prints, so if either
  // surface drifted this fails on one of the two.
  await expect(review.locator(".line-drawer-count")).toContainText("3 runs live");
  await expect(review.locator(".line-drawer-att")).toHaveText("3 stalled");
  await expect(review.locator(".line-drawer-att")).not.toContainText("waiting on you");
  await expect(stage(dashboard, "Review")).toHaveAttribute("aria-label", /3 stalled/);
  await expect(stage(dashboard, "Review")).not.toHaveAttribute("aria-label", /waiting on you/);

  // ---- every member is still reachable ----
  // The drawer's standing promise is that the cap is on the panel and never on the list. A
  // fold that HID thirty runs would break it; the caret is what keeps it.
  // `exact`, because the batch's own name deliberately extends this one - "Dismiss all 3 runs
  // blocked, session gone" is what makes two bars' controls tellable apart on a real fleet.
  const disclosure = review.getByRole("button", {
    name: "3 runs blocked, session gone",
    exact: true,
  });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(review.locator(".line-run-row")).toHaveCount(3);
  for (const run of seeded) {
    await expect(review.locator(".line-run-row").filter({ hasText: run.sessionName }))
      .toContainText("Blocked · session gone");
  }
  // A member's title starts EXACTLY under the bar's title - the 44px indent is the bar's own
  // padding plus its caret plus the gap after it, not a decorative number. Only a laid-out
  // browser can see this, and a few pixels out would put two title columns down one panel.
  const titleX = async (target: Locator): Promise<number> =>
    (await target.locator("strong").first().boundingBox())!.x;
  expect(await titleX(review.locator(".line-run-row").first())).toBe(await titleX(bar));
  await shoot(dashboard, "review-group-expanded");
  await disclosure.click();
  await expect(review.locator(".line-run-row")).toHaveCount(0);

  // ---- one control for the batch ----
  const dismissAll = review.getByRole("button", { name: "Dismiss all 3 runs blocked, session gone" });
  await expect(dismissAll).toBeVisible();
  await dismissAll.click();
  // It confirms with the COUNT echoed, because this ends three runs - thirty, on the fleet it
  // was built for - from a panel one keystroke off the strip.
  const confirm = dashboard.getByRole("dialog", { name: "Cancel 3 runs" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("3 runs stopped for the same reason: session gone");

  // Escape backs out and changes nothing, which is the half of a confirm that matters.
  await dashboard.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(bar).toHaveCount(1);
  expect(
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${seeded[0]!.runId}`)).run.status,
  ).toBe("blocked");

  // ---- and a batch that only partly worked says so ----
  // There is no batch route: `Dismiss all` is three independent POSTs, so "some of them
  // failed" is a state that genuinely happens and the one a bar must never paper over. Break
  // exactly one of the three first, so the mixed outcome is real rather than hoped for.
  await dashboard.route(`**/api/workflow-runs/${seeded[0]!.runId}/cancel`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: '{"error":"The run changed before it could be cancelled"}',
    }));
  await dismissAll.click();
  await dashboard.getByRole("button", { name: "Cancel 3 runs" }).click();

  // The count is the honest report: two runs left, one did not, and the drawer says which
  // arithmetic it is describing rather than claiming it cleared a pile it did not.
  const alert = review.getByRole("alert");
  await expect(alert).toContainText("1 of 3 runs could not be dismissed");
  await expect(alert).toContainText("The run changed before it could be cancelled");
  // And the surface RECOUNTS from what is actually still there: one run is not a pile, so the
  // bar is gone and what is left is the ordinary row it always would have been.
  await expect(bar).toHaveCount(0);
  await expect(review.locator(".line-run-row")).toHaveCount(1);
  await expect(review.locator(".line-run-row")).toContainText(seeded[0]!.sessionName);
  await expect(review.locator(".line-drawer-count")).toContainText("1 run live");
  await expect(review.locator(".line-drawer-att")).toHaveText("1 stalled");
  // Two POSTs did land, on the daemon, which is what makes this a partial and not a refusal.
  for (const run of seeded.slice(1)) {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${run.runId}`)).run.status,
    ).toBe("cancelled");
  }
  expect(
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${seeded[0]!.runId}`)).run.status,
  ).toBe("blocked");

  // ---- the survivor is still dismissable from its own row ----
  await dashboard.unroute(`**/api/workflow-runs/${seeded[0]!.runId}/cancel`);
  await review.locator(".line-run-row").getByRole("button", { name: "Dismiss" }).click();
  await dashboard.getByRole("button", { name: "Cancel run" }).click();
  await expect(review.locator(".line-drawer-count")).toContainText("0 runs live");
  await expect(review.locator(".line-drawer-att")).toHaveCount(0);
  await expect(review).toContainText("No workflow runs are in flight");
  await expect(alert).toHaveCount(0);
  await expect.poll(async () =>
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${seeded[0]!.runId}`)).run.status,
  ).toBe("cancelled");
});

// ---------------------------------------------------------------------------
// SHIPPED - the adoption ledger, one click off the count that is made of it
// ---------------------------------------------------------------------------

/**
 * The daemon's own adoption signal: the hook a harness fires when `gh pr create` returns.
 *
 * The AGENT's session id, not the card's - a hook naming the wrong one lands on no session at
 * all, and the test would then pass by never adopting anything. Same lever
 * `ship-log.spec.ts` uses, because it is the production path: no route writes `inspector_prs`
 * directly, and the two signals that can are this hook and a driver's `pr_created` event.
 */
async function announcePullRequest(daemon: DaemonHandle, url: string): Promise<void> {
  const sessions = await api<Array<{
    id: string;
    state: string;
    agent: string;
    cwd: string;
    agentSessionId: string | null;
  }>>(daemon, "/api/sessions");
  const live = sessions.find((session) => session.state !== "exited");
  if (!live) throw new Error("no live session to adopt a pull request onto");
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: live.agent,
      sessionId: live.agentSessionId ?? live.id,
      cwd: live.cwd,
      prCreated: true,
      prUrl: url,
    }),
  });
  if (!response.ok) throw new Error(`hook answered ${response.status}: ${await response.text()}`);
}

/**
 * A ledger row as the route serves it.
 *
 * A cross-repo week cannot be dispatched out of one temporary repository, and the two columns
 * that name a row (`title`, `head_ref_name`) are written by the Inspector's GitHub poll, which
 * reaches a network this layer has none of. So the multi-row cases fulfil the READ - the same
 * split, and the same shape, `ship-log.spec.ts` draws.
 */
function ledgerRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    key: "owner/repo#1",
    url: "https://github.example/owner/repo/pull/1",
    owner: "owner",
    repo: "repo",
    number: 1,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId: null,
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: null,
    adoptedAt: Date.now(),
    updatedAt: Date.now(),
    openFindings: 0,
    postedOpenFindings: 0,
    resolvedFindings: 0,
    ...over,
  };
}

test("a pull request adopted through the hook lands in the Shipped drawer, over the week the strip counts", async ({
  dashboard,
  daemon,
}) => {
  // The real path end to end: a dispatched session, the hook the harness fires when
  // `gh pr create` returns, the row that lands in `inspector_prs`, the windowed read the
  // drawer makes, and the browser rendering it back. A spec that only fulfilled the route
  // would pass on a build where nothing the fleet does ever reaches this list.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("open a pull request, notionally");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await waitForIdleSession(daemon);

  // What the drawer ASKS for, recorded on the way through rather than asserted about the
  // component. The parameterless read is 50 rows ordered by review recency, which truncates
  // and reorders a busy week - a drawer that then disagrees with the number on the button
  // that opened it, about rows from one table.
  const asked: string[] = [];
  await dashboard.route("**/api/inspector/prs*", async (route) => {
    asked.push(new URL(route.request().url()).search);
    await route.fallback();
  });

  await announcePullRequest(daemon, "https://github.com/mancej-cyc/ai-harness/pull/241");
  await expect
    .poll(async () => (await api<unknown[]>(daemon, "/api/inspector/prs")).length)
    .toBe(1);

  await stage(dashboard, "Shipped").click();
  const shipped = drawer(dashboard, "Shipped");
  await expect(shipped).toBeVisible();

  // The strip's own count and the drawer's are the same seven days off the same column, so
  // they agree by construction rather than by two folds being kept in step by hand.
  await expect(shipped.locator(".line-drawer-count")).toHaveText("1 this week");
  await expect(stage(dashboard, "Shipped")).toHaveAttribute("aria-label", /^Shipped, 1 /);

  await expect.poll(() => asked.length).toBeGreaterThan(0);
  for (const search of asked) {
    expect(search, "the Shipped drawer must never take the parameterless ledger read")
      .toMatch(/^\?adoptedSince=\d+$/);
  }

  // Nothing has polled this row, so it has neither a title nor a branch - both are written by
  // the same observation. The number is the last thing that is always true about a pull
  // request, and it is what the row is named by.
  const row = shipped.locator(".line-ship-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("#241");
  await expect(row).toContainText("open");
  // ONCE in the title line: the subline carries whatever the title did not already say, and
  // on this rung of the fallback the title IS the number.
  const heading = await row.locator(".sc-pr").innerText();
  expect(heading.trim()).toBe("#241");
  // The row's one destination is the pull request itself.
  await expect(row.getByRole("link")).toHaveAttribute(
    "href",
    "https://github.com/mancej-cyc/ai-harness/pull/241",
  );
  // And the owning session rides with it, abbreviated - this is the fact that makes a ledger
  // row traceable back to the fleet.
  await expect(row.locator(".sc-ref")).toBeVisible();
  await shoot(dashboard, "shipped-adopted");
});

test("the chips split the week by merge state, and the header escalates to the Ship log", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.route("**/api/inspector/prs*", async (route) => {
    const now = Date.now();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        ledgerRow({
          key: "mancej-cyc/ai-harness#241",
          owner: "mancej-cyc",
          repo: "ai-harness",
          number: 241,
          title: "Focus order for line drawer chips",
          headRefName: "fix/line-drawer-focus",
          mergedAt: now,
          adoptedAt: now - 2 * 3600_000,
          sessionId: "proc:/dev/ttys004:4123:1700",
        }),
        ledgerRow({
          key: "mancej-cyc/ai-harness#243",
          owner: "mancej-cyc",
          repo: "ai-harness",
          number: 243,
          headRefName: "e2e/shipped-drawer-spec",
          adoptedAt: now - 6 * 3600_000,
        }),
        ledgerRow({
          key: "jordanmance/notes#12",
          owner: "jordanmance",
          repo: "notes",
          number: 12,
          title: "Summarizer draft",
          headRefName: "draft/summarizer",
          state: "closed",
          adoptedAt: now - 30 * 3600_000,
        }),
      ]),
    });
  });

  await stage(dashboard, "Shipped").click();
  const shipped = drawer(dashboard, "Shipped");
  await expect(shipped).toBeVisible();
  await expect(shipped.locator(".line-drawer-count")).toHaveText("3 this week");

  // Newest adoption FIRST, which is the ledger's own ordering and the only one that makes a
  // three-row cap show the rows worth glancing at.
  await expect(shipped.locator(".line-ship-row").first())
    .toContainText("Focus order for line drawer chips");
  await expect(shipped.locator(".line-ship-row").last()).toContainText("Summarizer draft");

  // A titled row is named by its title, and the branch drops to the subline beside the repo
  // and number rather than vanishing - it is what the operator typed and still recognizes.
  const titled = shipped.locator(".line-ship-row").filter({ hasText: "Focus order" });
  await expect(titled.locator(".line-ship-sub"))
    .toHaveText("mancej-cyc/ai-harness#241 · fix/line-drawer-focus");
  // An untitled one falls back to its branch, and then the subline must not print that branch
  // a second time in a smaller type size.
  const untitled = shipped.locator(".line-ship-row").filter({ hasText: "e2e/shipped-drawer-spec" });
  await expect(untitled.locator(".sc-pr")).toHaveText("e2e/shipped-drawer-spec");
  await expect(untitled.locator(".line-ship-sub")).toHaveText("mancej-cyc/ai-harness#243");

  // Every state is spelled with a WORD and not only a hue, on the row and on the chip.
  await expect(titled).toContainText("merged");
  await expect(untitled).toContainText("open");
  await expect(shipped.locator(".line-ship-row").filter({ hasText: "Summarizer" }))
    .toContainText("gone");
  await shoot(dashboard, "shipped-open");

  // ---- narrow: the session handle goes, the merge state never does ----
  // The other drawers drop their free-text state column under 1180px, because it is the one
  // field also reachable from the chips beside it. On THIS row the state is the whole point,
  // the chips filter on exactly it, and dropping the word would leave a hue carrying it
  // alone - so the session handle goes instead. Only a laid-out browser can see which one
  // actually disappeared.
  await dashboard.setViewportSize({ width: 1100, height: 720 });
  await expect(titled.locator(".sc-ref")).toBeHidden();
  await expect(titled).toContainText("merged");
  await expect(titled).toContainText("2h ago");
  // And the row is still one row: the drawer's three-row cap is arithmetic over a fixed
  // height, and a column that wrapped instead of clipping would leave half a row peeking
  // over the edge of the body.
  expect((await titled.boundingBox())!.height).toBe(58);
  await dashboard.setViewportSize({ width: 1280, height: 720 });
  await expect(titled.locator(".sc-ref")).toBeVisible();

  // ---- the chips are the filter, and they are toggles ----
  // Case-insensitive on purpose: the words come from `PR_STANDING_LABELS`, which the rows
  // spell in small caps and the chips case up in CSS. Pinning the casing here would pin a
  // stylesheet rule through an accessible name.
  const chip = (name: RegExp) => shipped.getByRole("button", { name });
  await expect(chip(/^All 3$/i)).toHaveAttribute("aria-pressed", "true");
  await chip(/^merged 1$/i).click();
  await expect(chip(/^merged 1$/i)).toHaveAttribute("aria-pressed", "true");
  await expect(chip(/^All 3$/i)).toHaveAttribute("aria-pressed", "false");
  await expect(shipped.locator(".line-ship-row")).toHaveCount(1);
  await expect(shipped.locator(".line-ship-row")).toContainText("Focus order");
  // The counts do NOT narrow with the selection: they are what the selection was made from,
  // and a chip strip that re-tallied itself could never be used to get back out.
  await expect(chip(/^All 3$/i)).toBeVisible();
  await expect(chip(/^gone 1$/i)).toBeVisible();

  // Pressing the pressed chip is the way back out - the off state is "all of them".
  await chip(/^merged 1$/i).click();
  await expect(shipped.locator(".line-ship-row")).toHaveCount(3);
  await expect(chip(/^All 3$/i)).toHaveAttribute("aria-pressed", "true");

  // And none of it reaches the address bar: which pile you are reading is what you are
  // looking at, not where you are.
  const border = (name: RegExp): Promise<string> =>
    chip(name).evaluate((el) => getComputedStyle(el).borderTopColor);
  const resting = await border(/^gone 1$/i);
  await chip(/^gone 1$/i).click();
  await expect(shipped.locator(".line-ship-row")).toHaveCount(1);
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");
  // `aria-pressed` is the half a DOM assertion can read; this is the half a person reads.
  // Compared against the same chip's own resting paint rather than against a hex, so it
  // survives a theme without being a restatement of the stylesheet - and waiting for it
  // settles the 140ms crossfade, so the frame below is a pressed chip and not one halfway
  // between two fills.
  await expect.poll(() => border(/^gone 1$/i)).not.toBe(resting);
  await shoot(dashboard, "shipped-filtered");

  // ---- the escalation ----
  await shipped.getByRole("button", { name: /^Ship log/ }).click();
  await expect(dashboard).toHaveURL(/#\/shipped$/);
  await expect(dashboard.getByRole("heading", { level: 2, name: "Ship log" })).toBeVisible();
  // The strip is fleet chrome: it did not follow us, and neither did the drawer.
  await expect(dashboard.getByRole("navigation", { name: "The Line" })).toBeHidden();
  await expect(anyDrawer(dashboard)).toHaveCount(0);

  // Back on the fleet, the stage opens rather than toggling shut - the drawer was genuinely
  // dropped on the way out and not merely hidden.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await stage(dashboard, "Shipped").click();
  await expect(drawer(dashboard, "Shipped")).toBeVisible();
});

test("a ledger read that fails says so, instead of reporting a week in which nothing shipped", async ({
  dashboard,
}) => {
  // The CONTROL first, and it is not optional: the assertion below is that a sentence is
  // absent, and a sentence that could never appear here would make it pass through the exact
  // regression it names. On a fleet that has adopted nothing, the drawer does say so.
  const shipped = () => drawer(dashboard, "Shipped");
  await stage(dashboard, "Shipped").click();
  await expect(shipped()).toContainText("No pull request was adopted in the last seven days");
  await expect(shipped().locator(".line-drawer-count")).toHaveText("0 this week");
  await stage(dashboard, "Shipped").click();
  await expect(anyDrawer(dashboard)).toHaveCount(0);

  // Now break the read. `fetchJson` swallows every failure and resolves null, so this is the
  // shape a real outage takes: not an exception, just an absence.
  await dashboard.route("**/api/inspector/prs*", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));

  await stage(dashboard, "Shipped").click();
  await expect(shipped()).toBeVisible();
  await expect(shipped()).toContainText("The adoption ledger could not be read");
  await expect(shipped()).toContainText("It is not a report that nothing did");
  // It must not claim the absence, and above all must not print a zero the operator cannot
  // tell from a real one - the strip above it is showing a number this drawer would then be
  // contradicting.
  await expect(shipped()).not.toContainText("No pull request was adopted");
  await expect(shipped().locator(".line-drawer-count")).toHaveText("ledger unavailable");
  // Counts it does not have are not drawn as zeroes either.
  await expect(shipped().locator(".line-ship-chip")).toHaveCount(0);
  // The escalation survives: the page one click deeper reads the same ledger through the
  // same route, and it is the obvious next thing to try.
  await expect(shipped().getByRole("button", { name: /^Ship log/ })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Backlog: the queue, and the moves that change it
// ---------------------------------------------------------------------------

/** `PUT`, for the one seeded thing that is not created by a `POST`. */
async function put<T>(daemon: DaemonHandle, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface SeededTask {
  id: string;
  title: string;
}

async function seedTask(
  daemon: DaemonHandle,
  title: string,
  over: Record<string, unknown> = {},
): Promise<SeededTask> {
  const task = await api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    intent: `Whatever "${title}" is for.`,
    title,
    backlog: true,
    // Explicit null opts the task out of the machine's default post-work Workflow. Left
    // omitted, the configured default arms Live delivery, which this repo is not allowlisted
    // for - so the dispatch is REFUSED, and a launch spec would be measuring the allowlist
    // rather than the button. (The drawer reports that refusal and keeps the row, which is
    // how this was found. `dispatch-and-converse.spec.ts` pins the same field for the same
    // reason, through the modal's own picker.)
    workflowId: null,
    ...over,
  });
  return { id: task.id, title };
}

/** The drawer's row titles, top to bottom - the claim the whole panel is making. */
const queueTitles = (page: Page): Promise<string[]> =>
  drawer(page, "Backlog").locator(".line-bl-title").allInnerTexts();

const bandRows = (page: Page, band: "Ready, in the order autopilot would take them" | "Blocked and parked"): Locator =>
  drawer(page, "Backlog").getByRole("list", { name: band }).locator("li");

test("the ready band is Foreman's plan order, and the head of it is what autopilot takes next", async ({
  dashboard,
  daemon,
}) => {
  // Priority-then-age is the order the BOARD column uses, so seeding the plan's last item as
  // the only `blocker` is what makes this a test of plan order rather than of any order at
  // all: a drawer that re-sorted by priority would put "Hot but planned last" on top and
  // mark it next up, contradicting the machine that is about to take something else.
  const first = await seedTask(daemon, "Planned first", { priority: "low" });
  const second = await seedTask(daemon, "Planned second");
  const hot = await seedTask(daemon, "Hot but planned last", { priority: "blocker" });
  await put(daemon, "/api/backlog/plan", {
    entries: [first, second, hot].map(({ id }) => ({ taskId: id, dependsOn: [], reason: null })),
    note: null,
  });

  await stage(dashboard, "Backlog").click();
  const backlog = drawer(dashboard, "Backlog");
  await expect(backlog).toBeVisible();

  // The plan arrives on `useForeman`'s 4s poll rather than over SSE, so the order is what is
  // polled for - and the count is asserted first, since three rows in any order is the state
  // BEFORE the plan lands.
  await expect(backlog.locator(".line-drawer-count")).toHaveText("3 ready");
  await expect
    .poll(() => queueTitles(dashboard), { timeout: 20_000 })
    .toEqual(["Planned first", "Planned second", "Hot but planned last"]);

  // Exactly one next-up mark, and it is on the head. Two would be two answers to a question
  // that has one.
  await expect(backlog.getByText("next up", { exact: true })).toHaveCount(1);
  await expect(bandRows(dashboard, "Ready, in the order autopilot would take them").first())
    .toContainText("next up");
  // One band, so one list: a second, empty one would announce a group with nothing in it.
  await expect(backlog.getByRole("list")).toHaveCount(1);
});

test("blocked and parked rows sit in their own band, saying why, and moving between them", async ({
  dashboard,
  daemon,
}) => {
  const base = await seedTask(daemon, "Lay the base");
  await seedTask(daemon, "Build on the base", {
    dependencies: [{ type: "task", taskId: base.id }],
  });
  const held = await seedTask(daemon, "Held back for now");
  await api(daemon, `/api/tasks/${held.id}/update`, { enabled: false });

  await stage(dashboard, "Backlog").click();
  const backlog = drawer(dashboard, "Backlog");
  const ready = bandRows(dashboard, "Ready, in the order autopilot would take them");
  const stuck = bandRows(dashboard, "Blocked and parked");

  await expect(backlog.locator(".line-drawer-count")).toHaveText("1 ready · 1 blocked · 1 parked");
  await expect(ready).toHaveCount(1);
  await expect(ready.first()).toContainText("Lay the base");
  await expect(stuck).toHaveCount(2);
  // Named in the board card's own words - "after X", never a bare "blocked" - so the row says
  // what to go and look at.
  await expect(stuck.filter({ hasText: "Build on the base" })).toContainText("after Lay the base");
  await expect(stuck.filter({ hasText: "Held back for now" })).toContainText("parked");
  // The ready band leads, and both are reachable by name rather than by a visible caption -
  // a caption inside a body capped at exactly three rows leaves a partial row over the edge.
  const lists = backlog.getByRole("list");
  await expect(lists).toHaveCount(2);
  await expect(lists.first()).toHaveAccessibleName("Ready, in the order autopilot would take them");
  await expect(lists.last()).toHaveAccessibleName("Blocked and parked");
  await shoot(dashboard, "backlog-bands");

  // ---- the switch moves a row between bands, and it is the shared control ----

  // Resuming the parked one: it has no blockers, so it belongs in the ready band the moment
  // the write lands. This is the round trip - a drawer holding its own optimistic copy would
  // pass a click assertion and fail this one.
  await stuck.filter({ hasText: "Held back for now" })
    .getByRole("switch", { name: "Foreman may schedule Held back for now" }).click();
  await expect(ready).toHaveCount(2);
  await expect(ready.filter({ hasText: "Held back for now" })).toBeVisible();
  await expect(backlog.locator(".line-drawer-count")).toHaveText("2 ready · 1 blocked");

  // And back the other way, from the row it moved to.
  await ready.filter({ hasText: "Held back for now" })
    .getByRole("switch", { name: "Foreman may schedule Held back for now" }).click();
  await expect(stuck.filter({ hasText: "Held back for now" })).toContainText("parked");
  await expect(backlog.locator(".line-drawer-count")).toHaveText("1 ready · 1 blocked · 1 parked");
  // The daemon actually holds it, rather than the row having re-rendered off local state.
  const stored = await api<Array<{ id: string; enabled: boolean }>>(daemon, "/api/tasks");
  expect(stored.find((t) => t.id === held.id)?.enabled).toBe(false);

  // ---- the ordering lever is only on the rows being ordered ----

  // A priority set on a blocked row orders nothing, so the picker is not offered there.
  await expect(backlog.getByLabel("Priority for Lay the base")).toBeVisible();
  await expect(backlog.getByLabel("Priority for Build on the base")).toHaveCount(0);
});

test("the priority picker round-trips through the daemon and re-sorts the queue", async ({
  dashboard,
  daemon,
}) => {
  // No plan seeded on purpose: with none, `readyBacklog` falls back to priority-then-age,
  // which is what makes the re-sort visible from the picker alone.
  await seedTask(daemon, "Was on top");
  const climber = await seedTask(daemon, "Was underneath");

  await stage(dashboard, "Backlog").click();
  await expect.poll(() => queueTitles(dashboard)).toEqual(["Was on top", "Was underneath"]);

  await drawer(dashboard, "Backlog").getByLabel("Priority for Was underneath")
    .selectOption("blocker");

  // The row moves under the cursor, which is the feedback that makes it obvious the field
  // does something - and it moves because the DAEMON re-sorted, not because the select did.
  await expect.poll(() => queueTitles(dashboard)).toEqual(["Was underneath", "Was on top"]);
  await expect(drawer(dashboard, "Backlog").getByText("next up", { exact: true })).toHaveCount(1);
  await expect(bandRows(dashboard, "Ready, in the order autopilot would take them").first())
    .toContainText("Was underneath");
  const stored = await api<Array<{ id: string; priority: string | null }>>(daemon, "/api/tasks");
  expect(stored.find((t) => t.id === climber.id)?.priority).toBe("blocker");
});

test("Launch now dispatches the row, and the queue it left stops counting it", async ({
  dashboard,
  daemon,
}) => {
  await seedTask(daemon, "Launch me from the drawer");
  const before = await sessionIds(daemon);

  await stage(dashboard, "Backlog").click();
  const backlog = drawer(dashboard, "Backlog");
  await expect(backlog.locator(".line-drawer-count")).toHaveText("1 ready");

  await backlog.getByRole("button", { name: "Launch now" }).click();

  // The daemon's own word for "the launch turn is over" - the fake agent, like every other
  // spec here, so this costs no model tokens.
  const sessionId = await waitForIdleSession(daemon, before);
  expect(sessionId).not.toBe("");

  // A dispatched task is no longer queued, and the drawer that dispatched it says so rather
  // than holding a row for work that is now on the board below it.
  await expect(backlog).toContainText("Nothing is queued");
  await expect(backlog.locator(".line-drawer-count")).toHaveText("nothing queued");
  await expect(backlog.locator(".line-bl-title")).toHaveCount(0);
  await shoot(dashboard, "backlog-drawer-empty");
});

test("the drawer's footer opens the Sitrep, and the stage itself no longer does", async ({
  dashboard,
  daemon,
}) => {
  await seedTask(daemon, "Something to read about");

  // The regression this exists for: the stage press used to open the Sitrep directly, so a
  // half-done flip would still "do something real" and pass a looser assertion.
  await stage(dashboard, "Backlog").click();
  await expect(drawer(dashboard, "Backlog")).toBeVisible();
  await expect(dashboard.getByRole("dialog", { name: "Sitrep" })).toHaveCount(0);
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/fleet");
  await shoot(dashboard, "backlog-drawer");

  // The full-fleet read is one click away, and it is in the FOOTER - under the rows, where
  // Phase 2's autopilot readout joins it - rather than in the header beside the count.
  const footer = drawer(dashboard, "Backlog").locator(".line-drawer-foot");
  await expect(footer.getByRole("button", { name: /^Sitrep/ })).toBeVisible();
  await footer.getByRole("button", { name: /^Sitrep/ }).click();

  await expect(dashboard.getByRole("dialog", { name: "Sitrep" })).toBeVisible();
  // The drawer closed on the way, rather than staying open under a panel that covers the
  // board it was pushing down.
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(stage(dashboard, "Backlog")).toHaveAttribute("aria-expanded", "false");
});

// ---------------------------------------------------------------------------
// Backlog: the autopilot planner, and the footer's autopilot line
// ---------------------------------------------------------------------------

/** The planner's trigger - Phase 1's `next up` pill, now the way into the reasoning. */
const nextUpTrigger = (page: Page): Locator =>
  drawer(page, "Backlog").getByRole("button", { name: /^Next up:/ });

const planner = (page: Page): Locator => page.getByRole("dialog", { name: /^Why / });

/**
 * A queue whose head has a reason, a second ready task to be compared against, and
 * something waiting on the head.
 *
 * All three earn their place. The dependent is what makes "unblocks 1 task" a real
 * derivation rather than a constant - it is blocked through the dispatch route's own
 * `dependencies` field, and it sits in the drawer's other band while the planner counts
 * it. The second ready task is what makes the comparative facts say anything: with one
 * candidate the panel drops its superlatives, so a single-row queue would assert the copy
 * for a queue nobody has to choose within.
 */
async function seedPlannedQueue(daemon: DaemonHandle, reason: string): Promise<SeededTask> {
  const head = await seedTask(daemon, "Persist review verdicts", { priority: "high" });
  const rival = await seedTask(daemon, "Raise the Codex rollout scan cap");
  const dependent = await seedTask(daemon, "Wire verdicts into the ship gate", {
    dependencies: [{ type: "task", taskId: head.id }],
  });
  await put(daemon, "/api/backlog/plan", {
    entries: [
      { taskId: head.id, dependsOn: [], reason },
      { taskId: rival.id, dependsOn: [], reason: "Independent of the verdict work." },
      { taskId: dependent.id, dependsOn: [head.id], reason: "Needs the verdicts to exist." },
    ],
    note: null,
  });
  return head;
}

const REASON = "Nothing else can land until verdicts survive a restart.";

test("the next-up mark opens the planner, which quotes Foreman's own reason", async ({
  dashboard,
  daemon,
}) => {
  await seedPlannedQueue(daemon, REASON);

  await stage(dashboard, "Backlog").click();
  const backlog = drawer(dashboard, "Backlog");
  await expect(backlog.locator(".line-drawer-count")).toHaveText("2 ready · 1 blocked");
  await expect(queueTitles(dashboard)).resolves.toEqual([
    "Persist review verdicts",
    "Raise the Codex rollout scan cap",
    "Wire verdicts into the ship gate",
  ]);

  await expect(planner(dashboard)).toHaveCount(0);
  await nextUpTrigger(dashboard).click();
  const pop = planner(dashboard);
  await expect(pop).toBeVisible();
  await expect(nextUpTrigger(dashboard)).toHaveAttribute("aria-expanded", "true");

  // Foreman's own sentence, verbatim and attributed - the field that has existed on every
  // plan entry since the autopilot shipped and that nothing rendered until now.
  //
  // The generous timeout is `useForeman`'s 4s plan poll, and this is the assertion that
  // waits for it: the panel stays mounted and re-renders under the poll, so the reason
  // appears in the open popover rather than being a precondition for opening it. Nothing
  // earlier can wait for the plan - these two tasks are already in this order without it.
  await expect(pop).toContainText(REASON, { timeout: 20_000 });
  await expect(pop.locator("cite")).toHaveText("Foreman's plan");
  // The rule that put it on top, then the facts a reader can check against the rows behind
  // the panel. "unblocks 1 task" names the task in the blocked band underneath.
  await expect(pop).toContainText("plan order · 2 ready");
  await expect(pop).toContainText("high priority - nothing ready outranks it");
  await expect(pop).toContainText("the oldest of the 2 ready");
  await expect(pop).toContainText("no blockers - nothing upstream is holding it");
  await expect(pop).toContainText("unblocks 1 task: Wire verdicts into the ship gate");

  // NOT CLIPPED, which is the whole reason the panel is `position: fixed`. It is rendered
  // inside `.line-drawer-body` - three rows tall and scrolling - inside `.line-drawer`,
  // which clips. An absolutely-positioned panel would end at the drawer's bottom edge; this
  // one has to hang below it and still be fully on screen.
  const popBox = (await pop.boundingBox())!;
  const drawerBox = (await backlog.boundingBox())!;
  const viewport = dashboard.viewportSize()!;
  expect(popBox.y + popBox.height).toBeGreaterThan(drawerBox.y + drawerBox.height);
  expect(popBox.y + popBox.height).toBeLessThanOrEqual(viewport.height);
  expect(popBox.x).toBeGreaterThanOrEqual(0);
  expect(popBox.x + popBox.width).toBeLessThanOrEqual(viewport.width);
  await shoot(dashboard, "backlog-planner");

  // A click outside puts it away and leaves the queue where it was.
  await backlog.locator(".line-drawer-count").click();
  await expect(planner(dashboard)).toHaveCount(0);
  await expect(backlog).toBeVisible();

  // A SHORT window is where a fixed panel runs off the bottom of the screen. The placement
  // clamps its top and hands the stylesheet the room that is left, so the panel scrolls
  // inside itself and its Launch button - which sits outside that scroll - stays reachable.
  // Re-opened after the resize on purpose: a resize moves the anchor, so it closes first.
  await dashboard.setViewportSize({ width: 1280, height: 520 });
  await expect(planner(dashboard)).toHaveCount(0);
  await nextUpTrigger(dashboard).click();
  const shortBox = (await planner(dashboard).boundingBox())!;
  expect(shortBox.y + shortBox.height).toBeLessThanOrEqual(520);
  await expect(planner(dashboard).getByRole("button", { name: "Launch now" })).toBeVisible();

  // And a NARROW one, where the trigger sits further right than the panel can start: the
  // placement slides it left instead of opening it off the side of the window. The unit
  // test drives the sub-460px case this browser cannot reach - the drawer row's own fixed
  // columns collapse the mark out of view long before the window gets that small - so what
  // is checked here is the clamp actually engaging on a size a person can drag to.
  await dashboard.setViewportSize({ width: 640, height: 720 });
  await expect(planner(dashboard)).toHaveCount(0);
  await nextUpTrigger(dashboard).click();
  const narrowBox = (await planner(dashboard).boundingBox())!;
  expect(narrowBox.x).toBeGreaterThanOrEqual(0);
  expect(narrowBox.x + narrowBox.width).toBeLessThanOrEqual(640);
  await expect(planner(dashboard).getByRole("button", { name: "Launch now" })).toBeVisible();
});

test("the planner explains an unplanned head instead of implying Foreman chose it", async ({
  dashboard,
  daemon,
}) => {
  // No plan seeded at all: `readyBacklog` appends anything the plan does not name, oldest
  // first, so the fallback is what put this task on top. The panel has to say that rather
  // than quoting a reason that does not exist.
  await seedTask(daemon, "Nobody has planned this");

  await stage(dashboard, "Backlog").click();
  await nextUpTrigger(dashboard).click();
  const pop = planner(dashboard);
  await expect(pop).toContainText("Foreman's plan does not name this one yet");
  await expect(pop).toContainText("priority, then age · 1 ready");
  await expect(pop.locator("cite")).toHaveCount(0);
  // No downstream line when it releases nothing - never "unblocks 0 tasks".
  await expect(pop).not.toContainText("unblocks");
});

test("Escape peels the planner first and the drawer second", async ({ dashboard, daemon }) => {
  await seedTask(daemon, "Something to explain");

  await stage(dashboard, "Backlog").click();
  await nextUpTrigger(dashboard).click();
  await expect(planner(dashboard)).toBeVisible();

  // The fleet's own Escape closes the drawer while the keyboard is inside it, and the
  // keyboard IS inside it - the panel takes focus as it opens. One press must take one
  // layer, or the queue disappears while dismissing a panel about one row of it.
  await dashboard.keyboard.press("Escape");
  await expect(planner(dashboard)).toHaveCount(0);
  await expect(drawer(dashboard, "Backlog")).toBeVisible();
  // And the keyboard came back to the mark that opened it, so the second press is in scope.
  await expect(nextUpTrigger(dashboard)).toBeFocused();

  await dashboard.keyboard.press("Escape");
  await expect(anyDrawer(dashboard)).toHaveCount(0);
  await expect(stage(dashboard, "Backlog")).toHaveAttribute("aria-expanded", "false");
});

test("Launch now from the planner dispatches, and the queue behind it stays open", async ({
  dashboard,
  daemon,
}) => {
  await seedTask(daemon, "Launch me from the planner");
  await seedTask(daemon, "And leave me queued");
  const before = await sessionIds(daemon);

  await stage(dashboard, "Backlog").click();
  await nextUpTrigger(dashboard).click();
  // Clicking through Playwright's actionability check is the other half of the clipping
  // proof: a panel cut off by the drawer's overflow would not receive this click at all.
  await planner(dashboard).getByRole("button", { name: "Launch now" }).click();

  // The panel closes on the click; the drawer under it does not.
  await expect(planner(dashboard)).toHaveCount(0);
  await expect(drawer(dashboard, "Backlog")).toBeVisible();

  const sessionId = await waitForIdleSession(daemon, before);
  expect(sessionId).not.toBe("");
  // The row left the queue over SSE, and the mark moved to whatever is now on top.
  await expect.poll(() => queueTitles(dashboard)).toEqual(["And leave me queued"]);
  await expect(nextUpTrigger(dashboard)).toHaveAccessibleName(/And leave me queued/);
});

test("the drawer's autopilot switch is the Foreman panel's own, not a copy of it", async ({
  dashboard,
  daemon,
}) => {
  await seedTask(daemon, "Something for autopilot to take");

  await stage(dashboard, "Backlog").click();
  const backlog = drawer(dashboard, "Backlog");
  const auto = backlog.getByRole("switch", { name: "Backlog autopilot" });
  const readout = backlog.locator(".line-drawer-foot .line-drawer-foot-note");

  // Off is the shipped default, and the footer states it rather than staying silent.
  await expect(auto).toHaveAttribute("aria-checked", "false");
  await expect(readout).toHaveText("Autopilot off - nothing starts unless you start it");
  await expect(backlog.getByRole("button", { name: /^Sitrep/ })).toBeVisible();

  await auto.click();

  // The DAEMON holds it - this is the round trip, not an optimistic flip. `useForeman`
  // re-reads the config after the write, so the readout below comes back from the server.
  await expect
    .poll(async () => (await api<{ autoBacklog: boolean }>(daemon, "/api/foreman/config")).autoBacklog)
    .toBe(true);
  await expect(auto).toHaveAttribute("aria-checked", "true");
  // Foreman is on but not live on a fresh daemon, so the honest readout is the gate, not a
  // promise that something is about to launch. The `active/max` half comes from the status
  // poll rather than from the config write, so this waits longer than the default: one
  // missed 4s tick is a slow daemon, not a broken readout.
  await expect(readout).toHaveText(
    /^Autopilot on · \d+\/\d+ agents · nothing launches until Foreman is live$/,
    { timeout: 15_000 },
  );
  await shoot(dashboard, "backlog-autopilot-on");

  // The same switch, seen from the other surface that writes it. A drawer holding a
  // parallel flag would pass every assertion above and fail this one.
  await dashboard.getByRole("button", { name: /Foreman - the auto-responder/ }).click();
  const foreman = dashboard.getByRole("dialog", { name: "Foreman settings" });
  await expect(foreman.getByLabel("Auto-schedule the backlog")).toBeChecked();

  // And back, from the popover this time: the drawer's own readout has to follow.
  await foreman.getByLabel("Auto-schedule the backlog").click();
  await expect(auto).toHaveAttribute("aria-checked", "false");
  await expect(readout).toHaveText("Autopilot off - nothing starts unless you start it");
  expect((await api<{ autoBacklog: boolean }>(daemon, "/api/foreman/config")).autoBacklog).toBe(false);
});

test("every legacy #/workflows deep link redirects, and the Workflows page is gone", async ({
  dashboard,
  daemon,
}) => {
  // Bookmarks and desktop notifications carry these spellings. Landing is not enough - the
  // address bar has to be rewritten, or the next copy of the link keeps the old route alive.
  const redirects: [legacy: string, canonical: RegExp][] = [
    ["#/workflows/runs", /#\/runs$/],
    ["#/workflows/runs/run-that-does-not-exist", /#\/runs\/run-that-does-not-exist$/],
    ["#/workflows/runs?status=completed", /#\/runs\?status=completed$/],
    ["#/workflows/ensembles", /#\/ensembles$/],
    ["#/workflows/ensembles/ens-1", /#\/ensembles\/ens-1$/],
    // Anything else the prefix was ever spelled with. These never shipped as routes, which
    // is the point: a hash carrying the retired prefix is a link to that page however it is
    // misspelled, and it has to land somewhere better than the fleet.
    ["#/workflows/session-actions", /#\/library$/],
    ["#/workflows/runs/one/two", /#\/library$/],
    // The authoring spellings, still redirecting one phase later.
    ["#/workflows", /#\/library$/],
    // Not anchored: the Persona surface reports the asset it opens on, so the canonical
    // hash grows an id under it. What is being checked is that the SHELF is right.
    ["#/workflows/personas", /#\/library\/personas/],
    ["#/workflows/actions", /#\/library\/actions/],
  ];
  for (const [legacy, canonical] of redirects) {
    await dashboard.goto(`${daemon.baseURL}/${legacy}`);
    await expect(dashboard).toHaveURL(canonical);
    // Never the fleet. That is a real destination for an unknown hash, so a redirect landing
    // there is indistinguishable from no redirect at all.
    await expect(dashboard).not.toHaveURL(/#\/fleet$/);
  }

  // And the page they used to share is gone: no tab strip, and the two surfaces are pages
  // with their own headings rather than panels behind a tablist.
  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  await expect(dashboard.getByRole("heading", { level: 2, name: "Workflow runs" })).toBeVisible();
  await expect(dashboard.getByRole("tablist", { name: "Workflow sections" })).toHaveCount(0);

  await dashboard.goto(`${daemon.baseURL}/#/ensembles`);
  await expect(dashboard.getByRole("heading", { level: 2, name: "Ensembles" })).toBeVisible();
  await expect(dashboard.getByRole("tablist", { name: "Workflow sections" })).toHaveCount(0);

  // The Library's cross-links point at the new routes, not through a redirect.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.getByRole("button", { name: /ensembles →|need you →|run →/ }).first().click();
  await expect(dashboard).toHaveURL(/#\/ensembles$/);
});
