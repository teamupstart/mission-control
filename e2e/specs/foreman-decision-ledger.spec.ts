import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Foreman decision ledger, driven the way an operator meets it: a settings page opened
 * to ask "what has Foreman been doing, and why?".
 *
 * What only this layer can prove. `renderToStaticMarkup` pins the row's markup shape and
 * `foreman-episode-outcome.test.ts` pins the derivation behind its wording, but neither can
 * see whether a click reaches `/api/foreman/episodes/:id` and brings the captured screen
 * back into the DOM - and that round trip IS the feature. The whole point of the detail
 * route is that the pane is deliberately absent from the list read; a spec that could not
 * distinguish "on the wire" from "on the screen" would pass with the route unwired.
 *
 * Two failures are pinned here, and both were real on a live 833-episode ledger:
 *
 *  1. The table had no height budget. A hundred rows at ~35px is roughly 3,500px of table
 *     beside a control column a quarter of its height, rendered whole into the page's own
 *     scroller - so the count strip, which IS the filter, left the viewport on the first
 *     flick and the only control for shortening the list was reachable only from where you
 *     could not read it.
 *  2. `skipped` was one word for three unrelated events. 235 of 318 skips were the reviewer
 *     being beaten by the clock; 8 of the 12 in the newest hundred were escalations the
 *     operator had closed unanswered. Both read as "Foreman could not understand this".
 *
 * Episodes are seeded straight into the isolated fixture database rather than through
 * `POST /api/sessions/:id/foreman-episode`, which needs a live session per row: this spec is
 * about the READ path, and dispatching agents to manufacture history would spend model-free
 * subprocess time on fixture setup that the node:test layer already covers. The daemon
 * re-reads `foreman_episodes` on every poll, so a seeded row reaches the page the same way
 * a worker-written one does.
 */

/** One seeded decision. Only the fields this ledger renders are worth naming. */
interface SeedEpisode {
  marker: string;
  question: string;
  purpose: string;
  brief: string;
  pane: string;
  classification: string;
  triageReason: string | null;
  disposition: string;
  skipReason: string | null;
  resolvedBy: string | null;
  createdAt: number;
}

