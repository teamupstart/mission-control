import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  APP_CONFIG_ENTRIES,
  type AnyAppConfigEntry,
} from "../src/shared/app-config-entries.ts";
import {
  AwayConfigSchema,
  CostConfigSchema,
  SkillsConfigSchema,
} from "../src/shared/protocol.ts";
import {
  canonicalSettingsBackupJson,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_FORMAT_VERSION,
  type SettingsBackupEnvelopeBodyV1,
  type SettingsBackupEnvelopeV1,
} from "../src/shared/settings-backups.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

const home = mkdtempSync(join(tmpdir(), "mission-settings-restore-"));
process.env.HARNESS_HOME = join(home, "state");
process.env.CLAUDE_SETTINGS_PATH = join(home, "claude-settings.json");

const { openDb, getAppConfig, setAppConfig } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { personaView } = await import("../src/server/workflows/personas.ts");
const { BUILTIN_PERSONAS } = await import("../src/server/workflows/builtin-personas.ts");
const { BUILTIN_SESSION_ACTIONS } =
  await import("../src/server/workflows/builtin-session-actions.ts");
const { BUILTIN_WORKFLOWS } = await import("../src/server/workflows/builtin-workflows.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");
const {
  normalizePersonaName,
  normalizeSessionActionName,
  normalizeWorkflowName,
} = await import("../src/shared/workflow.ts");
const { setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { captureSettingsCatalogs, settingsCatalogCounts } =
  await import("../src/server/settings-backups/catalogs.ts");
const {
  captureSettingsConfig,
  mergeSettingPayload,
} = await import("../src/server/settings-backups/config-registry.ts");
const { createSettingsBackupEnvelope } =
  await import("../src/server/settings-backups/format.ts");
const { migrateSettingsBackupSnapshot, stageSettingsBackupSnapshot } =
  await import("../src/server/settings-backups/restore.ts");
const { SettingsBackupService } = await import("../src/server/settings-backups/service.ts");
const { SettingsBackupStore } = await import("../src/server/settings-backups/store.ts");
const {
  preflightCostReconcile,
  reconcileCostTelemetry,
} = await import("../src/server/cost.ts");
const { preflightSkillsReconcile, reconcileSkills } =
  await import("../src/server/skills/config.ts");

const db = openDb();
const workflowStore = new WorkflowStore(db);

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  clearWorkflowTables(db);
  db.exec("DELETE FROM app_config");
  try { rmSync(process.env.CLAUDE_SETTINGS_PATH!); } catch {}
});

const draft = (personaId: string, label = "Approved") => ({
  nodes: [
    { id: "session", kind: "session" as const, position: { x: 0, y: 0 } },
    { id: "judge", kind: "persona" as const, personaId, position: { x: 220, y: 0 } },
    { id: "end", kind: "end" as const, outcome: label, position: { x: 440, y: 0 } },
  ],
  edges: [
    { id: "start", source: "session", sourcePort: "submitted" as const, target: "judge", targetPort: "activate" as const },
    { id: "pass", source: "judge", sourcePort: "pass" as const, target: "end", targetPort: "terminal" as const },
    { id: "fail", source: "judge", sourcePort: "fail" as const, target: "session", targetPort: "return_for_changes" as const },
  ],
});

const defaults = {
  completionPolicy: { kind: "none" as const },
  resumptionPolicy: "manual" as const,
  bindingDefaults: { triggerMode: "manual" as const, deliveryMode: "preview" as const, maxRepairRounds: 2 },
};

