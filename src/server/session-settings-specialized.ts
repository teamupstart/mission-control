import { HARNESS_LAUNCHED_TASK_KINDS, TASK_KIND_INFO, taskDefaultWorkflowId } from "@shared/task.ts";
import { PipelinesConfigSchema, type PipelinesConfig } from "@shared/pipeline.ts";
import type { WorkflowPolicyPatch } from "@shared/protocol.ts";
import { getWorkflowPolicy } from "./workflows/config.ts";
import type { WorkflowManager } from "./workflows/manager.ts";
import { getPipelinesConfig } from "./pipelines/config.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { FEATURE_FLAGS } from "@shared/feature-flag-registry.ts";
import { FeatureFlagIntentSchema } from "@shared/feature-flags.ts";
import { AwayConfigPatchSchema, type AwayConfigPatch } from "@shared/protocol.ts";
import { RepoIndexConfigPatchSchema, type RepoIndexConfig, type RepoIndexConfigPatch } from "@shared/repo-index.ts";
import { ShapingSettingsIntentSchema, type ShapingConfig } from "@shared/shaping.ts";
import {
  VOICE_BACKEND_CHOICES, VOICE_CONFIRMATION_PLACEMENTS, VOICE_FLAG, VOICE_INDICATOR_IDS,
  VOICE_INPUT_DEVICE_BUILT_IN, VOICE_INPUT_DEVICE_SYSTEM_DEFAULT, VOICE_WHEN_UNSURE,
  VoiceConfigPatchSchema, VoiceConfigSchema, VoiceIndicatorSelectionSchema, VoiceUiConfigPatchSchema,
} from "@shared/voice.ts";
import { SpeechVoiceSchema, type VoiceSpeechVoice } from "@shared/voice-speech.ts";
import type { SettingsChoice } from "@shared/settings-mcp.ts";
import { ALL_SETTINGS_CONTROLS } from "@shared/settings-controls.ts";
import { settingsCategory, settingsCategoryAvailable } from "@shared/settings-registry.ts";
import { appConfigRevision } from "./db.ts";
import { applyFeatureFlagIntent, featureEnabled, getFeatureFlagsConfig } from "./feature-flags/index.ts";
import { getAwayConfig } from "./away/config.ts";
import { launcherPromptEnabled, setLauncherPrompt } from "./home-dispatch/config.ts";
import { getRepoIndexConfig, repositoryIndexEnvironmentOverride } from "./repo-index-config.ts";
import { InvalidSettingValue, type SettingDescriptor, type SettingScalar } from "./settings-dispatcher.ts";
import { applyShapingIntent, getShapingConfig } from "./shaping/index.ts";
import { bindTypedSettings, choices, field } from "./typed-settings.ts";
import { setVoiceConfirmation, setVoiceIndicator, storedVoiceUi } from "./ui-config.ts";
import { getVoiceConfig, setVoiceConfig } from "./voice/config.ts";
import { voiceStateStore } from "./voice/state.ts";

const controls = new Map(ALL_SETTINGS_CONTROLS.map(control => [control.id, control]));

export function controlMetadata(control: string) {
  const metadata = controls.get(control);
  if (!metadata) throw new Error(`Missing settings control ${control}`);
  return {
    control, label: metadata.label, keywords: metadata.keywords,
    available: () => settingsCategoryAvailable(metadata.category, getFeatureFlagsConfig()),
    destination: `Settings > ${settingsCategory(metadata.category).label}`,
  };
}

export function settingTargetId(id: string): string {
  return createHash("sha256").update(id).digest("base64url");
}

type ScalarDescriptor = Extract<SettingDescriptor, { replacement: "scalar" }>;

export function scalarIntent<Value extends SettingScalar>(
  key: string, control: string, schema: z.ZodType<Value>,
  adapter: {
    read(): Value;
    /** Use the stored choice for retry detection when the effective value can be inherited. */
    readStored?(): Value | undefined;
    apply(value: Value): Value;
    choices?: () => readonly SettingsChoice[];
    label?: string;
    available?: () => boolean;
  },
): ScalarDescriptor {
  const metadata = controlMetadata(control);
  return {
    ...metadata, key, label: adapter.label ?? metadata.label,
    access: "read-write", replacement: "scalar", schema,
    available: () => metadata.available() && (adapter.available?.() ?? true),
    read: adapter.read,
    choices: adapter.choices,
    ...(adapter.choices && { constraints: { choicesOnly: true } }),
    write(value) {
      const parsed = schema.parse(value);
      const current = adapter.read();
      const stored = adapter.readStored ? adapter.readStored() : current;
      if (stored === parsed) return current;
      if (adapter.choices && !adapter.choices().some(choice => choice.value === parsed)) throw new InvalidSettingValue();
      return adapter.apply(parsed);
    },
  };
}

