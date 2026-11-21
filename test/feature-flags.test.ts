// An explicit off must survive a later opt-in to all previews, including across builds.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as registry from "../src/shared/feature-flag-registry.ts";
import {
  applyFeatureFlagIntent, explicitlyDisabledFeatureFlags, FEATURE_FLAGS_DEFAULTS,
  FeatureFlagIntentSchema, FeatureFlagsConfigSchema, resolveFeatureFlag, resolveFeatureFlags,
  type FeatureFlagDefinition, type FeatureFlagIntent, type FeatureFlagsConfig,
} from "../src/shared/feature-flags.ts";

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
test("shipped registry is data-only, declares async-input as a preview, and is disjoint from append-only tombstones", () => {
  assert.deepEqual(Object.keys(registry).sort(), ["FEATURE_FLAGS", "RETIRED_FEATURE_FLAG_IDS"]);
  assert.deepEqual(registry.FEATURE_FLAGS.map((flag) => [flag.id, flag.stage]), [["async-input", "preview"]]);
  assert.deepEqual(registry.RETIRED_FEATURE_FLAG_IDS, []);
  const flags: readonly FeatureFlagDefinition[] = registry.FEATURE_FLAGS;
  const ids = flags.map((flag) => flag.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const flag of flags) {
    assert.match(flag.id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    assert.ok(flag.id.length <= 64 && flag.label.trim() && flag.description.trim());
    assert.ok(!(registry.RETIRED_FEATURE_FLAG_IDS as readonly string[]).includes(flag.id));
  }
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
