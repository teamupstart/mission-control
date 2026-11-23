import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { PublishedWorkflowGraph, WorkflowContextSnapshot } from "../../src/shared/workflow.ts";

import { expect, test } from "../fixtures/test.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";

const EVIDENCE = artifactsDir("workflow-closed-pr-recheck");

/**
 * The dead end an open pull request reported as closed used to be, and the move that ends it.
 *
 * Reported three times in one working day (issue #1494): a No-Mistakes run waiting on its
 * session's repair push flipped to `blocked`/`inspector_pr_closed` while the pull request stayed
 * open on GitHub with an unchanged head. The cause was a GitHub Inspector signal that observed
 * nothing - a failed poll, a settings save - carrying a null state the gate read as closed. The
 * run page then offered only `Cancel run` and a full restart, and a recheck was refused.
 *
 * The daemon no longer reads a null state as closed (`test/workflow-inspector-gate.test.ts`), so
 * this spec covers the recovery for a run already stranded that way: the header now leads with
 * `Check again`, which asks GitHub about the pull request again. It starts from the hardest
 * case - the Inspector already retired the row as closed, and its sweep never reads a retired
 * row again - and lifts the block only when GitHub answers OPEN. A pull request GitHub still
 * reports closed stays exactly where it was.
 *
 * The poller is slowed to a crawl so nothing but the operator's click re-evaluates the gate.
 * GitHub's answers come from the fixture's fake `gh`, scripted through `writeGhPullRequests`.
 * The stranded gate, the adopted pull request and its finding are written behind the daemon - a
 * real adoption needs a live pull request, which this offline suite has by design not got.
 * Everything from the click on is production: the route, the GitHub read, the ledger write, the
 * gate evaluation, the server event and the repaint.
 */
// The daemon fixture disables session discovery polling. Also keep PR polling from
// publishing a session update that could own the explicit recheck's recovery read.
test.use({ daemonEnv: { MISSION_INSPECTOR_POLL_MS: "3600000", MISSION_PR_POLL_MS: "3600000" } });

const PR_NUMBER = 1494;
const PR_KEY = `owner/repo#${PR_NUMBER}`;
const PR_URL = `https://github.example/owner/repo/pull/${PR_NUMBER}`;
const FAILED_HEAD = "f".repeat(40);
const FINDING = "Repair the edge before the gate can pass";

