import { statSync } from "node:fs";
import type { TranscriptMessage } from "@shared/types.ts";
import type {
  TranscriptMessages,
  TranscriptSince,
  TranscriptStreamRead,
  TranscriptWindow,
} from "./harness/types.ts";
import { completeLines, readRange, readTailLines } from "./util/file-tail.ts";

// Reading a line-per-record (JSONL) transcript, with NO knowledge of what a record
// looks like.
//
// Everything here is about BYTES: which slice of a possibly-multi-MB file to read for
// the opening turns, the recent turns, or the turns appended since an offset - none of
// which depends on whose transcript it is. What a line MEANS is the harness's business,
// supplied as a `parse` function, so a second JSONL-writing agent is a parser and a
// `narration` reader rather than a second copy of the windowing.
//
// `jsonlMessages` builds the `TranscriptMessages` capability from those two pieces. A
// harness whose record is not one-JSON-object-per-line implements the interface itself;
// nothing here is load-bearing for the contract, only for the shape we happen to have
// twice.

const NL = 0x0a; // "\n"
/** Bytes to read from the tail for a live stream's initial history. */
const INIT_TAIL_BYTES = 512 * 1024;
/** Cap on how many turns a live stream sends on connect. */
const INIT_LIMIT = 80;
/** Head bytes to scan for the opening turns (the session's original goal). */
const WINDOW_HEAD_BYTES = 128 * 1024;
/** Tail bytes to scan for the recent context (the pending question). */
const WINDOW_TAIL_BYTES = 384 * 1024;
/** Cap on a `since` window, so one long-running item can't return a whole file. */
const SINCE_MAX_BYTES = 512 * 1024;

/**
 * Turn one parsed JSONL record into a renderable message, or null to drop it.
 *
 * The one place a harness's record shape enters this file. It receives whatever
 * `JSON.parse` produced - `unknown`, not a typed record, because a malformed line is
 * ordinary rather than exceptional and must not be able to take a window down with it.
 */
export type TranscriptLineParser = (o: unknown) => TranscriptMessage | null;

/** Parse an array of JSONL lines into renderable messages. */
export function parseLines(
  lines: string[],
  parse: TranscriptLineParser,
  limit?: number,
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = parse(o);
    if (msg) out.push(msg);
  }
  return limit && out.length > limit ? out.slice(-limit) : out;
}

/**
 * A file's current byte size, or null when it is missing.
 *
 * The anchor a work item records at delivery so its verify window can start exactly at
 * its first turn. An O(1) stat; see `since` below for why bytes and not a timestamp or a
 * turn count.
 */
