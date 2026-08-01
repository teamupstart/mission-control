import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The committed screenshots under `docs/evidence/workflow-session-action-authoring/`.
 *
 * Behind `MC_E2E_EVIDENCE`, and committed, for `dispatch-and-converse.spec.ts`' reason: every
 * capture here carries a fresh worktree uuid and a relative timestamp, so an unconditional
 * run would rewrite five binaries on every `npm run test:e2e` for no added signal.
 *
 * A REAL daemon rather than a component fixture, because the thing worth photographing is the
 * whole surface an operator sees - the catalog arriving over SSE, a published version's stage
 * chain, and a live run parked on an action - and none of those exist in a props object. It
 * carries no operator data: the repository, the session and the actions are all seeded by
 * this file.
 *
 * Each capture is taken twice: at 1440 and at 720, the Electron window's own minimum width.
 * The narrow pass is the assertion that matters - it is where a stage strip, a four-field
 * editor and a three-pane builder have to stay reachable rather than merely not crash.
 */

const EVIDENCE = fileURLToPath(
  new URL("../../docs/evidence/workflow-session-action-authoring/", import.meta.url),
);
const PROMPT = "# Tidy the workspace\n\nRemove the stray scratch file and say so.\n";

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

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  for (const [suffix, width] of [["wide", 1440], ["narrow", 720]] as const) {
    await page.setViewportSize({ width, height: 900 });
    // One frame for the layout to settle after the resize; the strip re-measures its scroll.
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}${name}-${suffix}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("capture the authoring and run surfaces", async ({ dashboard, daemon }) => {
  test.skip(!process.env.MC_E2E_EVIDENCE, "set MC_E2E_EVIDENCE=1 to regenerate the screenshots");
  test.setTimeout(180_000);

  const action = await api<{ id: string }>(daemon, "/api/session-actions", {
    name: "Tidy the workspace",
    description: "Remove the stray scratch files before review",
    promptMarkdown: PROMPT,
    completion: { kind: "session_turn" },
  });
  await api(daemon, "/api/session-actions", {
    name: "Push the branch",
    description: "Commit and push what was reviewed",
    promptMarkdown: "# Push\n\nPush the branch.\n",
    requiredSkillId: "pull-request",
    completion: { kind: "session_turn" },
  });
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Intent Conformance",
    guidanceMarkdown: "# Judge\n\nE2E_PASS_VERDICT\n",
    runner: null,
    model: null,
  });

  // 1. The library: a built-in beside two operator rows, and one open in the editor.
  await dashboard.goto(`${daemon.baseURL}/#/workflows/actions`);
  await dashboard.getByRole("button", { name: /Tidy the workspace/ }).click();
  await expect(dashboard.locator(".wf-action-editor")).toBeVisible();
  await shoot(dashboard, "01-actions-library");

  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Ship it",
    draft: {
      nodes: [
        { id: "s", kind: "session", position: { x: 0, y: 0 } },
        { id: "p", kind: "persona", personaId: persona.id, position: { x: 240, y: 0 } },
        { id: "a", kind: "session_action", sessionActionId: action.id, position: { x: 480, y: 0 } },
        { id: "c", kind: "check", slot: "test", position: { x: 720, y: 0 } },
        { id: "e", kind: "end", outcome: "Approved", position: { x: 960, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "s", sourcePort: "submitted", target: "p", targetPort: "activate" },
        { id: "e2", source: "p", sourcePort: "pass", target: "a", targetPort: "activate" },
        { id: "e3", source: "p", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
        { id: "e4", source: "a", sourcePort: "complete", target: "c", targetPort: "activate" },
        { id: "e5", source: "c", sourcePort: "pass", target: "e", targetPort: "terminal" },
        { id: "e6", source: "c", sourcePort: "fail", target: "s", targetPort: "return_for_changes" },
      ],
    },
    completionPolicy: { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" },
  });

  // 2. The pipeline, at both ends of a strip too wide for one screen: the action stage among
  //    its neighbours, and the fixed Inspector footer past End.
  await dashboard.goto(`${daemon.baseURL}/#/workflows`);
  await dashboard.getByRole("button", { name: /Ship it/ }).click();
  await expect(dashboard.locator(".wf-pipeline-strip")).toBeVisible();
  await shoot(dashboard, "02-pipeline-action-stage");
  await dashboard.locator(".wf-pipeline-strip").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await shoot(dashboard, "03-pipeline-inspector-footer");

  // 3. The graph: the node's one `complete` port, and the rail that repoints and removes it.
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  await dashboard.locator('[data-node-kind="session_action"]').click();
  await shoot(dashboard, "04-graph-action-node");

  // 4. A live run parked on the action, which is the state the run vocabulary exists for.
  await api(daemon, "/api/workflows/config", { liveEnabled: true, repoAllowlist: [daemon.repo] }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for the evidence run");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");

  const version = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: version.version.id,
    sessionId,
    // Preview, so the run parks on `awaiting_send` and holds still for a photograph. Live
    // would race the fake agent's own turn.
    deliveryMode: "preview",
  });
  const run = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "evidence" },
  );
  await expect.poll(
    async () => (await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${run.run.id}`)).run.status,
    { timeout: 60_000 },
  ).toBe("waiting_for_action");

  await dashboard.goto(`${daemon.baseURL}/#/workflows/runs/${run.run.id}`);
  await expect(dashboard.locator("article.wf-run-action")).toBeVisible();
  await shoot(dashboard, "05-run-waiting-on-action");

  // 5. The Board ladder, where the same run is read as one vertical chain.
  await api(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Show full workflow" }).click();
  await expect(dashboard.locator(".wf-ladder-rung.is-fixed")).toBeVisible();
  await shoot(dashboard, "06-board-ladder");
});
