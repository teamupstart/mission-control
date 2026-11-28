import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { writeGhPullRequests } from "../fixtures/fake-agents.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { ResidentProfile } from "../../src/shared/residents.ts";
import type { ReviewItem, Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: with the `async-input` preview flag on, `request_input` stops being a call
 * the agent sits inside. The question is filed and the agent keeps working; the board does not
 * call it waiting until it actually stops; the operator answers from the inbox whenever they get
 * to it; and the answer reaches the agent as a message that starts its next turn. A resident
 * keeps its cadence with a question open, and a merge closes an open question instead of
 * leaving it behind the finished task.
 *
 * Real daemon, real routes, real SSE and the real built dashboard. The question is posted on the
 * exact channel the MCP `request_input` tool uses, with the `asyncCapable` marker the tool sends,
 * and the agents are the suite's fakes, so no model tokens are spent.
 */

const EVIDENCE = artifactsDir("async-input");
const RELEASED_TURN = "E2E_HOLD_TURN_UNTIL_RELEASED";

async function capture(target: Locator | Page, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  console.log(`CAPTURED e2e/.artifacts/async-input/${name}.png`);
}

const token = (daemon: DaemonHandle) => readFileSync(join(daemon.home, "token"), "utf8").trim();

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function enableAsyncInput(daemon: DaemonHandle): Promise<void> {
  const { config } = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id: "async-input", enabled: true }, "PUT");
  expect(config.overrides["async-input"]).toBe(true);
}

const QUESTION = "Which linter should this repo use?";
const LINTER = {
  kind: "input",
  title: QUESTION,
  body: `${QUESTION}\n\nThe repo has no linter. CI runs Prettier only.`,
  snoozable: true,
  decisions: [{
    id: "q",
    question: QUESTION,
    allowOther: true,
    options: [
      { id: "o0", label: "biome", detail: "lint + format in one fast binary" },
      { id: "o1", label: "eslint", detail: "type-aware rules", recommended: true },
    ],
  }],
};

type Filed = { id: string; wait: "call" | "message"; receipt?: string };

