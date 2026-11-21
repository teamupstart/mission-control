import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { PrCheckDetails } from "../../src/shared/pr-check-details.ts";

import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";
import { expect, test } from "../fixtures/test.ts";

// The "a CI check failed" alert follows the LATEST run of each check, not every run a commit
// ever had.
//
// The regression (issue #1511): a check fails, something changes on the pull request - the
// title is fixed, a workflow is dispatched again - and the same check runs again on the same
// commit and passes. GitHub's checks list goes green. `gh pr list --json statusCheckRollup`
// still carries BOTH runs, and the chip counted the old failure, so the red triangle stayed up
// for the rest of the pull request's life.
//
// And the line it must not cross: the `push` and `pull_request` runs of one job carry the same
// workflow and name, which is all `gh pr list` reports, so a passing `pull_request` run after a
// failed `push` run looks exactly like a re-run there. The poller asks GitHub for each run's
// event before it clears anything, and that failure stays up.
//
// Real: the dispatch, the worktree, the daemon's adoption hook, the branch poller asking `gh`,
// and the browser. Stood in for: what GitHub reports, through the fixture's fake `gh` - the
// rollup below is the shape GitHub returned for teamupstart/mission-control#1170.
// No model tokens: every agent binary is a fake (see `fake-agents.ts`).

// The branch poller ships at 20s; this file needs it to answer within a spec's budget.
test.use({ daemonEnv: { MISSION_PR_POLL_MS: "400" } });

const EVIDENCE = artifactsDir("pr-checks-retried");
const PR_NUMBER = 1511;
const PR_URL = `https://github.com/acme/mission-e2e/pull/${PR_NUMBER}`;
const ALERT = /CI checks? reported failure.*view check results/;

interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
  prNumber: number | null;
  prChecks: string | null;
  prCheckDetails?: PrCheckDetails | null;
}

interface TaskRow {
  worktreePath: string | null;
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<SessionRow> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("fix the release title check");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let live: SessionRow | undefined;
  await expect.poll(async () => {
    live = (await api<SessionRow[]>(daemon, "/api/sessions")).find((s) => s.state !== "exited");
    return live?.state ?? "";
  }, { timeout: 60_000, message: "the dispatched session should settle before its PR opens" })
    .toBe("idle");
  return live!;
}

/** The dispatched task's worktree, cut onto a feature branch the way an agent would. */
async function featureWorktree(daemon: DaemonHandle): Promise<string> {
  let worktree: string | null = null;
  await expect.poll(async () => {
    worktree = (await api<TaskRow[]>(daemon, "/api/tasks"))[0]?.worktreePath ?? null;
    return worktree;
  }, { message: "the task should record its worktree" }).not.toBeNull();
  execFileSync("git", ["-C", worktree!, "switch", "-q", "-c", "e2e/retried-check"]);
  return worktree!;
}

/** The hook a harness fires when `gh pr create` returns, then the turn ending. */
async function announcePullRequest(daemon: DaemonHandle, session: SessionRow): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      prCreated: true,
      prUrl: PR_URL,
    }),
  });
  expect(response.ok, await response.text()).toBe(true);
}

interface CheckRun {
  name: string;
  workflow: string;
  /** What triggered the run. `gh pr list` never says; GraphQL does. */
  event: string;
  conclusion: string;
  startedAt: Date;
  seconds: number;
}

/**
 * A pull request whose head carries these check runs, in both shapes GitHub reports them: as
 * `gh pr list --json statusCheckRollup` prints them (no app, no event), and as the GraphQL nodes
 * the poller reads to confirm a re-run (with both).
 */
function withChecks<T extends object>(pr: T, runs: CheckRun[]) {
  const times = (run: CheckRun) => ({
    startedAt: run.startedAt.toISOString(),
    completedAt: new Date(run.startedAt.getTime() + run.seconds * 1000).toISOString(),
  });
  return {
    ...pr,
    statusCheckRollup: runs.map((run) => ({
      __typename: "CheckRun", name: run.name, workflowName: run.workflow, status: "COMPLETED",
      conclusion: run.conclusion, ...times(run), detailsUrl: "https://github.com/acme/mission-e2e/actions/runs/1/job/1",
    })),
    // Each run in its own check suite, as a re-run or a run from another event is.
    checkContexts: runs.map((run, index) => ({
      __typename: "CheckRun", name: run.name, status: "COMPLETED", conclusion: run.conclusion, ...times(run),
      checkSuite: { id: `CS_${index}`, app: { slug: "github-actions" },
        workflowRun: { event: run.event, workflow: { id: `W_${run.workflow}`, name: run.workflow } } },
    })),
  };
}

