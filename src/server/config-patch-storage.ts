import { isDeepStrictEqual } from "node:util";
import type { AppConfigEntry, AppConfigInput } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "./db.ts";

/**
 * Persist an owner's validated patch result while keeping fields that this build dropped
 * or normalized on read. Pass the keys of the fields the owner merged to retain their
 * nested siblings. Full replacements and snapshot restores use their existing writer.
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
  if (entry.schema.safeParse(result).success) {
    setAppConfig(entry, result as AppConfigInput<Entry>);
    return;
  }
  // Whole-record fallback readers can start a patch from defaults when the saved row is
  // malformed. Replace known values from the validated result and keep the siblings that
  // the merge retained. Refuse the save if the repaired row still cannot be read.
  const repaired = { ...result, ...after };
  for (const key of mergedFields) {
    repaired[key] = repairMergedValue(result[key], after[key]);
  }
  entry.schema.parse(repaired);
  setAppConfig(entry, repaired as AppConfigInput<Entry>);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function repairMergedValue(preserved: unknown, validated: unknown): unknown {
  if (validated === null || typeof validated !== "object" || Array.isArray(validated)) return validated;
  const siblings = record(preserved);
  return {
    ...siblings,
    ...Object.fromEntries(Object.entries(validated).map(([key, value]) =>
      [key, repairMergedValue(siblings[key], value)])),
  };
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
