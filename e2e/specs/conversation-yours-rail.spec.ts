import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Conversation rail's "Yours" tab, driven end to end.
 *
 * The tab is an INDEX, not a filter: nothing leaves the transcript, and clicking a row
 * moves the log to that turn with all of its context still around it. So the assertions
 * here are about navigation and attribution, never about anything disappearing - a spec
 * that passed by checking things were hidden would be testing the wrong feature.
 *
 * The one thing that has to be right is WHOSE messages are listed. Foreman delivering
 * work, the daemon injecting on the operator's behalf, and workflow repair all arrive as
 * `user` turns byte-identical to a person's, so a rail keyed on the role would list them
 * under a tab called "Yours" and tell the operator they asked for work they never asked
 * for. This drives a real Foreman delivery through the real `/inject` route to prove the
 * separation on a turn the daemon actually attributed, rather than on a fixture.
 *
 * No model tokens: `MISSION_CLAUDE_BIN` points at the fake throughout, and every turn
 * here is either typed into the composer or delivered by the daemon.
 */

const EVIDENCE = artifactsDir("conversation-yours-rail");

/** What the operator types, in order. Distinct enough to assert on individually. */
const FIRST = "Investigate the ensemble failure and schedule fixes";
const SECOND = "Do not run the build in that checkout";
const THIRD = "Re-file the task and go ahead with the build";

/**
 * What is delivered on the operator's behalf - the turns that must NOT read as theirs.
 *
 * Two different origins, because the rail must group on the FIELD rather than on a
 * special case for Foreman. `harness` (drawn as "mission control") is the third, and it
 * is pinned in `test/conversation-yours.test.ts` instead: reaching it in a browser means
 * the retro delivery path, which refuses unless its skill is enabled, and a spec that
 * depended on that would be asserting the skills config rather than this rail.
 */
const FOREMAN_SAYS = "Continue. You have approval to run the build.";
const WORKFLOW_SAYS = "Repair the failing stage and report back.";

interface FleetSession {
  id: string;
  agentSessionId: string | null;
  runtime: string;
}

