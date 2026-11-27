import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { WorkflowInspectorGateState, WorkflowRunDetail } from "../../src/shared/workflow.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { readGhCiRuns, writeGhPullRequests } from "../fixtures/fake-agents.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Local review replaces the GitHub round.
 *
 * A change the Local Inspector passed is pushed once, the real Inspector worker observes its
 * pull request through the fake `gh`, the workflow manager answers that the head's tree is the
 * tree the local review read, and the run completes with no GitHub review and no comment. The
 * fallbacks keep today's GitHub review: a repository holding the merge grant, and a later push
 * whose content differs.
 *
 * Real: the dispatched session and worktree, the published workflow, the Local Inspector stage
 * (answered by the repository-review fixture, no model tokens), the Pull Request action's Live
 * delivery and the agent's turn, adoption through the daemon's `prCreated` hook, the Inspector
 * worker's sweep, the manager's match, the gate, and the dashboard reading all of it back.
 * Stood in for: GitHub itself, by the scripted fake `gh`; the push goes to the fixture's local
 * origin.
 *
 * The Pull Request action seals the checkout right after adoption, and that repository capture
 * refuses when an Inspector observation lands inside it - a race that predates this phase (it
 * reproduces with the local match turned off). `reviewLocallyAndPublish` therefore lets the fake
 * GitHub report the pull request only after the gate is waiting. The first read before that fails,
 * which earns the row one poll interval of backoff before the worker's next review decision, so
 * the waits below allow for it.
 */
test.use({ daemonEnv: { MISSION_INSPECTOR_POLL_MS: "5000", MISSION_PR_POLL_MS: "3600000" } });

const PR_NUMBER = 77;
const PR_URL = `https://github.com/owner/repo/pull/${PR_NUMBER}`;
const PR_KEY = `owner/repo#${PR_NUMBER}`;
const BRANCH = "e2e/local-review";
const EVIDENCE = artifactsDir("local-review-gate");

async function api<T>(daemon: DaemonHandle, path: string, data?: unknown, method = data === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, {
    method, ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
  });
  expect(response.ok, `${path} ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/local-review-gate/${name}.png`);
}

/** Every `gh` invocation the daemon made, as the fake recorded it. */
function ghCalls(daemon: DaemonHandle): string[][] {
  return readdirSync(daemon.recordDir).filter((name) => /^gh-\d/.test(name)).sort()
    .map((name) => (JSON.parse(readFileSync(join(daemon.recordDir, name), "utf8")) as { argv: string[] }).argv);
}
const githubWrites = (daemon: DaemonHandle) => ghCalls(daemon)
  .filter((argv) => argv.includes("POST") && argv.some((arg) => /\/pulls\/\d+\/(reviews|comments)/.test(arg)));
/** Every Inspector read of the pull request, one per worker sweep that observed it. */
const prReads = (daemon: DaemonHandle) => ghCalls(daemon)
  .filter((argv) => argv.includes("graphql") && argv.some((arg) => arg === `number=${PR_NUMBER}`));

const diffReads = (daemon: DaemonHandle) => ghCalls(daemon)
  .filter((argv) => argv.some((arg) => arg === `repos/owner/repo/pulls/${PR_NUMBER}`));

interface Ledger {
  key: string; headSha: string | null; reviewPosture: string | null; localReviewHeadSha?: string | null;
  observedHeadSha: string | null; round: number;
}
const ledger = async (daemon: DaemonHandle) =>
  (await api<Ledger[]>(daemon, "/api/inspector/prs")).find((row) => row.key === PR_KEY);

/** The daemon's own adoption signal: the hook a harness fires when `gh pr create` returns. */
async function announcePullRequest(daemon: DaemonHandle, sessionId: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const session = (await api<Array<{ id: string; agent: string; cwd: string; agentSessionId: string | null }>>(
    daemon, "/api/sessions")).find((item) => item.id === sessionId)!;
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ agent: session.agent, sessionId: session.agentSessionId ?? sessionId, cwd: session.cwd,
      prCreated: true, prUrl: PR_URL }),
  });
  expect(response.ok, `hook answered ${response.status}`).toBe(true);
}

/**
 * Run a Local Inspector workflow to a passed review, push the reviewed content once, and open
 * its pull request. Returns what the run reviewed and what reached the remote.
 */