async function capture(page: Page, name: string, target: Locator): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, name) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/pr-checks-retried/${name}`);
}

test("the failed-check alert clears once a later run of the same check passes, and never for another check", async ({
  dashboard,
  daemon,
}) => {
  const session = await dispatch(dashboard, daemon);
  const worktree = await featureWorktree(daemon);
  await announcePullRequest(daemon, session);

  const opened = new Date();
  const after = (seconds: number) => new Date(opened.getTime() + seconds * 1000);
  const title = { name: "release-compatible title", workflow: "Pull request title", event: "pull_request_target", seconds: 7 };
  const build = { name: "build", workflow: "CI", seconds: 240 };
  const buildPassed: CheckRun = { ...build, event: "pull_request", conclusion: "SUCCESS", startedAt: opened };
  const titleFailed: CheckRun = { ...title, conclusion: "FAILURE", startedAt: opened };
  const titlePassed: CheckRun = { ...title, conclusion: "SUCCESS", startedAt: after(60) };
  const pr = {
    cwd: worktree,
    url: PR_URL,
    number: PR_NUMBER,
    state: "OPEN" as const,
    createdAt: opened.toISOString(),
    mergedAt: null,
    headRefOid: "0".repeat(40),
  };

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const card = dashboard.locator(".console-detail");
  // The session's title bar, where the PR chip and its red triangle sit side by side.
  const titleBar = card.locator("header.detail-head");
  const chip = titleBar.locator(".pr-chip");
  const alert = titleBar.getByRole("button", { name: ALERT });
  const railPr = dashboard.getByRole("navigation", { name: "Sessions" }).locator(".rail-pr");

  // The title check fails, and it is the latest run of that check: the alert is right to be up.
  // Asserted first so the absence below cannot pass by the spec never seeing an alert at all.
  writeGhPullRequests(daemon.home, [withChecks(pr, [buildPassed, titleFailed])]);
  await expect(chip).toHaveAttribute("href", PR_URL);
  await expect(alert).toBeVisible();

  await expect(railPr).toHaveText(`#${PR_NUMBER} ⚠`);
  await capture(dashboard, "latest-run-failing.png", card);
  await capture(dashboard, "titlebar-before-alert-shown.png", titleBar);

  // The title is fixed and the check runs again on the SAME commit, and passes. GitHub keeps the
  // failed run beside the new one, exactly as it does for a real pull request.
  writeGhPullRequests(daemon.home, [withChecks(pr, [buildPassed, titleFailed, titlePassed])]);
  await expect(alert).toHaveCount(0);
  // Not just this title bar: no failed-check alert is left anywhere on the page.
  await expect(dashboard.getByRole("button", { name: ALERT })).toHaveCount(0);
  await expect(railPr).toHaveText(`#${PR_NUMBER}`);
  // The pull request itself is still shown; only the stale alarm is gone.
  await expect(chip).toHaveAttribute("href", PR_URL);
  await expect.poll(async () =>
    (await api<SessionRow[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.prChecks ?? null,
  ).toBe("passing");
  await capture(dashboard, "retried-run-passed.png", card);
  await capture(dashboard, "titlebar-after-alert-cleared.png", titleBar);

  // The build's `push` run failed, and its `pull_request` run passed later, with no overlap.
  // To `gh pr list` that is the same workflow and name passing after a failure - the shape of a
  // re-run - but it is a different check, and its failure raises the alert.
  const buildPushFailed: CheckRun = { ...build, event: "push", conclusion: "FAILURE", startedAt: after(-600) };
  writeGhPullRequests(daemon.home, [withChecks(pr, [buildPushFailed, buildPassed, titleFailed, titlePassed])]);
  await expect(alert).toBeVisible();
  await expect(railPr).toHaveText(`#${PR_NUMBER} ⚠`);
  await capture(dashboard, "push-failure-not-cleared.png", card);
});

