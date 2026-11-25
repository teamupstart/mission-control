import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SETTINGS_CATEGORIES } from "../src/web/lib/settings-registry.ts";
import { ALL_SETTINGS_CONTROLS, settingsControls } from "../src/web/lib/settings-search.ts";
import { FEATURE_FLAGS } from "../src/shared/feature-flag-registry.ts";
import { APP_CONFIG_ENTRIES, appConfigEntryHasSettings } from "../src/shared/app-config-entries.ts";
import { ACTIONS } from "../src/shared/keyboard-settings.ts";
import { DISPLAY_ITEMS } from "../src/shared/board-card-settings.ts";
import { TOPBAR_ITEMS } from "../src/shared/topbar-items-settings.ts";
import { VOICE_CONFIG_DEFAULTS, VOICE_INDICATOR_IDS } from "../src/shared/voice.ts";
import { TaskSourcesConfigSchema } from "../src/shared/task-source.ts";
import { DEFAULT_WORKFLOW_POLICY } from "../src/shared/workflow.ts";
import { HARNESS_LAUNCHED_TASK_KINDS } from "../src/shared/task.ts";
import { SHAPING_CONFIG_DEFAULTS } from "../src/shared/shaping.ts";
import { readCatalog } from "../src/server/skills/catalog.ts";
import { setAppConfig } from "../src/server/db.ts";
import { baseSessionSettings } from "../src/server/session-settings.ts";
import { typedSettings } from "../src/server/session-settings-owners.ts";
import { pipelineRuntimeSetting, settingTargetId, specializedSettings, workflowDefaultSettings } from "../src/server/session-settings-specialized.ts";
import { taskSourceSettings } from "../src/server/session-settings-task-sources.ts";
import type { SettingDescriptor } from "../src/server/settings-dispatcher.ts";
import { FEATURE_FLAGS_DEFAULTS } from "../src/shared/feature-flags.ts";

