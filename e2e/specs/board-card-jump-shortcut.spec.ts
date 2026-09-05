import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * ⌘1 … ⌘9, ⌘0, ⌘-, ⌘= on the Board's cards: the keycap in each card's top-right corner, and
 * the key opening that card's console.
 *
 * Every claim below needs a browser. The unit tests beside `lib/card-shortcuts.ts` prove how a
 * slot is handed out over a list of ids; they cannot see a keycap on a laid-out card, and they
 * certainly cannot see a keystroke become a route become an open conversation.
 *
 * - Every card prints its key, and the numbering runs down the board and ACROSS its status
 *   columns rather than restarting in each. That is why this spec pays for two sessions in
 *   two columns: one card could not tell "the board numbers itself" apart from "the first
 *   card gets a 1".
 * - Pressing the key opens that exact card's console view.
 * - The slots REFRESH as cards move. A card leaving **needs you** hands ⌘1 to whatever is now
 *   at the top, which is the whole reason the assignment is positional.
 * - The item is switched on and off in Settings → Display like every other card item, and
 *   unchecking it stands down the keycaps AND the chords together - an invisible shortcut
 *   that still swallowed ⌘0/⌘-/⌘= would be the one shape this control must not have.
 * - The desktop shell is told when the Board owns the number row, so page zoom keeps those
 *   keys the rest of the time. The menu itself is invisible from a browser; the report the
 *   dashboard sends is the whole input to it, and that is observable.
 * - The Keyboard panel refuses these twelve chords, naming the reservation, so no action can
 *   be bound to a key that would work in the Console and die on the Board.
 *
 * No model tokens are spent: every agent binary is redirected by
 * `e2e/fixtures/fake-agents.ts`, and the question that puts the second card in a second
 * column is posted over `POST /mcp/reviews`, the same route an agent's own MCP child uses.
 */

const EVIDENCE = artifactsDir("board-card-jump-shortcut");

/**
 * Both tasks are named explicitly, and their names are load-bearing twice over.
 *
 * With the Title field blank the daemon asks the model for one and the fake answers `E2E
 * Mock Session` for every prompt, so two dispatches would be two identically named cards.
 * And the names are chosen so that ALPHABETICAL order is the reverse of the order the two
 * cards start in: `Zulu` is the card that needs you, so it leads the board while its
 * question is open and falls behind `Alpha` the moment that question is answered. That is
 * what makes the refresh visible rather than a no-op that would pass either way.
 */
const IDLE_CARD = { title: "Alpha waits in idle", intent: "settle and wait" };
const ASKED_CARD = { title: "Zulu needs an answer", intent: "ask the human a question" };

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface LiveSession {
  id: string;
  name: string;
  state: string;
  cwd: string | null;
}

/**
 * Dispatch one agent from the real modal, settle it, and report the session it became.
 *
 * Identified by DIFFERENCE against the ids already on the fleet, because this spec
 * dispatches twice and "the one live session" stops being a description after the first.
 * `cwd` comes back with it: the review channel binds by checkout, and a dispatch cuts a
 * fresh uuid-named worktree nothing here could guess.
 */
async function dispatchIdleAgent(
  page: Page,
  daemon: DaemonHandle,
  task: { title: string; intent: string },
): Promise<LiveSession> {
  const before = new Set((await api<LiveSession[]>(daemon, "/api/sessions")).map((s) => s.id));
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // `RepoCombobox` portals its listbox over the fields below and reopens on every keystroke,
  // so without this the next fill lands on a covered control. Its own handler stops
  // propagation, so this closes the list rather than the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task.intent);
  // Title lives inside the Backlog details fold, which a fresh dispatch opens closed. The
  // summary line is part of the control's accessible name, so this cannot be `exact`.
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(task.title);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let fresh: LiveSession | undefined;
  await expect.poll(async () => {
    const sessions = await api<LiveSession[]>(daemon, "/api/sessions");
    fresh = sessions.find((s) => !before.has(s.id) && s.state !== "exited");
    // Both facts, not just the state: a card is on screen before the registry has
    // necessarily finished adopting the worktree the dispatch was cut into, and the review
    // channel below binds by that checkout.
    return fresh?.cwd ? fresh.state : "";
  }, { timeout: 60_000, message: `the dispatch for "${task.title}" settled with a checkout` })
    .toBe("idle");
  return fresh!;
}