async function shoot(page: Page, target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: a focused button keeps its tooltip bubble open over the header.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/workflow-closed-pr-recheck/${name}.png`);
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

interface RunProbe {
  run: { status: string; currentPhase: string };
  summary: { recovery?: { operations: string[]; primary: string | null } };
  events: Array<{ kind: string }>;
}

const probe = (daemon: DaemonHandle, runId: string): Promise<RunProbe> =>
  api<RunProbe>(daemon, `/api/workflow-runs/${runId}`);

const eventCount = async (daemon: DaemonHandle, runId: string, kind: string): Promise<number> =>
  (await probe(daemon, runId)).events.filter((event) => event.kind === kind).length;

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the closed pull request spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle before the workflow is bound" }).toBe("idle");
  return sessionId;
}

/** One single-reviewer run that passes, built through the routes the dashboard itself uses. */
async function seedRun(page: Page, daemon: DaemonHandle, name = "E2E closed pull request"): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Closed PR reviewer",
    guidanceMarkdown: "# Closed PR reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name,
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
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-closed-pr-recheck" },
  );
  try {
    await expect.poll(async () => (await probe(daemon, submitted.run.id)).run.status, {
      message: "the seeded round should settle completed",
      timeout: 40_000,
    }).toBe("completed");
  } catch (caught) {
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return submitted.run.id;
}

/**
 * Leave the run where the earlier build stranded the reported ones: an Inspector-only gate that
 * was waiting on the session's repair push for an open finding, blocked as closed.
 */
function strandAsClosed(daemon: DaemonHandle, runId: string): void {
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    const run = db.prepare("SELECT workflow_version_id FROM workflow_runs WHERE id = ?")
      .get(runId) as { workflow_version_id: string } | undefined;
    if (!run) throw new Error(`missing run ${runId}`);
    db.prepare("UPDATE workflow_versions SET completion_policy_json = ? WHERE id = ?").run(
      JSON.stringify({ kind: "inspector", onFindings: "inspector_only", missingPrAction: "wait" }),
      run.workflow_version_id,
    );
    db.prepare(
      `UPDATE workflow_runs
          SET status = 'blocked', current_phase = 'inspector_pr_closed', inspector_pr_key = ?,
              inspector_head_sha = ?, gate_state_json = ?, completed_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(
      PR_KEY,
      FAILED_HEAD,
      JSON.stringify({
        prKey: PR_KEY,
        prUrl: PR_URL,
        targetHeadSha: FAILED_HEAD,
        failedHeadSha: FAILED_HEAD,
        enteredAt: now - 60_000,
        lastObservedAt: now - 5_000,
        observedHeadSha: FAILED_HEAD,
        reviewPosture: "live",
        waitReason: "pr_closed",
        findingFingerprints: ["closed-pr-finding"],
      }),
      now,
      runId,
    );
    // The poller's last read of this pull request said CLOSED, and it retired the row.
    db.prepare(
      `INSERT INTO inspector_prs
         (key, url, owner, repo, number, repo_root, cwd, session_id, source, state,
          head_sha, review_posture, review_complete, round, last_reviewed_at, last_error,
          fail_count, last_fail_kind, next_attempt_at, last_attempt_sha, merged_at, merge_block,
          observed_head_sha, observed_state, observed_at, head_ref_name, title,
          adopted_at, updated_at)
       VALUES (?, ?, 'owner', 'repo', ?, ?, ?, NULL, 'hook', 'closed',
               ?, 'live', 1, 1, ?, NULL, 0, NULL, NULL, ?, NULL, NULL,
               ?, 'CLOSED', ?, 'feat/closed-pr', 'Closed pull request', ?, ?)`,
    ).run(
      PR_KEY, PR_URL, PR_NUMBER, daemon.repo, daemon.repo,
      FAILED_HEAD, now - 20_000, FAILED_HEAD,
      FAILED_HEAD, now - 5_000, now - 60_000, now,
    );
    db.prepare(
      `INSERT INTO inspector_comments
         (id, pr_key, fingerprint, path, line, title, body, severity, round, status,
          replies, answered_comment_id, created_at, updated_at)
       VALUES ('closed-pr-finding', ?, 'closed-pr-finding', 'src/edge.ts', 12, ?,
               'The edge drops durable state.', 'major', 1, 'open', 0, NULL, ?, ?)`,
    ).run(PR_KEY, FINDING, now - 20_000, now);
  });
}

/** Script what GitHub answers when the daemon reads this pull request. */
function scriptGitHub(daemon: DaemonHandle, state: "OPEN" | "CLOSED", head = FAILED_HEAD): void {
  writeGhPullRequests(daemon.home, [{
    cwd: daemon.repo,
    url: PR_URL,
    number: PR_NUMBER,
    state,
    headRefName: "feat/closed-pr",
    headRefOid: head,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    mergedAt: null,
  }]);
}

interface LedgerRow {
  state: string;
  observed_state: string | null;
  observed_at: number | null;
}

/** The adopted pull request's Inspector row, read straight from the daemon's database. */
const ledgerRow = (daemon: DaemonHandle): LedgerRow =>
  withDaemonDb(daemon, (db) => db.prepare(
    "SELECT state, observed_state, observed_at FROM inspector_prs WHERE key = ?",
  ).get(PR_KEY) as unknown as LedgerRow);

