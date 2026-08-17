import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { writeGhPullRequests, type FakePullRequest } from "../fixtures/fake-agents.ts";

// The branch poller ships at 20s, which is a spec's whole budget spent waiting. Only this file
// pays the faster cadence - it is what associates each repository's pull request with the
// repository, and that association is what "changed" is read from.
test.use({ daemonEnv: { MISSION_PR_POLL_MS: "400" } });

// One review per repository a task changed, concurrently, with unchanged repositories skipped.
//
// This is the only layer that can prove it. The binding's repository dimension, the changed-set
// predicate and the chip fan-out are each testable in isolation and each individually correct
// while the thing an operator asked for does not happen: a two-repo task showing one review, or
// a repository's changes shipping with no review at all because the run that should have covered
// it was never created.
//
// Three real mechanisms and one stand-in that is honest about what it is:
//
//  - REAL: the dispatch, the two worktrees, the daemon's own adoption path (a `prCreated` hook
//    carrying BOTH urls), the changed-set evaluation at trigger time, the runs, the bindings,
//    and the browser.
//  - STOOD IN FOR: the reviewer's verdict. A Persona is a model call, so the fake agent answers
//    from a marker in the persona's guidance - which is how every workflow spec here seeds a
//    run's outcome without spending a token.
//
// No model tokens: every agent binary is a fake (see `fake-agents.ts`).

const EVIDENCE = artifactsDir("multi-repo-workflow-runs");

const PR_PRIMARY = "https://github.com/example/demo-repo/pull/10";
const PR_SECOND = "https://github.com/example/second-repo/pull/20";

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await (target ?? page).screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/multi-repo-workflow-runs/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
}

interface RunRow {
  id: string;
  bindingId: string;
  sessionId: string | null;
  status: string;
  repoRoot?: string | null;
}

interface TaskRow {
  id: string;
  worktreePath: string | null;
  extraRepos: Array<{ repoRoot: string; worktreePath: string | null; prUrl: string | null }>;
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
  // Pinned to none for the reason every launch helper here gives: left at the dispatch default
  // the configured Workflow arms live delivery, which this repo is not allowlisted for, and the
  // dispatch is refused. The review below is bound explicitly instead, in Preview.
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

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
        return Boolean(task?.worktreePath && task.extraRepos.every((e) => e.worktreePath));
      },
      { message: "one worktree per attached repo, recorded on the task" },
    )
    .toBe(true);
  return task!;
}

/** Model the agent creating its feature branch after native detached acquisition. */
function createTaskBranches(task: TaskRow): void {
  const paths = [task.worktreePath, ...task.extraRepos.map((entry) => entry.worktreePath)];
  for (const path of paths) {
    if (path) execFileSync("git", ["-C", path, "switch", "-q", "-c", "e2e/multi-repo-run"]);
  }
}

/**
 * What `gh pr list` reports, per checkout - which is how this spec chooses which repositories
 * the turn changed.
 *
 * A pull request is one of the two ways the shared changed-set predicate reads a repository as
 * changed, and the fake agent commits nothing so no head ever moves off its baseline. That
 * leaves this as the whole lever, and it goes through the REAL machinery: one `gh` call per
 * worktree cwd, then the per-repo association that decides which repository owns which pull
 * request. Scripting one worktree and not the other is the only honest way to arrange a task
 * that genuinely changed one repository.
 */
function scriptPullRequests(
  daemon: DaemonHandle,
  task: TaskRow,
  which: { primary?: boolean; second?: boolean },
): void {
  const createdAt = new Date().toISOString();
  const row = (cwd: string, url: string, number: number): FakePullRequest => ({
    cwd,
    url,
    number,
    state: "OPEN",
    createdAt,
    mergedAt: null,
    headRefOid: "0".repeat(40),
  });
  const second = task.extraRepos[0]?.worktreePath ?? null;
  writeGhPullRequests(daemon.home, [
    ...(which.primary ? [row(task.worktreePath!, PR_PRIMARY, 10)] : []),
    ...(which.second && second ? [row(second, PR_SECOND, 20)] : []),
  ]);
}