/**
 * Ask this session's human a question, the way the agent's MCP child does.
 *
 * A pending review outranks every other reading in `stateDisplay`, so this is the cheapest
 * honest way to put a card in a second Board column - no second harness, no workflow run, no
 * kill. Returns the review's id so the answer below can retire it.
 */
async function askForReview(daemon: DaemonHandle, cwd: string): Promise<string> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      env: {},
      cwd,
      kind: "input",
      title: "Which key should this card answer to?",
      body: "Which key should this card answer to?",
      decisions: [{
        id: "q",
        question: "Which key should this card answer to?",
        options: [{ id: "o0", label: "whichever one it prints", recommended: true }],
        allowOther: false,
      }],
    }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`)
    .toBe(200);
  const created = (await res.json()) as { id: string };
  return created.id;
}

/**
 * Dispatch straight over `POST /api/tasks`, for the test that needs a board full of cards.
 *
 * The modal path above is the right one when the DISPATCH is part of what is being proved.
 * It is the wrong one for standing up thirteen cards: thirteen modal round trips is a minute
 * of typing into a form this spec is not about, and the form has its own spec. `backlog`
 * defaults false, so this launches now, and `workflowId: null` opts the task out of the
 * machine default the way the modal's "finish without a Workflow" does - this fixture
 * repository is not allowlisted for Workflows Live delivery and the dispatch would be
 * refused.
 */
async function dispatchViaApi(daemon: DaemonHandle, title: string): Promise<void> {
  await api(daemon, "/api/tasks", {
    repoRoot: daemon.repo,
    title,
    intent: `hold a jump slot for ${title}`,
    workflowId: null,
  });
}

/** Wait until `count` dispatched sessions have settled, so the board is stable to assert on. */
async function settledSessions(daemon: DaemonHandle, count: number): Promise<void> {
  await expect.poll(async () => {
    const sessions = await api<LiveSession[]>(daemon, "/api/sessions");
    return sessions.filter((s) => s.state === "idle" && s.cwd).length;
  }, { timeout: 180_000, message: `${count} dispatched sessions should settle idle` })
    .toBe(count);
}

/** Put the dashboard in the Board layout, where the cards this spec is about are drawn. */
async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon accepted the Board layout").toBe(true);
  // A RELOAD, not a hash navigation: the web store hydrates from `GET /api/ui/config` at
  // boot and paints from its `localStorage` mirror before that lands, so a preference
  // written out of band only takes on the next load.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

/** The keycap a card prints, which is the only place a person reads its key. */
function keycap(tile: Locator): Locator {
  return tile.locator(".tile-head .kb-hint");
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and it
  // would sit over the very corner this picture is of.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-card-jump-shortcut/${name}.png`);
}

