import { mkdirSync } from "node:fs";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * The panel answers its own question in place: the preview card redraws as items are
 * toggled, without leaving Settings.
 *
 * That is the whole argument for the preview existing. A checklist of eleven consequences
 * is a list of promises; the card beside it is the promise kept, before the operator has to
 * navigate to the Board to find out what they traded.
 *
 * Two things are being proved that no lower layer can. The card redraws IN PLACE - the same
 * click that stores the preference repaints the card two hundred pixels away, with no
 * reload - and the card is INERT: the session behind it does not exist, so nothing in it may
 * navigate, dispatch or take focus.
 *
 * No agent is dispatched, so no binary runs and no tokens are spent - this is the settings
 * page and a daemon.
 */

const EVIDENCE = artifactsDir("board-card-preview");

test("the preview redraws as items are toggled, and never navigates", async ({
  page,
  daemon,
}) => {
  // Tall enough for the whole panel to be on screen at once. The checklist is fifteen rows
  // of label-over-prose across two sections, beside a sticky card, and a screenshot of it
  // taken across a scroll is stitched rather than photographed - which is not what a frame
  // meant for pixel review should be.
  await page.setViewportSize({ width: 1500, height: 1860 });

  // The preview's workflow panel is drawn from a run SUMMARY, and there is no run behind
  // it. Recorded from before the navigation, because the failure this guards against is a
  // request the page fires on mount: a preview that asked the daemon for its fixture run
  // would 404 on every visit to Settings to arrive at exactly the placeholder it draws
  // anyway.
  const runReads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/workflow-runs/")) runReads.push(request.url());
  });

  await page.goto(`${daemon.baseURL}/#/settings/display`);

  const panel = page.locator('[data-anchor="display/board-card"]');
  await expect(panel).toBeVisible();
  const card = panel.locator(".board-card-preview-stage .tile");
  await expect(card).toBeVisible();

  // Every registry item has a reachable checkbox, and the LAST one is reachable too - the
  // panel is the tallest thing in Display and its final row is the one a layout mistake
  // would push off the end of the section rather than merely below the fold. Seventeen now:
  // fifteen card items - including both compact progress meters, the jump shortcut, and the
  // workflow-details switch - and the console band's two, which share this panel rather
  // than a second one.
  await expect(panel.getByRole("checkbox")).toHaveCount(17);
  await expect(panel.getByRole("checkbox", { name: "Git branch", exact: true }))
    .toBeVisible();
  // Both sections name themselves, which is what tells the card's "Branch" apart from the
  // console band's "Git branch" three rows below it.
  await expect(panel.getByRole("heading", { name: "Board card" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Conversation header" })).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: "Last seen", exact: true }))
    .toBeVisible();

  // The fixture populates every item, which is what makes each checkbox visibly do
  // something. These three stand in for the rest and are the ones with the least in common:
  // a wrapped line of prose, a chip on the runtime row, and a cell in the foot.
  await expect(card.locator(".tile-goal")).toBeVisible();
  await expect(card.locator(".rt-model")).toBeVisible();
  await expect(card.locator(".tile-branch")).toBeVisible();
  // ...and the one item that ships off, which the preview reports honestly rather than
  // showing the operator a card they do not have.
  await expect(card.locator(".tile-worktree")).toHaveCount(0);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(EVIDENCE, { recursive: true });
    await page.mouse.move(0, 0);
    await panel.screenshot({ path: `${EVIDENCE}01-defaults.png` });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/board-card-preview/01-defaults.png");

    // And the conversation section on its own, large enough to read. The whole-panel frame
    // above proves the two sections sit together; this one is where a reviewer can actually
    // read the sentence that says the reclaimed height is CONDITIONAL, which is the claim
    // the copy is carrying. Clipped from the section heading to the last row of the section
    // rather than screenshotting an element, because the heading, the blurb and the two rows
    // are siblings in the checklist rather than one container.
    const heading = panel.getByRole("heading", { name: "Conversation header" });
    const lastRow = panel.getByRole("checkbox", { name: "Git branch", exact: true });
    const top = await heading.boundingBox();
    const bottom = await lastRow.boundingBox();
    const column = await panel.locator(".board-card-checklist").boundingBox();
    if (top && bottom && column) {
      await page.screenshot({
        path: `${EVIDENCE}03-conversation-header-section.png`,
        clip: {
          x: column.x - 4,
          y: top.y - 10,
          width: column.width + 8,
          // Past the last checkbox's own row, so its wrapped description is in frame too.
          height: bottom.y + 64 - top.y,
        },
      });
      // eslint-disable-next-line no-console
      console.log("CAPTURED e2e/.artifacts/board-card-preview/03-conversation-header-section.png");
    }
  }

  // In place: no navigation, no reload. The URL is checked after each toggle because the
  // preview mounts a real tile whose open button is a real control - if it were reachable,
  // this is where it would show.
  const before = page.url();
  await panel.getByRole("checkbox", { name: "Goal", exact: true }).uncheck();
  await expect(card.locator(".tile-goal")).toHaveCount(0);
  await expect(card.locator(".rt-model")).toBeVisible();
  expect(page.url()).toBe(before);

  await panel.getByRole("checkbox", { name: "Model", exact: true }).uncheck();
  await expect(card.locator(".rt-model")).toHaveCount(0);

  await panel.getByRole("checkbox", { name: "Worktree", exact: true }).check();
  await expect(card.locator(".tile-worktree")).toBeVisible();
  await expect(card.locator(".tile-worktree")).toHaveText("parser-fix");
  expect(page.url()).toBe(before);

  if (process.env.MC_E2E_EVIDENCE === "1") {
    await page.mouse.move(0, 0);
    await panel.screenshot({ path: `${EVIDENCE}02-toggled.png` });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/board-card-preview/02-toggled.png");
  }

  // And back, which is the half that proves the checkbox is a preference rather than a
  // one-way trim.
  await panel.getByRole("checkbox", { name: "Goal", exact: true }).check();
  await expect(card.locator(".tile-goal")).toBeVisible();

  // The workflow panel drew - name, version, round and its disclosure control - and asked
  // the daemon for nothing at any point in all of that.
  await expect(card.locator(".tile-workflow-disclosure")).toBeVisible();
  await expect(card.locator(".wf-tile-peek-name")).toContainText("No-Mistakes Review");
  expect(runReads, "the preview fetched a workflow run that does not exist").toEqual([]);
});