function seedBaseline(): void {
  assert.equal(workflowStore.insertPersona({
    id: "persona-one",
    name: "Persona One",
    normalizedName: normalizePersonaName("Persona One"),
    description: "Original Persona",
    guidanceMarkdown: "# SECRET ORIGINAL GUIDANCE\n\nExact old bytes.\n",
    runner: null,
    model: null,
    createdAt: 10,
    updatedAt: 10,
  }).ok, true);
  assert.equal(workflowStore.insertSessionAction({
    id: "action-one",
    name: "Action One",
    normalizedName: normalizeSessionActionName("Action One"),
    description: "Original Action",
    promptMarkdown: "# SECRET ORIGINAL PROMPT\n\nDo it.\n",
    requiredSkillId: null,
    completion: { kind: "session_turn" },
    createdAt: 11,
    updatedAt: 11,
  }).ok, true);
  assert.equal(workflowStore.insertWorkflow({
    id: "workflow-one",
    name: "Workflow One",
    normalizedName: normalizeWorkflowName("Workflow One"),
    description: "Original workflow",
    draft: draft("persona-one"),
    ...defaults,
    createdAt: 12,
    updatedAt: 12,
  }).ok, true);
  assert.equal(workflowStore.publishWorkflow("workflow-one", 1, "version-one", 13).ok, true);
  workflowStore.seedWorkflowCommands(14);
  const unit = workflowStore.getWorkflowCommand("test")!;
  assert.equal(workflowStore.replaceWorkflowCommandCas("test", unit.revision, {
    defaultCommand: ["SECRET_ARGV", "test"],
    overrides: [{ repoRoot: "/secret/repository", command: ["SECRET_OVERRIDE"] }],
    maxRuns: 2,
  }, 15).ok, true);

  setAppConfig(APP_CONFIG_ENTRIES.skills, SkillsConfigSchema.parse({
    enabled: false,
    skills: { alpha: true },
    generation: 7,
    generationAt: 70,
  }));
  setAppConfig(APP_CONFIG_ENTRIES.away, AwayConfigSchema.parse({
    away: false,
    awaySince: null,
    detectStalls: true,
    stallWorkingMinutes: 5,
    stallUnfinishedMinutes: 10,
    stallEscalationMinutes: 20,
  }));
  setAppConfig(APP_CONFIG_ENTRIES.cost, CostConfigSchema.parse({ enabled: false }));
  setWorkflowPolicy({
    liveEnabled: true,
    repoAllowlist: ["/secret/allowlist"],
    defaultWorkflowId: "workflow-one",
    retention: { rawEvidenceDays: 14, completedRunDays: 30, maxCompletedRuns: 100 },
    checksEnabled: true,
  });
}

function snapshot(
  id = "daily-2026-08-24",
  appVersion = "restore-test",
): SettingsBackupEnvelopeV1 {
  const catalogs = captureSettingsCatalogs(workflowStore);
  return createSettingsBackupEnvelope({
    format: SETTINGS_BACKUP_FORMAT,
    formatVersion: SETTINGS_BACKUP_FORMAT_VERSION,
    id,
    kind: "daily",
    createdAt: "2026-08-24T12:00:00.000Z",
    localDate: "2026-08-24",
    appVersion,
    domains: [...captureSettingsConfig(), ...catalogs]
      .sort((left, right) => left.domain.localeCompare(right.domain)),
    counts: settingsCatalogCounts(catalogs),
  });
}

function resign(
  original: SettingsBackupEnvelopeV1,
  mutate: (value: SettingsBackupEnvelopeBodyV1) => void,
): SettingsBackupEnvelopeV1 {
  const { digest: _digest, ...raw } = structuredClone(original);
  mutate(raw);
  return createSettingsBackupEnvelope(raw);
}

function service(
  root: string,
  runtime: Record<string, unknown> = {},
  store = new SettingsBackupStore(root),
): InstanceType<typeof SettingsBackupService> {
  return new SettingsBackupService(
    workflowStore,
    store,
    () => new Date("2026-08-24T18:00:00.000Z"),
    "restore-test",
    {
      preflightSkills: () => [],
      preflightCost: () => {},
      reconcileSkills: () => {},
      reconcileCost: () => {},
      ...runtime,
    },
  );
}

