import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { workflowCommandEvidenceContent } from "../../src/shared/workflow.ts";
import type {
  WorkflowEvidenceCoverageClaim,
  WorkflowEvidenceReadinessResult,
  WorkflowSubmission,
} from "../../src/shared/workflow.ts";
import {
  evidenceReadinessEvaluatedEvent,
  evidenceTelemetryKey,
} from "../../src/server/workflows/test-evidence-audit.ts";

const EVIDENCE = artifactsDir("workflow-evidence-readiness");

/**
 * The Evidence pane, which is where readiness lives now that the run record is a tab bar.
 *
 * Reached rather than assumed. A run parked on readiness selects this pane by itself - the
 * block is what stopped the run, and a badge on a tab nobody clicks would leave it one click
 * away - but a run that has since completed sits on the worklist, and this spec asserts the
 * same controls in both states.
 */
async function evidencePane(page: Page): Promise<Locator> {
  const tab = page.getByRole("tab", { name: /^Evidence/ });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
  return page.getByRole("tabpanel", { name: /^Evidence/ });
}

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
): ReturnType<typeof evidenceReadinessEvaluatedEvent>["payload"] {
  const gaps = status === "gaps" ? ["missing_rendered_output" as const] : [];
  const evaluated: WorkflowEvidenceReadinessResult = {
    evaluatorVersion: "criterion_mapped_v1",
    status,
    criteria: [{
      criterionId: "analytics-criterion",
      criterion: "The analytics state is reviewer-visible",
      material: true,
      matchedClientCriterionId: "analytics-claim",
      authorProofClass: status === "gaps" ? "visual" : null,
      suggestedProofClass: null,
      links: [],
      gaps,
      warnings: [],
    }],
    gapCodes: gaps,
    warningCodes: [],
    unavailableReason: status === "unavailable" ? "fixture unavailable" : null,
  };
  const submission = {
    id: submissionId,
    runId: `run-${submissionId}`,
    round: 1,
    segment: 0,
    parentSubmissionId: null,
    continuationNodeId: null,
    continuationNodeAttemptId: null,
    mode: "full_workflow",
    triggerSource: "manual",
    triggerKey: `trigger-${submissionId}`,
    evidenceFingerprint: `fingerprint-${submissionId}`,
    context: {},
    evidence: {},
    prHeadSha: null,
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  } satisfies WorkflowSubmission;
  const coverage = [{
    clientCriterionId: "analytics-claim",
    criterion: "The analytics state is reviewer-visible",
    proofClass: "visual",
    repositoryScope: "repo-01",
    links: [],
  }] satisfies WorkflowEvidenceCoverageClaim[];
  return evidenceReadinessEvaluatedEvent({
    submission,
    readiness: evaluated,
    coverage,
    version: {
      workflowId: "analytics-workflow",
      version: workflowVersion,
      evidenceReadinessPolicy: "criterion_mapped_v1",
    },
  }).payload;
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

  /*
   * FIRST PAINT, with nothing clicked. A readiness block has parked this run, so the run record
   * opens on the pane holding it - the amber badge alone would leave the thing that stopped the
   * run one click away, which is the constraint the tab design had to answer.
   *
   * Reloaded first, because the browser landed here while the round was still capturing and the
   * initial pane is resolved ONCE per run on purpose: a state that turns blocking under a reader
   * raises the badge and does not yank them off the pane they chose. This is the arriving case.
   */
  await dashboard.reload();
  await expect(dashboard.getByRole("tab", { name: /^Evidence/ }))
    .toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  let readiness = await evidencePane(dashboard);
  await expect(readiness).toBeVisible();
  await expect(readiness).toContainText(
    "Structural only. Test Evidence Auditor still judges whether the proof is relevant and sufficient.",
  );
  await expect(readiness).toContainText("The dashboard result is visually correct");
  /*
   * The gap is reported ONCE, on the row of the claim it was recorded against.
   *
   * The reconciliation matched this author claim to a canonical criterion and still recorded
   * `missing_rendered_output` against it, because a focused command does not satisfy a visual
   * requirement. That criterion therefore HAS a row below, so it is not named in the block of
   * unmatched criteria - whose own sentence tells the reader those have no row to sit under.
   * The canonical wording is still a disclosure away, under Canonical reconciliation.
   */
  // Exactly the claim row's own note: the disclosure below carries the same code prefixed with
  // "Gaps:", and matching both would not prove which of them the reader actually sees.
  await expect(readiness.getByText("missing rendered output", { exact: true })).toBeVisible();
  await expect(readiness.getByRole("region", { name: "Unmatched canonical criteria" }))
    .toHaveCount(0);
  // By its title text: the control is a `<summary>`, which carries no implicit ARIA role for
  // `getByRole` to select on.
  const reconciliation = readiness.getByText("Canonical reconciliation", { exact: true });
  await reconciliation.click();
  await expect(readiness).toContainText(
    "Keep focused execution green and retain inspectable acceptance evidence",
  );
  await expect(readiness).toContainText("Gaps: missing rendered output");
  await reconciliation.click();
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
  readiness = await evidencePane(dashboard);

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
  readiness = await evidencePane(dashboard);
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
  readiness = await evidencePane(dashboard);
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
  await expect(card).toContainText("v13 · evaluator criterion_mapped_v1");
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

test("a round's spent preflight refinements block the run and hand the decision to the operator", async ({
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
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO workflow_evidence_owners (
         note_key, generation, all_generation, updated_at
       ) VALUES (?, 0, 0, ?)`,
    ).run(noteKey, Date.now());
  });

  // Every packet is missing the rendered output its own visual claim promises, so the
  // preflight keeps answering `gaps` and the round keeps buying refinements with them.
  stageLaterPacket(daemon, noteKey, session!.cwd, 1, "cap-root", false);
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: versionId,
    sessionId,
  });
  const created = await api<{ run: { id: string }; submission: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `cap-root-${Date.now()}` },
  );
  const runId = created.run.id;
  const runStatus = async () => (
    await api<{ run: { status: string; currentPhase: string } }>(daemon, `/api/workflow-runs/${runId}`)
  ).run;
  await expect.poll(async () => (await runStatus()).status, { timeout: 60_000 })
    .toBe("waiting_for_evidence_readiness");

  // The sweep and the explicit retry share one reservation. Either can capture the newly
  // staged packet first, so await the resulting child instead of requiring this request to win.
  let parentId = created.submission.id;
  for (const ordinal of [1, 2]) {
    stageLaterPacket(daemon, noteKey, session!.cwd, ordinal + 1, `cap-refine-${ordinal}`, false);
    const response = await fetch(
      `${daemon.baseURL}/api/workflow-runs/${runId}/submissions/${parentId}/evidence-readiness/retry`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: `cap-refine-${ordinal}-${Date.now()}` }),
      },
    );
    expect([200, 409]).toContain(response.status);
    await expect.poll(async () => {
      const detail = await api<{ submissions: WorkflowSubmission[] }>(daemon, `/api/workflow-runs/${runId}`);
      return { count: detail.submissions.length, parentId: detail.submissions.at(-1)?.parentSubmissionId,
        status: detail.submissions.at(-1)?.status };
    }, { timeout: 60_000 }).toEqual({ count: ordinal + 1, parentId, status: "waiting_for_evidence_readiness" });
    const detail = await api<{ submissions: WorkflowSubmission[] }>(daemon, `/api/workflow-runs/${runId}`);
    parentId = detail.submissions.at(-1)!.id;
  }

  // The healthy waiting round first, so the two controls the block changes are known to have
  // been there: this is the state every earlier segment of this round rendered in.
  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  const readiness = await evidencePane(dashboard);
  await expect(readiness.getByRole("button", { name: "Retry evidence preflight" })).toBeVisible();
  await expect(readiness.getByRole("region", { name: "Evidence readiness override" }))
    .not.toContainText("This round has spent its evidence preflight refinements");

  /*
   * The attempt that exceeds the cap, requested rather than clicked.
   *
   * WHICH actor spends it is genuinely a race and the daemon is right either way: the readiness
   * sweep reserves newly staged evidence on its own tick, so it can reach the cap between the
   * staging below and anything this spec does. Both routes are refused with 409 and both block
   * the run identically, so this asserts the refusal and then the state both produce. Driving it
   * through the route keeps the browser assertions below about the block's CONSEQUENCE, which is
   * what a person sees and what no other test layer can observe. The cap's own refusal message
   * is asserted where its ordering is deterministic, in `test/workflow-evidence-preflight.test.ts`.
   */
  stageLaterPacket(daemon, noteKey, session!.cwd, 4, "cap-over-limit", false);
  const refusal = await fetch(
    `${daemon.baseURL}/api/workflow-runs/${runId}/submissions/${parentId}/evidence-readiness/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: `cap-over-limit-${Date.now()}` }),
    },
  );
  expect(refusal.status).toBe(409);
  await expect.poll(async () => (await runStatus()).currentPhase, { timeout: 60_000 })
    .toBe("preflight_refinement_exhausted");
  expect((await runStatus()).status).toBe("blocked");
  // No fourth submission exists: the refusal is a refusal, not a segment that reviewed nothing.
  expect((await api<{ submissions: unknown[] }>(daemon, `/api/workflow-runs/${runId}`)).submissions)
    .toHaveLength(3);

  // The block withdraws the loop, not the decision: the refinement button is gone, the reason
  // is on the page, and the operator's own way through is still there.
  const overrideBox = readiness.getByRole("region", { name: "Evidence readiness override" });
  await expect(overrideBox).toBeVisible();
  await expect(overrideBox).toContainText(
    "This round has spent its evidence preflight refinements without closing these gaps",
  );
  await expect(readiness.getByRole("button", { name: "Retry evidence preflight" })).toHaveCount(0);
  await readiness.scrollIntoViewIfNeeded();
  await capture(dashboard, "08-preflight-refinements-exhausted", readiness);

  await overrideBox.getByLabel("Reason").fill(
    "The mapping is right; the preflight and this packet disagree about the proof class.",
  );
  await overrideBox.getByLabel("Test Evidence Auditor may still reject this packet.").check();
  await overrideBox.getByRole("button", { name: "Continue despite gaps" }).click();
  await expect.poll(async () => (await runStatus()).status, { timeout: 60_000 }).toBe("completed");
  await expect(readiness).toContainText(
    "Operator continued despite gaps: The mapping is right; the preflight and this packet"
    + " disagree about the proof class.",
  );
});