test("the final inventory assigns each searchable Settings control, including generated and hidden controls", () => {
  const source = readFileSync(new URL("../docs/session-settings-inventory.md", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\|[^\n]*\bPending\b/);
  const rows = [...source.matchAll(/^\| `([\w*-]+)` \| ([123]) \| ([^|]+) \| (.+) \|$/gm)];
  const assignments = new Map(rows.map(([, id, phase, disposition, owner]) => [id!, { phase, disposition, owner }]));
  assert.equal(assignments.size, rows.length);
  assert.deepEqual(new Set(ALL_SETTINGS_CONTROLS.map(control => control.category)),
    new Set(SETTINGS_CATEGORIES.map(category => category.id)));
  const used = new Set<string>();
  for (const control of ALL_SETTINGS_CONTROLS) {
    const key = assignments.has(control.id) ? control.id
      : ["harness-*", "keyboard-*", "feature-flag-*"].find(family => control.id.startsWith(family.slice(0, -1)));
    assert.ok(key && assignments.has(key), `Missing inventory row for ${control.id}`);
    used.add(key);
  }
  assert.deepEqual([...assignments.keys()].filter(id => !used.has(id)), []);
  assert.ok(ALL_SETTINGS_CONTROLS.some(control => control.category === "conductor"));
  assert.ok(!settingsControls(FEATURE_FLAGS_DEFAULTS).some(control => control.category === "conductor"));
  assert.equal(assignments.get("skin")?.disposition, "Read/write");
  assert.equal(assignments.get("session-settings-access")?.disposition, "Protected");
  assert.equal(assignments.get("feature-flag-session-settings-mcp")?.disposition, "Protected");
});

const neverWrite = (): never => assert.fail("inventory reads must never mutate owners");

const nonPreferenceControls = {
  "voice-roster": "Derived from resident and session call signs.",
  "native-worktree-pools": "Pool status and individual lease operations.",
  "legacy-worktree-drain": "A workstation operation.",
  "repository-index-rescan": "Rescans the filesystem.",
  "storage-overview": "Measured usage.",
  "storage-cleanup": "Preview and execute filesystem cleanup.",
  "storage-problems": "Storage health and diagnostics.",
  "foreman-episodes": "Decision history.",
  "workflow-test-evidence": "Derived proof status.",
  "workflow-health": "Derived delivery and retention health.",
  "conductor-overview": "Commissioning, inventory and runs.",
  "conductor-detection": "Detection and installation status.",
} as const;

function assertControlsCovered(controls: readonly { id: string }[], catalog: readonly SettingDescriptor[]) {
  const covered = new Set([
    ...catalog.map(setting => setting.control),
    // Add and remove edit the same selected list as the directories control.
    ...(catalog.some(setting => setting.key === "repoIndex.directories") ? ["repository-index-add"] : []),
    ...Object.keys(nonPreferenceControls),
  ]);
  for (const { id } of controls) assert.ok(covered.has(id), `Missing live setting or disposition for ${id}`);
}

const dispositions = {
  away: { away: "Live presence", awaySince: "Derived timestamp" },
  skills: { defaultSkillEnabled: "Inherited catalog seed", generation: "Derived watermark", generationAt: "Derived timestamp" },
  ui: { announcedTours: "Onboarding state", guidedTour: "Onboarding state", hiddenDisplayItemsSeed: "Migration marker", trustStaged: "Operator staging" },
  residents: { skillSources: "Controls instructions loaded by future residents", mcpServers: "Controls executable programs and environment" },
} as const;

test("the live owner catalog and explicit dispositions cover every indexed control and config owner", () => {
  const worktrees = { "/fixture/repo/.git": { enabled: true } };
  const sources = TaskSourcesConfigSchema.parse({
    sources: [
      { id: "issues", kind: "github-issues", repoRoot: "/fixture/repo" },
      { id: "jira", kind: "jira", repoRoot: "/fixture/repo" },
    ],
  });
  setAppConfig(APP_CONFIG_ENTRIES.worktrees, { repositories: worktrees } as never);
  const catalog = [
    ...baseSessionSettings,
    ...typedSettings({
      harnesses: neverWrite, foreman: neverWrite, inspector: neverWrite, llm: neverWrite, shipping: neverWrite,
      skills: neverWrite, cost: neverWrite, worktrees: neverWrite, storageLimits: neverWrite, backups: neverWrite,
      workflows: neverWrite,
    })(),
    ...specializedSettings({ away: neverWrite, repoIndex: neverWrite }),
    ...workflowDefaultSettings(() => null, neverWrite, neverWrite),
    pipelineRuntimeSetting(neverWrite),
    ...taskSourceSettings({ read: () => sources, apply: neverWrite, changed: neverWrite }),
  ];
  const keys = new Set(catalog.map(setting => setting.key));
  assert.equal(keys.size, catalog.length, "published keys must be unique");
  assertControlsCovered(ALL_SETTINGS_CONTROLS, catalog);
  assert.throws(() => assertControlsCovered([{ id: "undeclared-new-control" }], catalog), /undeclared-new-control/);

  const domains = Object.values(APP_CONFIG_ENTRIES).filter(appConfigEntryHasSettings);
  for (const entry of domains) {
    const owner = entry.key === "storage.limits" ? "storage" : entry.key;
    if (entry.classification.kind === "whole") {
      assert.ok(catalog.some(setting => setting.key === owner || setting.key.startsWith(`${owner}.`)), owner);
      continue;
    }
    const [prefix, nested] = owner.split(".");
    const exceptions = dispositions[prefix as keyof typeof dispositions] ?? {};
    if (nested && Object.hasOwn(exceptions, nested)) continue;
    for (const id of Object.keys(entry.classification.fields)) {
      const key = `${owner}.${id}`;
      assert.ok(Object.hasOwn(exceptions, id) || (owner === "taskSources" && id === "sources"
        ? sources.sources.every(source => keys.has(`taskSources.${settingTargetId(source.id)}.intervalMs`))
        : catalog.some(setting => setting.key === key || setting.key.startsWith(`${key}.`))), `Missing coverage for ${key}`);
    }
  }
  const editableLeaves = [
    ...Object.keys(SHAPING_CONFIG_DEFAULTS.limits).map(id => `shaping.limits.${id}`),
    ...Object.keys(VOICE_CONFIG_DEFAULTS.cancelWindow).map(id => `voice.cancelWindow.${id}`),
    ...Object.keys(VOICE_CONFIG_DEFAULTS.speech).map(id => `voice.speech.${id}`),
    ...Object.keys(DEFAULT_WORKFLOW_POLICY.retention).map(id => `workflows.retention.${id}`),
    ...HARNESS_LAUNCHED_TASK_KINDS.map(kind => `workflows.kindWorkflowDefaults.${kind}`),
    ...readCatalog().skills.map(skill => `skills.skills.${skill.id}`),
    ...Object.keys(worktrees).flatMap(repo => ["enabled", "maxSlots"].map(id =>
      `worktrees.repositories.${settingTargetId(repo)}.${id}`)),
  ];
  for (const key of editableLeaves) {
    assert.equal(catalog.find(setting => setting.key === key)?.access, "read-write", `Missing live owner for ${key}`);
  }
  for (const leaf of Object.keys(SHAPING_CONFIG_DEFAULTS).filter(id => id !== "limits")) {
    assert.equal(catalog.find(setting => setting.key === `shaping.${leaf}`)?.access, "protected");
  }
  for (const { id } of ACTIONS) assert.ok(keys.has(`ui.keybindings.${id}`));
  for (const { id } of DISPLAY_ITEMS) assert.ok(keys.has(`ui.hiddenDisplayItems.${id}`));
  for (const { id, kind } of TOPBAR_ITEMS) {
    assert.ok(keys.has(`ui.${kind === "optional" ? "hiddenTopbarItems" : "compactTopbarItems"}.${id}`));
  }
  for (const id of VOICE_INDICATOR_IDS) assert.ok(keys.has(`ui.voice.indicators.${id}`));
  for (const flag of FEATURE_FLAGS) {
    const setting = catalog.find(item => item.key === `featureFlags.${flag.id}`);
    assert.equal(setting?.access, flag.sessionSetting === "read-write" ? "read-write" : "protected");
    if (setting?.access === "protected") assert.ok(setting.reason);
  }
  for (const source of sources.sources) {
    const root = `taskSources.${settingTargetId(source.id)}.`;
    const permitted = (object: object, prefix = "") => Object.keys(object).filter(leaf =>
      !["id", "kind", "config", "defaults", "repoRoot", "enabled", "writeback", "repo", "site",
        "queryVia", "closeReason", "resolveTransition", "linkVia"].includes(leaf) || `${prefix}${leaf}` === "defaults.kind");
    const expected = [
      ...permitted(source),
      ...permitted(source.defaults, "defaults.").map(leaf => `defaults.${leaf}`),
      ...permitted(source.config as object, "config.").map(leaf => `config.${leaf}`),
    ];
    assert.deepEqual(catalog.filter(item => item.access === "read-write" && item.key.startsWith(root))
      .map(item => item.key.slice(root.length)).sort(), expected.sort());
  }
  for (const [key, access] of [
    ["dispatch.launcher.prompt", "read-write"], ["ui.showToursOnStartup", "read-write"],
    ["foreman.autoApproveAccess", "protected"], ["harnesses.autoModeOnDispatch", "protected"],
    ["sessionSettings.access", "protected"], ["updates.alpha", "protected"], ["reports.muted", "protected"],
    ["telemetry.user", "protected"], ["telemetry.product", "protected"], ["telemetry.identity", "protected"],
  ]) {
    assert.equal(catalog.find(setting => setting.key === key)?.access, access, key);
  }
  for (const key of ["ui.voice", "harnesses.advisor", "taskSources.sources", "featureFlags", "telemetry", "workflows.retention"]) {
    assert.ok(!keys.has(key), `No bulk setting for ${key}`);
  }
});
