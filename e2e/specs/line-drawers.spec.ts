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
 * A bounding box read only once it has stopped moving.
 *
 * A freshly dispatched session is still settling for a second or so - the titler renames it,
 * the driver reports its model, the branch line arrives - and every one of those changes the
 * card's height. Comparing a box taken mid-settle against one taken after it is a test that
 * fails about one run in five and blames the drawer for the titler. Two consecutive identical
 * reads is the cheapest honest definition of "settled".
 */
async function settledBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = JSON.stringify(await locator.boundingBox());
  await expect.poll(async () => {
    const next = JSON.stringify(await locator.boundingBox());
    const same = next === last;
    last = next;
    return same;
  }, { timeout: 15_000 }).toBe(true);
  return JSON.parse(last) as { x: number; y: number; width: number; height: number };
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

test("the Review drawer reads a live run and escalates to it at #/runs/:id", async ({
  dashboard,
  daemon,
}) => {
  // A real run, held in `waiting_for_session` by a Persona with a known opinion - the same
  // deterministic seeding `workflow-run-disable.spec.ts` uses, and the reason the fake
  // answers `E2E_FAIL_VERDICT` at all.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the Review drawer");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }).toBe("idle");

  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Strict reviewer",
    guidanceMarkdown: "# Strict reviewer\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Drawer review",
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
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-line-drawer" },
  );
  const runId = submitted.run.id;
  await expect.poll(async () =>
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
  { timeout: 30_000 }).toBe("waiting_for_session");

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