function mutateCurrentState(): void {
  const persona = workflowStore.getPersona("persona-one")!;
  assert.equal(workflowStore.updatePersonaCas("persona-one", persona.revision, {
    description: "Changed Persona",
    guidanceMarkdown: "# NEW GUIDANCE\n",
  }, 100).ok, true);
  const action = workflowStore.getSessionAction("action-one")!;
  assert.equal(workflowStore.updateSessionActionCas("action-one", action.revision, {
    description: "Changed Action",
    promptMarkdown: "# NEW PROMPT\n",
  }, 101).ok, true);
  const workflow = workflowStore.getWorkflow("workflow-one")!;
  assert.equal(workflowStore.updateWorkflowCas("workflow-one", workflow.draftRevision, {
    description: "Changed workflow",
    draft: draft("persona-one", "Changed"),
  }, 102).ok, true);
  assert.equal(workflowStore.publishWorkflow("workflow-one", 2, "version-two", 103).ok, true);
  assert.equal(workflowStore.archivePersonaCas("persona-one", 2, 104).ok, true);
  assert.equal(workflowStore.archiveSessionActionCas("action-one", 2, 105).ok, true);

  assert.equal(workflowStore.insertPersona({
    id: "persona-later",
    name: "Persona Later",
    normalizedName: normalizePersonaName("Persona Later"),
    description: "Created later",
    guidanceMarkdown: "later",
    runner: null,
    model: null,
    createdAt: 106,
    updatedAt: 106,
  }).ok, true);
  assert.equal(workflowStore.insertSessionAction({
    id: "action-later",
    name: "Action Later",
    normalizedName: normalizeSessionActionName("Action Later"),
    description: "Created later",
    promptMarkdown: "later",
    requiredSkillId: null,
    completion: { kind: "session_turn" },
    createdAt: 107,
    updatedAt: 107,
  }).ok, true);
  assert.equal(workflowStore.insertWorkflow({
    id: "workflow-later",
    name: "Workflow Later",
    normalizedName: normalizeWorkflowName("Workflow Later"),
    description: "Created later",
    draft: draft("persona-later"),
    ...defaults,
    createdAt: 108,
    updatedAt: 108,
  }).ok, true);

  const command = workflowStore.getWorkflowCommand("test")!;
  assert.equal(workflowStore.replaceWorkflowCommandCas("test", command.revision, {
    defaultCommand: ["changed"],
    overrides: [],
    maxRuns: 4,
  }, 109).ok, true);
  setAppConfig(APP_CONFIG_ENTRIES.skills, SkillsConfigSchema.parse({
    enabled: true,
    skills: { beta: true },
    generation: 99,
    generationAt: 999,
  }));
  setAppConfig(APP_CONFIG_ENTRIES.away, AwayConfigSchema.parse({
    away: true,
    awaySince: 555,
    detectStalls: false,
    stallWorkingMinutes: 50,
    stallUnfinishedMinutes: 60,
    stallEscalationMinutes: 70,
  }));
  setAppConfig(APP_CONFIG_ENTRIES.cost, CostConfigSchema.parse({ enabled: true }));
  setAppConfig(APP_CONFIG_ENTRIES.foremanLease, { workerId: "live-worker", expiresAt: 9999 });
  setAppConfig(APP_CONFIG_ENTRIES.costTelemetryEnabledAt, 8888);
  setWorkflowPolicy({
    liveEnabled: false,
    repoAllowlist: [],
    defaultWorkflowId: null,
    retention: { rawEvidenceDays: 15, completedRunDays: 31, maxCompletedRuns: 101 },
    checksEnabled: false,
  });
}

function seedMaterializedBuiltins(): { ids: [string, string, string]; rows: string } {
  const persona = BUILTIN_PERSONAS[0]!;
  const action = BUILTIN_SESSION_ACTIONS[0]!;
  const workflow = BUILTIN_WORKFLOWS[0]!.definition;
  db.prepare(
    `INSERT INTO personas (
       id, name, normalized_name, description, guidance_md, runner_id, model_id,
       revision, archived_at, created_at, updated_at, import_provenance_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    persona.id,
    persona.name,
    persona.normalizedName,
    persona.description,
    persona.guidanceMarkdown,
    persona.runner,
    persona.model,
    41,
    null,
    410,
    411,
    null,
  );
  db.prepare(
    `INSERT INTO session_actions (
       id, name, normalized_name, description, prompt_md, required_skill_id,
       completion_kind, revision, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    action.id,
    action.name,
    action.normalizedName,
    action.description,
    action.promptMarkdown,
    action.requiredSkillId,
    action.completion.kind,
    42,
    null,
    420,
    421,
  );
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json,
       completion_policy_json, resumption_policy, binding_defaults_json,
       draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workflow.id,
    workflow.name,
    workflow.normalizedName,
    workflow.description,
    JSON.stringify(workflow.draft),
    JSON.stringify(workflow.completionPolicy),
    workflow.resumptionPolicy,
    JSON.stringify(workflow.bindingDefaults),
    43,
    workflow.currentVersionId,
    null,
    430,
    431,
  );
  const ids: [string, string, string] = [persona.id, action.id, workflow.id];
  const rows = canonicalSettingsBackupJson({
    persona: db.prepare(`SELECT * FROM personas WHERE id = ?`).get(persona.id),
    action: db.prepare(`SELECT * FROM session_actions WHERE id = ?`).get(action.id),
    workflow: db.prepare(`SELECT * FROM workflow_definitions WHERE id = ?`).get(workflow.id),
  });
  return { ids, rows };
}

