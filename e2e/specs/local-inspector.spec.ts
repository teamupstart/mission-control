import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { WorkflowCommandView, WorkflowRunDetail } from "../../src/shared/workflow.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

async function api<T>(daemon: DaemonHandle, path: string, data?: unknown, method = data === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(daemon.baseURL + path, {
    method, ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
  });
  expect(response.ok, `${path} ${response.status}`).toBe(true);
  return response.json();
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function screenshot(locator: Locator, name: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const directory = artifactsDir("local-inspector");
  mkdirSync(directory, { recursive: true });
  await locator.screenshot({ path: join(directory, name + ".png") });
}

const prGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "pull-request", kind: "session_action", sessionActionId: "builtin:pull-request", position: { x: 400, y: 0 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 600, y: 0 } },
  ],
  edges: [
    { id: "submit", source: "session", sourcePort: "submitted", target: "pull-request", targetPort: "activate" },
    { id: "publish", source: "pull-request", sourcePort: "complete", target: "end", targetPort: "terminal" },
  ],
};

const inspectorGraph = {
  nodes: [...prGraph.nodes, { id: "inspect", kind: "check", slot: "inspector", position: { x: 200, y: 0 } }],
  edges: [
    { ...prGraph.edges[0], target: "inspect" }, prGraph.edges[1],
    { id: "pass", source: "inspect", sourcePort: "pass", target: "pull-request", targetPort: "activate" },
    { id: "repair", source: "inspect", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

const flag = (daemon: DaemonHandle, enabled: boolean) =>
  api(daemon, "/api/feature-flags", { kind: "flag", id: "local-inspector", enabled }, "PUT");
const setting = "Review in the workflow before the pull request opens";
const commandUrl = "/api/workflow-commands/inspector";

test("preview exposes the setting, tuning and stage picker before Pull Request", async ({ dashboard, daemon }) => {
  await dashboard.goto(daemon.baseURL + "/#/settings/inspector");
  const control = dashboard.getByRole("checkbox", { name: setting });
  await expect(dashboard.getByRole("checkbox", { name: "Run GitHub Inspector" })).toBeVisible();
  await expect(control).toHaveCount(0);
  await flag(daemon, true);
  await expect(control).toBeEnabled();
  await expect(control).not.toBeChecked();
  await control.press("Space");
  await expect.poll(async () => (await api<{ localReview: boolean }>(daemon, "/api/inspector/config")).localReview).toBe(true);
  await screenshot(dashboard.locator(".sc-card").filter({ has: control }), "settings");

  await dashboard.goto(daemon.baseURL + "/#/library/commands/inspector");
  await expect(dashboard.getByRole("heading", { name: "Local Inspector", exact: true })).toBeVisible();
  await expect(dashboard.getByLabel("Blocking severity")).toHaveValue("major");
  await expect(dashboard.getByLabel("Blocking severity")).toHaveAccessibleDescription(
    "Choose the lowest severity that blocks the Pull Request action",
  );
  await expect(dashboard.getByLabel("How often this Command may run")).toHaveValue("10");
  await expect(dashboard.getByLabel("Timeout in minutes")).toHaveValue("10");
  const exhaustion = dashboard.getByLabel("When the run budget is exhausted");
  await expect(exhaustion).toHaveValue("block");
  await dashboard.getByLabel("Blocking severity").selectOption("minor");
  await exhaustion.selectOption("skip");
  const save = dashboard.getByRole("button", { name: "Save Command" });
  await save.click();
  await expect(save).toBeDisabled();
  await dashboard.reload();
  await expect(dashboard.getByLabel("Blocking severity")).toHaveValue("minor");
  await expect(exhaustion).toHaveValue("skip");
  await screenshot(dashboard.locator(".wf-command-editor"), "library");

  await api(daemon, "/api/workflows", { name: "Review before publication", draft: prGraph });
  await dashboard.goto(daemon.baseURL + "/#/workflows");
  await dashboard.getByRole("button", { name: /Review before publication/ }).click();
  await dashboard.getByRole("button", { name: "Insert a stage before Stage 1" }).click();
  const picker = dashboard.getByRole("combobox", { name: "Insert a stage before Stage 1" });
  await picker.selectOption({ label: "Command · Local Inspector" });
  const cards = dashboard.locator(".wf-pipeline-stage-name");
  await expect(cards).toHaveText(["Command · Local Inspector", "Pull Request"]);
  await screenshot(dashboard.locator(".wf-pipeline-strip"), "pipeline");

  await flag(daemon, false);
  await expect.poll(async () => (await api<{ localReview: boolean }>(daemon, "/api/inspector/config")).localReview).toBe(false);
  await dashboard.goto(daemon.baseURL + "/#/library/commands");
  const leaveDraft = dashboard.getByRole("dialog", { name: "Leave with unsaved changes" });
  await expectContentClearsBorder(leaveDraft);
  await leaveDraft.getByRole("button", { name: "Discard and leave" }).click();
  const library = dashboard.getByRole("complementary", { name: "Command library" });
  await expect(library.getByRole("heading", { name: "Commands" })).toBeVisible();
  await expect(library.getByRole("button", { name: /Local Inspector/ })).toHaveCount(0);
});

async function start(page: Page, daemon: DaemonHandle, options: {
  provider?: "claude" | "codex"; marker?: string; maxRuns?: number; maxRepairRounds?: number; exhaustion?: "skip" | "block";
  allowCommands?: boolean;
} = {}) {
  await flag(daemon, true);
  await api(daemon, "/api/inspector/config", {
    enabled: true, localReview: true, runner: options.provider ?? "codex",
    model: options.provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.6-sol",
  }, "PUT");
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true, checksEnabled: true, repoAllowlist: options.allowCommands === false ? [] : [daemon.repo],
    defaultWorkflowId: null, checkCommands: [],
  }, "PUT");
  if (options.maxRuns !== undefined) {
    const command = await api<WorkflowCommandView>(daemon, commandUrl);
    await api(daemon, commandUrl, { ...command, expectedRevision: command.revision, maxRuns: options.maxRuns,
      onBudgetExhausted: options.exhaustion ?? "block" }, "PUT");
  }
  const origin = git(daemon.repo, "remote", "get-url", "origin");
  const refs = () => git(origin, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");
  const originalRefs = refs();
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("Review the local change. " + (options.marker ?? ""));
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await expectContentClearsBorder(dialog);
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let session: { id: string; cwd: string; state: string } | undefined;
  await expect.poll(async () => {
    session = (await api<Array<NonNullable<typeof session>>>(daemon, "/api/sessions")).find(s => s.state === "idle");
    return Boolean(session);
  }).toBe(true);
  const file = join(session!.cwd, "submitted.txt");
  writeFileSync(file, "submitted placeholder\n");
  git(daemon.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const { workflow } = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", { name: "Local Inspector fixture", draft: inspectorGraph });
  const { version } = await api<{ version: { id: string } }>(daemon, `/api/workflows/${workflow.id}/publish`, { expectedDraftRevision: 1 });
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: version.id, sessionId: session!.id, deliveryMode: "preview", maxRepairRounds: options.maxRepairRounds ?? 5,
  });
  const { run } = await api<{ run: { id: string } }>(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "local-inspector-first" });
  const url = `/api/workflow-runs/${run.id}`;
  const detail = () => api<WorkflowRunDetail>(daemon, url);
  const resubmit = (round: number) => api(daemon, url + "/resubmit", { requestId: `local-round-${round}` });
  const assertUnpublished = async () => {
    expect((await detail()).attempts.some(a => a.nodeId === "pull-request")).toBe(false);
    expect(refs()).toBe(originalRefs);
  };
  return { run, file, detail, resubmit, assertUnpublished, refs, originalRefs, url };
}