test("cancelled checks retain their actual conclusions and direct job links", async ({ dashboard, daemon }) => {
  const session = await dispatch(dashboard, daemon);
  const worktree = await featureWorktree(daemon);
  await announcePullRequest(daemon, session);
  const pr = { cwd: worktree, url: PR_URL, number: PR_NUMBER, state: "OPEN" as const,
    createdAt: new Date().toISOString(), mergedAt: null, headRefOid: "0".repeat(40) };
  const job = (name: string, conclusion: string, id: number) => ({
    name, status: "COMPLETED", conclusion,
    detailsUrl: `https://github.com/acme/mission-e2e/actions/runs/1/job/${id}`,
  });
  // No provenance proving a retry: gates must keep their existing conservative verdict.
  const results = [job("Catalog Security review", "CANCELLED", 1), job("Report title policy", "CANCELLED", 2),
    job("Catalog Security review", "SUCCESS", 3), job("Report title policy", "SUCCESS", 4),
    ...Array.from({ length: 19 }, (_, i) => job(`Required check ${i}`, "SUCCESS", i + 5))];
  writeGhPullRequests(daemon.home, [{ ...pr, statusCheckRollup: results }]);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const alert = dashboard.locator("header.detail-head").getByRole("button", { name: /CI includes 2 cancelled checks/ });
  await expect(alert).toBeVisible();
  await alert.click();
  const dialog = dashboard.getByRole("dialog", { name: "Pull request checks" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listitem")).toHaveCount(23);
  await expect(dialog.getByRole("link", { name: "Catalog Security review: CANCELLED" })).toHaveAttribute("href", results[0]!.detailsUrl);
  await expect(dialog.getByRole("link", { name: "Catalog Security review: SUCCESS" })).toHaveAttribute("href", results[2]!.detailsUrl);
  await expect(dialog.getByRole("link", { name: "Report title policy: CANCELLED" })).toHaveAttribute("href", results[1]!.detailsUrl);
  await expect(dialog.getByRole("link", { name: "Report title policy: SUCCESS" })).toHaveAttribute("href", results[3]!.detailsUrl);
  for (const [control, description, captureName] of [
    [dialog.getByRole("button", { name: "Close" }), "Close pull request checks", "close"],
    [dialog.getByRole("link", { name: "Catalog Security review: CANCELLED" }), "Open Catalog Security review: CANCELLED on the check provider", "job"],
    [dialog.getByRole("link", { name: "Open pull request on GitHub" }), "Open the pull request overview on GitHub", "overview"],
  ] as const) {
    await control.hover();
    await expect(dashboard.locator(".tooltip")).toHaveText(description);
    await expect(dashboard.locator(".tooltip")).toBeVisible();
    await expect(control).toHaveAccessibleDescription(description);
    if (process.env.MC_E2E_TOOLTIP_EVIDENCE === "1") {
      const dir = artifactsDir("pr-checks-tooltip-repair");
      mkdirSync(dir, { recursive: true });
      await dashboard.screenshot({ path: join(dir, `${captureName}.png`) });
    }
  }
  await dashboard.context().route("https://github.com/acme/mission-e2e/actions/**", route => route.fulfill({ body: "Fixture job" }));
  const popupPromise = dashboard.waitForEvent("popup");
  await dialog.getByRole("link", { name: "Catalog Security review: CANCELLED" }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(results[0]!.detailsUrl);
  await popup.close();
  await expectContentClearsBorder(dialog);
  await capture(dashboard, "cancelled-check-details.png", dialog);
  await expect.poll(async () => (await api<SessionRow[]>(daemon, "/api/sessions")).find(s => s.id === session.id)?.prChecks).toBe("failing");
  // Same rollup state, changed detail: the registry must emit this update too.
  writeGhPullRequests(daemon.home, [{ ...pr, statusCheckRollup: [job("Unit tests", "FAILURE", 99),
    { name: "External check", status: "COMPLETED", conclusion: "TIMED_OUT" }] }]);
  await expect(dialog.getByRole("link", { name: "Unit tests: FAILURE" })).toHaveAttribute("href", "https://github.com/acme/mission-e2e/actions/runs/1/job/99");
  await expect(dialog.getByText("External check: TIMED_OUT", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: /External check/ })).toHaveCount(0);
  await expect(dialog.getByText("1 CI check reported failure", { exact: true })).toBeVisible();
  await capture(dashboard, "failed-check-details.png", dialog);
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }) });
  expect(layout.ok).toBe(true);
  await dashboard.reload();
  await dashboard.locator("main.board").getByRole("button", { name: /1 CI check reported failure/ }).click();
  await expect(dialog.getByRole("link", { name: "Unit tests: FAILURE" })).toBeVisible();
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