function dumpExcludedTables(): Record<string, string[]> {
  const owned = new Set([
    "app_config",
    "personas",
    "session_actions",
    "workflow_commands",
    "workflow_command_overrides",
    "workflow_definitions",
    "workflow_versions",
  ]);
  const tables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  ).all() as unknown as Array<{ name: string }>).map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && !owned.has(name));
  return Object.fromEntries(tables.map((table) => {
    const escaped = table.replaceAll('"', '""');
    const rows = db.prepare(`SELECT * FROM "${escaped}"`).all() as unknown[];
    return [table, rows.map((row) => canonicalSettingsBackupJson(row)).sort()];
  }));
}

test("v1 staging is deterministic, applies schema defaults, and generic merge preserves runtime fields", () => {
  seedBaseline();
  const original = snapshot();
  const older = resign(original, (body) => {
    const ui = body.domains.find((entry) => entry.domain === "ui")!;
    delete (ui.payload as Record<string, unknown>).richText;
    for (const domain of ["workflow-definitions", "workflow-versions"] as const) {
      const rows = body.domains.find((entry) => entry.domain === domain)!.payload as
        Array<Record<string, unknown>>;
      for (const row of rows) delete row.evidenceReadinessPolicy;
    }
  });
  assert.deepEqual(migrateSettingsBackupSnapshot(older), migrateSettingsBackupSnapshot(older));
  const first = stageSettingsBackupSnapshot(older);
  const second = stageSettingsBackupSnapshot(older);
  assert.equal(
    canonicalSettingsBackupJson(first.config.map((entry) => entry.mergedValue)),
    canonicalSettingsBackupJson(second.config.map((entry) => entry.mergedValue)),
  );
  const ui = first.config.find((entry) => entry.domain === "ui")!.settingPayload as Record<string, unknown>;
  assert.equal(typeof ui.richText, "boolean");
  assert.equal(first.workflows[0]?.evidenceReadinessPolicy, "off");
  assert.equal(first.workflowVersions[0]?.evidenceReadinessPolicy, "off");

  const synthetic = {
    key: "synthetic",
    schema: z.object({ selected: z.string().default("automatic"), generation: z.number().default(0) }),
    snapshotVersion: 1,
    capture: "generic",
    backupDomain: "ui",
    classification: {
      kind: "fields",
      fields: { selected: "setting", generation: "derived" },
    },
  } satisfies AnyAppConfigEntry;
  assert.deepEqual(
    mergeSettingPayload(synthetic, { selected: "current", generation: 42 }, { selected: "old" }),
    { selected: "old", generation: 42 },
  );
});

test("preview is digest-bound and redacted, and preflight conflicts create no safety snapshot", async () => {
  seedBaseline();
  const root = join(home, "preflight");
  const store = new SettingsBackupStore(root);
  const original = snapshot();
  store.write(original);
  mutateCurrentState();
  const restore = service(root);
  const preview = restore.previewRestore(original.id);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  assert.equal(preview.preview.personas.reactivated, 1);
  assert.equal(preview.preview.personas.archived, 1);
  assert.equal(preview.preview.workflowVersions.retained, 1);
  const redacted = JSON.stringify(preview);
  for (const secret of [
    "SECRET ORIGINAL GUIDANCE",
    "SECRET ORIGINAL PROMPT",
    "SECRET_ARGV",
    "SECRET_OVERRIDE",
    "/secret/repository",
    "/secret/allowlist",
  ]) assert.equal(redacted.includes(secret), false);

  const conflict = resign(original, (body) => {
    const rows = body.domains.find((entry) => entry.domain === "personas")!.payload as
      Array<Record<string, unknown>>;
    rows.push({ ...rows[0], id: "duplicate-id" });
    body.counts.personas += 1;
  });
  store.write(conflict);
  const blocked = restore.previewRestore(original.id);
  assert.equal(blocked.status, "preflight_blocked");
  const result = await restore.restore(original.id, conflict.digest);
  assert.equal(result.status, "preflight_blocked");
  assert.equal(readdirSync(root).some((name) => name.startsWith("pre-restore-")), false);
});

