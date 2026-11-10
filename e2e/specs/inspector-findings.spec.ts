import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

/**
 * Settings > GitHub Inspector > Inspections: a pull request's Findings modal.
 *
 * The modal is the one place an operator reads every finding the Inspector generated for a
 * pull request, dry-run drafts included, with whether each reached GitHub. The ledger rows are
 * seeded directly, because only a completed review round (a model call) mints a finding. The
 * route the modal reads, the daemon that serves it and the poll that refreshes it are real.
 */

const EVIDENCE = artifactsDir("inspector-findings");

async function shoot(page: Page, name: string, region?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (region ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/inspector-findings/${name}.png`);
}

const POSTED_URL = "https://github.example/owner/repo/pull/601#discussion_r1";
const EARLIER_URL = "https://github.example/owner/repo/pull/601#discussion_r2";
const RESOLVED_URL = "https://github.example/owner/repo/pull/601#discussion_r3";

interface SeedFinding {
  id: string;
  title: string;
  body: string | null;
  severity: "blocker" | "major" | "minor" | "nit";
  status: "drafted" | "posting" | "open" | "resolved";
  postedAt: number | null;
  githubUrl: string | null;
  legacyPosted: "posted" | "unposted" | "unknown" | null;
  /** Validation refusals GitHub pinned on a draft, and its reason. Zero and null when absent. */
  postRefusals?: number;
  lastPostError?: string | null;
}

interface SeedPr {
  number: number;
  posture: "live" | "dry-run" | null;
  state?: "open" | "closed";
  /** GitHub's state as of the last poll. A PR merged by hand is `MERGED` with no `merged_at`. */
  observedState?: "OPEN" | "CLOSED" | "MERGED" | null;
  round?: number;
  findings: SeedFinding[];
}

function seedLedger(daemon: DaemonHandle, prs: SeedPr[]): void {
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    for (const pr of prs) {
      const key = `owner/repo#${pr.number}`;
      const open = pr.findings.some((f) => f.status !== "resolved");
      db.prepare(
        `INSERT INTO inspector_prs
           (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
            head_sha, review_posture, round, last_reviewed_at, fail_count, merge_block,
            observed_state, adopted_at, updated_at)
         VALUES (?, ?, 'owner', 'repo', ?, '/repo', '/repo', NULL, 'hook', ?,
                 'head-1', ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        key,
        `https://github.example/owner/repo/pull/${pr.number}`,
        pr.number,
        pr.state ?? "open",
        pr.posture,
        pr.round ?? 3,
        now,
        open ? "findings" : null,
        pr.observedState ?? null,
        now,
        now,
      );
      for (const f of pr.findings) insertFinding(db, key, f, now);
    }
  });
}

