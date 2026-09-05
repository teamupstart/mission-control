import {
  ENGINEER_EVENT_LIMITS,
  ENGINEER_OWNED_ATTEMPTS_CAPABILITY,
  ENGINEER_READINESS_CAPABILITY,
  ENGINEER_RETAINED_REVIEW_WORKTREES_CAPABILITY,
  ENGINEER_LIFECYCLE_CAPABILITY,
  ENGINEER_WORKTREE_RETIREMENT_CAPABILITY,
  type EngineerReadinessEvidence,
  type EngineerLifecycleEvent,
  type UnsupportedEngineerLifecycleEvent,
  type UnknownEngineerLifecycleEvent,
} from "@shared/pipeline.ts";

import { resolveBinPath, run, type RunResult } from "../../util/exec.ts";
import type {
  PipelineEngineerLifecycle,
  PipelineEngineerResult,
  PipelineEngineerRunSnapshot,
} from "../types.ts";
import { parseEngineerEvent, parseUnsupportedEngineerEvent } from "../commissions.ts";
import {
  conductorBin,
  conductorInstallationVersion,
  staleConductorBundleError,
} from "./probe.ts";

const CAPABILITY_TIMEOUT_MS = 5000;
const CAPABILITY_CACHE_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;
const ENGINEER_STATES = new Set([
  "created",
  "authoring",
  "awaiting_spec_merge",
  "cancelled",
  "failed",
  "settled",
]);

let capabilityAttempt: {
  expiresAt: number;
  promise: ReturnType<PipelineEngineerLifecycle["capability"]>;
} | null = null;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsedJson(result: RunResult): unknown | null {
  if (result.outcomeUnknown || result.overflowed || result.stdout.trim() === "") return null;
  try {
    return JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    return null;
  }
}

function failure(result: RunResult, fallback: string): PipelineEngineerResult<never> {
  const detail = result.overflowed
    ? "provider output exceeded the bounded buffer"
    : result.outcomeUnknown
      ? "provider command ended without a known outcome"
      : fallback;
  return { ok: false, error: detail.slice(0, 500), outcomeUnknown: result.outcomeUnknown };
}

function snapshot(value: unknown): PipelineEngineerRunSnapshot | null {
  const row = record(value);
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.capability !== ENGINEER_LIFECYCLE_CAPABILITY ||
    !boundedString(row.engineerRunId, ENGINEER_EVENT_LIMITS.identityChars) ||
    !(boundedString(row.correlationId, ENGINEER_EVENT_LIMITS.identityChars) || row.correlationId === null) ||
    !boundedString(row.attemptKey, ENGINEER_EVENT_LIMITS.identityChars) ||
    !Number.isSafeInteger(row.attempt) ||
    Number(row.attempt) < 1 ||
    !(boundedString(row.previousEngineerRunId, ENGINEER_EVENT_LIMITS.identityChars) || row.previousEngineerRunId === null) ||
    !boundedString(row.repoRoot, ENGINEER_EVENT_LIMITS.pathChars) ||
    !boundedString(row.idea, ENGINEER_EVENT_LIMITS.textChars) ||
    !Number.isSafeInteger(row.eventRevision) ||
    Number(row.eventRevision) < 1 ||
    typeof row.state !== "string" ||
    !ENGINEER_STATES.has(row.state)
  ) {
    return null;
  }
  const readinessValue = row.readiness ?? null;
  const failureValue = row.failure ?? null;
  const retentionValue = row.retention ?? null;
  const retirementValue = row.retirement ?? null;
  const readiness = parseReadiness(readinessValue);
  const failureEvidence = parseFailure(failureValue);
  const retention = parseRetention(retentionValue);
  const retirement = parseRetirement(retirementValue);
  if (
    (readinessValue !== null && readiness === null) ||
    (failureValue !== null && failureEvidence === null) ||
    (retentionValue !== null && retention === null) ||
    (retirementValue !== null && retirement === null) ||
    !(row.readinessRequired === undefined || typeof row.readinessRequired === "boolean") ||
    !(row.integrationOwner === undefined || boundedString(row.integrationOwner, 256) || row.integrationOwner === null)
  ) return null;
  return {
    schemaVersion: 1,
    capability: ENGINEER_LIFECYCLE_CAPABILITY,
    engineerRunId: row.engineerRunId,
    correlationId: row.correlationId as string | null,
    attemptKey: row.attemptKey,
    attempt: Number(row.attempt),
    previousEngineerRunId: row.previousEngineerRunId as string | null,
    repoRoot: row.repoRoot,
    idea: row.idea,
    eventRevision: Number(row.eventRevision),
    state: row.state as PipelineEngineerRunSnapshot["state"],
    readinessRequired: row.readinessRequired === true,
    integrationOwner: typeof row.integrationOwner === "string" ? row.integrationOwner : null,
    readiness,
    failure: failureEvidence,
    retention,
    retirement,
  };
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function stringOrNull(value: unknown, max: number): value is string | null {
  return value === null || boundedString(value, max);
}