async function boardCheckWarning(page: Page, daemon: DaemonHandle): Promise<Locator> {
  const session = await dispatch(page, daemon);
  const worktree = await featureWorktree(daemon);
  await announcePullRequest(daemon, session);
  writeGhPullRequests(daemon.home, [{
    cwd: worktree, url: PR_URL, number: PR_NUMBER, state: "OPEN",
    createdAt: new Date().toISOString(), mergedAt: null, headRefOid: "0".repeat(40),
    statusCheckRollup: [{ name: "Catalog Security review", status: "COMPLETED", conclusion: "CANCELLED",
      detailsUrl: "https://github.com/acme/mission-e2e/actions/runs/1/job/1" }],
  }]);
  const layout = await fetch(`${daemon.baseURL}/api/ui/config`, { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "board" }) });
  expect(layout.ok).toBe(true);
  await page.reload();
  const warning = page.locator("main.board").getByRole("button", { name: /CI includes 1 cancelled check/ });
  await expect(warning).toBeVisible();
  return warning;
}

test("the check dialog backdrop dismisses without opening its board session", async ({ dashboard, daemon }) => {
  const warning = await boardCheckWarning(dashboard, daemon);
  await warning.click();
  const dialog = dashboard.getByRole("dialog", { name: "Pull request checks" });
  await expectContentClearsBorder(dialog);
  await expect(dialog.getByRole("link", { name: "Open pull request on GitHub" })).toBeInViewport();
  const bounds = (await dialog.boundingBox())!;
  await dashboard.mouse.click(bounds.x / 2, bounds.y - 20);
  await expect(dialog).toBeHidden();
  await expect(dashboard.locator("main.board")).toBeVisible();
  await expect(dashboard.locator(".console-detail")).toHaveCount(0);
  await expect(dashboard.locator(".board-detail")).toHaveAttribute("aria-hidden", "true");
  await expect(warning).toBeFocused();
});