function seedEpisodes(daemon: DaemonHandle, episodes: SeedEpisode[]): void {
  const db = new DatabaseSync(join(daemon.home, "harness.db"));
  try {
    const insert = db.prepare(
      `INSERT INTO foreman_episodes
         (note_key, session_id, marker, situation, surface, question, pane, purpose, brief,
          classification, tier, triage_reason, skip_reason, disposition, last_action,
          created_at, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of episodes) {
      insert.run(
        // A UUID-shaped key, so the row renders the 8-character handle the panel truncates
        // to rather than the synthetic `proc:` form.
        `3f2a91cc-0d44-4d1e-9f1a-${e.marker.padStart(12, "0")}`,
        "sdk:seed",
        e.marker,
        "terminal-pane",
        "terminal",
        e.question,
        e.pane,
        e.purpose,
        e.brief,
        e.classification,
        2,
        e.triageReason,
        e.skipReason,
        e.disposition,
        null,
        e.createdAt,
        e.resolvedBy ? e.createdAt : null,
        e.resolvedBy,
      );
    }
  } finally {
    db.close();
  }
}

/**
 * A row per outcome, all sharing one ask.
 *
 * The shared `question` is the point rather than laziness: on a real ledger `Needs approval:
 * Bash` covers 318 rows and `running AskUserQuestion` another 126, so half the table read as
 * one string repeated. If the row still led with the ask, every assertion below would be
 * ambiguous - which is exactly what an operator was up against.
 */
const SEED: SeedEpisode[] = [
  {
    marker: "m-escalated",
    question: "running AskUserQuestion",
    purpose: "Whether to split the merged flake fixes into their own history.",
    brief: "Two policy choices are required, and both are the operator's to make.",
    pane: "❯ 1. Split them out\n  2. Revert and re-land\n  3. Keep them",
    classification: "design-fork",
    triageReason: "needs-judgment",
    disposition: "escalated",
    skipReason: null,
    resolvedBy: null,
    createdAt: 1_700_000_600_000,
  },
  {
    marker: "m-stale",
    question: "running AskUserQuestion",
    purpose: "Whether to restart the live daemon while three sessions are attached.",
    brief: "The reviewer reached an answer and the session moved on first.",
    pane: "❯ 1. Restart now\n  2. Wait for the sessions to drain",
    classification: "implementation",
    triageReason: "low-confidence",
    disposition: "skipped",
    skipReason: "stale",
    resolvedBy: "foreman",
    createdAt: 1_700_000_500_000,
  },
  {
    marker: "m-dismissed",
    question: "running AskUserQuestion",
    purpose: "Whether to overrule the judge and ship the change as it stands.",
    brief: "Escalated to the operator, who closed it without answering.",
    pane: "❯ 1. Ship as-is\n  2. Take another round",
    classification: "design-fork",
    triageReason: "human-only-escalate",
    disposition: "skipped",
    skipReason: null,
    resolvedBy: "you",
    createdAt: 1_700_000_400_000,
  },
  {
    marker: "m-declined",
    question: "running AskUserQuestion",
    purpose: "A plan review the session posted for approval.",
    brief: "Foreman may not approve a review, so it was left alone.",
    pane: "The child posted a plan review",
    classification: "other",
    triageReason: "non-input-review",
    disposition: "skipped",
    skipReason: null,
    resolvedBy: "foreman",
    createdAt: 1_700_000_300_000,
  },
  {
    marker: "m-answered",
    question: "Needs approval: Bash",
    purpose: "Polling GitHub until the pending CI job finishes.",
    brief: "Routine read-only access.",
    pane: "❯ 1. Yes\n  2. No, and tell Claude what to do differently",
    classification: "access",
    triageReason: "routine-access",
    disposition: "answered",
    skipReason: null,
    resolvedBy: "foreman",
    createdAt: 1_700_000_200_000,
  },
];

/**
 * The ledger, with its first seeded row on screen.
 *
 * Waiting for a ROW rather than for the heading is what makes the measurements below
 * honest: the heading renders over an empty table, and a spec that measured the scroller
 * before the 4s poll landed would read zero overflow and call the height budget broken -
 * or, worse, read zero and call a missing budget fine.
 */
async function openLedger(page: import("@playwright/test").Page, daemon: DaemonHandle) {
  await page.goto(`${daemon.baseURL}/#/settings/foreman`);
  const ledger = page.locator(".sc-ledger");
  await expect(ledger.getByRole("heading", { name: "Decisions" })).toBeVisible();
  await expect(ledger.locator(".sc-row-open").first()).toBeVisible();
  return ledger;
}

/**
 * The OUTCOME cell, by its word.
 *
 * Scoped to the cell rather than matched across the ledger, because the count strip above
 * the table uses the same vocabulary - "escalated" names a tile and a row, and they are
 * deliberately the same word for the same pile.
 */
function outcome(ledger: import("@playwright/test").Locator, word: string) {
  return ledger.locator(".sc-verdict", { hasText: new RegExp(`^${word}$`) });
}

test("the ledger names what each decision was FOR, not just what was asked", async ({
  page,
  daemon,
}) => {
  seedEpisodes(daemon, SEED);
  const ledger = await openLedger(page, daemon);

  // Four of the five rows share one ask. The purpose is what tells them apart, and it was
  // already on the wire and spent on a hover before this.
  for (const e of SEED) await expect(ledger.getByText(e.purpose)).toBeVisible();

  // The verbatim ask survives as the recognition cue rather than as the whole row.
  await expect(ledger.getByText("running AskUserQuestion").first()).toBeVisible();
});

test("the three ways into the skipped pile read as three different outcomes", async ({
  page,
  daemon,
}) => {
  seedEpisodes(daemon, SEED);
  const ledger = await openLedger(page, daemon);

  // Every one of these was the single word "skipped" before, in a table whose tile called
  // them "the asks Foreman could not read".
  await expect(outcome(ledger, "stale")).toBeVisible();
  await expect(outcome(ledger, "dismissed")).toBeVisible();
  await expect(outcome(ledger, "declined")).toBeVisible();
  await expect(outcome(ledger, "escalated")).toBeVisible();
  await expect(outcome(ledger, "answered")).toBeVisible();

  // The tile still accounts for all three, so the filter has not been split along with the
  // wording - which is the guarantee the strip makes about its own numbers.
  await ledger.getByRole("button", { name: /left alone/ }).click();
  await expect(outcome(ledger, "stale")).toBeVisible();
  await expect(outcome(ledger, "dismissed")).toBeVisible();
  await expect(outcome(ledger, "declined")).toBeVisible();
  // ...and only those three.
  await expect(ledger.getByText("Polling GitHub until the pending CI job finishes.")).toBeHidden();
});

test("a row says why the ladder landed where it did", async ({ page, daemon }) => {
  seedEpisodes(daemon, SEED);
  const ledger = await openLedger(page, daemon);

  // `needs-judgment` and `low-confidence` are both escalations on the old ledger, and both
  // printed the same word. The router has always computed the difference and logged it.
  //
  // Short labels, because the column is for SCANNING - a run of identical reasons down it is
  // a threshold to tune, and that pattern is invisible when every cell is a clipped sentence.
  const why = ledger.locator(".sc-decided-why");
  await expect(why.filter({ hasText: /^needs judgment$/ })).toBeVisible();
  await expect(why.filter({ hasText: /^low confidence$/ })).toBeVisible();
  await expect(why.filter({ hasText: /^routine access$/ })).toBeVisible();
  await expect(why.filter({ hasText: /^a review$/ })).toBeVisible();

  // The sentence is one hover away, and it names the string that was actually recorded so
  // the label map cannot hide a reason it has no words for. Located on the PAGE rather than
  // in the ledger: `Tooltip` renders its description into a visually-hidden body-level
  // portal, which is what makes the sentence reachable by a screen reader at all rather
  // than only while a pointer happens to be over the cell.
  await expect(
    page.getByText(/below the confidence floor.*recorded as "low-confidence"/),
  ).toBeAttached();
});

test("opening a row fetches the decision and shows the screen it was read on", async ({
  page,
  daemon,
}) => {
  seedEpisodes(daemon, SEED);
  const ledger = await openLedger(page, daemon);

  const row = ledger.getByRole("button", {
    name: /Whether to restart the live daemon while three sessions are attached/,
  });
  await expect(row).toHaveAttribute("aria-expanded", "false");

  // The captured screen is deliberately NOT in the list payload - it was 50.6% of that
  // response on a real database - so its presence here proves the detail route ran.
  await expect(ledger.getByText("Wait for the sessions to drain")).toBeHidden();

  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(ledger.getByText("Wait for the sessions to drain")).toBeVisible();
  // And the reasoning, which lived only in the drawer of a session that in a 30-day ledger
  // has usually stopped existing.
  await expect(
    ledger.getByText("The reviewer reached an answer and the session moved on first."),
  ).toBeVisible();

  // One at a time: the card carries a whole terminal screen, so two open in a scroller
  // pushes the row you opened first off the top.
  const other = ledger.getByRole("button", {
    name: /Polling GitHub until the pending CI job finishes/,
  });
  await other.click();
  await expect(other).toHaveAttribute("aria-expanded", "true");
  await expect(row).toHaveAttribute("aria-expanded", "false");
});

test("the rows scroll inside the table, leaving the filter strip in view", async ({
  page,
  daemon,
}) => {
  // Enough rows to overflow any sane height budget - the real ledger caps at 100, and the
  // failure this pins got worse the more Foreman did.
  seedEpisodes(
    daemon,
    Array.from({ length: 60 }, (_, i) => ({
      ...SEED[0]!,
      marker: `bulk-${i}`,
      purpose: `Decision number ${i} in a long run of them.`,
      createdAt: 1_700_000_000_000 + i,
    })),
  );
  const ledger = await openLedger(page, daemon);

  const scroller = ledger.locator(".sc-scroll");
  await expect(scroller).toBeVisible();

  // The scroller is genuinely shorter than its contents, which is the whole claim. Without
  // the height budget these two are equal and the page absorbs the difference.
  const overflow = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "the rows are not scrolling inside the table").toBeGreaterThan(200);

  // The page itself stays a readable length rather than growing to fit 60 rows of table.
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(pageOverflow, "the settings page still grows with the ledger").toBeLessThan(2_000);

  // And the filter survives a scroll to the bottom of the list, which is the specific thing
  // that was unreachable: the strip is the only control for making this list shorter.
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(ledger.getByRole("button", { name: /left alone/ })).toBeInViewport();
  await expect(ledger.getByRole("heading", { name: "Decisions" })).toBeInViewport();
});
