import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Board collects its cards by repository, on by default, and folds a group away.
 *
 * Five claims, and only a browser settles any of them. That the headings are there WITHOUT
 * anybody opening Settings - which is the whole of "shipped on", and is a claim about a fresh
 * profile rather than about a default constant. That a heading names its repository's directory
 * name. That a card really is INSIDE its repository's frame, which is a DOM containment fact no
 * markup assertion on a component in isolation can make. That the heading's disclosure hides and
 * restores its cards. And that unchecking the setting returns the column to one flat list with
 * every card still on it - a grouping that lost a session when switched off would be a far worse
 * bug than one that never grouped at all.
 *
 * Two repositories, because one cannot show a grouping: with a single repository every card is
 * in the same frame and a spec asserting "the cards are grouped" would pass over a board that
 * had simply drawn one box round everything.
 *
 * No model tokens: both dispatched agents are `e2e/fixtures/fake-agents.ts`.
 */

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** Dispatch one agent into `repo` and wait for it to settle idle. */
async function dispatchInto(
  page: Page,
  daemon: DaemonHandle,
  repo: string,
  goal: string,
  expectTotal: number,
): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(goal);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // Polled on the daemon rather than on the DOM: the card appears before the agent settles, and
  // a grouping assertion made against a starting session reads a column that is still moving.
  await expect.poll(async () => {
    const sessions = await api<Array<{ state: string; repoRoot: string | null }>>(
      daemon,
      "/api/sessions",
    );
    const settled = sessions.filter((s) => s.state === "idle");
    return settled.length;
  }, { timeout: 60_000 }).toBe(expectTotal);
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  expect(response.ok, "the daemon accepted the Board layout").toBe(true);
  // A RELOAD, not a hash navigation: the web store hydrates from `GET /api/ui/config` at boot
  // and paints from its `localStorage` mirror before that lands, so a preference written out of
  // band only takes on the next load.
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

const leaf = (path: string): string => path.replace(/\/+$/, "").split("/").pop()!;

test("the Board groups cards by repository out of the box, and a heading folds its group", async ({
  dashboard,
  daemon,
}) => {
  const first = leaf(daemon.repo);
  const second = leaf(daemon.secondRepo);

  await dispatchInto(dashboard, daemon, daemon.repo, "live in the first repo", 1);
  await dispatchInto(dashboard, daemon, daemon.secondRepo, "live in the second repo", 2);
  await useBoardLayout(dashboard, daemon);

  const board = dashboard.locator("main.board");
  await expect(board.locator(".tile")).toHaveCount(2);

  // ON, with nobody having opened Settings. Two repositories, two frames.
  const frames = board.locator(".board-repo");
  await expect(frames).toHaveCount(2);

  // Each heading names its repository's DIRECTORY name, not its path. Selected by accessible
  // name, which is also the assertion that the control announces which repository it governs.
  //
  const firstHead = dashboard.getByRole("button", { name: new RegExp(`Collapse ${first}\\b`) });
  const secondHead = dashboard.getByRole("button", { name: new RegExp(`Collapse ${second}\\b`) });
  await expect(firstHead).toBeVisible();
  await expect(secondHead).toBeVisible();

  // A frame is identified by the repository it NAMES, not by its head's accessible name: that
  // name carries the action, so it flips to "Expand …" the moment the group folds and a locator
  // built on it would stop matching exactly when the fold is being asserted.
  //
  // The inner locator is rooted at the PAGE, because `filter({ has })` re-queries it against each
  // candidate frame - one carrying a `main.board` prefix would be looking for the board inside
  // the frame.
  const frameFor = (name: string) =>
    frames.filter({
      has: dashboard.locator(".board-repo-head .bch-title", { hasText: new RegExp(`^${name}$`) }),
    });
  await expect(firstHead.locator(".bch-title")).toHaveText(first);
  await expect(firstHead.locator(".bch-title")).not.toContainText("/");
  // One session each, all of them in this column, so the count says `1 agent` rather than
  // inviting anyone to go looking for the other zero.
  await expect(firstHead.locator(".bch-meta")).toHaveText("1 agent");

  // Containment, which is the claim a frame actually makes. The card dispatched into the first
  // repository is inside the first repository's frame - and not inside the other one.
  const firstFrame = frameFor(first);
  const secondFrame = frameFor(second);
  await expect(firstFrame.locator(".tile-goal")).toHaveText("live in the first repo");
  await expect(secondFrame.locator(".tile-goal")).toHaveText("live in the second repo");
  await expect(firstFrame.locator(".tile")).toHaveCount(1);

  // The colour reaches the frame, and the stylesheet actually CONSUMES it. Both halves matter: a
  // `--repo-c` present inline but never read would leave every frame the same neutral grey, and
  // a `border-color` that happened to look tinted proves nothing on its own.
  //
  // Deliberately NOT "the two frames are different colours". The palette has seven entries and
  // these two roots are temp directories with a fresh random segment every run, so two of them
  // landing on one entry is an ordinary outcome rather than a bug - asserting otherwise is a
  // spec that fails one run in seven. Which root gets which entry, and that the entries are
  // distinct and exhaustive, is settled deterministically in `test/repo-color.test.ts`.
  for (const name of [first, second]) {
    expect(
      await frameFor(name).evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--repo-c").trim(),
      ),
      `${name}'s frame carries a palette colour`,
    ).toMatch(/^#[0-9a-f]{6}$/i);
  }
  const before = await firstFrame.evaluate((el) => getComputedStyle(el).borderTopColor);
  const after = await firstFrame.evaluate((el) => {
    (el as HTMLElement).style.setProperty("--repo-c", "#ff00ff");
    return getComputedStyle(el).borderTopColor;
  });
  expect(after, "the frame's border is mixed from --repo-c").not.toBe(before);
  await firstFrame.evaluate((el) => (el as HTMLElement).style.removeProperty("--repo-c"));

  // Fold. The heading stays - it is how you get the group back - and its cards go.
  await firstHead.click();
  await expect(firstFrame.locator(".tile")).toHaveCount(0);
  await expect(firstFrame).toHaveClass(/is-collapsed/);
  // The OTHER repository is untouched, which is what keying collapse per frame buys: folding one
  // group must never fold a sibling.
  await expect(secondFrame.locator(".tile")).toHaveCount(1);

  // And back. The label flips with the state, so the control says what it will do next.
  const expandFirst = board.getByRole("button", { name: new RegExp(`Expand ${first}\\b`) });
  await expect(expandFirst).toBeVisible();
  await expandFirst.click();
  await expect(firstFrame.locator(".tile")).toHaveCount(1);
});

