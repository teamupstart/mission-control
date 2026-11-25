import { createHash } from "node:crypto";
import { z } from "zod";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { DISPLAY_ITEMS } from "@shared/board-card-settings.ts";
import { capabilitiesFor, resolveSessionRuntime } from "@shared/harness-capabilities.ts";
import { ACTIONS, bindingValidationError, resolveKeybindings } from "@shared/keyboard-settings.ts";
import { parseChord } from "@shared/keyboard-chords.ts";
import { FOREMAN_MODEL_ROLES } from "@shared/foreman-models.ts";
import { LLM_JOB_IDS, LLM_JOB_SPECS } from "@shared/llm-jobs.ts";
import { PAUSE_CARD_CONTROLS, PAUSE_CONSOLE_CONTROLS } from "@shared/pause.ts";
import {
  BackgroundAgentsStyleSchema, BlockedPlacementSchema, ConversationViewSchema, CostConfigPatchSchema,
  ForemanConfigPatchSchema, HarnessesConfigPatchSchema, InspectorConfigPatchSchema, LayoutModeSchema,
  LineDensitySchema, LlmConfigPatchSchema, ReportGuidanceUpdateSchema, ResidentPlacementSchema,
  ShippingConfigPatchSchema, SkillsConfigPatchSchema, TaskKindCardStyleSchema, TaskKindHeaderStyleSchema,
  TerminalsConfigPatchSchema, UiConfigPatchSchema, WorktreesConfigPatchSchema,
  type UiConfig,
} from "@shared/protocol.ts";
import { DatabaseBackupsConfigPatchSchema } from "@shared/database-backups.ts";
import { StorageLimitsConfigPatchSchema } from "@shared/storage-limits.ts";
import { EMULATOR_IDS, MULTIPLEXER_IDS } from "@shared/terminal.ts";
import { TOPBAR_ITEMS } from "@shared/topbar-items-settings.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import { HARNESS_LAUNCHED_TASK_KINDS, TASK_KIND_INFO } from "@shared/task.ts";
import { appConfigRevision } from "./db.ts";
import { BACKGROUND_REASONING_EFFORT_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { featureEnabled } from "./feature-flags/index.ts";
import { getCostConfig } from "./cost.ts";
import { getForemanConfig } from "./foreman/config.ts";
import { getHarnessesConfig } from "./harnesses.ts";
import { getInspectorConfig } from "./inspector/config.ts";
import { getLlmConfig } from "./llm/config.ts";
import { readReportGuidance, writeReportGuidance } from "./report-guidance.ts";
import { getShippingConfig } from "./shipping/config.ts";
import { getSkillsConfig } from "./skills/config.ts";
import { getTerminalsConfig, setTerminalsConfig } from "./terminals-config.ts";
import { getUiConfig, setUiConfig } from "./ui-config.ts";
import { getWorktreesConfig } from "./worktrees/config.ts";
import { getWorkflowPolicy, patchWorkflowPreferences, WorkflowPreferencesPatchSchema } from "./workflows/config.ts";
import { getDatabaseBackupsConfig } from "./database-backups/config.ts";
import { getStorageLimitsConfig } from "./storage-limits.ts";
import { binUnsupportedReason } from "./terminal/bin.ts";
import { EMULATORS, MULTIPLEXERS } from "./terminal/registry.ts";
import { InvalidSettingValue, type SettingDescriptor } from "./settings-dispatcher.ts";
import { bindTypedSettings, choices, field } from "./typed-settings.ts";

const effortEnabled = () => featureEnabled(BACKGROUND_REASONING_EFFORT_FLAG_ID);

type Apply<Schema extends z.ZodType, Read extends () => unknown> = (patch: z.output<Schema>) => ReturnType<Read>;

/** Application effects shared with the dashboard routes, assembled with the owning services. */
export interface SettingsOwners {
  harnesses: Apply<typeof HarnessesConfigPatchSchema, typeof getHarnessesConfig>;
  foreman: Apply<typeof ForemanConfigPatchSchema, typeof getForemanConfig>;
  inspector: Apply<typeof InspectorConfigPatchSchema, typeof getInspectorConfig>;
  llm: Apply<typeof LlmConfigPatchSchema, typeof getLlmConfig>;
  shipping: Apply<typeof ShippingConfigPatchSchema, typeof getShippingConfig>;
  skills: Apply<typeof SkillsConfigPatchSchema, typeof getSkillsConfig>;
  cost: Apply<typeof CostConfigPatchSchema, typeof getCostConfig>;
  worktrees?: Apply<typeof WorktreesConfigPatchSchema, typeof getWorktreesConfig>;
  storageLimits?: Apply<typeof StorageLimitsConfigPatchSchema, typeof getStorageLimitsConfig>;
  backups?: Apply<typeof DatabaseBackupsConfigPatchSchema, typeof getDatabaseBackupsConfig>;
}

function uiField(path: string, control: string, options?: Parameters<typeof field<UiConfig>>[3]) {
  return field<UiConfig>("ui", path, control, options);
}

function membership(
  path: keyof Pick<UiConfig, "hiddenDisplayItems" | "hiddenTopbarItems" | "compactTopbarItems"
    | "pauseCardControls" | "pauseConsoleControls" | "collapsedBoardColumns">,
  id: string, control: string, label: string, inverted = false,
) {
  return uiField(`${path}.${id}`, control, {
    label,
    read: config => config[path].includes(id) !== inverted,
    patch: (config, value) => {
      if (typeof value !== "boolean") throw new InvalidSettingValue();
      const without = config[path].filter(item => item !== id);
      return { [path]: value !== inverted ? [...without, id] : without };
    },
  });
}

// Board and Console share the same durable column ids. The expanded column is local to its window.
const boardColumns = ["backlog", "attention", "blocked", "working", "idle", "neutral", "exited"] as const;

const uiFields = [
  uiField("layout", "layout", { choices: choices(LayoutModeSchema.options) }),
  uiField("lineDensity", "line-density", {
    choices: choices(LineDensitySchema.options),
    patch: (config, value) => ({ lineDensity: value, lineHidden: config.lineHidden }),
  }),
  uiField("lineHidden", "line-density", { label: "Hide the Line" }),
  uiField("groupBoardByRepo", "board-grouping"),
  uiField("boardSidebarAllSessions", "board-sidebar"),
  uiField("residentPlacement", "resident-placement", { choices: choices(ResidentPlacementSchema.options) }),
  uiField("blockedPlacement", "blocked-placement", { choices: choices(BlockedPlacementSchema.options) }),
  uiField("conversationView", "conversation-view", { choices: choices(ConversationViewSchema.options) }),
  uiField("richText", "format-messages"),
  uiField("guidedDispatch", "guided-dispatch"),
  uiField("taskKindCard", "board-card", { label: "Task kind on cards", choices: choices(TaskKindCardStyleSchema.options) }),
  uiField("taskKindHeader", "conversation-header", { label: "Task kind in conversation header", choices: choices(TaskKindHeaderStyleSchema.options) }),
  uiField("backgroundAgentsStyle", "board-card", { label: "Background agents style", choices: choices(BackgroundAgentsStyleSchema.options) }),
  ...DISPLAY_ITEMS.map(item => membership("hiddenDisplayItems", item.id,
    item.group === "card" ? "board-card" : item.group === "conversation" ? "conversation-header" : "working-indicator",
    `Show ${item.label}`, true)),
  ...TOPBAR_ITEMS.map(item => item.kind === "optional"
    ? membership("hiddenTopbarItems", item.id, "topbar", `Show ${item.label} in the top bar`, true)
    : membership("compactTopbarItems", item.id, "topbar", `Compact ${item.label} in the top bar`)),
  ...PAUSE_CARD_CONTROLS.map(id => membership("pauseCardControls", id, "pause-controls", `Show card pause ${id}`)),
  ...PAUSE_CONSOLE_CONTROLS.map(id => membership("pauseConsoleControls", id, "pause-controls", `Show console pause ${id}`)),
  ...ACTIONS.map(({ id, defaultBinding }) => uiField(`keybindings.${id}`, `keyboard-${id}`, {
    read: config => resolveKeybindings(config.keybindings)[id],
    patch: (config, value) => {
      const next = { ...config.keybindings };
      if (value === null) {
        delete next[id];
      } else {
        if (typeof value !== "string" || !value || value.length > 64 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new InvalidSettingValue();
        const { mods, key } = parseChord(value);
        if (!key || new Set(mods).size !== mods.length || bindingValidationError(resolveKeybindings(next), id, value)) {
          throw new InvalidSettingValue();
        }
        if (value === defaultBinding) delete next[id];
        else next[id] = value;
      }
      return { keybindings: next };
    },
  })),
  uiField("keybindingHints", "keyboard-chrome", { label: "Show shortcut hints" }),
  uiField("residentDrawerPinned", "dashboard-chrome", { label: "Pin the residents drawer" }),
  uiField("conversationRailCollapsed", "dashboard-chrome", { label: "Collapse the conversation rail" }),
  uiField("blockedFrameCollapsed", "dashboard-chrome", { label: "Collapse the blocked frame" }),
  uiField("sessionRailFolded", "dashboard-chrome", { label: "Fold the session rail" }),
  ...boardColumns.map(id => membership("collapsedBoardColumns", id, "dashboard-chrome", `Collapse the ${id} column`)),
  ...(["notifications", "sound", "reportsInInbox"] as const).map(id =>
    uiField(`alerts.${id}`, "alert-preferences", {
      label: `Alerts: ${id}`,
      patch: (config, value) => ({ alerts: { ...config.alerts, [id]: value } }),
      available: id === "reportsInInbox" ? () => featureEnabled("inbox") : undefined,
    })),
  ...(["blockingQuestions", "filedQuestions", "reports", "stuck"] as const).map(id =>
    uiField(`alerts.notify.${id}`, "alert-preferences", {
      label: `Notifications: ${id}`,
      patch: (config, value) => ({ alerts: { ...config.alerts, notify: { ...config.alerts.notify, [id]: value } } }),
      available: () => featureEnabled("inbox"),
    })),
];

export function typedSettings(
  owners: SettingsOwners, changed?: (key: string) => void,
): () => readonly SettingDescriptor[] {
  const harnesses = bindTypedSettings({
    schema: HarnessesConfigPatchSchema, read: getHarnessesConfig, apply: owners.harnesses,
  }, [
    ...AGENT_TYPES.flatMap(agent => {
      const label = AGENT_IDENTITY[agent].label;
      const control = `harness-${agent}`;
      const caps = capabilitiesFor(agent);
      return [
        field("harnesses", `defaultModel.${agent}`, control, { label: `${label} default model` }),
        field("harnesses", `defaultEffort.${agent}`, control, {
          label: `${label} default effort`, choices: choices([null, ...(caps.effort?.levels ?? [])]),
        }),
        field<ReturnType<typeof getHarnessesConfig>>("harnesses", `sessionRuntime.${agent}`, control, {
          label: `${label} session runtime`, choices: choices(caps.runtimes),
          read: config => resolveSessionRuntime(agent, config.sessionRuntime[agent]).runtime,
        }),
        field("harnesses", `terminalBackend.${agent}`, control, {
          label: `${label} terminal backend`,
          available: () => resolveSessionRuntime(agent, getHarnessesConfig().sessionRuntime[agent]).runtime === "terminal",
        }),
        ...(caps.advisor ? [field("harnesses", `advisor.${agent}.default`, control, {
          label: `${label} default advisor`, choices: choices([null, ...caps.advisor.values]),
        })] : []),
      ];
    }),
    ...HARNESS_LAUNCHED_TASK_KINDS.flatMap(kind => ["agent", "model", "effort"].map(leaf =>
      field("harnesses", `kindDefaults.${kind}.${leaf}`, "task-kind-defaults", {
        label: `${TASK_KIND_INFO[kind].label} default ${leaf}`,
      }))),
  ]);
  const llm = bindTypedSettings({ schema: LlmConfigPatchSchema, read: getLlmConfig, apply: owners.llm, changed }, [
    ...["runner", "claudeTransport", "codexTransport"].map(id => field("llm", id, "llm-jobs", { label: `Background jobs: ${id}` })),
    ...LLM_JOB_IDS.flatMap(job => {
      const spec = LLM_JOB_SPECS[job];
      return ["models", "runners", "efforts"].filter(id =>
        !(id === "models" && spec.fixedModels) && !(id === "efforts" && spec.fixedThinking),
      ).map(id => field("llm", `${id}.${job}`, "llm-jobs", {
        label: `${job} ${id}`,
        available: () => (!spec.previewFlag || featureEnabled(spec.previewFlag)) && (id !== "efforts" || effortEnabled()),
      }));
    }),
  ]);
  const foreman = bindTypedSettings({
    schema: ForemanConfigPatchSchema, read: getForemanConfig, apply: owners.foreman, changed,
    revision: () => appConfigRevision(APP_CONFIG_ENTRIES.foreman),
  }, [
    field("foreman", "skipScoutWrapup", "foreman-skip-scout-wrapup"),
    field("foreman", "skipReviewArtifactWrapup", "foreman-skip-review-artifact-wrapup"),
    field("foreman", "shipRecoveryMinutes", "foreman-ship-recovery-minutes"),
    field("foreman", "wrapupTriggers", "foreman-tuning", { label: "Foreman wrap-up triggers", replacement: "composite" }),
    ...["triage", "maxFixAttempts", "maxFixRounds", "maxSessions"].map(id =>
      field("foreman", id, "foreman-tuning", { label: `Foreman ${id}` })),
    field("foreman", "runner", "foreman-models", { label: "Foreman default runner" }),
    ...FOREMAN_MODEL_ROLES.flatMap(role => [
      field("foreman", `${role}Model`, "foreman-models", { label: `Foreman ${role} model` }),
      field("foreman", `${role}Runner`, "foreman-models", { label: `Foreman ${role} runner` }),
      field("foreman", `efforts.${role}`, "foreman-models", { label: `Foreman ${role} effort`, available: effortEnabled }),
    ]),
    ...AGENT_TYPES.map(agent => field("foreman", `backlogDefaultModel.${agent}`, "foreman-models", {
      label: `Foreman backlog dispatch model for ${AGENT_IDENTITY[agent].label}`,
    })),
  ]);
  const skills = bindTypedSettings({
    schema: SkillsConfigPatchSchema, read: getSkillsConfig, apply: owners.skills, changed,
    revision: () => appConfigRevision(APP_CONFIG_ENTRIES.skills),
  }, [
    field("skills", "commitPlanHtml", "skills-plan-html"),
    field("skills", "alwaysDraftPr", "skills-always-draft-pr"),
    field("skills", "grillFirstKinds", "grill-first-defaults", { replacement: "composite" }),
  ]);
  const worktrees = owners.worktrees && { schema: WorktreesConfigPatchSchema, read: getWorktreesConfig, apply: owners.worktrees };

  const descriptors = [
    ...bindTypedSettings({ schema: UiConfigPatchSchema, read: () => getUiConfig(false), apply: setUiConfig, changed }, uiFields),
    ...harnesses, ...llm, ...foreman, ...skills,
    ...[
      ["wrapup", "Wrap-up action"],
      ["trackReviewFeedback", "Track review feedback"],
      ["trackCiFailures", "Track CI failures"],
      ["keepShipTasksMoving", "Keep Ship tasks moving"],
      ["autoBacklog", "Backlog autopilot"],
      ["backlogRespectOpenPrs", "Keep open pull requests out of autopilot"],
    ].map(([id, label]) => ({
      key: `foreman.${id}`, label: label!, keywords: ["automation", "Foreman"],
      access: "protected" as const, destination: "Settings > Foreman",
    })),
    ...bindTypedSettings({ schema: InspectorConfigPatchSchema, read: getInspectorConfig, apply: owners.inspector, changed }, [
      ...["runner", "model", "effort"].map(id => field("inspector", id, "review-model", {
        label: `Inspector ${id}`, available: id === "effort" ? effortEnabled : undefined,
      })),
      field("inspector", "maxCommentsPerRound", "inspector-tuning", { label: "Inspector maximum comments per round" }),
    ]),
    ...bindTypedSettings({ schema: ShippingConfigPatchSchema, read: getShippingConfig, apply: owners.shipping, changed }, [
      field("shipping", "soakMinutes", "soak"),
      field("shipping", "method", "merge-method"),
      field("shipping", "stacking", "stacked-pull-requests"),
      field("shipping", "maxStackDepth", "stacked-pull-requests", { label: "Maximum stack depth" }),
    ]),
    ...bindTypedSettings({ schema: TerminalsConfigPatchSchema, read: getTerminalsConfig, apply: setTerminalsConfig, changed }, [
      field("terminals", "externalSessions", "external-sessions"),
      ...MULTIPLEXER_IDS.filter(id => MULTIPLEXERS[id].sessions?.attachArgv).map(id => field("terminals", `multiplexerTerminal.${id}`, "multiplexer-terminal", {
        label: `Terminal app for ${MULTIPLEXERS[id].label}`,
        choices: choices([null, ...EMULATOR_IDS.filter(app => !binUnsupportedReason(EMULATORS[app].bin))]),
      })),
    ]),
    ...bindTypedSettings({ schema: CostConfigPatchSchema, read: getCostConfig, apply: owners.cost, changed }, [
      field("cost", "view", "cost-view"),
    ]),
    ...bindTypedSettings({ schema: ReportGuidanceUpdateSchema, read: readReportGuidance,
      changed, apply: ({ guidance }) => writeReportGuidance(guidance) }, [field("reports", "guidance", "reports-guidance")]),
    ...bindTypedSettings({ schema: WorkflowPreferencesPatchSchema, read: getWorkflowPolicy, apply: patchWorkflowPreferences, changed }, [
      field("workflows", "skipPassedJudges", "workflow-judge-passes"),
    ]),
    ...worktrees ? bindTypedSettings(worktrees, ["enabled", "taskRetentionDays", "maxSlots"].map(id =>
      field("worktrees", id, "worktree-policy", { label: `Worktrees ${id}` }))) : [],
    ...owners.storageLimits ? bindTypedSettings({
      schema: StorageLimitsConfigPatchSchema, read: getStorageLimitsConfig, apply: owners.storageLimits,
    }, ["limitBytes", "warnAtPercent", "freeFloorBytes", "fleetBanner", "desktopNotification", "poolIdleBudgetBytes", "poolKeepWarm"].map(id =>
      field("storage", id, id.startsWith("pool") ? "storage-pool-caches" : "storage-limits", { label: `Storage ${id}` }))) : [],
    ...owners.backups ? bindTypedSettings({
      schema: DatabaseBackupsConfigPatchSchema, read: getDatabaseBackupsConfig, apply: owners.backups,
    }, ["scheduledCount", "preMigrationCount", "intervalHours", "scheduledMaxAgeDays", "preMigrationMaxAgeDays", "maxTotalBytes"].map(id =>
      field("backups", id, "database-backups", { label: `Database backup ${id}` }))) : [],
  ];

  return () => [
    ...descriptors,
    ...worktrees ? bindTypedSettings(worktrees, worktreeRepositoryKeys().flatMap(repo =>
      (["enabled", "maxSlots"] as const).map(id => field("worktrees", `repositories.${id}`, "worktree-policy", {
        key: `worktrees.repositories.${createHash("sha256").update(repo).digest("base64url")}.${id}`,
        label: `Worktree ${id} for ${repo.split(/[/\\]/).filter(Boolean).slice(-2).join("/")}`,
        read: config => config.repositories[repo]?.[id] ?? config[id],
        patch: (_config, value) => ({ repositories: { [repo]: { [id]: value } } }),
      })))) : [],
  ];
}

function worktreeRepositoryKeys(): string[] {
  try { return Object.keys(getWorktreesConfig().repositories); }
  catch { return []; }
}