function timestamp(value: unknown): value is string {
  return boundedString(value, ENGINEER_EVENT_LIMITS.identityChars) &&
    !Number.isNaN(Date.parse(value));
}

function retainedCommit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value);
}

function parseReadiness(value: unknown): PipelineEngineerRunSnapshot["readiness"] {
  if (value === null) return null;
  const row = record(value);
  if (!row || !["ready", "blocked", "inconclusive"].includes(String(row.status)) ||
      !boundedString(row.code, ENGINEER_EVENT_LIMITS.identityChars) ||
      !boundedString(row.summary, 240) ||
      !Array.isArray(row.checkedCapabilities) ||
      row.checkedCapabilities.length < 1 || row.checkedCapabilities.length > 32 ||
      row.checkedCapabilities.some((entry) => !boundedString(entry, 64)) ||
      typeof row.retryable !== "boolean" || !stringOrNull(row.remedy, 512) ||
      !stringOrNull(row.diagnostic, 2048) || !boundedString(row.fingerprint, 128) ||
      typeof row.permitted !== "boolean" || !timestamp(row.checkedAt)) return null;
  return row as unknown as PipelineEngineerRunSnapshot["readiness"];
}

function parseReadinessEvidence(value: unknown): EngineerReadinessEvidence | null {
  const row = record(value);
  if (!row || !["ready", "blocked", "inconclusive"].includes(String(row.status)) ||
      !boundedString(row.code, ENGINEER_EVENT_LIMITS.identityChars) ||
      !boundedString(row.summary, 240) || !Array.isArray(row.checkedCapabilities) ||
      row.checkedCapabilities.length < 1 || row.checkedCapabilities.length > 32 ||
      row.checkedCapabilities.some((entry) => !boundedString(entry, 64)) ||
      typeof row.retryable !== "boolean" || !stringOrNull(row.remedy, 512) ||
      !stringOrNull(row.diagnostic, 2048) || !boundedString(row.fingerprint, 128)) return null;
  return row as unknown as EngineerReadinessEvidence;
}

function parseFailure(value: unknown): PipelineEngineerRunSnapshot["failure"] {
  if (value === null) return null;
  const row = record(value);
  if (!row || !boundedString(row.error, 2048) ||
      !["authentication", "authorization", "remote", "workspace", "tooling", "provider", "unknown"].includes(String(row.class)) ||
      !boundedString(row.code, ENGINEER_EVENT_LIMITS.identityChars) ||
      !boundedString(row.summary, 240) ||
      typeof row.retryable !== "boolean" || !stringOrNull(row.remedy, 512) ||
      !stringOrNull(row.diagnostic, 2048)) return null;
  return row as unknown as PipelineEngineerRunSnapshot["failure"];
}

function parseRetention(value: unknown): PipelineEngineerRunSnapshot["retention"] {
  if (value === null) return null;
  const row = record(value);
  if (!row || !retainedCommit(row.retainedCommit) || !timestamp(row.retainedAt) ||
      !timestamp(row.retentionDeadline)) return null;
  return row as unknown as PipelineEngineerRunSnapshot["retention"];
}

function parseRetirement(value: unknown): PipelineEngineerRunSnapshot["retirement"] {
  if (value === null) return null;
  const row = record(value);
  if (!row || !boundedString(row.worktreePath, ENGINEER_EVENT_LIMITS.pathChars) ||
      !boundedString(row.branch, ENGINEER_EVENT_LIMITS.identityChars) ||
      !boundedString(row.planSlug, ENGINEER_EVENT_LIMITS.identityChars) ||
      !["spec_merged", "spec_closed", "task_cancelled", "retention_expired", "operator_cleanup"].includes(String(row.reason)) ||
      !(row.retainedCommit === null || retainedCommit(row.retainedCommit)) ||
      !timestamp(row.retiredAt)) return null;
  return row as unknown as PipelineEngineerRunSnapshot["retirement"];
}

async function executable(): Promise<PipelineEngineerResult<string>> {
  const configured = conductorBin();
  const resolved = await resolveBinPath(configured);
  return resolved
    ? { ok: true, value: resolved }
    : { ok: false, error: `${configured} is not on this daemon's PATH`, outcomeUnknown: false };
}

