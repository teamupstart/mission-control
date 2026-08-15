import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * The three settings ledgers - Inspector, Shipping, Foreman - as one table with one set of
 * bounds, driven the way an operator meets them.
 *
 * What was wrong. All three panels are drawn from `settings-console.tsx`, which handed out
 * `.sc-row`, `.sc-when` and the rest and left each panel to assemble its own table around
 * them. So the three drifted in the one dimension a shared class name says nothing about:
 * how much of a list they are willing to put on screen. Foreman grew a height budget when
 * its ledger reached its 100-row cap. Inspector and Shipping reached their 50 and grew
 * nothing, so the settings page ran on for a screen and a half of pull requests beside a
 * control column a quarter of their height - and the count strip, which IS the filter,
 * left the viewport on the first flick. The one control for shortening the list was
 * reachable only from a position where the list could not be read.
 *
 * What only this layer can prove. `settings-console.test.ts` pins the fold (`consolePage`)
 * and the rendered shape of one page, and it cannot measure a scroller or press a button:
 * `renderToStaticMarkup` produces a string with no layout in it, so "the rows scroll inside
 * the table" and "Older shows the next 25" are both invisible to it. Only a browser can
 * see that the table is shorter than its contents, that the page below it stayed reachable,
 * and that paging keeps the strip and the heading where they were.
 *
 * Rows are seeded straight into the isolated fixture database rather than adopted through a
 * hook per pull request: this spec is about the READ path, and 60 dispatched sessions would
 * spend a minute of subprocess time manufacturing fixture data that says nothing more than
 * 60 INSERTs do. `ship-log.spec.ts` covers the adoption path itself.
 *
 * No model tokens: nothing here dispatches an agent at all.
 */

const EVIDENCE = artifactsDir("settings-ledger");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like the Ship log's and the palette's: an ordinary run would
 * rewrite the binaries for no added signal. Inside the regression tests rather than in a
 * staged capture spec, because the point of the picture is that the assertions around it
 * passed on the same run.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // A window the ledger fits in whole, so the picture shows the pager where it lives -
  // under the rows, inside the table's border. The assertions above already ran at the
  // suite's own 1280x720, which is the size that has to hold.
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Off every control first, pointer AND focus: `Tooltip` shows on either, so the button
  // that was last clicked keeps its bubble open until something takes the focus away.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => window.scrollTo(0, 0));
  // The viewport, not `fullPage`: the topbar and the settings rail are fixed, and a
  // full-page capture paints them again halfway down the image.
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-ledger/${name}.png`);
}

/** How many rows a page holds. Mirrors `CONSOLE_PAGE_SIZE`, which the browser cannot import. */
const PAGE = 25;

/**
 * More pull requests than the panel's read returns, on purpose.
 *
 * `/api/inspector/prs` serves the 50 most recently reviewed, so seeding 60 proves the two
 * caps are different things: the route bounds what the panel KNOWS, and the pager bounds
 * what it SHOWS. The readout below therefore says "of 50" over a 60-row table, which is the
 * honest number - it is a count of the list on this screen, not of the database.
 */
const SEEDED = 60;

/** The 50 the route will actually return, as two full pages. */
const SERVED = 50;

/**
 * Seed adopted pull requests, newest reviewed first.
 *
 * `last_reviewed_at` descends with the index because that is the column the panel's read
 * orders by, so row 0 is the top of the table and the assertions below can name a specific
 * row rather than "some row".
 */
function seedPullRequests(daemon: DaemonHandle, count: number): void {
  withDaemonDb(daemon, (db) => {
    const insert = db.prepare(
      `INSERT INTO inspector_prs
         (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
          head_sha, round, last_reviewed_at, merged_at, adopted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'hook', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const base = 1_700_000_000_000;
    for (let i = 0; i < count; i += 1) {
      const number = 1000 + i;
      // Half merged, half still open, so both panels have more than one bucket to filter by
      // and the Shipping ledger is not one word repeated 50 times.
      const merged = i % 2 === 0;
      insert.run(
        `owner/repo#${number}`,
        `https://github.example/owner/repo/pull/${number}`,
        "owner",
        "repo",
        number,
        "/repo",
        "/repo",
        merged ? "closed" : "open",
        `sha${i}`,
        1,
        base - i * 60_000,
        merged ? base - i * 60_000 : null,
        base - i * 60_000,
        base - i * 60_000,
      );
    }
  });
}

