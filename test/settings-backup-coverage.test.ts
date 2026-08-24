import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_CONFIG_ENTRIES,
  APP_CONFIG_ENTRY_LIST,
  type AppConfigValueClass,
} from "../src/shared/app-config-entries.ts";
import {
  SETTINGS_BACKUP_DOMAINS,
  SETTINGS_BACKUP_DOMAIN_IDS,
} from "../src/shared/settings-backup-domains.ts";
import { SkillsConfigSchema } from "../src/shared/protocol.ts";
import { getAppConfig } from "../src/server/db.ts";
import { SETTINGS_BACKUP_CATALOGS } from "../src/server/settings-backups/catalogs.ts";
import {
  SETTINGS_CONFIG_BACKUP_ENTRIES,
  settingPayloadForEntry,
} from "../src/server/settings-backups/config-registry.ts";
import {
  SETTINGS_CONTROLS,
  type SettingsControl,
} from "../src/web/lib/settings-search.ts";
import { ACTIONS } from "../src/web/lib/keybindings.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";

test("every Settings control declares backup coverage or an explicit reason", () => {
  for (const control of SETTINGS_CONTROLS) {
    if (control.backup.kind === "domain") {
      assert.ok(control.backup.domains.length > 0, `${control.id} has no backup domain`);
      for (const domain of control.backup.domains) {
        assert.ok(SETTINGS_BACKUP_DOMAIN_IDS.includes(domain), `${control.id} names ${domain}`);
      }
    } else {
      assert.match(control.backup.reason, /^(read-only|operational-action|derived-status)$/);
    }
  }
});

test("Settings, runtime config, and Library domains have exactly one registered owner", () => {
  const settingsReferences = SETTINGS_CONTROLS.flatMap((control) =>
    control.backup.kind === "domain" ? control.backup.domains : []);
  const settingsDomains = SETTINGS_BACKUP_DOMAINS
    .filter((domain) => domain.surface === "settings")
    .map((domain) => domain.id);
  for (const domain of settingsDomains) {
    assert.ok(settingsReferences.includes(domain), `${domain} has no Settings control coverage`);
  }

  const configDomains = SETTINGS_CONFIG_BACKUP_ENTRIES.map((entry) => entry.backupDomain);
  assert.equal(new Set(configDomains).size, configDomains.length, "config domains must be unique");
  assert.deepEqual(
    [...configDomains].sort(),
    SETTINGS_BACKUP_DOMAINS
      .filter((domain) => domain.surface === "settings" || domain.surface === "runtime")
      .map((domain) => domain.id)
      .sort(),
  );

  const libraryDomains = SETTINGS_BACKUP_CATALOGS.map((entry) => entry.domain);
  assert.deepEqual(
    [...libraryDomains].sort(),
    SETTINGS_BACKUP_DOMAINS.filter((domain) => domain.surface === "library")
      .map((domain) => domain.id)
      .sort(),
  );
  assert.deepEqual(
    [...new Set([...configDomains, ...libraryDomains])].sort(),
    [...SETTINGS_BACKUP_DOMAIN_IDS].sort(),
  );
});

test("the config capture registry is derived from the complete classified key registry", () => {
  const expected = APP_CONFIG_ENTRY_LIST.filter((entry) => {
    if (entry.classification.kind === "whole") {
      return entry.classification.valueClass === "setting";
    }
    return Object.values(entry.classification.fields).includes("setting");
  });
  assert.deepEqual(SETTINGS_CONFIG_BACKUP_ENTRIES, expected);

  for (const entry of APP_CONFIG_ENTRY_LIST) {
    if (entry.classification.kind === "whole") {
      assert.match(entry.classification.valueClass, /^(setting|derived|operational)$/);
    } else {
      for (const valueClass of Object.values(entry.classification.fields)) {
        assert.match(valueClass, /^(setting|derived|operational)$/);
      }
    }
  }
});

