import type { CostConfig, SkillsConfig } from "@shared/protocol.ts";
import type { SettingsBackupDomainId } from "@shared/settings-backup-domains.ts";
import {
  canonicalSettingsBackupJson,
  SETTINGS_BACKUP_LIMITS,
  SettingsRestorePreviewSchema,
  type SettingsBackupEnvelopeV1,
  type SettingsRestorePreview,
} from "@shared/settings-backups.ts";
import { WORKFLOW_CHECK_SLOTS } from "@shared/workflow.ts";
import type {
  Persona,
  SessionAction,
  WorkflowCommandView,
  WorkflowDefinition,
} from "@shared/workflow.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import {
  SETTINGS_BACKUP_CATALOGS,
  SettingsBackupPersonaSchema,
  SettingsBackupSessionActionSchema,
  SettingsBackupWorkflowCommandSchema,
  SettingsBackupWorkflowDefinitionSchema,
  SettingsBackupWorkflowVersionSchema,
  parseSettingsCatalogPayload,
  type SettingsBackupPersona,
  type SettingsBackupSessionAction,
  type SettingsBackupWorkflowCommand,
  type SettingsBackupWorkflowDefinition,
  type SettingsBackupWorkflowVersion,
} from "./catalogs.ts";
import {
  SETTINGS_CONFIG_BACKUP_ENTRIES,
  parseSettingPayload,
  stageSettingsConfigRestore,
  type StagedSettingsConfigRestore,
} from "./config-registry.ts";
import { validateSettingsBackupDomains } from "./format.ts";

export interface MigratedSettingsBackup {
  snapshot: SettingsBackupEnvelopeV1;
  settings: Map<SettingsBackupDomainId, unknown>;
  personas: SettingsBackupPersona[];
  sessionActions: SettingsBackupSessionAction[];
  workflowCommands: SettingsBackupWorkflowCommand[];
  workflows: SettingsBackupWorkflowDefinition[];
  workflowVersions: SettingsBackupWorkflowVersion[];
}

export interface StagedSettingsBackup extends MigratedSettingsBackup {
  config: StagedSettingsConfigRestore[];
}

/**
 * Append-only migration dispatcher. V1 is the first published format, so its migration is
 * normalization through the current schemas and their historical defaults. A future reader
 * adds earlier-version steps here rather than rewriting evidence on disk.
 */
export function migrateSettingsBackupSnapshot(
  snapshot: SettingsBackupEnvelopeV1,
): MigratedSettingsBackup {
  validateSettingsBackupDomains(snapshot);
  const byDomain = new Map(snapshot.domains.map((entry) => [entry.domain, entry]));
  const settings = new Map<SettingsBackupDomainId, unknown>();
  for (const descriptor of SETTINGS_CONFIG_BACKUP_ENTRIES) {
    if (descriptor.backupDomain === null) throw new TypeError(`${descriptor.key} has no backup domain`);
    const entry = byDomain.get(descriptor.backupDomain);
    if (!entry) throw new TypeError(`Snapshot is missing domain ${descriptor.backupDomain}`);
    if (entry.version !== descriptor.snapshotVersion) {
      throw new TypeError(
        `Snapshot domain ${entry.domain} v${entry.version} has no deterministic migration`,
      );
    }
    settings.set(entry.domain, parseSettingPayload(descriptor, entry.payload));
  }
  for (const descriptor of SETTINGS_BACKUP_CATALOGS) {
    const entry = byDomain.get(descriptor.domain);
    if (!entry) throw new TypeError(`Snapshot is missing domain ${descriptor.domain}`);
    if (entry.version !== descriptor.version) {
      throw new TypeError(
        `Snapshot domain ${entry.domain} v${entry.version} has no deterministic migration`,
      );
    }
    parseSettingsCatalogPayload(entry.domain, entry.payload);
  }
  const payload = (domain: SettingsBackupDomainId): unknown => byDomain.get(domain)?.payload;
  return {
    snapshot,
    settings,
    personas: SettingsBackupPersonaSchema.array().parse(payload("personas")),
    sessionActions: SettingsBackupSessionActionSchema.array().parse(payload("session-actions")),
    workflowCommands: SettingsBackupWorkflowCommandSchema.array().parse(payload("workflow-commands")),
    workflows: SettingsBackupWorkflowDefinitionSchema.array().parse(payload("workflow-definitions")),
    workflowVersions: SettingsBackupWorkflowVersionSchema.array().parse(payload("workflow-versions")),
  };
}

