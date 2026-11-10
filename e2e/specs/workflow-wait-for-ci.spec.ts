import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * Wait for CI, authored in the editor and read in the run views.
 *
 * Real: the Pipeline editor, Publish, the dispatched session and its worktree, the Live Pull
 * Request packet the fake agent takes a turn on, the daemon's own adoption path (a `prCreated`
 * hook), the continuation, the Wait for CI attempt the engine parks, the manager's sweep that
 * decides it, the repair packet a failure sends, and the dashboard reading all of it over SSE.
 *
 * Stood in for: GitHub. The node reads CI only through the Inspector's stored snapshot, which
 * is a `gh` call this suite never makes, so the spec writes that snapshot
 * (`inspector_prs.observed_ci_json`) the way `withDaemonDb` documents for an observed head.
 * No model tokens are spent and GitHub is never reached.
 */

const EVIDENCE = artifactsDir("workflow-wait-for-ci");
const PROMPT = "# Pull Request\n\nOpen the pull request for the reviewed work.\n";
const PR_URL = "https://github.com/owner/repo/pull/77";
const PR_KEY = "owner/repo#77";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

test("the Pipeline editor adds Wait for CI after a Pull Request action, with its timeout and settings", async ({
  dashboard,
  daemon,
}) => {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E wait for CI authoring",
  });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E wait for CI authoring/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  // Before any Pull Request action there is nowhere Wait for CI is valid, so it is not offered.
  await expect(pipeline.getByLabel("Add the first stage").locator("option", { hasText: "Wait for CI" }))
    .toHaveCount(0);
  await pipeline.getByLabel("Add the first stage").selectOption({ label: "Pull Request" });
  await pipeline.getByLabel("Insert a stage after Stage 1").click();
  await pipeline.getByLabel("Insert a stage after Stage 1").selectOption({ label: "Wait for CI" });

  const row = pipeline.locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(row).toBeVisible();
  // A new node writes the new-node settings, and the row says them.
  await expect(row).toContainText("All checks · quiet 3 min · blocks after 45 min");
  await expect(pipeline.getByRole("radio", { name: "All checks must pass" })).toBeChecked();
  await expect(pipeline.getByRole("radio", { name: "Required checks must pass" })).not.toBeChecked();
  await expect(pipeline.getByLabel("Quiet period (minutes)")).toHaveValue("3");
  await expect(pipeline.getByRole("textbox", { name: /^Expected checks/ })).toHaveValue("");
  await expect(pipeline).toContainText(
    "Passes once every counted check has settled and stayed unchanged this long. Set 0 to pass as soon as they settle.",
  );
  await pipeline.getByRole("radio", { name: "Required checks must pass" }).check();
  await expect(row).toContainText("Required checks · quiet 3 min · blocks after 45 min");
  await pipeline.getByRole("textbox", { name: /^Expected checks/ }).fill("deploy\n\n  e2e  \n");
  await expect(row).toContainText("Required checks · quiet 3 min · blocks after 45 min · expects 2 checks");
  const timeout = pipeline.getByLabel("Timeout (minutes)");
  await expect(timeout).toHaveValue("45");
  await timeout.fill("60");
  await expect(row).toContainText("Required checks · quiet 3 min · blocks after 60 min · expects 2 checks");
  // Keys typed into the fields edit them rather than reaching the row's move and remove keys.
  await timeout.press("Backspace");
  await expect(timeout).toHaveValue("6");
  await expect(row).toContainText("blocks after 6 min");
  await timeout.press("0");
  await expect(timeout).toHaveValue("60");
  const expected = pipeline.getByRole("textbox", { name: /^Expected checks/ });
  await expected.press("Home");
  await expected.press("ArrowDown");
  await expect(expected).toBeFocused();
  await expect(row).toContainText("Required checks · quiet 3 min · blocks after 60 min · expects 2 checks");
  // A Wait for CI stage holds nothing else, so it has no "add a reviewer" control.
  await expect(pipeline.getByLabel("Add a reviewer or Command to Stage 2")).toHaveCount(0);

  const publish = dashboard.getByRole("button", { name: "Publish" });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect
    .poll(async () => (await api<unknown[]>(daemon, `/api/workflows/${created.workflow.id}/versions`)).length)
    .toBe(1);
  const version = await api<{
    graph: {
      nodes: Array<{ id: string; kind: string; timeoutMinutes?: number }>;
      edges: Array<{ source: string; sourcePort: string; target: string }>;
    };
  }>(daemon, `/api/workflows/${created.workflow.id}/versions/1`);
  const ci = version.graph.nodes.find((node) => node.kind === "wait_for_ci");
  expect(ci).toMatchObject({ timeoutMinutes: 60, strictness: "required", quietMinutes: 3, expectedChecks: ["deploy", "e2e"] });
  const action = version.graph.nodes.find((node) => node.kind === "session_action")!;
  expect(version.graph.edges).toContainEqual(expect.objectContaining({
    source: action.id,
    sourcePort: "complete",
    target: ci!.id,
  }));
  await shoot(dashboard, "01-editor-wait-for-ci");
});