test("the board numbers its cards across columns, and the key opens that card's console", async ({
  dashboard,
  daemon,
}) => {
  const idle = await dispatchIdleAgent(dashboard, daemon, IDLE_CARD);
  const asked = await dispatchIdleAgent(dashboard, daemon, ASKED_CARD);
  const reviewId = await askForReview(daemon, asked.cwd!);
  await useBoardLayout(dashboard, daemon);

  const needsYouCol = dashboard.locator("main.board section.board-col.tone-attention");
  const idleCol = dashboard.locator("main.board section.board-col.tone-idle");
  const askedTile = needsYouCol.locator(".tile");
  const idleTile = idleCol.locator(".tile");

  // The precondition the whole test rests on: two cards, in two DIFFERENT columns. Asserted
  // rather than assumed - a run that ended with both sessions in one column would go on to
  // pass while proving only what a single-card version proves.
  await expect(askedTile).toHaveCount(1);
  await expect(idleTile).toHaveCount(1);
  expect(idle.id, "the two dispatches are two sessions").not.toBe(asked.id);

  // The numbering crosses the status boundary: **needs you** is the first column, so its card
  // is ⌘1 and the count CARRIES ON into **idle** rather than restarting at 1 there.
  await expect(keycap(askedTile)).toHaveText("⌘1");
  await expect(keycap(idleTile)).toHaveText("⌘2");
  // In the card's top-right corner, which is where the request put it: the name takes the
  // rest of the head's width, so the keycap's right edge is the last thing on the row.
  const headBox = (await askedTile.locator(".tile-head").boundingBox())!;
  const capBox = (await keycap(askedTile).boundingBox())!;
  expect(capBox.x, "the keycap sits in the right half of the head").toBeGreaterThan(
    headBox.x + headBox.width / 2,
  );
  expect(
    headBox.x + headBox.width - (capBox.x + capBox.width),
    "the keycap is the last thing on the head row",
  ).toBeLessThan(2);
  // And the chord is announced on the control it drives, not only drawn: the keycap itself is
  // `aria-hidden`, as every keycap in this app is.
  await expect(
    idleTile.getByRole("button", { name: new RegExp(`^Open .*${IDLE_CARD.title}`) }),
  ).toHaveAttribute("aria-keyshortcuts", "Meta+2");
  await shoot(dashboard, "01-two-columns-numbered");

  // The claim: pressing the key opens THAT card's console view. ⌘2 is the idle card, which is
  // deliberately not the one the board has selected or the one that needs you - so opening it
  // cannot be a coincidence of either.
  await dashboard.keyboard.press("Meta+2");
  const detail = dashboard.locator(".cdetail");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { name: IDLE_CARD.title })).toBeVisible();
  // The drill-in, which is what "the console view" is on this layout: the opened card's own
  // column has become the rail beside its detail.
  await expect(dashboard.locator("main.board section.board-col.is-rail.tone-idle")).toHaveCount(1);
  await shoot(dashboard, "02-jumped-to-the-idle-card");

  // ⌘1 from inside the console re-points it at the other card, rather than needing a trip back
  // to the overview first.
  await dashboard.keyboard.press("Meta+1");
  await expect(detail.getByRole("heading", { name: ASKED_CARD.title })).toBeVisible();

  // REFRESH. The question is answered, so the `Zulu` card leaves **needs you** - and the two
  // cards are then ordered by name in one column, which puts `Alpha` first. The keys follow
  // the positions rather than the sessions.
  await dashboard.keyboard.press("Escape");
  await dashboard.keyboard.press("Escape");
  await api(daemon, `/api/reviews/${reviewId}/resolve`, { action: "dismiss" });
  await expect(needsYouCol.locator(".tile")).toHaveCount(0);
  const settled = idleCol.locator(".tile");
  await expect(settled).toHaveCount(2);
  await expect(settled.nth(0)).toContainText(IDLE_CARD.title);
  await expect(settled.nth(1)).toContainText(ASKED_CARD.title);
  await expect(keycap(settled.nth(0))).toHaveText("⌘1");
  await expect(keycap(settled.nth(1))).toHaveText("⌘2");
  // Which is the swap, stated from the card's side: the card that held ⌘1 a moment ago now
  // prints ⌘2, and ⌘1 opens its neighbour.
  const askedNow = idleCol.locator(".tile").filter({ hasText: ASKED_CARD.title });
  await expect(keycap(askedNow)).toHaveText("⌘2");
  // Captured from the OVERVIEW, before the press below: this is the one frame that shows the
  // refresh, and a picture taken after the jump would show the console instead of the two
  // renumbered cards it is evidence for.
  await shoot(dashboard, "03-keys-refreshed-after-the-answer");
  await dashboard.keyboard.press("Meta+1");
  await expect(dashboard.locator(".cdetail").getByRole("heading", { name: IDLE_CARD.title }))
    .toBeVisible();
});