/** Add current-state config merges only after the pure migration boundary has completed. */
export function stageSettingsBackupSnapshot(
  snapshot: SettingsBackupEnvelopeV1,
): StagedSettingsBackup {
  const migrated = migrateSettingsBackupSnapshot(snapshot);
  return { ...migrated, config: stageSettingsConfigRestore(migrated.settings) };
}

export interface SettingsRestorePreflightDeps {
  skills(config: SkillsConfig): readonly string[];
  cost(config: CostConfig): void;
}

function bounded(message: string): string {
  return message.slice(0, SETTINGS_BACKUP_LIMITS.errorCharacters);
}

function duplicateValues<T>(
  rows: readonly T[],
  value: (row: T) => string | number | null,
  label: string,
): string[] {
  const seen = new Set<string | number>();
  const out: string[] = [];
  for (const row of rows) {
    const item = value(row);
    if (item === null) continue;
    if (seen.has(item)) out.push(`Duplicate ${label}: ${item}`);
    seen.add(item);
  }
  return out;
}

function keyedDuplicates<T>(
  rows: readonly T[],
  value: (row: T) => string,
  label: string,
): string[] {
  return duplicateValues(rows, value, label);
}

function canonical(value: unknown): string {
  return canonicalSettingsBackupJson(value);
}

function personaContent(value: Persona | SettingsBackupPersona): unknown {
  const {
    id: _id, revision: _revision, archivedAt: _archivedAt, createdAt: _createdAt,
    updatedAt: _updatedAt, builtin: _builtin, ...content
  } = value;
  return content;
}

function actionContent(value: SessionAction | SettingsBackupSessionAction): unknown {
  const {
    id: _id, revision: _revision, archivedAt: _archivedAt, createdAt: _createdAt,
    updatedAt: _updatedAt, builtin: _builtin, ...content
  } = value;
  return content;
}

function commandContent(value: WorkflowCommandView | SettingsBackupWorkflowCommand): unknown {
  const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = value;
  return content;
}

function workflowContent(value: WorkflowDefinition | SettingsBackupWorkflowDefinition): unknown {
  const {
    id: _id, draftRevision: _draftRevision, archivedAt: _archivedAt,
    createdAt: _createdAt, updatedAt: _updatedAt, builtin: _builtin, ...content
  } = value;
  return content;
}

function catalogChanges<
  Current extends { id: string; archivedAt: number | null },
  Staged extends { id: string; archivedAt: number | null },
>(
  current: readonly Current[],
  staged: readonly Staged[],
  content: (value: Current | Staged) => unknown,
): SettingsRestorePreview["personas"] {
  const currentById = new Map(current.map((row) => [row.id, row]));
  const stagedIds = new Set(staged.map((row) => row.id));
  let added = 0;
  let changed = 0;
  let archived = 0;
  let reactivated = 0;
  for (const row of staged) {
    const before = currentById.get(row.id);
    if (!before) {
      added += 1;
      continue;
    }
    if (canonical(content(before)) !== canonical(content(row))) changed += 1;
    if (before.archivedAt === null && row.archivedAt !== null) archived += 1;
    if (before.archivedAt !== null && row.archivedAt === null) reactivated += 1;
  }
  for (const row of current) {
    if (!stagedIds.has(row.id) && row.archivedAt === null) archived += 1;
  }
  return { added, changed, archived, reactivated };
}

function identityBlockers<T extends { id: string; normalizedName: string }>(
  kind: string,
  staged: readonly T[],
  currentOperators: readonly T[],
  builtins: readonly T[],
): string[] {
  const out = [
    ...keyedDuplicates(staged, (row) => row.id, `${kind} id`),
    ...keyedDuplicates(staged, (row) => row.normalizedName, `${kind} normalized name`),
  ];
  const currentById = new Map(currentOperators.map((row) => [row.id, row]));
  const currentByName = new Map(currentOperators.map((row) => [row.normalizedName, row]));
  const builtinById = new Map(builtins.map((row) => [row.id, row]));
  const builtinByName = new Map(builtins.map((row) => [row.normalizedName, row]));
  for (const row of staged) {
    if (builtinById.has(row.id)) out.push(`${kind} id ${row.id} belongs to a built-in`);
    const currentNamed = currentByName.get(row.normalizedName);
    if (currentNamed && currentNamed.id !== row.id) {
      out.push(`${kind} name ${row.normalizedName} belongs to current id ${currentNamed.id}`);
    }
    const builtinNamed = builtinByName.get(row.normalizedName);
    const sameLegacyIdentity = currentById.get(row.id)?.normalizedName === row.normalizedName;
    if (builtinNamed && !sameLegacyIdentity) {
      out.push(`${kind} name ${row.normalizedName} belongs to a built-in`);
    }
  }
  return out;
}

