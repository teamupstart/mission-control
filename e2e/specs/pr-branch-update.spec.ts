import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { writeGhPullRequests, type FakePullRequest } from "../fixtures/fake-agents.ts";
import { expect, test } from "../fixtures/test.ts";

test.use({ daemonEnv: { MISSION_PR_POLL_MS: "300" } });
const PR_NUMBER = 1545;
const PR_URL = `https://github.com/acme/mission-e2e/pull/${PR_NUMBER}`;
interface SessionRow {
  id: string;
  state: string;
  agent: string;
  cwd: string;
  agentSessionId: string | null;
  transcriptPath: string | null;
  prNumber: number | null;
  prChecks: string | null;
}

interface TaskRow {
  worktreePath: string | null;
  extraRepos: Array<{ worktreePath: string | null }>;
}

async function api<T>(daemon: DaemonHandle, path: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as T;
}

async function dispatch(page: Page, daemon: DaemonHandle, attachedRepo?: string): Promise<SessionRow> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  if (attachedRepo) {
    await dialog.getByRole("button", { name: "Add another repo" }).click();
    await dialog.getByPlaceholder("repo to attach…").fill(attachedRepo);
    await page.keyboard.press("Escape");
    await dialog.getByRole("button", { name: "Attach repo" }).click();
  }
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
async function announcePullRequest(daemon: DaemonHandle, session: SessionRow, urls = [PR_URL]): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      prCreated: true,
      prUrl: urls[0],
      prUrls: urls,
    }),
  });
  expect(response.ok, await response.text()).toBe(true);
}


// Real dispatch, PR poller, SQLite claims, GitHub adapter and SSE; only external agents and GitHub are faked.
test("manual-merge PR updates once, follows the new checks/review, and offers conflict recovery", async ({ dashboard: page, daemon }) => {
  const session = await dispatch(page, daemon);
  const worktree = await featureWorktree(daemon);
  await announcePullRequest(daemon, session);
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const header = page.locator("header.detail-head");
  const calls = () => readdirSync(join(daemon.home, "agent-records")).filter(n => n.startsWith("gh-")).map(n =>
    JSON.parse(readFileSync(join(daemon.home, "agent-records", n), "utf8")) as { argv: string[] });
  const writes = () => calls().filter(c => c.argv.some(a => a.endsWith("/update-branch")));
  const pr = { cwd: worktree, url: PR_URL, number: PR_NUMBER, state: "OPEN" as const,
    createdAt: new Date().toISOString(), mergedAt: null, headRefOid: "a".repeat(40),
    checkContexts: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
    branchUpdate: { mergeStateStatus: "BEHIND", baseRefOid: "b".repeat(40), reviewDecision: "APPROVED", refusal: "" } };
  const script = () => writeGhPullRequests(daemon.home, [pr]);
  script();
  await expect(header.locator(".pr-chip")).toHaveAttribute("href", PR_URL);
  expect(writes()).toHaveLength(0); // preview disabled; shipping/Inspector also remain at defaults
  const flag = async (enabled: boolean) => {
    const r = await fetch(`${daemon.baseURL}/api/feature-flags`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "flag", id: "automatic-pr-branch-update", enabled }) });
    expect(r.ok).toBe(true);
  };
  await flag(true);
  await expect(header.getByText("Updating branch", { exact: true })).toBeVisible();
  await expect.poll(() => writes().length).toBe(1);
  expect(writes()[0]!.argv).toContain(`expected_head_sha=${pr.headRefOid}`);
  const capture = async (name: string) => {
    if (!process.env.MC_E2E_EVIDENCE) return;
    mkdirSync(artifactsDir("pr-branch-update"), { recursive: true });
    await page.screenshot({ path: join(artifactsDir("pr-branch-update"), name), fullPage: true });
  };
  await capture("updating.png");
  pr.headRefOid = "c".repeat(40); pr.branchUpdate.mergeStateStatus = "BLOCKED";
  pr.branchUpdate.reviewDecision = "REVIEW_REQUIRED"; pr.checkContexts[0]!.state = "PENDING"; script();
  await expect(header.getByText("Waiting for checks", { exact: true })).toBeVisible();
  await capture("checks.png");
  pr.checkContexts[0]!.state = "SUCCESS"; script();
  await expect(header.getByText("Waiting for review", { exact: true })).toBeVisible();
  pr.branchUpdate.reviewDecision = "APPROVED"; pr.branchUpdate.mergeStateStatus = "CLEAN"; script();
  await expect(header.locator(".pr-branch-update")).toHaveCount(0);
  expect(writes()).toHaveLength(1);
  pr.branchUpdate.baseRefOid = "d".repeat(40); pr.branchUpdate.mergeStateStatus = "BEHIND";
  pr.branchUpdate.refusal = "gh: merge conflict updating branch (HTTP 422)"; script();
  await expect(header.getByText("Branch update conflicts", { exact: true })).toBeVisible();
  const recovery = page.locator(".detail-pr-update");
  await expect(recovery.getByText(/merge conflict updating branch/)).toBeVisible();
  const resolve = recovery.getByRole("button", { name: "Send to session to resolve" });
  await expect(resolve).toHaveAccessibleDescription("Ask the owning session to resolve conflicts and push without merging the PR");
  await expect(recovery.getByRole("link", { name: "PR #1545" })).toHaveAccessibleDescription("Open this pull request on GitHub");
  const status = header.getByText("Branch update conflicts", { exact: true });
  await expect(status).not.toHaveAttribute("title");
  await status.hover();
  await expect(page.locator(".tooltip")).toContainText("merge conflict updating branch");
  await capture("conflict.png");
  await recovery.getByRole("button", { name: "Send to session to resolve" }).click();
  await expect(recovery.getByRole("button", { name: "Sent to session" })).toBeDisabled();
  const conflictPrompt = `Resolve the branch update conflicts for ${PR_URL}. Fetch its current target branch, merge it into the PR branch, resolve conflicts, run focused checks and push. Do not merge the pull request.`;
  // The fake provider writes this native user record only after receiving the prompt.
  // Resolve the transcript by the owning session's ID, so an acknowledged click or a
  // prompt delivered to a different session cannot satisfy the assertion.
  await expect.poll(async () => {
    const owner = (await api<SessionRow[]>(daemon, "/api/sessions")).find(candidate => candidate.id === session.id);
    return owner?.transcriptPath ? readFileSync(owner.transcriptPath, "utf8") : "";
  }, { message: "the PR's owning session must receive its conflict resolution prompt" })
    .toContain(JSON.stringify({ role: "user", content: conflictPrompt }));
  expect(writes()).toHaveLength(2);
  expect(calls().some(c => c.argv[0] === "pr" && c.argv[1] === "merge")).toBe(false);
  await flag(false);
  await expect(header.locator(".pr-branch-update")).toHaveCount(0);
});


