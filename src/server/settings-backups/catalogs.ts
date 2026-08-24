import { z } from "zod";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import {
  PersonaGuidanceSchema,
  PersonaProvenanceSchema,
  PublishedWorkflowGraphSchema,
  SessionActionCompletionSchema,
  SessionActionPromptSchema,
  SessionActionSkillIdSchema,
  WorkflowBindingDefaultsSchema,
  WorkflowCommandArgvSchema,
  WorkflowCommandOverrideSchema,
  WorkflowCompletionPolicySchema,
  WorkflowDraftGraphSchema,
  WorkflowResumptionPolicySchema,
} from "@shared/protocol.ts";
import {
  SETTINGS_BACKUP_LIMITS,
  SettingsBackupCountsSchema,
} from "@shared/settings-backups.ts";
import type { SettingsBackupDomainId } from "@shared/settings-backup-domains.ts";
import { WORKFLOW_CHECK_SLOTS } from "@shared/workflow.ts";
import type { WorkflowStore } from "../workflows/store.ts";

const id = z.string().min(1).max(200);
const name = z.string().min(1).max(200);
const normalizedName = z.string().min(1).max(200);
const description = z.string().max(10_000);
const model = z.string().min(1).max(200);
const timestamp = z.number().int().nonnegative();
const archivedAt = timestamp.nullable();
const catalog = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  z.array(schema).max(SETTINGS_BACKUP_LIMITS.entriesPerCatalog);

export const SettingsBackupPersonaSchema = z.object({
  id,
  name,
  normalizedName,
  description,
  guidanceMarkdown: PersonaGuidanceSchema,
  runner: z.enum(LLM_RUNNER_IDS).nullable(),
  model: model.nullable(),
  revision: z.number().int().positive(),
  archivedAt,
  createdAt: timestamp,
  updatedAt: timestamp,
  provenance: PersonaProvenanceSchema.nullable(),
  builtin: z.literal(false),
}).strict();

export const SettingsBackupSessionActionSchema = z.object({
  id,
  name,
  normalizedName,
  description,
  promptMarkdown: SessionActionPromptSchema,
  requiredSkillId: SessionActionSkillIdSchema.nullable(),
  completion: SessionActionCompletionSchema,
  revision: z.number().int().positive(),
  archivedAt,
  createdAt: timestamp,
  updatedAt: timestamp,
  builtin: z.literal(false),
}).strict();

