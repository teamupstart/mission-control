import { z } from "zod";

export const SETTINGS_PAGE_SIZE = 8;
export const SETTINGS_VALUE_MAX_BYTES = 16 * 1024;
export const SETTINGS_BODY_MAX_BYTES = SETTINGS_VALUE_MAX_BYTES + 2048;

const Query = z.string().trim().min(1).max(96);
const Key = z.string().min(1).max(128);
const Token = z.string().min(1).max(128);
const Value = z.unknown().refine(value => value !== undefined, "Supply a JSON value.");

// The MCP SDK lists object schemas. Keep this flat and independent of the catalog.
export const SettingsToolInputSchema = z.strictObject({
  operation: z.enum(["find", "get", "set"]),
  query: Query.optional(),
  cursor: Token.optional(),
  key: Key.optional(),
  choiceCursor: Token.optional(),
  value: Value.optional(),
  expectedVersion: Token.optional(),
});

export const SettingsRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("find"), query: Query, cursor: Token.optional() }),
  z.strictObject({ operation: z.literal("get"), key: Key, choiceCursor: Token.optional() }),
  z.strictObject({ operation: z.literal("set"), key: Key, value: Value, expectedVersion: Token.optional() }),
]);
export type SettingsRequest = z.infer<typeof SettingsRequestSchema>;

export type SettingsValue = null | boolean | number | string | SettingsValue[] | { [key: string]: SettingsValue };
export type SettingsValueType = "boolean" | "number" | "string" | "object" | "array" | "null";
export type SettingsAccess = "read-write" | "read-only" | "protected";
export interface SettingsMatch {
  key: string;
  label: string;
  access: SettingsAccess;
}
export interface SettingsChoice {
  value: SettingsValue;
  label: string;
}

export const SETTINGS_ERRORS = {
  invalid_request: "Use find with query, get with a key, or set with a key and JSON value. Use only arguments for that operation.",
  unauthorized: "Call from a live session registered in Mission Control.",
  access_disabled: "Ask the operator to check Settings > Trust and Settings > Feature flags.",
  unavailable: "Check that Mission Control is running and up to date. Read the setting before retrying a write.",
  unknown_key: "Use find to look up the exact key.",
  ambiguous_key: "Ask the operator to resolve the duplicate setting registration.",
  protected: "Open the setting in the dashboard.",
  read_only: "Use get to read this setting.",
  invalid_value: "Use get to check which values this setting accepts.",
  value_too_large: "Use the dashboard for this value. The tool only handles bounded JSON values.",
  invalid_cursor: "Repeat the original request without a cursor.",
  version_required: "Get the latest value and pass its version as expectedVersion.",
  stale_version: "Get the latest value, review the change, and retry with its version.",
} as const;
export type SettingsErrorCode = keyof typeof SETTINGS_ERRORS;
export type SettingsFailure = { ok: false; error: SettingsErrorCode; hint: string };
export type SettingsResult = SettingsFailure | { ok: true } & (
  | { operation: "find"; matches: SettingsMatch[]; nextCursor?: string }
  | { operation: "get"; key: string; value: SettingsValue; type: SettingsValueType;
      constraints?: { choicesOnly?: true }; choices?: SettingsChoice[]; nextChoiceCursor?: string; version?: string }
  | { operation: "set"; key: string; value: SettingsValue }
);

export function settingsFailure(error: SettingsErrorCode, hint: string = SETTINGS_ERRORS[error]): SettingsFailure {
  return { ok: false, error, hint };
}

const utf8 = new TextEncoder();

/** Inspect shape before stringifying so deep or wide input cannot amplify validation work. */
export function isBoundedSettingsValue(input: unknown): input is SettingsValue {
  let remaining = 512;
  let characters = SETTINGS_VALUE_MAX_BYTES;
  const countCharacters = (count: number) => (characters -= count) >= 0;
  function visit(value: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 8) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") return countCharacters(value.length);
    if (Array.isArray(value)) return value.length <= remaining && value.every(item => visit(item, depth + 1));
    if (typeof value !== "object") return false;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    const record = value as Record<string, unknown>;
    for (const key in record) {
      if (Object.hasOwn(record, key) && (key.length > 128 || !countCharacters(key.length) || !visit(record[key], depth + 1))) return false;
    }
    return true;
  }
  return visit(input, 0) && utf8.encode(JSON.stringify(input)).length <= SETTINGS_VALUE_MAX_BYTES;
}

export const SessionSettingsAccessSchema = z.strictObject({ enabled: z.boolean() });
export type SessionSettingsAccess = z.infer<typeof SessionSettingsAccessSchema>;