test("a run blocked as closed offers Check again, which lifts the block only for an open pull request", async ({
  dashboard,
  daemon,
}) => {
  const runId = await seedRun(dashboard, daemon);
  await api(
    daemon,
    "/api/inspector/config",
    { enabled: true, mode: "live", repoAllowlist: [daemon.repo] },
    "PUT",
  );
  strandAsClosed(daemon, runId);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  const checkAgain = header.getByRole("button", { name: "Check again" });
  await expect(header.getByText("Blocked", { exact: true })).toBeVisible();
  // The block's one non-destructive move, beside the destructive one it used to stand alone with.
  await expect(checkAgain).toBeVisible();
  await expect(header.getByRole("button", { name: "Cancel run" })).toBeVisible();
  await dashboard.getByRole("tab", { name: /^Completion/ }).click();
  const pane = dashboard.getByRole("tabpanel", { name: /^Completion/ });
  await expect(pane).toContainText("The adopted pull request was closed or switched.");
  await shoot(dashboard, header, "01-closed-block-offers-check-again");

  // GitHub still says closed: the click reads it again, and changes nothing.
  scriptGitHub(daemon, "CLOSED");
  const before = ledgerRow(daemon).observed_at;
  await checkAgain.click();
  await expect.poll(() => eventCount(daemon, runId, "inspector_recheck_requested"), {
    message: "the click should reach the recheck route",
  }).toBe(1);
  await expect.poll(() => ledgerRow(daemon).observed_at, {
    message: "the recheck should read the pull request from GitHub again",
  }).not.toBe(before);
  // A negative needs a window: the gate evaluates that read after the ledger records it.
  await dashboard.waitForTimeout(500);
  expect(ledgerRow(daemon)).toMatchObject({ state: "closed", observed_state: "CLOSED" });
  expect((await probe(daemon, runId)).run.status).toBe("blocked");
  expect(await eventCount(daemon, runId, "inspector_pr_seen_open")).toBe(0);
  expect(await eventCount(daemon, runId, "inspector_pr_reobserve_failed")).toBe(0);
  await expect(header.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(pane).toContainText("The adopted pull request was closed or switched.");

  // GitHub says open, as it did in every reported case. The row was retired, so no sweep would
  // ever have seen that; the same button reads it, un-retires the row and restores the repair
  // wait the false close interrupted - with no restart and no review re-spent.
  scriptGitHub(daemon, "OPEN");
  await checkAgain.click();
  await expect(header.getByText("Waiting for a new pushed head", { exact: true })).toBeVisible();
  expect(ledgerRow(daemon)).toMatchObject({ state: "open", observed_state: "OPEN" });
  await expect(pane).toContainText("GitHub Inspector left findings that have to be resolved.");
  await expect(pane).toContainText(FINDING);
  const recovered = await probe(daemon, runId);
  expect(recovered.run).toMatchObject({
    status: "waiting_for_new_head",
    currentPhase: "inspector_findings",
  });
  expect(recovered.events.filter((event) => event.kind === "inspector_pr_seen_open")).toHaveLength(1);
  if (process.env.MC_E2E_EVIDENCE) {
    // The clicked button repaints into its ghost twin under the pointer, which strands the bubble
    // the click opened. Hover the new one and leave it so the capture shows the header.
    await checkAgain.hover();
    await dashboard.mouse.move(0, 0);
    await expect(dashboard.locator(".tooltip")).toHaveCount(0);
  }
  await shoot(dashboard, header, "02-open-pull-request-restores-the-repair-wait");
});


// Issue #1549: seed the historical unsent delivery block, then let a real session
// resume event reconcile the current Inspector ledger and repaint the open run page.
for (const trigger of ["session return", "Check again"] as const) {
test(`${trigger} releases unsent feedback for a superseded clean Inspector head`, async ({ dashboard, daemon }) => {
  const runId = await seedRun(dashboard, daemon, "E2E Inspector feedback recovery");
  const sessionId = (await api<Array<{ id: string }>>(daemon, "/api/sessions"))[0]!.id;
  await api(daemon, `/api/sessions/${encodeURIComponent(sessionId)}/pause`, { mode: "now" });
  await api(daemon, "/api/inspector/config", {
    enabled: true, mode: "live", repoAllowlist: [daemon.repo],
  }, "PUT");
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true, repoAllowlist: [daemon.repo],
  }, "PUT");
  strandAsClosed(daemon, runId);
  const head = execFileSync("git", ["-C", daemon.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  withDaemonDb(daemon, (db) => {
    const run = db.prepare("SELECT binding_id, gate_state_json FROM workflow_runs WHERE id = ?")
      .get(runId) as { binding_id: string; gate_state_json: string };
    const gate = JSON.parse(run.gate_state_json);
    gate.waitReason = "findings";
    db.prepare("UPDATE workflow_runs SET current_phase = 'delivery_blocked', gate_state_json = ? WHERE id = ?")
      .run(JSON.stringify(gate), runId);
    db.prepare("UPDATE workflow_bindings SET delivery_mode = 'live' WHERE id = ?").run(run.binding_id);
    db.prepare(`INSERT INTO workflow_deliveries
      (id, run_id, submission_id, kind, session_id, note_key, payload, payload_sha256, state, created_at, updated_at)
      SELECT 'unsent-inspector', ?, s.id, 'inspector_feedback', b.session_id, b.note_key,
        'Old head feedback never sent', 'frozen-packet', 'prepared', ?, ?
      FROM workflow_submissions s JOIN workflow_bindings b ON b.id = ?
      WHERE s.run_id = ? ORDER BY s.round DESC LIMIT 1`)
      .run(runId, Date.now(), Date.now(), run.binding_id, runId);
    db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(PR_KEY);
    db.prepare(`UPDATE inspector_prs SET state = 'open', observed_state = 'OPEN',
      observed_head_sha = ?, head_sha = ?, clean_review_head_sha = ?, observed_at = ? WHERE key = ?`)
      .run(head, head, head, Date.now(), PR_KEY);
  });
  // A carried Inspector gate must not offer its action for another packet's block.
  withDaemonDb(daemon, (db) => db.prepare(
    "UPDATE workflow_deliveries SET kind = 'evidence_capture_repair' WHERE id = 'unsent-inspector'",
  ).run());
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  await expect(header.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(header.getByRole("button", { name: "Check again" })).toHaveCount(0);
  const refused = await fetch(`${daemon.baseURL}/api/workflow-runs/${runId}/recheck-inspector`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: "not-inspector-feedback" }),
  });
  expect(refused.status).toBe(409);
  expect(await eventCount(daemon, runId, "inspector_recheck_requested")).toBe(0);
  await shoot(dashboard, header, "05-evidence-repair-no-inspector-recheck");
  withDaemonDb(daemon, (db) => db.prepare(
    "UPDATE workflow_deliveries SET kind = 'inspector_feedback' WHERE id = 'unsent-inspector'",
  ).run());
  await dashboard.reload();
  const checkAgain = header.getByRole("button", { name: "Check again" });
  await expect(checkAgain).toBeVisible();
  scriptGitHub(daemon, "CLOSED");
  await checkAgain.click();
  await expect.poll(() => eventCount(daemon, runId, "inspector_recheck_requested")).toBe(1);
  await expect.poll(() => ledgerRow(daemon).observed_state).toBe("CLOSED");
  // An explicit recheck also respects the operator's pause and never pretends to send.
  expect((await probe(daemon, runId)).run.status).toBe("blocked");
  await checkAgain.hover();
  await dashboard.mouse.move(800, 600);
  await expect(dashboard.locator(".tooltip")).toHaveCount(0);
  await shoot(dashboard, header, trigger === "session return"
    ? "03-unsent-feedback-blocked" : "06-explicit-recheck-blocked");
  // The earlier read is no longer fresh enough for this gate. The Inspector poll is an
  // hour away, so each recovery entry point must request its own current observation.
  withDaemonDb(daemon, (db) => db.prepare(`UPDATE inspector_prs SET state = 'open',
    observed_state = 'OPEN', observed_head_sha = ?, observed_at = 0 WHERE key = ?`)
    .run(FAILED_HEAD, PR_KEY));
  scriptGitHub(daemon, trigger === "session return" ? "OPEN" : "CLOSED", head);
  await api(daemon, `/api/sessions/${encodeURIComponent(sessionId)}/resume`, {});
  if (trigger === "Check again") {
    // Session return cannot recover a remotely closed PR. Once reachable, a cached A
    // observation must not let Check again send before its own read discovers B.
    await expect.poll(() => ledgerRow(daemon).observed_state).toBe("CLOSED");
    await expect.poll(async () => (await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions"))
      .find(session => session.id === sessionId)?.state).toBe("idle");
    withDaemonDb(daemon, (db) => db.prepare(`UPDATE inspector_prs SET state = 'open',
      observed_state = 'OPEN', observed_head_sha = ?, observed_at = ? WHERE key = ?`)
      .run(FAILED_HEAD, Date.now(), PR_KEY));
    scriptGitHub(daemon, "OPEN", head);
    await checkAgain.click();
  }
  await expect.poll(async () => (await probe(daemon, runId)).run.status).toBe("completed");
  expect(await eventCount(daemon, runId, "inspector_recheck_requested"))
    .toBe(trigger === "session return" ? 1 : 2);
  expect(ledgerRow(daemon).observed_at).toBeGreaterThan(0);
  await expect(header.getByText("Completed", { exact: true })).toBeVisible();
  const packet = withDaemonDb(daemon, (db) => db.prepare(
    "SELECT state, delivered_at FROM workflow_deliveries WHERE id = 'unsent-inspector'",
  ).get());
  expect(packet).toEqual({ state: "cancelled", delivered_at: null });
  expect(await eventCount(daemon, runId, "inspector_feedback_recovered")).toBe(1);
  expect(await eventCount(daemon, runId, "inspector_persona_bypass_used")).toBe(1);
  await header.getByRole("button", { name: "Run this review again" }).hover();
  await dashboard.mouse.move(800, 600);
  await expect(dashboard.locator(".tooltip")).toHaveCount(0);
  await shoot(dashboard, header, trigger === "session return"
    ? "04-unsent-feedback-recovered" : "07-explicit-recheck-recovered");
});
}

