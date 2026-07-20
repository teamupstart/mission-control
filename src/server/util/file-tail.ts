import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Bounded reads of an append-only line file.
 *
 * Every harness that keeps a session log keeps it as one record per line and appends
 * forever - Claude's transcript JSONL, Codex's rollout - so "read the end of it without
 * parsing megabytes" is the primitive underneath all of them. Nothing here knows what a
 * record contains, which is why it lives outside `transcript.ts`: that module is
 * Anthropic's JSONL shape, and this is byte arithmetic on a file.
 *
 * The load-bearing detail is the partial line. Starting mid-file lands in the middle of
 * a record, and a half-record is not a record that failed to parse - it is one that
 * parses as something else if the truncation happens to fall on a boundary. So a read
 * that began mid-file drops its first line, and one that ended mid-file drops its last.
 */

const NL = 0x0a; // "\n"

/** Read `[start, end)` of a file as bytes. Shorter than asked for at EOF; never throws past open. */
export function readRange(path: string, start: number, end: number): Buffer {
  const len = Math.max(0, end - start);
  if (len === 0) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Split a byte range into whole lines, discarding the partial one at either end.
 *
 * `dropFirst` when the range began mid-file, `dropLast` when it ended mid-file. Neither
 * is inferable from the buffer itself, so both are the caller's to state.
 */
export function completeLines(buf: Buffer, dropFirst: boolean, dropLast: boolean): string[] {
  let from = 0;
  if (dropFirst) {
    const nl = buf.indexOf(NL);
    from = nl >= 0 ? nl + 1 : buf.length;
  }
  let end = buf.length;
  if (dropLast) {
    const lastNl = buf.lastIndexOf(NL);
    end = lastNl >= 0 ? lastNl + 1 : from;
  }
  const text = buf.subarray(from, end).toString("utf8");
  return text ? text.split("\n") : [];
}

/**
 * Read the last `maxBytes` of a file as complete lines, dropping a partial first line
 * when we began mid-file. Returns [] when the file is missing or unreadable.
 *
 * The last line is KEPT even though the file is being appended to, because a caller
 * parsing records drops an unparseable one anyway - and a whole final record is the
 * freshest thing in the file, which is usually the reason for reading the tail at all.
 */
export function readTailLines(path: string, maxBytes: number): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - maxBytes);
  return completeLines(readRange(path, start, size), start > 0, false);
}
