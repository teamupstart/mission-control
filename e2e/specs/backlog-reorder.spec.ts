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
 * Driven BOTH ways, because the feature is both. The keyboard route shipped first for the
 * reason it exists - a reorder that is only a mouse gesture is one some people cannot
 * perform - and the drag is the one the feature was asked for. The cases at the bottom
 * cover the drag, including the one that matters most: the SAME drag still hands a card to
 * an idle agent when it is dropped on one, because which drop target it lands on is the
 * only thing that decides which of the two things happens.
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

/**
 * One HTML5 drag, dispatched as the browser dispatches one.
 *
 * A real `DataTransfer`, created in the page, carried from `dragstart` through `dragover`
 * to `drop` - so the handlers under test are exactly the handlers a person's drag runs,
 * reading the payload the card actually wrote. Playwright's `dragTo` and a synthetic
 * `mouse.down`/`move`/`up` both drive Chromium's own drag machinery, which does not
 * reliably raise native HTML5 drag events through CDP; the repo already drags this way in
 * `board-held-by-workflow.spec.ts` for that reason.
 */
async function lift(page: Page, source: Locator): Promise<{
  over: (target: Locator) => Promise<void>;
  drop: (target: Locator) => Promise<void>;
  end: () => Promise<void>;
}> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  return {
    over: (target) => target.dispatchEvent("dragover", { dataTransfer }),
    drop: async (target) => {
      await target.dispatchEvent("dragover", { dataTransfer });
      await target.dispatchEvent("drop", { dataTransfer });
    },
    end: () => source.dispatchEvent("dragend", { dataTransfer }),
  };
}

/** The N+1 places a card can be dropped, in column order: above the first, then downward. */
const gaps = (page: Page): Locator => column(page).locator(".bl-gap");

test("dragging a card up the column moves it, and the move is on the row", async ({
  dashboard,
  daemon,
}) => {
  await seedTask(daemon, "Filed first");
  await seedTask(daemon, "Filed second");
  await seedTask(daemon, "Filed third");
  await useBoardLayout(dashboard, daemon);
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed first",
    "Filed second",
    "Filed third",
  ]);

  // Three cards, four places to put one: the column offers the drag every position the
  // move buttons can reach, including above the first card.
  await expect(gaps(dashboard)).toHaveCount(4);

  const drag = await lift(dashboard, card(dashboard, "Filed third"));

  // The column knows what is in the air. This is not decoration: the gaps are inert -
  // `pointer-events: none` - until it does, so that a card click and a file dropped on the
  // dashboard cannot be swallowed by a target that is invisible the rest of the time.
  await expect(column(dashboard)).toHaveClass(/is-reordering/);
  await expect(gaps(dashboard).first()).toHaveCSS("pointer-events", "auto");
  // And the card being moved is dimmed, so the gesture reads as a move rather than a copy.
  await expect(card(dashboard, "Filed third")).toHaveClass(/is-lifted/);

  // Over the topmost gap, the column draws ONE line, where the card would land.
  await drag.over(gaps(dashboard).first());
  await expect(gaps(dashboard).first()).toHaveClass(/is-over/);
  await expect(column(dashboard).locator(".bl-gap.is-over")).toHaveCount(1);
  await shoot(dashboard, "drag-over-the-top-gap", column(dashboard));

  await drag.drop(gaps(dashboard).first());
  await drag.end();

  // It stays where it was dropped - because the DAEMON moved it. Nothing is drawn
  // optimistically, so this order arriving at all is the whole round trip.
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed third",
    "Filed first",
    "Filed second",
  ]);
  await expect(column(dashboard).locator(".bl-gap.is-over")).toHaveCount(0);
  await expect(card(dashboard, "Filed third").getByText("next up")).toBeVisible();
  await shoot(dashboard, "drag-reordered", column(dashboard));
  await shoot(dashboard, "board-after-drag-reorder");

  // The order is a fact on the row, not a state of this DOM: it survives a reload, and the
  // daemon's own list - the one Foreman reads over loopback - already agreed before it.
  expect(await storedOrder(daemon)).toEqual(["Filed third", "Filed first", "Filed second"]);
  await dashboard.reload();
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed third",
    "Filed first",
    "Filed second",
  ]);

  // A drag DOWN the column, through the gap between two cards rather than an end - the
  // `before`-an-anchor case, which is the one an index would have got wrong.
  const back = await lift(dashboard, card(dashboard, "Filed third"));
  await back.drop(gaps(dashboard).nth(2));
  await back.end();
  await expect.poll(() => cardTitles(dashboard)).toEqual([
    "Filed first",
    "Filed third",
    "Filed second",
  ]);
});