/** Seed the parent review and its changed shipping continuation, so every gate evaluation sees the same hold. */
function seedPublishedTreeMismatch(daemon: DaemonHandle, runId: string, head: string, tree: string): void {
  strandAsClosed(daemon, runId);
  withDaemonDb(daemon, (db) => {
    const version = db.prepare(`SELECT v.id, v.graph_json FROM workflow_versions v
      JOIN workflow_runs r ON r.workflow_version_id = v.id WHERE r.id = ?`)
      .get(runId) as { id: string; graph_json: string };
    const graph = JSON.parse(version.graph_json);
    graph.nodes.push({ id: "publish", kind: "session_action", position: { x: 330, y: 0 },
      action: { sourceSessionActionId: "seeded-publish", sourceRevision: 1, name: "Publish",
        description: "", promptMarkdown: "Publish the reviewed work", requiredSkillId: null,
        completion: { kind: "pull_request" } } });
    Object.assign(graph.edges.find((edge: { id: string }) => edge.id === "pass"),
      { target: "publish", targetPort: "activate" });
    graph.edges.push({ id: "published", source: "publish", sourcePort: "complete", target: "end", targetPort: "terminal" });
    db.prepare("UPDATE workflow_versions SET graph_json = ? WHERE id = ?").run(JSON.stringify(graph), version.id);
    const parent = db.prepare("SELECT id, context_json FROM workflow_submissions WHERE run_id = ? ORDER BY round DESC LIMIT 1")
      .get(runId) as { id: string; context_json: string };
    const context = JSON.parse(parent.context_json);
    Object.assign(context.evidence, { headSha: FAILED_HEAD, contentTreeOid: "a".repeat(40), workingTreeDirty: false, workingTreeStatus: [] });
    delete context.evidence.publication;
    db.prepare("UPDATE workflow_submissions SET context_json = ? WHERE id = ?").run(JSON.stringify(context), parent.id);
    context.evidence.contentTreeOid = tree;
    context.evidence.headSha = head;
    db.prepare(`INSERT INTO workflow_submissions
      (id, run_id, round, segment, parent_submission_id, continuation_node_id, continuation_node_attempt_id, refinement_reason,
       mode, trigger_source, trigger_key, evidence_fingerprint, context_json, evidence_json, pr_head_sha, status, created_at, updated_at)
      SELECT id || '-shipping', run_id, round, 1, id, 'publish', 'seeded-publication-action', 'session_action', mode, trigger_source,
        trigger_key || '-shipping', evidence_fingerprint, ?, ?, ?, 'completed', created_at + 1, updated_at + 1
      FROM workflow_submissions WHERE id = ?`)
      .run(JSON.stringify(context), JSON.stringify(context.evidence), head, parent.id);
    const row = db.prepare("SELECT gate_state_json FROM workflow_runs WHERE id = ?").get(runId) as { gate_state_json: string };
    const gate = JSON.parse(row.gate_state_json);
    Object.assign(gate, { targetHeadSha: null, failedHeadSha: null, findingFingerprints: [] });
    db.prepare("UPDATE workflow_runs SET gate_state_json = ? WHERE id = ?").run(JSON.stringify(gate), runId);
    db.prepare("UPDATE inspector_prs SET head_sha = ?, last_attempt_sha = ? WHERE key = ?").run(head, head, PR_KEY);
    db.prepare("UPDATE inspector_comments SET github_url = ?, posted_at = ? WHERE pr_key = ?")
      .run(`${PR_URL}#discussion_r1576`, Date.now(), PR_KEY);
  });
}

