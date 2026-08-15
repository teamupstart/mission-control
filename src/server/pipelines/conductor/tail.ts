import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

// Incremental reads of one feature's `events.jsonl`, resumable across daemon restarts.
//
// What the ledger IS good for, and what it is not. ai-conductor persists 44 of its 71 event
// kinds, and the set it does NOT persist includes `loop_halt`, `gate_verdict` and
// `halt_cleared` - so a reader that took its halts from here would never see one. Halts,
// gate verdicts and step statuses all come from files (`state.ts`); the ledger contributes
// the one fact no file carries, which is the token spend the engine attributes to each
// step, plus a cheap liveness signal in the shape of "this run's ledger grew".
//
// The records carry NO sequence number - verified against the engine's only writer, which
// stamps an ISO `ts` and nothing else. So the resumable coordinate is the BYTE OFFSET, and
// that is also the `seq` phase 5's ingest ledger will key on for a tailed event: the
// offset a record starts at is unique within a file and monotonic, which is the whole
// contract a sequence number owes.
//
// Two hazards this handles rather than assumes away:
//
//  - A PARTIAL LAST LINE. The engine appends with a single `appendFileSync`, but a reader
//    can still arrive between the write and its flush. So the offset only ever advances to
//    the last newline seen, and a trailing fragment is re-read on the next pass.
//  - A REWRITTEN LEDGER. The file is append-only and never rotated, but a worktree can be
//    cut, deleted and re-cut under the same slug, which produces a shorter file under a
//    stored offset. Anything shorter than the offset restarts at 0.

/** How many bytes one pass will read from one ledger. */
const MAX_TAIL_BYTES = 1024 * 1024;

/** How many parsed records one pass will hand back, so a burst cannot unbound a tick. */
const MAX_TAIL_RECORDS = 5000;

/** One pass over one ledger. */
export interface TailReading {
  /** Parsed records, in file order. Unparseable lines are dropped, never guessed at. */
  records: ConductorEventRecord[];
  /** Where to resume - always at a line boundary. Feed it back on the next pass. */
  offset: number;
  /** The ledger got shorter than the stored offset, so this pass restarted at 0. */
  restarted: boolean;
}

/**
 * One persisted engine event, in the shape this build reads.
 *
 * Deliberately loose. The engine's event union is TypeScript-only and unversioned, with 71
 * members and no schema, so anything narrower here would be a second copy of a contract
 * that has no first copy. Two fields are named because two are read; the rest is carried
 * as an opaque record for phase 5's ingest, which stores an unrecognised kind rather than
 * rejecting it.
 */
export interface ConductorEventRecord {
  /** The engine's discriminant. `type`, not `kind`. Null when the record carries none. */
  type: string | null;
  /** Writer-stamped ISO-8601 instant. Null when absent or not a string. */
  ts: string | null;
  /** Byte offset this record starts at - the resumable, monotonic key. */
  offset: number;
  /** The whole record, untouched. */
  body: Record<string, unknown>;
}

/** Where one feature's event ledger lives. */
export function conductorEventsPath(worktree: string): string {
  return join(worktree, ".pipeline", "events.jsonl");
}

/**
 * Read whatever has been appended since `from`.
 *
 * Total, like every reader in this module: a missing file, an unreadable one, or a
 * directory in its place all yield an empty pass at the offset that was handed in, so a
 * caller's stored offset is never corrupted by a failed read.
 *
 * Read through a file descriptor with an explicit position rather than a stream, because
 * the whole point is to start at a byte and stop at a bound - and a stream that resolved
 * after the tick had moved on would apply an old file's bytes to a new pass.
 */
export function tailConductorEvents(worktree: string, from: number): TailReading {
  const path = conductorEventsPath(worktree);
  const start = Number.isInteger(from) && from >= 0 ? from : 0;

  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { records: [], offset: start, restarted: false };
    size = stat.size;
  } catch {
    return { records: [], offset: start, restarted: false };
  }

  // Shorter than where we stopped means this is not the file we were reading.
  const restarted = size < start;
  const begin = restarted ? 0 : start;
  if (size <= begin) return { records: [], offset: begin, restarted };

  const want = Math.min(size - begin, MAX_TAIL_BYTES);
  const buffer = Buffer.allocUnsafe(want);
  let read = 0;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    read = readSync(fd, buffer, 0, want, begin);
  } catch {
    return { records: [], offset: begin, restarted };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // A descriptor we could not close is not a reason to lose the pass.
      }
    }
  }

  const text = buffer.subarray(0, read).toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  // No complete line in what we read: hold the offset and try again next pass.
  if (lastNewline < 0) return { records: [], offset: begin, restarted };

  const complete = text.slice(0, lastNewline + 1);
  const records: ConductorEventRecord[] = [];
  let cursor = begin;
  /**
   * Where the record cap stopped this pass, when it did.
   *
   * The offset MUST come back to this byte rather than to the end of what was read, or the
   * records past the cap are never seen by anything: the next pass resumes after them, and
   * their token usage is silently absent from the run's cost for ever. A cap is a bound on
   * how much one pass does, not a licence to skip work.
   */
  let cappedAt: number | null = null;
  for (const line of complete.split("\n")) {
    const at = cursor;
    // Byte length, not character length: the offset is a file position, and a multi-byte
    // character in a step's prose would otherwise drift the cursor off every line boundary
    // after it.
    cursor += Buffer.byteLength(line, "utf8") + 1;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    // The cap is checked only once a line has proved to be a RECORD, so the offset it
    // reports always points at something a later pass will actually read. Checking before
    // the parse would let a malformed line - one this reader is committed to dropping -
    // become the resume point, which is a boundary that has to be re-read and re-dropped
    // on every pass until something valid follows it.
    if (records.length >= MAX_TAIL_RECORDS) {
      cappedAt = at;
      break;
    }
    const body = parsed as Record<string, unknown>;
    records.push({
      type: typeof body.type === "string" ? body.type : null,
      ts: typeof body.ts === "string" ? body.ts : null,
      offset: at,
      body,
    });
  }

  // The cap's byte when it fired, and the end of the complete lines otherwise. Never both:
  // advancing past a record this pass declined to read loses it permanently.
  return {
    records,
    offset: cappedAt ?? begin + Buffer.byteLength(complete, "utf8"),
    restarted,
  };
}

/**
 * Total tokens the engine attributed to the steps in this batch.
 *
 * Null when the batch mentions none, which is different from zero: a run whose ledger has
 * not reached a `step_completed` yet has an unknown spend, and a chip reading `0 tokens`
 * would be a claim nobody made. Every numeric leaf of a `tokenUsage` object is summed
 * rather than named field by field, because the engine's usage shape varies by provider
 * and a reader that named `input`/`output` would silently under-count a third one.
 */
export function tokensIn(records: readonly ConductorEventRecord[]): number | null {
  let total = 0;
  let saw = false;
  for (const record of records) {
    const usage = record.body.tokenUsage;
    if (typeof usage !== "object" || usage === null) continue;
    for (const value of Object.values(usage as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        total += value;
        saw = true;
      }
    }
  }
  return saw ? total : null;
}
