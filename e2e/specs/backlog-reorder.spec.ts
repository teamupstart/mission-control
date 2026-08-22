import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * The backlog has ONE order and it is the operator's, proven the only way it can be: a
 * click in a browser, a route, a server event, and back to two different surfaces plus the
 * scheduler that acts on it.
 *
 * The three older layers each assert something real and none of them can see this. The
 * markup tests know the buttons exist; the HTTP tests know the route places a rank; the
 * machine tests know `decideBacklogTick` takes the head. Only here does pressing `top` on
 * a card end with Foreman launching a different task.
 *
 * Driven with the KEYBOARD on purpose. Dragging arrives in phase 2, and the keyboard route
 * is the one that ships first for the reason it exists: a reorder that is only a mouse
 * gesture is one some people cannot perform and no spec can drive.
 *
 * NO MODEL TOKENS. Every agent binary is redirected at a fake by `fixtures/fake-agents.ts`,
 * which covers both paths a launch takes - the one-shot `claude -p` titler and the SDK
 * session - so the autopilot case at the bottom launches a fake and costs nothing.
 */

const EVIDENCE = artifactsDir("backlog-reorder");

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // The Tooltip opens on hover AND on focus - correctly, since a keyboard user needs the
  // same explanation. Both have to be let go of, or the bubble lands in the shot over the
  // card below it.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  console.log(`CAPTURED e2e/.artifacts/backlog-reorder/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 of HTML is the SPA fallback answering a path no route claimed - a mistyped
    // path, or the wrong method. Naming it beats `Unexpected token '<'` three frames away.
    throw new Error(`${path} answered HTML, not JSON - is that route and method real?`);
  }
}

/** One backlog task, titled by this spec rather than by the daemon's titler. */
async function seedTask(daemon: DaemonHandle, title: string): Promise<{ id: string; title: string }> {
  const task = await api<{ id: string }>(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    intent: `Whatever "${title}" is for.`,
    title,
    backlog: true,
    // Explicit null opts out of the machine's default post-work Workflow. Left omitted, the
    // configured default arms Live delivery, which this repo is not allowlisted for - so the
    // dispatch is REFUSED and the autopilot case would be measuring the allowlist.
    workflowId: null,
  });
  return { id: task.id, title };
}

/** Switch the dashboard to the Board layout, which is where the Backlog column lives. */
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

const column = (page: Page): Locator => page.locator("section.board-backlog");
const cardTitles = (page: Page): Promise<string[]> => column(page).locator(".bl-title").allInnerTexts();
const card = (page: Page, title: string): Locator => page.locator(".bl-card", { hasText: title });
const move = (page: Page, title: string, which: string): Locator =>
  card(page, title).getByRole("button", { name: `Move "${title}" ${which}` });

const stage = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "The Line" })
    .getByRole("button", { name: new RegExp(`^${name},`) });
const drawer = (page: Page, name: string): Locator => page.getByRole("region", { name: `${name} drawer` });
const queueTitles = (page: Page): Promise<string[]> =>
  drawer(page, "Backlog").locator(".line-bl-title").allInnerTexts();

/** Every backlog task's title in the daemon's own rank order - the scheduler's list. */
async function storedOrder(daemon: DaemonHandle): Promise<string[]> {
  const tasks = await api<Array<{ title: string; status: string; backlogRank: number | null }>>(
    daemon,
    "/api/tasks",
  );
  return tasks
    .filter((t) => t.status === "backlog")
    .sort((a, b) => (a.backlogRank ?? Infinity) - (b.backlogRank ?? Infinity))
    .map((t) => t.title);
}

