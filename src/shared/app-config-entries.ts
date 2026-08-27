import { z } from "zod";
import {
  AwayConfigSchema,
  BacklogPlanSchema,
  CostConfigSchema,
  ForemanConfigSchema,
  HarnessesConfigSchema,
  InspectorConfigSchema,
  LlmConfigSchema,
  ShippingConfigSchema,
  SkillsConfigSchema,
  StandingInstructionsConfigSchema,
  StoredWorkflowPolicySchema,
  UiConfigSchema,
  WorktreesConfigSchema,
} from "./protocol.ts";
import type {
  AwayConfig,
  CostConfig,
  ForemanConfig,
  HarnessesConfig,
  InspectorConfig,
  LlmConfig,
  ShippingConfig,
  SkillsConfig,
  UiConfig,
  WorktreesConfig,
} from "./protocol.ts";
import { PipelinesConfigSchema, type PipelinesConfig } from "./pipeline.ts";
import { TaskSourcesConfigSchema, type TaskSourcesConfig } from "./task-source.ts";
import type { StandingInstructionsConfig } from "./standing-instructions.ts";
import type { WorkflowPolicy } from "./workflow.ts";
import type { SettingsBackupDomainId } from "./settings-backup-domains.ts";

export const APP_CONFIG_VALUE_CLASSES = ["setting", "derived", "operational"] as const;
export type AppConfigValueClass = (typeof APP_CONFIG_VALUE_CLASSES)[number];

export type AppConfigCaptureKind =
  | "generic"
  | "away"
  | "harnesses"
  | "foreman"
  | "ui"
  | "standing";

interface AppConfigEntryBase<Key extends string, Schema extends z.ZodTypeAny> {
  key: Key;
  schema: Schema;
  /** Version of this entry's logical snapshot meaning, independent from SQLite. */
  snapshotVersion: 1;
  capture: AppConfigCaptureKind;
}

export interface AppConfigWholeEntry<
  Key extends string = string,
  Schema extends z.ZodTypeAny = z.ZodTypeAny,
> extends AppConfigEntryBase<Key, Schema> {
  classification: { kind: "whole"; valueClass: AppConfigValueClass };
  backupDomain: SettingsBackupDomainId | null;
}

export interface AppConfigFieldsEntry<
  Key extends string = string,
  Schema extends z.ZodTypeAny = z.ZodTypeAny,
> extends AppConfigEntryBase<Key, Schema> {
  classification: {
    kind: "fields";
    fields: Record<keyof z.output<Schema>, AppConfigValueClass>;
  };
  backupDomain: SettingsBackupDomainId;
}

export type AnyAppConfigEntry = AppConfigWholeEntry | AppConfigFieldsEntry;

function fieldsEntry<
  const Key extends string,
  Schema extends z.ZodTypeAny,
>(
  key: Key,
  schema: Schema,
  backupDomain: SettingsBackupDomainId,
  fields: Record<keyof z.output<Schema>, AppConfigValueClass>,
  capture: AppConfigCaptureKind = "generic",
): AppConfigFieldsEntry<Key, Schema> {
  return {
    key,
    schema,
    snapshotVersion: 1,
    backupDomain,
    classification: { kind: "fields", fields },
    capture,
  };
}

function wholeEntry<
  const Key extends string,
  Schema extends z.ZodTypeAny,
>(
  key: Key,
  schema: Schema,
  valueClass: AppConfigValueClass,
  backupDomain: SettingsBackupDomainId | null,
): AppConfigWholeEntry<Key, Schema> {
  return {
    key,
    schema,
    snapshotVersion: 1,
    backupDomain,
    classification: { kind: "whole", valueClass },
    capture: "generic",
  };
}

const harnessesFields = {
  autoModeOnDispatch: "setting",
  defaultModel: "setting",
  defaultEffort: "setting",
  sessionRuntime: "setting",
  kindDefaults: "setting",
} satisfies Record<keyof HarnessesConfig, AppConfigValueClass>;

const worktreesFields = {
  enabled: "setting",
  maxSlots: "setting",
  repositories: "setting",
} satisfies Record<keyof WorktreesConfig, AppConfigValueClass>;

const skillsFields = {
  enabled: "setting",
  skills: "setting",
  generation: "derived",
  generationAt: "derived",
} satisfies Record<keyof SkillsConfig, AppConfigValueClass>;

const costFields = {
  enabled: "setting",
  exportIntervalMs: "setting",
  view: "setting",
} satisfies Record<keyof CostConfig, AppConfigValueClass>;

const foremanFields = {
  runner: "setting",
  enabled: "setting",
  mode: "setting",
  repoAllowlist: "setting",
  autoApproveAccess: "setting",
  triage: "setting",
  triageModel: "setting",
  triageRunner: "setting",
  reviewModel: "setting",
  reviewRunner: "setting",
  verifyModel: "setting",
  verifyRunner: "setting",
  maxFixAttempts: "setting",
  maxFixRounds: "setting",
  skipScoutWrapup: "setting",
  skipReviewArtifactWrapup: "setting",
  wrapupTriggers: "setting",
  wrapup: "setting",
  trackReviewFeedback: "setting",
  trackCiFailures: "setting",
  keepShipTasksMoving: "setting",
  shipRecoveryMinutes: "setting",
  autoBacklog: "setting",
  backlogRespectOpenPrs: "setting",
  backlogDefaultModel: "setting",
  maxSessions: "setting",
  backlogModel: "setting",
  backlogRunner: "setting",
} satisfies Record<keyof ForemanConfig, AppConfigValueClass>;