test("an attached repository PR gets its own guarded update and progress beside its link", async ({ dashboard: page, daemon }) => {
  const session = await dispatch(page, daemon, daemon.secondRepo);
  const primaryWorktree = await featureWorktree(daemon);
  let attachedWorktree: string | null = null;
  await expect.poll(async () => {
    attachedWorktree = (await api<TaskRow[]>(daemon, "/api/tasks"))[0]?.extraRepos[0]?.worktreePath ?? null;
    return attachedWorktree;
  }).not.toBeNull();
  execFileSync("git", ["-C", attachedWorktree!, "switch", "-q", "-c", "e2e/attached-pr-update"]);
  const attachedUrl = "https://github.com/acme/second-repo/pull/1546";
  await announcePullRequest(daemon, session, [PR_URL, attachedUrl]);
  const createdAt = new Date().toISOString();
  const primary: FakePullRequest = {
    cwd: primaryWorktree, url: PR_URL, number: PR_NUMBER, state: "OPEN", createdAt,
    mergedAt: null, headRefOid: "e".repeat(40),
    checkContexts: [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
    branchUpdate: { mergeStateStatus: "CLEAN", baseRefOid: "b".repeat(40), reviewDecision: "APPROVED" },
  };
  const attached: FakePullRequest = {
    ...primary, cwd: attachedWorktree!, url: attachedUrl, number: 1546, headRefOid: "a".repeat(40),
    branchUpdate: { mergeStateStatus: "BEHIND", baseRefOid: "b".repeat(40), reviewDecision: "APPROVED" },
  };
  writeGhPullRequests(daemon.home, [primary, attached]);
  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const repos = page.locator(".task-repo-prs");
  const attachedLink = repos.getByRole("link", { name: /second-repo.*#1546/ });
  const attachedRow = repos.locator(":scope > span").filter({ has: page.getByRole("link", { name: /second-repo.*#1546/ }) });
  const primaryRow = repos.locator(":scope > span").filter({ has: page.getByRole("link", { name: /demo-repo.*#1545/ }) });
  await expect(attachedLink).toHaveAttribute("href", attachedUrl);
  const flag = await fetch(`${daemon.baseURL}/api/feature-flags`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "flag", id: "automatic-pr-branch-update", enabled: true }),
  });
  expect(flag.ok).toBe(true);
  await expect(attachedRow.getByText("Updating branch", { exact: true })).toBeVisible();
  await expect(primaryRow.locator(".pr-branch-update")).toHaveCount(0);
  await expect(page.locator("header.detail-head .pr-chip")).toHaveAttribute("href", PR_URL);
  await expect(page.locator("header.detail-head .pr-branch-update")).toHaveCount(0);
  const writes = () => readdirSync(join(daemon.home, "agent-records")).filter(n => n.startsWith("gh-")).map(n =>
    JSON.parse(readFileSync(join(daemon.home, "agent-records", n), "utf8")) as { argv: string[]; cwd: string })
    .filter(call => call.argv.some(arg => arg.endsWith("/update-branch")));
  await expect.poll(() => writes().length).toBe(1);
  expect(writes()[0]).toEqual({ cwd: attachedWorktree, argv: [
    "api", "--method", "PUT", "repos/acme/second-repo/pulls/1546/update-branch", "-f", `expected_head_sha=${attached.headRefOid}`,
  ] });
  const capture = async (name: string) => {
    if (!process.env.MC_E2E_EVIDENCE) return;
    mkdirSync(artifactsDir("pr-branch-update"), { recursive: true });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(artifactsDir("pr-branch-update"), name), fullPage: true });
  };
  await capture("attached-updating.png");
  attached.headRefOid = "c".repeat(40);
  attached.branchUpdate!.mergeStateStatus = "BLOCKED";
  attached.checkContexts = [{ __typename: "StatusContext", context: "ci", state: "PENDING" }];
  writeGhPullRequests(daemon.home, [primary, attached]);
  await expect(attachedRow.getByText("Waiting for checks", { exact: true })).toBeVisible();
  await expect(attachedLink).toHaveAttribute("href", attachedUrl);
  await expect(primaryRow.locator(".pr-branch-update")).toHaveCount(0);
  expect(writes()).toHaveLength(1);
  await capture("attached-checks.png");
});
