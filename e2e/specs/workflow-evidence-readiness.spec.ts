import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { workflowCommandEvidenceContent } from "../../src/shared/workflow.ts";
import { evidenceTelemetryKey } from "../../src/server/workflows/test-evidence-audit.ts";

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

function readiness(
  submissionId: string,
  status: "ready" | "gaps" | "unavailable",
  workflowVersion: number,
): Record<string, unknown> {
  return {
    submissionKey: evidenceTelemetryKey("submission", submissionId),
    policy: "criterion_mapped_v1",
    evaluatorVersion: "criterion-mapped-v1",
    status,
    round: 1,
    segment: 0,
    refinementReason: null,
    criteriaCount: 1,
    mappedClaimCount: 1,
    warningCount: 0,
    gapCount: status === "gaps" ? 1 : 0,
    gapCodes: status === "gaps" ? [{ category: "missing_rendered_output", count: 1 }] : [],
    proofClasses: status === "gaps" ? [{ category: "visual", count: 1 }] : [],
    missingRoles: status === "gaps" ? [{ category: "rendered_output", count: 1 }] : [],
    override: false,
    workflowId: "analytics-workflow",
    workflowVersion,
    repositoryScope: "repository",
  };
}

function seedOutcomeAnalytics(daemon: DaemonHandle): void {
  const audit = (
    submissionId: string,
    outcome: "pass" | "fail",
    readinessStatus: "ready" | "overridden",
    workflowVersion: number,
    digest: string,
  ) => ({
    nodeId: "test-auditor",
    submissionKey: evidenceTelemetryKey("submission", submissionId),
    workflowId: "analytics-workflow",
    workflowVersion,
    guidance: {
      personaId: "builtin:test-evidence-auditor",
      revision: workflowVersion,
      digest,
    },
    round: 1,
    segment: 0,
    firstSubmission: true,
    firstAuditorAttempt: true,
    readinessSnapshot: {
      policy: "criterion_mapped_v1",
      evaluatorVersion: "criterion-mapped-v1",
      status: readinessStatus,
    },
    outcome,
    rejectionCategories: outcome === "fail" ? ["visual_artifact"] : [],
    evidenceReadiness: {
      imageCount: 0,
      textArtifactCount: 0,
      checkCount: 1,
      checkOmittedBytes: 0,
      transcriptMessageCount: 1,
      transcriptTruncated: false,
      transcriptOmittedHeadBytes: 0,
      transcriptMiddleOmitted: false,
    },
    downstreamProofRequests: [],
    possibleDownstreamProofOverreach: false,
  });
  const legacyAudit = (...args: Parameters<typeof audit>) => {
    const payload: ReturnType<typeof audit> & { firstAuditorAttempt?: boolean } = audit(...args);
    delete payload.firstAuditorAttempt;
    return payload;
  };
  withDaemonDb(daemon, (db) => {
    const insert = db.prepare(
      `INSERT INTO workflow_events (event_id, run_id, ts, event_kind, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const events: Array<[string, string, number, string, unknown]> = [
      ["e2e-readiness-ready", "analytics-ready", 10, "evidence_readiness_evaluated",
        readiness("opaque-ready", "ready", 13)],
      ["e2e-audit-ready", "analytics-ready", 11, "test_evidence_audit",
        audit("opaque-ready", "fail", "ready", 13, "aaaaaaaaaaaa")],
      ["e2e-readiness-override", "analytics-override", 20, "evidence_readiness_evaluated",
        readiness("override-submission", "gaps", 12)],
      ["e2e-override", "analytics-override", 21, "evidence_readiness_overridden",
        { submissionId: "override-submission", acknowledgedRisk: true }],
      ["e2e-audit-override", "analytics-override", 22, "test_evidence_audit",
        audit("override-submission", "pass", "overridden", 12, "bbbbbbbbbbbb")],
      ["e2e-readiness-refined", "analytics-refined", 30, "evidence_readiness_evaluated",
        readiness("refined-submission", "gaps", 13)],
      ["e2e-refinement", "analytics-refined", 31, "evidence_preflight_refinement_reserved",
        { parentSubmissionId: "refined-submission", round: 1, segment: 1 }],
      ["e2e-readiness-unavailable", "analytics-unavailable", 40,
        "evidence_readiness_evaluated", readiness("unavailable-submission", "unavailable", 13)],
      ["e2e-audit-legacy-1", "analytics-legacy-1", 50, "test_evidence_audit",
        legacyAudit("legacy-submission-1", "pass", "ready", 13, "cccccccccccc")],
      ["e2e-audit-legacy-2", "analytics-legacy-2", 51, "test_evidence_audit",
        legacyAudit("legacy-submission-2", "pass", "ready", 13, "cccccccccccc")],
    ];
    for (const event of events) {
      insert.run(event[0], event[1], event[2], event[3], JSON.stringify(event[4]));
    }
  });
}

function seedUnreadableAuditorWithValidPreflight(daemon: DaemonHandle): void {
  withDaemonDb(daemon, (db) => {
    const insert = db.prepare(
      `INSERT INTO workflow_events (event_id, run_id, ts, event_kind, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(
      "e2e-readiness-with-unreadable-auditor",
      "analytics-mixed-window",
      10,
      "evidence_readiness_evaluated",
      JSON.stringify(readiness("mixed-window-submission", "ready", 13)),
    );
    insert.run(
      "e2e-unreadable-auditor",
      "analytics-mixed-window",
      11,
      "test_evidence_audit",
      JSON.stringify({ malformed: true }),
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
  await expect(composer).toContainText("0 saved");
  const executionEvidence = composer.getByLabel("Execution evidence for acceptance criterion");
  await executionEvidence.selectOption("execution:secondary-command");
  await expect(executionEvidence).toHaveValue("execution:secondary-command");
  await executionEvidence.scrollIntoViewIfNeeded();
  await capture(dashboard, "01-legacy-command-evidence-visible");
  await executionEvidence.selectOption("");

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

test("Test evidence readiness separates preflight outcomes from first Auditor acceptance", async ({
  dashboard,
  daemon,
}) => {
  seedOutcomeAnalytics(daemon);
  await dashboard.setViewportSize({ width: 1440, height: 1600 });
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  const card = dashboard.locator('[data-anchor="workflows/test-evidence"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("First Auditor attempt accepted 50% (1 of 2 first Auditor attempts)");
  await expect(card).toContainText("target at least 70%");
  await expect(card).toContainText(
    "2 legacy attempts have no first-Auditor identity and are excluded from the headline.",
  );
  await expect(card).toContainText("Preflight interceptions");
  await expect(card).toContainText("50% (2 of 4 enforcing evaluations)");
  await expect(card).toContainText("Same-round refinements");
  await expect(card).toContainText("50% (1 of 2 intercepted runs)");
  await expect(card).toContainText("Operator overrides");
  await expect(card).toContainText("Readiness unavailable");
  await expect(card).toContainText("25% (1 of 4 enforcing evaluations)");
  await expect(card).toContainText("Post-ready Auditor rejection");
  await expect(card).toContainText("100% (1 of 1 first Auditor attempts on ready packets)");
  await expect(card).toContainText("Post-override Auditor rejection");
  await expect(card).toContainText("0% (0 of 1 first Auditor attempts on overridden packets)");
  await expect(card).toContainText("Visual proof class");
  await expect(card).toContainText("Missing Rendered output role");
  await expect(card).toContainText("v13 · guidance aaaaaaaa");
  await expect(card).toContainText("v12 · guidance bbbbbbbb");
  await expect(card).toContainText("v13 · evaluator criterion-mapped-v1");
  await expect(card).toContainText(
    "An interception is not an acceptance: the Auditor remains the semantic authority.",
  );
  await card.scrollIntoViewIfNeeded();
  await capture(dashboard, "06-outcome-analytics-desktop", card);

  await dashboard.setViewportSize({ width: 900, height: 1600 });
  await expect(card).toBeVisible();
  const cardBox = await card.boundingBox();
  expect(cardBox, "analytics card must have a rendered box at constrained width").not.toBeNull();
  expect(cardBox!.width, "analytics card must fit the constrained viewport").toBeLessThan(900);
  await capture(dashboard, "07-outcome-analytics-constrained", card);
});

test("valid preflight outcomes remain visible when Auditor telemetry is unreadable", async ({
  dashboard,
  daemon,
}) => {
  seedUnreadableAuditorWithValidPreflight(daemon);
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  const card = dashboard.locator('[data-anchor="workflows/test-evidence"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("No Test Evidence Auditor attempt could be read back");
  await expect(card).toContainText("Preflight outcomes");
  await expect(card).toContainText("0% (0 of 1 enforcing evaluations)");
  await expect(card).not.toContainText("No Test Evidence Auditor attempt has been recorded yet");
});