/** The ledger column of a settings panel, once the daemon's first poll has filled it. */
async function openLedger(page: Page, daemon: DaemonHandle, category: string): Promise<Locator> {
  await page.goto(`${daemon.baseURL}/#/settings/${category}`);
  const ledger = page.locator(".sc-ledger");
  // Waiting for a ROW, not for the heading: the heading renders over an empty table, and a
  // spec that measured the scroller before the poll landed would read zero overflow and
  // call a missing height budget fine.
  await expect(ledger.locator(".sc-scroll .sc-row").first()).toBeVisible();
  return ledger;
}

const rows = (ledger: Locator) => ledger.locator(".sc-scroll .sc-row");
const range = (ledger: Locator) => ledger.locator(".sc-pager-range");
const older = (ledger: Locator) => ledger.getByRole("button", { name: "Older" });
const newer = (ledger: Locator) => ledger.getByRole("button", { name: "Newer" });

test("the Inspector's ledger shows one page and walks the rest of it", async ({
  page,
  daemon,
}) => {
  seedPullRequests(daemon, SEEDED);
  const ledger = await openLedger(page, daemon, "inspector");

  await expect(rows(ledger)).toHaveCount(PAGE);
  await expect(range(ledger)).toHaveText(`1-${PAGE} of ${SERVED}`);
  // The newest row is on the first page and the oldest served one is not - which is what
  // makes "Newer" and "Older" the right words for these two buttons rather than "previous"
  // and "next", a direction a reader can check against the last column.
  await expect(ledger.getByRole("link", { name: "repo#1000" })).toBeVisible();
  await expect(ledger.getByRole("link", { name: `repo#${1000 + SERVED - 1}` })).toBeHidden();

  // On the first page there is nowhere newer to go, and the control says so by being
  // visibly unavailable rather than by disappearing from under the cursor.
  await expect(newer(ledger)).toBeDisabled();
  await expect(older(ledger)).toBeEnabled();

  await older(ledger).click();
  await expect(range(ledger)).toHaveText(`${PAGE + 1}-${SERVED} of ${SERVED}`);
  await expect(rows(ledger)).toHaveCount(PAGE);
  await expect(ledger.getByRole("link", { name: `repo#${1000 + SERVED - 1}` })).toBeVisible();
  await expect(ledger.getByRole("link", { name: "repo#1000" })).toBeHidden();
  // The route serves 50 of the 60 seeded rows, so the last page is the last page: the pager
  // counts the list it is showing, and does not claim to reach the whole database.
  await expect(older(ledger)).toBeDisabled();

  await newer(ledger).click();
  await expect(range(ledger)).toHaveText(`1-${PAGE} of ${SERVED}`);
  await expect(ledger.getByRole("link", { name: "repo#1000" })).toBeVisible();
  await shoot(page, "inspector");
});

test("paging from the keyboard keeps the focus on a control that can still act", async ({
  page,
  daemon,
}) => {
  seedPullRequests(daemon, SEEDED);
  const ledger = await openLedger(page, daemon, "inspector");

  // Two pages is the ordinary case for a 50-row ledger, and it is the one that breaks: the
  // press that reaches the last page disables the button under the finger in the same
  // commit, and a browser blurs a control that becomes disabled. Without the hand-off the
  // reader is returned to the top of the document, on the screen whose whole point is not
  // losing your place in a long list.
  await older(ledger).focus();
  await page.keyboard.press("Enter");
  await expect(range(ledger)).toHaveText(`${PAGE + 1}-${SERVED} of ${SERVED}`);
  await expect(older(ledger)).toBeDisabled();
  await expect(newer(ledger)).toBeFocused();

  // And back the other way, which lands on the first page and kills Newer.
  await page.keyboard.press("Enter");
  await expect(range(ledger)).toHaveText(`1-${PAGE} of ${SERVED}`);
  await expect(older(ledger)).toBeFocused();
});

