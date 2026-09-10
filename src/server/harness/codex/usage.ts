import { createHash } from "node:crypto";
import { readJsonlUsage } from "../usage-jsonl.ts";
import { CODEX_HEAD_BYTES, parseSessionMeta } from "./rollout.ts";
import type {
  HarnessUsageEvent,
  UsageCursor,
  UsageRead,
  UsageSpec,
} from "../types.ts";
import { estimateStandardApiUsage } from "./pricing.ts";

function nonNegativeNumber(value: unknown, optional = false): number | null {
  if (value === undefined && optional) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** The five token tiers of one Codex request, in the LEDGER's convention. */
export interface CodexTokenSplit {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoningOutput: number;
}

/**
 * Read one Codex usage object into the ledger's token convention, or reject it.
 *
 * THE SUBTRACTION IS THE POINT, and it is why this is a shared function rather than four
 * lines copied into each reader. Codex reports `input_tokens` INCLUSIVE of the cached and
 * cache-write tiers, while `usage_ledger` stores them disjoint so that
 * `input + output + cache_read + cache_write` is a token total rather than a number that
 * counts the cached tier twice. Anthropic's envelope reports the same tiers already
 * disjoint. Two providers, two conventions, and the one place they are reconciled has to be
 * one place: a second copy of `fullInput - cacheRead - cacheWrite` is a second chance to
 * omit it, and the resulting rows look plausible - merely inflated - forever.
 *
 * `cacheRead + cacheWrite > fullInput` is rejected rather than clamped: it means the object
 * does not follow the convention this function assumes, and a negative `input` silently
 * subtracted from a fleet total is worse than a dropped row.
 *
 * Shared by the rollout reader (an interactive Codex session's `last_token_usage`) and by
 * the headless runner (`codex exec --json`'s `turn.completed.usage`), whose payloads carry
 * byte-identical field names.
 */
export function codexTokenSplit(usage: Record<string, unknown>): CodexTokenSplit | null {
  const fullInput = nonNegativeNumber(usage.input_tokens);
  const cacheRead = nonNegativeNumber(usage.cached_input_tokens, true);
  const cacheWrite = nonNegativeNumber(usage.cache_write_input_tokens, true);
  const output = nonNegativeNumber(usage.output_tokens);
  const reasoningOutput = nonNegativeNumber(usage.reasoning_output_tokens, true);
  if (
    fullInput === null ||
    cacheRead === null ||
    cacheWrite === null ||
    output === null ||
    reasoningOutput === null ||
    cacheRead + cacheWrite > fullInput
  ) {
    return null;
  }
  return {
    input: fullInput - cacheRead - cacheWrite,
    cacheRead,
    cacheWrite,
    output,
    reasoningOutput,
  };
}

/** Parse a complete rollout record and carry its active model forward. */
function parseRecord(
  raw: string,
  modelId: string | null,
): { modelId: string | null; event: HarnessUsageEvent | null } {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { modelId, event: null };
  }
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  if (record.type === "turn_context") {
    return {
      modelId: typeof payload.model === "string" && payload.model ? payload.model : modelId,
      event: null,
    };
  }
  if (record.type !== "event_msg" || payload.type !== "token_count") {
    return { modelId, event: null };
  }
  const info = (payload.info ?? {}) as Record<string, unknown>;
  if (!info.last_token_usage || typeof info.last_token_usage !== "object") {
    return { modelId, event: null };
  }
  const split = codexTokenSplit(info.last_token_usage as Record<string, unknown>);
  if (!split) return { modelId, event: null };
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return { modelId, event: null };
  const identity = createHash("sha256").update(timestamp).update("\0").update(raw).digest("hex");
  return {
    modelId,
    event: { identity, ts, modelId, querySource: "main", vendorCostUsd: null, ...split },
  };
}

/** Codex retains its own header and token conventions over the shared bounded reader. */
export function readCodexUsage(path: string, cursor: UsageCursor, maxBytes: number): UsageRead {
  return readJsonlUsage(path, cursor, maxBytes, {
    headBytes: CODEX_HEAD_BYTES,
    header: (raw) => ({ sourceId: parseSessionMeta(raw)?.sessionId ?? null, supported: true }),
    record: parseRecord,
  });
}

export const codexUsage: UsageSpec = {
  read: readCodexUsage,
  estimate: estimateStandardApiUsage,
};