async function execute(
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<PipelineEngineerResult<{ result: RunResult; parsed: unknown }>> {
  const bin = await executable();
  if (!bin.ok) return bin;
  const result = await run(bin.value, args, { timeoutMs });
  if (result.code !== 0) {
    return failure(
      result,
      result.stderr.trim() || `provider command exited with code ${String(result.code)}`,
    );
  }
  const parsed = parsedJson(result);
  if (parsed === null) return failure(result, "provider did not answer with the expected JSON");
  return { ok: true, value: { result, parsed } };
}

async function capability(): ReturnType<PipelineEngineerLifecycle["capability"]> {
  if (capabilityAttempt && capabilityAttempt.expiresAt > Date.now()) {
    return capabilityAttempt.promise;
  }
  const promise = (async (): Promise<
    Awaited<ReturnType<PipelineEngineerLifecycle["capability"]>>
  > => {
    const bin = await executable();
    if (!bin.ok) return bin;
    const stale = staleConductorBundleError(await conductorInstallationVersion(bin.value));
    if (stale) return { ok: false, error: stale, outcomeUnknown: false };
    const answer = await execute(["engineer", "capabilities"], CAPABILITY_TIMEOUT_MS);
    if (!answer.ok) return answer;
    const row = record(answer.value.parsed);
    if (!row || row.schemaVersion !== 1 || row[ENGINEER_LIFECYCLE_CAPABILITY] !== true) {
      return {
        ok: true,
        value: { supported: false, readiness: false, worktreeRetirement: false, retainedReviewWorktrees: false, ownedAttempts: false },
      };
    }
    return { ok: true, value: {
      supported: true,
      readiness: row[ENGINEER_READINESS_CAPABILITY] === true,
      worktreeRetirement: row[ENGINEER_WORKTREE_RETIREMENT_CAPABILITY] === true,
      retainedReviewWorktrees: row[ENGINEER_RETAINED_REVIEW_WORKTREES_CAPABILITY] === true,
      ownedAttempts: row[ENGINEER_OWNED_ATTEMPTS_CAPABILITY] === true,
    } };
  })();
  capabilityAttempt = { expiresAt: Date.now() + CAPABILITY_CACHE_MS, promise };
  return promise;
}

async function create(input: {
  repoRoot: string;
  idea: string;
  correlationId: string;
  attemptKey: string;
  integrationOwner?: string;
}): Promise<PipelineEngineerResult<PipelineEngineerRunSnapshot>> {
  const answer = await execute([
    "engineer",
    "run-create",
    "--repo-root",
    input.repoRoot,
    "--idea",
    input.idea,
    "--correlation-id",
    input.correlationId,
    "--attempt-key",
    input.attemptKey,
    ...(input.integrationOwner ? ["--integration-owner", input.integrationOwner] : []),
  ]);
  if (!answer.ok) return answer;
  const parsed = snapshot(answer.value.parsed);
  return parsed &&
    parsed.repoRoot === input.repoRoot &&
    parsed.correlationId === input.correlationId &&
    parsed.attemptKey === input.attemptKey
    ? { ok: true, value: parsed }
    : failure(answer.value.result, "provider returned a malformed Engineer run snapshot");
}

async function readinessProbe(input: {
  repoRoot: string;
}): Promise<PipelineEngineerResult<EngineerReadinessEvidence>> {
  const bin = await executable();
  if (!bin.ok) return bin;
  const result = await run(bin.value, [
    "engineer",
    "readiness-probe",
    "--repo-root",
    input.repoRoot,
  ], { timeoutMs: COMMAND_TIMEOUT_MS });
  const parsed = parsedJson(result);
  const evidence = parsed === null ? null : parseReadinessEvidence(parsed);
  if (!evidence) {
    return failure(result, result.stderr.trim() || "provider returned malformed Engineer readiness evidence");
  }
  return { ok: true, value: evidence };
}

async function readiness(input: {
  engineerRunId: string;
  repoRoot: string;
}): Promise<PipelineEngineerResult<PipelineEngineerRunSnapshot>> {
  const bin = await executable();
  if (!bin.ok) return bin;
  const result = await run(bin.value, [
    "engineer",
    "run-readiness",
    "--run-id",
    input.engineerRunId,
    "--repo-root",
    input.repoRoot,
  ], { timeoutMs: COMMAND_TIMEOUT_MS });
  const parsedJsonValue = parsedJson(result);
  if (parsedJsonValue === null) {
    return failure(result, result.stderr.trim() || "provider did not answer with readiness JSON");
  }
  const parsed = snapshot(parsedJsonValue);
  return parsed && parsed.engineerRunId === input.engineerRunId && parsed.repoRoot === input.repoRoot
    ? { ok: true, value: parsed }
    : failure(result, "provider returned a malformed Engineer readiness snapshot");
}

async function inspectCorrelation(input: {
  repoRoot: string;
  correlationId: string;
}): Promise<PipelineEngineerResult<PipelineEngineerRunSnapshot[]>> {
  const answer = await execute([
    "engineer",
    "run-inspect",
    "--repo-root",
    input.repoRoot,
    "--correlation-id",
    input.correlationId,
  ]);
  if (!answer.ok) return answer;
  const row = record(answer.value.parsed);
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.capability !== ENGINEER_LIFECYCLE_CAPABILITY ||
    row.repoRoot !== input.repoRoot ||
    row.correlationId !== input.correlationId ||
    !Array.isArray(row.runs)
  ) {
    return failure(answer.value.result, "provider returned malformed Engineer correlation JSON");
  }
  const runs = row.runs.map(snapshot);
  if (runs.some((entry) => entry === null)) {
    return failure(answer.value.result, "provider returned a malformed Engineer run in correlation history");
  }
  if (
    (runs as PipelineEngineerRunSnapshot[]).some(
      (entry) => entry.repoRoot !== input.repoRoot || entry.correlationId !== input.correlationId,
    )
  ) {
    return failure(answer.value.result, "provider returned mismatched Engineer correlation history");
  }
  for (let index = 0; index < runs.length; index += 1) {
    const entry = runs[index]!;
    const predecessor = index === 0 ? null : runs[index - 1]!.engineerRunId;
    if (entry.attempt !== index + 1 || entry.previousEngineerRunId !== predecessor) {
      return failure(answer.value.result, "provider returned unordered Engineer correlation history");
    }
  }
  return { ok: true, value: runs as PipelineEngineerRunSnapshot[] };
}

