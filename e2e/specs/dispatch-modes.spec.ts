import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * One dispatch form, four jobs, and no way to be in two of them at once.
 *
 * The form used to learn which job it was doing by reading a handful of independent optional
 * props - an edit target, a guided pass, a launch mode, an Ensemble draft, a tour preview -
 * and resolving a precedence between whatever arrived. The reachable consequence was a
 * control offered where it could not work: the tour's form carried a Guided switch that
 * persisted the preference and could never start a pass, because the pass state behind it was
 * never wired. The mode is a discriminated union now, so each job carries its own inputs and
 * nothing else.
 *
 * Driven through the browser because the claim is about which controls a person can reach in
 * each mode and what pressing them does. `test/dispatch-mode.test.ts` covers the rule itself
 * in milliseconds - including the contradictions, which are unreachable from here precisely
 * because the type now refuses them, except through the last test here, which hands one to the
 * real component directly - and a markup test can assert one snapshot of one mode
 * but not that MOVING between them takes the right controls with it, which is where the two
 * halves of a fresh dispatch actually live.
 *
 * Each mode is also SUBMITTED here, because "exposes only its fields" is half the contract and
 * "sends only its payload" is the other: a Single dispatch posts one task and never touches the
 * Ensemble routes, an Ensemble goes out through Review then Launch and never files a task, and
 * an edit updates the row it opened.
 *
 * The Library's strategy launcher - the fourth way in, an opening that arrives already in
 * Ensemble mode - is covered by `library.spec.ts`, and the tour's fixed form by
 * `see-work-tour.spec.ts`. The agents the Single and Ensemble launches start are the fixture
 * fakes every spec runs against (`e2e/fixtures/fake-agents.ts`), so nothing here spends model
 * tokens.
 */

/** The topbar door: never `{ exact: true }`, the keycap renders inside the button's label. */
async function openDispatch(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Every POST a dispatch form can send, in order, with its body.
 *
 * Recorded for the whole test rather than awaited one at a time, because the claim is as much
 * about the requests that did NOT happen - the other mode's route - as about the one that did.
 */
function recordSubmissions(page: Page): Array<{ path: string; body: Record<string, unknown> }> {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (!/^\/api\/(tasks|ensembles)(\/|$)/.test(path)) return;
    seen.push({ path, body: (request.postDataJSON() ?? {}) as Record<string, unknown> });
  });
  return seen;
}

/**
 * Fill the brief both halves of a fresh dispatch share.
 *
 * `Escape` after the repo is load-bearing: `RepoCombobox` portals its list over the Task field
 * and opens on every keystroke, and its own Escape handler stops propagation, so this closes the
 * list and not the modal.
 */
async function fillBrief(page: Page, dialog: Locator, repo: string, task: string): Promise<void> {
  await dialog.getByPlaceholder("search repos or type a path…").fill(repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
}

/** Shelve a task so the Board has a card to open the editor from. Returns the stored row. */
async function seedBacklogTask(
  daemon: DaemonHandle,
  title: string,
  intent: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${daemon.baseURL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoRoot: daemon.repo, title, intent, backlog: true }),
  });
  expect(response.ok, `seeding "${title}" answered ${response.status}`).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

