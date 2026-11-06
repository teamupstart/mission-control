import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

// A reply that picks one of the options a session offered used to come back from the goal
// model as an "amendment" whose objective did not keep the current one as its prefix. The
// refiner stamped it unclear and latched it: the drawer said wrap-up was paused, the Goal line
// said so too, and a bound Workflow was never reached. It now resolves as steering. The fake
// agent answers `amend` with a non-prefixed objective whenever the instruction carries the
// E2E_AMEND_SHRINK marker, so the real refiner, registry and drawer are what this drives.

const REQUEST = "Ship the stuck goal recovery feature";
const PICK = "E2E_AMEND_SHRINK pick option B";
test.use({ daemonEnv: { MISSION_GOAL_POLL_MS: "20", MISSION_GOAL_REFRESH_MS: "20" } });

interface Goal {
  objective: string | null;
  objectiveVersion: number;
  promptRevision: number;
  resolvedPromptRevision: number;
  relationship: string | null;
  rationale: string | null;
  pendingPrompts: unknown[];
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function goalOf(daemon: DaemonHandle, sessionId: string): Promise<Goal> {
  const response = await fetch(`${daemon.baseURL}/api/sessions/${sessionId}/goal`);
  expect(response.ok, "the goal route should answer").toBe(true);
  return (await response.json()) as Goal;
}

/** Dispatch one agent from the modal and wait for its opening objective to resolve. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(REQUEST);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const response = await fetch(`${daemon.baseURL}/api/sessions`);
    const sessions = (await response.json()) as Array<{ id: string; state: string }>;
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { message: "the dispatched session should settle" }).toBe("idle");
  await expect.poll(async () => (await goalOf(daemon, sessionId)).resolvedPromptRevision,
    { message: "the opening objective should resolve" }).toBe(1);
  return sessionId;
}

test("an amendment that drops the objective resolves as steering and leaves wrap-up unpaused", async ({ dashboard, daemon }) => {
  const sessionId = await dispatch(dashboard, daemon);
  const opening = await goalOf(daemon, sessionId);
  expect(opening.objective).toBe(REQUEST);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const detail = dashboard.locator(".console-detail");
  const reply = detail.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill(PICK);
  await reply.press("Enter");

  await expect.poll(async () => {
    const goal = await goalOf(daemon, sessionId);
    return goal.promptRevision >= 2 && goal.resolvedPromptRevision === goal.promptRevision
      ? goal.relationship
      : "pending";
  }, { message: "the misread amendment should resolve rather than latch" }).toBe("steer");
  const resolved = await goalOf(daemon, sessionId);
  expect(resolved.objective, "steering must not adopt the proposed objective").toBe(REQUEST);
  expect(resolved.objectiveVersion).toBe(opening.objectiveVersion);
  expect(resolved.pendingPrompts).toEqual([]);
  expect(resolved.rationale).toMatch(/^Treated as steering: /);

  // The Goal line no longer tells the person automatic wrap-up is paused.
  const goalLine = detail.locator("p.goal");
  await expect(goalLine).toHaveText(REQUEST);
  await expect(goalLine).toHaveAccessibleDescription(REQUEST);
  await expect(goalLine).not.toHaveAccessibleDescription(/paused/);

  await dashboard.getByRole("button", { name: "Foreman intent", exact: true }).click();
  const drawer = dashboard.locator(".foreman-drawer");
  await expect(drawer).toBeVisible();
  const intent = drawer.locator("section.fd-intent");
  await expect(intent.locator(".fd-intent-relation")).toHaveText("steering");
  await expect(intent.locator(".fd-intent-objective")).toHaveText(REQUEST);
  await expect(intent.locator(".fd-intent-version")).toHaveText(`objective v${opening.objectiveVersion}`);
  await expect(intent.locator(".fd-intent-reading")).toContainText(
    "Treated as steering: the proposed amendment did not retain the current objective.",
  );
  await expect(intent).not.toContainText("Automatic wrap-up is paused");
  await expect(intent).not.toContainText("needs more context");

  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("goal-amendment-downgrade");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await drawer.screenshot({ path: `${dir}foreman-intent-steering.png` });
  }
});

interface LiveSession {
  id: string;
  agent: string;
  agentSessionId: string | null;
  cwd: string;
  state: string;
  pendingTurns: unknown[];
  workCycle: { logicalKey: string; generation: number; active: boolean; completedAt: number | null } | null;
}

/** A published Workflow whose binding Foreman completes: the review a stuck session never reached. */
async function bindForemanCompleteWorkflow(daemon: DaemonHandle, sessionId: string): Promise<void> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Downgrade reviewer",
    guidanceMarkdown: "# Downgrade reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E amendment downgrade",
    bindingDefaults: { triggerMode: "foreman_complete", deliveryMode: "preview", maxRepairRounds: 5 },
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
    daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 },
  );
  await api(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    triggerMode: "foreman_complete",
    deliveryMode: "preview",
  });
}

