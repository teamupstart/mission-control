import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

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
  const updated = await fetch(`${daemon.baseURL}/api/workflows/${created.workflow.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedDraftRevision: 1,
      evidenceReadinessPolicy: "criterion_mapped_v1",
    }),
  });
  if (!updated.ok) throw new Error(`workflow update answered ${updated.status}: ${await updated.text()}`);
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${created.workflow.id}/publish`,
    { expectedDraftRevision: 2 },
  );
  return published.version.id;
}

async function capture(page: Page, name: string, target?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  if (target) {
    await target.screenshot({ path: `${EVIDENCE}${name}.png`, animations: "disabled" });
  } else {
    await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  }
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/workflow-evidence-readiness/${name}.png`);
}

function stageLaterPacket(
  daemon: DaemonHandle,
  noteKey: string,
  cwd: string,
  generation: number,
  prefix: string,
  complete: boolean,
): void {
  const now = Date.now();
  const executionId = `${prefix}-execution`;
  const renderedId = `${prefix}-rendered`;
  const execution = workflowCommandEvidenceContent({
    command: `node --test ${prefix}.test.ts`,
    exitCode: 0,
    output: `ok 1 - ${prefix}\n`,
  });
  const rendered = workflowCommandEvidenceContent({
    command: `capture ${prefix} rendered output`,
    exitCode: 0,
    output: `rendered ${prefix}\n`,
  });
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `UPDATE workflow_evidence_owners
       SET generation = ?, updated_at = ?
       WHERE note_key = ?`,
    ).run(generation, now, noteKey);
    db.prepare(
      `INSERT INTO workflow_evidence_scope_generations (
         note_key, source_root, generation, updated_at
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(note_key, source_root) DO UPDATE SET
         generation = excluded.generation,
         updated_at = excluded.updated_at`,
    ).run(noteKey, cwd, generation, now);
    const insertEvidence = db.prepare(
      `INSERT INTO workflow_evidence_staging (
         id, note_key, client_item_id, source_kind, evidence_kind, source_root,
         source_locator, inline_content, command_exit_code, episode_key, display_name, caption,
         repository_scope, mime_type, bytes, sha256, generation, state,
         reserved_group_key, created_at, updated_at
       ) VALUES (?, ?, ?, 'command', 'text', ?, ?, ?, 0, NULL, ?, ?, 'repo-01',
         'text/plain', ?, ?, ?, 'staged', NULL, ?, ?)`,
    );
    insertEvidence.run(
      `e2e-${executionId}`,
      noteKey,
      executionId,
      cwd,
      `${prefix}.test.ts`,
      execution,
      `${prefix}.test.ts`,
      `${prefix} execution passed`,
      Buffer.byteLength(execution),
      createHash("sha256").update(execution).digest("hex"),
      generation,
      now,
      now,
    );
    if (complete) {
      insertEvidence.run(
        `e2e-${renderedId}`,
        noteKey,
        renderedId,
        cwd,
        `capture ${prefix} rendered output`,
        rendered,
        `${prefix}.png`,
        `${prefix} rendered state`,
        Buffer.byteLength(rendered),
        createHash("sha256").update(rendered).digest("hex"),
        generation,
        now,
        now,
      );
    }
    db.prepare(
      `INSERT INTO workflow_evidence_coverage_staging (
         id, note_key, client_criterion_id, criterion, proof_class, repository_scope,
         source_root, links_json, episode_key, generation, state, reserved_group_key,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'visual', 'repo-01', ?, ?, NULL, ?, 'staged', NULL, ?, ?)`,
    ).run(
      `e2e-${prefix}-coverage`,
      noteKey,
      `${prefix}-criterion`,
      "The dashboard result is visually correct",
      cwd,
      JSON.stringify([
        { clientItemId: executionId, role: "execution" },
        ...(complete ? [{ clientItemId: renderedId, role: "rendered_output" }] : []),
      ]),
      generation,
      now,
      now,
    );
  });
}

test("criterion readiness waits, repairs in the same round, and records an operator override", async ({
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
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO workflow_evidence_owners (
         note_key, generation, all_generation, updated_at
       ) VALUES (?, 1, 0, ?)`,
    ).run(noteKey, now);
    db.prepare(
      `INSERT INTO workflow_evidence_scope_generations (
         note_key, source_root, generation, updated_at
       ) VALUES (?, ?, 1, ?)`,
    ).run(noteKey, session!.cwd, now);
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
  await expect(composer).toContainText("0 saved");

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
  await expect(composer).toContainText("1 saved");
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
  const binding = (await api<Array<{ id: string; workflowVersionId: string; sessionId: string }>>(
    daemon,
    "/api/workflow-bindings",
  )).find((candidate) => candidate.workflowVersionId === versionId && candidate.sessionId === sessionId);
  expect(binding).toBeTruthy();
  await expect(dialog).toBeHidden();
  await expect(dashboard).toHaveURL(new RegExp(`#/runs/${accepted.run.id}$`));
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${accepted.run.id}`)
  ).run.status, { timeout: 60_000 }).toBe("waiting_for_evidence_readiness");

  let readiness = dashboard.getByRole("region", { name: "Evidence readiness", exact: true });
  await expect(readiness).toBeVisible();
  await expect(readiness).toContainText(
    "Structural only. Test Evidence Auditor still judges whether the proof is relevant and sufficient.",
  );
  await expect(readiness).toContainText("The dashboard result is visually correct");
  await expect(readiness).toContainText("missing rendered output");
  await expect(readiness.getByRole("button", { name: "Retry evidence preflight" })).toBeVisible();
  await expect(readiness.getByRole("button", { name: "Continue despite gaps" })).toBeDisabled();
  await readiness.scrollIntoViewIfNeeded();
  await capture(dashboard, "03-waiting-for-readiness", readiness);

  const consoleLayout = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout: "console" }),
  });
  expect(consoleLayout.ok).toBe(true);
  await dashboard.goto(`${daemon.baseURL}/#/fleet`);
  const sessionsRail = dashboard.getByRole("navigation", { name: "Sessions" });
  await sessionsRail.locator("button.rail-row").first().click();
  await expect(dashboard.locator("header.detail-head")
    .getByRole("button", { name: "Evidence preflight" })).toBeVisible();
  await dashboard.goto(`${daemon.baseURL}/#/runs/${accepted.run.id}`);
  readiness = dashboard.getByRole("region", { name: "Evidence readiness", exact: true });

  const submissionsBeforeUnchangedRetry = (await api<{ submissions: Array<{ id: string }> }>(
    daemon,
    `/api/workflow-runs/${accepted.run.id}`,
  )).submissions.length;
  const unchangedRetry = dashboard.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().endsWith("/evidence-readiness/retry"));
  await readiness.getByRole("button", { name: "Retry evidence preflight" }).click();
  const unchangedRetryResponse = await unchangedRetry;
  expect(unchangedRetryResponse.status()).toBe(409);
  expect(await unchangedRetryResponse.json()).toMatchObject({ code: "workflow_unchanged_evidence" });
  await expect(dashboard.getByRole("alert")).toContainText(
    "Stage new evidence before retrying evidence preflight",
  );
  await expect.poll(async () => (
    await api<{ submissions: Array<{ id: string }> }>(daemon, `/api/workflow-runs/${accepted.run.id}`)
  ).submissions.length).toBe(submissionsBeforeUnchangedRetry);

  // Saving the initial criterion mapping advanced this scope to generation 2. A retry may
  // refine only from a strictly newer staging generation.
  stageLaterPacket(daemon, noteKey, session!.cwd, 3, "repair", true);
  await readiness.getByRole("button", { name: "Retry evidence preflight" }).click();
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${accepted.run.id}`)
  ).run.status, { timeout: 60_000 }).toBe("completed");
  await dashboard.reload();
  readiness = dashboard.getByRole("region", { name: "Evidence readiness", exact: true });
  await expect(readiness).toContainText("ready");
  await expect(dashboard.getByRole("region", { name: "Rounds" })
    .getByText("captured to repair evidence preflight gaps", { exact: false })).toBeVisible();
  await readiness.scrollIntoViewIfNeeded();
  await capture(dashboard, "04-repaired-same-round", readiness);

  stageLaterPacket(daemon, noteKey, session!.cwd, 4, "override", false);
  const overrideRun = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding!.id}/submit`,
    { requestId: `override-${Date.now()}` },
  );
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${overrideRun.run.id}`)
  ).run.status, { timeout: 60_000 }).toBe("waiting_for_evidence_readiness");
  await dashboard.goto(`${daemon.baseURL}/#/runs/${overrideRun.run.id}`);
  readiness = dashboard.getByRole("region", { name: "Evidence readiness", exact: true });
  const overrideBox = readiness.getByRole("region", { name: "Evidence readiness override" });
  await overrideBox.getByLabel("Reason").fill("Operator accepts the missing rendered output for this run.");
  await overrideBox.getByLabel("Test Evidence Auditor may still reject this packet.").check();
  const overrideRequest = dashboard.waitForRequest((request) => (
    request.method() === "POST"
    && request.url().includes(`/api/workflow-runs/${overrideRun.run.id}/submissions/`)
    && request.url().endsWith("/evidence-readiness/override")
  ));
  await overrideBox.getByRole("button", { name: "Continue despite gaps" }).click();
  expect((await overrideRequest).postDataJSON()).toMatchObject({ acknowledgedRisk: true });
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${overrideRun.run.id}`)
  ).run.status, { timeout: 60_000 }).toBe("completed");
  await expect(readiness).toContainText(
    "Operator continued despite gaps: Operator accepts the missing rendered output for this run.",
  );
  await readiness.scrollIntoViewIfNeeded();
  await capture(dashboard, "05-durable-operator-override", readiness);
});