function configValue<T>(staged: StagedSettingsBackup, domain: SettingsBackupDomainId): T {
  const entry = staged.config.find((item) => item.domain === domain);
  if (!entry) throw new TypeError(`Snapshot is missing merged config ${domain}`);
  return entry.mergedValue as T;
}

/** Validate the complete staged catalog and compute the deliberately redacted preview. */
export function preflightSettingsRestore(
  store: WorkflowStore,
  staged: StagedSettingsBackup,
  deps: SettingsRestorePreflightDeps,
): SettingsRestorePreview {
  const blockers: string[] = [];
  const currentPersonas = store.personaCatalog();
  const currentActions = store.sessionActionCatalog();
  const currentWorkflows = store.workflowCatalog();
  const builtinPersonas = currentPersonas.filter((row) => row.builtin);
  const builtinActions = currentActions.filter((row) => row.builtin);
  const builtinWorkflows = currentWorkflows.filter((row) => row.builtin);
  const builtinPersonaIds = new Set(builtinPersonas.map((row) => row.id));
  const builtinActionIds = new Set(builtinActions.map((row) => row.id));
  const builtinWorkflowIds = new Set(builtinWorkflows.map((row) => row.id));
  const operatorPersonas = currentPersonas.filter(
    (row) => !row.builtin && !builtinPersonaIds.has(row.id),
  );
  const operatorActions = currentActions.filter(
    (row) => !row.builtin && !builtinActionIds.has(row.id),
  );
  const operatorWorkflows = currentWorkflows.filter(
    (row) => !row.builtin && !builtinWorkflowIds.has(row.id),
  );

  blockers.push(...identityBlockers(
    "Persona",
    staged.personas,
    operatorPersonas as SettingsBackupPersona[],
    builtinPersonas as SettingsBackupPersona[],
  ));
  blockers.push(...identityBlockers(
    "Session Action",
    staged.sessionActions,
    operatorActions as SettingsBackupSessionAction[],
    builtinActions as SettingsBackupSessionAction[],
  ));
  blockers.push(...identityBlockers(
    "workflow",
    staged.workflows,
    operatorWorkflows as SettingsBackupWorkflowDefinition[],
    builtinWorkflows as SettingsBackupWorkflowDefinition[],
  ));

  blockers.push(...keyedDuplicates(staged.workflowCommands, (row) => row.slot, "Command slot"));
  const expectedSlots = new Set<string>(WORKFLOW_CHECK_SLOTS);
  for (const command of staged.workflowCommands) {
    expectedSlots.delete(command.slot);
    blockers.push(...keyedDuplicates(
      command.overrides,
      (row) => row.repoRoot,
      `${command.slot} Command override`,
    ));
  }
  if (expectedSlots.size > 0) blockers.push(`Snapshot is missing Command slots: ${[...expectedSlots].join(", ")}`);

  blockers.push(
    ...keyedDuplicates(staged.workflowVersions, (row) => row.id, "workflow version id"),
    ...keyedDuplicates(
      staged.workflowVersions,
      (row) => `${row.workflowId}\0${row.version}`,
      "workflow version number",
    ),
    ...keyedDuplicates(
      staged.workflowVersions,
      (row) => `${row.workflowId}\0${row.sourceDraftRevision}`,
      "workflow source draft revision",
    ),
    ...keyedDuplicates(
      staged.workflows.filter((row) => row.currentVersionId !== null),
      (row) => row.currentVersionId ?? "",
      "workflow current-version pointer",
    ),
  );

  const stagedWorkflowById = new Map(staged.workflows.map((row) => [row.id, row]));
  const stagedVersionById = new Map(staged.workflowVersions.map((row) => [row.id, row]));
  const stagedPersonas = [
    ...staged.personas,
    ...builtinPersonas,
  ];
  const stagedActions = [
    ...staged.sessionActions,
    ...builtinActions,
  ];
  for (const workflow of staged.workflows) {
    const validation = store.validateDraft(workflow, {
      personas: stagedPersonas,
      sessionActions: stagedActions,
    });
    for (const diagnostic of validation.diagnostics.filter((item) => item.severity === "error")) {
      blockers.push(`Workflow ${workflow.id} draft is invalid: ${diagnostic.message}`);
    }
    if (workflow.currentVersionId !== null) {
      const version = stagedVersionById.get(workflow.currentVersionId);
      if (!version || version.workflowId !== workflow.id) {
        blockers.push(`Workflow ${workflow.id} current version does not resolve inside the snapshot`);
      }
    }
  }
  for (const version of staged.workflowVersions) {
    if (!stagedWorkflowById.has(version.workflowId)) {
      blockers.push(`Workflow version ${version.id} has no staged definition`);
    }
  }

  const currentVersions = operatorWorkflows.flatMap((workflow) => store.listWorkflowVersions(workflow.id));
  const byVersionId = new Map(currentVersions.map((row) => [row.id, row]));
  const byNumber = new Map(currentVersions.map((row) => [`${row.workflowId}\0${row.version}`, row]));
  const byDraft = new Map(currentVersions.map((row) => [
    `${row.workflowId}\0${row.sourceDraftRevision}`,
    row,
  ]));
  let inserted = 0;
  let retained = 0;
  for (const version of staged.workflowVersions) {
    const sameId = store.getWorkflowVersionById(version.id);
    if (sameId) {
      retained += 1;
      if (canonical(sameId) !== canonical(version)) {
        blockers.push(`Workflow version id ${version.id} has different immutable bytes`);
      }
    } else {
      inserted += 1;
    }
    const sameNumber = byNumber.get(`${version.workflowId}\0${version.version}`);
    if (sameNumber && sameNumber.id !== version.id) {
      blockers.push(`Workflow ${version.workflowId} version ${version.version} belongs to ${sameNumber.id}`);
    }
    const sameDraft = byDraft.get(`${version.workflowId}\0${version.sourceDraftRevision}`);
    if (sameDraft && sameDraft.id !== version.id) {
      blockers.push(
        `Workflow ${version.workflowId} source revision ${version.sourceDraftRevision} belongs to ${sameDraft.id}`,
      );
    }
    const idRow = byVersionId.get(version.id);
    if (idRow && canonical(idRow) !== canonical(version)) {
      blockers.push(`Workflow version ${version.id} conflicts with current history`);
    }
  }

  const policy = configValue<{ defaultWorkflowId: string | null }>(staged, "workflow-policy");
  if (policy.defaultWorkflowId !== null) {
    const selected = stagedWorkflowById.get(policy.defaultWorkflowId)
      ?? currentWorkflows.find((row) => row.builtin && row.id === policy.defaultWorkflowId);
    if (!selected || selected.archivedAt !== null || selected.currentVersionId === null) {
      blockers.push(`Default workflow ${policy.defaultWorkflowId} is not a live published staged workflow`);
    }
  }

  try {
    blockers.push(...deps.skills(configValue<SkillsConfig>(staged, "skills")));
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  try {
    deps.cost(configValue<CostConfig>(staged, "cost"));
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  const currentCommands = store.workflowCommandCatalog();
  const commandBySlot = new Map(currentCommands.map((row) => [row.slot, row]));
  const workflowCommandsChanged = staged.workflowCommands.filter((row) => {
    const current = commandBySlot.get(row.slot);
    return !current || canonical(commandContent(current)) !== canonical(commandContent(row));
  }).length;
  const changedDomains = staged.config.filter((item) => item.changed).map((item) => item.domain);
  const externalEffects = ["skills", "cost"] as const;

  return SettingsRestorePreviewSchema.parse({
    snapshotId: staged.snapshot.id,
    digest: staged.snapshot.digest,
    settingsDomains: changedDomains.sort(),
    personas: catalogChanges(operatorPersonas, staged.personas, personaContent),
    sessionActions: catalogChanges(operatorActions, staged.sessionActions, actionContent),
    workflowCommandsChanged,
    workflows: catalogChanges(operatorWorkflows, staged.workflows, workflowContent),
    workflowVersions: { inserted, retained },
    externalEffects,
    exclusions: [
      "Tasks, sessions, schedules, worktrees, and goals remain current",
      "Bindings, runs, attempts, reviews, usage, leases, projections, and ledgers remain current",
      "Built-in catalogs and credentials come from the installed application and environment",
    ],
    warnings: [],
    blockers: [...new Set(blockers.map(bounded))].slice(0, SETTINGS_BACKUP_LIMITS.previewItems),
  });
}