async function reviewLocallyAndPublish(page: Page, daemon: DaemonHandle, options: {
  mode: "live" | "dry-run"; mergeGrant?: boolean; localReview?: boolean;
  /** False publishes a workflow version with no Local Inspector stage at all. */
  stage?: boolean;
}) {
  const localReview = options.localReview ?? true;
  const stage = options.stage ?? true;
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "local-inspector", enabled: true }, "PUT");
  await api(daemon, "/api/inspector/config", {
    enabled: true, mode: options.mode, repoAllowlist: [daemon.repo], localReview, runner: "codex", model: "gpt-5.6-sol",
  }, "PUT");
  await api(daemon, "/api/shipping/config", { repoAllowlist: options.mergeGrant ? [daemon.repo] : [] }, "PUT");
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true, checksEnabled: true, repoAllowlist: [daemon.repo], defaultWorkflowId: null, checkCommands: [],
  }, "PUT");

  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Ship the reviewed change. E2E_LOCAL_INSPECTOR_CLEAN");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let session: { id: string; cwd: string; state: string } | undefined;
  await expect.poll(async () => {
    session = (await api<Array<NonNullable<typeof session>>>(daemon, "/api/sessions")).find((s) => s.state === "idle");
    return Boolean(session);
  }).toBe(true);
  const checkout = session!.cwd;
  git(daemon.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  // The author's change, committed before review. The Local Inspector reads the same tree
  // either way, and nothing in the checkout moves while the workflow later seals it.
  git(checkout, "switch", "-q", "-c", BRANCH);
  writeFileSync(join(checkout, "submitted.txt"), "the reviewed change\n");
  git(checkout, "add", "submitted.txt");
  git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-qm", "The reviewed change");
  const head = git(checkout, "rev-parse", "HEAD");

  const origin = git(daemon.repo, "remote", "get-url", "origin");
  const remoteRefs = () => git(origin, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").split("\n").filter(Boolean);
  const refsBefore = remoteRefs();

  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Open the pull request", description: "Open the pull request for the reviewed work",
    promptMarkdown: "# Pull Request\n\nOpen the pull request for the reviewed work.\n", requiredSkillId: null,
    completion: { kind: "pull_request" },
  });
  const { workflow } = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Local review gate fixture",
    completionPolicy: { kind: "inspector", onFindings: "inspector_only", missingPrAction: "wait" },
    draft: stage ? {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "inspect", kind: "check", slot: "inspector", position: { x: 200, y: 0 } },
        { id: "pull-request", kind: "session_action", sessionActionId: action.id, position: { x: 400, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 600, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "inspect", targetPort: "activate" },
        { id: "pass", source: "inspect", sourcePort: "pass", target: "pull-request", targetPort: "activate" },
        { id: "repair", source: "inspect", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
        { id: "publish", source: "pull-request", sourcePort: "complete", target: "end", targetPort: "terminal" },
      ],
    } : {
      // The shape every version before the Local Inspector has: straight to the Pull Request.
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "pull-request", kind: "session_action", sessionActionId: action.id, position: { x: 400, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 600, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "pull-request", targetPort: "activate" },
        { id: "publish", source: "pull-request", sourcePort: "complete", target: "end", targetPort: "terminal" },
      ],
    },
  });
  const { version } = await api<{ version: { id: string } }>(daemon, `/api/workflows/${workflow.id}/publish`, { expectedDraftRevision: 1 });
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: version.id, sessionId: session!.id, deliveryMode: "live",
  });
  const { run } = await api<{ run: { id: string } }>(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "local-review-gate" });
  const detail = () => api<WorkflowRunDetail>(daemon, `/api/workflow-runs/${run.id}`);
  writeFileSync(join(daemon.home, "repository-review-ready"), "ready");

  // The Local Inspector passes with repository access (or skips with Local review off), and
  // only then is the action reached.
  await expect.poll(async () => (await detail()).attempts.find((a) => a.nodeId === "pull-request")?.state,
    { timeout: 60_000 }).toBe("waiting");
  const inspected = (await detail()).attempts.find((a) => a.nodeId === "inspect");
  expect(Boolean(inspected), "the version runs a Local Inspector stage exactly when it has one").toBe(stage);
  const reviewed = (inspected?.output ?? { status: "absent", localInspector: { status: "absent", publicationTree: "", baseRef: "" } }) as {
    status: string; localInspector: { status: string; publicationTree: string; baseRef: string };
  };
  if (stage) {
    expect(reviewed).toMatchObject(localReview
      ? { status: "passed", localInspector: { status: "passed", baseRef: "refs/remotes/origin/main" } }
      : { status: "skipped", localInspector: { status: "skipped" } });
  }
  expect(remoteRefs(), "nothing reaches the remote before the Pull Request action").toEqual(refsBefore);
  await expect.poll(async () => (await detail()).summary.actionWait, { timeout: 90_000 }).toBe("awaiting_pull_request");

  // The author pushes exactly the reviewed content, once. By URL, so no remote-tracking ref in
  // the checkout moves while the Pull Request action's continuation is captured.
  if (stage && localReview) {
    expect(git(checkout, "rev-parse", "HEAD^{tree}"), "the pushed tree is the tree the local review read")
      .toBe(reviewed.localInspector.publicationTree);
  }
  git(checkout, "push", "-q", origin, `HEAD:refs/heads/${BRANCH}`);
  const pushed = remoteRefs().filter((ref) => !refsBefore.includes(ref));
  expect(pushed, "one push").toEqual([`refs/heads/${BRANCH} ${head}`]);

  // GitHub answers for the pull request only once the action's continuation is captured and the
  // gate is waiting. Adoption needs no provider read, and an Inspector observation landing inside
  // that repository capture makes it refuse ("The repository changed during both capture
  // attempts"), a race that predates this phase. Holding the read back keeps every observation
  // after the capture, so no case here depends on when the poll happens to tick.
  writeGhPullRequests(daemon.home, []);
  await announcePullRequest(daemon, session!.id);
  await expect.poll(async () => (await detail()).run.status, { timeout: 120_000 }).toBe("waiting_for_inspector");
  writeGhPullRequests(daemon.home, [{
    cwd: realpathSync(checkout), number: PR_NUMBER, url: PR_URL, state: "OPEN", createdAt: new Date().toISOString(),
    mergedAt: null, headRefOid: head, headRefName: BRANCH, baseRefName: "main",
  }]);
  return { runId: run.id, detail, head, checkout, origin, publicationTree: reviewed.localInspector.publicationTree, remoteRefs };
}