test("all twelve slots are handed out in order, and the last three open their cards", async ({
  dashboard,
  daemon,
}) => {
  // The tenth, eleventh and twelfth slots - ⌘0, ⌘- and ⌘= - are the three the operator named
  // last and the three no smaller fleet can reach. A two-card board cannot tell "⌘= opens the
  // twelfth card" apart from "⌘= is not ours", because on a two-card board it genuinely is
  // not ours. So this test pays for thirteen cards: twelve to fill the row, and a thirteenth
  // to show the slots running out rather than wrapping.
  //
  // WHAT THIS PROVES, exactly. Playwright drives the page through the DevTools protocol,
  // which delivers a keystroke to the renderer directly - it does not travel through the
  // browser's own chrome, which is why Playwright cannot open a browser tab with ⌘T either.
  // So this settles that the app's handler claims these three chords and opens the right
  // card. It does NOT settle whether a real browser's window shortcuts would have taken the
  // keystroke first; that question has no page-JavaScript answer at all, and the decision
  // taken on it is recorded in `src/web/lib/card-shortcuts.ts` and stated in `docs/ui.md`.
  const titles = Array.from({ length: 13 }, (_, i) => `Slot ${String(i + 1).padStart(2, "0")}`);
  for (const title of titles) await dispatchViaApi(daemon, title);
  await settledSessions(daemon, titles.length);
  // Thirteen cards in one column, all in frame. The assertions below do not need it - a
  // Playwright locator reads a card whether or not it is scrolled into view - but the
  // evidence frame does: the whole point of this fleet is the BOTTOM of the row, ⌘0/⌘-/⌘= and
  // the card after them, and a picture of the first four cards shows none of that.
  await dashboard.setViewportSize({ width: 1500, height: 2200 });
  await useBoardLayout(dashboard, daemon);

  const tiles = dashboard.locator("main.board .tile");
  await expect(tiles).toHaveCount(titles.length);

  // The number row as it is spelled on the keyboard, in board order. Asserted card by card
  // rather than as a set: the claim is that slot N belongs to the Nth card, and a set would
  // pass on a board that handed out all twelve keys in the wrong order.
  const row = ["⌘1", "⌘2", "⌘3", "⌘4", "⌘5", "⌘6", "⌘7", "⌘8", "⌘9", "⌘0", "⌘-", "⌘="];
  for (const [index, chord] of row.entries()) {
    await expect(tiles.nth(index)).toContainText(titles[index]!);
    await expect(keycap(tiles.nth(index))).toHaveText(chord);
  }
  // Thirteenth: plainly no keycap, rather than a chord nobody can press.
  await expect(tiles.nth(12)).toContainText(titles[12]!);
  await expect(keycap(tiles.nth(12))).toHaveCount(0);
  await shoot(dashboard, "05-twelve-slots-and-a-thirteenth-card");

  // And each of the last three opening ITS OWN card - not the first card, and not the one the
  // board happens to have selected. Pressed in ascending order, so each press also has to
  // re-point a detail the previous one opened.
  const detail = dashboard.locator(".cdetail");
  for (const [chord, title] of [
    ["Meta+0", "Slot 10"],
    ["Meta+-", "Slot 11"],
    ["Meta+=", "Slot 12"],
  ] as const) {
    await dashboard.keyboard.press(chord);
    await expect(detail.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await shoot(dashboard, "06-twelfth-slot-opened-by-cmd-equals");
});

test("unchecking the item takes the keycaps off every card and stands the chords down", async ({
  dashboard,
  daemon,
}) => {
  await dispatchIdleAgent(dashboard, daemon, IDLE_CARD);
  await useBoardLayout(dashboard, daemon);

  const tile = dashboard.locator("main.board .tile");
  await expect(tile).toHaveCount(1);
  // Shipped ON, unlike the worktree cell: this is the affordance for a capability rather than
  // a new fact about the session, and a chord nobody can see is a chord nobody presses.
  await expect(keycap(tile)).toHaveText("⌘1");

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const item = dashboard.getByRole("checkbox", { name: "Jump shortcut", exact: true });
  await expect(item).toBeChecked();
  await item.uncheck();

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(tile).toHaveCount(1);
  await expect(keycap(tile)).toHaveCount(0);
  // The half a keycap count cannot prove, and the reason the two are one switch: the chord is
  // down too. ⌘1 does nothing, so nothing opens - and on the desktop shell ⌘0/⌘-/⌘= go back
  // to whatever else the operator uses them for.
  await dashboard.keyboard.press("Meta+1");
  await expect(dashboard.locator(".cdetail")).toHaveCount(0);
  // Still an ordinary card: its name is not on the list and cannot be switched off.
  await expect(tile.locator(".tile-name")).toHaveCount(1);
  await shoot(dashboard, "04-item-unchecked");

  // And back, which is what makes it a preference rather than a one-way trim.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(item).not.toBeChecked();
  await item.check();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(keycap(tile)).toHaveText("⌘1");
  await dashboard.keyboard.press("Meta+1");
  await expect(dashboard.locator(".cdetail")).toBeVisible();
});

test("the shell is told the Board owns the number row only on Fleet, and only while it is on", async ({
  dashboard,
  daemon,
}) => {
  // The desktop half of this feature, from the only side a browser can see it.
  //
  // A menu accelerator is registered with the OS and handled before the renderer sees the
  // keystroke, so ⌘0/⌘-/⌘= cannot be both zoom's and the board's - the View menu hands them
  // over while the dashboard is claiming them and takes them back when it is not. Which of
  // those two states the shell is in is not observable from a browser at all. What IS
  // observable is the report the dashboard sends, and that report is the whole input to the
  // decision, so this stubs the bridge and reads it.
  //
  // Ownership follows the PAGE and the PREFERENCE, not whether a card happens to hold a
  // given slot - on the enabled Fleet Board the row is the Board's even where slots 10-12 have
  // no card, which is the rule `main/menu-template.ts` states and `docs/ui.md` repeats. So the
  // cases below vary exactly those two things, and both shipped broken in this branch: a page
  // that is not Fleet under a layout that still says `board`, and the preference switched off.
  await dashboard.addInitScript(() => {
    const reports: boolean[] = [];
    Object.defineProperty(window, "__cardJumpKeyReports", {
      configurable: true,
      get: () => reports,
    });
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        onOpenSettings: () => () => {},
        setCardJumpKeys: async (claimed: boolean) => void reports.push(claimed),
      },
    });
  });

  const latest = (): Promise<boolean | undefined> =>
    dashboard.evaluate(() => {
      const reports = (window as unknown as { __cardJumpKeyReports: boolean[] })
        .__cardJumpKeyReports;
      return reports.at(-1);
    });

  await dispatchIdleAgent(dashboard, daemon, IDLE_CARD);
  await useBoardLayout(dashboard, daemon);
  await expect(dashboard.locator("main.board .tile")).toHaveCount(1);
  // Claimed: a Board card is on screen with a key printed on it.
  await expect.poll(latest, { message: "the Board claims the number row" }).toBe(true);

  // Released on another PAGE, though the layout is still Board. The keydown handler returns
  // early for every non-fleet route, so a claim here would take ⌘0/⌘-/⌘= from zoom on the
  // Library, on Runs, and on the Settings page that carries this feature's own checkbox.
  for (const page of ["library", "runs", "settings/display"]) {
    await dashboard.goto(`${daemon.baseURL}/#/${page}`);
    await expect.poll(latest, { message: `${page} releases the number row` }).toBe(false);
  }

  // Claimed again on the way back, so this is a live report rather than a one-way trim.
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect.poll(latest, { message: "returning to the fleet reclaims it" }).toBe(true);

  // Released by the preference, which is what the item's own description promises.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await dashboard.getByRole("checkbox", { name: "Jump shortcut", exact: true }).uncheck();
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(dashboard.locator("main.board .tile")).toHaveCount(1);
  await expect.poll(latest, { message: "the preference releases the number row" }).toBe(false);
});

