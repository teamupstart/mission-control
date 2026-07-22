import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { CODEX_HEAD_BYTES, parseSessionMeta } from "./rollout.ts";
import type {
  HarnessUsageEvent,
  UsageCursor,
  UsageRead,
  UsageSpec,
} from "../types.ts";
import { estimateStandardApiUsage } from "./pricing.ts";

function empty(cursor: UsageCursor, reset = false, sourceId: string | null = null): UsageRead {
  return { events: [], cursor, sourceId, more: false, reset };
}

function nonNegativeNumber(value: unknown, optional = false): number | null {
  if (value === undefined && optional) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
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
  const usage = info.last_token_usage as Record<string, unknown>;
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
    return { modelId, event: null };
  }
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return { modelId, event: null };
  const identity = createHash("sha256").update(timestamp).update("\0").update(raw).digest("hex");
  return {
    modelId,
    event: {
      identity,
      ts,
      modelId,
      querySource: "main",
      input: fullInput - cacheRead - cacheWrite,
      cacheRead,
      cacheWrite,
      output,
      reasoningOutput,
    },
  };
}

/**
 * Read complete rollout records forward from a durable cursor.
 *
 * The returned offset advances only through the final newline, so a record being appended
 * during the read is retried intact. A shorter file is surfaced rather than guessed through.
 */
export function readCodexUsage(
  path: string,
  cursor: UsageCursor,
  maxBytes: number,
): UsageRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return empty(cursor);
  }
  let size: number;
  let fileId: string;
  let sourceId: string | null;
  let buf: Buffer;
  try {
    const stat = fstatSync(fd, { bigint: true });
    size = Number(stat.size);
    fileId = `${stat.dev}:${stat.ino}`;
    const head = Buffer.allocUnsafe(Math.min(size, CODEX_HEAD_BYTES));
    const headBytes = readSync(fd, head, 0, head.length, 0);
    const headText = head.subarray(0, headBytes).toString("utf8");
    const newline = headText.indexOf("\n");
    sourceId = parseSessionMeta(newline >= 0 ? headText.slice(0, newline) : headText)?.sessionId ?? null;
    if (cursor.fileId && cursor.fileId !== fileId) return empty(cursor, true, sourceId);
    if (size < cursor.offset) return empty(cursor, true, sourceId);
    const current = { ...cursor, fileId };
    if (size === cursor.offset || maxBytes <= 0) return empty(current, false, sourceId);

    const end = Math.min(size, cursor.offset + maxBytes);
    const range = Buffer.allocUnsafe(end - cursor.offset);
    const bytes = readSync(fd, range, 0, range.length, cursor.offset);
    buf = range.subarray(0, bytes);
  } catch {
    return empty(cursor);
  } finally {
    closeSync(fd);
  }
  const current = { ...cursor, fileId };
  const end = cursor.offset + buf.length;
  let from = 0;
  if (cursor.discardPartial) {
    const firstNewline = buf.indexOf(0x0a);
    if (firstNewline < 0) {
      return {
        events: [],
        cursor: { ...current, offset: end },
        sourceId,
        more: end < size,
        reset: false,
      };
    }
    from = firstNewline + 1;
  }

  const complete = buf.subarray(from);
  const lastNewline = complete.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // We just found the end of a previously skipped oversized record. Commit only that
    // boundary; bytes after it begin a new record and must be retried from their start.
    if (from > 0) {
      const offset = cursor.offset + from;
      return {
        events: [],
        cursor: { ...current, offset, discardPartial: false },
        sourceId,
        more: offset < size,
        reset: false,
      };
    }
    // A record larger than the budget cannot be retained safely in memory. Advance in
    // bounded chunks while remembering that the next prefix is a suffix to discard. Usage
    // records are tiny; this path skips oversized transcript/tool payload records so they
    // cannot permanently strand later token events.
    if (end < size) {
      return {
        events: [],
        cursor: { ...current, offset: end, discardPartial: true },
        sourceId,
        more: true,
        reset: false,
      };
    }
    return {
      events: [],
      cursor: current,
      sourceId,
      more: false,
      reset: false,
    };
  }
  const consumed = complete.subarray(0, lastNewline + 1);
  const lines = consumed.toString("utf8").split("\n");
  lines.pop();
  let modelId = cursor.modelId;
  const events: HarnessUsageEvent[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const parsed = parseRecord(raw, modelId);
    modelId = parsed.modelId;
    if (parsed.event) events.push(parsed.event);
  }
  const offset = cursor.offset + from + consumed.length;
  return {
    events,
    cursor: { offset, modelId, discardPartial: false, fileId },
    sourceId,
    more: offset < size,
    reset: false,
  };
}

export const codexUsage: UsageSpec = {
  read: readCodexUsage,
  estimate: estimateStandardApiUsage,
};
