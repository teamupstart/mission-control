import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

const NOTE_KEY = "e2e-run-steering";
const INSTRUCTION = "skip the E2E for now, the harness is broken";
test.use({ daemonEnv: { MISSION_GOAL_POLL_MS: "20", MISSION_GOAL_REFRESH_MS: "20" } });

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Dispatch one agent from the modal - the sanctioned way to get a live, bindable session. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await expectContentClearsBorder(dialog);
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the fields below, so close it before filling
  // the next one. Its handler stops propagation, so this closes the list, not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("Ship the steering context feature");
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

/** Drive a real classification and capture through a passing, fake-backed review. */
async function seedRun(page: Page, daemon: DaemonHandle, steer: boolean): Promise<{
  runId: string;
  sessionId: string;
}> {
  const sessionId = await dispatch(page, daemon);
  await expect.poll(async () => (await api<{ resolvedPromptRevision: number }>(daemon,
    `/api/sessions/${sessionId}/goal`)).resolvedPromptRevision).toBe(1);
  if (steer) {
    await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first().click();
    const reply = page.locator(".console-detail").getByPlaceholder(/^Reply to this session/);
    await expect(reply).toBeEnabled();
    await reply.fill(INSTRUCTION);
    await reply.press("Enter");
    await expect.poll(async () => (await api<{ resolvedPromptRevision: number }>(daemon,
      `/api/sessions/${sessionId}/goal`)).resolvedPromptRevision).toBe(2);
    await expect.poll(async () => {
      const sessions = await api<Array<{ id: string; state: string; pendingTurns: unknown[] }>>(daemon, "/api/sessions");
      const session = sessions.find((item) => item.id === sessionId)!;
      const idle = withDaemonDb(daemon, (db) => db.prepare("SELECT turn_in_progress FROM sdk_sessions WHERE id = ?").get(sessionId)) as { turn_in_progress: number };
      return session.state === "idle" && session.pendingTurns.length === 0 && idle.turn_in_progress === 0;
    }).toBe(true);
  }
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Steering reviewer",
    guidanceMarkdown: "# Steering reviewer\n\nE2E_PASS_VERDICT",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E run steering",
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
    { requestId: NOTE_KEY },
  );
  try {
    await expect.poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "the seeded round should settle completed", timeout: 40_000 }).toBe("completed");
  } catch (caught) {
    // The seeding failure that matters here is server-side and invisible to a browser trace.
    // eslint-disable-next-line no-console
    console.log(`DAEMON LOG TAIL:\n${daemon.readLog().split("\n").slice(-60).join("\n")}`);
    throw caught;
  }
  return { runId: submitted.run.id, sessionId };
}


test("a steered session freezes its instruction and shows it separately from the contract", async ({ dashboard, daemon }) => {
  const { runId } = await seedRun(dashboard, daemon, true);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}?pane=intent`);
  const intent = dashboard.getByRole("tabpanel", { name: /^Intent/ });
  const steering = intent.locator("details.wf-run-disclosure").filter({ hasText: "Human steering context" });
  await steering.locator("> summary").click();
  await expect(steering.locator("pre")).toHaveText(INSTRUCTION);
  await expect(steering).toContainText("Steering does not add, remove or narrow acceptance criteria.");
  await expect(steering).toContainText("Frozen through resolved prompt revision 2.");
  await expect(steering).toContainText("Revision 2");
  await expect(steering.locator("time")).toBeVisible();
  const contract = intent.locator("details.wf-run-disclosure").filter({ hasText: "Review contract" });
  await contract.locator("> summary").click();
  await expect(contract.locator("pre")).toHaveText("Ship the steering context feature");
  const decisions = intent.locator("details.wf-run-disclosure").filter({ hasText: "Human decisions and rationale" });
  await decisions.locator("> summary").click();
  await expect(decisions).not.toContainText(INSTRUCTION);
  if (process.env.MC_E2E_EVIDENCE) {
    const dir = artifactsDir("workflow-run-steering");
    mkdirSync(dir, { recursive: true });
    await dashboard.mouse.move(0, 0);
    await intent.screenshot({ path: `${dir}steering-context.png` });
  }
});

test("a run with no steering has no steering disclosure", async ({ dashboard, daemon }) => {
  const { runId } = await seedRun(dashboard, daemon, false);
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}?pane=intent`);
  const intent = dashboard.getByRole("tabpanel", { name: /^Intent/ });
  await expect(intent).toBeVisible();
  await expect(intent.locator("summary").filter({ hasText: "Human steering context" })).toHaveCount(0);
});