export function flagSettings(): SettingDescriptor[] {
  return FEATURE_FLAGS.map(flag => {
    const control = `feature-flag-${flag.id}`;
    const key = `featureFlags.${flag.id}`;
    if (flag.sessionSetting !== "read-write") {
      return { ...controlMetadata(control), key, access: "protected", reason: flag.sessionSetting ?? "This flag has no session access policy." };
    }
    return scalarIntent(key, control, z.boolean(), {
      read: () => featureEnabled(flag.id),
      readStored: () => getFeatureFlagsConfig().overrides[flag.id],
      apply(enabled) {
        const intent = FeatureFlagIntentSchema.parse({ kind: "flag", id: flag.id, enabled });
        const result = applyFeatureFlagIntent(intent);
        if (!result.ok) throw new InvalidSettingValue();
        return featureEnabled(flag.id);
      },
    });
  });
}

const shapingSettingsSchema = ShapingSettingsIntentSchema.pick({ limits: true });

function shapingSettings(): SettingDescriptor[] {
  return bindTypedSettings({
    schema: shapingSettingsSchema, read: getShapingConfig,
    apply(patch) {
      const result = applyShapingIntent({ kind: "settings", ...patch });
      if (!result.ok) throw new InvalidSettingValue();
      return result.config;
    },
  }, (["timeoutMs", "deadlineMs", "maxBytes", "totalBytes"] as const).map(id =>
    field<ShapingConfig>("shaping", `limits.${id}`, "task-shaping-limits", { label: `Task shaping ${id}` })));
}

function voiceSettings(changed: (key: string) => void): SettingDescriptor[] {
  function inputDevices() {
    return [
      { value: VOICE_INPUT_DEVICE_BUILT_IN, label: "Built-in microphone" },
      { value: VOICE_INPUT_DEVICE_SYSTEM_DEFAULT, label: "System default" },
      ...(voiceStateStore.listenerDevices() ?? []).map(device => ({ value: device.id, label: device.name })),
    ];
  }
  const voiceId = (voice: VoiceSpeechVoice | null) => voice && `${voice.engine}:${voice.id}`;
  const speechChoices = () => {
    const catalog = voiceStateStore.state().speech?.catalog;
    return (["neural", "system"] as const).flatMap(engine =>
      (catalog?.[engine] ?? []).map(voice => ({
        value: voiceId({ engine, id: voice.id }), label: voice.name,
      })));
  };
  return [
    scalarIntent("voice.speech.voice", "voice-mode", z.string().max(264).nullable(), {
      label: "Voice used for spoken replies",
      read: () => voiceId(getVoiceConfig().speech.voice),
      choices: () => [{ value: null, label: "Automatic" }, ...speechChoices()],
      apply(value) {
        const split = value?.indexOf(":") ?? 0;
        const voice = value === null ? null : SpeechVoiceSchema.parse({
          engine: value.slice(0, split), id: value.slice(split + 1),
        });
        const saved = setVoiceConfig({ speech: { voice } });
        changed("voice.speech.voice");
        return voiceId(saved.speech.voice);
      },
    }),
    ...bindTypedSettings({ schema: VoiceConfigPatchSchema, read: getVoiceConfig, apply: patch => setVoiceConfig(patch), changed }, [
      field("voice", "autoMuteDuringCalls", "voice-auto-mute"),
      field("voice", "transcriptStyle", "voice-mode", {
        label: "Live voice transcript style", choices: choices(VoiceConfigSchema.shape.transcriptStyle.unwrap().options),
      }),
      field("voice", "transcriptCorner", "voice-mode", {
        label: "Live voice transcript corner", choices: choices(VoiceConfigSchema.shape.transcriptCorner.unwrap().options),
      }),
      field("voice", "transcriptWords", "voice-mode", { label: "Live voice transcript word limit" }),
      field("voice", "endOfSpeechMs", "voice-end-of-speech"),
      field("voice", "cancelWindow.enabled", "voice-cancel-window", { label: "Enable voice cancel window" }),
      field("voice", "cancelWindow.seconds", "voice-cancel-window", { label: "Voice cancel window in seconds" }),
      field("voice", "whenUnsure", "voice-when-unsure", { choices: choices(VOICE_WHEN_UNSURE) }),
      field("voice", "planFormsByVoice", "voice-plan-forms"),
      field("voice", "backend", "setup-checks", {
        label: "Voice recognition backend", choices: choices(VOICE_BACKEND_CHOICES),
        available: () => featureEnabled(VOICE_FLAG) && !VOICE_BACKEND_CHOICES.some(value => value === process.env.MISSION_VOICE_BACKEND),
      }),
    ]),
    scalarIntent("voice.inputDevice", "voice-input-device", VoiceConfigSchema.shape.inputDevice.unwrap(), {
      read: () => getVoiceConfig().inputDevice,
      choices: inputDevices,
      apply: inputDevice => {
        const saved = setVoiceConfig({ inputDevice });
        changed("voice.inputDevice");
        return saved.inputDevice;
      },
    }),
    scalarIntent("ui.voice.confirmation", "voice-confirmation", VoiceUiConfigPatchSchema.shape.confirmation, {
      read: () => storedVoiceUi().confirmation,
      choices: () => choices(VOICE_CONFIRMATION_PLACEMENTS),
      apply: value => setVoiceConfirmation(value).confirmation,
    }),
    ...VOICE_INDICATOR_IDS.map(id => scalarIntent(`ui.voice.indicators.${id}`, "voice-indicators",
      VoiceIndicatorSelectionSchema.shape.enabled, {
        label: `Show voice indicator on ${id}`,
        read: () => storedVoiceUi().indicators.includes(id),
        apply(enabled) {
          const config = setVoiceIndicator(id, enabled);
          if (!config) throw new InvalidSettingValue();
          return config.indicators.includes(id);
        },
      })),
  ];
}

