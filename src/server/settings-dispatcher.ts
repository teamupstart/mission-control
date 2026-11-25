import { createHmac, randomBytes } from "node:crypto";
import type { ZodType } from "zod";
import {
  isBoundedSettingsValue, SETTINGS_PAGE_SIZE, settingsFailure,
  type SettingsChoice, type SettingsFailure, type SettingsRequest, type SettingsResult,
  type SettingsValue, type SettingsValueType,
} from "@shared/settings-mcp.ts";

interface Descriptor {
  key: string;
  label: string;
  keywords: readonly string[];
}

type Choices = {
  choices?: () => readonly SettingsChoice[];
  constraints?: { choicesOnly?: true };
};

type Scalar = Exclude<SettingsValue, object>;
type Composite = Extract<SettingsValue, object>;

/**
 * Owners are synchronous so the version check, authorization check and owner mutation
 * share a daemon turn. A composite owner supplies a revision that changes on every edit,
 * including dashboard edits, through the same owner.
 */
export type SettingDescriptor = Descriptor & (
  | { access: "protected"; destination: string }
  | ({ access: "read-only"; read(): SettingsValue } & Choices)
  | ({ access: "read-write"; replacement: "scalar"; schema: ZodType<Scalar>;
       read(): Scalar; write(value: Scalar): Scalar } & Choices)
  | ({ access: "read-write"; replacement: "composite"; schema: ZodType<Composite>;
       read(): { value: Composite; revision: string }; write(value: Composite): Composite } & Choices)
);

const tokenKey = randomBytes(32);
function token(parts: unknown[]): string {
  return createHmac("sha256", tokenKey).update(JSON.stringify(parts)).digest("base64url");
}

function offsetFor(cursor: string | undefined, scope: readonly unknown[], length: number): number | null {
  if (cursor === undefined) return 0;
  const offset = Number(cursor.split(".", 1)[0]);
  if (!Number.isSafeInteger(offset) || offset < SETTINGS_PAGE_SIZE || offset >= length
    || offset % SETTINGS_PAGE_SIZE !== 0) return null;
  return cursor === cursorFor(offset, scope) ? offset : null;
}

function cursorFor(offset: number, scope: readonly unknown[]): string {
  return `${offset}.${token([...scope, offset])}`;
}

function continuation(offset: number, scope: readonly unknown[], length: number): string | undefined {
  const next = offset + SETTINGS_PAGE_SIZE;
  return next < length ? cursorFor(next, scope) : undefined;
}

function valueType(value: SettingsValue): SettingsValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Exclude<SettingsValueType, "null" | "array">;
}

/** The catalog contains only intentionally published descriptors. Storage paths confer no access. */
export function dispatchSetting(
  request: SettingsRequest,
  catalog: readonly SettingDescriptor[],
  authorize: () => SettingsFailure | null,
): SettingsResult {
  const refusal = authorize();
  if (refusal) return refusal;

  if (request.operation === "find") {
    const terms = request.query.toLowerCase().split(/\s+/);
    const matches = catalog.filter(setting => {
      const haystack = [setting.key, setting.label, ...setting.keywords].join(" ").toLowerCase();
      return terms.every(term => haystack.includes(term));
    }).map(({ key, label, access }) => ({ key, label, access }));
    const scope = ["find", request.query, catalog.map(({ key, label, access, keywords }) => [key, label, access, keywords])];
    const offset = offsetFor(request.cursor, scope, matches.length);
    if (offset === null) return settingsFailure("invalid_cursor");
    const nextCursor = continuation(offset, scope, matches.length);
    return { ok: true, operation: "find", matches: matches.slice(offset, offset + SETTINGS_PAGE_SIZE),
      ...(nextCursor && { nextCursor }) };
  }

  const matches = catalog.filter(setting => setting.key === request.key);
  if (matches.length > 1) return settingsFailure("ambiguous_key");
  const setting = matches[0];
  if (!setting) return settingsFailure("unknown_key");
  if (setting.access === "protected") return settingsFailure("protected", `Manage this setting in ${setting.destination}.`);

  try {
    if (request.operation === "get") {
      const choices = setting.choices?.();
      const scope = ["get", setting.key, choices];
      const offset = offsetFor(request.choiceCursor, scope, choices?.length ?? 0);
      if (offset === null) return settingsFailure("invalid_cursor");
      const page = choices?.slice(offset, offset + SETTINGS_PAGE_SIZE);
      if (page && !isBoundedSettingsValue(page)) return settingsFailure("value_too_large");
      let value: SettingsValue;
      let version: string | undefined;
      if (setting.access === "read-write" && setting.replacement === "composite") {
        const current = setting.read();
        value = current.value;
        version = token(["version", setting.key, current.revision]);
      } else {
        value = setting.read();
      }
      if (!isBoundedSettingsValue(value)) return settingsFailure("value_too_large");
      const nextChoiceCursor = continuation(offset, scope, choices?.length ?? 0);
      return { ok: true, operation: "get", key: setting.key, value, type: valueType(value),
        ...(setting.constraints && { constraints: setting.constraints }), ...(page && { choices: page }),
        ...(nextChoiceCursor && { nextChoiceCursor }),
        ...(version && { version }) };
    }
    if (setting.access === "read-only") return settingsFailure("read_only");
    return writeSetting(setting, request, authorize);
  } catch {
    // Owner exceptions may include paths, input or config contents. Keep those out of tool responses and logs.
    return settingsFailure("unavailable");
  }
}

function writeSetting(
  setting: Extract<SettingDescriptor, { access: "read-write" }>,
  request: Extract<SettingsRequest, { operation: "set" }>,
  authorize: () => SettingsFailure | null,
): SettingsResult {
  if (!isBoundedSettingsValue(request.value)) return settingsFailure("value_too_large");
  const confirmVersion = setting.replacement === "composite";
  if (confirmVersion && request.expectedVersion === undefined) return settingsFailure("version_required");
  if (!confirmVersion && request.expectedVersion !== undefined) return settingsFailure("invalid_request");
  if (setting.replacement === "composite") {
    const parsed = setting.schema.safeParse(request.value);
    if (!parsed.success) return settingsFailure("invalid_value");
    const current = setting.read();
    const refusal = authorize();
    if (refusal) return refusal;
    if (request.expectedVersion !== token(["version", setting.key, current.revision])) return settingsFailure("stale_version");
    return savedSetting(setting.key, setting.write(parsed.data));
  }
  const parsed = setting.schema.safeParse(request.value);
  if (!parsed.success) return settingsFailure("invalid_value");
  return authorize() ?? savedSetting(setting.key, setting.write(parsed.data));
}

function savedSetting(key: string, value: SettingsValue): SettingsResult {
  if (!isBoundedSettingsValue(value)) return settingsFailure("value_too_large");
  return { ok: true, operation: "set", key, value };
}
