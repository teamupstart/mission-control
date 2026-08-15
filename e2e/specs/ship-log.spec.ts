import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { openDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * The Ship log at `#/shipped`, driven the way an operator reaches it: a hash, or ⌘K.
 *
 * This is the only layer that can see any of it. `test/ship-log.test.ts` proves the folds -
 * day grouping, the repo rail's tallies, the merged/open/gone mapping, the title's fallback -
 * and `test/workflow-route.test.ts` proves the hash round trip, and neither can tell you
 * whether `#/shipped` mounts a page at all, whether the page then asks for the ADOPTION
 * window rather than the panel's 50-row default, whether the rail's bars filter the feed
 * they sit beside, or whether a ledger read that failed says so instead of drawing a quiet
 * week. A spec that only rendered the component would pass on a build whose route was wired
 * to nothing.
 *
 * ## What is real here and what is stood in for
 *
 * Real, in the first test: the dispatched session, the daemon's own adoption path (a
 * `prCreated` hook through `POST /hooks/:event`, one of exactly two signals that prove
 * Mission Control opened a pull request), the row that lands in `inspector_prs`, the route
 * the page fetches, and the browser rendering it back.
 *
 * Stood in for, and only ever the PROVIDER's answer: what the Inspector's poll saw on
 * GitHub. `title` and `head_ref_name` are written by the poller calling `gh`, and e2e
 * reaches no network - the same reason every agent binary here is a fake. The first test
 * writes those columns exactly as the poll would (`workflow-pull-request-mismatch.spec.ts`
 * uses the same lever); the multi-repo tests fulfil the read itself, because a cross-repo
 * week cannot be dispatched from one temporary repository.
 *
 * No model tokens: the one dispatched session runs against the fake agent.
 */

const EVIDENCE = artifactsDir("ship-log");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like the Line's and the palette's captures: an ordinary run
 * would rewrite the binaries for no added signal. Inside the regression tests rather than
 * in a staged capture spec, because the point of the picture is that the assertions around
 * it passed on the same run.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and this
  // page is a rail of adjacent buttons over a feed of adjacent links.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/ship-log/${name}.png`);
}

