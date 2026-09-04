import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { workflowCommandEvidenceContent } from "../../src/shared/workflow.ts";

const EVIDENCE = artifactsDir("workflow-evidence-readiness");

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<string> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(
    "Keep focused execution green and retain inspectable acceptance evidence",
  );
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const session = sessions.find((candidate) => candidate.state !== "exited");
    sessionId = session?.id ?? "";
    return session?.state;
  }, { timeout: 40_000 }).toBe("idle");
  return sessionId;
}

async function createWorkflow(daemon: DaemonHandle): Promise<string> {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E criterion mapped evidence",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "end", kind: "end", outcome: "Complete", position: { x: 220, y: 0 } },
      ],
      edges: [{
        id: "complete",
        source: "session",
        sourcePort: "submitted",
        target: "end",
        targetPort: "terminal",
      }],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${created.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  return published.version.id;
}

async function capture(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-evidence-readiness/${name}.png`);
}

test("criterion coverage stays advisory while its frozen readiness remains inspectable", async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  const sessionId = await dispatch(dashboard, daemon);
  const versionId = await createWorkflow(daemon);
  const session = (await api<Array<{ id: string; agentSessionId?: string; cwd: string }>>(
    daemon,
    "/api/sessions",
  )).find((candidate) => candidate.id === sessionId);
  expect(session).toBeTruthy();
  const noteKey = session!.agentSessionId ?? session!.id;
  const command = {
    command: "node --test focused.test.ts",
    exitCode: 0,
    output: "ok 1 - focused behavior\n",
  };
  const content = workflowCommandEvidenceContent(command);
  const secondaryContent = workflowCommandEvidenceContent({
    command: "node --test integration.test.ts",
    exitCode: 0,
    output: "ok 1 - integrated behavior\n",
  });
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO workflow_evidence_owners (
         note_key, generation, all_generation, updated_at
       ) VALUES (?, 1, 0, ?)`,
    ).run(noteKey, now);
    const insertEvidence = db.prepare(
      `INSERT INTO workflow_evidence_staging (
         id, note_key, client_item_id, source_kind, evidence_kind, source_root,
         source_locator, inline_content, command_exit_code, episode_key, display_name, caption,
         repository_scope, mime_type, bytes, sha256, generation, state,
         reserved_group_key, created_at, updated_at
       ) VALUES (?, ?, ?, 'command', 'text', ?, ?, ?, ?, NULL, ?, ?, 'repo-01',
         'text/plain', ?, ?, 1, 'staged', NULL, ?, ?)`);
    insertEvidence.run(
      "e2e-focused-command",
      noteKey,
      "focused-command",
      session!.cwd,
      command.command,
      content,
      command.exitCode,
      "focused.test.ts",
      "Focused command passed",
      Buffer.byteLength(content),
      createHash("sha256").update(content).digest("hex"),
      now,
      now,
    );
    insertEvidence.run(
      "e2e-secondary-command",
      noteKey,
      "secondary-command",
      session!.cwd,
      "node --test integration.test.ts",
      secondaryContent,
      null,
      "legacy-command-output.txt",
      "Legacy command evidence remains readable",
      Buffer.byteLength(secondaryContent),
      createHash("sha256").update(secondaryContent).digest("hex"),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO workflow_evidence_coverage_staging (
         id, note_key, client_criterion_id, criterion, proof_class, repository_scope,
         source_root, links_json, episode_key, generation, state, reserved_group_key,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'focused_execution', 'repo-01', ?, ?, NULL, 1,
         'staged', NULL, ?, ?)`,
    ).run(
      "e2e-focused-coverage",
      noteKey,
      "criterion-focused",
      "The focused behavior remains correct",
      session!.cwd,
      JSON.stringify([
        { clientItemId: "focused-command", role: "execution" },
        { clientItemId: "secondary-command", role: "execution" },
        { clientItemId: "focused-command", role: "state_snapshot" },
      ]),
      now,
      now,
    );
  });

  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  await dashboard.reload();
  await dashboard.getByRole("button", { name: "Bind to a session…" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Bind workflow" });
  await dialog.getByLabel("Session").selectOption(sessionId);
  await dialog.getByLabel("Published workflow").selectOption(versionId);
  await expectContentClearsBorder(dialog);
  const composer = dialog.getByRole("region", { name: "Workflow evidence" });
  await expect(composer).toContainText("focused.test.ts");
  await expect(composer).toContainText("legacy-command-output.txt");
  await expect(composer).not.toContainText("Registered evidence is unavailable");
  await expect(composer).toContainText("1 saved");
  const focusedClaim = composer.locator(".workflow-coverage-claim")
    .filter({ hasText: "The focused behavior remains correct" });
  await focusedClaim.getByRole("button", { name: "Edit" }).click();
  await expect(composer).toContainText("A screenshot is not requested.");
  const executionEvidence = composer.getByLabel("Execution evidence for acceptance criterion");
  await executionEvidence.selectOption("execution:secondary-command");
  await expect(executionEvidence).toHaveValue("execution:secondary-command");
  await capture(dashboard, "01-legacy-command-evidence-visible");
  await executionEvidence.selectOption("execution:focused-command");
  const focusedUpdate = dashboard.waitForResponse((response) =>
    response.request().method() === "POST"
    && /\/api\/(?:workflow-bindings\/[^/]+\/evidence|sessions\/[^/]+\/workflow-evidence)\/coverage$/
      .test(new URL(response.url()).pathname));
  await composer.getByRole("button", { name: "Save criterion mapping" }).click();
  const focusedCoverage = await (await focusedUpdate).json() as {
    coverage: Array<{ clientCriterionId: string; links: Array<{ clientItemId: string; role: string }> }>;
  };
  expect(focusedCoverage.coverage.find(
    (claim) => claim.clientCriterionId === "criterion-focused",
  )?.links).toEqual([
    { clientItemId: "focused-command", role: "execution" },
    { clientItemId: "secondary-command", role: "execution" },
    { clientItemId: "focused-command", role: "state_snapshot" },
  ]);

  await composer.getByPlaceholder("What must be true for this work to be accepted?")
    .fill("The dashboard result is visually correct");
  await composer.getByLabel("Proof class for acceptance criterion").selectOption("visual");
  await composer.getByLabel("Execution evidence for acceptance criterion")
    .selectOption("execution:focused-command");
  await expect(composer).toContainText("Provisional gaps: missing rendered output.");
  await dashboard.route(
    /\/api\/(?:workflow-bindings\/[^/]+\/evidence|sessions\/[^/]+\/workflow-evidence)\/coverage$/,
    async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary coverage save failure" }),
      });
    },
    { times: 1 },
  );
  await composer.getByRole("button", { name: "Save criterion mapping" }).click();
  await expect(composer.getByRole("alert")).toContainText("Temporary coverage save failure");
  await expect(dialog.getByRole("button", { name: "Bind and submit" })).toBeEnabled();
  await composer.getByRole("button", { name: "Save criterion mapping" }).click();
  await expect(composer).toContainText("2 saved");
  await expect(composer.getByRole("alert")).toHaveCount(0);
  await composer.locator(".workflow-coverage-claim")
    .filter({ hasText: "The dashboard result is visually correct" })
    .getByRole("button", { name: "Edit" })
    .click();
  await expect(composer).toContainText("Provisional gaps: missing rendered output.");
  await capture(dashboard, "02-visual-provisional-gap");

  const submitted = dashboard.waitForResponse((response) =>
    response.request().method() === "POST"
    && /\/api\/workflow-bindings\/[^/]+\/submit$/.test(new URL(response.url()).pathname));
  await dialog.getByRole("button", { name: "Bind and submit" }).click();
  const accepted = await (await submitted).json() as { run: { id: string } };
  await expect(dialog).toBeHidden();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${accepted.run.id}$`));
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${accepted.run.id}`)
  ).run.status, { timeout: 60_000 }).toBe("completed");

  const readiness = dashboard.getByRole("region", { name: "Evidence readiness" });
  await expect(readiness).toBeVisible();
  await expect(readiness).toContainText("Advisory only. This result did not block workflow execution.");
  await expect(readiness).toContainText("The focused behavior remains correct");
  await expect(readiness).toContainText("The dashboard result is visually correct");
  await expect(readiness).toContainText("missing rendered output");
  await readiness.scrollIntoViewIfNeeded();
  await capture(dashboard, "03-frozen-readiness-run-detail");
});