test("restore advances catalogs, preserves immutable history and every excluded table, then reconciles", async () => {
  seedBaseline();
  const root = join(home, "success");
  const store = new SettingsBackupStore(root);
  const original = snapshot();
  store.write(original);
  mutateCurrentState();
  db.prepare(`DELETE FROM workflow_versions WHERE id = ?`).run("version-one");

  const binding = workflowStore.insertBinding({
    id: "binding-current",
    workflowVersionId: "version-two",
    noteKey: "claude:current",
    sessionId: "session-current",
    sessionAgent: "claude",
    sessionName: "Current work",
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds: 2,
    now: 120,
  });
  workflowStore.createInitialSubmission(
    { id: "run-current", binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: "manual:current", now: 121 },
    { id: "submission-current", triggerSource: "manual", triggerKey: "manual:current", context: {}, evidence: {}, now: 121 },
  );
  const excludedBefore = dumpExcludedTables();
  const operationalBefore = {
    lease: getAppConfig(APP_CONFIG_ENTRIES.foremanLease),
    telemetry: getAppConfig(APP_CONFIG_ENTRIES.costTelemetryEnabledAt),
  };
  const calls: string[] = [];
  const registry = new Registry();
  const restore = service(root, {
    registry,
    reconcileSkills: () => calls.push("skills"),
    reconcileCost: () => {
      calls.push("cost");
      throw new Error("injected post-commit cost failure");
    },
  });
  const result = await restore.restore(original.id, original.digest);
  assert.equal(result.status, "restored");
  if (result.status !== "restored") return;
  assert.match(result.safetySnapshotId, /^pre-restore-/);
  assert.deepEqual(calls, ["skills", "cost"]);
  assert.match(result.warnings.join(" "), /post-commit cost failure/);

  const skills = SkillsConfigSchema.parse(getAppConfig(APP_CONFIG_ENTRIES.skills));
  assert.equal(skills.enabled, false);
  assert.deepEqual(skills.skills, { alpha: true });
  assert.equal(skills.generation, 99);
  assert.equal(skills.generationAt, 999);
  const away = AwayConfigSchema.parse(getAppConfig(APP_CONFIG_ENTRIES.away));
  assert.equal(away.detectStalls, true);
  assert.equal(away.stallWorkingMinutes, 5);
  assert.equal(away.away, true);
  assert.equal(away.awaySince, 555);
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.foremanLease), operationalBefore.lease);
  assert.deepEqual(getAppConfig(APP_CONFIG_ENTRIES.costTelemetryEnabledAt), operationalBefore.telemetry);

  const persona = workflowStore.getPersona("persona-one")!;
  assert.equal(persona.guidanceMarkdown, "# SECRET ORIGINAL GUIDANCE\n\nExact old bytes.\n");
  assert.equal(persona.archivedAt, null);
  assert.ok(persona.revision > 2);
  assert.notEqual(workflowStore.getPersona("persona-later")!.archivedAt, null);
  assert.equal(workflowStore.getSessionAction("action-one")!.promptMarkdown, "# SECRET ORIGINAL PROMPT\n\nDo it.\n");
  assert.notEqual(workflowStore.getSessionAction("action-later")!.archivedAt, null);
  assert.notEqual(workflowStore.getWorkflow("workflow-later")!.archivedAt, null);
  const restoredWorkflow = workflowStore.getWorkflow("workflow-one")!;
  assert.equal(restoredWorkflow.currentVersionId, "version-one");
  assert.equal(restoredWorkflow.evidenceReadinessPolicy, "off");
  assert.ok(restoredWorkflow.draftRevision > 2);
  assert.equal(
    workflowStore.listWorkflowVersions("workflow-one")
      .find((version) => version.id === "version-one")?.evidenceReadinessPolicy,
    "off",
  );
  assert.deepEqual(workflowStore.listWorkflowVersions("workflow-one").map((row) => row.id), [
    "version-two",
    "version-one",
  ]);
  assert.equal(workflowStore.getBinding("binding-current")!.workflowVersionId, "version-two");
  assert.equal(workflowStore.getRun("run-current")!.workflowVersionId, "version-two");
  assert.deepEqual(workflowStore.getWorkflowCommand("test")!.defaultCommand, ["SECRET_ARGV", "test"]);
  assert.deepEqual(dumpExcludedTables(), excludedBefore);
  assert.equal(registry.snapshot().personas.some((row) => row.id === "persona-one"), true);
  assert.equal(registry.snapshot().workflowSummaries.find((row) => row.id === "workflow-one")
    ?.currentVersionId, "version-one");
});