/** Ask the way the MCP `request_input` tool does, as a child that can take a receipt. */
async function ask(daemon: DaemonHandle, cwd: string, body: Record<string, unknown>): Promise<Filed> {
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
    body: JSON.stringify({ env: {}, cwd, asyncCapable: true, ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Filed;
}

async function sessionFor(daemon: DaemonHandle, taskId: string): Promise<Session | undefined> {
  return (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === taskId);
}

async function openInbox(page: Page): Promise<Locator> {
  const inbox = page.getByRole("dialog", { name: "Attention inbox" });
  const button = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(async () => {
    if (!(await inbox.isVisible())) await button.click({ timeout: 3000 });
    await expect(inbox).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expectContentClearsBorder(inbox);
  return inbox;
}

test("a filed question lets the agent keep working, turns it amber only once it stops, and its inbox answer wakes it", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await enableAsyncInput(daemon);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Add a linter to CI", intent: `${RELEASED_TURN} add a linter to CI`,
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  // The fake holds its first turn open until released: the agent is working when it asks.
  let session!: Session;
  await expect.poll(async () => {
    session = (await sessionFor(daemon, task.id))!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("working");

  const filed = await ask(daemon, session.cwd!, { ...LINTER, meanwhile: "proceeding with eslint; the config is one file" });
  expect(filed.wait).toBe("message");
  expect(filed.receipt).toMatch(/^Filed, not answered/);
  await expect.poll(async () => {
    const s = await sessionFor(daemon, task.id);
    return s && { pendingReviews: s.pendingReviews, openQuestions: s.openQuestions };
  }).toEqual({ pendingReviews: 0, openQuestions: 1 });

  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = page.locator(".console-detail");
  const badge = detail.locator(".badge", { has: page.locator(".badge-dot") }).first();
  // Still working past its question: not amber, but the question is already in the inbox. The
  // badge names the open question in the working tone (Phase 3's working-tone branch).
  await expect(badge).toHaveText(/1 question open/);
  await expect(badge).toHaveClass(/badge-working/);
  await expect(badge).not.toHaveClass(/badge-attention/);
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("1");
  await capture(page, "working-with-question", page);

  // The agent runs out of work and ends its turn with the question still open.
  writeFileSync(join(daemon.recordDir, "e2e-release-held-turn"), "");
  await expect(badge).toHaveText(/waiting on your answer/, { timeout: 30_000 });
  await expect(badge).toHaveClass(/badge-attention/);
  await capture(page, "stopped-waiting", page);

  // Answered from the inbox, whenever the operator gets to it.
  const inbox = await openInbox(page);
  await expect(inbox).toContainText(QUESTION);
  await inbox.getByRole("radio", { name: /eslint/ }).check();
  await capture(inbox, "inbox-answer", page);
  await inbox.getByRole("button", { name: /^Submit/ }).click();
  await expect(inbox.getByText("Nothing to answer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inbox).toBeHidden();

  // The answer reaches the agent as a message, which starts its next turn.
  // The message opens with the review marker line, then exactly the answer text.
  await expect(detail.getByText(`Mock reply to: [mission-control:answer review=${filed.id}]`, { exact: false }).first())
    .toBeVisible({ timeout: 30_000 });
  await expect(badge).not.toHaveClass(/badge-attention/);
  // The conversation shows the operator's answer once, as the gold answer entry. The message
  // that carried it to the agent is the daemon's words, never drawn as an operator turn.
  await expect(detail.locator(".review-answer")).toContainText("you answered");
  await expect(detail.locator(".review-answer")).toContainText(QUESTION);
  await expect(detail.locator(".turn-user").first()).toContainText("add a linter to CI");
  await expect(detail.locator(".turn-user", { hasText: `Mission Control answer to question ${filed.id}` })).toHaveCount(0);
  expect((await api<ReviewItem[]>(daemon, "/api/reviews")).find((r) => r.id === filed.id)).toMatchObject({
    status: "answered", waitMode: "message", meanwhile: "proceeding with eslint; the config is one file",
  });
  await capture(page, "answered-resumed", page);
});

type Run = { iteration: number; loop_state: string };
function liveRun(daemon: DaemonHandle): Run | undefined {
  return withDaemonDb(daemon, (db) => db.prepare(
    "SELECT iteration, loop_state FROM resident_runs WHERE ended_at IS NULL AND launch_state = 'launched'",
  ).get() as Run | undefined);
}

test("a resident keeps waking on its cadence while its filed question waits in the inbox", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await enableAsyncInput(daemon);
  const personas = await api<Array<{ id: string; name: string }>>(daemon, "/api/personas");
  const profile = await api<ResidentProfile>(daemon, "/api/residents/profiles", { settings: {
    identity: { name: "Linter watcher" },
    persona: { personaId: personas.find((p) => p.name === "Code Risk Reviewer")!.id },
    workspace: { defaultRepoRoot: daemon.repo },
    execution: { model: "claude-fable-5" },
    loop: { delaySeconds: 2, minDelaySeconds: 1, maxDelaySeconds: 3600, iterationCap: 50 },
  } });
  await api(daemon, `/api/residents/profiles/${profile.id}/launch`, { repoRoot: daemon.repo, requestId: "launch-linter-watcher" });
  await expect.poll(() => liveRun(daemon)?.iteration ?? null, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  const resident = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.kind === "resident")!;

  const filed = await ask(daemon, resident.cwd!, LINTER);
  expect(filed.wait).toBe("message");
  const asked = liveRun(daemon)!.iteration;
  // Two more iterations on its own cadence, with the question still open the whole time.
  await expect.poll(() => liveRun(daemon)?.iteration, { timeout: 60_000 }).toBeGreaterThanOrEqual(asked + 2);
  expect(liveRun(daemon)?.loop_state).not.toBe("paused");
  expect((await api<ReviewItem[]>(daemon, "/api/reviews")).find((r) => r.id === filed.id)?.status).toBe("pending");
  await page.goto(`${daemon.baseURL}/#/fleet`);
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" }).locator(".pulse-n")).toHaveText("1");
  await capture(page, "resident-iterating-with-question", page);
});

test("a merge completes the task with a question open and takes the question out of the inbox", async ({ dashboard: page, daemon }) => {
  test.setTimeout(120_000);
  await enableAsyncInput(daemon);
  await api(daemon, "/api/shipping/config", { closeSessionAfterMerge: false }, "PUT");
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Ship the linter", intent: "add a linter to CI",
    kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await sessionFor(daemon, task.id))!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");

  const filed = await ask(daemon, session.cwd!, LINTER);
  expect(filed.wait).toBe("message");
  await page.goto(`${daemon.baseURL}/#/fleet`);
  const toAnswer = page.locator("button.pulse-seg", { hasText: "to answer" });
  await expect(toAnswer.locator(".pulse-n")).toHaveText("1");
  await capture(page, "before-merge", page);

  const cwd = session.cwd!;
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git("switch", "-c", "feat/linter");
  writeFileSync(join(cwd, "lint.txt"), "eslint\n");
  git("add", "lint.txt");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "Add a linter");
  const prUrl = "https://github.com/acme/mission-e2e/pull/1601";
  writeGhPullRequests(daemon.home, [{
    cwd, number: 1601, url: prUrl, state: "MERGED", createdAt: new Date().toISOString(),
    mergedAt: new Date().toISOString(), headRefOid: git("rev-parse", "HEAD"), headRefName: git("branch", "--show-current"),
  }]);
  const hook = async (event: string, extra = {}) => {
    const response = await fetch(`${daemon.baseURL}/hooks/${event}`, {
      method: "POST", headers: { "content-type": "application/json", "x-harness-token": token(daemon) },
      body: JSON.stringify({ agent: session.agent, sessionId: session.agentSessionId, cwd, env: {}, ...extra }),
    });
    expect(response.status).toBe(204);
  };
  await hook("PostToolUse", { toolName: "Bash", prCreated: true, prUrl, prUrls: [prUrl] });
  await expect.poll(async () => (await sessionFor(daemon, task.id))?.prState, { timeout: 30_000 }).toBe("merged");
  await hook("Stop");

  // The merge is the operator's conclusion: the task completes, and the question goes with it.
  await expect.poll(async () => (await api<Task[]>(daemon, "/api/tasks")).find((t) => t.id === task.id)?.status,
    { timeout: 30_000 }).toBe("done");
  await expect.poll(async () => (await api<ReviewItem[]>(daemon, "/api/reviews")).find((r) => r.id === filed.id))
    .toMatchObject({ status: "orphaned", closedReason: "merged" });
  await expect(toAnswer).toHaveCount(0);
  await capture(page, "after-merge", page);
});
