import { mkdirSync } from "node:fs";
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

/** The daemon's own word for "the launch turn is over", which no DOM poll can substitute for. */
async function waitForIdleSession(daemon: DaemonHandle): Promise<string> {
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
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

  // ---- and the third drawer is reachable the same way ----
  await stage(dashboard, "Intake").click();
  await expect(drawer(dashboard, "Intake")).toBeVisible();
  await expect(anyDrawer(dashboard)).toHaveCount(1);
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
): Promise<SeededRun> {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(intent);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  const sessionId = await waitForIdleSession(daemon);

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
  const binding = await api<{ id: string; sessionName: string; noteKey: string }>(
    daemon,
    "/api/workflow-bindings",
    { workflowVersionId: published.version.id, sessionId, deliveryMode: "preview" },
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

  // The state under test cannot be seeded by writing SQLite: run summaries are served from an
  // in-memory map on the Registry rather than re-read per request, so a direct UPDATE never
  // reaches the browser. The daemon has to do it - kill the session and let `session_remove`
  // reach `orphanBinding`, which is the exact path all 31 blocked runs on the real fleet took.
  await api(daemon, `/api/sessions/${seeded.sessionId}/kill`, {});
  // `EXIT_LINGER_MS` is a hardcoded 8s between the session exiting and `session_remove`
  // firing, and it is not env-tunable - so this poll gets its own explicit budget rather than
  // the 20s `expect` default.
  await expect.poll(async () => {
    const detail = await api<{ run: { status: string; currentPhase: string } }>(
      daemon,
      `/api/workflow-runs/${seeded.runId}`,
    );
    return `${detail.run.status}:${detail.run.currentPhase}`;
  }, { timeout: 60_000 }).toBe("blocked:session_disappeared");

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
