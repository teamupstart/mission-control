import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Issue #1733, reproduced with a real daemon restart rather than a seeded row.
 *
 * A live Pull Request action is delivered into a real SDK session, the daemon is stopped while
 * that action is still waiting on its turn, and a new daemon comes up on the same home. Nothing
 * is written behind the daemon: the run, the delivered packet, the session restore and every
 * observer sweep after the restart are the product's own.
 *
 * The claim is about the window after the restart. The run must never be blocked as
 * `session_action_blocked` while its session is being restored, and must come out either still
 * waiting on the action or finished by it - never parked where only Cancel is left.
 *
 * A REGRESSION GUARD, not the reproduction. A clean restart restores the SDK session before the
 * workflow observer's first sweep (workflow recovery waits for the first discovery pass, which
 * waits for the restore), so this passes on the build before the fix as well. The report's
 * stranding needs the bound session to read `exited` or missing while the observer looks; that
 * decision is reproduced through the real Registry and manager in
 * `test/session-action-runtime.test.ts`, and the operator's recovery in
 * `workflow-session-lost-recheck.spec.ts`. This spec holds the line that the grace window and
 * the re-check do not disturb a delivered action that a restart merely interrupts.
 */

const EVIDENCE = artifactsDir("workflow-session-action-restart");
/** Two full observer sweeps (15 s each) after the first one the new daemon runs. */
const OBSERVE_MS = 40_000;

async function shoot(target: Page | Locator, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/workflow-session-action-restart/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

interface RunDetail {
  run: { status: string; currentPhase: string; gateState: { code?: string; detail?: string } | null };
  summary: { actionWait?: string | null; round: number };
  deliveries: Array<{ kind: string; state: string }>;
  events: Array<{ kind: string }>;
}

const detail = (daemon: DaemonHandle, runId: string): Promise<RunDetail> =>
  api<RunDetail>(daemon, `/api/workflow-runs/${runId}`);

const sessionState = async (daemon: DaemonHandle, sessionId: string): Promise<string> => {
  const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions").catch(() => []);
  return sessions.find((session) => session.id === sessionId)?.state ?? "missing";
};

/** A live Pull Request action, delivered into a real SDK session and still waiting on its turn. */
async function deliverPullRequestAction(page: Page, daemon: DaemonHandle): Promise<{ runId: string; sessionId: string }> {
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the restart spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle to idle", timeout: 60_000 }).toBe("idle");

  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Pull Request across a restart",
    description: "Open the pull request",
    promptMarkdown: "# Open the pull request\n\nPublish the reviewed work.\n",
    completion: { kind: "pull_request" },
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E restart during a Pull Request action",
    draft: {
      nodes: [
        { id: "session-node", kind: "session", position: { x: 0, y: 0 } },
        { id: "action-node", kind: "session_action", sessionActionId: action.id, position: { x: 240, y: 0 } },
        { id: "end-node", kind: "end", outcome: "Approved", position: { x: 480, y: 0 } },
      ],
      edges: [
        { id: "e-submit", source: "session-node", sourcePort: "submitted", target: "action-node", targetPort: "activate" },
        { id: "e-complete", source: "action-node", sourcePort: "complete", target: "end-node", targetPort: "terminal" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id, sessionId, deliveryMode: "live", triggerMode: "manual",
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon, `/api/workflow-bindings/${binding.id}/submit`, { requestId: "e2e-restart-pull-request" },
  );
  const runId = submitted.run.id;

  // Stop the daemon while the action is genuinely in flight: the packet confirmed delivered and
  // the turn not yet settled, which is the window the report's restart landed in.
  await expect.poll(async () => {
    const current = await detail(daemon, runId);
    const delivered = current.deliveries.some((d) => d.kind === "session_action" && d.state === "delivered");
    return `${current.run.status}/${delivered}/${current.summary.actionWait}`;
  }, { message: "the Pull Request action should be delivered and working", timeout: 60_000, intervals: [100] })
    .toMatch(/^waiting_for_action\/true\/(awaiting_pickup|working)$/);
  return { runId, sessionId };
}

test("a daemon restart during a delivered Pull Request action never strands the run as session_lost", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(240_000);
  const { runId, sessionId } = await deliverPullRequestAction(dashboard, daemon);
  const before = await detail(daemon, runId);
  console.log(`BEFORE RESTART run=${before.run.status}/${before.run.currentPhase} wait=${before.summary.actionWait}`
    + ` deliveries=${before.deliveries.map((d) => `${d.kind}:${d.state}`).join(",")}`
    + ` session=${await sessionState(daemon, sessionId)}`);

  await daemon.shutdown();
  await daemon.restart();

  const seen: string[] = [];
  const started = Date.now();
  while (Date.now() - started < OBSERVE_MS) {
    const current = await detail(daemon, runId);
    const line = `${current.run.status}/${current.run.currentPhase}/${current.summary.actionWait ?? "-"}`
      + ` session=${await sessionState(daemon, sessionId)}`
      + (current.run.gateState?.code ? ` code=${current.run.gateState.code}` : "");
    if (seen.at(-1)?.replace(/^\+\d+ms /, "") !== line) {
      seen.push(`+${Date.now() - started}ms ${line}`);
      console.log(`AFTER RESTART +${Date.now() - started}ms ${line}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const after = await detail(daemon, runId);
  // The headline: across the whole window, the restart never blocked the action.
  expect(seen.filter((line) => line.includes("session_action_blocked")), seen.join("\n")).toEqual([]);
  expect(after.events.map((event) => event.kind)).not.toContain("session_action_blocked");
  expect(["waiting_for_action", "capturing", "completed"]).toContain(after.run.status);
  expect(after.summary.round).toBe(1);
  // One instruction, typed once, across the restart.
  expect(after.deliveries.filter((d) => d.kind === "session_action")).toHaveLength(1);

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  await expect(header).toBeVisible();
  await expect(header.getByText("Blocked", { exact: true })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Cancel run" })).toHaveCount(after.run.status === "completed" ? 0 : 1);
  await dashboard.mouse.move(0, 0);
  await shoot(header, "01-after-restart");
});
