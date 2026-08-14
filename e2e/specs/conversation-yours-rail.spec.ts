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
 * for. All three origins are driven through their real routes here - Foreman and workflow
 * through `/inject`, Mission Control through the retro delivery - so the separation is
 * proven on turns the daemon actually attributed rather than on fixtures.
 *
 * Every lookup here is `getByRole` or `getByPlaceholder` - no class, no attribute, and no
 * reading of body text. Two things make that possible. A rail row is a button whose
 * accessible name IS the message it indexes, so it can be named directly. A transcript
 * turn is an `article` named for whoever typed it, in both renderings, so turns are
 * addressed by author and then by position - and position is something this spec controls,
 * because it sends known messages in a known order.
 *
 * No model tokens: `MISSION_CLAUDE_BIN` points at the fake throughout, and every turn
 * here is either typed into the composer or delivered by the daemon.
 */

const EVIDENCE = artifactsDir("conversation-yours-rail");

/** What the operator types, in order. Distinct enough to assert on individually. */
const FIRST = "Investigate the ensemble failure and schedule fixes";
const SECOND = "Do not run the build in that checkout";
const THIRD = "Re-file the task and go ahead with the build";
/** Sent after the rail is already open, to prove it still follows the tail. */
const FOURTH = "And pin the flake before it costs another run";

/** The dispatch prompt, which is the operator's first message in the conversation. */
const DISPATCH = "exercise the yours rail";

/**
 * The card's own heading, which the dispatch prompt becomes.
 *
 * Case-insensitive because the title is drawn title-cased from what was typed.
 */
const CARD_TITLE = /exercise the yours rail/i;

/** What is delivered on the operator's behalf - the turns that must NOT read as theirs. */
const FOREMAN_SAYS = "Continue. You have approval to run the build.";
const WORKFLOW_SAYS = "Repair the failing stage and report back.";

/**
 * How many prose replies the agent has written by the end of the setup.
 *
 * One for the dispatch prompt and one for each of the three messages typed after it. It
 * is a count rather than a search for any one of them because a turn names its author,
 * not its contents - which is what keeps every lookup here to a role and a name.
 */
const AGENT_REPLIES = 4;

/** The bylines the rail draws for the three non-human origins. */
const FOREMAN = "foreman";
const MISSION_CONTROL = "mission control";
const WORKFLOW = "workflow";

interface FleetSession {
  id: string;
  agentSessionId: string | null;
  runtime: string;
}

/**
 * Photograph the surface the assertions above just proved.
 *
 * Behind `MC_E2E_EVIDENCE`, matching the sibling rail spec: the assertions are what keep
 * the feature honest on every run, and a picture nobody asked for is a cost with no
 * reader. Produced outside the repository, because evidence is never committed.
 */
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
 * Waiting for `agentSessionId` is what makes the deliveries below land on this session
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
 * Turn the shipped skills on before anything is dispatched.
 *
 * Order matters and is the whole reason this runs first: enabling skills bumps the
 * config's generation, and a session that started BEFORE that bump is refused the retro
 * until it acknowledges a reload. A session dispatched after it starts current, which is
 * the state a real operator's session is in.
 */
async function enableSkills(daemon: DaemonHandle): Promise<void> {
  const view = (await (await fetch(`${daemon.baseURL}/api/skills`)).json()) as {
    skills: { id: string }[];
  };
  const skills = Object.fromEntries(view.skills.map((s) => [s.id, true]));
  const res = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, skills }),
  });
  expect(res.ok, `PUT /api/skills/config answered ${res.status}`).toBe(true);
}

/** Deliver a turn the way Foreman and workflow repair do: the real route, real origin. */
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
 * Mission Control typing into the session on the operator's behalf.
 *
 * The retro route is the shipped path that records a `harness` origin - the daemon acting
 * on a human's click. There is no `/inject` origin for it deliberately: a caller cannot
 * claim to be the daemon, so this has to come through the route that really is.
 */