test("moving a card with the keyboard changes the order everywhere, and the mark follows", async ({
  dashboard,
  daemon,
}) => {
  await seedTask(daemon, "Filed first");
  await seedTask(daemon, "Filed second");
  await seedTask(daemon, "Filed third");
  await useBoardLayout(dashboard, daemon);

  // Arrival order is the starting order: work that files itself lands at the bottom.
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed first",
    "Filed second",
    "Filed third",
  ]);
  await expect(card(dashboard, "Filed first").getByText("next up")).toBeVisible();
  await shoot(dashboard, "column-as-filed", column(dashboard));

  // ---- the keyboard route, end to end ----

  // The control is genuinely focusable and genuinely a button - `press` focuses it and
  // sends a real key, which is what a person without a mouse does. Nothing here is a
  // synthesized click on a div.
  const toTop = move(dashboard, "Filed third", "to top");
  await toTop.focus();
  await expect(toTop).toBeFocused();
  await toTop.press("Enter");

  // The card moves because the DAEMON moved it. Nothing is drawn optimistically, so this
  // order arriving at all is the round trip: click, route, `task_upsert`, re-render. And it
  // is the WHOLE order, not just the moved card: "to top" moves one card, so the two it
  // passed have to still be in the order they were filed in.
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed third",
    "Filed first",
    "Filed second",
  ]);

  // The painted tooltip belongs to the control that now HAS focus, not to the one that
  // disabled itself by succeeding. Pressing `to top` is exactly what makes `to top`
  // inapplicable, and a disabled element loses focus without the browser firing blur - so
  // its bubble used to be stranded, painted over the card below for as long as the operator
  // left it there. One tooltip, and it is the live one.
  const painted = dashboard.locator("span.tooltip");
  await expect(painted).toHaveCount(1);
  await expect(painted).toHaveText('Move "Filed third" to the bottom of the backlog');

  // The `next up` mark moved with it, and there is exactly one: two marks would be two
  // answers to a question that has one.
  await expect(column(dashboard).getByText("next up", { exact: true })).toHaveCount(1);
  await expect(card(dashboard, "Filed third").getByText("next up")).toBeVisible();
  await shoot(dashboard, "column-reordered", column(dashboard));
  // The same moment, uncropped. The column shot above is the tight one a diff reader wants;
  // this is the one a REVIEWER wants - the reordered cards in the board they actually sit
  // in, with the move controls legible on each.
  await shoot(dashboard, "board-after-keyboard-move");

  // ---- the same list, read somewhere else ----

  // The Line's Backlog drawer is a different component reading the same predicate. If the
  // board had re-sorted locally rather than the daemon having moved the row, this disagrees.
  await stage(dashboard, "Backlog").click();
  await expect(drawer(dashboard, "Backlog")).toBeVisible();
  await expect.poll(() => queueTitles(dashboard)).toEqual([
    "Filed third",
    "Filed first",
    "Filed second",
  ]);
  await shoot(dashboard, "drawer-reordered", drawer(dashboard, "Backlog"));
  await dashboard.keyboard.press("Escape");

  // And the daemon's own list - the one Foreman reads over loopback - agrees with both.
  expect(await storedOrder(daemon)).toEqual(["Filed third", "Filed first", "Filed second"]);

  // ---- the other three controls, and the ends of the column ----

  await move(dashboard, "Filed third", "down").press("Enter");
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed first",
    "Filed third",
    "Filed second",
  ]);

  await move(dashboard, "Filed first", "to bottom").press("Enter");
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed third",
    "Filed second",
    "Filed first",
  ]);

  await move(dashboard, "Filed second", "up").press("Enter");
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed second",
    "Filed third",
    "Filed first",
  ]);

  // Focus never leaves the group. `up` disabled itself by succeeding - the card it moved
  // is now at the top - and a disabled button cannot hold focus, so without the handoff
  // the browser drops focus to `<body>` and a keyboard user is thrown to the top of the
  // document on every single press. The whole point of shipping this gesture as buttons is
  // that it can be driven without a mouse, and one you have to re-Tab to after each use is
  // not that.
  //
  // `down` and not `to bottom`: the counterpart of a one-place move is the other one-place
  // move, which keeps the operator's hand on the granularity they were working at.
  await expect(move(dashboard, "Filed second", "down")).toBeFocused();

  // And when the pressed control is STILL live, focus simply stays on it - so a card can be
  // walked down the column by pressing the same key over and over.
  await move(dashboard, "Filed second", "down").press("Enter");
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed third",
    "Filed second",
    "Filed first",
  ]);
  await expect(move(dashboard, "Filed second", "down")).toBeFocused();
  await dashboard.keyboard.press("Enter");
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed third",
    "Filed first",
    "Filed second",
  ]);
  await expect(move(dashboard, "Filed second", "up")).toBeFocused();

  // Back to the order the assertions below read.
  await move(dashboard, "Filed second", "to top").press("Enter");
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed second",
    "Filed third",
    "Filed first",
  ]);

  // At each end, the move that has nowhere to go is disabled rather than live-and-inert.
  // That is also how the column says "this IS the top" without drawing a mark to say so.
  await expect(move(dashboard, "Filed second", "up")).toBeDisabled();
  await expect(move(dashboard, "Filed second", "to top")).toBeDisabled();
  await expect(move(dashboard, "Filed first", "down")).toBeDisabled();
  await expect(move(dashboard, "Filed first", "to bottom")).toBeDisabled();
  await expect(move(dashboard, "Filed third", "up")).toBeEnabled();
});

