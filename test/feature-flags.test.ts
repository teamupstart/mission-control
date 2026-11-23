// An explicit off must survive a later opt-in to all previews, including across builds.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as registry from "../src/shared/feature-flag-registry.ts";
import {
  applyFeatureFlagIntent, explicitlyDisabledFeatureFlags, FEATURE_FLAGS_DEFAULTS,
  FeatureFlagIntentSchema, FeatureFlagsConfigSchema, resolveFeatureFlag, resolveFeatureFlags,
  type FeatureFlagDefinition, type FeatureFlagId, type FeatureFlagIntent, type FeatureFlagsConfig,
} from "../src/shared/feature-flags.ts";
import { INBOX_FLAG } from "../src/shared/inbox.ts";
import { VOICE_FLAG, VOICE_REQUIRED_FLAGS } from "../src/shared/voice.ts";

const definitions = [
  { id: "preview-one", label: "Preview", description: "Try the preview.", stage: "preview", keywords: [] },
  { id: "shipped-one", label: "Shipped", description: "Use the shipped feature.", stage: "default-on", keywords: [] },
] as const satisfies readonly FeatureFlagDefinition[];
function apply(config: FeatureFlagsConfig, intent: FeatureFlagIntent) {
  const result = applyFeatureFlagIntent(config, intent, definitions, ["retired-one"]);
  assert.equal(result.ok, true);
  return result.config;
}