/** Wait for the run to reach `status`, printing its events if it never does. */
async function settles(daemon: DaemonHandle, detail: () => Promise<WorkflowRunDetail>, status: string): Promise<void> {
  try {
    await expect.poll(async () => (await detail()).run.status, { timeout: 120_000 }).toBe(status);
  } catch (error) {
    const final = await detail();
    console.log("RUN EVENTS", JSON.stringify(final.events.map((event) => [event.kind, event.payload]), null, 1).slice(-6000));
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-40).join("\n")}`);
    throw error;
  }
}

const gateOf = (detail: WorkflowRunDetail) => detail.inspectorGate?.state as WorkflowInspectorGateState | undefined;

test("No-Mistakes Review version 23 runs the Local Inspector last before the Pull Request action", async ({ dashboard, daemon }) => {
  await dashboard.setViewportSize({ width: 1440, height: 900 });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /No-Mistakes Review/ }).click();
  await expect(dashboard.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("No-Mistakes Review (High Rigor)");
  const stages = dashboard.locator(".wf-pipeline-strip section.wf-pipeline-stage");
  await expect(stages).toHaveCount(7);
  await expect(stages.nth(5).locator(".wf-pipeline-stage-name")).toHaveText("Command · Local Inspector");
  await expect(stages.nth(5).locator(".wf-pipeline-reviewer-name")).toHaveText(["Commandinspector"]);
  await expect(stages.nth(6).locator(".wf-pipeline-stage-name")).toHaveText("Pull Request");
  await stages.nth(5).scrollIntoViewIfNeeded();
  await shoot(dashboard, dashboard.locator(".wf-pipeline-strip"), "no-mistakes-v23-pipeline");
});

test("Settings explains which heads skip the GitHub review", async ({ dashboard, daemon }) => {
  await api(daemon, "/api/feature-flags", { kind: "flag", id: "local-inspector", enabled: true }, "PUT");
  await dashboard.goto(daemon.baseURL + "/#/settings/inspector");
  const control = dashboard.getByRole("checkbox", { name: "Review in the workflow before the pull request opens" });
  await expect(control).toBeVisible();
  const card = dashboard.locator(".sc-card").filter({ has: control });
  await expect(card).toContainText("a pushed head whose content matches a passed local review gets no GitHub review and no comments");
  await expect(card).toContainText("Repositories holding the merge grant keep the GitHub review for every head.");
  await shoot(dashboard, card, "settings-local-review");
});

for (const mode of ["live", "dry-run"] as const) {
  test(`${mode}: a pushed head matching the passed local review completes with no GitHub review`, async ({ dashboard, daemon }) => {
    test.setTimeout(180_000);
    const run = await reviewLocallyAndPublish(dashboard, daemon, { mode });

    await settles(daemon, run.detail, "completed");
    const done = await run.detail();
    expect(gateOf(done)?.localReview).toMatchObject({ headSha: run.head, treeOid: run.publicationTree, baseRef: "refs/remotes/origin/main" });
    expect(done.events.find((event) => event.kind === "inspector_gate_clean")?.payload).toMatchObject({ path: "local" });

    // The worker kept observing and recorded the head without a GitHub round. Dry run never
    // produces a `local` head.
    await expect.poll(async () => (await ledger(daemon))?.localReviewHeadSha, { timeout: 60_000 }).toBe(run.head);
    const row = (await ledger(daemon))!;
    expect(row).toMatchObject({ headSha: run.head, observedHeadSha: run.head, round: 0,
      reviewPosture: mode === "live" ? "local" : "dry-run" });
    expect(githubWrites(daemon), "nothing was posted to the pull request").toEqual([]);
    expect(diffReads(daemon), "no GitHub review read the pull request's diff").toEqual([]);
    expect(run.remoteRefs().filter((ref) => ref.startsWith(`refs/heads/${BRANCH} `))).toEqual([`refs/heads/${BRANCH} ${run.head}`]);

    // One CI run, started when GitHub first reported the opened pull request at the reviewed head -
    // and it stays one. The worker goes on observing the pull request for two more sweeps, the
    // run stays completed, and nothing asks the session to repair and push again: no Inspector
    // feedback packet exists, so no new head and no second CI run.
    const opened = [{ number: PR_NUMBER, headSha: run.head, event: "opened" }];
    expect(readGhCiRuns(daemon.home), "one CI run, on the pull request opening").toEqual(opened);
    const sweeps = prReads(daemon).length;
    await expect.poll(() => prReads(daemon).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(sweeps + 2);
    expect(readGhCiRuns(daemon.home), "still exactly one CI run after continued observation").toEqual(opened);
    const settled = await run.detail();
    expect(settled.run.status).toBe("completed");
    expect(settled.deliveries.filter((delivery) => delivery.kind === "inspector_feedback")).toEqual([]);
    expect(githubWrites(daemon)).toEqual([]);
    console.log(`CI RUNS (${mode}): ${JSON.stringify(readGhCiRuns(daemon.home))}; Inspector reads of #${PR_NUMBER}: `
      + `${sweeps} at completion, ${prReads(daemon).length} after two more sweeps; inspector_feedback deliveries: 0; GitHub writes: 0`);

    await dashboard.goto(`${daemon.baseURL}/#/runs/${run.runId}`);
    await dashboard.getByRole("tab", { name: /^Completion/ }).click();
    const pane = dashboard.getByRole("tabpanel", { name: /^Completion/ });
    await expect(pane).toContainText("Reviewed locally");
    await expect(pane).toContainText(`Reviewed locally: pull request head ${run.head.slice(0, 12)} has the tree`);
    await expect(pane).toContainText("so no GitHub review ran and nothing was posted");
    const local = pane.getByRole("region", { name: "Local Inspector review" });
    await expect(local.getByRole("heading", { name: "Local Inspector findings" })).toBeVisible();
    await expect(local).toContainText("Local Inspector found no unresolved issues.");
    await shoot(dashboard, pane, `completion-reviewed-locally-${mode}`);

    // The rail leaves clean marks out, so the chip is read where it is drawn: the session.
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    const chip = dashboard.locator(".console-detail")
      .getByRole("link", { name: /^GitHub Inspector: reviewed locally before the pull request opened/ });
    await expect(chip).toBeVisible({ timeout: 60_000 });
    await expect(chip).toContainText("✓");
    await expect(chip).toHaveAccessibleName(/No GitHub review ran and nothing was posted/);
    await shoot(dashboard, chip, `chip-reviewed-locally-${mode}`);
  });
}