test("picking a filter opens the new list at its top, not at the last offset", async ({
  page,
  daemon,
}) => {
  // The pager's own reset was written first and covered only the pager, so a filter change -
  // the OTHER way this list gets replaced - reset the page to 1 and left the scroller where it
  // was. The reader lands in the middle of a list they have not seen the top of, and if the
  // filtered list is shorter the browser clamps to its new maximum and opens them at its END.
  seedPullRequests(daemon, SEEDED);
  const ledger = await openLedger(page, daemon, "inspector");
  const scroller = ledger.locator(".sc-scroll");

  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(
    await scroller.evaluate((el) => el.scrollTop),
    "the fixture has to be able to fail - these rows are not scrolling",
  ).toBeGreaterThan(0);

  // A different list of the same length, so a preserved offset stays genuinely non-zero
  // rather than being clamped to 0 by a list too short to scroll. That would pass either way.
  await ledger.getByRole("button", { name: /retired/ }).click();
  await expect(rows(ledger)).toHaveCount(PAGE);
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBe(0);

  // And the way back out of the filter is a replaced list too.
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await ledger.getByRole("button", { name: /show all/ }).click();
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBe(0);
});

test("filtering the ledger starts the new list at its first page", async ({ page, daemon }) => {
  seedPullRequests(daemon, SEEDED);
  const ledger = await openLedger(page, daemon, "inspector");

  await older(ledger).click();
  await expect(range(ledger)).toHaveText(`${PAGE + 1}-${SERVED} of ${SERVED}`);

  // The strip is the filter, and clicking a tile is a new list - 25 retired rows here,
  // which is one page. Left on page 2 this table would be empty with rows in it, which
  // reads exactly like the ledger having broken.
  await ledger.getByRole("button", { name: /retired/ }).click();
  await expect(rows(ledger)).not.toHaveCount(0);
  // Half the seeded rows are closed, so the filtered list is 25 - one page, and the pager
  // is gone rather than present with two dead buttons over a list already shown whole.
  await expect(ledger.locator(".sc-pager")).toHaveCount(0);
  await expect(rows(ledger)).toHaveCount(PAGE);

  // And back: the way out of a filter is the tile's own chip, and it returns two pages.
  await ledger.getByRole("button", { name: /show all/ }).click();
  await expect(range(ledger)).toHaveText(`1-${PAGE} of ${SERVED}`);
});

test("every ledger bounds its own height, leaving the strip and the page reachable", async ({
  page,
  daemon,
}) => {
  seedPullRequests(daemon, SEEDED);

  // Inspector and Shipping are the two that had no budget at all. Foreman's is pinned by
  // `foreman-decision-ledger.spec.ts`, which is where its ledger's own claims live - it is
  // the panel this shape was taken FROM, and the one that already measured it.
  for (const category of ["inspector", "shipping"] as const) {
    const ledger = await openLedger(page, daemon, category);
    const scroller = ledger.locator(".sc-scroll");

    // The scroller is genuinely shorter than its contents. Without the budget these two are
    // equal and the settings page absorbs the difference.
    const overflow = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(overflow, `${category} rows are not scrolling inside the table`).toBeGreaterThan(100);

    // The page itself stays a readable length rather than growing to fit the table.
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(pageOverflow, `${category} settings page still grows with the ledger`).toBeLessThan(
      2_000,
    );

    // The specific thing that was unreachable: the strip is the only control for making
    // this list shorter, and it survives a scroll to the bottom of the rows.
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(ledger.locator(".sc-strip")).toBeInViewport();
    await expect(ledger.getByRole("heading", { name: /Inspections|Merge queue/ })).toBeInViewport();

    // The budget is on the TABLE, not on the rows alone, and this is the difference: the
    // pager ends inside the table's own border rather than below it. Bounding only
    // `.sc-scroll` made the table 62vh PLUS its heading, column names and pager, which put
    // the pager under the fold on a short window - the one place it must not be, because
    // `overscroll-behavior: contain` means the reader who has just scrolled to the end of
    // the rows cannot reach it by carrying on scrolling.
    const table = (await ledger.locator(".sc-table").boundingBox())!;
    const pager = (await ledger.locator(".sc-pager").boundingBox())!;
    expect(
      Math.round(pager.y + pager.height),
      `${category} pager hangs outside its table`,
    ).toBeLessThanOrEqual(Math.round(table.y + table.height));

    // And the table stays a share of the window rather than growing with the ledger, so
    // the controls beside it and the caption under it are still reachable.
    const viewport = page.viewportSize()!.height;
    expect(table.height, `${category} ledger claims too much of the window`).toBeLessThan(
      viewport * 0.65,
    );
  }
});