function insertFinding(
  db: DatabaseSync,
  prKey: string,
  f: SeedFinding,
  now: number,
): void {
  db.prepare(
    `INSERT INTO inspector_comments
       (id, pr_key, fingerprint, path, line, title, body, severity, round, status,
        replies, answered_comment_id, created_at, updated_at,
        posted_at, github_url, legacy_posted, post_refusals, last_post_error)
     VALUES (?, ?, ?, 'src/example.ts', 10, ?, ?, ?, 2, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.id, prKey, `fp-${f.id}`, f.title, f.body, f.severity, f.status, now, now,
    f.postedAt, f.githubUrl, f.legacyPosted, f.postRefusals ?? 0, f.lastPostError ?? null,
  );
}

const SIX: SeedFinding[] = [
  {
    id: "posted-link", title: "Posted with its link", body: "BODY posted with a link.",
    severity: "blocker", status: "open", postedAt: 1_000, githubUrl: POSTED_URL, legacyPosted: null,
  },
  {
    id: "posted-nolink", title: "Posted before its link was captured", body: "BODY posted, no link yet.",
    severity: "major", status: "open", postedAt: 1_000, githubUrl: null, legacyPosted: null,
  },
  {
    id: "draft", title: "A draft that was never posted", body: "BODY only in Mission Control.",
    severity: "major", status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null,
  },
  {
    id: "draft-earlier", title: "Raised again after an earlier post", body: "BODY raised again.",
    severity: "minor", status: "drafted", postedAt: 900, githubUrl: EARLIER_URL, legacyPosted: null,
  },
  {
    id: "resolved-posted", title: "Resolved after it was posted", body: "BODY resolved and posted.",
    severity: "minor", status: "resolved", postedAt: 800, githubUrl: RESOLVED_URL, legacyPosted: null,
  },
  {
    id: "legacy", title: "Recorded before posting was tracked", body: null,
    severity: "nit", status: "resolved", postedAt: null, githubUrl: null, legacyPosted: "unknown",
  },
];

const findingsButton = (page: Page, number: number) =>
  page.getByRole("button", { name: `View GitHub Inspector's findings on owner/repo#${number}` });

const findingsDialog = (page: Page, number: number) =>
  page.getByRole("dialog", { name: `GitHub Inspector findings on owner/repo#${number}` });

test("the Findings modal lists every finding and whether each was posted", async ({
  dashboard,
  daemon,
}) => {
  seedLedger(daemon, [{ number: 601, posture: "live", findings: SIX }]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);

  // The table footer points at the modal rather than claiming the table holds the findings.
  await expect(dashboard.getByText(
    "In dry run nothing is posted to GitHub. Open a pull request's Findings to read what GitHub Inspector found.",
  )).toBeVisible();

  const open = findingsButton(dashboard, 601);
  await expect(open).toBeVisible();
  await expect(open).toHaveText("Findings");
  await open.click();

  const modal = findingsDialog(dashboard, 601);
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { name: "GitHub Inspector findings" })).toBeVisible();
  await expect(modal.getByRole("link", { name: "owner/repo#601" }))
    .toHaveAttribute("href", "https://github.example/owner/repo/pull/601");
  await expect(modal.locator(".inspector-findings-pr")).toContainText("open");
  await expect(modal.locator(".inspector-findings-pr")).toContainText("3 review rounds");
  // Reviewed live, so no dry-run line.
  await expect(modal).not.toContainText("Dry run: nothing on this pull request was posted");

  const rows = modal.locator("tr.wf-run-finding-row");
  await expect(rows).toHaveCount(6);
  const posted = (title: string): Locator => rows.filter({ hasText: title }).locator("td").nth(5);

  await expect(posted("Posted with its link")).toHaveText("Posted");
  await expect(posted("Posted with its link").getByRole("link", { name: "Posted" }))
    .toHaveAttribute("href", POSTED_URL);

  await expect(posted("Posted before its link was captured")).toHaveText("Posted");
  await expect(posted("Posted before its link was captured").getByRole("link")).toHaveCount(0);

  await expect(posted("A draft that was never posted")).toHaveText("Not posted");
  await expect(posted("A draft that was never posted").getByRole("link")).toHaveCount(0);

  await expect(posted("Raised again after an earlier post")).toHaveText("Not posted (posted earlier)");
  await expect(
    posted("Raised again after an earlier post").getByRole("link", { name: "Not posted (posted earlier)" }),
  ).toHaveAttribute("href", EARLIER_URL);

  await expect(posted("Resolved after it was posted")).toHaveText("Posted");
  await expect(posted("Resolved after it was posted").getByRole("link", { name: "Posted" }))
    .toHaveAttribute("href", RESOLVED_URL);

  await expect(posted("Recorded before posting was tracked")).toHaveText("Unknown");

  // Every unresolved finding's body is on screen; a resolved one's opens with Show finding.
  for (const body of [
    "BODY posted with a link.",
    "BODY posted, no link yet.",
    "BODY only in Mission Control.",
    "BODY raised again.",
  ]) {
    await expect(modal.getByText(body)).toBeVisible();
  }
  await expect(modal.getByText("BODY resolved and posted.")).toHaveCount(0);
  await shoot(dashboard, "findings-modal", modal);
  await rows.filter({ hasText: "Resolved after it was posted" })
    .getByRole("button", { name: "Show finding" }).click();
  await expect(modal.getByText("BODY resolved and posted.")).toBeVisible();
  await rows.filter({ hasText: "Recorded before posting was tracked" })
    .getByRole("button", { name: "Show finding" }).click();
  await expect(modal.getByText(/Legacy finding: detail was not persisted/)).toBeVisible();

  // Read-only: Resolve stays on the Inspections row.
  await expect(modal.getByRole("button", { name: /Resolve/ })).toHaveCount(0);

  await expectContentClearsBorder(modal);
  await shoot(dashboard, "findings-modal-resolved-detail", modal);

  await modal.locator(".modal-foot").getByRole("button", { name: "Close" }).click();
  await expect(modal).toHaveCount(0);
  // Resolve was never touched from the modal, so the row still carries its findings.
  await expect(dashboard.locator(".sc-row").filter({ hasText: "repo#601" })).toContainText("4 findings");
});