// The backup format reuses the shared graph schemas rather than describing workflows a second
// time, so a node's provider/model choice should ride along for free. "Should" is the word
// this test exists to remove: capture, canonical JSON, digest signing, staging and the merge
// are five separate passes over the same object, and a strip in any one of them would lose a
// published routing decision on the one day an operator most needs it back.
test("a node execution override survives capture, signing and restore in draft and version", async () => {
  const routed = () => {
    const base = draft("persona-one");
    return {
      ...base,
      nodes: base.nodes.map((node) => node.kind === "persona"
        ? { ...node, executionOverride: { runner: "codex" as const, model: "gpt-5.6-sol" } }
        : node),
    };
  };
  assert.equal(workflowStore.insertPersona({
    id: "persona-one",
    name: "Persona One",
    normalizedName: normalizePersonaName("Persona One"),
    description: "Original Persona",
    guidanceMarkdown: "# Judge\n",
    runner: null,
    model: null,
    createdAt: 10,
    updatedAt: 10,
  }).ok, true);
  assert.equal(workflowStore.insertWorkflow({
    id: "workflow-one",
    name: "Workflow One",
    normalizedName: normalizeWorkflowName("Workflow One"),
    description: "Original workflow",
    draft: routed(),
    ...defaults,
    createdAt: 12,
    updatedAt: 12,
  }).ok, true);
  assert.equal(workflowStore.publishWorkflow("workflow-one", 1, "version-one", 13).ok, true);

  const root = join(home, "override-restore");
  const store = new SettingsBackupStore(root);
  const original = snapshot();
  store.write(original);

  // Take the choice away, both in the draft and in a newer published version.
  assert.equal(workflowStore.updateWorkflowCas("workflow-one", 1, {
    draft: draft("persona-one"),
  }, 100).ok, true);
  assert.equal(workflowStore.publishWorkflow("workflow-one", 2, "version-two", 101).ok, true);
  const strippedDraft = workflowStore.getWorkflow("workflow-one")!.draft.nodes
    .find((node) => node.kind === "persona")!;
  assert.equal(Object.hasOwn(strippedDraft, "executionOverride"), false);

  const result = await service(root, {}, store).restore(original.id, original.digest);
  assert.equal(result.status, "restored");

  const restoredDraft = workflowStore.getWorkflow("workflow-one")!.draft.nodes
    .find((node) => node.kind === "persona")!;
  assert.deepEqual(
    (restoredDraft as { executionOverride?: unknown }).executionOverride,
    { runner: "codex", model: "gpt-5.6-sol" },
  );
  const restoredVersion = workflowStore.getWorkflowVersion("workflow-one", 1)!.graph.nodes
    .find((node) => node.kind === "persona")!;
  assert.deepEqual(
    (restoredVersion as { executionOverride?: unknown }).executionOverride,
    { runner: "codex", model: "gpt-5.6-sol" },
  );
});

test("restore preview and mutation preserve installed built-in catalog rows", async () => {
  seedBaseline();
  const root = join(home, "builtins");
  const store = new SettingsBackupStore(root);
  const original = snapshot();
  store.write(original);
  const before = seedMaterializedBuiltins();
  const restore = service(root);

  const preview = restore.previewRestore(original.id);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  assert.equal(preview.preview.personas.archived, 0);
  assert.equal(preview.preview.sessionActions.archived, 0);
  assert.equal(preview.preview.workflows.archived, 0);

  const result = await restore.restore(original.id, original.digest);
  assert.equal(result.status, "restored");
  assert.equal(canonicalSettingsBackupJson({
    persona: db.prepare(`SELECT * FROM personas WHERE id = ?`).get(before.ids[0]),
    action: db.prepare(`SELECT * FROM session_actions WHERE id = ?`).get(before.ids[1]),
    workflow: db.prepare(`SELECT * FROM workflow_definitions WHERE id = ?`).get(before.ids[2]),
  }), before.rows);
});

test("a stale digest is refused before safety capture", async () => {
  seedBaseline();
  const root = join(home, "stale");
  const store = new SettingsBackupStore(root);
  const original = snapshot();
  store.write(original);
  const preview = service(root).previewRestore(original.id);
  assert.equal(preview.status, "ready");
  const changed = resign(original, (body) => { body.appVersion = "changed-after-preview"; });
  store.write(changed);
  const result = await service(root).restore(original.id, original.digest);
  assert.equal(result.status, "stale_digest");
  assert.equal(readdirSync(root).some((name) => name.startsWith("pre-restore-")), false);
});