test("dropping a card where it already is sends nothing", async ({ dashboard, daemon }) => {
  await seedTask(daemon, "Stays exactly here");
  await seedTask(daemon, "Its neighbour");
  await useBoardLayout(dashboard, daemon);
  await expect.poll(() => cardTitles(dashboard)).toEqual(["Stays exactly here", "Its neighbour"]);

  const reorders: string[] = [];
  dashboard.on("request", (r) => {
    if (r.url().includes("/reorder")) reorders.push(r.url());
  });

  // Both gaps either side of the first card are where it already is. A request here would
  // burn a rank allocation and push a `task_upsert` to every connected dashboard to
  // redraw exactly what they are already drawing.
  const drag = await lift(dashboard, card(dashboard, "Stays exactly here"));
  await drag.over(gaps(dashboard).first());
  // No line is drawn either: there is nowhere for it to go, so nothing promises a move.
  await expect(column(dashboard).locator(".bl-gap.is-over")).toHaveCount(0);
  await drag.drop(gaps(dashboard).first());
  await drag.drop(gaps(dashboard).nth(1));
  await drag.end();

  expect(reorders, "a no-op drop asks the daemon for nothing").toEqual([]);
  expect(await cardTitles(dashboard)).toEqual(["Stays exactly here", "Its neighbour"]);
  expect(await storedOrder(daemon)).toEqual(["Stays exactly here", "Its neighbour"]);
});

/**
 * Dispatch one agent and wait for it to settle, so there is an idle tile to drop onto.
 *
 * `__none` on the workflow selector matters: the configured default arms Live delivery,
 * which this repo is not allowlisted for, and the dispatch would be refused. The agent is
 * a fake (`fixtures/fake-agents.ts`), so this costs no model tokens.
 */
async function dispatchIdleAgent(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("wait for a handover");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let sessionId = "";
  await expect
    .poll(
      async () => {
        const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
        const live = sessions.find((s) => s.state !== "exited");
        sessionId = live?.id ?? "";
        return live?.state ?? "";
      },
      { timeout: 60_000 },
    )
    .toBe("idle");
  return sessionId;
}

test("the same drag still hands a card to an idle agent", async ({ dashboard, daemon }) => {
  // THE regression that matters. One drag now has two possible endings, and nothing else in
  // the suite would notice the assign one breaking: every layer below this sees a card that
  // is `draggable` and a tile that has an `onDrop`, and none of them can see that a drop
  // target added to the column ate the drop meant for the agent - or that the tile's drop
  // quietly started reordering instead of handing the task over.
  const task = await seedTask(daemon, "Hand me over");
  await useBoardLayout(dashboard, daemon);
  await expect.poll(() => cardTitles(dashboard)).toEqual(["Hand me over"]);
  const dispatched = await dispatchIdleAgent(dashboard, daemon);

  // Every request the drop makes, so the ENDING can be named rather than inferred from a
  // side effect two layers away.
  const posted: string[] = [];
  dashboard.on("request", (r) => {
    if (r.method() !== "POST") return;
    if (/\/api\/tasks\/[^/]+\/(assign|reorder)$/.test(new URL(r.url()).pathname)) {
      posted.push(`${new URL(r.url()).pathname} ${r.postData() ?? ""}`);
    }
  });

  const tile = dashboard.locator("section.board-col.tone-idle .tile").first();
  await expect(tile).toBeVisible();

  const drag = await lift(dashboard, card(dashboard, "Hand me over"));
  // The tile lights up because the board knows a card is in the air and which repo it is
  // for - the same `dragstart`, and the same one notion of what is in the air, that the
  // column now also reads to light its own gaps.
  await expect(tile).toHaveClass(/can-drop/);
  await expect(tile.locator(".tile-drop-hint")).toHaveText("↳ drop to hand this over");
  await shoot(dashboard, "drag-over-the-idle-agent");
  await drag.drop(tile);
  await drag.end();

  // The drop went to the AGENT. One POST, naming this task and this session, on the assign
  // route - and no reorder, so the column's new drop targets did not take a drag that was
  // aimed past them.
  await expect.poll(() => posted).toEqual([
    `/api/tasks/${task.id}/assign {"sessionId":"${dispatched}","overrideDisabled":true,"confirmReset":false}`,
  ]);

  // And the daemon answered, in the browser, about THIS agent - the answer names the task
  // it is already carrying, which nothing but the assign path could have produced.
  //
  // Why the answer is a refusal, stated rather than left to look like a broken feature: the
  // only agent an e2e run can stand up is one Mission Control dispatched, and a dispatched
  // agent is carrying its own task in its own checkout. `TaskManager.assign` refuses to
  // give it a second one - a CAPACITY rule older than this phase and untouched by it, which
  // `test/task-assign.test.ts` pins on its own, and which cannot be cleared here because
  // freeing that agent's checkout ("Clean up") also stops the agent. What a browser has to
  // prove is the half a browser owns: the drop landed on the tile, ran the assign, and did
  // not reorder. It did.
  await expect(
    dashboard.getByRole("status").filter({ hasText: "it takes one task at a time" }),
  ).toBeVisible();
  await shoot(dashboard, "drag-assigned-to-the-agent");

  // The card is exactly where it was. A drop that fell through to a reorder would have
  // moved it, and a drop that did nothing at all would look the same from here - which is
  // why the request above is asserted rather than only the absence of movement.
  expect(await cardTitles(dashboard)).toEqual(["Hand me over"]);
  expect(await storedOrder(daemon)).toEqual(["Hand me over"]);
});