const workflowFields = {
  liveEnabled: "setting",
  repoAllowlist: "setting",
  defaultWorkflowId: "setting",
  retention: "setting",
  checksEnabled: "setting",
} satisfies Record<keyof WorkflowPolicy, AppConfigValueClass>;

const taskSourcesFields = {
  sources: "setting",
} satisfies Record<keyof TaskSourcesConfig, AppConfigValueClass>;

const llmFields = {
  runner: "setting",
  claudeTransport: "setting",
  codexTransport: "setting",
  models: "setting",
  runners: "setting",
} satisfies Record<keyof LlmConfig, AppConfigValueClass>;

const awayFields = {
  away: "operational",
  awaySince: "operational",
  detectStalls: "setting",
  stallWorkingMinutes: "setting",
  stallUnfinishedMinutes: "setting",
  stallEscalationMinutes: "setting",
} satisfies Record<keyof AwayConfig, AppConfigValueClass>;

const standingFields = {
  default: "setting",
  repositories: "setting",
} satisfies Record<keyof StandingInstructionsConfig, AppConfigValueClass>;

const inspectorFields = {
  runner: "setting",
  enabled: "setting",
  mode: "setting",
  repoAllowlist: "setting",
  model: "setting",
  maxCommentsPerRound: "setting",
} satisfies Record<keyof InspectorConfig, AppConfigValueClass>;

const shippingFields = {
  autoMerge: "setting",
  soakMinutes: "setting",
  method: "setting",
  repoAllowlist: "setting",
  closeSessionAfterMerge: "setting",
} satisfies Record<keyof ShippingConfig, AppConfigValueClass>;

const pipelinesFields = {
  enabled: "setting",
  launchRuntime: "setting",
  foremanMechanicalTriage: "setting",
  repos: "setting",
} satisfies Record<keyof PipelinesConfig, AppConfigValueClass>;

const uiFields = {
  layout: "setting",
  conversationView: "setting",
  lineDensity: "setting",
  keybindings: "setting",
  alerts: "setting",
  richText: "setting",
  keybindingHints: "setting",
  guidedDispatch: "setting",
  guidedTour: "setting",
  trustStaged: "setting",
  hiddenDisplayItems: "setting",
  groupBoardByRepo: "setting",
} satisfies Record<keyof UiConfig, AppConfigValueClass>;

const ForemanLeaseSchema = z.object({
  workerId: z.string(),
  expiresAt: z.number(),
});

const StoredBacklogPlanSchema = BacklogPlanSchema.extend({ generatedAt: z.number() });

/**
 * The complete supported `app_config` partition.
 *
 * Config owners import their descriptor from here for every read and write. The backup
 * service enumerates the same object, so there is no second inclusion list to forget.
 */
export const APP_CONFIG_ENTRIES = {
  harnesses: fieldsEntry(
    "harnesses", HarnessesConfigSchema, "harnesses", harnessesFields, "harnesses",
  ),
  worktrees: fieldsEntry("worktrees", WorktreesConfigSchema, "worktrees", worktreesFields),
  skills: fieldsEntry("skills", SkillsConfigSchema, "skills", skillsFields),
  cost: fieldsEntry("cost", CostConfigSchema, "cost", costFields),
  foreman: fieldsEntry("foreman", ForemanConfigSchema, "foreman", foremanFields, "foreman"),
  foremanInstructions: wholeEntry(
    "foreman.instructions",
    z.string().nullable().default(null),
    "setting",
    "foreman-instructions",
  ),
  workflows: fieldsEntry(
    "workflows", StoredWorkflowPolicySchema, "workflow-policy", workflowFields,
  ),
  taskSources: fieldsEntry(
    "taskSources", TaskSourcesConfigSchema, "task-sources", taskSourcesFields,
  ),
  llm: fieldsEntry("llm", LlmConfigSchema, "models", llmFields),
  away: fieldsEntry("away", AwayConfigSchema, "away", awayFields, "away"),
  standingInstructions: fieldsEntry(
    "instructions.standing",
    StandingInstructionsConfigSchema,
    "standing-instructions",
    standingFields,
    "standing",
  ),
  inspector: fieldsEntry("inspector", InspectorConfigSchema, "inspector", inspectorFields),
  shipping: fieldsEntry("shipping", ShippingConfigSchema, "shipping", shippingFields),
  pipelines: fieldsEntry("pipelines", PipelinesConfigSchema, "pipelines", pipelinesFields),
  ui: fieldsEntry("ui", UiConfigSchema, "ui", uiFields, "ui"),
  foremanLease: wholeEntry("foreman.lease", ForemanLeaseSchema, "operational", null),
  backlogPlan: wholeEntry("backlog.plan", StoredBacklogPlanSchema, "derived", null),
  costTelemetryEnabledAt: wholeEntry(
    "costTelemetryEnabledAt", z.number().nullable(), "derived", null,
  ),
  costOtelLastSeen: wholeEntry("costOtelLastSeen", z.number(), "operational", null),
} as const;

export type AppConfigEntry = (typeof APP_CONFIG_ENTRIES)[keyof typeof APP_CONFIG_ENTRIES];
export type AppConfigValue<Entry extends AppConfigEntry> = z.output<Entry["schema"]>;
export type AppConfigInput<Entry extends AppConfigEntry> = z.input<Entry["schema"]>;

export const APP_CONFIG_ENTRY_LIST: readonly AppConfigEntry[] = Object.values(APP_CONFIG_ENTRIES);

export function appConfigEntryHasSettings(entry: AppConfigEntry): boolean {
  if (entry.classification.kind === "whole") {
    return entry.classification.valueClass === "setting";
  }
  return Object.values(entry.classification.fields).includes("setting");
}