test("the initial app_config key and value-class partition is pinned", () => {
  assert.deepEqual(
    APP_CONFIG_ENTRY_LIST.map((entry) => entry.key).sort(),
    [
      "away",
      "backlog.plan",
      "cost",
      "costOtelLastSeen",
      "costTelemetryEnabledAt",
      "foreman",
      "foreman.instructions",
      "foreman.lease",
      "harnesses",
      "inspector",
      "instructions.standing",
      "llm",
      "pipelines",
      "shipping",
      "skills",
      "taskSources",
      "ui",
      "workflows",
      "worktrees",
    ],
  );

  for (const entry of [
    APP_CONFIG_ENTRIES.harnesses,
    APP_CONFIG_ENTRIES.worktrees,
    APP_CONFIG_ENTRIES.cost,
    APP_CONFIG_ENTRIES.foreman,
    APP_CONFIG_ENTRIES.workflows,
    APP_CONFIG_ENTRIES.taskSources,
    APP_CONFIG_ENTRIES.llm,
    APP_CONFIG_ENTRIES.standingInstructions,
    APP_CONFIG_ENTRIES.inspector,
    APP_CONFIG_ENTRIES.shipping,
    APP_CONFIG_ENTRIES.pipelines,
    APP_CONFIG_ENTRIES.ui,
  ]) {
    assert.equal(entry.classification.kind, "fields");
    if (entry.classification.kind === "fields") {
      assert.ok(Object.values(entry.classification.fields).every((value) => value === "setting"));
    }
  }
  assert.deepEqual(APP_CONFIG_ENTRIES.skills.classification.fields, {
    enabled: "setting",
    skills: "setting",
    generation: "derived",
    generationAt: "derived",
  });
  assert.deepEqual(APP_CONFIG_ENTRIES.away.classification.fields, {
    away: "operational",
    awaySince: "operational",
    detectStalls: "setting",
    stallWorkingMinutes: "setting",
    stallUnfinishedMinutes: "setting",
    stallEscalationMinutes: "setting",
  });
  assert.equal(APP_CONFIG_ENTRIES.foremanInstructions.classification.valueClass, "setting");
  assert.equal(APP_CONFIG_ENTRIES.foremanLease.classification.valueClass, "operational");
  assert.equal(APP_CONFIG_ENTRIES.backlogPlan.classification.valueClass, "derived");
  assert.equal(APP_CONFIG_ENTRIES.costTelemetryEnabledAt.classification.valueClass, "derived");
  assert.equal(APP_CONFIG_ENTRIES.costOtelLastSeen.classification.valueClass, "operational");
});

test("mixed config snapshots include settings and exclude derived or operational state", () => {
  const skills = SkillsConfigSchema.parse({
    enabled: true,
    skills: { retro: true },
    generation: 42,
    generationAt: 1234,
  });
  assert.deepEqual(settingPayloadForEntry(APP_CONFIG_ENTRIES.skills, skills), {
    enabled: true,
    skills: { retro: true },
  });

  const away = APP_CONFIG_ENTRIES.away.schema.parse({
    away: true,
    awaySince: 999,
    detectStalls: false,
  });
  const awayPayload = settingPayloadForEntry(APP_CONFIG_ENTRIES.away, away);
  assert.equal("away" in (awayPayload as object), false);
  assert.equal("awaySince" in (awayPayload as object), false);
  assert.equal((awayPayload as { detectStalls: boolean }).detectStalls, false);
});

test("generated Settings controls inherit backup coverage in their generators", () => {
  for (const action of ACTIONS) {
    const control = SETTINGS_CONTROLS.find((candidate) => candidate.id === `keyboard-${action.id}`);
    assert.deepEqual(control?.backup, { kind: "domain", domains: ["ui"] });
  }
  for (const agent of AGENT_TYPES) {
    const control = SETTINGS_CONTROLS.find((candidate) => candidate.id === `harness-${agent}`);
    assert.deepEqual(control?.backup, { kind: "domain", domains: ["harnesses"] });
  }
});

function compileTimeCoverageContracts(): void {
  // @ts-expect-error app_config callers must use a classified descriptor, not a string key.
  getAppConfig("ui");

  // @ts-expect-error every Settings control must state its backup contract.
  const missingBackup: SettingsControl = {
    id: "fixture",
    label: "Fixture",
    description: "Fixture",
    category: "display",
    anchor: "display/fixture",
    keywords: [],
    kind: "jump",
  };
  void missingBackup;

  type SyntheticConfig = { included: boolean; forgotten: number };
  // @ts-expect-error an object-valued schema classification must name every field.
  const incompleteFields = { included: "setting" } satisfies Record<
    keyof SyntheticConfig,
    AppConfigValueClass
  >;
  void incompleteFields;
}
void compileTimeCoverageContracts;
