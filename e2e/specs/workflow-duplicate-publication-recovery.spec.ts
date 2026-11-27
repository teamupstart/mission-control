import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { resolvedSessionIntent } from "../../src/shared/goal.ts";
import type { WorkflowRunDetail } from "../../src/shared/workflow.ts";
import type { Session, SessionGoal, Task } from "../../src/shared/types.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";
import { expect, test } from "../fixtures/test.ts";

test.use({ daemonEnv: { MISSION_INSPECTOR_POLL_MS: "3600000", MISSION_PR_POLL_MS: "800" } });

async function screenshot(target: Locator | Page, filename: string) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  const dir = artifactsDir("workflow-duplicate-publication-recovery");
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: join(dir, filename) });
}

test("Check again completes an eligible duplicate and settles its merged task", async ({ dashboard, daemon }) => {
  test.setTimeout(180_000);
  const api = async <T>(path: string, body?: unknown, method?: string): Promise<T> => {
    const response = await dashboard.request.fetch(daemon.baseURL + path, {
      method: method ?? (body === undefined ? "GET" : "POST"), data: body,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as T;
  };
  await api("/api/foreman/config", { enabled: true, mode: "dry-run", trackCiFailures: true, autoBacklog: false }, "PUT");
  await api("/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  await api("/api/inspector/config", { enabled: true, mode: "live", repoAllowlist: [daemon.repo] }, "PUT");
  const persona = await api<{ id: string }>("/api/personas", {
    name: "Publication reviewer", guidanceMarkdown: "Review the queued change. E2E_PASS_VERDICT",
  });
  const action = await api<{ id: string }>("/api/session-actions", {
    name: "Publish reviewed change", description: "", promptMarkdown: "Publish the reviewed change.",
    completion: { kind: "pull_request" },
  });
  const { workflow } = await api<{ workflow: { id: string } }>("/api/workflows", {
    name: "Publication review",
    completionPolicy: { kind: "inspector", onFindings: "inspector_only", missingPrAction: "wait" },
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "review", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "publish", kind: "session_action", sessionActionId: action.id, position: { x: 440, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 660, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "review", targetPort: "activate" },
        { id: "pass", source: "review", sourcePort: "pass", target: "publish", targetPort: "activate" },
        { id: "fail", source: "review", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
        { id: "published", source: "publish", sourcePort: "complete", target: "end", targetPort: "terminal" },
      ],
    },
  });
  await api(`/api/workflows/${workflow.id}/publish`, { expectedDraftRevision: 1 });
  // A branch-owning task is eligible. Use the fixture's named Git worktree at dispatch.
  await api("/api/worktrees/config", { enabled: false }, "PUT");
  const task = await api<Task>("/api/tasks", {
    title: "Queue fix", intent: "Fix the queue and publish the reviewed change.", repoRoot: daemon.repo,
    kind: "bugfix", agent: "claude", runtime: "sdk", workflowId: workflow.id,
  });
  const currentTask = async () => (await api<Task[]>("/api/tasks")).find(t => t.id === task.id)!;
  const currentSession = async () => (await api<Session[]>("/api/sessions")).find(s => s.task?.id === task.id);
  await expect.poll(async () => (await currentSession())?.state).toBe("idle");
  const session = (await currentSession())!;
  const cwd = session.cwd!;
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const branch = git("branch", "--show-current");
  expect((await currentTask()).branch).toBe(branch);
  writeFileSync(join(cwd, "queue.txt"), "Queue fix\n");
  git("add", "queue.txt");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "Fix the queue");
  const head = git("rev-parse", "HEAD");
  const hook = async (name: string, fields = {}) => {
    const result = await dashboard.request.post(daemon.baseURL + "/hooks/" + name, {
      headers: { "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim() },
      data: { agent: session.agent, sessionId: session.agentSessionId, cwd, env: {}, ...fields },
    });
    expect(result.status(), await result.text()).toBe(204);
  };
  await hook("PreToolUse", { toolName: "Bash" });
  await hook("Stop");
  const claim = async () => {
    const goal = await api<SessionGoal>(`/api/sessions/${session.id}/goal`);
    const cycle = (await currentSession())!.workCycle!;
    return await api<{ runId: string; state: string }>(`/api/sessions/${session.id}/workflow-completion`, {
      completionKind: "prompted", marker: cycle.generation.toString(16).padStart(64, "0"),
      expectedWorkCycle: { logicalKey: cycle.logicalKey, generation: cycle.generation },
      expectedIntent: resolvedSessionIntent(goal),
      summary: "The queue change is ready.", evidenceFingerprint: head,
    });
  };
  await api(`/api/sessions/${session.id}/goal/accept`, {});
  const accepted = await claim();
  expect(accepted.state).toBe("started");
  const detail = (id: string) => api<WorkflowRunDetail>(`/api/workflow-runs/${id}`);
  const awaitPublication = async (id: string) => {
    await expect.poll(async () => (await detail(id)).deliveries[0]?.state, { timeout: 45_000 }).toBe("delivered");
    const packet = (await detail(id)).deliveries[0]!.payload;
    expect(packet).toContain("Workflow pull request CI follow-through");
    await hook("UserPromptSubmit", { prompt: packet });
    await hook("Stop");
  };
  await awaitPublication(accepted.runId);
  const url = "https://github.com/acme/mission-e2e/pull/1809";
  const key = "acme/mission-e2e#1809";
  const createdAt = new Date().toISOString();
  const pr = { cwd, number: 1809, url, headRefName: branch, headRefOid: head, createdAt };
  writeGhPullRequests(daemon.home, [{ ...pr, state: "OPEN", mergedAt: null }]);
  await hook("PostToolUse", { toolName: "Bash", prCreated: true, prUrl: url, prUrls: [url] });
  await hook("Stop");
  await expect.poll(async () => (await detail(accepted.runId)).run.status, { timeout: 30_000 }).toBe("waiting_for_inspector");
  // Stand in for the earlier Inspector review of this exact commit in the disposable daemon.
  withDaemonDb(daemon, db => {
    const observedAt = Date.now();
    expect(db.prepare(`UPDATE inspector_prs SET state = 'open', observed_state = 'OPEN',
      head_sha = ?, observed_head_sha = ?, clean_review_head_sha = ?, review_complete = 1,
      round = 1, last_attempt_sha = ?, review_posture = 'live', head_ref_name = ?, observed_at = ?, last_reviewed_at = ? WHERE key = ?`)
      .run(head, head, head, head, branch, observedAt, observedAt, key).changes).toBe(1);
    db.prepare(`UPDATE workflow_runs SET gate_state_json = json_set(gate_state_json,
      '$.observedHeadSha', ?, '$.lastObservedAt', CAST(? AS INTEGER), '$.reviewPosture', 'live') WHERE id = ?`)
      .run(head, observedAt, accepted.runId);
  });
  await api(`/api/workflow-runs/${accepted.runId}/recheck-inspector`, { requestId: "observe-accepted-review" });
  await expect.poll(async () => (await detail(accepted.runId)).run.status, { timeout: 30_000 }).toBe("completed");
  // The legacy handoff has no pending-check observation. The overlapping check history
  // returned on recheck is what can later attribute the consecutive claims to CI.
  const startedAt = new Date().toISOString();
  expect(await claim()).toMatchObject({ runId: accepted.runId, state: "already_claimed" });
  await hook("PreToolUse", { toolName: "Bash" });
  await hook("Stop");
  const completedAt = new Date().toISOString();
  const duplicate = await claim();
  expect(duplicate.state).toBe("started");
  expect(duplicate.runId).not.toBe(accepted.runId);
  await awaitPublication(duplicate.runId);
  const mergedAt = new Date().toISOString();
  writeGhPullRequests(daemon.home, [{ ...pr, state: "MERGED", mergedAt, checkRollupState: "SUCCESS",
    checkContexts: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", startedAt, completedAt }] }]);
  await expect.poll(async () => (await currentSession())?.prState).toBe("merged");
  withDaemonDb(daemon, db => db.prepare(`UPDATE inspector_prs SET state = 'closed', observed_state = 'MERGED',
    observed_at = ?, merged_at = ? WHERE key = ?`).run(Date.now(), Date.parse(mergedAt), key));
  await hook("Stop");
  await expect.poll(async () => (await detail(duplicate.runId)).run.currentPhase, { timeout: 30_000 }).toBe("inspector_pr_closed");
  expect((await currentTask()).status).toBe("running");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${duplicate.runId}`);
  const header = dashboard.locator("header.wf-run-head");
  await expect(header.getByText("Blocked", { exact: true })).toBeVisible();
  await header.getByRole("button", { name: "Check again" }).click();
  await expect(header.getByText("Completed", { exact: true })).toBeVisible();
  const recovered = await detail(duplicate.runId);
  expect(recovered.run.status).toBe("completed");
  expect(recovered.events.filter(e => e.kind === "duplicate_publication_recovered")).toMatchObject([
    { payload: { acceptedRunId: accepted.runId, prKey: key, headSha: head } },
  ]);
  await expect.poll(async () => (await currentTask()).status).toBe("done");
  await dashboard.getByRole("tab", { name: /^Completion/ }).click();
  await header.scrollIntoViewIfNeeded();
  await dashboard.mouse.move(0, 0);
  await screenshot(dashboard, "completed-run.png");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const sitrep = dashboard.getByRole("dialog", { name: "Sitrep" });
  await expect(async () => {
    await dashboard.keyboard.press("Shift+P");
    await expect(sitrep).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  const outcome = sitrep.locator(".report-row").filter({ has: dashboard.getByText(task.title, { exact: true }) });
  await expect(outcome.getByText("done", { exact: true })).toBeVisible();
  await expect(outcome.getByRole("link", { name: /merged/ })).toHaveAttribute("href", url);
  await screenshot(sitrep, "settled-task.png");
});