/** Say what just held, after it held - so the transcript cannot narrate a step that did not. */
function observed(line: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${line}`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<SessionRow> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the ship log");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let live: SessionRow | undefined;
  await expect
    .poll(async () => {
      const sessions = await api<SessionRow[]>(daemon, "/api/sessions");
      live = sessions.find((session) => session.state !== "exited");
      return live?.state ?? "";
    }, { timeout: 60_000, message: "the dispatched session should settle before the hook fires" })
    .toBe("idle");
  return live!;
}

/**
 * The daemon's own adoption signal: the hook a harness fires when `gh pr create` returns.
 *
 * The AGENT's session id, not the card's - a hook naming the wrong one lands on no session
 * at all, and this spec would then pass by never adopting anything.
 */
async function announcePullRequest(daemon: DaemonHandle, session: SessionRow, url: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      prCreated: true,
      prUrl: url,
    }),
  });
  if (!response.ok) throw new Error(`hook answered ${response.status}: ${await response.text()}`);
}

/** Write what a poll would have observed. WAL is on, so a second writer is safe here. */
function observePullRequest(
  daemon: DaemonHandle,
  patch: { branch: string; title?: string },
): void {
  const db = openDaemonDb(daemon.home);
  try {
    db.prepare(
      `UPDATE inspector_prs
          SET head_ref_name = ?, title = ?, observed_state = 'OPEN', observed_at = ?
        WHERE state = 'open'`,
    ).run(patch.branch, patch.title ?? null, Date.now());
  } finally {
    db.close();
  }
}

const page2 = (page: Page) => page.getByRole("heading", { level: 2, name: "Ship log" });
const feedRow = (page: Page, name: RegExp | string) =>
  page.getByRole("listitem").filter({ hasText: name });

/** A ledger row as the route serves it, so a cross-repo week can be stood up in one read. */
function ledgerRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    key: "owner/repo#1",
    url: "https://github.example/owner/repo/pull/1",
    owner: "owner",
    repo: "repo",
    number: 1,
    repoRoot: "/repo",
    cwd: "/repo",
    sessionId: null,
    source: "hook",
    state: "open",
    headSha: null,
    reviewPosture: null,
    round: 0,
    lastReviewedAt: null,
    lastError: null,
    failCount: 0,
    lastFailKind: null,
    nextAttemptAt: null,
    lastAttemptSha: null,
    mergedAt: null,
    mergeBlock: null,
    observedHeadSha: null,
    observedState: null,
    observedAt: null,
    headRefName: null,
    title: null,
    adoptedAt: Date.now(),
    updatedAt: Date.now(),
    openFindings: 0,
    postedOpenFindings: 0,
    resolvedFindings: 0,
    ...over,
  };
}

test("a pull request adopted through the hook appears on the Ship log, named by what is known", async ({
  dashboard,
  daemon,
}) => {
  const session = await dispatch(dashboard, daemon);
  await announcePullRequest(daemon, session, "https://github.com/mancej-cyc/ai-harness/pull/241");
  await expect
    .poll(async () => (await api<unknown[]>(daemon, "/api/inspector/prs")).length)
    .toBe(1);

  await dashboard.goto(`${daemon.baseURL}/#/shipped`);
  await expect(page2(dashboard)).toBeVisible();

  // Nothing has polled this row yet, so it has no title AND no branch - the two nullable
  // columns are written by the same observation. The page must still name it: the number is
  // the last thing that is always true about a pull request.
  await expect(feedRow(dashboard, "#241")).toBeVisible();
  await expect(feedRow(dashboard, "#241")).toContainText("open");
  // ONCE. The subline carries whatever the title line did not already say, and on this rung
  // of the fallback the title line IS the number - so a subline that always printed it
  // rendered "#241" twice in two type sizes.
  const unpolled = (await feedRow(dashboard, "#241").innerText()).match(/#241/g) ?? [];
  expect(unpolled, "an unnamed row must not print its number twice").toHaveLength(1);
  // The rail is cross-repo, so it names the owner too - this is the page's whole claim.
  await expect(dashboard.getByRole("button", { name: /mancej-cyc\/ai-harness/ })).toBeVisible();

  // Now the poll runs and reports a branch, still with no title: the middle rung of the
  // fallback, and the one an operator sees most often on a fresh row.
  observePullRequest(daemon, { branch: "fix/line-drawer-focus" });
  await dashboard.reload();
  await expect(page2(dashboard)).toBeVisible();
  await expect(feedRow(dashboard, "fix/line-drawer-focus")).toBeVisible();

  // And with a title, the title wins - the field Phase 1 put on the ledger for this page.
  observePullRequest(daemon, {
    branch: "fix/line-drawer-focus",
    title: "Focus order for line drawer chips",
  });
  await dashboard.reload();
  await expect(feedRow(dashboard, "Focus order for line drawer chips")).toBeVisible();
  // The branch does not vanish when a title arrives; it drops to the subline beside the
  // number, because the branch is what the operator typed and still recognizes.
  await expect(feedRow(dashboard, "Focus order for line drawer chips"))
    .toContainText("#241 · fix/line-drawer-focus");
  await expect(
    feedRow(dashboard, "Focus order for line drawer chips").getByRole("link"),
  ).toHaveAttribute("href", "https://github.com/mancej-cyc/ai-harness/pull/241");
});