for (const fallback of ["merge-grant", "skipped-stage", "no-stage"] as const) test(fallback === "merge-grant"
  ? "a repository holding the merge grant keeps the GitHub review for a matching head"
  : fallback === "skipped-stage"
    ? "a skipped Local Inspector stage keeps the GitHub review"
    : "a workflow version without the Local Inspector stage keeps the GitHub review", async ({ dashboard, daemon }) => {
  test.setTimeout(180_000);
  // The no-stage case keeps Local review on, so the version is the only thing that differs.
  const run = await reviewLocallyAndPublish(dashboard, daemon, fallback === "merge-grant"
    ? { mode: "live", mergeGrant: true }
    : fallback === "skipped-stage" ? { mode: "live", localReview: false } : { mode: "live", stage: false });

  // The gate reaches the point where it waits for the GitHub Inspector, and the worker reviews.
  await expect.poll(async () => (await run.detail()).run.currentPhase, { timeout: 120_000 })
    .toMatch(/^inspector_(review|review_error|review_backoff|clean_review)$/);
  await expect.poll(() => diffReads(daemon).length, { timeout: 60_000 }).toBeGreaterThan(0);
  const detail = await run.detail();
  expect(detail.run.status).not.toBe("completed");
  expect(gateOf(detail)?.localReview).toBeUndefined();
  expect((await ledger(daemon))?.localReviewHeadSha ?? null).toBeNull();

  await dashboard.goto(`${daemon.baseURL}/#/runs/${run.runId}`);
  await dashboard.getByRole("tab", { name: /^Completion/ }).click();
  const pane = dashboard.getByRole("tabpanel", { name: /^Completion/ });
  await expect(pane).toBeVisible();
  await expect(pane).not.toContainText("Reviewed locally");
  await expect(pane.getByRole("region", { name: "Local Inspector review" })).toHaveCount(0);
  await shoot(dashboard, pane, `completion-${fallback}-github-path`);
});