test("paging returns to the top of the rows rather than keeping the last offset", async ({
  page,
  daemon,
}) => {
  seedPullRequests(daemon, SEEDED);
  const ledger = await openLedger(page, daemon, "shipping");
  const scroller = ledger.locator(".sc-scroll");

  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // A scroller keeps its offset across a re-render, so without the reset the older page
  // opens in its middle - which reads as rows having been skipped.
  await older(ledger).click();
  await expect(range(ledger)).toHaveText(`${PAGE + 1}-${SERVED} of ${SERVED}`);
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop))
    .toBe(0);
  await shoot(page, "shipping");
});

/**
 * Seed Foreman decisions, newest first - enough of them to need a second page.
 *
 * Only the columns this ledger renders are worth setting; `foreman-decision-ledger.spec.ts`
 * seeds the same table with real per-row variety, because that spec is about what a row
 * SAYS. This one is about the table around it.
 */
function seedEpisodes(daemon: DaemonHandle, count: number): void {
  withDaemonDb(daemon, (db) => {
    const insert = db.prepare(
      `INSERT INTO foreman_episodes
         (note_key, session_id, marker, situation, surface, question, pane, purpose, brief,
          classification, tier, triage_reason, skip_reason, disposition, last_action,
          created_at, resolved_at, resolved_by)
       VALUES (?, 'sdk:seed', ?, 'terminal-pane', 'terminal', 'Needs approval: Bash', ?, ?, ?,
               'access', 2, 'routine-access', NULL, 'answered', NULL, ?, ?, 'foreman')`,
    );
    const base = 1_700_000_000_000;
    for (let i = 0; i < count; i += 1) {
      insert.run(
        `3f2a91cc-0d44-4d1e-9f1a-${String(i).padStart(12, "0")}`,
        `m-${i}`,
        "❯ 1. Yes\n  2. No",
        `Decision number ${i} in a long run of them.`,
        "Routine read-only access.",
        base - i * 60_000,
        base - i * 60_000,
      );
    }
  });
}

test("the Foreman ledger pages by the same rules, in the same words", async ({ page, daemon }) => {
  // The panel this shape was taken from. It is in this spec because "these three agree" is
  // the claim being made, and a spec that only covered the two that were broken would pass
  // the day the reference implementation is the one that drifts.
  seedEpisodes(daemon, 30);
  const ledger = await openLedger(page, daemon, "foreman");

  await expect(rows(ledger)).toHaveCount(PAGE);
  await expect(range(ledger)).toHaveText(`1-${PAGE} of 30`);
  await expect(newer(ledger)).toBeDisabled();

  await older(ledger).click();
  await expect(range(ledger)).toHaveText(`${PAGE + 1}-30 of 30`);
  await expect(rows(ledger)).toHaveCount(5);
  await expect(older(ledger)).toBeDisabled();
  await shoot(page, "foreman");
});