/** One HTML5 drag through a page-made `DataTransfer`, for `backlog-reorder.spec.ts`' reason. */
async function dragOnto(page: Page, source: Locator, target: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
  await source.dispatchEvent("dragend", { dataTransfer });
}

test("a reviewer dropped onto the Wait for CI stage stays put, and nothing announces a move", async ({
  dashboard,
  daemon,
}) => {
  await api(daemon, "/api/workflows", { name: "E2E wait for CI drop" });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E wait for CI drop/ }).click();

  const pipeline = dashboard.locator(".wf-pipeline-strip");
  await pipeline.getByLabel("Add the first stage").selectOption({ label: "Command · lint" });
  await pipeline.getByLabel("Add a reviewer or Command to Stage 1").selectOption({ label: "Command · typecheck" });
  await pipeline.getByLabel("Insert a stage after Stage 1").click();
  await pipeline.getByLabel("Insert a stage after Stage 1").selectOption({ label: "Pull Request" });
  await pipeline.getByLabel("Insert a stage after Stage 2").click();
  await pipeline.getByLabel("Insert a stage after Stage 2").selectOption({ label: "Wait for CI" });

  const stages = pipeline.locator("section.wf-pipeline-stage");
  const lint = pipeline.getByRole("listitem", { name: /^Command · lint, / });
  const typecheck = pipeline.getByRole("listitem", { name: /^Command · typecheck, / });
  const ciRow = pipeline.locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  const ciStage = stages.filter({ has: dashboard.locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" }) });
  const announcement = dashboard.locator('p.sr-only[aria-live="polite"]');

  // A drop that moves something is announced, which is what makes the refusals below observable.
  await dragOnto(dashboard, typecheck, lint);
  await expect(announcement).toHaveText("Moved Command · typecheck into Stage 1");
  await expect(typecheck).toHaveAccessibleName("Command · typecheck, Command 1 of 2 in Stage 1");

  await dragOnto(dashboard, lint, ciStage);
  await dragOnto(dashboard, lint, ciRow);
  await expect(announcement).toHaveText("Moved Command · typecheck into Stage 1");
  await expect(lint).toHaveAccessibleName("Command · lint, Command 2 of 2 in Stage 1");
  await expect(ciStage.locator("li.wf-pipeline-reviewer")).toHaveCount(1);
});