test("a later push whose content differs is reviewed on GitHub as before", async ({ dashboard, daemon }) => {
  test.setTimeout(180_000);
  const run = await reviewLocallyAndPublish(dashboard, daemon, { mode: "live" });
  await settles(daemon, run.detail, "completed");
  await expect.poll(async () => (await ledger(daemon))?.reviewPosture, { timeout: 60_000 }).toBe("local");
  expect(diffReads(daemon)).toEqual([]);

  // A CI repair: new content, pushed to the same pull request.
  writeFileSync(join(run.checkout, "submitted.txt"), "the reviewed change, repaired after CI\n");
  git(run.checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-qam", "Repair after CI");
  const repaired = git(run.checkout, "rev-parse", "HEAD");
  git(run.checkout, "push", "-q", run.origin, `HEAD:refs/heads/${BRANCH}`);
  writeGhPullRequests(daemon.home, [{
    cwd: realpathSync(run.checkout), number: PR_NUMBER, url: PR_URL, state: "OPEN", createdAt: new Date().toISOString(),
    mergedAt: null, headRefOid: repaired, headRefName: BRANCH, baseRefName: "main",
  }]);

  // The worker sees the new head, finds no match, and starts a GitHub review of it. The new head
  // is also GitHub's second CI run, which is what the local path avoids.
  await expect.poll(async () => (await ledger(daemon))?.observedHeadSha, { timeout: 60_000 }).toBe(repaired);
  expect(readGhCiRuns(daemon.home)).toEqual([
    { number: PR_NUMBER, headSha: run.head, event: "opened" },
    { number: PR_NUMBER, headSha: repaired, event: "synchronize" },
  ]);
  await expect.poll(() => diffReads(daemon).length, { timeout: 60_000 }).toBeGreaterThan(0);
  expect((await ledger(daemon))?.localReviewHeadSha, "the local record still names only the reviewed head").toBe(run.head);

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const chip = dashboard.locator(".console-detail").getByRole("link", { name: /^GitHub Inspector:/ });
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expect(chip).not.toHaveAccessibleName(/reviewed locally/);
  await shoot(dashboard, chip, "chip-after-different-push");
});