test("the Findings control is on every row with a finding, and a dry run says so", async ({
  dashboard,
  daemon,
}) => {
  const draft = SIX[2]!;
  seedLedger(daemon, [
    { number: 602, posture: "dry-run", findings: [{ ...draft, id: "dry-draft" }] },
    // Reviewed clean: nothing to view.
    { number: 603, posture: "live", findings: [] },
    // Closed, every finding resolved: still the record of what was said.
    {
      number: 604,
      posture: "live",
      state: "closed",
      findings: [{ ...SIX[4]!, id: "closed-resolved" }],
    },
  ]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);

  await expect(dashboard.locator(".sc-row").filter({ hasText: "repo#603" })).toContainText("clean");
  await expect(findingsButton(dashboard, 603)).toHaveCount(0);
  await expect(findingsButton(dashboard, 604)).toBeVisible();

  await findingsButton(dashboard, 602).click();
  const modal = findingsDialog(dashboard, 602);
  await expect(modal.getByText("Dry run: nothing on this pull request was posted")).toBeVisible();
  await expect(modal.locator("tr.wf-run-finding-row")).toHaveCount(1);
  await expect(modal.getByText("BODY only in Mission Control.")).toBeVisible();
  await expectContentClearsBorder(modal);
  await shoot(dashboard, "findings-modal-dry-run", modal);
  await dashboard.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  await findingsButton(dashboard, 604).click();
  const closed = findingsDialog(dashboard, 604);
  await expect(closed.locator(".inspector-findings-pr")).toContainText("closed");
  await expect(closed.locator("tr.wf-run-finding-row")).toHaveCount(1);
});

const RECORD_LINE = "kept as a record and will not be reviewed again";

test("a closed pull request's leftover findings read as a record of how it ended", async ({
  dashboard,
  daemon,
}) => {
  const draft = SIX[2]!;
  seedLedger(daemon, [
    // Merged by hand: GitHub says MERGED, and YOLO mode never wrote `merged_at`.
    {
      number: 611,
      posture: "dry-run",
      state: "closed",
      observedState: "MERGED",
      findings: [{ ...draft, id: "merged-a" }, { ...draft, id: "merged-b", title: "A second draft" }],
    },
    {
      number: 612,
      posture: "dry-run",
      state: "closed",
      observedState: "CLOSED",
      findings: [{ ...draft, id: "closed-a" }],
    },
    { number: 613, posture: "dry-run", observedState: "OPEN", findings: [{ ...draft, id: "open-a" }] },
  ]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);

  const ledgerRow = (number: number): Locator =>
    dashboard.locator(".sc-row").filter({ hasText: `repo#${number}` });
  await expect(ledgerRow(611)).toContainText("2 unresolved at merge");
  await expect(ledgerRow(612)).toContainText("1 unresolved at close");
  await expect(ledgerRow(613)).toContainText("1 finding");
  await expect(ledgerRow(613)).not.toContainText("unresolved at");
  await shoot(dashboard, "closed-pr-rows", dashboard.locator(".sc-table-inspector"));

  await findingsButton(dashboard, 611).click();
  const merged = findingsDialog(dashboard, 611);
  await expect(merged.locator(".inspector-findings-pr")).toContainText("merged");
  await expect(merged.getByText(
    `This pull request merged with 2 findings unresolved. They are ${RECORD_LINE}.`,
  )).toBeVisible();
  // Rows keep their own posted label, and the dry-run line still applies beside the record.
  await expect(merged.locator("tr.wf-run-finding-row")).toHaveCount(2);
  await expect(merged.getByText("Dry run: nothing on this pull request was posted")).toBeVisible();
  await expectContentClearsBorder(merged);
  await shoot(dashboard, "findings-modal-merged-record", merged);
  await dashboard.keyboard.press("Escape");
  await expect(merged).toHaveCount(0);

  await findingsButton(dashboard, 612).click();
  const closed = findingsDialog(dashboard, 612);
  await expect(closed.locator(".inspector-findings-pr")).toContainText("closed");
  await expect(closed.getByText(
    `This pull request closed with 1 finding unresolved. It is ${RECORD_LINE}.`,
  )).toBeVisible();
  await dashboard.keyboard.press("Escape");
  await expect(closed).toHaveCount(0);

  await findingsButton(dashboard, 613).click();
  const open = findingsDialog(dashboard, 613);
  await expect(open.locator(".inspector-findings-pr")).toContainText("open");
  await expect(open.locator("tr.wf-run-finding-row")).toHaveCount(1);
  await expect(open.getByText(RECORD_LINE, { exact: false })).toHaveCount(0);
});

