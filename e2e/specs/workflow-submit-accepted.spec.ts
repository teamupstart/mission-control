import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

const EVIDENCE = artifactsDir("workflow-submit-accepted");
import type { DaemonHandle } from "../fixtures/daemon.ts";

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}

async function createPublishedWorkflow(
  daemon: DaemonHandle,
  name: string,
): Promise<{ workflowId: string; versionId: string }> {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name,
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 220, y: 0 } },
      ],
      edges: [
        {
          id: "complete",
          source: "session",
          sourcePort: "submitted",
          target: "end",
          targetPort: "terminal",
        },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${created.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  return { workflowId: created.workflow.id, versionId: published.version.id };
}

async function dispatchSlowContextSession(
  page: Page,
  daemon: DaemonHandle,
): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(
    "E2E_SLOW_WORKFLOW_CONTEXT hold a session for accepted workflow submission",
  );
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const session = sessions.find((item) => item.state !== "exited");
    sessionId = session?.id ?? "";
    return session?.state ?? "";
  }, { message: "the bindable session should settle before capture" }).toBe("idle");
  return sessionId;
}

test("Bind and submit opens the durable capturing run before compaction finishes", async ({
  dashboard,
  daemon,
}) => {
  const sessionId = await dispatchSlowContextSession(dashboard, daemon);
  const published = await createPublishedWorkflow(daemon, "E2E accepted submission");

  // Reload after API seeding so the browser's SSE snapshot includes the published version.
  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Bind to a session…" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Session").selectOption(sessionId);
  await dialog.getByLabel("Published workflow").selectOption(published.versionId);

  const submitResponse = dashboard.waitForResponse((response) =>
    response.request().method() === "POST"
    && /\/api\/workflow-bindings\/[^/]+\/submit$/.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "Bind and submit" }).click();
  const response = await submitResponse;
  expect(response.status()).toBe(202);
  const accepted = await response.json() as { run: { id: string; status: string } };
  expect(accepted.run.status).toBe("capturing");
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    // eslint-disable-next-line no-console
    console.log("OBSERVED bind-and-submit returned 202 with a durable capturing run");
  }

  await expect(dialog).toBeHidden();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${accepted.run.id}$`));

  // The provider fake is still holding compaction open. This API read proves the visible
  // run is the durable in-progress row, not a completed run rendered after a long request.
  const detail = await api<{ run: { status: string } }>(
    daemon,
    `/api/workflow-runs/${accepted.run.id}`,
  );
  expect(detail.run.status).toBe("capturing");
  await expect(dashboard.locator(".wf-run-facts .workflow-chip")).toHaveText(
    "Capturing evidence",
    { timeout: 6_000 },
  );

  if (process.env.MC_E2E_EVIDENCE) {
    // eslint-disable-next-line no-console
    console.log('OBSERVED the accepted run detail page says "Capturing evidence"');
    await dashboard.screenshot({
      path: `${EVIDENCE}workflow-submit-accepted.png`,
      fullPage: true,
    });
    // eslint-disable-next-line no-console
    console.log("CAPTURED e2e/.artifacts/workflow-submit-accepted/workflow-submit-accepted.png");
  }
});

test("binding overrides survive unrelated live workflow updates", async ({ dashboard, daemon }) => {
  const sessionId = await dispatchSlowContextSession(dashboard, daemon);
  const selected = await createPublishedWorkflow(daemon, "E2E selected binding");

  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  await dashboard.reload();
  let releaseVersionDetail!: () => void;
  const versionDetailGate = new Promise<void>((resolve) => { releaseVersionDetail = resolve; });
  let heldVersionDetail = false;
  await dashboard.route(`**/api/workflows/${selected.workflowId}`, async (route) => {
    if (route.request().method() === "GET" && !heldVersionDetail) {
      heldVersionDetail = true;
      await versionDetailGate;
    }
    await route.continue();
  });
  await dashboard.getByRole("button", { name: "Bind to a session…" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await dialog.getByLabel("Session").selectOption(sessionId);
  await dialog.getByLabel("Published workflow").selectOption(selected.versionId);

  const repairRounds = dialog.getByLabel("Maximum repair rounds");
  await repairRounds.fill("8");
  await expect(repairRounds).toHaveValue("8");

  // A person can edit while immutable-version defaults are still loading. Their edit wins
  // when that older request eventually completes.
  const versionDetailResponse = dashboard.waitForResponse((response) =>
    response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/workflows/${selected.workflowId}`);
  releaseVersionDetail();
  await versionDetailResponse;
  await expect(repairRounds).toHaveValue("8");

  // Publishing another workflow arrives through SSE and rerenders the open dialog. That live
  // collection change must not reapply the selected version's defaults over this binding-only
  // override.
  const unrelated = await createPublishedWorkflow(daemon, "E2E unrelated workflow");
  await expect(dialog.getByLabel("Published workflow").locator(`option[value="${unrelated.versionId}"]`))
    .toHaveCount(1);
  await expect(repairRounds).toHaveValue("8");
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.screenshot({
      path: `${EVIDENCE}workflow-binding-repair-rounds.png`,
      fullPage: true,
    });
  }

  await dialog.getByRole("button", { name: "Bind only" }).click();
  await expect(dialog).toBeHidden();
  const bindings = await api<Array<{ workflowVersionId: string; maxRepairRounds: number }>>(
    daemon,
    "/api/workflow-bindings",
  );
  expect(bindings.find((binding) => binding.workflowVersionId === selected.versionId)?.maxRepairRounds)
    .toBe(8);
});