test("resolution: explicit choice, stage, then master; unknown ids stay off", () => {
  for (const flag of definitions) for (const enableAll of [false, true]) {
    for (const override of [undefined, false, true]) {
      const config = { enableAll, overrides: override === undefined ? {} : { [flag.id]: override } };
      const expected = override ?? (flag.stage === "default-on" || enableAll);
      assert.equal(resolveFeatureFlag(flag.id, config, definitions), expected);
      assert.equal(resolveFeatureFlags(config, definitions)[flag.id], expected);
      assert.equal(resolveFeatureFlag("unknown", { enableAll, overrides: { unknown: true } }, definitions), false);
    }
  }
});
test("individual choices are stored in both directions under either master state", () => {
  for (const enableAll of [false, true]) for (const enabled of [false, true]) {
    const result = apply({ enableAll, overrides: {} }, { kind: "flag", id: "preview-one", enabled });
    assert.deepEqual(result, { enableAll, overrides: { "preview-one": enabled } });
  }
  let config = apply(FEATURE_FLAGS_DEFAULTS, { kind: "flag", id: "preview-one", enabled: true });
  config = apply(config, { kind: "flag", id: "preview-one", enabled: false });
  config = apply(config, { kind: "master", enabled: true });
  assert.equal(resolveFeatureFlag("preview-one", config, definitions), false);
  assert.deepEqual(explicitlyDisabledFeatureFlags(config, definitions), [definitions[0]]);
});
test("master preserves choices, or explicitly clears only known disabled choices", () => {
  const original = { enableAll: false, overrides: { "preview-one": true, "shipped-one": false, unknown: false, "retired-one": true } };
  for (const enabled of [true, false]) {
    assert.deepEqual(apply(original, { kind: "master", enabled }).overrides,
      { "preview-one": true, "shipped-one": false, unknown: false });
  }
  const next = apply(original, { kind: "master", enabled: true, enableDisabled: true });
  assert.deepEqual(next.overrides, { "preview-one": true, unknown: false });
  assert.equal(resolveFeatureFlag("shipped-one", next, definitions), true);
  assert.equal(apply(original, { kind: "master", enabled: false, enableDisabled: true }).overrides["shipped-one"], false);
  assert.equal(original.overrides["retired-one"], true, "input is never mutated");
  assert.deepEqual(applyFeatureFlagIntent(original, { kind: "flag", id: "unknown", enabled: true }, definitions), { ok: false, error: "unknown_flag" });
});
test("schemas bound keys and entries while accepting future ids", () => {
  assert.deepEqual(FeatureFlagsConfigSchema.parse({}), FEATURE_FLAGS_DEFAULTS);
  assert.deepEqual(FeatureFlagsConfigSchema.parse(undefined), FEATURE_FLAGS_DEFAULTS);
  const overrides = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`flag-${i}`, false]));
  assert.equal(FeatureFlagsConfigSchema.safeParse({ overrides }).success, true);
  assert.equal(FeatureFlagsConfigSchema.safeParse({ overrides: { ...overrides, extra: true } }).success, false);
  for (const id of ["", "Upper", "has_space", "-leading", "trailing-", "two--dashes", "a".repeat(65)]) {
    assert.equal(FeatureFlagsConfigSchema.safeParse({ overrides: { [id]: true } }).success, false, id);
    assert.equal(FeatureFlagIntentSchema.safeParse({ kind: "flag", id, enabled: true }).success, false, id);
  }
  assert.equal(FeatureFlagsConfigSchema.safeParse({ overrides: { ["a".repeat(64)]: true } }).success, true);
  assert.equal(FeatureFlagIntentSchema.safeParse({ kind: "master", enabled: "true" }).success, false);
});
test("shipped registry is data-only, well formed, and disjoint from append-only tombstones", () => {
  assert.deepEqual(Object.keys(registry).sort(), [
    "AGENT_ENVIRONMENT_FLAG", "FEATURE_FLAGS", "HEADLESS_MODE_FLAG_ID", "MCP_SCHEDULES_FLAG_ID",
    "PINNED_PLAN_CHANGE_FLAG_ID", "RETIRED_FEATURE_FLAG_IDS", "SESSION_AWAITING_FLAG_ID", "WORK_UNIT_ID_FLAG_ID",
  ]);
  assert.equal(registry.FEATURE_FLAGS.find((flag) => flag.id === registry.AGENT_ENVIRONMENT_FLAG)?.stage, "preview");
  assert.equal(registry.FEATURE_FLAGS.find((flag) => flag.id === registry.MCP_SCHEDULES_FLAG_ID)?.stage, "preview",
    "recurring missions through MCP ships as a preview");
  assert.equal(registry.FEATURE_FLAGS.find((flag) => flag.id === registry.WORK_UNIT_ID_FLAG_ID)?.stage, "preview",
    "the work unit id ships as a preview");
  assert.equal(registry.FEATURE_FLAGS.find((flag) => flag.id === registry.SESSION_AWAITING_FLAG_ID)?.stage, "preview",
    "awaiting background work ships as a preview");
  assert.ok(registry.FEATURE_FLAGS.some(flag => flag.id === "automatic-pr-branch-update" && flag.stage === "preview"));
  assert.equal(registry.FEATURE_FLAGS.find((flag) => flag.id === "resident-active-hours")?.stage, "preview",
    "resident active hours ships as a preview");
  assert.equal(registry.FEATURE_FLAGS.find((flag) => flag.id === "resident-profiles-fold")?.stage, "preview",
    "the Residents drawer's Profiles fold ships as a preview");
  assert.equal(registry.HEADLESS_MODE_FLAG_ID, "headless-mode");
  assert.deepEqual(registry.FEATURE_FLAGS.find((flag) => flag.id === registry.HEADLESS_MODE_FLAG_ID), {
    id: "headless-mode",
    label: "Headless mode",
    description: "Dispatch work to Mission Control from a Claude Code terminal session.",
    stage: "preview",
    keywords: ["headless", "terminal", "cli", "dispatch"],
  });
  // Session control requests ships off until the operator opts in.
  assert.equal(registry.FEATURE_FLAGS.find((flag) => flag.id === "session-control-requests")?.stage, "preview");
  assert.deepEqual(registry.RETIRED_FEATURE_FLAG_IDS, []);
  const flags: readonly FeatureFlagDefinition[] = registry.FEATURE_FLAGS;
  const ids = flags.map((flag) => flag.id);
  assert.ok(ids.includes("task-shaping"), "the task shaping preview is declared");
  assert.equal(flags.find((flag) => flag.id === "async-input")?.stage, "preview", "ask without stopping ships as a preview");
  assert.equal(flags.find((flag) => flag.id === "filed-plan-decisions")?.stage, "preview", "filed plan decisions ships as a preview");
  assert.ok(ids.indexOf("filed-plan-decisions") === ids.indexOf("async-input") + 1, "filed plan decisions sits beside the flag it needs");
  // Reports and inbox upgrades ships as a preview, off until the operator opts in.
  const inbox = flags.find((flag) => flag.id === INBOX_FLAG);
  assert.equal(inbox?.stage, "preview", "reports and inbox upgrades ships as a preview");
  assert.equal(inbox?.label, "Reports and inbox upgrades");
  assert.equal(resolveFeatureFlag(INBOX_FLAG as FeatureFlagId, FEATURE_FLAGS_DEFAULTS, flags), false, "off by default");
  // Voice addressing ships as a preview, off until the operator opts in, and the flags it needs
  // are real flags of this registry (a flag cannot require another; Setup offers them instead).
  const voice = flags.find((flag) => flag.id === VOICE_FLAG);
  assert.equal(voice?.stage, "preview", "voice addressing ships as a preview");
  assert.equal(voice?.label, "Voice addressing");
  assert.equal(resolveFeatureFlag(VOICE_FLAG, FEATURE_FLAGS_DEFAULTS, flags), false, "off by default");
  for (const required of VOICE_REQUIRED_FLAGS) assert.ok(ids.includes(required), required);
  assert.equal(new Set(ids).size, ids.length);
  for (const flag of flags) {
    assert.match(flag.id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    assert.ok(flag.id.length <= 64 && flag.label.trim() && flag.description.trim());
    assert.ok(flag.stage === "preview" || flag.stage === "default-on");
    assert.ok(flag.keywords.every((keyword) => keyword.trim() === keyword && keyword.length > 0));
    assert.ok(!(registry.RETIRED_FEATURE_FLAG_IDS as readonly string[]).includes(flag.id));
    assert.equal(FeatureFlagIntentSchema.safeParse({ kind: "flag", id: flag.id, enabled: true }).success, true);
  }
  assert.equal(new Set(registry.RETIRED_FEATURE_FLAG_IDS).size, registry.RETIRED_FEATURE_FLAG_IDS.length);
  // Off by default: the suite's default is every preview off.
  assert.equal(resolveFeatureFlag("task-shaping", FEATURE_FLAGS_DEFAULTS), false);
  assert.equal(resolveFeatureFlag("async-input", FEATURE_FLAGS_DEFAULTS), false);
  assert.equal(resolveFeatureFlag("filed-plan-decisions", FEATURE_FLAGS_DEFAULTS), false);
  const files = ["src/shared/feature-flags.ts", "src/shared/feature-flag-registry.ts",
    ...readdirSync("src/server/feature-flags").map((name) => `src/server/feature-flags/${name}`)];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'][^"']*(?:update-preferences|\/update)\.ts/);
    if (file.startsWith("src/shared")) assert.doesNotMatch(source, /["'](?:node:|[^"']*protocol\.ts)/);
  }
});


test("the maximum config fits the reconnect/event budget", () => {
  const config = FeatureFlagsConfigSchema.parse({ enableAll: true,
    overrides: Object.fromEntries(Array.from({ length: 512 }, (_, i) =>
      [`flag-${String(i).padStart(59, "0")}`, false])),
  });
  assert.ok(Buffer.byteLength(JSON.stringify({ type: "feature_flags", config })) < 40 * 1024);
  const next = apply({ enableAll: false, overrides: { "preview-one": false, "shipped-one": false, unknown: false } },
    { kind: "master", enabled: true, enableDisabled: true });
  assert.deepEqual(resolveFeatureFlags(next, definitions), { "preview-one": true, "shipped-one": true });
  assert.deepEqual(next.overrides, { unknown: false });
});