test("Publish refuses a quiet period at or above the timeout, said on the node, and publishes once it fits", async ({
  dashboard,
  daemon,
}) => {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", { name: "E2E wait for CI quiet" });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E wait for CI quiet/ }).click();
  const pipeline = dashboard.locator(".wf-pipeline-strip");
  await pipeline.getByLabel("Add the first stage").selectOption({ label: "Pull Request" });
  await pipeline.getByLabel("Insert a stage after Stage 1").click();
  await pipeline.getByLabel("Insert a stage after Stage 1").selectOption({ label: "Wait for CI" });
  const publish = dashboard.getByRole("button", { name: "Publish" });
  await expect(publish).toBeEnabled();

  await pipeline.getByLabel("Timeout (minutes)").fill("10");
  const quiet = pipeline.getByLabel("Quiet period (minutes)");
  await quiet.fill("10");
  // Inline, on the node, in place of the hint; and in the validation list beside Publish.
  const message = "The quiet period must be shorter than the timeout.";
  await expect(quiet.locator("xpath=..")).toContainText(message);
  await expect(quiet).toHaveAttribute("aria-invalid", "true");
  await expect(dashboard.getByRole("complementary", { name: "Workflow settings and validation" })).toContainText(message);
  await expect(publish).toBeDisabled();
  await shoot(dashboard, "01b-editor-quiet-period-diagnostic");
  // The publish route refuses it too, with the node diagnostic.
  await expect.poll(async () => (await api<{ workflow: { draft: { nodes: Array<{ kind: string; quietMinutes?: number }> } } }>(
    daemon, `/api/workflows/${created.workflow.id}`)).workflow.draft.nodes.find((node) => node.kind === "wait_for_ci")?.quietMinutes,
  ).toBe(10);
  const refused = await fetch(`${daemon.baseURL}/api/workflows/${created.workflow.id}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDraftRevision: (await api<{ workflow: { draftRevision: number } }>(daemon, `/api/workflows/${created.workflow.id}`)).workflow.draftRevision }),
  });
  expect(refused.ok).toBe(false);
  expect(await refused.text()).toContain("wait_for_ci_quiet_period");

  await quiet.fill("0");
  await expect(quiet.locator("xpath=..")).not.toContainText(message);
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect
    .poll(async () => (await api<unknown[]>(daemon, `/api/workflows/${created.workflow.id}/versions`)).length)
    .toBe(1);
  const version = await api<{ graph: { nodes: Array<Record<string, unknown>> } }>(
    daemon, `/api/workflows/${created.workflow.id}/versions/1`);
  expect(version.graph.nodes.find((node) => node.kind === "wait_for_ci")).toMatchObject({
    timeoutMinutes: 10,
    strictness: "all",
    quietMinutes: 0,
    expectedChecks: [],
  });
});

test("the Graph palette adds a Wait for CI node with pass and fail ports, and the rail edits its settings", async ({ dashboard, daemon }) => {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", { name: "E2E wait for CI graph" });
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /E2E wait for CI graph/ }).click();
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  await dashboard.locator("section.workflow-palette").getByRole("button", { name: "＋ Wait for CI" }).click();
  const node = dashboard.locator('[data-node-kind="wait_for_ci"]');
  await expect(node).toHaveCount(1);
  await expect(node).toContainText("Wait for CI");
  await expect(node.getByLabel("Pass output")).toHaveCount(1);
  await expect(node.getByLabel("Fail output")).toHaveCount(1);
  await node.click();
  const rail = dashboard.getByRole("complementary", { name: "Workflow properties and validation" });
  await expect(rail.getByLabel("Timeout (minutes)")).toHaveValue("45");
  await expect(rail.getByRole("radio", { name: "All checks must pass" })).toBeChecked();
  await expect(rail.getByLabel("Quiet period (minutes)")).toHaveValue("3");
  await expect(rail.getByRole("textbox", { name: /^Expected checks/ })).toHaveValue("");
  await expect(rail).toContainText("Only checks GitHub marks required, plus any expected checks, count.");
  await expect(rail).toContainText("It blocks the run when CI times out, never appears, or an expected check never appears.");
  // Unconnected, it says where it belongs.
  await expect(rail).toContainText("Wait for CI must follow a Pull Request session action's complete route");

  await rail.getByRole("radio", { name: "Required checks must pass" }).check();
  await rail.getByLabel("Quiet period (minutes)").fill("5");
  await rail.getByRole("textbox", { name: /^Expected checks/ }).fill("deploy\ndeploy");
  // A repeated name is said on the node, and Publish refuses it.
  await expect(rail).toContainText("Expected checks must be unique, and there can be at most 20.");
  await expect(rail.locator("code.workflow-diagnostic-code", { hasText: "wait_for_ci_expected_checks" })).toBeVisible();
  await shoot(dashboard, "01c-graph-rail-wait-for-ci");
  await rail.getByRole("textbox", { name: /^Expected checks/ }).fill("deploy\ne2e");
  await expect(rail.locator("code.workflow-diagnostic-code", { hasText: "wait_for_ci_expected_checks" })).toHaveCount(0);
  await expect.poll(async () => (await api<{ workflow: { draft: { nodes: Array<Record<string, unknown>> } } }>(
    daemon, `/api/workflows/${created.workflow.id}`)).workflow.draft.nodes.find((item) => item.kind === "wait_for_ci"),
  ).toMatchObject({ timeoutMinutes: 45, strictness: "required", quietMinutes: 5, expectedChecks: ["deploy", "e2e"] });
});

// ---- a run -------------------------------------------------------------------------------

async function dispatch(page: Page, daemon: DaemonHandle, branch: string): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the CI spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let session: { id: string; state: string; cwd: string; agent: string; agentSessionId: string | null } | undefined;
  await expect.poll(async () => {
    const sessions = await api<Array<NonNullable<typeof session>>>(daemon, "/api/sessions");
    session = sessions.find((item) => item.state !== "exited");
    return session?.state ?? "";
  }, { message: "the dispatched session should settle to idle" }).toBe("idle");
  execFileSync("git", ["-C", session!.cwd, "switch", "-q", "-c", branch]);
  await hook(daemon, session!, {});
  await expect.poll(async () =>
    (await api<Array<{ id: string; gitBranch: string | null }>>(daemon, "/api/sessions"))
      .find((item) => item.id === session!.id)?.gitBranch ?? null,
  ).toBe(branch);
  return session!.id;
}

async function hook(
  daemon: DaemonHandle,
  session: { id: string; agent: string; cwd: string; agentSessionId: string | null },
  extra: Record<string, unknown>,
): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      ...extra,
    }),
  });
  if (!response.ok) throw new Error(`hook answered ${response.status}: ${await response.text()}`);
}

interface CiWait {
  runId: string;
  head: string;
}

type RunDetail = {
  run: { status: string; currentPhase: string };
  summary: { actionWait?: string | null };
  attempts: Array<{ nodeId: string; state: string; output: { expectedHeadOid?: string | null } | null }>;
  deliveries: Array<{ kind: string; payload: string }>;
};

/** Dispatch, publish Session -> Pull Request -> Wait for CI -> End, and run it to the wait. */
async function runToCiWait(
  page: Page,
  daemon: DaemonHandle,
  name: string,
  settings: Record<string, unknown> = {},
): Promise<CiWait> {
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const sessionId = await dispatch(page, daemon, `e2e/${name}`);
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: `Open the pull request ${name}`,
    description: "Open the pull request for the reviewed work",
    promptMarkdown: PROMPT,
    requiredSkillId: null,
    completion: { kind: "pull_request" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: `E2E wait for CI ${name}`,
    resumptionPolicy: "manual",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: "action-node", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: "ci-node", kind: "wait_for_ci", timeoutMinutes: 45, position: { x: 480, y: 0 }, ...settings },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 720, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "action-node", targetPort: "activate" },
        { id: "e-complete", source: "action-node", sourcePort: "complete", target: "ci-node", targetPort: "activate" },
        { id: "e-pass", source: "ci-node", sourcePort: "pass", target: "end-node", targetPort: "terminal" },
        { id: "e-fail", source: "ci-node", sourcePort: "fail", target: "session-node", targetPort: "return_for_changes" },
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
    deliveryMode: "live",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `e2e-wait-for-ci-${name}` },
  );
  const runId = submitted.run.id;
  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).summary.actionWait ?? null, {
    message: "the Pull Request action never settled into a wait for its pull request",
    timeout: 180_000,
  }).toBe("awaiting_pull_request");

  // The turn opened the pull request, through the daemon's own adoption path.
  const session = (await api<Array<{ id: string; agent: string; cwd: string; agentSessionId: string | null }>>(
    daemon, "/api/sessions")).find((item) => item.id === sessionId)!;
  await hook(daemon, session, { prCreated: true, prUrl: PR_URL });

  // The Inspector has not polled, so the node watches the head the continuation captured.
  let head = "";
  await expect.poll(async () => {
    const detail = await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);
    const ci = detail.attempts.find((attempt) => attempt.nodeId === "ci-node" && attempt.state === "waiting");
    head = ci?.output?.expectedHeadOid ?? "";
    return head.length;
  }, { message: "Wait for CI never started waiting on a head", timeout: 120_000 }).toBe(40);
  expect(head).toBe(execFileSync("git", ["-C", session.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  return { runId, head };
}

/**
 * What the Inspector's poll would store for the pull request: CI on one head, observed at
 * `observedAt`. The node measures its quiet period between observations, so a spec backdates
 * the first sighting instead of waiting real minutes for the second.
 */
function seedCi(
  daemon: DaemonHandle,
  head: string,
  checkRuns: unknown[],
  observedAt = Date.now(),
  totalCount: number | null = null,
): void {
  withDaemonDb(daemon, (db) => {
    const changed = db.prepare("UPDATE inspector_prs SET observed_ci_json = ? WHERE key = ?")
      .run(JSON.stringify({ headSha: head, observedAt, checkRuns, totalCount }), PR_KEY);
    if (Number(changed.changes) !== 1) throw new Error("the adopted pull request row is missing");
  });
}

/** The waiting Wait for CI attempt's state, as the daemon last wrote it. */
function waitingCiState(daemon: DaemonHandle): { id: string; state: Record<string, unknown> } | null {
  return withDaemonDb(daemon, (db) => {
    const row = db.prepare(
      "SELECT id, output_json FROM workflow_node_attempts WHERE node_id = 'ci-node' AND state = 'waiting'",
    ).get() as { id: string; output_json: string } | undefined;
    return row ? { id: row.id, state: JSON.parse(row.output_json) as Record<string, unknown> } : null;
  });
}

/** Wait until the daemon's own sweep has started the quiet clock on the waiting attempt. */
async function quietStarted(daemon: DaemonHandle, at: number): Promise<void> {
  await expect.poll(() => waitingCiState(daemon)?.state.quietSince ?? null, {
    message: "the node never started its quiet period on settled CI",
    timeout: 60_000,
  }).toBe(at);
}

const QUIET_MS = 3 * 60_000;

const check = (name: string, state: "pending" | "passing" | "failing", extra: Record<string, unknown> = {}) => ({
  name,
  state,
  conclusion: state === "pending" ? null : state === "failing" ? "FAILURE" : "SUCCESS",
  detailsUrl: `https://ci.example/${encodeURIComponent(name)}`,
  title: null,
  summary: null,
  ...extra,
});

test("a run waits for CI, then returns a failing check to the session by name", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-fail");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const strip = dashboard.getByRole("region", { name: "Workflow run pipeline" }).or(
    dashboard.locator('[aria-label="Workflow run pipeline"]'),
  );
  const ciRow = strip.locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(ciRow).toContainText("Waiting for CI");
  await shoot(dashboard, "02-run-waiting-for-ci");

  seedCi(daemon, head, [
    check("unit (node 24)", "failing", { title: "2 tests failed", summary: "test/a.test.ts failed twice" }),
    check("lint", "passing"),
    check("docs", "passing", { conclusion: "NEUTRAL", title: "1 warning" }),
  ]);
  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: "failing CI did not return the run to the session",
    timeout: 60_000,
  }).toBe("waiting_for_session");
  const detail = await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);
  const repair = detail.deliveries.find((delivery) => delivery.kind === "persona_feedback");
  expect(repair?.payload).toContain('Fix the failing CI check "unit (node 24)"');
  expect(repair?.payload).not.toContain('CI check "docs"');

  await expect(ciRow).toContainText("CI failed");
  await ciRow.click();
  const card = dashboard.locator("article.wf-run-verdict", { hasText: "Wait for CI" });
  await expect(card).toContainText("CI failed on PR #77");
  await expect(card).toContainText('Fix the failing CI check "unit (node 24)"');
  // The full check list folds away once CI has decided; the failing checks are listed above it.
  await expect(card.getByRole("list", { name: "CI checks" })).toBeHidden();
  await card.getByText("Checks on the head commit (3)").click();
  await expect(card.getByRole("list", { name: "CI checks" })).toContainText("lint");
  await shoot(dashboard, "03-run-ci-failed");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}03-ci-failed-card.png` });
});

test("a run waits out the quiet period on green CI, then passes it", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-pass");
  const checks = [
    check("unit (node 24)", "passing"),
    check("docs", "passing", { conclusion: "NEUTRAL", title: "1 warning" }),
  ];
  // One settled observation: the quiet period starts, and the sweep alone never passes it.
  const firstSeen = Date.now() - QUIET_MS - 60_000;
  seedCi(daemon, head, checks, firstSeen);
  await quietStarted(daemon, firstSeen);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const ciRow = dashboard.locator('[aria-label="Workflow run pipeline"]')
    .locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  // The chip keeps saying what the node is doing; only the panel headline names the quiet period.
  await expect(ciRow).toContainText("Waiting for CI");
  await ciRow.click();
  const waitingCard = dashboard.locator("article.wf-run-attempt", { hasText: "Wait for CI" });
  await expect(waitingCard.locator(".wf-run-ci-headline")).toHaveText(
    `Every counted check has settled on PR #77 at ${head.slice(0, 12)}. `
    + "Passing once nothing changes for 3 min (0 of 3 so far).",
  );
  await shoot(dashboard, "04a-run-ci-quiet-period");
  if (process.env.MC_E2E_EVIDENCE) await waitingCard.screenshot({ path: `${EVIDENCE}04a-ci-quiet-card.png` });
  await expect(ciRow).toContainText("Waiting for CI");
  expect((await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status).toBe("running");

  // The Inspector's next poll, a quiet period later, with nothing changed: it passes.
  seedCi(daemon, head, checks);
  await expect.poll(async () =>
    (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: "green CI did not complete the run",
    timeout: 60_000,
  }).toBe("completed");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  await expect(ciRow).toContainText("CI passed");
  await ciRow.click();
  const card = dashboard.locator("article.wf-run-verdict", { hasText: "Wait for CI" });
  await expect(card).toContainText("CI passed on PR #77");
  await expect(card).not.toContainText(/flaky/i);
  await shoot(dashboard, "04-run-ci-passed");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}04-ci-passed-card.png` });
});

/** Both widths, for `workflow-session-action-evidence.spec.ts`' reason. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  for (const [suffix, width] of [["wide", 1440], ["narrow", 720]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}${name}-${suffix}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("a run blocked for missing CI says why, and waiting again passes green CI", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-missing-block");

  // Reach a real block through the daemon's own sweep: nothing ever appears on the head, and the
  // wait is backdated past its timeout, so the node blocks as `ci_missing`.
  const waiting = waitingCiState(daemon)!;
  withDaemonDb(daemon, (db) => {
    const state = { ...waiting.state, waitingSince: Number(waiting.state.waitingSince) - 46 * 60_000 };
    db.prepare("UPDATE workflow_node_attempts SET output_json = ? WHERE id = ?").run(JSON.stringify(state), waiting.id);
  });
  await expect.poll(async () => (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.currentPhase, {
    message: "the backdated wait never blocked the run",
    timeout: 60_000,
  }).toBe("ci_missing");

  // Green CI appears on the head now; the block stays until somebody waits again.
  const green = [check("unit (node 24)", "passing"), check("lint", "passing")];
  const firstSeen = Date.now() - QUIET_MS - 60_000;
  seedCi(daemon, head, green, firstSeen);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const ciRow = dashboard.locator('[aria-label="Workflow run pipeline"]')
    .locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(ciRow).toContainText("Blocked");
  await ciRow.click();
  const card = dashboard.locator("article.wf-run-attempt", { hasText: "Wait for CI" });
  const reason = card.locator(".wf-run-ci-headline");
  await expect(reason).toHaveText(
    "No CI check appeared on the pull request's head commit before the timeout. Check that CI "
    + "runs on pull requests and that GitHub Inspector is on, then wait for CI again.",
  );
  await expect(reason).not.toContainText("Waiting for CI on");
  await expect(card.getByRole("link", { name: PR_KEY })).toHaveAttribute("href", PR_URL);
  // The triage clause names the cause, and the run offers the retry as its move.
  await expect(dashboard.getByText("no CI on the PR").first()).toBeVisible();
  const again = dashboard.getByRole("button", { name: "Wait for CI again" });
  await expect(again).toBeVisible();
  expect((await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.currentPhase).toBe("ci_missing");
  await shoot(dashboard, "05-run-ci-missing-block");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}05-ci-missing-block-card.png` });

  // Waiting again judges the same head: the green snapshot starts the quiet period, and the
  // next poll with nothing changed passes the run.
  await again.click();
  await expect.poll(async () => (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: "Wait for CI again did not reopen the run",
    timeout: 60_000,
  }).toBe("running");
  await expect(ciRow).toContainText("Waiting for CI");
  await quietStarted(daemon, firstSeen);
  seedCi(daemon, head, green);
  await expect.poll(async () => (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message: "the retried run did not pass green CI",
    timeout: 60_000,
  }).toBe("completed");
  await expect(ciRow).toContainText("CI passed");
});