test("the shortcut is not a rebindable action in the Keyboard panel", async ({
  dashboard,
  daemon,
}) => {
  // Stated on the surface an operator would look on. A slot addresses a POSITION on the
  // board, so there is no one action to name in a settings row and nothing to rebind - ⌘4
  // means "the fourth card" or it means nothing. The switch is the Display item instead,
  // which the test above drives.
  await dashboard.goto(`${daemon.baseURL}/#/settings/keyboard`);
  const panel = dashboard
    .locator("section.settings-section")
    .filter({ has: dashboard.getByRole("heading", { name: "Shortcuts", exact: true }) });
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText("Jump shortcut");
  for (const chord of ["⌘1", "⌘0", "⌘-", "⌘="]) {
    await expect(panel.getByText(chord, { exact: true })).toHaveCount(0);
  }
  // Nor can an action be REBOUND onto one of the twelve, which is the other half of "not
  // configurable here". The jump arm runs ahead of the action dispatch, so an action bound to
  // ⌘1 would keep working in the Console and on every other page and silently stop working on
  // the Board - so the editor refuses the chord instead of accepting one it cannot honour, and
  // says which reservation refused it.
  const diffRow = panel.locator('[data-anchor="keyboard/diff"]');
  await diffRow.getByRole("button", { name: /^Change shortcut for Open diff/ }).click();
  await expect(diffRow.getByRole("button", { name: /^Recording/ })).toBeVisible();
  await dashboard.keyboard.press("Meta+1");
  await expect(panel.locator(".settings-error"))
    .toHaveText("⌘1 is reserved for the Board's card jump shortcuts.");
  // Still recording after a refusal, which is the right shape - the operator is being asked
  // for a different key, not silently returned to a row that looks unchanged.
  await expect(diffRow.getByRole("button", { name: /^Recording/ })).toBeVisible();
  await dashboard.keyboard.press("Escape");
  // Refused, not quietly applied: the action still answers to its own key.
  await expect(
    diffRow.getByRole("button", { name: /^Change shortcut for Open diff \(currently ⇧D\)/ }),
  ).toBeVisible();

  // The switch that does exist, on the surface the request named, so the two panels
  // together say where this feature is turned on and off.
  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await expect(
    dashboard
      .locator('[data-anchor="display/board-card"]')
      .getByRole("checkbox", { name: "Jump shortcut", exact: true }),
  ).toBeVisible();
});
