import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

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
const ALERT = "A CI check failed on this pull request - open on GitHub";

interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
  prNumber: number | null;
  prChecks: string | null;
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
  const chip = card.locator(".pr-chip");
  const alert = card.getByRole("link", { name: ALERT });
  const railPr = dashboard.getByRole("navigation", { name: "Sessions" }).locator(".rail-pr");

  // The title check fails, and it is the latest run of that check: the alert is right to be up.
  // Asserted first so the absence below cannot pass by the spec never seeing an alert at all.
  writeGhPullRequests(daemon.home, [withChecks(pr, [buildPassed, titleFailed])]);
  await expect(chip).toHaveAttribute("href", PR_URL);
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute("href", PR_URL);
  await expect(railPr).toHaveText(`#${PR_NUMBER} ⚠`);
  await capture(dashboard, "latest-run-failing.png", card);

  // The title is fixed and the check runs again on the SAME commit, and passes. GitHub keeps the
  // failed run beside the new one, exactly as it does for a real pull request.
  writeGhPullRequests(daemon.home, [withChecks(pr, [buildPassed, titleFailed, titlePassed])]);
  await expect(alert).toHaveCount(0);
  await expect(railPr).toHaveText(`#${PR_NUMBER}`);
  // The pull request itself is still shown; only the stale alarm is gone.
  await expect(chip).toHaveAttribute("href", PR_URL);
  await expect.poll(async () =>
    (await api<SessionRow[]>(daemon, "/api/sessions")).find((s) => s.id === session.id)?.prChecks ?? null,
  ).toBe("passing");
  await capture(dashboard, "retried-run-passed.png", card);

  // The build's `push` run failed, and its `pull_request` run passed later, with no overlap.
  // To `gh pr list` that is the same workflow and name passing after a failure - the shape of a
  // re-run - but it is a different check, and its failure raises the alert.
  const buildPushFailed: CheckRun = { ...build, event: "push", conclusion: "FAILURE", startedAt: after(-600) };
  writeGhPullRequests(daemon.home, [withChecks(pr, [buildPushFailed, buildPassed, titleFailed, titlePassed])]);
  await expect(alert).toBeVisible();
  await expect(railPr).toHaveText(`#${PR_NUMBER} ⚠`);
  await capture(dashboard, "push-failure-not-cleared.png", card);
});
