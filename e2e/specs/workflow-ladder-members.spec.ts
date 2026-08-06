import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The Workflows tab names every reviewer, including the ones that already passed.
 *
 * The ladder used to fold a stage's members away as soon as the stage passed, so a run whose
 * review stage read `All passed` beside `2 reviewers` identified neither reviewer. That is the
 * one question the surface exists to answer - who approved this - and the Runs monitor answered
 * it for the same run at the same moment, which made the two readings disagree.
 *
 * Only a browser can prove the fix. The markup test pins the shape of a rendered stage and the
 * Electron tests measure height, but neither can dispatch a session, publish a workflow, run a
 * real review to completion, click the tab a person clicks, and read what is on screen after.
 *
 * No model tokens: the reviewers are answered by `e2e/fixtures/fake-agents.ts`, which returns a
 * schema-valid pass verdict for any Persona whose published guidance carries `E2E_PASS_VERDICT`.
 */

const NODE = {
  session: "session-node",
  evidence: "evidence-node",
  docs: "docs-node",
  join: "join-node",
  end: "end-node",
};

const REVIEWER = {
  evidence: "E2E evidence auditor",
  docs: "E2E docs steward",
};
const EVIDENCE = artifactsDir("workflow-ladder-members");

const WORKFLOW = "E2E ladder members";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("hold a session for the ladder member spec");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect
    .poll(async () => {
      const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
      const live = sessions.find((session) => session.state !== "exited");
      sessionId = live?.id ?? "";
      return live?.state ?? "";
    }, { message: "the dispatched session should settle before the workflow is bound" })
    .toBe("idle");
  return sessionId;
}

/**
 * A real completed run over `Session -> two Personas -> all-pass join -> End`.
 *
 * Two reviewers rather than one, because one member row could be produced by a stage that
 * simply names itself. Two that BOTH passed is the state the collapsing rule erased.
 */
async function seedApprovedRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatch(page, daemon);
  const personaId = async (name: string): Promise<string> =>
    (await api<{ id: string }>(daemon, "/api/personas", {
      name,
      guidanceMarkdown: `# ${name}\n\nE2E_PASS_VERDICT`,
    })).id;
  const evidence = await personaId(REVIEWER.evidence);
  const docs = await personaId(REVIEWER.docs);
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: WORKFLOW,
    draft: {
      nodes: [
        { id: NODE.session, kind: "session", position: { x: 0, y: 0 } },
        { id: NODE.evidence, kind: "persona", personaId: evidence, position: { x: 220, y: 0 } },
        { id: NODE.docs, kind: "persona", personaId: docs, position: { x: 220, y: 140 } },
        { id: NODE.join, kind: "all_pass", position: { x: 440, y: 70 } },
        { id: NODE.end, kind: "end", outcome: "Approved", position: { x: 660, y: 70 } },
      ],
      edges: [
        { id: "e-evidence", source: NODE.session, sourcePort: "submitted", target: NODE.evidence, targetPort: "activate" },
        { id: "e-docs", source: NODE.session, sourcePort: "submitted", target: NODE.docs, targetPort: "activate" },
        { id: "e-evidence-pass", source: NODE.evidence, sourcePort: "pass", target: NODE.join, targetPort: "result" },
        { id: "e-evidence-fail", source: NODE.evidence, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        { id: "e-docs-pass", source: NODE.docs, sourcePort: "pass", target: NODE.join, targetPort: "result" },
        { id: "e-docs-fail", source: NODE.docs, sourcePort: "fail", target: NODE.join, targetPort: "result" },
        { id: "e-join-pass", source: NODE.join, sourcePort: "pass", target: NODE.end, targetPort: "terminal" },
        { id: "e-join-fail", source: NODE.join, sourcePort: "fail", target: NODE.session, targetPort: "return_for_changes" },
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
    { requestId: "e2e-ladder-members" },
  );
  await expect
    .poll(async () =>
      (await api<{ run: { status: string } }>(
        daemon,
        `/api/workflow-runs/${submitted.run.id}`,
      )).run.status,
    { message: "both scripted reviewers should approve and complete the run", timeout: 40_000 })
    .toBe("completed");
  return sessionId;
}

test("the Workflows tab names the reviewers that approved a passed stage", async ({
  dashboard,
  daemon,
}) => {
  await seedApprovedRun(dashboard, daemon);

  const config = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect((await config.json() as { config?: { layout?: string } }).config?.layout).toBe("console");
  await dashboard.reload();

  const rail = dashboard.getByRole("navigation", { name: "Sessions" });
  await expect(rail).toBeVisible();
  await rail.getByRole("button").first().click();
  const tabs = dashboard.getByRole("tablist", { name: "Session detail" });
  await tabs.getByRole("tab", { name: /Workflows$/ }).click();

  const ladder = dashboard.getByRole("region", { name: `${WORKFLOW} workflow stages` });
  await expect(ladder).toBeVisible();
  if (process.env.MC_E2E_EVIDENCE) {
    // eslint-disable-next-line no-console
    console.log("OBSERVED the Workflows tab rendered the ladder for the completed run");
  }

  // The stage still folds to one verdict for the row...
  const stage = ladder.locator("li.wf-ladder-rung").filter({ hasText: "2 reviewers" });
  await expect(stage.locator(".wf-ladder-state")).toHaveText("All passed");

  // ...and both reviewers behind that verdict are named under it, with no control clicked to
  // reveal them. This is the whole regression: `All passed` beside `2 reviewers` used to be
  // every word the tab would say about who approved the change.
  for (const name of [REVIEWER.evidence, REVIEWER.docs]) {
    const member = stage.locator("li.wf-ladder-member").filter({ hasText: name });
    await expect(member).toHaveClass(/workflow-passed/);
    await expect(member.locator(".wf-ladder-member-name")).toHaveText(name);
    await expect(member.locator(".wf-ladder-member-state")).toHaveText("Passed");
  }
  await expect(stage.locator("li.wf-ladder-member")).toHaveCount(2);
  if (process.env.MC_E2E_EVIDENCE) {
    // eslint-disable-next-line no-console
    console.log(`OBSERVED both ${REVIEWER.evidence} and ${REVIEWER.docs} named under the stage, unexpanded`);
  }

  // Nothing in this pane offers to expand anything: the tab is not the Board tile, so there is
  // no disclosure to find, and the reading above is what the tab shows on arrival.
  await expect(dashboard.getByRole("button", { name: "Show full workflow" })).toHaveCount(0);

  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({
      path: `${EVIDENCE}workflow-ladder-members.png`,
      fullPage: true,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/workflow-ladder-members/workflow-ladder-members.png");
  }
});
