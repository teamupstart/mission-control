import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A real Pull Request action run, read in the browser: the PR is durably adopted before its
 * provider metadata arrives, the missing comparison facts become a warning, and the workflow
 * still completes.
 *
 * The browser assertion covers the product boundary: the card says the PR opened, names the
 * ref disagreement without using a failure state, and offers the completed run's existing
 * fresh-review action. A unit test alone cannot prove that warning survives the SSE projection.
 *
 * ## What is real here and what is stood in for
 *
 * Real: the dispatched session and its worktree, the published `pull_request` workflow, the
 * Live delivery that types the instruction, the turn the fake agent takes, the daemon's own
 * adoption path (a `prCreated` hook through `/hooks/:event`, which is one of exactly two
 * signals that prove Mission Control opened a pull request), the adapter's decision, and the
 * dashboard reading it back over SSE.
 *
 * No Inspector poll is fabricated. That absence is the point: durable creation adoption is
 * sufficient, and the later GitHub comparison fields are optional diagnostics.
 */

const NODE = { session: "session-node", action: "action-node", end: "end-node" };
const PROMPT = "# Pull Request\n\nOpen the pull request for the reviewed work.\n";
const EVIDENCE = artifactsDir("workflow-session-action-authoring");

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
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

/**
 * The daemon's own adoption signal: the hook a harness fires when `gh pr create` returns.
 *
 * One of exactly two signals that prove Mission Control opened a pull request, so driving it
 * rather than writing the row is what makes the adoption here the real path. The hook carries
 * the AGENT's session id, not the card's - `agentSessionId` off the session API - because a
 * hook naming the wrong one lands on no session at all, and this spec would then pass by never
 * adopting anything.
 */
async function announcePullRequest(daemon: DaemonHandle, sessionId: string, url: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const session = (await api<Array<{
    id: string;
    agent: string;
    cwd: string;
    agentSessionId: string | null;
  }>>(daemon, "/api/sessions")).find((item) => item.id === sessionId)!;
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? sessionId,
      cwd: session.cwd,
      prCreated: true,
      prUrl: url,
    }),
  });
  if (!response.ok) throw new Error(`hook answered ${response.status}: ${await response.text()}`);
}

async function dispatch(page: Page, daemon: DaemonHandle, unchanged = false): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the PR spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let session: {
    id: string;
    state: string;
    cwd: string;
    agent: string;
    agentSessionId: string | null;
    gitBranch: string | null;
  } | undefined;
  await expect
    .poll(async () => {
      const sessions = await api<Array<NonNullable<typeof session>>>(daemon, "/api/sessions");
      session = sessions.find((item) => item.state !== "exited");
      return session?.state ?? "";
    }, { message: "the dispatched session should settle to idle before evidence capture" })
    .toBe("idle");

  if (unchanged) return session!.id;

  // Native acquisition is detached. Model the branch the working agent creates, then send
  // the same live hook that lets the daemon observe it without enabling host process scans
  // in the isolated browser fixture.
  execFileSync("git", ["-C", session!.cwd, "switch", "-q", "-c", "e2e/pr-mismatch"]);
  execFileSync("git", ["-C", session!.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Work to publish"]);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const observed = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({
      agent: session!.agent,
      sessionId: session!.agentSessionId ?? session!.id,
      cwd: session!.cwd,
    }),
  });
  if (!observed.ok) throw new Error(`branch observation hook answered ${observed.status}`);
  await expect.poll(async () =>
    (await api<Array<{ id: string; gitBranch: string | null }>>(daemon, "/api/sessions"))
      .find((item) => item.id === session!.id)?.gitBranch ?? null,
  ).toBe("e2e/pr-mismatch");
  return session!.id;
}

const actionWait = async (daemon: DaemonHandle, runId: string): Promise<string | null> =>
  (await api<{ summary: { actionWait?: string | null } }>(daemon, `/api/workflow-runs/${runId}`))
    .summary.actionWait ?? null;

/** Seed only a sibling Persona's finished review and refused packet, without model calls.
 * The retry endpoint, conversation hold, release, delivery, and rendered Runs state stay real.
 */
