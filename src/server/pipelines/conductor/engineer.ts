import {
  ENGINEER_LIFECYCLE_CAPABILITY,
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
import { conductorBin } from "./probe.ts";

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
  promise: Promise<PipelineEngineerResult<{ supported: boolean }>>;
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
    typeof row.engineerRunId !== "string" ||
    !(typeof row.correlationId === "string" || row.correlationId === null) ||
    typeof row.attemptKey !== "string" ||
    !Number.isInteger(row.attempt) ||
    Number(row.attempt) < 1 ||
    !(typeof row.previousEngineerRunId === "string" || row.previousEngineerRunId === null) ||
    typeof row.repoRoot !== "string" ||
    typeof row.idea !== "string" ||
    !Number.isInteger(row.eventRevision) ||
    Number(row.eventRevision) < 1 ||
    typeof row.state !== "string" ||
    !ENGINEER_STATES.has(row.state)
  ) {
    return null;
  }
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
  };
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

async function capability(): Promise<PipelineEngineerResult<{ supported: boolean }>> {
  if (capabilityAttempt && capabilityAttempt.expiresAt > Date.now()) {
    return capabilityAttempt.promise;
  }
  const promise = (async (): Promise<
    PipelineEngineerResult<{ supported: boolean }>
  > => {
    const answer = await execute(["engineer", "capabilities"], CAPABILITY_TIMEOUT_MS);
    if (!answer.ok) return answer;
    const row = record(answer.value.parsed);
    if (!row || row.schemaVersion !== 1 || row[ENGINEER_LIFECYCLE_CAPABILITY] !== true) {
      return {
        ok: true,
        value: { supported: false },
      };
    }
    return { ok: true, value: { supported: true } };
  })();
  capabilityAttempt = { expiresAt: Date.now() + CAPABILITY_CACHE_MS, promise };
  return promise;
}

async function create(input: {
  repoRoot: string;
  idea: string;
  correlationId: string;
  attemptKey: string;
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
  create,
  inspectCorrelation,
  replay,
  cancel,
};

/** Test-only reset for process-local capability caching. */
export function resetConductorEngineerCapabilityCache(): void {
  capabilityAttempt = null;
}