test("safety failure prevents SQLite writes and durable failure rolls back while keeping safety", async () => {
  seedBaseline();
  const original = snapshot();

  const safetyRoot = join(home, "safety-failure");
  new SettingsBackupStore(safetyRoot).write(original);
  mutateCurrentState();
  const beforeSafetyFailure = canonicalSettingsBackupJson({
    skills: getAppConfig(APP_CONFIG_ENTRIES.skills),
    persona: workflowStore.getPersona("persona-one"),
  });
  const failingStore = new SettingsBackupStore(safetyRoot, {
    beforeRename: () => { throw new Error("injected safety failure"); },
  });
  const safetyResult = await service(safetyRoot, {}, failingStore).restore(original.id, original.digest);
  assert.equal(safetyResult.status, "io_error");
  assert.equal(canonicalSettingsBackupJson({
    skills: getAppConfig(APP_CONFIG_ENTRIES.skills),
    persona: workflowStore.getPersona("persona-one"),
  }), beforeSafetyFailure);

  clearWorkflowTables(db);
  db.exec("DELETE FROM app_config");
  seedBaseline();
  const rollbackRoot = join(home, "rollback");
  const rollbackStore = new SettingsBackupStore(rollbackRoot);
  rollbackStore.write(snapshot());
  mutateCurrentState();
  const beforeRollback = canonicalSettingsBackupJson({
    config: captureSettingsConfig(),
    catalogs: captureSettingsCatalogs(workflowStore),
  });
  const rollback = await service(rollbackRoot, {
    afterConfigRestore: () => { throw new Error("injected durable failure"); },
  }).restore("daily-2026-08-24", rollbackStore.read("daily-2026-08-24").status === "ready"
    ? (rollbackStore.read("daily-2026-08-24") as { snapshot: SettingsBackupEnvelopeV1 }).snapshot.digest
    : "");
  assert.equal(rollback.status, "restore_failed");
  assert.equal(canonicalSettingsBackupJson({
    config: captureSettingsConfig(),
    catalogs: captureSettingsCatalogs(workflowStore),
  }), beforeRollback);
  assert.equal(readdirSync(rollbackRoot).some((name) => name.startsWith("pre-restore-")), true);

  const finalValidation = await service(rollbackRoot, {
    beforeCommit: () => { throw new Error("injected final-validation failure"); },
  }).restore("daily-2026-08-24", (rollbackStore.read("daily-2026-08-24") as {
    snapshot: SettingsBackupEnvelopeV1;
  }).snapshot.digest);
  assert.equal(finalValidation.status, "restore_failed");
  assert.equal(canonicalSettingsBackupJson({
    config: captureSettingsConfig(),
    catalogs: captureSettingsCatalogs(workflowStore),
  }), beforeRollback);
});

test("duplicate identities, overrides, immutable tuples, pointers, and reused names fail preflight", () => {
  seedBaseline();
  const base = snapshot();
  mutateCurrentState();
  const cases: Array<(body: SettingsBackupEnvelopeBodyV1) => void> = [
    (body) => {
      const actions = body.domains.find((row) => row.domain === "session-actions")!.payload as
        Array<Record<string, unknown>>;
      actions.push({ ...actions[0], id: "action-copy" });
      body.counts.sessionActions += 1;
    },
    (body) => {
      const commands = body.domains.find((row) => row.domain === "workflow-commands")!.payload as
        Array<{ overrides: Array<Record<string, unknown>> }>;
      commands.find((row) => row.overrides.length > 0)!.overrides.push(
        { ...commands.find((row) => row.overrides.length > 0)!.overrides[0] },
      );
    },
    (body) => {
      const workflows = body.domains.find((row) => row.domain === "workflow-definitions")!.payload as
        Array<Record<string, unknown>>;
      workflows.push({ ...workflows[0], id: "workflow-copy" });
      body.counts.workflowDefinitions += 1;
    },
    (body) => {
      const version = (body.domains.find((row) => row.domain === "workflow-versions")!.payload as
        Array<Record<string, unknown>>)[0]!;
      version.id = "version-two";
      const workflow = (body.domains.find((row) => row.domain === "workflow-definitions")!.payload as
        Array<Record<string, unknown>>)[0]!;
      workflow.currentVersionId = "version-two";
    },
    (body) => {
      const version = (body.domains.find((row) => row.domain === "workflow-versions")!.payload as
        Array<Record<string, unknown>>)[0]!;
      version.version = 2;
    },
    (body) => {
      const version = (body.domains.find((row) => row.domain === "workflow-versions")!.payload as
        Array<Record<string, unknown>>)[0]!;
      version.sourceDraftRevision = 2;
    },
    (body) => {
      const workflow = (body.domains.find((row) => row.domain === "workflow-definitions")!.payload as
        Array<Record<string, unknown>>)[0]!;
      workflow.currentVersionId = "missing-version";
    },
    (body) => {
      const workflow = (body.domains.find((row) => row.domain === "workflow-definitions")!.payload as
        Array<Record<string, unknown>>)[0]!;
      workflow.id = "old-workflow-id";
      workflow.normalizedName = normalizeWorkflowName("Workflow Later");
    },
  ];
  cases.forEach((mutate, index) => {
    const root = join(home, `conflict-${index}`);
    new SettingsBackupStore(root).write(resign(base, mutate));
    assert.equal(service(root).previewRestore(base.id).status, "preflight_blocked");
  });
});