// ---- node settings in a run --------------------------------------------------------------

/** Open the run, then the Wait for CI card, and return the card with the given state. */
async function ciCard(page: Page, daemon: DaemonHandle, runId: string, chip: string, kind: "verdict" | "attempt") {
  await page.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const ciRow = page.locator('[aria-label="Workflow run pipeline"]').locator("li.wf-pipeline-reviewer", { hasText: "Wait for CI" });
  await expect(ciRow).toContainText(chip);
  await ciRow.click();
  return page.locator(`article.wf-run-${kind}`, { hasText: "Wait for CI" });
}

async function runStatus(daemon: DaemonHandle, runId: string, status: string, message: string): Promise<void> {
  await expect.poll(async () => (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status, {
    message,
    timeout: 60_000,
  }).toBe(status);
}

test("Required checks pass over a failing check that is not required, which the panel tags", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-required", { strictness: "required", quietMinutes: 3, expectedChecks: [] });
  const checks = [
    check("build", "passing", { required: true }),
    check("SonarQube", "passing", { required: true }),
    check("preview deploy", "failing"),
  ];
  const firstSeen = Date.now() - QUIET_MS - 60_000;
  seedCi(daemon, head, checks, firstSeen);
  await quietStarted(daemon, firstSeen);
  seedCi(daemon, head, checks);
  await runStatus(daemon, runId, "completed", "required checks passing did not complete the run");

  const card = await ciCard(dashboard, daemon, runId, "CI passed", "verdict");
  await expect(card).toContainText("CI passed on PR #77");
  await expect(card).toContainText("Required checks · quiet 3 min · limit 45 min");
  await card.getByText("Checks on the head commit (3)").click();
  const list = card.getByRole("list", { name: "CI checks" });
  await expect(list.locator("li", { hasText: "preview deploy" })).toContainText("Not required");
  await expect(list.locator("li", { hasText: "build" })).toContainText("Required");
  await expect(card).not.toContainText("Failing checks");
  await shoot(dashboard, "06-run-ci-required");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}06-ci-required-card.png` });
});

test("Required checks with none marked wait out the quiet period, then judge every check and say so", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-fallback", { strictness: "required", quietMinutes: 3, expectedChecks: [] });
  const checks = [check("unit (node 24)", "passing"), check("lint", "passing")];
  const firstSeen = Date.now() - QUIET_MS - 60_000;
  seedCi(daemon, head, checks, firstSeen);
  await quietStarted(daemon, firstSeen);
  seedCi(daemon, head, checks);
  await runStatus(daemon, runId, "completed", "the fallback did not pass green CI");

  const card = await ciCard(dashboard, daemon, runId, "CI passed", "verdict");
  await expect(card).toContainText("No check on this head is marked required, so every check was judged.");
  await expect(card).toContainText("No check was marked required, so every check was judged.");
  await shoot(dashboard, "07-run-ci-fallback");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}07-ci-fallback-card.png` });
});