/**
 * The hook a harness fires when `gh pr create` returns, carrying EVERY url it printed - the
 * daemon's own adoption path.
 *
 * Adoption is what puts a pull request in the Inspector ledger; the per-repo ASSOCIATION comes
 * from the poller (`scriptPullRequests`). Both are needed and they answer different questions,
 * so this spec drives both rather than letting one stand in for the other.
 */
async function announcePullRequests(
  daemon: DaemonHandle,
  session: SessionRow,
  urls: string[],
): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/PostToolUse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      toolName: "Bash",
      prCreated: true,
      prUrl: urls[0],
      prUrls: urls,
    }),
  });
  if (!response.ok) throw new Error(`PostToolUse answered ${response.status}`);
  await expect
    .poll(
      async () => (await api<Array<{ url: string }>>(daemon, "/api/inspector/prs"))
        .map((p) => p.url).sort(),
      { message: "every announced pull request is adopted" },
    )
    .toEqual([...urls].sort());
}

/** Wait until the attached repo's own pull request has reached the task, or has not. */
async function attachedRepoPr(daemon: DaemonHandle, taskId: string, url: string | null): Promise<void> {
  await expect
    .poll(
      async () => {
        const tasks = await api<TaskRow[]>(daemon, "/api/tasks");
        return tasks.find((t) => t.id === taskId)?.extraRepos[0]?.prUrl ?? null;
      },
      {
        timeout: 30_000,
        message: `the attached repo should own ${url ?? "no pull request"}`,
      },
    )
    .toBe(url);
}

/** Publish a one-reviewer workflow and bind it to the session in Preview. */
async function bindReview(daemon: DaemonHandle, sessionId: string): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "E2E multi-repo reviewer",
    guidanceMarkdown: "# E2E multi-repo reviewer\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E multi-repo review",
    draft: {
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
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  return binding.id;
}

/** Every run this session is carrying, once `expected` of them have settled off `capturing`. */
async function settledRuns(daemon: DaemonHandle, sessionId: string, expected: number): Promise<RunRow[]> {
  let runs: RunRow[] = [];
  await expect
    .poll(
      async () => {
        const page = await api<{ items: RunRow[] }>(
          daemon,
          `/api/workflow-runs?session=${encodeURIComponent(sessionId)}&limit=50`,
        );
        runs = page.items;
        return runs.length === expected && runs.every((r) => r.status !== "capturing")
          ? expected
          : -1;
      },
      { timeout: 60_000, message: `the session should carry ${expected} settled review(s)` },
    )
    .toBe(expected);
  return runs;
}

