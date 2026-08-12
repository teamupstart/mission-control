import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The operator's way out of a finding nothing else can close.
 *
 * A finding the Inspector raised is resolved in exactly one place - `closeRow`, reached only
 * when a REVIEW ROUND lists its fingerprint as resolved. A round returns early once it has
 * already reviewed the head, so a finding whose fix was pushed and reviewed once, and which
 * the model then simply never mentions again, has no round left to close it. It held
 * `mergeBlock: findings` for the life of the pull request, and PR #494 had to be merged by
 * hand because of it.
 *
 * `test/inspector-finding-resolution.test.ts` proves the loop end to end - that the block
 * survives every sweep until the row is resolved, and that the pull request then lands on the
 * next one - and `test/http-integration.test.ts` proves the route's own contract. Neither can
 * tell you whether an operator can actually REACH any of it: whether the ledger row offers a
 * control at all, whether it is offered only on the rows it makes sense for, or whether
 * pressing it changes what the panel then says. That is this spec's subject, and this is the
 * only layer that can see it.
 *
 * No model tokens: nothing here dispatches an agent, and the ledger rows are seeded directly.
 */

const EVIDENCE = artifactsDir("inspector-resolve-findings");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like the Ship log's and the palette's captures: an ordinary run
 * would rewrite the binaries for no added signal.
 */
async function shoot(page: Page, name: string, region?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and this
  // panel is a table of adjacent buttons.
  await page.mouse.move(0, 0);
  // Scoped to a region when the claim is about one, which is what makes the fold frame
  // readable: a whole 420px page is mostly the control column above the table it is about.
  await (region ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/inspector-resolve-findings/${name}.png`);
}

interface SeedRow {
  number: number;
  /** How many findings are still counted open on it. */
  open: number;
  state?: "open" | "closed";
}

/**
 * Seed adopted pull requests and their findings.
 *
 * Written straight to the ledger, because the only thing that mints a finding is a completed
 * review round - a model call this suite must never make. It is the same lever
 * `ship-log.spec.ts` uses to stand in for what a poll observed, and WAL is on, so a second
 * writer here is safe. Everything downstream of the seed is real: the route the click
 * reaches, the daemon that serves it, and the re-read the panel draws from.
 */
function seedLedger(daemon: DaemonHandle, rows: SeedRow[]): void {
  const db = new DatabaseSync(join(daemon.home, "harness.db"));
  const now = Date.now();
  try {
    for (const row of rows) {
      db.prepare(
        `INSERT INTO inspector_prs
           (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
            head_sha, review_posture, round, last_reviewed_at, fail_count, merge_block,
            adopted_at, updated_at)
         VALUES (?, ?, 'owner', 'repo', ?, '/repo', '/repo', NULL, 'hook', ?,
                 'head-1', 'live', 5, ?, 0, ?, ?, ?)`,
      ).run(
        `owner/repo#${row.number}`,
        `https://github.example/owner/repo/pull/${row.number}`,
        row.number,
        row.state ?? "open",
        now,
        row.open > 0 ? "findings" : null,
        now,
        now,
      );
      for (let i = 0; i < row.open; i++) {
        db.prepare(
          `INSERT INTO inspector_comments
             (id, pr_key, fingerprint, path, line, title, body, severity, round, status,
              replies, answered_comment_id, created_at, updated_at)
           VALUES (?, ?, ?, 'src/example.ts', 1, ?, 'detail', 'major', 4, 'open', 0, NULL, ?, ?)`,
        ).run(
          `id-${row.number}-${i}`,
          `owner/repo#${row.number}`,
          `fp-${row.number}-${i}`,
          `Finding ${i + 1} on #${row.number}`,
          now,
          now,
        );
      }
    }
  } finally {
    db.close();
  }
}

const ledgerRow = (page: Page, name: string) =>
  page.locator(".sc-row").filter({ hasText: name });

const resolveButton = (page: Page, number: number) =>
  page.getByRole("button", { name: `Resolve the Inspector's findings on repo#${number}` });