test("a refused move says why, changes nothing, and hands the control back", async ({
  dashboard,
  daemon,
}) => {
  // The route is status-guarded, so a card that dispatched between the render and the click
  // answers 409. Reaching that genuinely would mean racing a launch against the click;
  // what is under test here is what the CARD does with an answer it did not like, so the
  // daemon's own wording is fulfilled in its place - the same trade backlog-task-delete
  // makes for its refused delete.
  await seedTask(daemon, "Refused mover");
  await seedTask(daemon, "Innocent bystander");
  await useBoardLayout(dashboard, daemon);
  await expect.poll(() => cardTitles(dashboard)).toEqual(["Refused mover", "Innocent bystander"]);

  await dashboard.route("**/api/tasks/*/reorder", async (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "that task is already running" }),
    }),
  );

  const down = move(dashboard, "Refused mover", "down");
  await down.focus();
  await down.press("Enter");

  // Surfaced, not swallowed. A control that silently sprang back would read as broken
  // rather than as late, and the operator would have no idea the order they see is stale.
  await expect(dashboard.getByRole("status").filter({ hasText: "that task is already running" }))
    .toBeVisible();
  // The column is exactly as it was: nothing was drawn optimistically to roll back.
  expect(await cardTitles(dashboard)).toEqual(["Refused mover", "Innocent bystander"]);
  expect(await storedOrder(daemon)).toEqual(["Refused mover", "Innocent bystander"]);
  // And the control is live again and still holds focus. A refusal that also cost the
  // keyboard user their place would punish them twice for one 409.
  await expect(down).toBeEnabled();
  await expect(down).toBeFocused();
  await shoot(dashboard, "refused-move");
});

test("priority colours the card and moves nothing", async ({ dashboard, daemon }) => {
  // The decision this feature turned on, proven where a person would see it. Setting the
  // most urgent priority there is on the LAST card leaves it last - an order a chip could
  // rearrange is not an order the operator set.
  await seedTask(daemon, "Stays on top");
  await seedTask(daemon, "Stays at the bottom");
  await useBoardLayout(dashboard, daemon);
  await expect.poll(() => cardTitles(dashboard)).toEqual(["Stays on top", "Stays at the bottom"]);

  await card(dashboard, "Stays at the bottom")
    .getByLabel("Priority for Stays at the bottom")
    .selectOption("blocker");

  // The chip lands - read back off the control, so this is the daemon's answer and not the
  // select's own value.
  await expect(card(dashboard, "Stays at the bottom").getByLabel("Priority for Stays at the bottom"))
    .toHaveValue("blocker");
  await expect(card(dashboard, "Stays at the bottom").locator(".bl-prio")).toHaveClass(/prio-blocker/);
  // Read ONCE rather than through a retrying assertion: the claim is that the order never
  // became wrong, and a poll would happily wait out a transient re-sort.
  expect(await cardTitles(dashboard)).toEqual(["Stays on top", "Stays at the bottom"]);
  await expect(card(dashboard, "Stays on top").getByText("next up")).toBeVisible();
  await shoot(dashboard, "priority-is-annotation", column(dashboard));
});

test("autopilot launches the card the operator moved up, not the one filed first", async ({
  dashboard,
  daemon,
}) => {
  // The requirement, end to end: reordering changes what Foreman SCHEDULES. Everything
  // above proves the order is drawn and stored; this proves it is acted on.
  await seedTask(daemon, "Would have gone first");
  await seedTask(daemon, "Moved up by hand");
  await useBoardLayout(dashboard, daemon);
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Would have gone first",
    "Moved up by hand",
  ]);

  await move(dashboard, "Moved up by hand", "to top").press("Enter");
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Moved up by hand",
    "Would have gone first",
  ]);

  // Arm the autopilot for this repo only, then start the worker. `maxSessions: 1` is what
  // makes the assertion sharp: exactly one task can be in flight, so the one that launches
  // is the one Foreman chose FIRST and not merely the one that happened to finish first.
  const response = await fetch(`${daemon.baseURL}/api/foreman/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      mode: "live",
      autoBacklog: true,
      maxSessions: 1,
      repoAllowlist: [daemon.repo],
    }),
  });
  expect(response.ok, "the daemon accepted the autopilot config").toBe(true);
  await daemon.startForeman();

  try {
    // The daemon's own word for "it took this one", rather than a DOM poll: the task that
    // left the backlog is the task the scheduler picked.
    await expect
      .poll(
        async () => {
          const tasks = await api<Array<{ title: string; status: string }>>(daemon, "/api/tasks");
          return tasks.filter((t) => t.status !== "backlog").map((t) => t.title).sort();
        },
        { timeout: 90_000 },
      )
      .toEqual(["Moved up by hand"]);
  } catch (error) {
    // The daemon's home - and its log with it - is deleted on stop, so it has to be read
    // here or not at all.
    throw new Error(`${(error as Error).message}\n\n--- daemon log ---\n${daemon.readLog()}`);
  }

  // And the one that would have gone first is still queued, still exactly where it was put.
  expect(await storedOrder(daemon)).toEqual(["Would have gone first"]);
  await shoot(dashboard, "autopilot-took-the-moved-card");
});