test("the preview card cannot be clicked, tabbed into, or opened", async ({ page, daemon }) => {
  await page.goto(`${daemon.baseURL}/#/settings/display`);
  const stage = page.locator(".board-card-preview-stage");
  await expect(stage).toBeVisible();

  // `inert` takes the whole subtree out of the accessibility tree and out of hit-testing,
  // which is exactly the claim: the tile's stretched open button, its permission-mode
  // picker and its workflow disclosure are all real controls aimed at a session that does
  // not exist.
  await expect(stage).toHaveAttribute("inert", "");
  // The controls are still IN the markup - the preview is the real tile, so of course they
  // are - and the claim is that none of them can be reached. Focus is the sharpest form of
  // that: `inert` makes every descendant unfocusable, so a `.focus()` on the tile's own
  // open button leaves the document's focus exactly where it was.
  const openButton = stage.locator(".tile-open");
  await expect(openButton).toHaveCount(1);
  const tookFocus = await openButton.evaluate((node: HTMLElement) => {
    node.focus();
    return document.activeElement === node;
  });
  expect(tookFocus, "a control inside the preview took focus").toBe(false);

  const before = page.url();
  // `force`, because the point is that the click LANDS on the element and still does
  // nothing - an ordinary click would be refused by actionability checks and prove less.
  await stage.locator(".tile").click({ force: true, position: { x: 20, y: 20 } });
  expect(page.url()).toBe(before);
  await expect(page.locator("main.board")).toHaveCount(0);
  await expect(page.locator(".console-detail")).toHaveCount(0);

  // Nothing inside can take focus either, so a keyboard walk through Settings does not
  // wander into a card that is a picture.
  const focusedInside = await stage.evaluate(
    (node) => node.contains(document.activeElement) && node !== document.activeElement,
  );
  expect(focusedInside).toBe(false);
});