export const SettingsBackupWorkflowCommandSchema = z.object({
  slot: z.enum(WORKFLOW_CHECK_SLOTS),
  defaultCommand: WorkflowCommandArgvSchema.nullable(),
  overrides: z.array(WorkflowCommandOverrideSchema),
  maxRuns: z.number().int().positive(),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();

export const SettingsBackupWorkflowDefinitionSchema = z.object({
  id,
  name,
  normalizedName,
  description,
  draft: WorkflowDraftGraphSchema,
  completionPolicy: WorkflowCompletionPolicySchema,
  resumptionPolicy: WorkflowResumptionPolicySchema,
  bindingDefaults: WorkflowBindingDefaultsSchema,
  draftRevision: z.number().int().positive(),
  currentVersionId: id.nullable(),
  archivedAt,
  createdAt: timestamp,
  updatedAt: timestamp,
  builtin: z.literal(false),
}).strict();

export const SettingsBackupWorkflowVersionSchema = z.object({
  id,
  workflowId: id,
  version: z.number().int().positive(),
  sourceDraftRevision: z.number().int().positive(),
  graph: PublishedWorkflowGraphSchema,
  completionPolicy: WorkflowCompletionPolicySchema,
  resumptionPolicy: WorkflowResumptionPolicySchema,
  bindingDefaults: WorkflowBindingDefaultsSchema,
  publishedAt: timestamp,
}).strict();

const SettingsBackupPersonasSchema = catalog(SettingsBackupPersonaSchema);
const SettingsBackupSessionActionsSchema = catalog(SettingsBackupSessionActionSchema);
const SettingsBackupWorkflowCommandsSchema = catalog(SettingsBackupWorkflowCommandSchema);
const SettingsBackupWorkflowDefinitionsSchema = catalog(SettingsBackupWorkflowDefinitionSchema);
const SettingsBackupWorkflowVersionsSchema = catalog(SettingsBackupWorkflowVersionSchema);

export interface SettingsCatalogBackupEntry {
  domain: SettingsBackupDomainId;
  version: 1;
  payload: unknown;
}

interface CatalogDescriptor {
  domain: SettingsBackupDomainId;
  version: 1;
  schema: z.ZodTypeAny;
  capture(store: WorkflowStore): unknown;
}

export const SETTINGS_BACKUP_CATALOGS = [
  {
    domain: "personas",
    version: 1,
    schema: SettingsBackupPersonasSchema,
    capture: (store: WorkflowStore) => store.listPersonas(true)
      .filter((persona) => !persona.builtin)
      .sort((left, right) => left.id.localeCompare(right.id)),
  },
  {
    domain: "session-actions",
    version: 1,
    schema: SettingsBackupSessionActionsSchema,
    capture: (store: WorkflowStore) => store.listSessionActions(true)
      .filter((action) => !action.builtin)
      .sort((left, right) => left.id.localeCompare(right.id)),
  },
  {
    domain: "workflow-commands",
    version: 1,
    schema: SettingsBackupWorkflowCommandsSchema,
    capture: (store: WorkflowStore) => [...store.workflowCommandCatalog()]
      .sort((left, right) => left.slot.localeCompare(right.slot)),
  },
  {
    domain: "workflow-definitions",
    version: 1,
    schema: SettingsBackupWorkflowDefinitionsSchema,
    capture: (store: WorkflowStore) => store.listWorkflows(true)
      .filter((workflow) => !workflow.builtin)
      .sort((left, right) => left.id.localeCompare(right.id)),
  },
  {
    domain: "workflow-versions",
    version: 1,
    schema: SettingsBackupWorkflowVersionsSchema,
    capture: (store: WorkflowStore) => store.listWorkflows(true)
      .filter((workflow) => !workflow.builtin)
      .flatMap((workflow) => store.listWorkflowVersions(workflow.id))
      .sort((left, right) => left.workflowId.localeCompare(right.workflowId)
        || left.version - right.version
        || left.id.localeCompare(right.id)),
  },
] as const satisfies readonly CatalogDescriptor[];

export function parseSettingsCatalogPayload(
  domain: SettingsBackupDomainId,
  value: unknown,
): unknown {
  const descriptor = SETTINGS_BACKUP_CATALOGS.find((candidate) => candidate.domain === domain);
  if (!descriptor) throw new TypeError(`No settings backup catalog for ${domain}`);
  return descriptor.schema.parse(value);
}

export function captureSettingsCatalogs(store: WorkflowStore): SettingsCatalogBackupEntry[] {
  return SETTINGS_BACKUP_CATALOGS.map((descriptor) => ({
    domain: descriptor.domain,
    version: descriptor.version,
    payload: descriptor.schema.parse(descriptor.capture(store)),
  }));
}

type SettingsBackupCounts = z.infer<typeof SettingsBackupCountsSchema>;

export function settingsCatalogCounts(entries: readonly SettingsCatalogBackupEntry[]): SettingsBackupCounts {
  const count = (domain: SettingsBackupDomainId): number => {
    const payload = entries.find((entry) => entry.domain === domain)?.payload;
    return Array.isArray(payload) ? payload.length : 0;
  };
  return {
    personas: count("personas"),
    sessionActions: count("session-actions"),
    workflowCommands: count("workflow-commands"),
    workflowDefinitions: count("workflow-definitions"),
    workflowVersions: count("workflow-versions"),
  };
}
