import { isDeepStrictEqual } from "node:util";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { TaskSourcesConfigPatchSchema } from "@shared/protocol.ts";
import type { TaskSourceInstance, TaskSourcesConfig } from "@shared/task-source.ts";
import type { SettingsValue } from "@shared/settings-mcp.ts";
import { appConfigRevision } from "./db.ts";
import { bindTypedSettings, field } from "./typed-settings.ts";
import { controlMetadata, settingTargetId } from "./session-settings-specialized.ts";
import { ProtectedSettingValue } from "./settings-dispatcher.ts";

const commonFields = [
  "label", "intervalMs", "keepUpdated", "maxPerSweep",
  "defaults.kind", "defaults.agent", "defaults.priority", "defaults.labels",
] as const;

const queryFields: Record<TaskSourceInstance["kind"], readonly string[]> = {
  "github-issues": [
    "config.labelsAny", "config.assignedToMe", "config.unassignedOnly", "config.milestone",
  ],
  jira: ["config.jql"],
};

const providerFields = {
  "github-issues": [...queryFields["github-issues"], "config.priorityFrom", "config.copyLabels", "config.limit"],
  jira: [...queryFields.jira, "config.limit", "config.priorityFromJira"],
} as const satisfies Record<TaskSourceInstance["kind"], readonly string[]>;

function sourceField(source: TaskSourceInstance, path: string) {
  const [parent, leaf] = path.split(".") as [string, string?];
  const readValue = (row: TaskSourceInstance): SettingsValue => {
    const value = (row as unknown as Record<string, SettingsValue>)[parent];
    return (leaf ? (value as Record<string, SettingsValue>)[leaf] : value) ?? null;
  };
  return field<TaskSourcesConfig>("taskSources", "sources", "task-sources", {
    key: `taskSources.${settingTargetId(source.id)}.${path}`,
    label: `${source.label.slice(0, 64) || "Task source"}: ${path}`,
    replacement: /\.(labels|labelsAny|priorityFrom)$/.test(path) ? "composite" : undefined,
    read(config) {
      const current = config.sources.find(row => row.id === source.id && row.kind === source.kind);
      if (!current) throw new Error("Task source no longer exists");
      return readValue(current);
    },
    patch: (config, value) => ({
      sources: config.sources.map(row => {
        if (row.id !== source.id) return row;
        // A disabled source can still be swept manually. A changed query can
        // select issues outside the operator's approved write-back scope.
        if (queryFields[row.kind].includes(path)
          && (row.writeback.onPrOpened || row.writeback.onCompleted || row.writeback.resolve)
          && !isDeepStrictEqual(value, readValue(row))) {
          throw new ProtectedSettingValue(controlMetadata("task-sources").destination);
        }
        return { ...row, ...(leaf ? { [parent]: { ...(row[parent as "config" | "defaults"] as object), [leaf]: value } } : { [parent]: value }) };
      }),
    }),
  });
}

export function taskSourceSettings(owner: {
  read: () => TaskSourcesConfig;
  apply: (config: TaskSourcesConfig) => TaskSourcesConfig;
  changed: (key: string) => void;
}) {
  const sources = owner.read().sources;
  return [
    ...bindTypedSettings({
      ...owner, schema: TaskSourcesConfigPatchSchema,
      revision: () => appConfigRevision(APP_CONFIG_ENTRIES.taskSources),
    }, sources.flatMap(source => [...commonFields, ...providerFields[source.kind]].map(path => sourceField(source, path)))),
    ...sources.map(source => ({
      ...controlMetadata("task-sources"),
      key: `taskSources.${settingTargetId(source.id)}.authority`,
      label: `Task source authority for ${source.label.slice(0, 64) || "this source"}`,
      access: "protected" as const,
      reason: "Enablement, repository and credential selection, automatic dispatch and upstream write-back require operator consent.",
    })),
  ];
}
