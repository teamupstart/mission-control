import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { writeGhPullRequests, type FakePullRequest } from "../fixtures/fake-agents.ts";
import type { Locator, Page } from "@playwright/test";

// One task, one pull request per repository it changed - discovered, shown, and waited for.
//
// This is the only layer that can prove the feature. The sniffer, the poller fan-out, the
// per-repo episode records and the completion quorum are each testable in isolation and each
// individually correct while the thing an operator asked for does not happen: a two-repo task
// that shows one link, or one that calls itself done with a repository's work unmerged.
//
// Three real mechanisms, and one stand-in that is honest about what it is:
//
//  - REAL: the dispatch, the two worktrees, the daemon's own adoption path (a `prCreated` hook
//    carrying BOTH urls, which is what multi-url sniffing exists to deliver), the branch poller
//    asking `gh` once per checkout, the per-repo association, the quorum, and the browser.
//  - STOOD IN FOR: what GitHub says. `gh` is redirected at a fake for the reason every spec
//    here redirects it - a real one would publish - and this spec scripts what it reports, per
//    checkout, so a pull request can merge in one repository while its sibling stays open.
//
// No model tokens: every agent binary is a fake (see `fake-agents.ts`).

// The branch poller ships at 20s, which is a spec's whole budget spent waiting twice. Only
// this file pays the faster cadence - see the `daemonEnv` option.
test.use({ daemonEnv: { MISSION_PR_POLL_MS: "400" } });

const EVIDENCE = artifactsDir("multi-repo-pull-requests");

/**
 * A frame of the state the assertion beside it just proved, behind `MC_E2E_EVIDENCE` so an
 * ordinary run does not rewrite a binary for no added signal. What a picture adds here is the
 * half the DOM cannot carry: that a row of per-repo lines reads as "which repo, which pull
 * request" at a glance rather than as a row of interchangeable numbers.
 */