test("the page reads the adoption window, not the panel's review-ordered default", async ({
  dashboard,
  daemon,
}) => {
  // What is at stake: the default read is 50 rows ordered by REVIEW recency, which can both
  // truncate and reorder a busy week - a page that then disagrees with the Line's Shipped
  // count about rows from one table. The parameter is the contract Phase 1 added for this.
  const asked: string[] = [];
  await dashboard.route("**/api/inspector/prs*", async (route) => {
    asked.push(new URL(route.request().url()).search);
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await dashboard.goto(`${daemon.baseURL}/#/shipped`);
  await expect(page2(dashboard)).toBeVisible();
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  for (const search of asked) {
    expect(search, "the Ship log must never take the parameterless ledger read").toMatch(
      /^\?adoptedSince=\d+$/,
    );
  }

  // An empty week says so plainly - and that is a claim the page is entitled to make,
  // because the read succeeded. Contrast with the failed read below.
  await expect(dashboard.getByText("No pull request was adopted in this range")).toBeVisible();
});

test("the rail's mix bars filter the feed, and the KPI row keeps its context", async ({
  dashboard,
  daemon,
}) => {
  // Anchored to LOCAL MIDNIGHT, not to `now - 2h`.
  //
  // The page groups by the operator's local day, so a row seeded "two hours ago" is on
  // yesterday's heading whenever this suite runs between midnight and 02:00 - and the
  // assertions below name both headings. Clamping each of today's rows to the later of
  // midnight and a few hours back makes them today's rows at every hour of the clock, and
  // an hour BEFORE midnight is yesterday's row just as reliably.
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const hoursAgoToday = (hours: number): number => Math.max(today, now - hours * 3600_000);
  await dashboard.route("**/api/inspector/prs*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        ledgerRow({
          key: "mancej-cyc/ai-harness#241",
          owner: "mancej-cyc",
          repo: "ai-harness",
          number: 241,
          title: "Focus order for line drawer chips",
          headRefName: "fix/line-drawer-focus",
          mergedAt: now,
          adoptedAt: hoursAgoToday(2),
          sessionId: "proc:/dev/ttys004:4123:1700",
        }),
        ledgerRow({
          key: "mancej-cyc/ai-harness#243",
          owner: "mancej-cyc",
          repo: "ai-harness",
          number: 243,
          title: "Playwright spec for the ship log",
          headRefName: "e2e/ship-log-spec",
          adoptedAt: hoursAgoToday(5),
        }),
        ledgerRow({
          key: "jordanmance/notes#12",
          owner: "jordanmance",
          repo: "notes",
          number: 12,
          title: "Summarizer draft",
          headRefName: "draft/summarizer",
          state: "closed",
          adoptedAt: today - 3600_000,
        }),
      ]),
    });
  });

  await dashboard.goto(`${daemon.baseURL}/#/shipped`);
  await expect(page2(dashboard)).toBeVisible();

  // Two repositories, three pull requests, one merged. The KPI row is the week's account.
  await expect(dashboard.getByText("Shipped this week")).toBeVisible();
  await expect(dashboard.getByText("33% of adopted PRs landed")).toBeVisible();

  // Every row is present and every merge state is spelled with a WORD, not only a hue.
  await expect(feedRow(dashboard, "Focus order for line drawer chips")).toContainText("merged");
  await expect(feedRow(dashboard, "Playwright spec for the ship log")).toContainText("open");
  await expect(feedRow(dashboard, "Summarizer draft")).toContainText("gone");
  // Two days, and the newest is named by the relative word rather than by a date.
  await expect(dashboard.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "Yesterday" })).toBeVisible();
  // The owning session rides on the row it happened on, abbreviated, never as a link.
  await expect(feedRow(dashboard, "Focus order for line drawer chips"))
    .toContainText("ttys004:4123");
  observed("the week's pull requests group by day, repo-tagged, with merge state as a word");
  await shoot(dashboard, "ship-log");

  // The rail doubles as the filter, and it is a TOGGLE - so it says so when pressed.
  const notes = dashboard.getByRole("button", { name: /jordanmance\/notes/ });
  await expect(notes).toHaveAttribute("aria-pressed", "false");
  await notes.click();
  await expect(notes).toHaveAttribute("aria-pressed", "true");
  await expect(feedRow(dashboard, "Summarizer draft")).toBeVisible();
  await expect(feedRow(dashboard, "Focus order for line drawer chips")).toHaveCount(0);
  // The KPI row deliberately does NOT narrow with it: the tile still says two repositories,
  // because the context the selection was made from is what makes the selection readable.
  await expect(dashboard.getByText("33% of adopted PRs landed")).toBeVisible();
  observed("a rail press filters the feed to one repository and leaves the KPI row whole");
  await shoot(dashboard, "ship-log-filtered");

  // Pressing the same repository again is the way back out, and so is the explicit control.
  await notes.click();
  await expect(notes).toHaveAttribute("aria-pressed", "false");
  await expect(feedRow(dashboard, "Focus order for line drawer chips")).toBeVisible();

  // The range chips fold the same rows rather than refetching them: yesterday's row leaves
  // "Today" and the merge rate follows it, with no reload and nothing lost.
  await dashboard.getByRole("button", { name: "Today", exact: true }).click();
  await expect(feedRow(dashboard, "Summarizer draft")).toHaveCount(0);
  await expect(feedRow(dashboard, "Focus order for line drawer chips")).toBeVisible();
  await expect(dashboard.getByText("50% of adopted PRs landed")).toBeVisible();
  // And none of it reaches the address bar: the range and the filter are what you are
  // looking at, not where you are.
  expect(await dashboard.evaluate(() => location.hash)).toBe("#/shipped");
  observed("the range chips refold the same rows, and neither filter reaches the address bar");
});