/** The Board, the one layout that draws the backlog as a column of cards. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

test("a fresh dispatch is Single, and the toggle carries the whole form between its two halves", async ({
  dashboard,
}) => {
  const dialog = await openDispatch(dashboard);
  await expectContentClearsBorder(dialog);

  // Single: the launch-mode choice, the guided offer, the backlog bookkeeping, and both verbs.
  await expect(dialog.getByRole("radio", { name: "Single agent" }))
    .toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("switch", { name: "Guided" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Backlog details" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add to backlog" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeVisible();
  // And none of Ensemble's controls, which is the half of this a single snapshot misses.
  await expect(dialog.getByRole("button", { name: "Review" })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "Best of N" })).toHaveCount(0);

  await dialog.getByRole("radio", { name: "Ensemble" }).click();

  // Ensemble replaces the body and the primary action outright, so the controls that belong to
  // a single task go with it - a Guided switch here would be offering to ask about fields that
  // are no longer on screen.
  await expect(dialog.getByRole("radio", { name: "Best of N" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Review" })).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "Guided" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Backlog details" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add to backlog" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toHaveCount(0);
  await shoot(dashboard, "ensemble-form");

  // Back, and the form is the Single form again rather than a hybrid of the two.
  await dialog.getByRole("radio", { name: "Single agent" }).click();
  await expect(dialog.getByRole("switch", { name: "Guided" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Dispatch now" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Review" })).toHaveCount(0);
});

test("a Single dispatch posts one task and never touches the Ensemble routes", async ({
  dashboard,
  daemon,
}) => {
  const submissions = recordSubmissions(dashboard);
  const dialog = await openDispatch(dashboard);
  const task = "Tighten the retry budget on the poller.";
  await fillBrief(dashboard, dialog, daemon.repo, task);
  // Pinned to None: left on "Dispatch default", the daemon's configured Workflow would refuse
  // a repo that is not allowlisted for Live delivery, and this test is about the payload.
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  const posted = dashboard.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks",
  );
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  expect((await posted).ok(), "the daemon accepted the dispatch").toBe(true);
  await expect(dialog).toBeHidden();

  // Exactly one request, to the task route, carrying the Single form and launching now.
  expect(submissions.map((s) => s.path)).toEqual(["/api/tasks"]);
  const body = submissions[0]!.body;
  expect(body).toMatchObject({
    repoRoot: daemon.repo,
    intent: task,
    kind: "ship",
    workflowId: null,
    backlog: false,
    enabled: true,
  });
  // And none of an Ensemble's: no strategy, no idempotency key, no member roster.
  for (const field of ["strategyId", "strategyConfig", "sourceKey", "workflow"]) {
    expect(body, `a Single dispatch carried ${field}`).not.toHaveProperty(field);
  }

  // The row the daemon now holds is the one the form described.
  const rows = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Array<{
    intent: string;
    kind: string;
  }>;
  expect(rows.filter((row) => row.intent === task).map((row) => row.kind)).toEqual(["ship"]);
});

test("an Ensemble goes out through Review then Launch, and never files a task", async ({
  dashboard,
  daemon,
}) => {
  const submissions = recordSubmissions(dashboard);
  const dialog = await openDispatch(dashboard);
  await dialog.getByRole("radio", { name: "Ensemble" }).click();
  const task = "Compare two ways to cap the poller's retries.";
  await fillBrief(dashboard, dialog, daemon.repo, task);

  // The Single form's launch chord does nothing here. Ensemble's primary is a deliberate
  // two-step, and a chord that filed this brief as one task would be the Single payload
  // leaving from the Ensemble form.
  await dialog.getByPlaceholder("What should this agent do?").focus();
  await dashboard.keyboard.press("Control+Enter");
  await expect(dialog).toBeVisible();
  const launch = dialog.getByRole("button", { name: /^Launch \d+ agents$/ });
  await expect(launch, "nothing is reviewed until Review is pressed").toHaveCount(0);

  const previewed = dashboard.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/ensembles/preview",
  );
  await dialog.getByRole("button", { name: "Review launch" }).click();
  expect((await previewed).ok(), "the daemon previewed the plan").toBe(true);
  await expect(dialog.getByText("Reviewed ✓")).toBeVisible();
  await expect(launch).toBeEnabled();

  const created = dashboard.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/ensembles",
  );
  await launch.click();
  const createdResponse = await created;
  expect(createdResponse.status(), "the daemon launched the ensemble").toBe(201);
  const runId = ((await createdResponse.json()) as { run: { id: string } }).run.id;
  // A launched Ensemble hands the operator to its run, and the form is gone.
  await expect(dialog).toBeHidden();
  await expect.poll(() => dashboard.evaluate(() => location.hash)).toBe(`#/ensembles/${runId}`);

  // Preview, then create - and nothing filed on the task route at any point, the chord included.
  expect(submissions.map((s) => s.path)).toEqual(["/api/ensembles/preview", "/api/ensembles"]);
  const body = submissions[1]!.body;
  expect(body).toMatchObject({
    repoRoot: daemon.repo,
    intent: task,
    strategyId: "best_of_n",
  });
  expect(body.sourceKey, "the launch carries its idempotency key").toEqual(expect.any(String));
  expect(body).toHaveProperty("strategyConfig");
  // None of a single task's fields: an Ensemble owns its own members and their backlog wave.
  for (const field of ["kind", "agent", "priority", "labels", "dependencies", "backlog", "enabled"]) {
    expect(body, `an Ensemble launch carried ${field}`).not.toHaveProperty(field);
  }
  const rows = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Array<{ intent: string }>;
  expect(rows.filter((row) => row.intent === task), "the brief was filed as a task").toEqual([]);
});

test("the backlog editor offers no way into another mode, and saves the row it opened", async ({
  dashboard,
  daemon,
}) => {
  const title = "Retire the legacy poller";
  await seedBacklogTask(daemon, title, "Rip out the poller and its dead config.");
  await useBoardLayout(dashboard, daemon);

  const card = dashboard.locator(".bl-card", { hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: title, exact: true }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Edit a backlog task" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);

  // An existing row cannot become an Ensemble and its answers already exist, so neither the
  // launch-mode toggle nor the guided offer is here to be pressed.
  await expect(dialog.getByRole("radio", { name: "Single agent" })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "Ensemble" })).toHaveCount(0);
  await expect(dialog.getByRole("switch", { name: "Guided" })).toHaveCount(0);
  // Edit's own verbs, which no other mode has: Delete, and Save rather than "Add to backlog".
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add to backlog" })).toHaveCount(0);
  await shoot(dashboard, "edit-form");

  // The documented payload for this mode is an update of what changed, and it reaches the row
  // the card opened - not a second task filed by the create route.
  const composer = dialog.getByPlaceholder("What should this agent do?");
  await expect(composer).toHaveValue("Rip out the poller and its dead config.");
  await composer.fill("Rip out the poller, its dead config, and the cron entry.");
  const saved = dashboard.waitForResponse((r) => /\/api\/tasks\/[^/]+\/update$/.test(r.url()));
  await dialog.getByRole("button", { name: "Save" }).click();
  expect((await saved).status(), "the daemon accepted the edit").toBe(200);
  await expect(dialog).toBeHidden();

  const tasks = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Array<{
    title?: string | null;
    intent?: string;
  }>;
  expect(tasks.filter((t) => t.title === title)).toHaveLength(1);
  expect(tasks.find((t) => t.title === title)?.intent).toContain("and the cron entry");
});

const EVIDENCE = artifactsDir("dispatch-modes");
const MOUNT_MODULE = fileURLToPath(new URL("../fixtures/dispatch-mount.tsx", import.meta.url));

/**
 * The openings the old prop list could spell and the union now cannot, one per pair of jobs
 * that used to collide, plus a kind that names no job at all. `task` and `demo` are filled in
 * inside the page, where a real stored row and a callable tour dispatcher exist.
 */