test("the check dialog contains keyboard focus and returns it to its opener", async ({ dashboard, daemon }) => {
  const warning = await boardCheckWarning(dashboard, daemon);
  await warning.focus();
  await dashboard.keyboard.press("Enter");
  const dialog = dashboard.getByRole("dialog", { name: "Pull request checks" });
  await expectContentClearsBorder(dialog);
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  const job = dialog.getByRole("link", { name: "Catalog Security review: CANCELLED" });
  const overview = dialog.getByRole("link", { name: "Open pull request on GitHub" });
  await expect(close).toBeFocused();
  await dashboard.keyboard.press("Shift+Tab");
  await expect(overview).toBeFocused();
  await dashboard.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await dashboard.keyboard.press("Tab");
  await expect(job).toBeFocused();
  await dashboard.keyboard.press("Tab");
  await expect(overview).toBeFocused();

  // Another overlay can arrive above this one; closing it restores the exact control
  // that held focus, without re-initialising or closing the covered dialog.
  await dashboard.getByRole("button", { name: /^Foreman - the auto-responder/ })
    .evaluate((element: HTMLButtonElement) => element.click());
  await dashboard.getByRole("button", { name: "About Foreman", exact: true })
    .evaluate((element: HTMLButtonElement) => element.click());
  const guide = dashboard.getByRole("dialog", { name: "About Foreman", exact: true });
  await expectContentClearsBorder(guide);
  await expect(guide.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await dashboard.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(overview).toBeFocused();
  // The guide's settings popover remains open beneath it and owns its own Escape.
  await dashboard.getByRole("button", { name: /^Foreman - the auto-responder/ })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(dashboard.getByRole("dialog", { name: "Foreman settings", exact: true })).toBeHidden();

  if (process.env.MC_E2E_OVERLAY_REVIEW_EVIDENCE === "1") {
    const dir = artifactsDir("pr-checks-overlay-review");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await dashboard.screenshot({ path: join(dir, "keyboard-focus-contained.png") });
  }
  await dashboard.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(warning).toBeFocused();
  await dashboard.keyboard.press("Enter");
  await expect(close).toBeFocused();
  await close.click();
  await expect(dialog).toBeHidden();
  await expect(warning).toBeFocused();
});

test("100 reported checks warn of an incomplete list while 99 are complete", async ({ dashboard, daemon }) => {
  const session = await dispatch(dashboard, daemon);
  const worktree = await featureWorktree(daemon);
  await announcePullRequest(daemon, session);
  const pr = { cwd: worktree, url: PR_URL, number: PR_NUMBER, state: "OPEN" as const,
    createdAt: new Date().toISOString(), mergedAt: null, headRefOid: "0".repeat(40) };
  const results = Array.from({ length: 100 }, (_, index) => ({
    name: `Boundary check ${index + 1}`, status: "COMPLETED",
    conclusion: index === 0 ? "CANCELLED" : "SUCCESS",
  }));
  writeGhPullRequests(daemon.home, [{ ...pr, statusCheckRollup: results }]);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.locator("header.detail-head").getByRole("button", { name: /CI includes 1 cancelled check/ }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Pull request checks" });
  const warning = dialog.getByRole("status");

  // Start with the warning present, then cross the boundary on the same open dialog.
  // The API assertions exercise the real poller's parser rather than seeded UI details.
  for (const count of [100, 99] as const) {
    if (count === 99) writeGhPullRequests(daemon.home, [{ ...pr, statusCheckRollup: results.slice(0, count) }]);
    await expect.poll(async () => {
      const details = (await api<SessionRow[]>(daemon, "/api/sessions"))
        .find(s => s.id === session.id)?.prCheckDetails;
      return { count: details?.results.length, complete: details?.complete };
    }).toEqual({ count, complete: count === 99 });
    await expect(dialog.getByRole("listitem")).toHaveCount(count);
    if (count === 100) {
      await expect(warning).toHaveText("The check list may be incomplete. Missing results cannot be classified.");
      await expect(warning).toBeVisible();
    } else {
      await expect(warning).toHaveCount(0);
    }
    await expectContentClearsBorder(dialog);
    if (process.env.MC_E2E_BOUNDARY_EVIDENCE === "1") {
      const dir = artifactsDir("pr-checks-boundary-repair");
      mkdirSync(dir, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await dialog.screenshot({ path: join(dir, `${count}-results.png`) });
    }
  }
});

test("publication wait reason remains visible separately from the cancelled CI warning", async ({ dashboard, daemon }) => {
  const session = await dispatch(dashboard, daemon);
  const worktree = await featureWorktree(daemon);
  await announcePullRequest(daemon, session);
  writeGhPullRequests(daemon.home, [{
    cwd: worktree, url: PR_URL, number: PR_NUMBER, state: "OPEN",
    createdAt: new Date().toISOString(), mergedAt: null, headRefOid: "0".repeat(40),
    statusCheckRollup: [
      { name: "Catalog Security review", status: "COMPLETED", conclusion: "CANCELLED" },
      { name: "Report title policy", status: "COMPLETED", conclusion: "CANCELLED" },
      { name: "Required checks", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
  }]);
  const post = async <T,>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${daemon.baseURL}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json() as Promise<T>;
  };
  const persona = await post<{ id: string }>("/api/personas", {
    name: "Publication wait reviewer", guidanceMarkdown: "# Publication wait reviewer\n\nE2E_PASS_VERDICT",
  });
  const name = "CI reporting publication wait";
  const workflow = await post<{ workflow: { id: string } }>("/api/workflows", { name, draft: {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
      { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
    ],
    edges: [
      { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
      { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
      { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
    ],
  } });
  const published = await post<{ version: { id: string } }>(`/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
  const binding = await post<{ id: string }>("/api/workflow-bindings", {
    workflowVersionId: published.version.id, sessionId: session.id, deliveryMode: "preview",
  });
  const submitted = await post<{ run: { id: string } }>(`/api/workflow-bindings/${binding.id}/submit`, { requestId: "ci-publication-wait" });
  const runPath = `/api/workflow-runs/${submitted.run.id}`;
  await expect.poll(async () => (await api<{ run: { status: string } }>(daemon, runPath)).run.status,
    { timeout: 40_000 }).toBe("completed");

  // Seed the recorded gate and its matching unpublished evidence. Inspector re-observes
  // historical publication holds, so a clean snapshot would correctly leave this state.
  const now = Date.now();
  withDaemonDb(daemon, db => {
    const submission = db.prepare(`SELECT id, context_json FROM workflow_submissions
      WHERE run_id = ? ORDER BY round DESC, segment DESC LIMIT 1`).get(submitted.run.id) as {
        id: string; context_json: string;
      };
    const context = JSON.parse(submission.context_json);
    context.evidence.workingTreeDirty = true;
    context.evidence.workingTreeStatus = [" M unpublished.txt"];
    context.evidence.publication.unpublishedPaths = ["unpublished.txt"];
    db.prepare("UPDATE workflow_submissions SET context_json = ?, evidence_json = ? WHERE id = ?")
      .run(JSON.stringify(context), JSON.stringify(context.evidence), submission.id);
    db.prepare("UPDATE workflow_versions SET completion_policy_json = ? WHERE id = ?").run(
      JSON.stringify({ kind: "inspector", onFindings: "inspector_only", missingPrAction: "wait" }), published.version.id);
    db.prepare(`UPDATE workflow_runs SET status = 'waiting_for_session',
      current_phase = 'inspector_working_tree_not_pushed', inspector_pr_key = ?,
      inspector_head_sha = ?, gate_state_json = ?, completed_at = NULL, updated_at = ? WHERE id = ?`).run(
      `acme/mission-e2e#${PR_NUMBER}`, "0".repeat(40), JSON.stringify({
        prKey: `acme/mission-e2e#${PR_NUMBER}`, prUrl: PR_URL, targetHeadSha: "0".repeat(40),
        failedHeadSha: null, enteredAt: now, lastObservedAt: now, observedHeadSha: "0".repeat(40),
        reviewPosture: "live", waitReason: "working_tree_not_pushed", findingFingerprints: [],
      }), now, submitted.run.id);
  });
  const gate = await api<{ inspectorGate: { state: { waitReason: string } } }>(daemon, runPath);
  expect(gate.inspectorGate.state.waitReason).toBe("working_tree_not_pushed");
  await dashboard.setViewportSize({ width: 1440, height: 1100 });
  await dashboard.reload();
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  await dashboard.getByRole("tablist", { name: "Session detail" }).getByRole("tab", { name: /Workflows$/ }).click();
  const ladder = dashboard.getByRole("region", { name: `${name} workflow stages` });
  const wait = ladder.getByText("Required publication content is missing, differs from the PR, or lacks retained artifact evidence. Check the evidence snapshot, then commit and push the required changes and resubmit.", { exact: true });
  await wait.scrollIntoViewIfNeeded();
  await expect(wait).toBeVisible();
  await expect(wait).toBeInViewport();
  const warning = dashboard.locator("header.detail-head").getByRole("button", { name: /CI includes 2 cancelled checks; no failures in the reported results/ });
  await warning.hover();
  await expect(warning).toBeInViewport();
  await expect(dashboard.locator(".tooltip")).toHaveText("CI includes 2 cancelled checks; no failures in the reported results - view check results");
  await expect(dashboard.locator(".tooltip")).toBeVisible();
  await expect(wait).toBeInViewport();
  if (process.env.MC_E2E_WAIT_REASON_EVIDENCE === "1") {
    const dir = artifactsDir("pr-checks-wait-reason-repair");
    mkdirSync(dir, { recursive: true });
    await dashboard.screenshot({ path: join(dir, "publication-wait-and-ci-warning.png") });
  }
});
