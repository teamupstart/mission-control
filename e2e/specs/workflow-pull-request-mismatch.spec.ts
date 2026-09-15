import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
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

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
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

  // Native acquisition is detached. Model the branch the working agent creates, then send
  // the same live hook that lets the daemon observe it without enabling host process scans
  // in the isolated browser fixture.
  execFileSync("git", ["-C", session!.cwd, "switch", "-q", "-c", "e2e/pr-mismatch"]);
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

test("a durably adopted pull request completes before provider metadata arrives", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(360_000);
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const sessionId = await dispatch(dashboard, daemon);

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
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-pr-mismatch" },
  );
  const runId = submitted.run.id;

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