test("after the misread amendment resolves, Foreman's completion claim starts the bound Workflow", async ({ dashboard, daemon }) => {
  const sessionId = await dispatch(dashboard, daemon);
  await bindForemanCompleteWorkflow(daemon, sessionId);

  await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
  const reply = dashboard.locator(".console-detail").getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill(PICK);
  await reply.press("Enter");
  await expect.poll(async () => {
    const goal = await goalOf(daemon, sessionId);
    return goal.promptRevision >= 2 && goal.resolvedPromptRevision === goal.promptRevision
      ? goal.relationship
      : "pending";
  }, { message: "the misread amendment should resolve rather than latch" }).toBe("steer");

  // The turn's completion is the boundary a prompted wrap-up consumes. The same hook the
  // Foreman specs post establishes it without spending a model call.
  let live: LiveSession | undefined;
  await expect.poll(async () => {
    live = (await api<LiveSession[]>(daemon, "/api/sessions")).find((item) => item.id === sessionId);
    return live?.state === "idle" && live.pendingTurns.length === 0;
  }, { message: "the reply turn should settle" }).toBe(true);
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const hook = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ agent: live!.agent, sessionId: live!.agentSessionId, cwd: live!.cwd, env: {} }),
  });
  expect(hook.status, await hook.clone().text()).toBe(204);
  await expect.poll(async () => {
    live = (await api<LiveSession[]>(daemon, "/api/sessions")).find((item) => item.id === sessionId);
    return Boolean(live?.workCycle && !live.workCycle.active && live.workCycle.completedAt !== null);
  }, { message: "the session should have a completed work cycle" }).toBe(true);

  // Exactly the claim Foreman's worker sends (`ForemanClient.claimWorkflowCompletion`) once its
  // step-8 intent gate passes. The daemon re-checks that intent: on a latched goal it refuses
  // with "Foreman completion intent is no longer current" and no run is ever created.
  const goal = await goalOf(daemon, sessionId);
  const claim = await fetch(`${daemon.baseURL}/api/sessions/${sessionId}/workflow-completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      completionKind: "prompted",
      marker: randomBytes(32).toString("hex"),
      expectedWorkCycle: { logicalKey: live!.workCycle!.logicalKey, generation: live!.workCycle!.generation },
      summary: "The session finished the work behind its unchanged objective.",
      evidenceFingerprint: "e2e-goal-amendment-downgrade",
      expectedIntent: {
        objective: goal.objective,
        objectiveVersion: goal.objectiveVersion,
        promptRevision: goal.promptRevision,
        episodeKey: `intent:${goal.objectiveVersion}:${goal.promptRevision}`,
      },
    }),
  });
  const claimed = (await claim.json()) as { claimed: boolean; runId?: string; error?: string };
  expect(claim.status, JSON.stringify(claimed)).toBe(200);
  expect(claimed.claimed, JSON.stringify(claimed)).toBe(true);
  const runId = claimed.runId!;
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)).run.status,
    { message: "the bound Workflow run should finish its review", timeout: 40_000 }).toBe("completed");
  } catch (caught) {
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }

  // The run reviews the unchanged contract, and carries the pick as steering context.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}?pane=intent`);
  const intent = dashboard.getByRole("tabpanel", { name: /^Intent/ });
  const contract = intent.locator("details.wf-run-disclosure").filter({ hasText: "Review contract" });
  await contract.locator("> summary").click();
  await expect(contract.locator("pre")).toHaveText(REQUEST);
  const steering = intent.locator("details.wf-run-disclosure").filter({ hasText: "Human steering context" });
  await steering.locator("> summary").click();
  await expect(steering.locator("pre").first()).toHaveText(PICK);
  await expect(steering).toContainText("Treated as steering: the proposed amendment did not retain the current objective.");

  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("goal-amendment-downgrade");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await intent.screenshot({ path: `${dir}bound-workflow-run-intent.png` });
  }
});