async function shoot(page: Page, card: ReturnType<Page["locator"]>, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // lands on top of the rows being photographed.
  await page.mouse.move(0, 0);
  await card.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/conversation-yours-rail/${name}.png`);
}

/**
 * The dispatched session, once it has bound a conversation.
 *
 * Waiting for `agentSessionId` is what makes the injection below land on this session
 * rather than on nothing.
 */
async function session(daemon: DaemonHandle): Promise<FleetSession> {
  let found: FleetSession | null = null;
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as FleetSession[];
        found = all.find((s) => s.runtime === "sdk" && s.agentSessionId !== null) ?? null;
        return found !== null;
      },
      { message: "the dispatched session should bind a conversation", timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

/**
 * Deliver a turn the way Foreman does: the real route, with the real origin.
 *
 * `/inject` is where authorship is recorded (`recordInjection`), and it is the ONLY
 * moment it is knowable - by the time the text reaches the agent it is keystrokes
 * indistinguishable from a person's. Driving the route rather than writing a fixture is
 * what makes this spec evidence that the shipped attribution path works.
 */
async function delivers(
  daemon: DaemonHandle,
  target: FleetSession,
  origin: "foreman" | "workflow",
  text: string,
): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `buffer: false` so it is delivered rather than parked in the operator's outbox -
    // the outbox is the human's editable queue, and neither of these callers uses it.
    body: JSON.stringify({ text, origin, buffer: false }),
  });
  expect(res.ok, `POST /inject answered ${res.status}: ${await res.text()}`).toBe(true);
}

/**
 * Both machine deliveries, and the wait that makes the rail assertions deterministic.
 *
 * `exact` on the text match because the fake agent echoes every turn it receives as
 * "Mock reply to: <text>", so a substring match finds the delivery AND its echo.
 */
async function machinesDeliver(
  page: Page,
  daemon: DaemonHandle,
  card: ReturnType<Page["locator"]>,
): Promise<void> {
  const target = await session(daemon);
  await delivers(daemon, target, "foreman", FOREMAN_SAYS);
  await expect(card.getByText(FOREMAN_SAYS, { exact: true })).toBeVisible();
  await delivers(daemon, target, "workflow", WORKFLOW_SAYS);
  await expect(card.getByText(WORKFLOW_SAYS, { exact: true })).toBeVisible();
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("exercise the yours rail");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Dispatch, expand, and leave a conversation with three of the operator's messages in it. */
async function conversationWithMessages(
  page: Page,
  daemon: DaemonHandle,
): Promise<ReturnType<Page["locator"]>> {
  await dispatch(page, daemon);

  const card = page.locator("article.card").first();
  await card.getByRole("button", { name: "Expand conversation" }).click();

  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();

  for (const text of [FIRST, SECOND, THIRD]) {
    await reply.fill(text);
    await reply.press("Enter");
    // The echo is written after the turn lands, so its arrival means the transcript
    // update carrying the operator's own message has already reached the browser.
    await expect(card.getByText(`Mock reply to: ${text}`)).toBeVisible();
  }
  return card;
}

/** The rail, and the tab that owns it. */
function rail(card: ReturnType<Page["locator"]>): ReturnType<Page["locator"]> {
  return card.getByRole("region", { name: "Conversation rail" });
}

test("the Yours tab lists what you sent, and says who sent the rest", async ({ dashboard, daemon }) => {
  const card = await conversationWithMessages(dashboard, daemon);
  await machinesDeliver(dashboard, daemon, card);

  const yours = rail(card).getByRole("tab", { name: "Yours" });

  // Reachable, and honestly labelled as unselected until asked for: Activity is what the
  // rail shows until the operator chooses otherwise.
  await expect(yours).toBeVisible();
  await expect(yours).toHaveAttribute("aria-selected", "false");
  await yours.click();
  await expect(yours).toHaveAttribute("aria-selected", "true");

  // Every message the operator typed is indexed.
  for (const text of [FIRST, SECOND, THIRD]) {
    await expect(rail(card).getByRole("button", { name: new RegExp(text) })).toBeVisible();
  }

  // And the count is about THEM. Asserted against the rows actually drawn rather than a
  // literal, because the dispatch prompt is one of the operator's messages too - the
  // number that matters is that the delivered turns are not in it.
  const own = rail(card).locator(".yours-row:not(.is-injected)");
  const delivered = rail(card).locator(".yours-row.is-injected");
  await expect(delivered).toHaveCount(2);
  await expect(rail(card).locator(".activity-head .activity-count")).toHaveText(
    String(await own.count()),
  );

  // Both machine deliveries are listed - nothing is hidden - and each names its own
  // author, so neither can be read as something the operator typed. This is the
  // assertion the whole feature turns on: every one of these five turns carries the
  // `user` role, so a rail grouping by ROLE would have shown all five as theirs.
  const foremanRow = rail(card).getByRole("button", { name: new RegExp(FOREMAN_SAYS) });
  const workflowRow = rail(card).getByRole("button", { name: new RegExp(WORKFLOW_SAYS) });
  await expect(foremanRow).toContainText("foreman");
  await expect(workflowRow).toContainText("workflow");

  // And they sit BELOW the operator's own, whatever order they arrived in - both were
  // delivered after all three, but it is the grouping that puts them last, not the clock.
  const rows = rail(card).getByRole("button").filter({ hasText: /Investigate|Do not run|Re-file|Continue|Repair/ });
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(3)).toContainText(FOREMAN_SAYS);
  await expect(rows.nth(4)).toContainText(WORKFLOW_SAYS);

  // Dimmed, and provably so rather than by inspection: a delivered row's text is drawn
  // in a quieter colour than the operator's own.
  const mine = rail(card).getByRole("button", { name: new RegExp(FIRST) });
  const colourOf = (row: ReturnType<Page["locator"]>): Promise<string> =>
    row.locator(".yours-text").evaluate((el) => getComputedStyle(el).color);
  const quiet = await colourOf(foremanRow);
  expect(quiet).not.toBe(await colourOf(mine));
  expect(await colourOf(workflowRow)).toBe(quiet);

  // The rail says why, on the surface, rather than leaving the dimming to be decoded.
  await expect(rail(card)).toContainText(/without it reading as yours/);

  await shoot(dashboard, card, "01-yours-tab");

  // An index hides nothing: the agent's replies are still in the transcript beside it.
  await expect(card.getByText(`Mock reply to: ${FIRST}`)).toBeVisible();
});

test("clicking a row moves the transcript to that turn", async ({ dashboard, daemon }) => {
  const card = await conversationWithMessages(dashboard, daemon);
  await rail(card).getByRole("tab", { name: "Yours" }).click();

  // The log follows its tail, so the FIRST message is scrolled out of sight by the time
  // three exchanges have landed. That is the state this feature exists to rescue, and
  // asserting it first is what makes the jump below mean something.
  const firstTurn = card.locator("[data-turn-id]").filter({ hasText: FIRST }).first();
  await expect(firstTurn).not.toBeInViewport();

  await rail(card).getByRole("button", { name: new RegExp(FIRST) }).click();

  // The transcript moved to it, and the turn is marked so the reader can see where they
  // landed - with the rest of the conversation still around it, which is the whole
  // difference between indexing and filtering.
  await expect(firstTurn).toBeInViewport();
  await expect(firstTurn).toHaveClass(/is-marked/);
  await expect(card.getByText(`Mock reply to: ${FIRST}`)).toBeVisible();

  // The rail marks its own end of that selection too, so the two never disagree about
  // which message is being read.
  await expect(rail(card).getByRole("button", { name: new RegExp(FIRST) })).toHaveAttribute(
    "aria-current",
    "true",
  );

  await shoot(dashboard, card, "02-jumped-to-turn");

  // And a second row moves it again, rather than the first click being a one-off.
  const thirdTurn = card.locator("[data-turn-id]").filter({ hasText: THIRD }).first();
  await rail(card).getByRole("button", { name: new RegExp(THIRD) }).click();
  await expect(thirdTurn).toBeInViewport();
  await expect(thirdTurn).toHaveClass(/is-marked/);
  await expect(firstTurn).not.toHaveClass(/is-marked/);
});

test("the jump works in the terminal rendering too", async ({ dashboard, daemon }) => {
  // `conversationView` ships as "terminal", so for most readers this IS the conversation.
  // The two renderings draw a turn as completely different elements - a `.turn` bubble
  // and a `.pty-entry` command line - so a rail that could only address one of them
  // would be broken by default and working only for people who had switched.
  const card = await conversationWithMessages(dashboard, daemon);
  await card.getByRole("button", { name: "Terminal view" }).click();
  await expect(card.locator(".transcript[data-view='terminal']")).toBeVisible();

  // This rendering draws a turn as one command line rather than a bubble, so the three
  // exchanges above do not fill the log's height and the first message has never left
  // the screen. Fill it: a jump that lands on something already in view proves nothing.
  // The terminal rendering relabels the composer with its own prompt metaphor, so this
  // is deliberately not the chat placeholder the helper above uses.
  const reply = card.getByPlaceholder("Send the next instruction to this process…");
  for (const n of [1, 2, 3, 4]) {
    await reply.fill(`Filler turn ${n} to push the log past its height`);
    await reply.press("Enter");
    await expect(card.getByText(`Mock reply to: Filler turn ${n} to push the log past its height`)).toBeVisible();
  }

  await rail(card).getByRole("tab", { name: "Yours" }).click();
  const firstTurn = card.locator("[data-turn-id]").filter({ hasText: FIRST }).first();
  await expect(firstTurn).not.toBeInViewport();

  await rail(card).getByRole("button", { name: new RegExp(FIRST) }).click();
  await expect(firstTurn).toBeInViewport();
  await expect(firstTurn).toHaveClass(/is-marked/);
  // Still a terminal entry, not a chat bubble - the jump did not change the rendering.
  await expect(firstTurn).toHaveClass(/pty-entry/);
});

test("a narrow conversation can still reach the tabs, once it opens the rail", async ({
  dashboard,
  daemon,
}) => {
  const card = await conversationWithMessages(dashboard, daemon);

  // Narrow the PANEL, live: the layout is a container query on the conversation's own
  // width, so shrinking the window is exactly how a person reaches this state.
  await dashboard.setViewportSize({ width: 600, height: 900 });
  const narrow = rail(card);
  const toggle = narrow.getByRole("button", { name: "Observed activity" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Collapsed, the list is away but the tabs are not: they share the row the disclosure
  // was already spending, so this layout gives up no height it did not give up before -
  // and the Yours tab is reachable without opening anything first.
  const yours = narrow.getByRole("tab", { name: "Yours" });
  await expect(yours).toBeVisible();
  await expect(narrow.getByRole("button", { name: new RegExp(SECOND) })).toBeHidden();

  // Choosing a tab reveals it. A tab that switched a list the reader cannot see would be
  // a dead end at this width, which is the whole reason this opens.
  await yours.click();
  // The disclosure renames itself for the tab it is now holding, which is why this is a
  // fresh locator rather than the one above: "Observed activity" no longer names it.
  const opened = narrow.getByRole("button", { name: "Your messages" });
  await expect(opened).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveCount(0);
  await expect(narrow.getByRole("button", { name: new RegExp(SECOND) })).toBeVisible();

  await shoot(dashboard, card, "03-narrow-yours-open");

  // And it still closes, on the same control.
  await opened.click();
  await expect(narrow.getByRole("button", { name: new RegExp(SECOND) })).toBeHidden();
  await expect(yours).toBeVisible();

  // The composer survives the stacked section: still on screen, still writable.
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeVisible();
  await expect(reply).toBeEnabled();
});

test("the tab survives find taking the column, and switches back", async ({ dashboard, daemon }) => {
  const card = await conversationWithMessages(dashboard, daemon);
  await rail(card).getByRole("tab", { name: "Yours" }).click();
  await expect(rail(card).getByRole("button", { name: new RegExp(SECOND) })).toBeVisible();

  // Find owns the whole column while it is open - the rail is not merely covered.
  await card.locator(".card-meta").click();
  await dashboard.keyboard.press("Meta+f");
  await expect(card.getByRole("searchbox", { name: "Find in conversation" })).toBeVisible();
  await expect(card.getByRole("region", { name: "Conversation rail" })).toHaveCount(0);

  // Closing it hands the column back on the tab the reader left it on, not reset to
  // Activity: they were working through their own messages, and find was a detour.
  await dashboard.keyboard.press("Escape");
  await expect(rail(card).getByRole("tab", { name: "Yours" })).toHaveAttribute("aria-selected", "true");
  await expect(rail(card).getByRole("button", { name: new RegExp(SECOND) })).toBeVisible();

  // Back to Activity, and the rail is the tool-call list again.
  await rail(card).getByRole("tab", { name: "Activity" }).click();
  await expect(rail(card).getByText("Tool calls observed in the loaded transcript.")).toBeVisible();
});

test("find's You scope and the Yours tab agree about whose message is whose", async ({
  dashboard,
  daemon,
}) => {
  // The two controls the conversation offers under the word "you", in the same column,
  // asserted against the same delivered turn. They disagreed before: find selected on the
  // role alone, so its "You" pill returned rows whose own byline said foreman.
  const card = await conversationWithMessages(dashboard, daemon);
  await machinesDeliver(dashboard, daemon, card);

  await card.locator(".card-meta").click();
  await dashboard.keyboard.press("Meta+f");
  const box = card.getByRole("searchbox", { name: "Find in conversation" });
  // A word both the operator and Foreman used, so scope is the only thing that can
  // separate the two matches.
  await box.fill("build");

  // `exact` on both pills: the scope buttons sit in the same rail as the result rows,
  // and "You" is a substring of several bylines and snippets below them.
  const results = card.getByRole("complementary", { name: "Search results" });
  await results.getByRole("button", { name: "All", exact: true }).click();
  await expect(results).toContainText(FOREMAN_SAYS);

  await results.getByRole("button", { name: "You", exact: true }).click();
  await expect(results).toContainText(SECOND);
  // The row that used to come back under this pill, and must not any more.
  await expect(results).not.toContainText(FOREMAN_SAYS);
});
