import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { APP_CONFIG_ENTRIES, appConfigEntryHasSettings } from "../src/shared/app-config-entries.ts";
import { DISPLAY_ITEMS } from "../src/shared/board-card-settings.ts";
import { ACTIONS } from "../src/shared/keyboard-settings.ts";
import { ALL_SETTINGS_CONTROLS } from "../src/shared/settings-controls.ts";
import { SETTINGS_VALUE_MAX_BYTES, settingsFailure } from "../src/shared/settings-mcp.ts";
import { TOPBAR_ITEMS } from "../src/shared/topbar-items-settings.ts";
import { dispatchSetting } from "../src/server/settings-dispatcher.ts";
import { typedSettings } from "../src/server/session-settings-owners.ts";
import { bindTypedSettings, field } from "../src/server/typed-settings.ts";

const unused = (): never => assert.fail("coverage must inspect declarations without mutating settings");

const phase3Owners = {
  away: ["away", "awaySince", "detectStalls", "stallWorkingMinutes", "stallUnfinishedMinutes", "stallEscalationMinutes"],
  featureFlags: "whole",
  foremanInstructions: "whole",
  pipelines: ["enabled", "launchRuntime", "foremanMechanicalTriage", "repos"],
  repoIndex: ["directories"],
  residentMcpServers: ["servers"],
  residentSkillSources: ["directories"],
  shaping: "whole",
  standingInstructions: ["default", "repositories"],
  taskSources: ["sources"],
  voice: ["muted", "hotkey", "autoMuteDuringCalls", "endOfSpeechMs", "cancelWindow", "speech", "whenUnsure",
    "planFormsByVoice", "inputDevice", "decisionProvider", "backend"],
} as const;

// In a covered domain every top-level field must have a published leaf or an exact disposition.
// The inventory explains these phase 3, operational and protected exceptions.
const withheld = {
  backups: [],
  cost: ["enabled", "exportIntervalMs"],
  foreman: ["autoApproveAccess", "enabled", "mode", "repoAllowlist"],
  harnesses: ["autoModeOnDispatch"],
  inspector: ["enabled", "mode", "repoAllowlist"],
  llm: [],
  reports: [],
  shipping: ["autoMerge", "closeSessionAfterMerge", "codeRabbitAutoResolve", "repoAllowlist"],
  skills: ["defaultSkillEnabled", "enabled", "generation", "generationAt", "planStorage", "skills"],
  storageLimits: [],
  terminals: [],
  ui: ["announcedTours", "guidedTour", "hiddenDisplayItemsSeed", "showToursOnStartup", "trustStaged", "voice"],
  workflows: ["checksEnabled", "kindWorkflowDefaults", "liveEnabled", "repoAllowlist", "retention"],
  worktrees: ["repositories"],
} as const;

test("typed owner fields, Settings controls and exact rollout dispositions reconcile", () => {
  const catalog = typedSettings({
    harnesses: unused, foreman: unused, inspector: unused, llm: unused, shipping: unused, skills: unused,
    cost: unused, worktrees: unused, storageLimits: unused, backups: unused,
  })();
  const keys = new Set(catalog.map(setting => setting.key));
  assert.equal(keys.size, catalog.length, "public keys must be unique");

  const inventory = readFileSync(new URL("../docs/session-settings-inventory.md", import.meta.url), "utf8");
  const covered = new Set(catalog.map(setting => setting.control));
  for (const [, id] of inventory.matchAll(/^\| `([\w*-]+)` \| 2 \| Read\/write \|/gm)) {
    const live = ALL_SETTINGS_CONTROLS.filter(control =>
      id!.endsWith("*") ? control.id.startsWith(id!.slice(0, -1)) : control.id === id);
    assert.ok(live.length, `Unknown settings control ${id}`);
    for (const control of live) assert.ok(covered.has(control.id), `No typed binding for ${control.id}`);
  }
  assert.doesNotMatch(inventory, /\| 2 \| Pending \|/);
  assert.deepEqual(
    Object.keys(APP_CONFIG_ENTRIES).filter(id => appConfigEntryHasSettings(APP_CONFIG_ENTRIES[id as keyof typeof APP_CONFIG_ENTRIES])).sort(),
    [...Object.keys(withheld), ...Object.keys(phase3Owners)].sort(),
  );
  for (const [id, disposition] of Object.entries(phase3Owners)) {
    const { classification } = APP_CONFIG_ENTRIES[id as keyof typeof phase3Owners];
    if (disposition === "whole") {
      assert.equal(classification.kind, "whole", id);
    } else {
      assert.equal(classification.kind, "fields", id);
      assert.deepEqual(Object.keys(classification.fields).sort(), [...disposition].sort(), id);
    }
  }
  for (const [id, exceptions] of Object.entries(withheld)) {
    const entry = APP_CONFIG_ENTRIES[id as keyof typeof withheld];
    const owner = id === "storageLimits" ? "storage" : id;
    const published = new Set(catalog
      .filter(setting => setting.key.startsWith(`${owner}.`) && !setting.key.startsWith("worktrees.repositories."))
      .map(setting => setting.key.split(".")[1]!));
    if (id === "ui") published.add("skin");
    assert.ok(!exceptions.some(field => published.has(field)), `Conflicting policy for ${id}`);
    assert.deepEqual([...published, ...exceptions].sort(), Object.keys(entry.classification.fields).sort(), id);
  }
  for (const { id } of ACTIONS) assert.ok(keys.has(`ui.keybindings.${id}`));
  for (const { id } of DISPLAY_ITEMS) assert.ok(keys.has(`ui.hiddenDisplayItems.${id}`));
  for (const { id, kind } of TOPBAR_ITEMS) {
    assert.ok(keys.has(`ui.${kind === "optional" ? "hiddenTopbarItems" : "compactTopbarItems"}.${id}`));
  }
  assert.equal(catalog.find(setting => setting.key === "foreman.autoBacklog")?.access, "protected");
  for (const key of ["foreman.skipScoutWrapup", "foreman.skipReviewArtifactWrapup", "reports.guidance"]) {
    assert.equal(catalog.find(setting => setting.key === key)?.access, "protected", key);
  }
  assert.ok(!keys.has("ui.keybindings") && !keys.has("harnesses.advisor") && !keys.has("worktrees.repositories"));
});

test("typed replacement rejects stripped, inherited and oversized input before writing", () => {
  // The route's Zod object strips unknown keys. The one-field binding refuses them
  // rather than accepting a replacement that silently dropped part of the input.
  const schema = z.object({ appearance: z.object({ density: z.enum(["compact", "full"]) }) });
  const config = { appearance: { density: "compact" as const } };
  const [descriptor] = bindTypedSettings({
    schema, read: (): z.output<typeof schema> => config, apply: unused, revision: () => "0",
  }, [field("fixture", "appearance", "layout", { replacement: "composite" })]);
  const dispatch = (request: Parameters<typeof dispatchSetting>[0]) => dispatchSetting(request, [descriptor!], () => null);
  const get = dispatch({ operation: "get", key: "fixture.appearance" });
  assert.ok(get.ok && get.operation === "get" && get.version);
  const update = { operation: "set", key: get.key, expectedVersion: get.version } as const;
  for (const value of [
    { density: "full", unexpected: "secret" },
    JSON.parse('{"density":"full","__proto__":{"unexpected":"secret"}}'),
  ]) {
    assert.deepEqual(dispatch({ ...update, value }), settingsFailure("invalid_value"));
  }
  assert.deepEqual(dispatch({ ...update, value: { density: "x".repeat(SETTINGS_VALUE_MAX_BYTES) } }),
    settingsFailure("value_too_large"));
});