async function missionControlDelivers(daemon: DaemonHandle, target: FleetSession): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(target.id)}/retro`, {
    method: "POST",
  });
  expect(res.ok, `POST /retro answered ${res.status}: ${await res.text()}`).toBe(true);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(DISPATCH);
  await dialog.getByRole("combobox", { name: "After work" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** Dispatch, expand, and leave a conversation with more of the operator's messages in it. */
async function conversationWithMessages(
  page: Page,
  daemon: DaemonHandle,
  texts: string[] = [FIRST, SECOND, THIRD],
): Promise<ReturnType<Page["locator"]>> {
  await dispatch(page, daemon);

  // The card is an `article`, and so is every turn inside it now that both renderings
  // draw a turn as one - so the heading it carries is what tells the two apart. Filtering
  // on a role rather than reaching for `article.card` keeps every selector in this spec
  // to a role, a label, a placeholder or text a person can read on screen.
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: CARD_TITLE }) });
  await card.getByRole("button", { name: "Expand conversation" }).click();

  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();

  for (const [i, text] of texts.entries()) {
    await reply.fill(text);
    await reply.press("Enter");
    // Wait on the operator's own turn ARRIVING rather than on the echo quoting it back.
    // Counting is what makes this a role-only wait: the turns are named for their author,
    // so "the dispatch prompt plus the ones sent so far" is a number the spec knows.
    await expect(turnsBy(card, "you")).toHaveCount(i + 2);
  }
  return card;
}

/** The rail, by the landmark it names itself with. */
function rail(card: ReturnType<Page["locator"]>): ReturnType<Page["locator"]> {
  return card.getByRole("region", { name: "Conversation rail" });
}

/** One rail row, by the accessible name it takes from the message it indexes. */
function row(
  card: ReturnType<Page["locator"]>,
  text: string,
): ReturnType<Page["locator"]> {
  return rail(card).getByRole("button", { name: new RegExp(text) });
}

/**
 * Every rail row, in the order the rail draws them.
 *
 * No filter: at rail widths the disclosure caret is `display: none` and so is out of the
 * accessibility tree, which leaves the rows as the only buttons in the column.
 */
function rows(card: ReturnType<Page["locator"]>): ReturnType<Page["locator"]> {
  return rail(card).getByRole("button");
}

/**
 * The transcript turns by a given author, in conversation order.
 *
 * Both renderings draw a turn as an `article` named for whoever typed it, so a turn is
 * addressable by role and accessible name alone - no class, no attribute, and no reading
 * of the message body. Which of an author's turns is wanted is then a position, and
 * position is what this spec controls: it sends known messages in a known order.
 */
function turnsBy(
  card: ReturnType<Page["locator"]>,
  who: string,
): ReturnType<Page["locator"]> {
  return card.getByRole("article", { name: who, exact: true });
}

/** The operator's messages, indexed the way they were sent. */
const YOURS = { DISPATCH: 0, FIRST: 1, SECOND: 2, THIRD: 3 } as const;

/** One of the operator's own turns, by the order it was sent in. */
function yourTurn(
  card: ReturnType<Page["locator"]>,
  index: (typeof YOURS)[keyof typeof YOURS],
): ReturnType<Page["locator"]> {
  return turnsBy(card, "you").nth(index);
}

/** The colour a rail row draws its message in, which is what "dimmed" means on screen. */
function colourOf(locator: ReturnType<Page["locator"]>): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).color);
}

test("both groups and a jump, in one frame", async ({ dashboard, daemon }) => {
  // The whole feature at once, in the smallest conversation that can show it.
  //
  // The rail is 244px wide and about four rows tall, so a session with seven rows in it
  // cannot put both groups on screen together however it is scrolled - the test below
  // proves the grouping by reading the rows, which needs no picture. This one exists so
  // that a person who has not run the code can SEE it: two messages the operator sent,
  // then the two sent for them, dimmed and named, and the transcript holding the turn a
  // row just jumped to. It asserts what it photographs, so the picture cannot outlive
  // the behaviour.
  // Tall enough that the whole card is on screen at once. `toBeInViewport` answers about
  // the BROWSER's viewport, not the rail's scroller, so at the default 720px the foot of
  // the card falls off the bottom and rows that are perfectly visible inside the rail
  // still read as out of view.
  await dashboard.setViewportSize({ width: 1280, height: 1000 });
  await enableSkills(daemon);
  const card = await conversationWithMessages(dashboard, daemon, [FIRST]);

  const target = await session(daemon);
  await delivers(daemon, target, "foreman", FOREMAN_SAYS);
  await expect(turnsBy(card, FOREMAN)).toBeVisible();
  await missionControlDelivers(daemon, target);
  await expect(turnsBy(card, MISSION_CONTROL)).toBeVisible();

  await rail(card).getByRole("tab", { name: "Yours" }).click();

  // Four rows, and every one of them on screen: the operator's two first, then the two
  // sent on their behalf, each naming its author.
  const ordered = rows(card);
  await expect(ordered).toHaveCount(4);
  await expect(ordered.nth(0)).toHaveAccessibleName(new RegExp(DISPATCH));
  await expect(ordered.nth(1)).toHaveAccessibleName(new RegExp(FIRST));
  await expect(ordered.nth(2)).toHaveAccessibleName(new RegExp(FOREMAN));
  await expect(ordered.nth(3)).toHaveAccessibleName(new RegExp(MISSION_CONTROL));

  // The two delivered rows are drawn quieter than the operator's own.
  const quiet = await colourOf(ordered.nth(2));
  expect(quiet).not.toBe(await colourOf(ordered.nth(1)));
  expect(await colourOf(ordered.nth(3))).toBe(quiet);

  // And a row moves the log: Foreman's turn is marked in the rail and flashing in the
  // transcript, with the conversation still around it.
  await ordered.nth(2).click();
  await expect(turnsBy(card, FOREMAN)).toBeInViewport();
  await expect(turnsBy(card, FOREMAN)).toHaveClass(/is-flashed/);
  await expect(ordered.nth(2)).toHaveAttribute("aria-current", "true");

  // The boundary between the two groups, on screen together: one of the operator's own
  // messages, then both of the ones sent for them. The rail is a 244px column about three
  // rows tall, so this trio is the most of the list that can share a frame - and it is the
  // part that carries the meaning, because it is where "mine" stops and "sent for me"
  // starts. Asserted rather than hoped for, so the photograph below cannot quietly stop
  // showing it.
  await ordered.nth(3).scrollIntoViewIfNeeded();
  for (const i of [1, 2, 3]) await expect(ordered.nth(i)).toBeInViewport();

  await shoot(dashboard, card, "00-rail-and-jump");
});

test("the Yours tab lists what you sent, and says who sent the rest", async ({
  dashboard,
  daemon,
}) => {
  await enableSkills(daemon);
  const card = await conversationWithMessages(dashboard, daemon);

  const target = await session(daemon);
  await delivers(daemon, target, "foreman", FOREMAN_SAYS);
  await expect(turnsBy(card, FOREMAN)).toBeVisible();
  await delivers(daemon, target, "workflow", WORKFLOW_SAYS);
  await expect(turnsBy(card, WORKFLOW)).toBeVisible();
  await missionControlDelivers(daemon, target);

  const yours = rail(card).getByRole("tab", { name: "Yours" });

  // Reachable, and honestly labelled as unselected until asked for: Activity is what the
  // rail shows until the operator chooses otherwise.
  await expect(yours).toBeVisible();
  await expect(yours).toHaveAttribute("aria-selected", "false");
  await yours.click();
  await expect(yours).toHaveAttribute("aria-selected", "true");

  // Every message the operator typed is indexed, the dispatch prompt included - it is a
  // message they wrote, and the rail would be lying to leave it out.
  for (const text of [DISPATCH, FIRST, SECOND, THIRD]) {
    await expect(row(card, text)).toBeVisible();
  }

  // All three machine-typed turns are listed - nothing is hidden - and each names its own
  // author, so none can be read as something the operator typed. This is the assertion
  // the whole feature turns on: every one of these seven turns carries the `user` role,
  // so a rail grouping by ROLE would have shown all seven as theirs.
  const foremanRow = row(card, FOREMAN_SAYS);
  const workflowRow = row(card, WORKFLOW_SAYS);
  const missionRow = rail(card).getByRole("button", { name: new RegExp(MISSION_CONTROL) });
  await expect(foremanRow).toContainText(FOREMAN);
  await expect(workflowRow).toContainText(WORKFLOW);
  await expect(missionRow).toContainText(MISSION_CONTROL);

  // That the head COUNT is about the operator's messages only - four typed, three
  // delivered, so it reads four - is pinned in `test/conversation-yours-render.test.ts`
  // instead. The count is a bare number with no role and no label, and giving it one
  // purely so a browser test could name it would be furniture, not accessibility.

  // And the delivered turns sit BELOW the operator's own, whatever order they arrived in.
  // All three were delivered after all four were typed, but it is the grouping that puts
  // them last rather than the clock.
  const ordered = rows(card);
  await expect(ordered).toHaveCount(7);
  for (const [i, byline] of [FOREMAN, WORKFLOW, MISSION_CONTROL].entries()) {
    await expect(ordered.nth(4 + i)).toHaveAccessibleName(new RegExp(byline));
  }

  // Dimmed, and provably so rather than by inspection: a delivered row draws its message
  // in a quieter colour than the operator's own, and all three share it.
  const quiet = await colourOf(foremanRow);
  expect(quiet).not.toBe(await colourOf(row(card, FIRST)));
  expect(await colourOf(workflowRow)).toBe(quiet);
  expect(await colourOf(missionRow)).toBe(quiet);

  // The rail says why, on the surface, rather than leaving the dimming to be decoded.
  await expect(rail(card)).toContainText(/without it reading as yours/);

  // The one frame that carries the whole feature, taken after everything above has
  // already been asserted so the picture and the proof come from the same run.
  //
  // The rail opens anchored on the operator's last message, so the delivered rows start
  // below the fold: bringing them up puts both groups in shot at once, which is the point.
  // Then a delivered row is CLICKED, so the same frame also holds the other half of the
  // feature - the row marked in the rail, and the turn it jumped to flashing in the log.
  // Taken while the flash is still up, which is why it follows the class assertion
  // directly rather than after any further waiting.
  // The middle of the three delivered rows, deliberately: clicking focuses it and the
  // browser scrolls a focused control into view, which lands the window on the boundary
  // between the two groups - the operator's last message above, all three delivered rows
  // below it - with no scrolling of our own to fight the focus. The rail holds about four
  // rows at this height, so this is the frame that carries the most of the feature at once.
  await workflowRow.click();
  await expect(turnsBy(card, WORKFLOW)).toBeInViewport();
  await expect(turnsBy(card, WORKFLOW)).toHaveClass(/is-flashed/);
  await expect(workflowRow).toHaveAttribute("aria-current", "true");
  await shoot(dashboard, card, "01-yours-tab");

  // An index hides nothing: the agent's replies are all still in the transcript beside it,
  // one for every turn it was sent - the three delivered on the operator's behalf
  // included, because the agent answers those exactly as it answers a typed one.
  await expect(turnsBy(card, "claude")).toHaveCount(AGENT_REPLIES + 3);
});

test("clicking a row moves the transcript to that turn and flashes it", async ({
  dashboard,
  daemon,
}) => {
  const card = await conversationWithMessages(dashboard, daemon);
  await rail(card).getByRole("tab", { name: "Yours" }).click();

  // The log follows its tail, so the FIRST message is scrolled out of sight by the time
  // three exchanges have landed. That is the state this feature exists to rescue, and
  // asserting it first is what makes the jump below mean something.
  const firstTurn = yourTurn(card, YOURS.FIRST);
  await expect(firstTurn).not.toBeInViewport();
  await expect(firstTurn).not.toHaveClass(/is-flashed/);

  await row(card, FIRST).click();

  // The transcript moved to it, and the turn flashes so the reader can see where they
  // landed - with the rest of the conversation still around it, which is the whole
  // difference between indexing and filtering.
  await expect(firstTurn).toBeInViewport();
  await expect(firstTurn).toHaveClass(/is-flashed/);
  // The context around it survived the jump - that is the whole point of an index.
  await expect(turnsBy(card, "claude").first()).toBeVisible();

  await shoot(dashboard, card, "02-jumped-to-turn");

  // The rail marks its own end of that selection, and keeps it: the flash answers "you
  // were taken here", the mark answers "this is the message you are reading", and only
  // the first of those stops being true.
  await expect(row(card, FIRST)).toHaveAttribute("aria-current", "true");

  // The flash is a flash. It goes on its own, leaving the turn reading as an ordinary
  // part of the conversation rather than as one in a permanent state.
  await expect(firstTurn).not.toHaveClass(/is-flashed/, { timeout: 10_000 });
  await expect(row(card, FIRST)).toHaveAttribute("aria-current", "true");

  // And a second row moves it again, rather than the first click being a one-off.
  const thirdTurn = yourTurn(card, YOURS.THIRD);
  await row(card, THIRD).click();
  await expect(thirdTurn).toBeInViewport();
  await expect(thirdTurn).toHaveClass(/is-flashed/);
  await expect(firstTurn).not.toHaveClass(/is-flashed/);

  // Clicking the row you are ALREADY on flashes again, which is the one case a class
  // that never leaves the DOM would silently swallow: React drops a state update that
  // does not change the id, so the ring would sit at its faded end while the reader
  // watched nothing happen. Read off the animation's own clock rather than a screenshot,
  // because "did it start over?" is exactly what that clock answers.
  const ringAge = (): Promise<number> =>
    thirdTurn.evaluate((el) => Number(el.getAnimations()[0]?.currentTime ?? -1));
  await dashboard.waitForTimeout(700);
  expect(await ringAge(), "the ring should have been running a while").toBeGreaterThan(400);
  await row(card, THIRD).click();
  expect(await ringAge(), "a repeat click should restart the ring").toBeLessThan(400);
});

test("the jump works in the terminal rendering too", async ({ dashboard, daemon }) => {
  // `conversationView` ships as "terminal", so for most readers this IS the conversation.
  // The two renderings draw a turn completely differently - a bubble and a command line -
  // so a rail that could only address one of them would be broken by default and working
  // only for people who had switched.
  const card = await conversationWithMessages(dashboard, daemon);
  await card.getByRole("button", { name: "Terminal view" }).click();

  // The terminal rendering relabels the composer with its own prompt metaphor, which is
  // how a reader knows the switch landed.
  const reply = card.getByPlaceholder("Send the next instruction to this process…");
  await expect(reply).toBeVisible();

  // This rendering draws a turn as one command line rather than a bubble, so the three
  // exchanges above do not fill the log's height and the first message has never left the
  // screen. Fill it: a jump that lands on something already in view proves nothing.
  for (const n of [1, 2, 3, 4]) {
    await reply.fill(`Filler turn ${n} to push the log past its height`);
    await reply.press("Enter");
    await expect(turnsBy(card, "you")).toHaveCount(4 + n);
  }

  await rail(card).getByRole("tab", { name: "Yours" }).click();
  const firstTurn = yourTurn(card, YOURS.FIRST);
  await expect(firstTurn).not.toBeInViewport();

  await row(card, FIRST).click();
  await expect(firstTurn).toBeInViewport();
  await expect(firstTurn).toHaveClass(/is-flashed/);
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
  await expect(row(card, SECOND)).toBeHidden();

  // Choosing a tab reveals it. A tab that switched a list the reader cannot see would be
  // a dead end at this width, which is the whole reason this opens.
  await yours.click();
  // The disclosure renames itself for the tab it is now holding, which is why this is a
  // fresh locator rather than the one above: "Observed activity" no longer names it.
  const opened = narrow.getByRole("button", { name: "Your messages" });
  await expect(opened).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveCount(0);
  await expect(row(card, SECOND)).toBeVisible();

  await shoot(dashboard, card, "03-narrow-yours-open");

  // And it still closes, on the same control.
  await opened.click();
  await expect(row(card, SECOND)).toBeHidden();
  await expect(yours).toBeVisible();
});

test("the rail keeps following your latest message, and reopens on it", async ({
  dashboard,
  daemon,
}) => {
  // Two regressions, both of them in how the rail decides the reader has scrolled away.
  //
  // The rail rests on the last of the OPERATOR's rows rather than on the scroller's end,
  // because the dimmed rows sit past it. It used to measure "has the reader left?" against
  // the literal bottom, so its own anchoring reported the view as away from the tail and
  // it stopped following - one delivered turn was enough to break it for the rest of the
  // session. And the flag was shared across both tabs, so a list left scrolled up handed
  // that position to the other tab.
  const card = await conversationWithMessages(dashboard, daemon);
  await delivers(daemon, await session(daemon), "foreman", FOREMAN_SAYS);
  await expect(turnsBy(card, FOREMAN)).toBeVisible();
  await rail(card).getByRole("tab", { name: "Yours" }).click();

  // Resting on the operator's last message, with the delivered row below the fold.
  await expect(row(card, THIRD)).toBeInViewport();

  // A message sent now still pulls the rail after it. This is the case the old reading of
  // "at the bottom" silently dropped.
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await reply.fill(FOURTH);
  await reply.press("Enter");
  await expect(row(card, FOURTH)).toBeInViewport();
  // And the list really is overflowing, so following it meant something.
  await expect(row(card, DISPATCH)).not.toBeInViewport();

  // Reading back through your own messages parks the rail where you left it.
  await row(card, DISPATCH).scrollIntoViewIfNeeded();
  await expect(row(card, FOURTH)).not.toBeInViewport();

  // But asking for a tab is asking to see that list, so it opens on its own resting place
  // rather than inheriting wherever the column happened to be left.
  await rail(card).getByRole("tab", { name: "Activity" }).click();
  await rail(card).getByRole("tab", { name: "Yours" }).click();
  await expect(row(card, FOURTH)).toBeInViewport();
});

test("the tab survives find taking the column, and switches back", async ({ dashboard, daemon }) => {
  const card = await conversationWithMessages(dashboard, daemon);
  await rail(card).getByRole("tab", { name: "Yours" }).click();
  await expect(row(card, SECOND)).toBeVisible();

  // Find owns the whole column while it is open - the rail is not merely covered.
  await card.getByRole("heading", { name: CARD_TITLE }).click();
  await dashboard.keyboard.press("Meta+f");
  await expect(card.getByRole("searchbox", { name: "Find in conversation" })).toBeVisible();
  await expect(card.getByRole("region", { name: "Conversation rail" })).toHaveCount(0);

  // Closing it hands the column back on the tab the reader left it on, not reset to
  // Activity: they were working through their own messages, and find was a detour.
  await dashboard.keyboard.press("Escape");
  await expect(rail(card).getByRole("tab", { name: "Yours" })).toHaveAttribute("aria-selected", "true");
  await expect(row(card, SECOND)).toBeVisible();

  // Back to Activity, and the column stops being your messages: the tabs swap which of
  // the two lists the rail IS, rather than adding one below the other.
  await rail(card).getByRole("tab", { name: "Activity" }).click();
  await expect(rail(card).getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await expect(rail(card).getByRole("tab", { name: "Yours" })).toHaveAttribute("aria-selected", "false");
  await expect(row(card, SECOND)).toHaveCount(0);
});

test("find's You scope and the Yours tab agree about whose message is whose", async ({
  dashboard,
  daemon,
}) => {
  // The two controls the conversation offers under the word "you", in the same column,
  // asserted against the same delivered turn. They disagreed before: find selected on the
  // role alone, so its "You" pill returned rows whose own byline said foreman.
  const card = await conversationWithMessages(dashboard, daemon);
  await delivers(daemon, await session(daemon), "foreman", FOREMAN_SAYS);
  await expect(turnsBy(card, FOREMAN)).toBeVisible();

  await card.getByRole("heading", { name: CARD_TITLE }).click();
  await dashboard.keyboard.press("Meta+f");
  const box = card.getByRole("searchbox", { name: "Find in conversation" });
  // A word both the operator and Foreman used, so scope is the only thing that can
  // separate the two matches.
  await box.fill("build");

  // `exact` on both pills: the scope buttons sit in the same rail as the result rows, and
  // "You" is a substring of several bylines and snippets below them.
  const results = card.getByRole("complementary", { name: "Search results" });
  await results.getByRole("button", { name: "All", exact: true }).click();
  await expect(results).toContainText(FOREMAN_SAYS);

  await results.getByRole("button", { name: "You", exact: true }).click();
  await expect(results).toContainText(SECOND);
  // The row that used to come back under this pill, and must not any more.
  await expect(results).not.toContainText(FOREMAN_SAYS);
});
