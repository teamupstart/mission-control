import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ALL_SETTINGS_CONTROLS } from "@shared/settings-controls.ts";
import { settingsCategoryAvailable } from "@shared/settings-registry.ts";
import { type SettingsChoice, type SettingsValue } from "@shared/settings-mcp.ts";
import { getFeatureFlagsConfig } from "./feature-flags/index.ts";
import { InvalidSettingValue, type SettingDescriptor, type SettingScalar, type SettingComposite } from "./settings-dispatcher.ts";

export interface TypedSettingField<Config> {
  key: string;
  path: readonly string[];
  control: string;
  label?: string;
  replacement?: "composite";
  choices?: readonly SettingsChoice[];
  available?: () => boolean;
  read?: (config: Config) => SettingsValue;
  patch?: (config: Config, value: SettingsValue) => unknown;
}

export function field<Config>(
  owner: string, path: string, control: string,
  options: Omit<TypedSettingField<Config>, "key" | "path" | "control"> & { key?: string } = {},
): TypedSettingField<Config> {
  return { key: `${owner}.${path}`, ...options, path: path.split("."), control };
}

const controls = new Map(ALL_SETTINGS_CONTROLS.map(control => [control.id, control]));
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

function ownValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}

function atPath(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(ownValue, value);
}

function nestedPatch(path: readonly string[], value: SettingsValue): unknown {
  return path.reduceRight<unknown>((nested, key) => ({ [key]: nested }), value);
}

function hasOnlyAcceptedKeys(input: unknown, parsed: unknown): boolean {
  if (input === null || typeof input !== "object") return true;
  return Object.entries(input).every(([key, value]) =>
    !unsafeKeys.has(key) && ownValue(parsed, key) !== undefined && hasOnlyAcceptedKeys(value, ownValue(parsed, key)));
}

/**
 * Bind an allowlisted field to a synchronous config owner. Validate the one-field patch
 * through the dashboard's schema, including refinements on enclosing maps and objects.
 */
export function bindTypedSettings<Config, Patch>(owner: {
  schema: z.ZodType<Patch>;
  read: () => Config;
  apply: (patch: Patch) => Config;
  revision?: () => string;
  changed?: (key: string) => void;
}, fields: readonly TypedSettingField<Config>[]): SettingDescriptor[] {
  return fields.map(setting => {
    const { key, path, control, label, choices } = setting;
    if (!path.length || path.some(part => unsafeKeys.has(part))) throw new Error(`Invalid path for ${key}`);
    const metadata = controls.get(control);
    if (!metadata && !label) throw new Error(`Missing search metadata for ${key}`);
    const read = (config: Config): SettingsValue =>
      setting.read ? setting.read(config) : (atPath(config, path) as SettingsValue | undefined) ?? null;
    const readScalar = (config: Config): SettingScalar => {
      const value = read(config);
      if (value !== null && typeof value === "object") throw new Error(`Expected a scalar for ${key}`);
      return value;
    };
    const readComposite = (config: Config): SettingComposite => {
      const value = read(config);
      if (value === null || typeof value !== "object") throw new Error(`Expected a composite for ${key}`);
      return value;
    };
    const write = <Value extends SettingsValue>(value: Value, project: (config: Config) => Value): Value => {
      const current = owner.read();
      const input = setting.patch ? setting.patch(current, value) : nestedPatch(path, value);
      const parsed = owner.schema.safeParse(input);
      if (!parsed.success || !hasOnlyAcceptedKeys(input, parsed.data)) throw new InvalidSettingValue();
      const effective = project(current);
      if (isDeepStrictEqual(effective, value)) return effective;
      const saved = owner.apply(parsed.data);
      owner.changed?.(key);
      return project(saved);
    };
    const descriptor = {
      key, control, label: label ?? metadata!.label,
      keywords: metadata ? [metadata.label, ...metadata.keywords] : [],
      access: "read-write" as const,
      available: () => (!metadata || settingsCategoryAvailable(metadata.category, getFeatureFlagsConfig()))
        && (setting.available?.() ?? true),
      ...(choices && { choices: () => choices, constraints: { choicesOnly: true as const } }),
    };
    if (setting.replacement === "composite") {
      const revision = owner.revision;
      if (!revision) throw new Error(`Missing revision for ${key}`);
      return {
        ...descriptor, replacement: "composite",
        schema: z.custom<SettingComposite>(value => value !== null && typeof value === "object"),
        read: () => ({ value: readComposite(owner.read()), revision: revision() }),
        write: value => write(value, readComposite),
      };
    }
    return {
      ...descriptor, replacement: "scalar",
      schema: z.custom<SettingScalar>(value => (value === null || typeof value !== "object")
        && (!choices || choices.some(choice => choice.value === value))),
      read: () => readScalar(owner.read()),
      write: value => write(value, readScalar),
    };
  });
}

export function choices(values: readonly (string | boolean | null)[]): SettingsChoice[] {
  return values.map(value => ({ value, label: value === null ? "Default" : String(value) }));
}