test("Codex reads outside the diff, returns a repair packet, then releases the Pull Request action", async ({ dashboard, daemon }) => {
  test.setTimeout(120_000);
  const run = await start(dashboard, daemon);
  // Mutating the session checkout after capture must not change either the diff or the MCP view.
  await expect.poll(async () => (await run.detail()).events.some(event => event.kind === "submission_captured")).toBe(true);
  writeFileSync(run.file, "fixed after capture\n");
  writeFileSync(join(daemon.home, "repository-review-ready"), "ready");
  await expect.poll(async () => (await run.detail()).run.status, { timeout: 30_000 }).toBe("waiting_for_session");
  await run.assertUnpublished();
  const result = await run.detail();
  expect(result.attempts.find(a => a.nodeId === "inspect")?.output).toMatchObject({
    status: "failed", localInspector: { status: "failed", blockingSeverity: "major", findingCount: 1,
      publicationTree: expect.stringMatching(/^[a-f0-9]{40}$/), baseRef: "refs/remotes/origin/main", mergeBase: expect.stringMatching(/^[a-f0-9]{40}$/) },
  });
  expect(result.llmCalls.find(call => call.purpose === "inspector_review")?.runner).toBe("codex");
  await expect.poll(() => withDaemonDb(daemon, db => db.prepare(
    "SELECT payload FROM workflow_deliveries WHERE run_id=? AND kind='persona_feedback'",
  ).get(run.run.id)?.payload)).toContain("Replace the local placeholder");
  const audits = withDaemonDb(daemon, db => db.prepare("SELECT audit_json FROM workflow_repository_queries").all());
  expect(JSON.stringify(audits)).toContain("README.md");

  await dashboard.goto(daemon.baseURL + `/#/runs/${run.run.id}`);
  const card = dashboard.getByRole("article").filter({ hasText: "Reviewed the submitted worktree with read-only repository access." });
  await expect(card.getByText("Command · Local Inspector", { exact: true })).toBeVisible();
  await expect(card).toContainText("Replace the local placeholder");
  await card.getByRole("button", { name: "Load findings" }).click();
  await expect(card.locator(".wf-run-command-artifact pre")).toContainText("The submitted worktree still contains the placeholder.");
  await dashboard.mouse.move(0, 0);
  await screenshot(card, "run-findings");
  await run.resubmit(2);
  await expect.poll(async () => (await run.detail()).attempts.find(a => a.nodeId === "pull-request")?.state, { timeout: 30_000 }).toBe("waiting");
  expect((await run.detail()).attempts.filter(a => a.nodeId === "inspect").at(-1)?.output)
    .toMatchObject({ localInspector: { status: "passed", findingCount: 0 } });
  expect(run.refs()).toBe(run.originalRefs);
});