test("a two-repo task runs one review per changed repo, each named on the card", async ({
  dashboard,
  daemon,
}) => {
  await dispatchAcross(dashboard, daemon);
  const session = await settledSession(daemon);
  const task = await provisionedTask(daemon);
  createTaskBranches(task);

  // One command, two pull requests: both repositories changed.
  await announcePullRequests(daemon, session, [PR_PRIMARY, PR_SECOND]);
  scriptPullRequests(daemon, task, { primary: true, second: true });
  await attachedRepoPr(daemon, task.id, PR_SECOND);
  const bindingId = await bindReview(daemon, session.id);
  await api(daemon, `/api/workflow-bindings/${bindingId}/submit`, {
    requestId: "e2e-multi-repo-review",
  });

  // Two runs, on two different bindings, one per repository - which is the whole feature.
  const runs = await settledRuns(daemon, session.id, 2);
  expect(new Set(runs.map((r) => r.bindingId)).size).toBe(2);
  expect(runs.map((r) => r.repoRoot).sort()).toEqual([daemon.repo, daemon.secondRepo].sort());

  // The operator sees one chip per run, each naming the repository it reviews. A single chip
  // here would hide a repository's review behind whichever run updated last.
  const card = dashboard.locator("article.card").first();
  const chips = card.locator(".workflow-chip");
  await expect(chips).toHaveCount(2);
  await expect(card.locator(".workflow-chip-repo", { hasText: "demo-repo" })).toHaveCount(1);
  await expect(card.locator(".workflow-chip-repo", { hasText: "second-repo" })).toHaveCount(1);
  await shoot(dashboard, "two-repo-chips", card);

  // Each chip opens its OWN run, and the run page names that run's repository. Clicking the
  // attached repo's chip must not land on the primary's review.
  await card.getByRole("button", { name: /second-repo/ }).click();
  const secondRun = runs.find((r) => r.repoRoot === daemon.secondRepo)!;
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${secondRun.id}$`));
  await expect(dashboard.locator(".wf-run-repo")).toHaveText("second-repo");
  await shoot(dashboard, "attached-repo-run", dashboard.locator(".wf-run-head"));
});

test("a repo the task never changed gets no review at all", async ({ dashboard, daemon }) => {
  // The other half of the promise, and the one a permissive build gets wrong quietly: a
  // review of a repository nobody touched holds its pull request behind a verdict about
  // nothing, and - because the gate's candidate is repository-scoped - would be the run that
  // pins whatever pull request the session's own branch happens to carry.
  await dispatchAcross(dashboard, daemon);
  const session = await settledSession(daemon);
  const task = await provisionedTask(daemon);
  createTaskBranches(task);

  // Only the ATTACHED repo changed. The primary is deliberately the untouched one, because a
  // predicate that privileged it - or that iterated attached repos alone - passes a test where
  // the primary is the changed one and fails here.
  await announcePullRequests(daemon, session, [PR_SECOND]);
  scriptPullRequests(daemon, task, { second: true });
  await attachedRepoPr(daemon, task.id, PR_SECOND);
  const bindingId = await bindReview(daemon, session.id);
  await api(daemon, `/api/workflow-bindings/${bindingId}/submit`, {
    requestId: "e2e-single-changed-repo",
  });

  const runs = await settledRuns(daemon, session.id, 1);
  expect(runs[0]?.repoRoot).toBe(daemon.secondRepo);

  // One chip, and it is the attached repository's. Sampled over several ticks rather than
  // asserted once: "no second review appeared" is exactly the claim a single early read
  // passes by being taken before the second one would have been created.
  const card = dashboard.locator("article.card").first();
  await expect(card.locator(".workflow-chip")).toHaveCount(1);
  for (let i = 0; i < 5; i += 1) {
    const page = await api<{ items: RunRow[] }>(
      daemon,
      `/api/workflow-runs?session=${encodeURIComponent(session.id)}&limit=50`,
    );
    expect(page.items.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await shoot(dashboard, "unchanged-repo-skipped", card);
});

test("a single-repo task still shows exactly one unnamed workflow chip", async ({
  dashboard,
  daemon,
}) => {
  // Single-repo behaviour is byte-identical, and this is where that is asserted through a
  // browser: one chip, and no repository name on it. The name is the disambiguator between
  // siblings, so a session with no sibling must not carry one.
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
  createTaskBranches(task);
  await announcePullRequests(daemon, session, [PR_PRIMARY]);
  scriptPullRequests(daemon, task, { primary: true });
  const bindingId = await bindReview(daemon, session.id);
  await api(daemon, `/api/workflow-bindings/${bindingId}/submit`, {
    requestId: "e2e-single-repo-review",
  });
  await settledRuns(daemon, session.id, 1);

  const card = dashboard.locator("article.card").first();
  await expect(card.locator(".workflow-chip")).toHaveCount(1);
  await expect(card.locator(".workflow-chip-repo")).toHaveCount(0);
  await shoot(dashboard, "single-repo-unchanged", card);
});
