import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

for (const afterContractRejection of [false, true]) test(
  afterContractRejection
    ? "a token refusal after a rejected review shows the provider reason"
    : "a provider token refusal appears immediately as a blocked run with no retry action",
  async ({ dashboard, daemon }) => {
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("hold a session for token refusal review");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((session) => session.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");

  const reviewer = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Token refusal reviewer",
    guidanceMarkdown: afterContractRejection
      ? "# Token refusal reviewer\n\nE2E_CONTRACT_REVIEW E2E_PERSONA_TOKEN_AFTER_CONTRACT"
      : "# Token refusal reviewer\n\nE2E_PERSONA_TOKEN_EXHAUSTED",
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E provider token refusal",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: reviewer.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id, sessionId, deliveryMode: "preview",
  });
  const submitted = await api<{ run: { id: string } }>(daemon, `/api/workflow-bindings/${binding.id}/submit`, {
    requestId: `e2e-provider-token-refusal-${afterContractRejection}`,
  });
  const runId = submitted.run.id;
  await expect.poll(async () => {
    const { run } = await api<{ run: { status: string; currentPhase: string } }>(daemon, `/api/workflow-runs/${runId}`);
    return `${run.status}/${run.currentPhase}`;
  }, { timeout: 60_000 }).toBe("blocked/provider_token_exhausted");
  const { run } = await api<{ run: { gateState: { error: string } } }>(daemon, `/api/workflow-runs/${runId}`);
  expect(run.gateState.error).toContain("Claude error_during_execution (api_error)");
  expect(run.gateState.error).not.toContain("Persona review contract error");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const header = dashboard.locator("header.wf-run-head");
  await expect(header).toContainText("provider token or quota limit reached");
  await expect(header.getByRole("button", { name: "Retry the failed call" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Cancel run" })).toBeVisible();
  const gatePacket = dashboard.locator("details.wf-run-packet", { hasText: "Join and gate packet" });
  await gatePacket.locator("summary").click();
  await expect(gatePacket).toContainText("Claude error_during_execution (api_error)");
  await expect(gatePacket).not.toContainText("Persona review contract error");
});