test("an operator resolves a stuck finding from the Inspector ledger", async ({
  dashboard,
  daemon,
}) => {
  seedLedger(daemon, [{ number: 494, open: 2 }]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);

  // The row says what it is carrying, in words, before anything is pressed.
  const row = ledgerRow(dashboard, "repo#494");
  await expect(row).toBeVisible();
  await expect(row).toContainText("2 findings");
  await shoot(dashboard, "inspector-findings-stuck");

  // The control is named for the pull request it acts on, so a table of them stays
  // unambiguous to anyone reading it by its accessible name.
  const resolve = resolveButton(dashboard, 494);
  await expect(resolve).toBeVisible();
  await resolve.click();

  // The count is not optimistic: it changes when the daemon has agreed, because a finding
  // count is evidence about a public pull request rather than the state of a local control.
  await expect(row).toContainText("clean");
  // "closed", not "fixed": an operator resolving a finding is not evidence a push fixed it,
  // and the ledger stores one `resolved` status for all three routes without recording which.
  await expect(row).toContainText("2 closed");
  await expect(row).not.toContainText("2 fixed");
  // And the control retires with the state it was for - there is nothing left to resolve.
  await expect(resolve).toHaveCount(0);
  await shoot(dashboard, "inspector-findings-resolved");

  // It reached the daemon rather than only the DOM: a reload re-reads the ledger.
  await dashboard.reload();
  await expect(ledgerRow(dashboard, "repo#494")).toContainText("clean");
});

test("the resolve control is offered only where there is something to resolve", async ({
  dashboard,
  daemon,
}) => {
  seedLedger(daemon, [
    { number: 495, open: 1 },
    // Reviewed clean - nothing to resolve, so nothing to press.
    { number: 496, open: 0 },
    // Closed and still carrying findings. Out of the sweep for good, so resolving it would
    // change nothing anyone can see while quietly rewriting the record of what the Inspector
    // said about something that has already landed.
    { number: 497, open: 1, state: "closed" },
  ]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);

  await expect(ledgerRow(dashboard, "repo#495")).toContainText("1 finding");
  await expect(resolveButton(dashboard, 495)).toBeVisible();

  await expect(ledgerRow(dashboard, "repo#496")).toContainText("clean");
  await expect(resolveButton(dashboard, 496)).toHaveCount(0);

  await expect(ledgerRow(dashboard, "repo#497")).toBeVisible();
  await expect(resolveButton(dashboard, 497)).toHaveCount(0);
});

/**
 * The same control at phone width, where the ledger row folds.
 *
 * The Inspector row's fixed tracks are wider than a narrow viewport, and `.sc-table` CLIPS
 * rather than scrolls - it has to, for its rounded corners - so a cell the fold does not
 * place explicitly is not squeezed, it silently disappears. Adding a fifth column put the
 * one control on this panel that repairs a stuck pull request at exactly that risk.
 *
 * Measured rather than eyeballed: a `toBeVisible()` here proves nothing, because a clipped
 * cell still reports visible. The assertion is that the button's right edge lands inside
 * the table's own box, which is the thing clipping it.
 */
test("the resolve control survives the fold at phone width", async ({ dashboard, daemon }) => {
  seedLedger(daemon, [{ number: 494, open: 1 }]);
  await dashboard.setViewportSize({ width: 420, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);

  const table = dashboard.locator(".sc-table-inspector");
  const resolve = resolveButton(dashboard, 494);
  await expect(resolve).toBeVisible();
  await table.scrollIntoViewIfNeeded();

  const tableBox = (await table.boundingBox())!;
  const buttonBox = (await resolve.boundingBox())!;
  expect(
    buttonBox.x + buttonBox.width,
    "the control must not be clipped out of a table that cannot scroll",
  ).toBeLessThanOrEqual(tableBox.x + tableBox.width);
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(tableBox.y + tableBox.height + 1);
  // On its own line, below the verdict - not squeezed onto a line already at content width.
  const row = ledgerRow(dashboard, "repo#494");
  const verdictBox = (await row.locator(".sc-verdict").boundingBox())!;
  expect(buttonBox.y, "the fold gives it a line of its own").toBeGreaterThanOrEqual(
    verdictBox.y + verdictBox.height,
  );
  // And it spans the row rather than sitting in the first track of it.
  //
  // This is the assertion that pins `grid-column: 1 / -1`, and it is not decoration: the
  // folded grid is `minmax(0, 1fr) auto`, so an auto-placed `.sc-act` lands in track ONE and
  // its `justify-content: flex-end` then right-aligns it to the end of that track - which is
  // short of the row's right edge, leaving the only control on this panel visibly out of
  // line with every other trailing cell. Nothing about that is clipped or invisible, so the
  // checks above hold either way; only comparing it against a cell that IS at the row edge
  // can tell the two apart.
  const whenBox = (await row.locator(".sc-when").boundingBox())!;
  expect(
    Math.abs(buttonBox.x + buttonBox.width - (whenBox.x + whenBox.width)),
    "the control must right-align with the row's other trailing cell, not with track one",
  ).toBeLessThanOrEqual(1);

  await dashboard.mouse.move(0, 0);
  await shoot(dashboard, "inspector-findings-narrow-fold", table);

  // And it still works down here, which is the only reason the cell is worth keeping.
  await resolve.click();
  await expect(ledgerRow(dashboard, "repo#494")).toContainText("clean");
  await expect(resolve).toHaveCount(0);
});