async function replay(input: {
  engineerRunId: string;
  afterRevision: number;
}): Promise<
  PipelineEngineerResult<
    Array<
      EngineerLifecycleEvent | UnknownEngineerLifecycleEvent | UnsupportedEngineerLifecycleEvent
    >
  >
> {
  const answer = await execute([
    "engineer",
    "run-replay",
    "--run-id",
    input.engineerRunId,
    "--after-revision",
    String(input.afterRevision),
  ]);
  if (!answer.ok) return answer;
  const row = record(answer.value.parsed);
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.engineerRunId !== input.engineerRunId ||
    row.afterRevision !== input.afterRevision ||
    !Array.isArray(row.events)
  ) {
    return failure(answer.value.result, "provider returned malformed Engineer replay JSON");
  }
  const events: Array<
    EngineerLifecycleEvent | UnknownEngineerLifecycleEvent | UnsupportedEngineerLifecycleEvent
  > = [];
  let revision = input.afterRevision;
  for (const value of row.events) {
    const parsed = parseEngineerEvent(value);
    let event:
      | EngineerLifecycleEvent
      | UnknownEngineerLifecycleEvent
      | UnsupportedEngineerLifecycleEvent;
    if (parsed.ok) {
      event = parsed.event;
    } else {
      const unsupported = parseUnsupportedEngineerEvent(value);
      if (!unsupported.ok) {
        return failure(answer.value.result, "provider replay contained a malformed Engineer event");
      }
      event = unsupported.event;
    }
    if (event.engineerRunId !== input.engineerRunId || event.revision !== revision + 1) {
      return failure(answer.value.result, "provider replay contained a malformed Engineer event");
    }
    events.push(event);
    revision = event.revision;
  }
  return { ok: true, value: events };
}

async function cancel(input: {
  engineerRunId: string;
  reason: string;
}): Promise<PipelineEngineerResult<PipelineEngineerRunSnapshot>> {
  const answer = await execute([
    "engineer",
    "run-cancel",
    "--run-id",
    input.engineerRunId,
    "--reason",
    input.reason,
  ]);
  if (!answer.ok) return answer;
  const parsed = snapshot(answer.value.parsed);
  return parsed && parsed.engineerRunId === input.engineerRunId
    ? { ok: true, value: parsed }
    : failure(answer.value.result, "provider returned a malformed cancelled Engineer snapshot");
}

export const CONDUCTOR_ENGINEER_LIFECYCLE: PipelineEngineerLifecycle = {
  capability,
  readinessProbe,
  create,
  readiness,
  inspectCorrelation,
  replay,
  cancel,
};

/** Test-only reset for process-local capability caching. */
export function resetConductorEngineerCapabilityCache(): void {
  capabilityAttempt = null;
}
