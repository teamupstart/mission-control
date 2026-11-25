import { isDeepStrictEqual } from "node:util";
import type { AppConfigEntry, AppConfigInput } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

/**
 * Persist an owner's validated patch result while keeping fields that this build dropped
 * or normalized on read. The owner still decides which fields its patch replaces and
 * which it merges. Full replacements and snapshot restores use their existing writer.
 */
export function persistConfigPatch<Entry extends AppConfigEntry>(
  entry: Entry, before: object, next: AppConfigInput<Entry>,
  patch: object, mergedFields: readonly string[] = [],
): void {
  const stored = getAppConfig(entry);
  const raw = record(stored);
  const prior = record(before);
  const after = record(next);
  const result = { ...raw, ...after };
  for (const key of Object.keys(raw)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      delete result[key];
      continue;
    }
    if (!Object.hasOwn(patch, key) && isDeepStrictEqual(prior[key], after[key])) {
      result[key] = raw[key];
    } else if (mergedFields.includes(key)) {
      result[key] = preserveSiblings(raw[key], prior[key], after[key], record(patch)[key]);
    }
  }
  setAppConfig(entry, result as AppConfigInput<Entry>);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function preserveSiblings(raw: unknown, before: unknown, after: unknown, patch: unknown): unknown {
  if (after === null || typeof after !== "object" || Array.isArray(after)
    || patch === null || Array.isArray(patch)) return after;
  const old = record(before);
  const next = record(after);
  const edits = record(patch);
  // Start from the validated result so an owner's intentional removals remain removed.
  const result = { ...next };
  for (const [key, value] of Object.entries(record(raw))) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (!Object.hasOwn(edits, key) && isDeepStrictEqual(old[key], next[key])) result[key] = value;
    else if (Object.hasOwn(next, key)) result[key] = preserveSiblings(value, old[key], next[key], edits[key]);
  }
  return result;
}
