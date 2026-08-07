import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A real Pull Request action run, read in the browser: parked on each of the two
 * stray-pull-request states in turn, then recovered and completed.
 *
 * These two states are the ones an operator most needs told apart from "no pull request yet",
 * and until this spec existed the only thing proving their labels was a unit test calling
 * `sessionActionStatus` directly. That asserts a lookup table. It does not assert that the
 * daemon computes the state, that it survives the SSE projection, or that either label ever
 * reaches a screen - which is the whole reason this repository requires a browser spec for a
 * UI change.
 *
 * The completion at the end is the other half, and it is what proves the two mismatch states
 * are WAITS rather than blocks: the same run recovers from both and finishes, and the card
 * then carries the provenance a finished action leaves behind - which pull request, on which
 * branch, at which commit. Nothing else asserts that provenance renders at all.
 *
 * ## What is real here and what is stood in for
 *
 * Real: the dispatched session and its worktree, the published `pull_request` workflow, the
 * Live delivery that types the instruction, the turn the fake agent takes, the daemon's own
 * adoption path (a `prCreated` hook through `/hooks/:event`, which is one of exactly two
 * signals that prove Mission Control opened a pull request), the adapter's decision, and the
 * dashboard reading it back over SSE.
 *
 * Stood in for: what the Inspector's poll SAW on GitHub. The observation columns
 * (`head_ref_name`, `observed_head_sha`, `observed_state`) are written by the poller calling
 * `gh`, and e2e reaches no network - the same reason every agent binary here is a fake. So the
 * spec writes the row the poll would have written, and nothing else. The adapter still has to
 * read it, compare it, and choose the state; the browser still has to render it.
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

/**
 * Write what a poll would have observed about the adopted pull request.
 *
 * The one thing this file fabricates, and it fabricates only the provider's answer. WAL is on,
 * so a second writer is safe beside the running daemon, and `loadOpenInspectorPrs` is read
 * fresh on every decision - deliberately, so a cached ledger cannot leave an action waiting for
 * a head that had already arrived.
 */
function observePullRequest(
  daemon: DaemonHandle,
  patch: { branch: string; repoRoot?: string; headSha?: string },
): void {
  const db = new DatabaseSync(join(daemon.home, "harness.db"));
  try {
    db.prepare(
      `UPDATE inspector_prs
          SET head_ref_name = ?, observed_head_sha = ?, observed_state = 'OPEN', observed_at = ?
              ${patch.repoRoot ? ", repo_root = ?" : ""}
        WHERE state = 'open'`,
    ).run(
      patch.branch,
      patch.headSha ?? "a".repeat(40),
      Date.now(),
      ...(patch.repoRoot ? [patch.repoRoot] : []),
    );
  } finally {
    db.close();
  }
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

  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    }, { message: "the dispatched session should settle to idle before evidence capture" })
    .toBe("idle");
  return sessionId;
}

const actionWait = async (daemon: DaemonHandle, runId: string): Promise<string | null> =>
  (await api<{ summary: { actionWait?: string | null } }>(daemon, `/api/workflow-runs/${runId}`))
    .summary.actionWait ?? null;

test("a pull request action names each stray, then completes with its provenance", async ({
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

  // The turn opened a pull request, through the daemon's own adoption path - and the poll that
  // follows finds it on a branch this action is not about.
  await announcePullRequest(daemon, sessionId, "https://github.com/owner/repo/pull/77");
  await expect.poll(async () =>
    (await api<Array<{ key: string }>>(daemon, "/api/inspector/prs")).length,
    { message: "the prCreated hook never adopted a pull request" },
  ).toBeGreaterThan(0);
  observePullRequest(daemon, { branch: "some-other-branch" });

  await expect.poll(() => actionWait(daemon, runId), {
    message: "a pull request on another branch was not distinguished from having none",
    timeout: 120_000,
  }).toBe("pull_request_wrong_branch");

  // The label an operator actually reads, in the browser, arriving over SSE without a reload.
  await expect(card).toContainText("PR on another branch");
  await expect(card).toContainText("opened a pull request from a different branch");
  await expect(card).not.toContainText("Awaiting PR");
  await shoot(dashboard, "11-pr-on-another-branch");

  // The same run, with the pull request found in another repository entirely.
  //
  // A REAL second repository, because "a different repository" is a claim about identity that
  // the daemon resolves through git. A path that does not exist resolves to nothing, and the
  // adapter reads that as UNKNOWN rather than as a mismatch - correctly, since it will not
  // convict a session on a directory it cannot inspect.
  const otherRepo = join(daemon.workspace, "other-repo");
  mkdirSync(otherRepo, { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: otherRepo });
  observePullRequest(daemon, { branch: "some-other-branch", repoRoot: otherRepo });
  await expect.poll(() => actionWait(daemon, runId), {
    message: "a pull request in another repository was not distinguished from a branch mismatch",
    timeout: 120_000,
  }).toBe("pull_request_wrong_repository");

  await expect(card).toContainText("PR on another repo");
  await expect(card).toContainText("in a different repository");
  await shoot(dashboard, "12-pr-on-another-repo");

  // A WAIT throughout, never a block: the run is still live and the action is still waiting,
  // which is what lets a turn that opened a stray first and the right one second recover.
  const state = await api<{ run: { status: string }; attempts: Array<{ state: string }> }>(
    daemon,
    `/api/workflow-runs/${runId}`,
  );
  expect(state.run.status).toBe("waiting_for_action");
  expect(state.attempts.some((attempt) => attempt.state === "waiting")).toBe(true);

  // And the run RECOVERS from both, which is what makes them waits rather than blocks. The
  // pull request is found on the right branch, at the commit this session's checkout is
  // actually on, and the action completes.
  const session = (await api<Array<{ id: string; cwd: string; gitBranch: string | null }>>(
    daemon,
    "/api/sessions",
  )).find((item) => item.id === sessionId)!;
  const head = execFileSync("git", ["-C", session.cwd, "rev-parse", "HEAD"], { encoding: "utf8" })
    .trim();
  observePullRequest(daemon, {
    branch: session.gitBranch!,
    repoRoot: session.cwd,
    headSha: head,
  });

  await expect.poll(async () =>
    (await api<{ attempts: Array<{ nodeId: string; state: string }> }>(
      daemon,
      `/api/workflow-runs/${runId}`,
    )).attempts.some((attempt) => attempt.nodeId === NODE.action && attempt.state === "completed"),
    { message: "a matching pull request never completed the action", timeout: 180_000 },
  ).toBe(true);

  // The PROVENANCE, in the browser. This is the audit trail a finished action leaves - which
  // pull request, on which branch, at which commit - and nothing else asserts that it renders.
  // A regression could drop the link or the commit after completion and every other check here
  // would still pass, because they all read waiting states.
  await expect(card).toContainText("Complete");
  const link = card.getByRole("link", { name: "#77" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://github.com/owner/repo/pull/77");
  await expect(card).toContainText(`on ${session.gitBranch}, verified at ${head.slice(0, 8)}`);
  // The commit is the one the CONTINUATION captured, not merely the one the pull request is at.
  // Those are the same here, and the point of printing it is that a reader can tell when they
  // are not.
  await expect(card).not.toContainText("Awaiting");
  await shoot(dashboard, "13-pr-verified-provenance");
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