test("an expected check that never appears blocks the run at the timeout, by name, and offers to wait again", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-expected", { strictness: "all", quietMinutes: 3, expectedChecks: ["deploy"] });
  seedCi(daemon, head, [check("unit (node 24)", "passing")]);
  await expect.poll(() => waitingCiState(daemon)?.state.missingExpected ?? null, {
    message: "the node never noticed the expected check was missing",
    timeout: 60_000,
  }).toEqual(["deploy"]);
  // Green CI without the expected check keeps waiting; past the timeout it blocks.
  expect((await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.status).toBe("running");
  const waiting = waitingCiState(daemon)!;
  withDaemonDb(daemon, (db) => {
    const state = { ...waiting.state, waitingSince: Number(waiting.state.waitingSince) - 46 * 60_000 };
    db.prepare("UPDATE workflow_node_attempts SET output_json = ? WHERE id = ?").run(JSON.stringify(state), waiting.id);
  });
  await expect.poll(async () => (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.currentPhase, {
    message: "the missing expected check never blocked the run",
    timeout: 60_000,
  }).toBe("ci_expected_missing");

  const card = await ciCard(dashboard, daemon, runId, "Blocked", "attempt");
  await expect(card.locator(".wf-run-ci-headline")).toHaveText(
    'These expected checks never appeared on the head commit before the timeout: "deploy". Check that '
    + "the workflows producing them run on pull requests, or correct the names in a new version, then "
    + "wait for CI again.",
  );
  await expect(card).toContainText('All checks · expects "deploy" · quiet 3 min · limit 45 min');
  await card.getByText("Checks on the head commit (1)").click();
  await expect(card.getByRole("list", { name: "CI checks" }).locator("li", { hasText: "deploy" })).toContainText("Not reported yet");
  await expect(dashboard.getByRole("button", { name: "Wait for CI again" })).toBeVisible();
  await shoot(dashboard, "08-run-ci-expected-missing");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}08-ci-expected-missing-card.png` });
});

test("green CI on a head with more than 100 checks blocks rather than pass on the first 100", async ({ dashboard, daemon }) => {
  test.setTimeout(360_000);
  const { runId, head } = await runToCiWait(dashboard, daemon, "ci-truncated", { strictness: "all", quietMinutes: 0, expectedChecks: [] });
  seedCi(daemon, head, [check("unit (node 24)", "passing"), check("lint", "passing")], Date.now(), 140);
  await expect.poll(async () => (await api<RunDetail>(daemon, `/api/workflow-runs/${runId}`)).run.currentPhase, {
    message: "a truncated green head did not block the run",
    timeout: 60_000,
  }).toBe("ci_checks_truncated");

  const card = await ciCard(dashboard, daemon, runId, "Blocked", "attempt");
  await expect(card.locator(".wf-run-ci-headline")).toHaveText(
    "GitHub reported 140 checks; only the first 100 were read, so this node cannot confirm CI passed. "
    + "Check the rest on GitHub; if they pass, an operator can disable this node for the run, then wait for CI again.",
  );
  await expect(card.locator("p.wf-run-meta", { hasText: /^GitHub reported 140 checks; only the first 100 were read\.$/ })).toBeVisible();
  await expect(dashboard.getByText("over 100 checks").first()).toBeVisible();
  await shoot(dashboard, "09-run-ci-truncated");
  if (process.env.MC_E2E_EVIDENCE) await card.screenshot({ path: `${EVIDENCE}09-ci-truncated-card.png` });
});