test("an unresolved finding outside the new diff stays visible and keeps Pull Request unreached", async ({ dashboard, daemon }) => {
  const run = await start(dashboard, daemon, { marker: "E2E_LOCAL_INSPECTOR_CARRY_OFF_DIFF" });
  writeFileSync(join(daemon.home, "repository-review-ready"), "ready");
  await expect.poll(async () => (await run.detail()).run.status, { timeout: 30_000 }).toBe("waiting_for_session");

  const checkout = dirname(run.file);
  git(checkout, "add", "submitted.txt");
  git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-qm", "Base advances and still contains the placeholder");
  git(checkout, "update-ref", "refs/remotes/origin/main", git(checkout, "rev-parse", "HEAD"));
  writeFileSync(join(checkout, "unrelated.txt"), "unrelated work\n");
  await run.resubmit(2);

  await expect.poll(async () => {
    const detail = await run.detail();
    const second = detail.submissions.find(submission => submission.round === 2);
    return detail.attempts.find(attempt => attempt.submissionId === second?.id && attempt.nodeId === "inspect")?.output;
  }, { timeout: 30_000 }).toMatchObject({ localInspector: { status: "failed", findingCount: 1 } });
  await run.assertUnpublished();
  await dashboard.goto(daemon.baseURL + `/#/runs/${run.run.id}`);
  const card = dashboard.getByRole("article").filter({ hasText: "Reviewed the submitted worktree with read-only repository access." });
  await expect(card).toContainText("Replace the local placeholder");
  await card.getByRole("button", { name: "Load findings" }).click();
  await expect(card.locator(".wf-run-command-artifact pre")).toContainText("The submitted worktree still contains the placeholder.");
  await screenshot(card, "carried-finding-round5");
});

test("a provider verdict without a repository query blocks without a repair or PR action", async ({ dashboard, daemon }) => {
  const run = await start(dashboard, daemon, { provider: "claude", marker: "E2E_LOCAL_INSPECTOR_NO_QUERY" });
  writeFileSync(join(daemon.home, "repository-review-ready"), "ready");
  await expect.poll(async () => (await run.detail()).run.currentPhase, { timeout: 30_000 }).toBe("command_action_required");
  await run.assertUnpublished();
  const detail = await run.detail();
  expect(detail.submissions).toHaveLength(1);
  expect(detail.attempts.find(a => a.nodeId === "inspect")).toMatchObject({
    state: "error", verdict: null, output: { localInspector: { status: "blocked" } },
  });
  await dashboard.goto(daemon.baseURL + `/#/runs/${run.run.id}`);
  await expect(dashboard.getByRole("main")).toContainText("did not complete a verified repository query");
  await expect(dashboard.getByText(/Reviewed the submitted worktree/)).toHaveCount(0);
});