const CONTRADICTIONS: Array<{ label: string; opening: Record<string, unknown>; reason: RegExp }> = [
  {
    label: "an edit that is also the tour",
    opening: { kind: "edit", task: "$task", demo: "$demo" },
    reason: /the edit dispatch opening carrying demo, which belongs to tour/,
  },
  {
    label: "an edit that is also an Ensemble launch",
    opening: { kind: "edit", task: "$task", strategyId: "best_of_n" },
    reason: /the edit dispatch opening carrying strategyId, which belongs to ensemble/,
  },
  {
    label: "the tour over a backlog row",
    opening: { kind: "tour", demo: "$demo", task: "$task" },
    reason: /the tour dispatch opening carrying task, which belongs to edit/,
  },
  {
    label: "a kind that names no job",
    opening: { kind: "swarm" },
    reason: /an unsupported dispatch opening "swarm"/,
  },
];

test("a contradictory opening shows no form in the browser, and the same layer recovers", async ({
  dashboard,
  daemon,
}) => {
  // The development dashboard, because it is the only build that can load a module the app
  // does not: Vite serves `e2e/fixtures/dispatch-mount.tsx` through `/@fs/` and resolves its
  // imports to the same `src/` the running dashboard is made of. The production bundle has no
  // such door, and adding one to the product would be the test hook this avoids.
  const { startDevDashboard } = await import("../fixtures/dev-dashboard.ts");
  const task = await seedBacklogTask(daemon, "Hold the poller", "Keep this row exactly as it is.");
  const dev = await startDevDashboard(daemon);
  try {
    const refusals: string[] = [];
    dashboard.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Dispatch did not open")) {
        refusals.push(message.text());
      }
    });
    // Every route a dispatch form can submit through. A refused opening must reach none of
    // them: nothing rendered means nothing to press, and this is how a browser says so.
    const submissions: string[] = [];
    dashboard.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() !== "POST") return;
      if (/^\/api\/(dispatch|tasks(\/[^/]+\/(update|dispatch))?|ensembles)$/.test(url.pathname)) {
        submissions.push(`${request.method()} ${url.pathname}`);
      }
    });

    await dashboard.goto(`${dev.origin}/#/fleet`);
    await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
    await dashboard.evaluate(async ({ modulePath, row }) => {
      const mount = await import(/* @vite-ignore */ `/@fs${modulePath}`);
      const w = window as unknown as Record<string, unknown>;
      w.__dispatchMount = mount;
      w.__tourDispatches = 0;
      w.__demo = {
        id: "tour-run",
        briefReady: true,
        repoRoot: row.repoRoot,
        dispatch: async () => {
          w.__tourDispatches = (w.__tourDispatches as number) + 1;
          return { ok: true };
        },
      };
      // Swap the `$task` / `$demo` placeholders for the live objects this page holds.
      w.__resolve = (opening: Record<string, unknown>) => Object.fromEntries(
        Object.entries(opening).map(([k, v]) => [k, v === "$task" ? row : v === "$demo" ? w.__demo : v]),
      );
    }, { modulePath: MOUNT_MODULE, row: task });

    const dispatchDialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
    const editDialog = dashboard.getByRole("dialog", { name: "Edit a backlog task" });

    for (const { label, opening, reason } of CONTRADICTIONS) {
      const before = refusals.length;
      await dashboard.evaluate((opening) => {
        const w = window as unknown as Record<string, any>;
        w.__current = w.__dispatchMount.mountDispatchLayer(w.__resolve(opening));
      }, opening);
      // The refusal is logged from the render that declined to draw, so waiting on it is
      // waiting on that render - which is what makes the absence below a finding rather than
      // an assertion that ran before anything happened.
      await expect.poll(() => refusals.slice(before).join("\n"), { message: label }).toMatch(reason);
      await expect(dispatchDialog, `${label}: no new-dispatch form`).toHaveCount(0);
      await expect(editDialog, `${label}: no edit form`).toHaveCount(0);
      await dashboard.evaluate(() => (window as unknown as Record<string, any>).__current.unmount());
    }

    // Now one layer, three openings in a row, the way App re-renders it. A valid opening draws
    // its form; a contradictory one on the SAME layer takes the form away rather than leaving
    // the last good one standing; and a valid one after it draws again. So the refusal is about
    // the opening in hand, not a latch the layer falls into.
    await dashboard.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      w.__current = w.__dispatchMount.mountDispatchLayer({ kind: "new" });
    });
    await expect(dispatchDialog).toBeVisible();
    await expect(dispatchDialog.getByRole("radio", { name: "Single agent" }))
      .toHaveAttribute("aria-checked", "true");
    await shoot(dashboard, "valid-new-opening");

    const before = refusals.length;
    await dashboard.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      w.__current.reopen(w.__resolve({ kind: "edit", task: "$task", demo: "$demo" }));
    });
    await expect.poll(() => refusals.slice(before).join("\n"))
      .toMatch(/the edit dispatch opening carrying demo/);
    await expect(dispatchDialog).toHaveCount(0);
    await expect(editDialog).toHaveCount(0);
    await shoot(dashboard, "contradictory-opening-refused");

    await dashboard.evaluate(() => {
      const w = window as unknown as Record<string, any>;
      w.__current.reopen(w.__resolve({ kind: "edit", task: "$task" }));
    });
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByPlaceholder("What should this agent do?"))
      .toHaveValue("Keep this row exactly as it is.");
    await dashboard.evaluate(() => (window as unknown as Record<string, any>).__current.unmount());

    // Nothing was submitted anywhere while any of this was on screen, the tour's dispatcher
    // included, and the row the contradictory edits named is exactly as it was seeded.
    expect(submissions, "a refused opening reached a submit route").toEqual([]);
    expect(await dashboard.evaluate(() => (window as unknown as Record<string, number>).__tourDispatches))
      .toBe(0);
    const rows = (await (await fetch(`${daemon.baseURL}/api/tasks`)).json()) as Array<{
      id: string;
      intent: string;
    }>;
    expect(rows.find((row) => row.id === task.id)?.intent).toBe("Keep this row exactly as it is.");
  } finally {
    dev.stop();
  }
});

/**
 * A frame of what the assertion beside it just proved, behind `MC_E2E_EVIDENCE`.
 *
 * The Ensemble form and the editor are taller than the 720px default viewport and their BODY
 * is what scrolls, so a capture at that size crops the footer - which is where each mode's own
 * verbs live. Grown for the capture and put straight back, so the assertions around it keep
 * running at the size every other spec uses.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const restore = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 1100 });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  if (restore) await page.setViewportSize(restore);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/dispatch-modes/${name}.png`);
}
