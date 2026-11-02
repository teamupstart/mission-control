import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { writeGhPullRequests, type FakePullRequest } from "../fixtures/fake-agents.ts";
import { recordsIn } from "../fixtures/records.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import type { Session } from "../../src/shared/types.ts";

test.use({ daemonEnv: { MISSION_INSPECTOR_POLL_MS: "2000", MISSION_PR_POLL_MS: "500", FOREMAN_QUEUE_SETTLE_MS: "0" } });
const evidence = artifactsDir("shipping-coderabbit-followup");
async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(`${daemon.baseURL}${path}`, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}
async function shoot(page: Page, name: string, keepHover = false) {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(evidence, { recursive: true });
  if (!keepHover) await page.mouse.move(0, 0);
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  console.log(`CAPTURED e2e/.artifacts/shipping-coderabbit-followup/${name}.png`);
}
function threads(resolved = false) {
  return { nodes: [{ id: "thread", isResolved: resolved, isOutdated: true, path: "src/a.ts", comments: { nodes: [{
    id: "root", databaseId: 1, url: "https://github.com/acme/mission-e2e/pull/27#discussion_r1",
    author: { __typename: "Bot", login: "coderabbitai" }, body: "Check the missing guard",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  }] } }], pageInfo: { hasNextPage: false, endCursor: null } };
}

