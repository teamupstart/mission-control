import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../shared/harness-runtime.mjs";
import type { UpdateApplyOutcome } from "../shared/update.ts";

export const UPDATE_OUTCOME_SCHEMA = 1;

export function updateOutcomePath(directory = stateDir()): string {
  return join(directory, "update-outcome.json");
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function writeUpdateOutcome(path: string, outcome: UpdateApplyOutcome): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ schema: UPDATE_OUTCOME_SCHEMA, ...outcome }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function readUpdateOutcome(path = updateOutcomePath()): UpdateApplyOutcome | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.schema !== UPDATE_OUTCOME_SCHEMA ||
      typeof record.targetVersion !== "string" ||
      !validTimestamp(record.recordedAt)
    ) {
      return null;
    }
    if (record.result === "failure" && typeof record.message === "string") {
      return {
        result: "failure",
        targetVersion: record.targetVersion,
        recordedAt: record.recordedAt,
        message: record.message,
      };
    }
    if (record.result === "in-progress" || record.result === "success") {
      return {
        result: record.result,
        targetVersion: record.targetVersion,
        recordedAt: record.recordedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Read and remove a marker so a surfaced result cannot recur forever. */
export function consumeUpdateOutcome(path = updateOutcomePath()): UpdateApplyOutcome | null {
  const outcome = readUpdateOutcome(path);
  if (outcome) rmSync(path, { force: true });
  return outcome;
}

export function clearUpdateOutcome(path = updateOutcomePath()): void {
  rmSync(path, { force: true });
}