test("unchecking Group by repository returns the column to one flat list", async ({
  dashboard,
  daemon,
}) => {
  await dispatchInto(dashboard, daemon, daemon.repo, "first flat card", 1);
  await dispatchInto(dashboard, daemon, daemon.secondRepo, "second flat card", 2);
  await useBoardLayout(dashboard, daemon);

  const board = dashboard.locator("main.board");
  await expect(board.locator(".board-repo")).toHaveCount(2);

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const toggle = dashboard.getByRole("checkbox", { name: "Group by repository", exact: true });
  // Checked on a profile that has never touched it, which is the setting's half of the
  // shipped-on claim - the board's half is the test above.
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await expect(board.locator(".board-repo")).toHaveCount(0);
  // Every card still on the board. A grouping that dropped a session when switched off would be
  // a worse defect than one that never grouped.
  await expect(board.locator(".tile")).toHaveCount(2);
  await expect(board.locator(".tile-goal", { hasText: "first flat card" })).toBeVisible();
  await expect(board.locator(".tile-goal", { hasText: "second flat card" })).toBeVisible();
});

test("the arrow keys skip a collapsed repository instead of vanishing into it", async ({
  dashboard,
  daemon,
}) => {
  // The consequence of collapse being a VIEW's state while the arrow keys walk the ORDERING.
  // Fold a group and its cards leave the DOM, but nothing had told navigation that - so the
  // cursor stepped into rows nobody can see: no tile drew as selected, the scroll-into-view had
  // no element to reach, and Enter would have opened a session that was not on screen.
  //
  // Asserted through the keyboard rather than over the ordering, because the divergence only
  // exists between the two and a unit test on either half would have passed.
  await dispatchInto(dashboard, daemon, daemon.secondRepo, "aaa first alphabetically", 1);
  await dispatchInto(dashboard, daemon, daemon.repo, "mmm second", 2);
  await dispatchInto(dashboard, daemon, daemon.repo, "zzz third", 3);
  await useBoardLayout(dashboard, daemon);

  const board = dashboard.locator("main.board");
  await expect(board.locator(".board-repo")).toHaveCount(2);
  await expect(board.locator(".tile")).toHaveCount(3);

  // Fold the frame holding the alphabetically FIRST card, which is the one an arrow press from
  // nothing would otherwise land on.
  const firstLeaf = leaf(daemon.secondRepo);
  await dashboard.getByRole("button", { name: new RegExp(`Collapse ${firstLeaf}\\b`) }).click();
  await expect(board.locator(".tile")).toHaveCount(2);

  // One press from no selection: the cursor must land on a card that is actually drawn.
  await dashboard.locator("main.board").click({ position: { x: 4, y: 4 } });
  await dashboard.keyboard.press("ArrowDown");
  const selected = board.locator(".tile.selected");
  await expect(selected).toHaveCount(1);

  // And walking the whole column never selects nothing, which is what stepping through the
  // folded rows looked like.
  for (let press = 0; press < 4; press += 1) {
    await dashboard.keyboard.press("ArrowDown");
    await expect(selected).toHaveCount(1);
  }
  // Every stop was one of the two visible cards, never a folded one.
  await expect(selected.locator(".tile-goal")).not.toHaveText("aaa first alphabetically");
});