async function holdWithWorkflow(daemon: DaemonHandle, sessionId: string) {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "CodeRabbit workflow holder", guidanceMarkdown: "# Holder\n\nE2E_FAIL_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "CodeRabbit ownership check", draft: {
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
  const published = await api<{ version: { id: string } }>(daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", { workflowVersionId: published.version.id, sessionId, deliveryMode: "preview" });
  const submitted = await api<{ run: { id: string } }>(daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "coderabbit-held" });
  await expect.poll(async () => (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`)).run.status,
    { timeout: 60_000 }).toBe("waiting_for_session");
  return submitted.run.id;
}

test("the independent default-off toggle persists and unreadable settings remain unknown", async ({ dashboard, daemon }) => {
  await api(daemon, "/api/foreman/config", { enabled: false }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  const toggle = dashboard.getByRole("checkbox", { name: "Follow up on CodeRabbit comments" });
  await expect(toggle).not.toBeChecked(); await toggle.locator("..").click();
  await expect.poll(() => api(daemon, "/api/shipping/config")).toMatchObject({ codeRabbitAutoResolve: true, autoMerge: false });
  await expect(dashboard.getByText("Foreman is disabled.")).toBeVisible();
  const foremanControls = dashboard.getByRole("button", { name: "Open Foreman controls" });
  await expect(foremanControls).toHaveAccessibleDescription("Open Foreman settings to enable Live follow-up");
  await foremanControls.hover();
  const tooltip = dashboard.locator(".tooltip");
  await expect(tooltip).toHaveText("Open Foreman settings to enable Live follow-up");
  await expect(tooltip).toBeVisible();
  await shoot(dashboard, "foreman-controls-tooltip", true);
  await foremanControls.click();
  await expect(dashboard).toHaveURL(/#\/settings\/foreman/);
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  await dashboard.reload(); await expect(toggle).toBeChecked(); await shoot(dashboard, "enabled-prerequisite");
  await dashboard.route("**/api/shipping/config", (route) => route.fulfill({ status: 503, body: "unavailable" }));
  await expect(toggle).toBeDisabled();
  await expect(dashboard.getByText("Unknown - Shipping configuration is unavailable")).toBeVisible();
  await shoot(dashboard, "unknown-config");
});

test("fake GitHub drives unresolved, zero and unknown in Shipping without Inspector or GitHub writes", async ({ dashboard, daemon }) => {
  const pr: FakePullRequest = { cwd: daemon.repo, number: 27, url: "https://github.com/acme/mission-e2e/pull/27",
    state: "OPEN", createdAt: new Date().toISOString(), mergedAt: null, headRefOid: "head", reviewThreads: threads() };
  writeGhPullRequests(daemon.home, [pr]);
  withDaemonDb(daemon, (db) => db.prepare(`INSERT INTO inspector_prs
    (key,url,owner,repo,number,cwd,repo_root,source,state,round,adopted_at,updated_at)
    VALUES ('acme/mission-e2e#27',?,'acme','mission-e2e',27,?,?,'hook','open',0,?,?)`)
    .run(pr.url, daemon.repo, daemon.repo, Date.now(), Date.now()));
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  await dashboard.getByRole("checkbox", { name: "Follow up on CodeRabbit comments" }).locator("..").click();
  const row = dashboard.locator(".sc-row").filter({ hasText: "mission-e2e#27" });
  await expect(row).toContainText("CodeRabbit: 1 unresolved");
  await expect(row).toContainText("Waiting for an eligible owning session"); await shoot(dashboard, "unresolved-owner-held");
  writeGhPullRequests(daemon.home, [{ ...pr, reviewError: true }]);
  await expect(row).toContainText("CodeRabbit: unknown");
  await expect(row).toContainText("Last complete observation: 1 unresolved");
  await expect(row).toContainText("scripted provider unavailable"); await shoot(dashboard, "unknown-provider");
  writeGhPullRequests(daemon.home, [{ ...pr, reviewThreads: threads(true) }]);
  await expect(row).toContainText("CodeRabbit: 0 unresolved"); await shoot(dashboard, "zero-unresolved");
  const calls = recordsIn<{ argv: string[] }>(daemon.recordDir, (file) => file.startsWith("gh-"));
  expect(calls.some((call) => call.argv.some((a) => /mutation|--method/.test(a)))).toBe(false);
  expect(await api(daemon, "/api/inspector/config")).toMatchObject({ enabled: false });
  expect(await api(daemon, "/api/shipping/config")).toMatchObject({ autoMerge: false });
});

test("workflow ownership holds Foreman, then one same-PR prompt is delivered without replaying uncertain delivery", async ({ dashboard, daemon }) => {
  await api(daemon, "/api/tasks", { repoRoot: daemon.repo, intent: "Implement the guard and follow this PR", title: "CodeRabbit follow-through",
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null });
  let session!: Session;
  await expect.poll(async () => { session = (await api<Session[]>(daemon, "/api/sessions"))[0]!; return session?.state; }).toBe("idle");
  // Native task checkouts start detached. The fake agent does not create a branch,
  // so perform the repository action a real agent takes before opening its PR.
  execFileSync("git", ["switch", "-c", "fix/coderabbit"], { cwd: session.cwd! });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: session.cwd!, encoding: "utf8" }).trim();
  const pr: FakePullRequest = { cwd: session.cwd!, number: 27, url: "https://github.com/acme/mission-e2e/pull/27", state: "OPEN",
    createdAt: new Date().toISOString(), mergedAt: null, headRefOid: head, headRefName: "fix/coderabbit", reviewThreads: threads() };
  writeGhPullRequests(daemon.home, [pr]);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  for (const event of ["PostToolUse", "Stop"]) {
    const res = await fetch(`${daemon.baseURL}/hooks/${event}`, { method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({ agent: session.agent, sessionId: session.agentSessionId, cwd: session.cwd,
        ...(event === "PostToolUse" ? { toolName: "Bash", prCreated: true, prUrl: pr.url, prUrls: [pr.url] } : {}) }) });
    expect(res.status).toBe(204);
  }
  await dashboard.goto(`${daemon.baseURL}/#/settings/shipping`);
  await dashboard.getByRole("checkbox", { name: "Follow up on CodeRabbit comments" }).locator("..").click();
  const row = dashboard.locator(".sc-row").filter({ hasText: "mission-e2e#27" });
  await expect(row).toContainText("CodeRabbit: 1 unresolved");
  await api(daemon, "/api/foreman/config", { enabled: true, mode: "live", repoAllowlist: [daemon.repo],
    trackReviewFeedback: false, trackCiFailures: false, wrapupTriggers: [], keepShipTasksMoving: false }, "PUT");
  await expect.poll(async () => (await api<Session[]>(daemon, "/api/sessions"))[0]?.prState).toBe("open");
  const runId = await holdWithWorkflow(daemon, session.id);
  await daemon.startForeman();
  const prompts = async () => {
    const transcript = await api<{ messages: Array<{ role: string; text: string }> }>(daemon, `/api/sessions/${session.id}/transcript`);
    return transcript.messages.filter((m) => m.role === "user" && m.text.includes("CodeRabbit has"));
  };
  await expect(row).toContainText("an active workflow owns this session");
  await shoot(dashboard, "workflow-held");
  await dashboard.waitForTimeout(5000); expect(await prompts()).toHaveLength(0);
  await api(daemon, `/api/workflow-runs/${runId}/cancel`, { requestId: "coderabbit-release" });
  await expect.poll(async () => (await prompts()).length, { timeout: 30_000, message: "Foreman should send the CodeRabbit prompt" }).toBe(1);
  const prompt = (await prompts())[0]!.text;
  for (const text of [pr.url, session.cwd!, "focused checks", "existing branch", "no merge authority"]) expect(prompt).toContain(text);
  await expect(row).toContainText("Feedback delivered"); await shoot(dashboard, "feedback-delivered");
  await dashboard.waitForTimeout(5000); expect(await prompts()).toHaveLength(1);
  // Reconcile a lost-response receipt as it would be loaded after a crash. The service
  // continues to observe it, but never automatically replays it.
  withDaemonDb(daemon, (db) => {
    const row = db.prepare("SELECT code_rabbit_state FROM inspector_prs WHERE key = 'acme/mission-e2e#27'").get() as { code_rabbit_state: string };
    const state = JSON.parse(row.code_rabbit_state);
    for (const receipt of state.receipts) receipt.outcome = "uncertain";
    db.prepare("UPDATE inspector_prs SET code_rabbit_state = ? WHERE key = 'acme/mission-e2e#27'").run(JSON.stringify(state));
  });
  await expect(row).toContainText("Delivery uncertain"); await shoot(dashboard, "delivery-uncertain");
  expect(await prompts()).toHaveLength(1);
});