test("a ledger read that fails says so, instead of reporting a week in which nothing shipped", async ({
  dashboard,
  daemon,
}) => {
  // The CONTROL first, and it is not optional: the assertion below is that a sentence is
  // absent, and a sentence that could never appear here would make it pass through the exact
  // regression it names.
  await dashboard.route("**/api/inspector/prs*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await dashboard.goto(`${daemon.baseURL}/#/shipped`);
  await expect(dashboard.getByText("No pull request was adopted in this range")).toBeVisible();

  // Now break the read. `fetchJson` swallows every failure and resolves null, so this is the
  // shape a real outage takes: not an exception, just an absence.
  await dashboard.unroute("**/api/inspector/prs*");
  await dashboard.route("**/api/inspector/prs*", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await dashboard.reload();

  await expect(page2(dashboard)).toBeVisible();
  await expect(dashboard.getByText("The adoption ledger could not be read")).toBeVisible();
  await expect(dashboard.getByText("It is not a report that nothing did")).toBeVisible();
  // Not one number, and above all not the empty-week sentence: an unreachable ledger and a
  // quiet week look identical from here, and only one of them is news about the fleet.
  await expect(dashboard.getByText("No pull request was adopted in this range")).toHaveCount(0);
  await expect(dashboard.getByText("Shipped this week")).toHaveCount(0);
});

test("⌘K reaches the Ship log, and so does the Line's Shipped drawer", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);

  await dashboard.keyboard.press("Meta+k");
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();
  // Searched by what the page is ABOUT, not by its name - the keywords carry that, and an
  // operator hunting for where their merged pull requests went types this, not "ship log".
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("pull request");
  const row = dashboard.getByRole("option", { name: /Ship log, page/ });
  await expect(row).toBeVisible();
  await dashboard.keyboard.press("Enter");

  await expect(palette).toBeHidden();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/shipped");
  await expect(page2(dashboard)).toBeVisible();

  // The other way in, asserted from this page's side: the Shipped stage no longer navigates
  // to the completed workflow runs at all - it opens a drawer over the fleet, and that
  // drawer's header is what escalates here. (The drawer's own rows, chips and load states are
  // `line-drawers.spec.ts`' subject; what is pinned here is that the retired route is gone
  // and that this page is where the click eventually leads.)
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard
    .getByRole("navigation", { name: "The Line" })
    .getByRole("button", { name: /^Shipped,/ })
    .click();
  await expect(dashboard).not.toHaveURL(/#\/runs/);
  await dashboard
    .getByRole("region", { name: "Shipped drawer" })
    .getByRole("button", { name: /^Ship log/ })
    .click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash)).toBe("#/shipped");
  await expect(page2(dashboard)).toBeVisible();
});
