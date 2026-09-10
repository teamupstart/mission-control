import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { HarnessUsageEvent, UsageCursor, UsageRead } from "./types.ts";

interface UsageJsonlFormat {
  headBytes: number;
  header(raw: string, complete: boolean): { sourceId: string | null; supported: boolean };
  record(raw: string, modelId: string | null): { modelId: string | null; event: HarnessUsageEvent | null };
}

function empty(cursor: UsageCursor, reset = false, sourceId: string | null = null): UsageRead {
  return { events: [], cursor, sourceId, more: false, reset };
}

/**
 * Read complete JSONL records forward from a durable cursor.
 *
 * The returned offset advances only through the final newline, so a record being appended
 * during the read is retried intact. A shorter file is surfaced rather than guessed through.
 */
export function readJsonlUsage(
  path: string,
  cursor: UsageCursor,
  maxBytes: number,
  format: UsageJsonlFormat,
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
    const head = Buffer.allocUnsafe(Math.min(size, format.headBytes));
    const headBytes = readSync(fd, head, 0, head.length, 0);
    const headText = head.subarray(0, headBytes).toString("utf8");
    const newline = headText.indexOf("\n");
    const header = format.header(newline >= 0 ? headText.slice(0, newline) : headText, newline >= 0);
    sourceId = header.sourceId;
    if (cursor.fileId && cursor.fileId !== fileId) return empty(cursor, true, sourceId);
    if (size < cursor.offset) return empty(cursor, true, sourceId);
    if (!header.supported) return empty(cursor, false, sourceId);
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
    const parsed = format.record(raw, modelId);
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