async function queueSiblingFeedback(daemon: DaemonHandle, runId: string): Promise<string> {
  await expect.poll(async () => (await api<{ deliveries: Array<{ state: string }> }>(daemon,
    `/api/workflow-runs/${runId}`)).deliveries.some(d => d.state === "delivered")).toBe(true);
  const peer = withDaemonDb(daemon, db => {
    const run = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId)!;
    const binding = db.prepare("SELECT * FROM workflow_bindings WHERE id = ?").get(run.binding_id as string)!;
    const submission = db.prepare("SELECT * FROM workflow_submissions WHERE run_id = ? ORDER BY round, segment LIMIT 1").get(runId)!;
    const delivery = db.prepare("SELECT * FROM workflow_deliveries WHERE run_id = ? LIMIT 1").get(runId)!;
    const clone = (table: string, row: Record<string, unknown>, patch: Record<string, unknown>) => {
      const values = { ...row, ...patch };
      db.prepare(`INSERT INTO ${table} (${Object.keys(values).join(",")}) VALUES (${Object.keys(values).map(() => "?").join(",")})`)
        .run(...Object.values(values) as SQLInputValue[]);
    };
    const peerId = `${runId}-sibling`;
    clone("workflow_bindings", binding, { id: peerId, repo_root: daemon.secondRepo,
      session_repo_root: daemon.secondRepo, session_cwd: daemon.secondRepo });
    clone("workflow_runs", run, { id: peerId, binding_id: peerId, trigger_key: peerId,
      status: "waiting_for_session", current_phase: "persona_feedback" });
    clone("workflow_submissions", submission, { id: peerId, run_id: peerId, trigger_key: peerId,
      round: 3, status: "waiting_for_session" });
    const payload = "Repair the sibling repository's round-3 review finding.";
    clone("workflow_deliveries", delivery, { id: peerId, run_id: peerId, submission_id: peerId,
      kind: "persona_feedback", node_attempt_id: null, state: "refused", delivered_at: null,
      payload, payload_sha256: createHash("sha256").update(payload).digest("hex") });
    return { id: peerId, sessionId: binding.session_id, noteKey: binding.note_key };
  });
  await api(daemon, `/api/workflow-deliveries/${peer.id}/retry`, {
    requestId: "queue-sibling", expectedSessionId: peer.sessionId, expectedNoteKey: peer.noteKey,
  });
  // Retry enrolls the packet behind the live holder before claiming a send. Restore the
  // normal prepared Persona-packet seed; no delivery or hold outcome is seeded.
  withDaemonDb(daemon, db => db.prepare("UPDATE workflow_deliveries SET state = 'prepared' WHERE id = ? AND state = 'refused'").run(peer.id));
  const held = await api<{ deliveryHold: { runId: string } | null; deliveries: Array<{ state: string }> }>(daemon,
    `/api/workflow-runs/${peer.id}`);
  expect(held.deliveryHold?.runId).toBe(runId);
  expect(held.deliveries[0]?.state).toBe("prepared");
  return peer.id;
}