test("bulk Registry replacement emits no per-row burst and a concurrent restore is refused", async () => {
  seedBaseline();
  const registry = new Registry();
  registry.initializePersonas(workflowStore.personaCatalog().map((row) => personaView(row)));
  registry.initializeSessionActions(workflowStore.sessionActionCatalog());
  registry.initializeWorkflowCommands(workflowStore.workflowCommandCatalog());
  registry.initializeWorkflows(workflowStore.workflowCatalog().map((row) => workflowStore.summary(row)));
  const events: unknown[] = [];
  registry.on("event", (event) => events.push(event));
  registry.replaceSettingsCatalogs({ personas: [], sessionActions: [], workflowCommands: [], workflows: [] });
  assert.deepEqual(events, []);
  assert.deepEqual(registry.snapshot().personas, []);
  assert.deepEqual(registry.snapshot().sessionActions, []);
  assert.deepEqual(registry.snapshot().workflowCommands, []);
  assert.deepEqual(registry.snapshot().workflowSummaries, []);

  const root = join(home, "mutex");
  const original = snapshot();
  new SettingsBackupStore(root).write(original);
  const restore = service(root);
  const first = restore.restore(original.id, original.digest);
  const second = await restore.restore(original.id, original.digest);
  assert.equal(second.status, "in_progress");
  assert.equal((await first).status, "restored");
});

test("Cost preflight is read-only and startup reconciliation is idempotent", () => {
  writeFileSync(process.env.CLAUDE_SETTINGS_PATH!, "{ invalid");
  assert.throws(() => preflightCostReconcile(), /not valid JSON\/JSONC/);
  assert.equal(readFileSync(process.env.CLAUDE_SETTINGS_PATH!, "utf8"), "{ invalid");

  writeFileSync(process.env.CLAUDE_SETTINGS_PATH!, "{}\n");
  setAppConfig(APP_CONFIG_ENTRIES.cost, CostConfigSchema.parse({ enabled: false }));
  assert.equal(reconcileCostTelemetry(), "unchanged");
  const first = readFileSync(process.env.CLAUDE_SETTINGS_PATH!, "utf8");
  assert.equal(reconcileCostTelemetry(), "unchanged");
  assert.equal(readFileSync(process.env.CLAUDE_SETTINGS_PATH!, "utf8"), first);
});

test("Skills preflight refuses known blockers and startup reconciliation retries idempotently", () => {
  const dirs = ["claude", "codex", "pi"].map((name) => join(home, `skills-${name}`));
  [process.env.CLAUDE_SKILLS_DIR, process.env.CODEX_SKILLS_DIR, process.env.PI_SKILLS_DIR] = dirs;
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const blocked = join(dirs[0]!, "mission-pull-request");
  mkdirSync(blocked);
  const desired = SkillsConfigSchema.parse({
    enabled: true,
    skills: { "pull-request": true },
    generation: 0,
    generationAt: 0,
  });
  assert.ok(preflightSkillsReconcile(desired).length > 0);

  rmSync(blocked, { recursive: true });
  setAppConfig(APP_CONFIG_ENTRIES.skills, desired);
  const first = reconcileSkills(100);
  assert.equal(first.changed, true);
  assert.equal(first.config.generation, 1);
  const second = reconcileSkills(200);
  assert.equal(second.changed, false);
  assert.equal(second.config.generation, 1);
});