export function transcriptSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * What a JSONL harness has to supply to get the whole `TranscriptMessages` capability.
 *
 * Exactly ONE of the two parsers, and the union is what says so. A record shape whose
 * turns are independent supplies `parse`; one whose tool records extend an earlier turn
 * (Codex's rollout) needs the whole batch and supplies `parseBatch`. Spelling it as two
 * optional fields let a harness pass a `parse: () => null` stub beside the real batch
 * parser to satisfy the type - dead code that reads like a live contract, and no way to
 * tell from the interface which of the two would have won.
 */
export type JsonlMessagesSpec = {
  /** See `TranscriptMessages.narration`. */
  narration(path: string): string | null;
} & (
  | { parse: TranscriptLineParser; parseBatch?: undefined }
  | { parseBatch: (records: unknown[]) => TranscriptMessage[]; parse?: undefined }
);

/**
 * Build the `TranscriptMessages` capability over a one-record-per-line file.
 *
 * Every read here is bounded: a multi-MB transcript is never parsed in full, on any
 * path, because these run on a poll tick and behind an SSE stream.
 */
export function jsonlMessages(spec: JsonlMessagesSpec): TranscriptMessages {
  const { narration } = spec;
  const parseMany = (lines: string[], limit?: number): TranscriptMessage[] => {
    if (spec.parse) return parseLines(lines, spec.parse, limit);
    const records: unknown[] = [];
    for (const line of lines) {
      try {
        if (line.trim()) records.push(JSON.parse(line));
      } catch { /* malformed JSONL records are expected while a writer is active */ }
    }
    const out = spec.parseBatch(records);
    return limit && out.length > limit ? out.slice(-limit) : out;
  };

  /**
   * The opening `headTurns` plus the most recent `tailTurns`. A small file is returned
   * whole; a large one returns head+tail with the middle elided (`truncated`).
   */
  const window = (path: string, headTurns = 12, tailTurns = 48): TranscriptWindow => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { messages: [], truncated: false, headCount: 0 };
    }
    // Small enough to read whole: no head/tail split, no truncation.
    if (size <= WINDOW_HEAD_BYTES + WINDOW_TAIL_BYTES) {
      const all = parseMany(readTailLines(path, size));
      return { messages: all, truncated: false, headCount: 0 };
    }
    // Head begins at byte 0 (first line is whole) but ends mid-file (drop the partial
    // last line). Tail begins mid-file (drop the partial first line) but ends at EOF
    // (keep the last line - parseLines drops it only if it isn't valid JSON).
    const headLines = completeLines(readRange(path, 0, WINDOW_HEAD_BYTES), false, true);
    const tailLines = completeLines(readRange(path, size - WINDOW_TAIL_BYTES, size), true, false);
    const head = parseMany(headLines).slice(0, headTurns);
    const tail = parseMany(tailLines).slice(-tailTurns);
    // De-dupe by record id in case the windows overlap on a mid-size file.
    const seen = new Set(head.map((m) => m.id));
    const merged = [...head, ...tail.filter((m) => !seen.has(m.id))];
    return { messages: merged, truncated: true, headCount: head.length };
  };

  /**
   * A window read FORWARD from a byte offset - how the work queue scopes a window to a
   * single item.
   *
   * The transcript is append-only, so the file size recorded when an item was delivered
   * is an exact item boundary, and seeking to it is O(1). That beats every alternative:
   * the diff is cumulative whenever the agent doesn't commit, a turn count can span three
   * items, and filtering a head+tail window by timestamp would silently drop the item's
   * earliest turns (the ones establishing what the agent set out to do) whenever its work
   * exceeds the tail.
   */
  const since = (path: string, offset: number, maxBytes = SINCE_MAX_BYTES): TranscriptSince => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { messages: [], truncated: false, headCount: 0 };
    }
    if (size < offset) return { messages: [], truncated: false, reset: true, headCount: 0 };
    // Bound the window from the TAIL when an item wrote more than the cap: the
    // recent turns are what show whether the work landed.
    const truncated = size - offset > maxBytes;
    const start = truncated ? size - maxBytes : offset;
    const buf = readRange(path, start, size);
    // Drop the partial first line ONLY when we truncated into the middle of a line.
    // `offset` itself is a line boundary (it was EOF when the item was delivered),
    // so dropping there would discard a real turn - the item's opening one. If the
    // file happened to end mid-line at delivery, parseLines skips the unparseable
    // fragment anyway, so not dropping is safe in both cases.
    const lines = completeLines(buf, truncated, false);
    // headCount is 0 even when truncated: this window drops a PREFIX rather than a
    // middle, so the turns it returns are always contiguous and a reader slicing
    // forward from 0 can never run back into an elided boundary.
    return { messages: parseMany(lines), truncated, headCount: 0 };
  };

  /** Read the tail for a stream's initial view, and report where to resume from. */
  const initial = (path: string): TranscriptStreamRead => {
    const size = statSync(path).size;
    const start = Math.max(0, size - INIT_TAIL_BYTES);
    const buf = readRange(path, start, size);
    // If we began mid-file, drop the partial first line.
    let from = 0;
    if (start > 0) {
      const nl = buf.indexOf(NL);
      from = nl >= 0 ? nl + 1 : buf.length;
    }
    // Only parse up to the last newline; a trailing partial line stays for next read.
    const lastNl = buf.lastIndexOf(NL);
    const end = lastNl >= 0 ? lastNl + 1 : from;
    const text = buf.subarray(from, end).toString("utf8");
    const messages = parseMany(text ? text.split("\n") : [], INIT_LIMIT);
    return { messages, pos: start + end };
  };

  /** Read whatever complete lines were appended since `pos`. */
  const appended = (path: string, pos: number): TranscriptStreamRead => {
    const size = statSync(path).size;
    if (size <= pos) return { messages: [], pos };
    const buf = readRange(path, pos, size);
    const lastNl = buf.lastIndexOf(NL);
    if (lastNl < 0) return { messages: [], pos }; // no complete line yet
    const text = buf.subarray(0, lastNl + 1).toString("utf8");
    return { messages: parseMany(text.split("\n")), pos: pos + lastNl + 1 };
  };

  return { window, since, size: transcriptSize, initial, appended, narration };
}