for (const reviewCase of ["substantive", "corrected", "exhausted", "legacy"] as const) test(`Persona readiness shows ${reviewCase} review and its recovery`, async ({
  dashboard,
  daemon,
}) => {
  test.setTimeout(180_000);
  const sessionId = await dispatch(dashboard, daemon);
  // No model tokens: the reviewer's published guidance carries `E2E_FAIL_VERDICT`, which
  // `e2e/fixtures/fake-claude.mjs` answers with a fixed, schema-valid fail verdict.
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: "Disagreement reviewer",
    guidanceMarkdown: `# Disagreement reviewer\n\n${reviewCase === "corrected" ? "E2E_CONTRACT_REVIEW E2E_CORRECT_REVIEW" : reviewCase === "exhausted" ? "E2E_CONTRACT_REVIEW" : "E2E_FAIL_VERDICT"}`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "E2E readiness disagreement",
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
  const enforced = await fetch(`${daemon.baseURL}/api/workflows/${workflow.workflow.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedDraftRevision: 1, evidenceReadinessPolicy: "criterion_mapped_v1" }),
  });
  if (!enforced.ok) throw new Error(`workflow update answered ${enforced.status}`);
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 2 },
  );

  const session = (await api<Array<{ id: string; agentSessionId?: string; cwd: string }>>(
    daemon,
    "/api/sessions",
  )).find((candidate) => candidate.id === sessionId);
  expect(session).toBeTruthy();
  const noteKey = session!.agentSessionId ?? session!.id;
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `INSERT INTO workflow_evidence_owners (
         note_key, generation, all_generation, updated_at
       ) VALUES (?, 0, 0, ?)`,
    ).run(noteKey, Date.now());
  });
  // COMPLETE: the visual claim carries both an execution and a rendered-output link, so the
  // preflight answers `ready` and the reviewer runs against a structurally complete packet.
  stageLaterPacket(daemon, noteKey, session!.cwd, 1, "agreed", true);

  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: "preview",
  });
  const created = await api<{ run: { id: string }; submission: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `disagreement-${Date.now()}` },
  );
  const runId = created.run.id;
  await expect.poll(async () => (
    await api<{ submissions: Array<{ readiness: { status: string } | null }> }>(
      daemon,
      `/api/workflow-runs/${runId}`,
    )
  ).submissions[0]?.readiness?.status, { timeout: 60_000 }).toBe("ready");
  await expect.poll(async () => (
    await api<{ run: { status: string } }>(daemon, `/api/workflow-runs/${runId}`)
  ).run.status, { timeout: 60_000 }).toBe(reviewCase === "corrected" ? "completed" : reviewCase === "exhausted" ? "blocked" : "waiting_for_session");

  await dashboard.goto(`${daemon.baseURL}/#/runs/${runId}`);
  if (reviewCase === "corrected" || reviewCase === "exhausted") {
    const detail = await api<{ attempts: Array<{ reviewRejections?: unknown[] }>; events: Array<{ kind: string }> }>(daemon, `/api/workflow-runs/${runId}`);
    expect(detail.attempts.some((attempt) => (attempt.reviewRejections?.length ?? 0) > 0)).toBe(true);
    const timeline = dashboard.locator("section.wf-run-timeline");
    await expect(timeline).toContainText("Persona contract violation");
    await expect(timeline).toContainText(reviewCase === "corrected" ? "accepted" : "exhausted");
    if (reviewCase === "exhausted") {
      await expect(dashboard.getByText(/Persona review contract error/).first()).toBeVisible();
      await expect(dashboard.getByText("Rejected review responses", { exact: true })).toBeVisible();
      await expect(dashboard.getByText("Rejected review responses", { exact: true }))
        .toHaveAccessibleDescription("Show the review responses rejected by the review contract");
      await capture(dashboard, "13-review-contract-recovery", dashboard.locator("article.wf-run-attempt").first());
    }
    await capture(dashboard, `11-contract-${reviewCase}`, timeline);
    return;
  }
  if (reviewCase === "legacy") {
    withDaemonDb(daemon, (db) => {
      const row = db.prepare("SELECT id, verdict_json FROM workflow_node_attempts WHERE submission_id = ? AND persona_snapshot_json IS NOT NULL").get(created.submission.id) as { id: string; verdict_json: string };
      const verdict = JSON.parse(row.verdict_json);
      for (const change of verdict.requestedChanges) delete change.basis;
      db.prepare("UPDATE workflow_node_attempts SET verdict_json = ?, review_input_json = NULL WHERE id = ?").run(JSON.stringify(verdict), row.id);
    });
    await dashboard.reload();
    await evidencePane(dashboard);
    const recovery = dashboard.getByRole("region", { name: "Evidence recovery", exact: true });
    await expect(recovery).toContainText("legacy finding reasons may be unknown");
    await capture(dashboard, "12-legacy-review-recovery", recovery);
    await recovery.getByRole("button", { name: "Re-review evidence decision" }).click();
    await expect.poll(async () => (await api<{ submissions: WorkflowSubmission[] }>(daemon, `/api/workflow-runs/${runId}`)).submissions.length).toBe(2);
    return;
  }
  const timeline = dashboard.locator("section.wf-run-timeline");
  await expect(timeline.getByRole("heading", { name: "Timeline" })).toBeVisible();
  const disagreement = timeline.getByRole("listitem")
    .filter({ hasText: "Readiness review disagreement" });
  await expect(disagreement).toHaveCount(1);
  // The two gates and what each one said, in the reader's own words rather than an event id.
  await expect(disagreement).toContainText("Disagreement reviewer");
  await expect(disagreement).toContainText("readiness ready");
  // The durable spelling never reaches the screen as itself: the timeline prints the readable
  // form, which is the same rule every other event payload value is rendered under.
  await expect(disagreement).toContainText("policy criterion mapped v1");
  await expect(disagreement).toContainText("summary Deterministic e2e objection");
  // It sits in the round it happened in, beside the verdict that caused it.
  await expect(timeline.getByRole("heading", { name: "Round 1" })).toBeVisible();
  await expect(timeline.getByRole("listitem").filter({ hasText: "Persona verdict" }))
    .toContainText("verdict fail");
  await expect(dashboard.getByText(/Structural readiness at review: ready/)).toBeVisible();
  await capture(dashboard, "14-structural-and-substantive-review", dashboard.locator("article.wf-run-change").first());
  await disagreement.scrollIntoViewIfNeeded();
  await capture(dashboard, "09-readiness-review-disagreement", timeline);
});

test("mapping infrastructure recovery reuses frozen evidence in a new same-round segment", async ({ dashboard, daemon }) => {
  test.setTimeout(180_000);
  const sessionId = await dispatch(dashboard, daemon);
  const versionId = await createWorkflow(daemon);
  const session = (await api<Array<{ id: string; agentSessionId?: string; cwd: string }>>(daemon, "/api/sessions"))
    .find((item) => item.id === sessionId)!;
  const noteKey = session.agentSessionId ?? session.id;
  withDaemonDb(daemon, (db) => {
    db.prepare("INSERT INTO workflow_evidence_owners (note_key, generation, all_generation, updated_at) VALUES (?, 0, 0, ?)")
      .run(noteKey, Date.now());
  });
  stageLaterPacket(daemon, noteKey, session.cwd, 1, "mapping-recovery", false);
  const binding = await api<{ id: string }>(daemon, "/api/workflow-bindings", { workflowVersionId: versionId, sessionId, deliveryMode: "preview" });
  const created = await api<{ run: { id: string }; submission: { id: string } }>(daemon,
    `/api/workflow-bindings/${binding.id}/submit`, { requestId: "mapping-root" });
  await expect.poll(async () => (await api<{ run: { status: string } }>(daemon,
    `/api/workflow-runs/${created.run.id}`)).run.status).toBe("waiting_for_evidence_readiness");
  // Reproduce a persisted failed mapping operation without launching a real model.
  withDaemonDb(daemon, (db) => {
    const row = db.prepare("SELECT context_json FROM workflow_submissions WHERE id = ?").get(created.submission.id) as { context_json: string };
    const context = JSON.parse(row.context_json);
    context.criterionMappings = [];
    context.reconciliation = { version: 1, fingerprint: "a".repeat(64), status: "failed", method: "semantic", attempts: 2, error: "mapping timeout", cause: "transport" };
    delete context.coverageSelection;
    db.prepare("UPDATE workflow_submissions SET context_json = ?, status = 'failed' WHERE id = ?").run(JSON.stringify(context), created.submission.id);
    db.prepare("UPDATE workflow_runs SET status = 'blocked', current_phase = 'evidence_reconciliation_error', gate_state_json = ? WHERE id = ?")
      .run(JSON.stringify({ submissionId: created.submission.id, error: "mapping timeout" }), created.run.id);
  });
  await dashboard.goto(`${daemon.baseURL}/#/runs/${created.run.id}`);
  await evidencePane(dashboard);
  const recovery = dashboard.getByRole("region", { name: "Evidence recovery", exact: true });
  await expect(recovery).toContainText("frozen evidence");
  await expect(recovery.getByRole("button", { name: "Retry criterion mapping" })).toBeVisible();
  await expect(recovery.getByRole("button", { name: "Retry criterion mapping" }))
    .toHaveAccessibleDescription("Retry with the frozen evidence in a new segment without spending an author repair");
  await capture(dashboard, "10-mapping-recovery", recovery);
  await recovery.getByRole("button", { name: "Retry criterion mapping" }).click();
  await expect.poll(async () => (await api<{ submissions: WorkflowSubmission[] }>(daemon,
    `/api/workflow-runs/${created.run.id}`)).submissions.length).toBe(2);
  const detail = await api<{ submissions: WorkflowSubmission[] }>(daemon, `/api/workflow-runs/${created.run.id}`);
  expect(detail.submissions.map((item) => item.round)).toEqual([1, 1]);
  expect(detail.submissions[1]!.parentSubmissionId).toBe(created.submission.id);
  expect(detail.submissions[0]!.status).toBe("failed");
});