test("an enabled Local Inspector blocks before review when the repository is denied Commands", async ({ dashboard, daemon }) => {
  const run = await start(dashboard, daemon, { allowCommands: false });
  await expect.poll(async () => (await run.detail()).run.currentPhase, { timeout: 30_000 }).toBe("command_action_required");
  await run.assertUnpublished();
  const detail = await run.detail();
  expect(detail.submissions).toHaveLength(1);
  expect(detail.submissions[0]?.evidence).toMatchObject({ localInspectorEnabled: true });
  expect(detail.llmCalls.filter(call => call.purpose === "inspector_review")).toHaveLength(0);
  expect(detail.attempts.find(a => a.nodeId === "inspect")).toMatchObject({
    state: "error", verdict: null, output: { localInspector: { status: "blocked" } },
  });

  await dashboard.goto(daemon.baseURL + `/#/runs/${run.run.id}`);
  const card = dashboard.getByRole("article").filter({ hasText: "Command · Local Inspector" });
  await expect(card).toContainText("This repository is not on the workflow allowlist");
  await expect(card.getByText(/Reviewed the submitted worktree/)).toHaveCount(0);
  await screenshot(card, "permission-denied-round1");
});

test("after a restart, Claude reopens the captured worktree and a spent allowance blocks the next round", async ({ dashboard, daemon }) => {
  test.setTimeout(120_000);
  const run = await start(dashboard, daemon, { provider: "claude", maxRuns: 1, marker: "E2E_LOCAL_INSPECTOR_RESTART" });
  const started = join(daemon.home, "repository-provider-started");
  await expect.poll(() => existsSync(started), { timeout: 25_000 }).toBe(true);
  const oldPid = readFileSync(started, "utf8");
  await daemon.crash();
  await daemon.restart();
  await expect.poll(() => readFileSync(started, "utf8"), { timeout: 25_000 }).not.toBe(oldPid);
  const newPid = readFileSync(started, "utf8");
  writeFileSync(join(daemon.home, `repository-review-ready-${newPid}`), "ready");
  await expect.poll(async () => (await run.detail()).run.status, { timeout: 30_000 }).toBe("waiting_for_session");
  expect((await run.detail()).llmCalls.filter(call => call.purpose === "inspector_review").map(call => call.state))
    .toEqual(["interrupted", "succeeded"]);
  writeFileSync(run.file, "fixed but allowance exhausted\n");
  await run.resubmit(2);
  await expect.poll(async () => (await run.detail()).run.currentPhase).toBe("command_action_required");
  await run.assertUnpublished();
  const blocked = await run.detail();
  const repair = blocked.submissions.find(submission => submission.round === 2);
  expect(repair).toBeDefined();
  expect(blocked.attempts).toContainEqual(expect.objectContaining({
    submissionId: repair!.id,
    nodeId: "inspect",
    state: "error",
    error: expect.stringContaining("allowance is exhausted"),
    output: expect.objectContaining({ localInspector: expect.objectContaining({ status: "blocked" }) }),
  }));
  expect(blocked.llmCalls.filter(call => call.purpose === "inspector_review")).toHaveLength(2);
});

test("unresolved findings stop at the workflow repair limit with no push", async ({ dashboard, daemon }) => {
  test.setTimeout(90_000);
  const run = await start(dashboard, daemon, { maxRepairRounds: 1 });
  writeFileSync(join(daemon.home, "repository-review-ready"), "ready");
  await expect.poll(async () => (await run.detail()).run.status, { timeout: 30_000 }).toBe("waiting_for_session");
  writeFileSync(run.file, "submitted placeholder with cosmetic change\n");
  await run.resubmit(2);
  await expect.poll(async () => {
    const detail = await run.detail();
    return [detail.submissions.length, detail.run.status];
  }, { timeout: 30_000 }).toEqual([2, "waiting_for_session"]);
  const response = await fetch(daemon.baseURL + run.url + "/resubmit", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "over-limit", resubmitUnchanged: true }),
  });
  expect(response.status).toBe(409);
  await expect.poll(async () => (await run.detail()).run.currentPhase).toBe("round_limit");
  await run.assertUnpublished();
});