// A draft GitHub refused after a switch to live. Below the cap it still reads Not posted, and
// says how many times and why from the first refusal; at 3 it reads Refused. Both stay
// unresolved, so their bodies stay on screen and the row keeps counting them.
const REFUSAL_REASON = "Line could not be resolved (HTTP 422)";

test("a refused draft shows how many times GitHub refused it and why, and reads Refused at 3", async ({
  dashboard,
  daemon,
}) => {
  seedLedger(daemon, [{
    number: 607,
    posture: "live",
    findings: [
      {
        id: "refused-once", title: "GitHub refused this once", body: "BODY refused once.",
        severity: "major", status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null,
        postRefusals: 1, lastPostError: REFUSAL_REASON,
      },
      {
        id: "refused-thrice", title: "GitHub refused this three times", body: "BODY refused three times.",
        severity: "major", status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null,
        postRefusals: 3, lastPostError: REFUSAL_REASON,
      },
    ],
  }]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);
  // Both refused drafts are still open findings on the row.
  await expect(dashboard.locator(".sc-row").filter({ hasText: "repo#607" })).toContainText("2 findings");

  await findingsButton(dashboard, 607).click();
  const modal = findingsDialog(dashboard, 607);
  const rows = modal.locator("tr.wf-run-finding-row");
  await expect(rows).toHaveCount(2);
  const row = (title: string): Locator => rows.filter({ hasText: title });
  const posted = (title: string): Locator => row(title).locator("td").nth(5);

  // Once: Not posted, the count on its own line, GitHub's reason on hover and focus.
  await expect(posted("GitHub refused this once")).toHaveText("Not postedGitHub refused it 1 time");
  const once = posted("GitHub refused this once").getByText("Not posted", { exact: true });
  await expect(once).toHaveAccessibleDescription(`GitHub's reason: ${REFUSAL_REASON}`);
  await expect(row("GitHub refused this once").locator("td").nth(4)).toHaveText("drafted");

  // Three times: Refused, with the same reason.
  await expect(posted("GitHub refused this three times")).toHaveText("RefusedGitHub refused it 3 times");
  const thrice = posted("GitHub refused this three times").getByText("Refused", { exact: true });
  await expect(thrice).toHaveAccessibleDescription(`GitHub's reason: ${REFUSAL_REASON}`);
  await thrice.hover();
  await expect(dashboard.locator(".tooltip")).toHaveText(`GitHub's reason: ${REFUSAL_REASON}`);
  await expect(row("GitHub refused this three times").locator("td").nth(4)).toHaveText("drafted");

  // Still unresolved, so both bodies are on screen.
  await expect(modal.getByText("BODY refused once.")).toBeVisible();
  await expect(modal.getByText("BODY refused three times.")).toBeVisible();
  await shoot(dashboard, "findings-modal-refused", modal);

  // The detail row carries the reason too.
  for (const title of ["GitHub refused this once", "GitHub refused this three times"]) {
    await row(title).getByRole("button", { name: "Show finding" }).click();
    const detail = modal.locator(`#wf-run-finding-refused-${title.endsWith("once") ? "once" : "thrice"}`);
    await expect(detail.locator("dt", { hasText: "Why GitHub refused it" })).toBeVisible();
    await expect(detail.locator("dd", { hasText: REFUSAL_REASON })).toBeVisible();
  }
  await expectContentClearsBorder(modal);
  await shoot(dashboard, "findings-modal-refused-detail", modal);
});