async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/multi-repo-pull-requests/${name}.png`);
}

const PR_PRIMARY = "https://github.com/example/demo-repo/pull/10";
const PR_SECOND = "https://github.com/example/second-repo/pull/20";

interface TaskRow {
  id: string;
  status: string;
  outcome: string | null;
  outcomeUrl: string | null;
  worktreePath: string | null;
  extraRepos: Array<{ repoRoot: string; worktreePath: string | null; prUrl: string | null }>;
}

interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/** Fill the dispatch form, attach `second-repo`, and launch. */
async function dispatchAcross(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  // The `Escape` after each repo field is load-bearing: `RepoCombobox` portals its listbox
  // over the fields below it, so the next `fill` would land on a covered control.
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Add another repo" }).click();
  await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Attach repo" }).click();
  await dialog.getByPlaceholder("What should this agent do?").fill("Rename the shared field");
  await dialog.getByLabel("Kind").selectOption("ship");
  // Pinned to none for the reason every launch helper here gives: left at the dispatch
  // default the configured Workflow arms live delivery, which this repo is not allowlisted
  // for, and the dispatch is refused.
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The dispatched session, once its first turn has settled. */
async function settledSession(daemon: DaemonHandle): Promise<SessionRow> {
  let live: SessionRow | undefined;
  await expect
    .poll(
      async () => {
        const sessions = await api<SessionRow[]>(daemon, "/api/sessions");
        live = sessions.find((s) => s.state !== "exited");
        return live?.state ?? "";
      },
      { timeout: 60_000, message: "the dispatched session should settle" },
    )
    .toBe("idle");
  return live!;
}

/** The dispatched task, once every repo it attached has a worktree recorded on it. */
async function provisionedTask(daemon: DaemonHandle, extras = 1): Promise<TaskRow> {
  let task: TaskRow | undefined;
  await expect
    .poll(
      async () => {
        const tasks = await api<TaskRow[]>(daemon, "/api/tasks");
        task = tasks.find((t) => t.extraRepos.length === extras);
        return Boolean(
          task?.worktreePath && task.extraRepos.every((e) => e.worktreePath),
        );
      },
      { message: "one worktree per attached repo, recorded on the task" },
    )
    .toBe(true);
  return task!;
}

/**
 * The daemon's own adoption signal: the hook a harness fires when `gh pr create` returns,
 * carrying EVERY url the command printed.
 *
 * The agent's session id, not the card's - a hook naming the wrong one lands on no session at
 * all, and this spec would then pass by never adopting anything.
 */
async function announcePullRequests(
  daemon: DaemonHandle,
  session: SessionRow,
  urls: string[],
): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const post = async (event: string, body: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({
        agent: session.agent,
        sessionId: session.agentSessionId ?? session.id,
        cwd: session.cwd,
        ...body,
      }),
    });
    if (!response.ok) throw new Error(`${event} answered ${response.status}: ${await response.text()}`);
  };
  await post("PostToolUse", { toolName: "Bash", prCreated: true, prUrl: urls[0], prUrls: urls });
  // The turn ending, which is the other half of what a real agent produces and is what puts
  // the card back to idle. Not decoration: the live-agent completion path requires an idle
  // session, so a spec that only fired the tool event would leave the task running for a
  // reason that has nothing to do with the quorum.
  await post("Stop", {});
}

/** What `gh` reports for each checkout, from now on. */
function scriptPullRequests(
  daemon: DaemonHandle,
  task: TaskRow,
  merged: { primary?: boolean; second?: boolean } = {},
): void {
  const second = task.extraRepos[0]?.worktreePath ?? null;
  const createdAt = new Date().toISOString();
  const mergedAt = new Date().toISOString();
  const row = (
    cwd: string,
    url: string,
    number: number,
    isMerged: boolean,
  ): FakePullRequest => ({
    cwd,
    url,
    number,
    state: isMerged ? "MERGED" : "OPEN",
    createdAt,
    mergedAt: isMerged ? mergedAt : null,
    headRefOid: "0".repeat(40),
  });
  writeGhPullRequests(daemon.home, [
    row(task.worktreePath!, PR_PRIMARY, 10, merged.primary === true),
    ...(second ? [row(second, PR_SECOND, 20, merged.second === true)] : []),
  ]);
}

test("a two-repo task shows a pull request per repo and completes only on the second merge", async ({
  dashboard,
  daemon,
}) => {
  await dispatchAcross(dashboard, daemon);
  const session = await settledSession(daemon);
  const task = await provisionedTask(daemon);

  // One command, two pull requests. Everything downstream of this - adoption, the card, the
  // quorum - is reachable only if BOTH urls survived the hook.
  await announcePullRequests(daemon, session, [PR_PRIMARY, PR_SECOND]);
  await expect
    .poll(
      async () => {
        const prs = await api<Array<{ url: string }>>(daemon, "/api/inspector/prs");
        return prs.map((p) => p.url).sort();
      },
      { message: "both pull requests are adopted, not just the first" },
    )
    .toEqual([PR_PRIMARY, PR_SECOND]);

  scriptPullRequests(daemon, task);

  // The card names each repository beside its own pull request. One link per repo, each
  // pointing at that repo's pull request - which is the thing a single outcome link could
  // never say.
  const card = dashboard.locator("article.card").first();
  const primaryLink = card.getByRole("link", { name: /demo-repo/ });
  const secondLink = card.getByRole("link", { name: /second-repo/ });
  await expect(primaryLink).toHaveAttribute("href", PR_PRIMARY);
  await expect(secondLink).toHaveAttribute("href", PR_SECOND);
  await shoot(dashboard, "both-open", card);

  // The PRIMARY repo's pull request merges first, which is the case a quorum-less build gets
  // wrong: before this phase, one merged pull request on the task's own binding - and the
  // primary's is exactly that - concluded the whole task.
  scriptPullRequests(daemon, task, { primary: true });
  await expect(
    dashboard.locator(".tt-desc", {
      hasText: `${daemon.repo} (primary repo) - pull request #10 merged`,
    }),
  ).toHaveCount(1);

  // The task does NOT finish, because the attached repo's work has not landed.
  //
  // Sampled over several poll ticks rather than asserted once. A web-first assertion cannot
  // see a state that is briefly right and then wrong, and "did not complete" is exactly the
  // claim a single read would pass by being taken too early.
  const statuses: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const tasks = await api<TaskRow[]>(daemon, "/api/tasks");
    statuses.push(tasks.find((t) => t.id === task.id)?.status ?? "gone");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  expect(new Set(statuses)).toEqual(new Set(["running"]));
  await expect(secondLink).toHaveAttribute("href", PR_SECOND);
  await shoot(dashboard, "primary-merged-task-running", card);

  // The attached repo lands too, and only now is the task over - with BOTH pull requests named.
  scriptPullRequests(daemon, task, { primary: true, second: true });
  await expect
    .poll(
      async () =>
        (await api<TaskRow[]>(daemon, "/api/tasks")).find((t) => t.id === task.id)?.status,
      { timeout: 30_000, message: "every changed repo has merged, so the task is done" },
    )
    .toBe("done");

  // The browser agreeing, not just the API: the card itself carries the finished task.
  await expect(card.locator(".task-chip.task-done")).toHaveCount(1);
  await shoot(dashboard, "both-merged-task-done", card);

  const done = (await api<TaskRow[]>(daemon, "/api/tasks")).find((t) => t.id === task.id)!;
  expect(done.outcome).toBe(`merged ${PR_PRIMARY}, ${PR_SECOND}`);
  // The scalar link stays the primary's, which is what every existing consumer means by it.
  expect(done.outcomeUrl).toBe(PR_PRIMARY);
  // And the per-repo state reached the wire on the fields phase 1 reserved.
  expect(done.extraRepos.map((e) => e.prUrl)).toEqual([PR_SECOND]);
});

test("a single-repo task still shows one outcome and no per-repo lines", async ({
  dashboard,
  daemon,
}) => {
  // The other half of the promise. Everything above is reached through an attached repo, and
  // a task without one must look exactly as it did before any of this existed.
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Write a haiku about flexbox");
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  const session = await settledSession(daemon);
  const task = await provisionedTask(daemon, 0);
  await announcePullRequests(daemon, session, [PR_PRIMARY]);
  // Scripted, so the poller CONFIRMS the chip the hook drew optimistically rather than
  // retracting it a tick later - which is what it correctly does for a branch `gh` reports
  // no pull request on, and would make the absence below prove nothing.
  scriptPullRequests(daemon, task);

  const card = dashboard.locator("article.card").first();
  await expect(card).toBeVisible();
  // The session's own PR chip is unchanged and still there; the per-repo list is not drawn at
  // all. Asserted as absence AFTER a pull request exists, so this cannot pass by nothing
  // having happened yet.
  await expect(card.locator(".pr-chip")).toHaveCount(1);
  await expect(card.locator(".task-repo-pr")).toHaveCount(0);
  await shoot(dashboard, "single-repo-unchanged", card);
});