export function specializedSettings(owners: {
  repoIndex?: (patch: RepoIndexConfigPatch) => RepoIndexConfig;
  away: (patch: AwayConfigPatch) => ReturnType<typeof getAwayConfig>;
}, changed: (key: string) => void = () => {}): SettingDescriptor[] {
  const repoIndex = owners.repoIndex;
  return [
    ...shapingSettings(), ...voiceSettings(changed),
    ...bindTypedSettings({ schema: AwayConfigPatchSchema, read: getAwayConfig, apply: owners.away, changed },
      ["detectStalls", "stallWorkingMinutes", "stallUnfinishedMinutes", "stallEscalationMinutes"].map(id =>
        field("away", id, "away-stalls", { label: `Away ${id}` }))),
    scalarIntent("dispatch.launcher.prompt", "setup-checks", z.boolean(), {
      label: "Offer the home dispatch launcher prompt",
      read: launcherPromptEnabled,
      apply(value) {
        setLauncherPrompt(value);
        return launcherPromptEnabled();
      },
    }),
    ...repoIndex ? bindTypedSettings({
      schema: RepoIndexConfigPatchSchema, read: getRepoIndexConfig, apply: repoIndex, changed,
      revision: () => appConfigRevision(APP_CONFIG_ENTRIES.repoIndex),
    }, [field("repoIndex", "directories", "repository-index-directories", {
      replacement: "composite", available: () => !repositoryIndexEnvironmentOverride(),
    })]) : [],
  ];
}

export function workflowDefaultSettings(
  workflowManager: () => Pick<WorkflowManager, "list"> | null,
  apply: (patch: WorkflowPolicyPatch) => ReturnType<typeof getWorkflowPolicy>,
  changed: (key: string) => void,
): SettingDescriptor[] {
  return HARNESS_LAUNCHED_TASK_KINDS.map(kind => scalarIntent(
    `workflows.kindWorkflowDefaults.${kind}`, "task-kind-workflow-defaults", z.string().min(1).max(500).nullable(),
    {
      label: `${TASK_KIND_INFO[kind].label} after-work workflow`,
      available: () => workflowManager() !== null,
      read: () => taskDefaultWorkflowId(kind, getWorkflowPolicy().kindWorkflowDefaults),
      choices: () => [
        { value: "$inherit", label: "Use the built-in default" },
        { value: null, label: "None" },
        ...workflowManager()!.list().filter(workflow => workflow.currentVersionId !== null)
          .map(workflow => ({ value: workflow.id, label: workflow.name })),
      ],
      apply(value) {
        const kindWorkflowDefaults = { ...getWorkflowPolicy().kindWorkflowDefaults };
        if (value === "$inherit") delete kindWorkflowDefaults[kind];
        else kindWorkflowDefaults[kind] = value;
        const saved = apply({ kindWorkflowDefaults });
        changed(`workflows.kindWorkflowDefaults.${kind}`);
        return taskDefaultWorkflowId(kind, saved.kindWorkflowDefaults);
      },
    },
  ));
}

export function pipelineRuntimeSetting(
  apply: (config: PipelinesConfig) => PipelinesConfig,
  changed: (key: string) => void,
): SettingDescriptor {
  return scalarIntent("pipelines.launchRuntime", "conductor-launch-runtime",
    PipelinesConfigSchema.shape.launchRuntime.unwrap(), {
      read: () => getPipelinesConfig().launchRuntime,
      apply(launchRuntime) {
        const saved = apply({ ...getPipelinesConfig(), launchRuntime });
        changed("pipelines.launchRuntime");
        return saved.launchRuntime;
      },
    });
}
