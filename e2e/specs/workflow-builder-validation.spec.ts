import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The workflow builder validates the open draft once it has a graph, and draws nothing to
 * validate before then.
 *
 * The builder's validation result is what draws the properties rail - its Validation section
 * and diagnostics - and what lets Publish enable. It is gated on the graph alone
 * (`workflowDraftValidation`, which `test/workflow-draft-validation.test.ts` also pins for a
 * workflow with no completion policy, a state the daemon never serves and the rail cannot draw).
 * Here both sides of that gate are seen through the page: no rail while the workflow's detail is
 * still on its way, then a validated rail - clean for a complete graph with Publish on, and the
 * missing End named with Publish off for a broken one. The workflows are real and no agent runs.
 */

async function createWorkflow(daemon: DaemonHandle, name: string, draft: unknown): Promise<string> {
  const response = await fetch(`${daemon.baseURL}/api/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, draft }),
  });
  if (!response.ok) throw new Error(`create workflow answered ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { workflow: { id: string } }).workflow.id;
}

/** Hold this workflow's detail read until `hold` settles, then let the real reply through. */
async function holdDetail(page: Page, id: string, hold: Promise<void>): Promise<void> {
  await page.route((url) => url.pathname === `/api/workflows/${id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await hold;
    await route.continue();
  });
}

const EVIDENCE = artifactsDir("workflow-builder-validation");

/** Gated behind `MC_E2E_EVIDENCE`: the rendered state the assertions beside it just passed on. */
async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  console.log(`CAPTURED e2e/.artifacts/workflow-builder-validation/${name}.png`);
}

const session = { id: "session", kind: "session", position: { x: 0, y: 0 } };
const end = { id: "end", kind: "end", outcome: "Approved", position: { x: 220, y: 0 } };

test("the builder validates a draft once its graph arrives: rail, diagnostics and Publish follow it", async ({
  dashboard,
  daemon,
}) => {
  const validId = await createWorkflow(daemon, "Validated complete workflow", {
    nodes: [session, end],
    edges: [{ id: "done", source: "session", sourcePort: "submitted", target: "end", targetPort: "terminal" }],
  });
  const brokenId = await createWorkflow(daemon, "Validated workflow with no end", {
    nodes: [session],
    edges: [],
  });

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await holdDetail(dashboard, validId, held);

  const validation = dashboard.getByRole("heading", { name: /^Validation/ });
  const publish = dashboard.getByRole("button", { name: "Publish", exact: true });
  const name = dashboard.locator("section.workflow-policy-fields").getByLabel("Name");

  // No graph yet: the detail is held, so there is nothing to validate and no rail.
  const detailRead = dashboard.waitForRequest((request) => new URL(request.url()).pathname === `/api/workflows/${validId}`);
  await dashboard.goto(`${daemon.baseURL}/#/library/workflows/${validId}`);
  await detailRead;
  await expect(validation).toHaveCount(0);
  await expect(name).toHaveCount(0);

  // The graph arrives: the rail renders, validated clean, and the draft can publish.
  release();
  await expect(name).toHaveValue("Validated complete workflow");
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(dashboard.getByRole("heading", { name: "Validation · 0 errors" })).toBeVisible();
  await expect(publish).toBeEnabled();

  // A broken graph is caught, with the reason on screen and Publish off.
  // A hash change alone keeps the open builder; reload so the route opens this workflow.
  await dashboard.goto(`${daemon.baseURL}/#/library/workflows/${brokenId}`);
  await dashboard.reload();
  await expect(name).toHaveValue("Validated workflow with no end");
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(dashboard.getByRole("heading", { name: /^Validation · [1-9]\d* errors?$/ })).toBeVisible();
  await expect(dashboard.getByText("Add at least one End node.")).toBeVisible();
  await expect(dashboard.locator("code.workflow-diagnostic-code", { hasText: "missing_end" })).toBeVisible();
  await expect(publish).toBeDisabled();
  // One frame for both claims: a taller viewport fits the header's Publish and the named diagnostic.
  if (process.env.MC_E2E_EVIDENCE) {
    await dashboard.setViewportSize({ width: 1280, height: 1000 });
    await dashboard.evaluate(() => window.scrollTo(0, 0));
    await expect(dashboard.locator("code.workflow-diagnostic-code", { hasText: "missing_end" })).toBeInViewport();
    await expect(publish).toBeInViewport();
  }
  await capture(dashboard, "builder-missing-end-publish-disabled");
});