for (const scenario of ["unobserved", "merged", "operator", "no_change", "missing_base", "missing_tree", "retry_adoption", "detached_ahead", "tree_retry_adoption"]) test(scenario === "tree_retry_adoption" ? "missing accepted-tree proof allows a late PR adoption before recovery" : scenario === "detached_ahead" ? "a detached checkout with commits ahead waits for late PR adoption" : scenario === "retry_adoption" ? "a delayed PR adoption completes during a transient proof-read retry" : scenario.startsWith("missing_") ? `${scenario} proof blocks with a recovery action and releases sibling feedback` : scenario === "no_change" ? "an unchanged detached repository completes without a PR and explains why in Runs" : scenario === "merged"
  ? "an earlier merged PR completes the action and names the publication in Runs"
  : scenario === "operator" ? "Fleet and Runs identify the operator when an action needs an answer"
  : "a durably adopted pull request completes before provider metadata arrives", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  const alreadyMerged = scenario === "merged";
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const detached = scenario === "no_change" || scenario.startsWith("missing_") || scenario === "retry_adoption" || scenario === "detached_ahead" || scenario === "tree_retry_adoption";
  const sessionId = await dispatch(dashboard, daemon, detached);
  if (scenario === "detached_ahead") {
    const session = (await api<Array<{ id: string; cwd: string }>>(daemon, "/api/sessions")).find(s => s.id === sessionId)!;
    execFileSync("git", ["-C", session.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Detached work to publish"]);
    expect(execFileSync("git", ["-C", session.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()).toBe("HEAD");
    expect(execFileSync("git", ["-C", session.cwd, "rev-list", "--count", "origin/main..HEAD"], { encoding: "utf8" }).trim()).toBe("1");
  }

  // A `pull_request` action - the completion this build now proves, and the one whose graph
  // this spec's ancestor pinned as unpublishable.
  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Open the pull request",
    description: "Open the pull request for the reviewed work",
    promptMarkdown: PROMPT,
    requiredSkillId: null,
    completion: { kind: "pull_request" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E pull request run",
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.action, kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: NODE.session, sourcePort: "submitted", target: NODE.action, targetPort: "activate" },
        { id: "e-complete", source: NODE.action, sourcePort: "complete", target: NODE.end, targetPort: "terminal" },
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
  if (alreadyMerged) {
    await announcePullRequest(daemon, sessionId, "https://github.com/owner/repo/pull/77");
    const session = (await api<Array<{ id: string; cwd: string }>>(daemon, "/api/sessions"))
      .find(item => item.id === sessionId)!;
    const head = execFileSync("git", ["-C", session.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // Seed the Inspector's historical provider observation in the disposable daemon only.
    // Everything from the later delivery through continuation and rendering is production code.
    withDaemonDb(daemon, db => {
      const seeded = db.prepare(`UPDATE inspector_prs SET state = 'closed',
        observed_state = 'MERGED', observed_head_sha = ?, head_ref_name = 'e2e/pr-mismatch',
        observed_at = 1, merged_at = 1 WHERE url = ?`).run(head, "https://github.com/owner/repo/pull/77");
      expect(Number(seeded.changes), "the hook must adopt PR #77 before seeding its merge").toBe(1);
    });
  }
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-pr-mismatch" },
  );
  const runId = submitted.run.id;

  if (detached) {
    if (scenario === "missing_base" || scenario === "retry_adoption") {
      const session = (await api<Array<{ id: string; cwd: string }>>(daemon, "/api/sessions")).find(s => s.id === sessionId)!;
      // Remove only base refs in this disposable fixture; HEAD remains a real detached commit.
      for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/heads/main"]) {
        execFileSync("git", ["-C", session.cwd, "update-ref", "--no-deref", "-d", ref]);
      }
    }
    const siblingId = await queueSiblingFeedback(daemon, runId);
    if (scenario === "missing_tree" || scenario === "tree_retry_adoption") withDaemonDb(daemon, db => {
      // Delivery proves capture has finished. Remove the historical proof only now, so an
      // in-flight capture cannot overwrite the seed with a freshly measured content tree.
      const updated = db.prepare("UPDATE workflow_submissions SET context_json = json_remove(context_json, '$.evidence.contentTreeOid', '$.evidence.publication') WHERE run_id = ?")
        .run(runId);
      expect(Number(updated.changes)).toBe(1);
      const stored = db.prepare("SELECT json_extract(context_json, '$.evidence.contentTreeOid') AS tree FROM workflow_submissions WHERE run_id = ?").get(runId);
      expect(stored?.tree).toBeNull();
    });
    await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
    if (scenario === "missing_base" || scenario === "retry_adoption" || scenario === "missing_tree" || scenario === "tree_retry_adoption") {
      await expect.poll(() => actionWait(daemon, runId), { timeout: 30_000 }).toBe("awaiting_proof");
    }
    if (scenario === "retry_adoption" || scenario === "detached_ahead" || scenario === "tree_retry_adoption") {
      if (scenario === "detached_ahead") {
        await expect.poll(() => actionWait(daemon, runId), { timeout: 30_000 }).toBe("awaiting_pull_request");
        await expect(dashboard.locator("article.wf-run-action")).toContainText("Awaiting PR");
      }
      await announcePullRequest(daemon, sessionId, "https://github.com/owner/repo/pull/77");
      await expect.poll(async () =>
        (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
      { timeout: 30_000 }).toBe("completed");
      await expect.poll(async () => (await api<{ deliveries: Array<{ state: string }> }>(daemon,
        `/api/workflow-runs/${siblingId}`)).deliveries[0]?.state).toBe("delivered");
      await expect(dashboard.locator("article.wf-run-action")).toContainText("PR opened with warning");
      await shoot(dashboard, scenario === "tree_retry_adoption" ? "23-missing-tree-adopted" : scenario === "detached_ahead" ? "21-detached-ahead-adopted" : "19-proof-retry-adopted");
      return;
    }
    try {
      await expect.poll(async () =>
        (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
    { timeout: scenario.startsWith("missing_") ? 90_000 : 45_000 }).toBe(scenario === "no_change" ? "completed" : "blocked");
    } catch (error) {
      const holder = await api(daemon, `/api/workflow-runs/${runId}`);
      const sibling = await api(daemon, `/api/workflow-runs/${siblingId}`);
      const summarize = (detail: unknown) => {
        const d = detail as { run: { status: string }; summary: { actionWait: string; recovery: unknown }; deliveryHold: unknown;
          deliveries: Array<{ state: string }> };
        return { status: d.run.status, actionWait: d.summary.actionWait, deliveryHold: d.deliveryHold,
          packetStates: d.deliveries.map(p => p.state), recovery: d.summary.recovery };
      };
      console.log("Unchanged-repository stall evidence", JSON.stringify({ holder: summarize(holder), sibling: summarize(sibling) }));
      await shoot(dashboard, "17-baseline-stall");
      await dashboard.goto(`${daemon.baseURL}/#/runs/${siblingId}`);
      await expect(dashboard.getByRole("heading", { name: "E2E pull request run", exact: true })).toBeVisible();
      await shoot(dashboard, "17-baseline-sibling");
      throw error;
    }
    await expect.poll(async () => (await api<{ deliveries: Array<{ state: string }> }>(daemon,
      `/api/workflow-runs/${siblingId}`)).deliveries[0]?.state).toBe("delivered");
    const card = dashboard.locator("article.wf-run-action");
    if (scenario !== "no_change") {
      await expect(card).toContainText(scenario === "missing_base" ? "default base" : "accepted content tree");
      await expect(card).toContainText("resubmit with fresh evidence");
      await expect(dashboard.getByRole("button", { name: "Start repair round 2", exact: true })).toBeEnabled();
      await card.scrollIntoViewIfNeeded();
      await shoot(dashboard, `${scenario === "missing_tree" ? "22" : "20"}-${scenario}-proof-retry`, true);
      return;
    }
    await expect(card).toContainText("No changes to publish");
    await expect(card).toContainText("No pull request was needed");
    await expect(card).not.toContainText("PR opened");
    expect(await api<unknown[]>(daemon, "/api/inspector/prs")).toEqual([]);
    await shoot(dashboard, "16-no-change");
    return;
  }
  if (alreadyMerged) {
    await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
    { timeout: 180_000 }).toBe("completed");
    const card = dashboard.locator("article.wf-run-action");
    await expect(card).toContainText("Already published through merged pull request");
    await expect(card).toContainText("no new pull request is needed");
    await expect(card).not.toContainText("Awaiting PR");
    await expect(card.getByRole("link", { name: "#77" })).toHaveAttribute("href", "https://github.com/owner/repo/pull/77");
    await shoot(dashboard, "13-already-merged");
    return;
  }
  // The turn runs for real and settles, and with nothing adopted the honest answer is that no
  // pull request has appeared. This is the CONTROL for everything below: without it, a spec
  // that only ever saw the mismatch labels could not tell them from the state they replaced.
  await expect.poll(() => actionWait(daemon, runId), {
    message: "the action never settled into a wait for its pull request",
    timeout: 180_000,
  }).toBe("awaiting_pull_request");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const card = dashboard.locator("article.wf-run-action");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Awaiting PR");

  let expectedOwner = "Next: the session must open or identify the pull request.";
  let expectedReason = "Waiting for a pull request";
  if (scenario === "operator") {
    const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
    const asked = await fetch(`${daemon.baseURL}/mcp/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-token": token },
      body: JSON.stringify({ env: {}, sessionId, kind: "input", title: "Which branch should I publish?",
        body: "Confirm the publication branch before continuing.",
        decisions: [{ id: "branch", question: "Which branch should I publish?",
          options: [{ id: "current", label: "Current branch" }], allowOther: true }] }),
    });
    expect(asked.status, await asked.clone().text()).toBe(200);
    await expect.poll(() => actionWait(daemon, runId), { timeout: 60_000 }).toBe("needs_operator");
    expectedOwner = "Next: you must answer the session's question.";
    expectedReason = "waiting on an answer from you";
  }
  await expect(card).toContainText(expectedOwner);
  await expect(card).toContainText(expectedReason);
  await shoot(dashboard, `14-runs-wait-${scenario}`);

  // Both Fleet layouts show the same reason/actor without opening workflow details.
  for (const layout of ["board", "console"] as const) {
    await api(daemon, "/api/ui/config", { layout }, "PUT");
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    await dashboard.reload();
    const wait = dashboard.locator(layout === "board" ? ".tile .workflow-action-wait" : ".rail-row .workflow-action-wait");
    await expect(wait).toContainText(expectedOwner);
    await expect(wait).toContainText(expectedReason);
    await expect(wait).toBeVisible();
    if (layout === "console") {
      const row = dashboard.locator(".rail-row").filter({ has: dashboard.locator(".workflow-action-wait") });
      await expect(row).toHaveAccessibleName(await row.locator(".rail-name").innerText());
      await expect(row).toHaveAccessibleDescription(new RegExp(expectedOwner));
      await expect(row).toHaveAccessibleDescription(new RegExp(expectedReason));
    }
    await shoot(dashboard, `15-${layout}-wait-${scenario}`);
  }
  if (scenario === "operator") return;
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);

  // The turn opened a pull request through the daemon's own adoption path. Do not fabricate a
  // provider poll: the newly adopted row deliberately still has null comparison metadata.
  await announcePullRequest(daemon, sessionId, "https://github.com/owner/repo/pull/77");
  await expect.poll(async () =>
    (await api<Array<{ key: string }>>(daemon, "/api/inspector/prs")).length,
    { message: "the prCreated hook never adopted a pull request" },
  ).toBeGreaterThan(0);
  await expect.poll(async () =>
    (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
  { message: "the PR warning stopped the workflow", timeout: 120_000 }).toBe("completed");

  // The warning arrives over SSE without a reload, while the action and run remain complete.
  await expect(card).toContainText("Complete");
  await expect(card).toContainText("PR opened with warning");
  await expect(card).toContainText("branch, pushed ref, pull-request state");
  await expect(card).toContainText("not available for comparison");
  await expect(card).toContainText("workflow continued");
  await expect(card).not.toContainText("Awaiting PR");
  const link = card.getByRole("link", { name: "#77" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://github.com/owner/repo/pull/77");
  await expect(card).toContainText("on a branch not yet observed, pushed ref not yet observed");
  await expect(dashboard.getByRole("button", { name: "Run this review again" })).toBeVisible();
  await shoot(dashboard, "11-pr-mismatch-warning");
  if (process.env.MC_E2E_EVIDENCE) {
    await card.screenshot({ path: `${EVIDENCE}12-pr-warning-card.png` });
  }
});

/** Both widths, for `workflow-session-action-evidence.spec.ts`' reason. */
async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  for (const [suffix, width] of [["wide", 1440], ["narrow", 720]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}${name}-${suffix}.png`, fullPage });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