// A refused draft never reached GitHub, so a dry-run pull request carrying only one still says
// nothing on it was posted.
test("a dry run whose only finding GitHub refused 3 times still says nothing was posted", async ({
  dashboard,
  daemon,
}) => {
  seedLedger(daemon, [{
    number: 608,
    posture: "dry-run",
    findings: [{
      id: "dry-refused", title: "Refused, then back to dry run", body: "BODY refused in dry run.",
      severity: "major", status: "drafted", postedAt: null, githubUrl: null, legacyPosted: null,
      postRefusals: 3, lastPostError: REFUSAL_REASON,
    }],
  }]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);
  await findingsButton(dashboard, 608).click();
  const modal = findingsDialog(dashboard, 608);
  await expect(modal.locator("tr.wf-run-finding-row")).toHaveCount(1);
  await expect(modal.locator("tr.wf-run-finding-row").locator("td").nth(5))
    .toHaveText("RefusedGitHub refused it 3 times");
  await expect(modal.getByText("Dry run: nothing on this pull request was posted")).toBeVisible();
  await shoot(dashboard, "findings-modal-dry-run-refused", modal);
});

test("an open Findings modal refreshes on the panel's poll", async ({ dashboard, daemon }) => {
  seedLedger(daemon, [{ number: 605, posture: "live", findings: [SIX[0]!] }]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);
  await findingsButton(dashboard, 605).click();
  const modal = findingsDialog(dashboard, 605);
  await expect(modal.locator("tr.wf-run-finding-row")).toHaveCount(1);

  // A later review round records another finding while the modal is open.
  withDaemonDb(daemon, (db) => {
    insertFinding(db, "owner/repo#605", { ...SIX[2]!, id: "later-draft" }, Date.now());
  });
  await expect(modal.locator("tr.wf-run-finding-row")).toHaveCount(2, { timeout: 15_000 });
  await expect(modal.getByText("BODY only in Mission Control.")).toBeVisible();
});

test("a failed refresh keeps the findings on screen, says so, and recovers on the next tick", async ({
  dashboard,
  daemon,
}) => {
  seedLedger(daemon, [{ number: 606, posture: "live", findings: [SIX[0]!] }]);
  await dashboard.goto(`${daemon.baseURL}/#/settings/inspector`);
  await findingsButton(dashboard, 606).click();
  const modal = findingsDialog(dashboard, 606);
  const rows = modal.locator("tr.wf-run-finding-row");
  await expect(rows).toHaveCount(1);

  const retry = "Couldn't read this pull request's findings. Trying again on the next refresh.";
  await expect(modal.getByText(retry)).toHaveCount(0);

  // Every read of this pull request's findings now fails, as a daemon restart would.
  const findingsRoute = "**/api/inspector/findings?*";
  await dashboard.route(findingsRoute, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));

  // The next tick fails: the last answer stays, and the modal says it could not refresh.
  await expect(modal.getByText(retry)).toBeVisible({ timeout: 15_000 });
  await expect(rows).toHaveCount(1);
  await expect(modal.getByText("BODY posted with a link.")).toBeVisible();
  await shoot(dashboard, "findings-modal-refresh-failed", modal);

  // The daemon answers again, with a finding recorded meanwhile. The following tick reads
  // it, so the modal shows fresh findings rather than the kept ones, and the error clears.
  withDaemonDb(daemon, (db) => {
    insertFinding(db, "owner/repo#606", { ...SIX[2]!, id: "after-outage" }, Date.now());
  });
  await dashboard.unroute(findingsRoute);
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(modal.getByText(retry)).toHaveCount(0);
  await expect(modal.getByText("BODY only in Mission Control.")).toBeVisible();
  await shoot(dashboard, "findings-modal-recovered", modal);
});