// Issue #1574: the immutable gate state is seeded because publication and reviews are fake;
// the fresh-review click uses the real route, capture, Persona runner and SSE repaint.
test("a published tree changed after review offers fresh review without another push", async ({ dashboard, daemon }) => {
  const runId = await seedRun(dashboard, daemon, "E2E published tree needs review");
  const reviewedHead = execFileSync("git", ["-C", daemon.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // A real post-review commit keeps the fixture's retained proof consistent when a
  // background Inspector observation re-evaluates the gate before the operator clicks.
  writeFileSync(join(daemon.repo, "publication.txt"), "Changed after semantic review\n");
  execFileSync("git", ["-C", daemon.repo, "add", "publication.txt"]);
  execFileSync("git", ["-C", daemon.repo, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com",
    "commit", "-qm", "Post-review publication"]);
  const head = execFileSync("git", ["-C", daemon.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", daemon.repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  strandAsClosed(daemon, runId);
  withDaemonDb(daemon, (db) => {
    const submission = db.prepare("SELECT id, context_json FROM workflow_submissions WHERE run_id = ? ORDER BY round DESC LIMIT 1")
      .get(runId) as { id: string; context_json: string };
    const parent = JSON.parse(submission.context_json) as WorkflowContextSnapshot;
    const reviewedTree = parent.evidence.publication?.treeOid ?? parent.evidence.contentTreeOid;
    expect(reviewedTree).not.toBe(tree);
    const child = structuredClone(parent);
    Object.assign(child.evidence, { headSha: head, contentTreeOid: tree, workingTreeDirty: false });
    child.evidence.publication = { version: 1, treeOid: tree, unpublishedPaths: [],
      artifactProblems: [], pathsTruncated: false, localArtifacts: [] };
    db.prepare(`INSERT INTO workflow_submissions (
      id, run_id, round, segment, parent_submission_id, continuation_node_id,
      continuation_node_attempt_id, refinement_reason, mode, trigger_source, trigger_key,
      evidence_group_key, staged_image_generation, evidence_fingerprint, context_json,
      evidence_json, pr_head_sha, status, created_at, updated_at, completed_at
    ) SELECT ?, run_id, round, 1, id, 'publication', 'publication-attempt', 'session_action',
      mode, trigger_source, ?, evidence_group_key, staged_image_generation, evidence_fingerprint,
      ?, evidence_json, ?, status, created_at + 1, updated_at + 1, completed_at
      FROM workflow_submissions WHERE id = ?`)
      .run(`${submission.id}-publication`, `${runId}-publication`, JSON.stringify(child), head, submission.id);
    const version = db.prepare(`SELECT v.id, v.graph_json FROM workflow_versions v
      JOIN workflow_runs r ON r.workflow_version_id = v.id WHERE r.id = ?`)
      .get(runId) as { id: string; graph_json: string };
    const graph = JSON.parse(version.graph_json) as PublishedWorkflowGraph;
    graph.nodes.push({ id: "publication", kind: "session_action", position: { x: 330, y: 0 },
      action: { sourceSessionActionId: "publication", sourceRevision: 1, name: "Pull Request",
        description: "Publish the reviewed work", promptMarkdown: "Publish the reviewed work",
        requiredSkillId: null, completion: { kind: "pull_request" } } });
    graph.edges.find(edge => edge.id === "pass")!.target = "publication";
    graph.edges.find(edge => edge.id === "pass")!.targetPort = "activate";
    graph.edges.push({ id: "published", source: "publication", sourcePort: "complete", target: "end", targetPort: "terminal" });
    db.prepare("UPDATE workflow_versions SET graph_json = ? WHERE id = ?").run(JSON.stringify(graph), version.id);
    const row = db.prepare("SELECT gate_state_json FROM workflow_runs WHERE id = ?").get(runId) as { gate_state_json: string };
    const gate = JSON.parse(row.gate_state_json);
    Object.assign(gate, {
      waitReason: "reviewed_tree_changed", targetHeadSha: null, failedHeadSha: null,
      observedHeadSha: head, findingFingerprints: [],
      reviewedContent: { submissionId: submission.id, headSha: reviewedHead,
        treeOid: reviewedTree, publishedTreeOid: tree },
    });
    db.prepare("UPDATE workflow_runs SET status = 'waiting_for_session', current_phase = 'inspector_reviewed_tree_changed', gate_state_json = ?, updated_at = 0 WHERE id = ?")
      .run(JSON.stringify(gate), runId);
    db.prepare("UPDATE inspector_comments SET status = 'resolved' WHERE pr_key = ?").run(PR_KEY);
    db.prepare("UPDATE inspector_prs SET state = 'open', observed_state = 'OPEN', head_sha = ?, observed_head_sha = ? WHERE key = ?")
      .run(head, head, PR_KEY);
  });
  const sessionId = withDaemonDb(daemon, (db) => (db.prepare(`SELECT b.session_id
    FROM workflow_bindings b JOIN workflow_runs r ON r.binding_id = b.id WHERE r.id = ?`)
    .get(runId) as { session_id: string }).session_id);
  // Drive the session update that raced the old synthetic fixture on loaded CI runners.
  await api(daemon, `/api/sessions/${encodeURIComponent(sessionId)}/rename`, { name: "Published tree needs review" });
  await expect.poll(() => withDaemonDb(daemon, (db) => (db.prepare(
    "SELECT updated_at FROM workflow_runs WHERE id = ?").get(runId) as { updated_at: number }).updated_at))
    .toBeGreaterThan(0);
  expect((await probe(daemon, runId)).run.currentPhase).toBe("inspector_reviewed_tree_changed");
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  const review = header.getByRole("button", { name: "Review pushed head" });
  await expect(review).toBeVisible();
  await dashboard.getByRole("tab", { name: /^Completion/ }).click();
  const pane = dashboard.getByRole("tabpanel", { name: /^Completion/ });
  await expect(pane).toContainText("Pushing again will not resolve this hold");
  await expect(pane).toContainText(`reviewed ${reviewedHead.slice(0, 7)}`);
  await expect(pane).toContainText(`published ${head.slice(0, 8)}`);
  await expect(pane).toContainText(`tree ${tree.slice(0, 8)}`);
  await shoot(dashboard, dashboard, "08-published-tree-needs-review");
  await shoot(dashboard, header, "09-review-pushed-head-action");
  await review.click();
  const confirm = dashboard.getByRole("dialog", { name: "Review pushed head" });
  await expect(confirm).toBeVisible();
  await expectContentClearsBorder(confirm);
  await expect(confirm).toContainText("even though the checkout has not changed since publication");
  await confirm.getByRole("button", { name: /Start round 2|Preview fresh evidence/ }).click();
  await expect(confirm).toBeHidden();
  await expect.poll(() => withDaemonDb(daemon, (db) => db.prepare(`
    SELECT COUNT(*) AS count FROM workflow_node_attempts a JOIN workflow_submissions s ON s.id = a.submission_id
    WHERE s.run_id = ? AND s.round = 2 AND a.node_id = 'reviewer' AND a.state = 'completed' AND a.runner_id IS NOT NULL
  `).get(runId) as { count: number }).count).toBe(1);
  expect(execFileSync("git", ["-C", daemon.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(head);
});

// #1576: a publication mismatch must not swallow a current-head Inspector packet.
// Seed only the immutable publication snapshots; recheck runs the real gate and delivery preparation.
test("current-head findings remain visible as a repair packet across the published-tree hold", async ({ dashboard, daemon }) => {
  const runId = await seedRun(dashboard, daemon, "E2E published finding delivery");
  await api(daemon, "/api/inspector/config", { enabled: true, mode: "live", repoAllowlist: [daemon.repo] }, "PUT");
  const head = execFileSync("git", ["-C", daemon.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", daemon.repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  seedPublishedTreeMismatch(daemon, runId, head, tree);
  scriptGitHub(daemon, "OPEN", head);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const checkAgain = dashboard.locator("header.wf-run-head").getByRole("button", { name: "Check again" });
  await expect(checkAgain).toBeVisible();
  await checkAgain.click();
  await expect.poll(async () => (await probe(daemon, runId)).run.currentPhase).toBe("inspector_findings");
  await dashboard.getByRole("tab", { name: /^Deliveries/ }).click();
  const pane = dashboard.getByRole("tabpanel", { name: /^Deliveries/ });
  await pane.getByRole("button", { name: "Show packet" }).click();
  await expect(pane).toContainText(FINDING);
  await expect(pane).toContainText(`${PR_URL}#discussion_r1576`);
  await expect(pane).toContainText("fresh full workflow review is required even if no code changes are needed");
  await expect(pane).toContainText("not confirmed"); // Preview never claims to have sent it.
  expect((await probe(daemon, runId)).run.status).toBe("waiting_for_session");
  await shoot(dashboard, pane, "10-published-head-finding-packet");
});
