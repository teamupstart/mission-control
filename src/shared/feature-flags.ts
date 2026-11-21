import { z } from "zod";
import { boundedRecord } from "./zod-shapes.ts";
import { FEATURE_FLAGS, RETIRED_FEATURE_FLAG_IDS } from "./feature-flag-registry.ts";

export interface FeatureFlagDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly stage: "preview" | "default-on";
  readonly keywords: readonly string[];
}
export type FeatureFlagId = (typeof FEATURE_FLAGS)[number]["id"];

const FlagIdSchema = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const FeatureFlagsConfigSchema = z.object({
  enableAll: z.boolean().default(false),
  overrides: boundedRecord(FlagIdSchema, z.boolean(), 512).default({}),
}).prefault({});
export type FeatureFlagsConfig = z.infer<typeof FeatureFlagsConfigSchema>;
export const FEATURE_FLAGS_DEFAULTS: FeatureFlagsConfig = Object.freeze({
  enableAll: false, overrides: Object.freeze({}),
});
export const FeatureFlagIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("master"), enabled: z.boolean(), enableDisabled: z.boolean().optional() }),
  z.object({ kind: z.literal("flag"), id: FlagIdSchema, enabled: z.boolean() }),
]);
export type FeatureFlagIntent = z.infer<typeof FeatureFlagIntentSchema>;

/** Unknown and retired ids never enable anything on this build. No update-channel input. */
export function resolveFeatureFlag(
  id: string, config: FeatureFlagsConfig,
  definitions: readonly FeatureFlagDefinition[] = FEATURE_FLAGS,
): boolean {
  const definition = definitions.find((flag) => flag.id === id);
  if (!definition) return false;
  return Object.hasOwn(config.overrides, id)
    ? config.overrides[id]! : definition.stage === "default-on" || config.enableAll;
}

export function resolveFeatureFlags(
  config: FeatureFlagsConfig, definitions: readonly FeatureFlagDefinition[] = FEATURE_FLAGS,
): Record<string, boolean> {
  return Object.fromEntries(definitions.map((flag) => [flag.id, resolveFeatureFlag(flag.id, config, definitions)]));
}

export function explicitlyDisabledFeatureFlags(
  config: FeatureFlagsConfig, definitions: readonly FeatureFlagDefinition[] = FEATURE_FLAGS,
): readonly FeatureFlagDefinition[] {
  return definitions.filter((flag) => Object.hasOwn(config.overrides, flag.id) && config.overrides[flag.id] === false);
}

export type FeatureFlagIntentResult =
  | { ok: true; config: FeatureFlagsConfig }
  | { ok: false; error: "unknown_flag" };

export function applyFeatureFlagIntent(
  config: FeatureFlagsConfig, intent: FeatureFlagIntent,
  definitions: readonly FeatureFlagDefinition[] = FEATURE_FLAGS,
  retiredIds: readonly string[] = RETIRED_FEATURE_FLAG_IDS,
): FeatureFlagIntentResult {
  if (intent.kind === "flag" && !definitions.some((flag) => flag.id === intent.id)) {
    return { ok: false, error: "unknown_flag" };
  }
  const overrides = { ...config.overrides };
  for (const id of retiredIds) delete overrides[id];
  if (intent.kind === "flag") overrides[intent.id] = intent.enabled;
  else if (intent.enabled && intent.enableDisabled) {
    for (const flag of definitions) if (overrides[flag.id] === false) delete overrides[flag.id];
  }
  return { ok: true, config: {
    enableAll: intent.kind === "master" ? intent.enabled : config.enableAll, overrides,
  } };
}

/** Compare the full bounded record, independently of insertion order. */
export function sameFeatureFlagsConfig(a: FeatureFlagsConfig, b: FeatureFlagsConfig): boolean {
  return a.enableAll === b.enableAll && Object.keys(a.overrides).length === Object.keys(b.overrides).length
    && Object.entries(a.overrides).every(([id, value]) => Object.hasOwn(b.overrides, id) && b.overrides[id] === value);
}
