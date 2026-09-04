import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

const NO_MISTAKES = "builtin-workflow:no-mistakes-review";
const EVIDENCE = artifactsDir("board-card-workflow-progress");

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function dispatchIdleAgent(page: Page, daemon: DaemonHandle): Promise<string> {
  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((session) => session.id),
  );
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?")
    .fill("show the No-Mistakes pipeline on a Board card");
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const session = sessions.find((candidate) => !before.has(candidate.id));
    sessionId = session?.id ?? "";
    return session?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  return sessionId;
}

async function seedNoMistakesRun(page: Page, daemon: DaemonHandle): Promise<string> {
  const sessionId = await dispatchIdleAgent(page, daemon);
  const workflows = await api<Array<{ id: string }>>(
    daemon,
    "/api/workflows",
  );
  const workflow = workflows.find((candidate) => candidate.id === NO_MISTAKES);
  expect(workflow, "this build ships a published No-Mistakes Review").toBeTruthy();
  // This spec needs the stable post-Persona blocked boundary to inspect Board progress. Version
  // 13's enforcing evidence preflight has its own end-to-end lifecycle spec, so use the last
  // advisory version here rather than manufacturing unrelated evidence in this fixture.
  const versions = await api<Array<{ id: string; version: number }>>(
    daemon,
    `/api/workflows/${workflow!.id}/versions`,
  );
  const versionId = versions.find((version) => version.version === 12)?.id;
  expect(versionId, "this build retains immutable No-Mistakes Review v12").toBeTruthy();

  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: versionId,
    sessionId,
    deliveryMode: "preview",
    maxRepairRounds: 5,
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: "e2e-board-card-workflow-progress" },
  );

  // In the isolated fixture repository the shipped workflow reaches a stable blocked boundary.
  // The Board response below is then projected from this real run without any model call.
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${submitted.run.id}`)
  ).run.status, { timeout: 120_000 }).toBe("blocked");
  return submitted.run.id;
}

async function useBoardLayout(page: Page, daemon: DaemonHandle): Promise<void> {
  const response = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "board" }),
  });
  const body = (await response.json()) as { config?: { layout?: string } };
  expect(body.config?.layout, "the daemon accepted the Board layout").toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
}

async function forceIntentStage(page: Page, runId: string): Promise<void> {
  await page.route(`**/api/workflow-runs/${runId}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      summary: Record<string, unknown>;
      run: Record<string, unknown>;
      version: { graph: { nodes: Array<{ id: string; kind: string }> } };
      submissions: Array<Record<string, unknown>>;
      attempts: Array<Record<string, unknown>>;
      deliveries: unknown[];
      inspectorGate: unknown;
    };
    const checkIds = new Set(
      body.version.graph.nodes.filter((node) => node.kind === "check").map((node) => node.id),
    );
    body.attempts = body.attempts
      .filter((attempt) => checkIds.has(String(attempt.nodeId)))
      .map((attempt) => ({
        ...attempt,
        state: "completed",
        output: { ...(attempt.output as Record<string, unknown>), status: "passed" },
      }));
    body.summary = { ...body.summary, status: "running", phase: "persona_review" };
    body.run = { ...body.run, status: "running", currentPhase: "persona_review" };
    body.submissions = body.submissions.map((submission, index, all) =>
      index === all.length - 1 ? { ...submission, status: "running" } : submission
    );
    body.deliveries = [];
    body.inspectorGate = null;
    await route.fulfill({ response, json: body });
  });
}

async function setColumnWidth(page: Page, column: Locator, width: 250 | 300): Promise<void> {
  await page.evaluate((nextWidth) => {
    const id = "workflow-progress-evidence-width";
    const existing = document.getElementById(id);
    const style = existing ?? document.head.appendChild(document.createElement("style"));
    style.id = id;
    style.textContent = `.board-col { flex: 0 0 ${nextWidth}px !important; min-width: ${nextWidth}px !important; max-width: ${nextWidth}px !important; }`;
  }, width);
  await expect.poll(async () => Math.round((await column.boundingBox())?.width ?? 0), {
    message: `the occupied Board column should settle at ${width}px`,
  }).toBe(width);
}

async function shoot(column: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await column.page().mouse.move(0, 0);
  await column.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-card-workflow-progress/${name}.png`);
}

test("the Board card shows the whole No-Mistakes pipeline by default and preserves the rung preference", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(240_000);
  const runId = await seedNoMistakesRun(dashboard, daemon);
  await forceIntentStage(dashboard, runId);
  await useBoardLayout(dashboard, daemon);

  const tile = dashboard.locator(".tile").filter({
    has: dashboard.locator(".tile-workflow-disclosure"),
  });
  const column = tile.locator("xpath=ancestor::section[contains(@class, 'board-col')]");
  const peek = tile.locator(".wf-tile-peek");
  await expect(tile).toHaveCount(1);

  // Default on, and each visual unit still has a real accessible name.
  await expect(peek.locator(".wf-stage-meter")).toBeVisible();
  await expect(peek.locator('.tpm-seg[role="img"]')).toHaveCount(5);
  await expect(peek.locator('.wf-repair-pip[role="img"]')).toHaveCount(6);
  await expect(peek.getByRole("img", { name: "Intent Conformance Judge: Waiting" }))
    .toHaveClass(/is-now/);
  await expect(peek.getByRole("img", { name: "Round 1: current" })).toBeVisible();
  await expect(peek).toContainText("1 / 5 stages");
  await expect(peek.locator(".wf-tile-peek-rung")).toHaveCount(0);

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  const setting = dashboard.getByRole("checkbox", { name: "Workflow progress bar" });
  await expect(setting).toBeChecked();
  await setting.uncheck();
  const preview = dashboard.locator(".board-card-preview-stage .wf-tile-peek");
  await expect(preview.locator(".wf-repair-meter")).toHaveCount(0);
  await expect(preview.locator(".wf-tile-peek-round")).toHaveText("R3 / 5");

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  await expect(peek.locator(".wf-tile-peek-rung")).toBeVisible();
  await expect(peek.locator(".wf-stage-meter")).toHaveCount(0);
  await expect(peek.locator(".wf-tile-peek-title strong"))
    .toHaveText("Intent Conformance Judge");

  for (const width of [300, 250] as const) {
    await setColumnWidth(dashboard, column, width);
    const [nameBox, stateBox] = await Promise.all([
      peek.locator(".wf-tile-peek-title strong").boundingBox(),
      peek.locator(".wf-tile-peek-state").boundingBox(),
    ]);
    expect(nameBox && stateBox, "the fallback caption finished laying out").toBeTruthy();
    expect(
      nameBox!.x + nameBox!.width <= stateBox!.x - 7,
      `the stage name keeps its gap from the status at ${width}px`,
    ).toBe(true);
    await shoot(column, `before-rung-${width}px`);
  }

  await dashboard.goto(`${daemon.baseURL}/#/settings/display`);
  await setting.check();
  await expect(preview.locator(".wf-repair-meter")).toBeVisible();
  await expect(preview.locator(".wf-tile-peek-round")).toHaveCount(0);

  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  await dashboard.reload();
  await expect(peek.locator(".wf-stage-meter")).toBeVisible();
  await expect(peek.locator(".wf-tile-peek-rung")).toHaveCount(0);
  for (const width of [300, 250] as const) {
    await setColumnWidth(dashboard, column, width);
    await shoot(column, `after-meter-${width}px`);
  }
});
