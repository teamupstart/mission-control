import { statSync } from "node:fs";
import type { TranscriptMessage } from "@shared/types.ts";
import type {
  TranscriptInitialRead,
  TranscriptMessages,
  TranscriptPage,
  TranscriptSince,
  TranscriptStreamRead,
  TranscriptWindow,
} from "./harness/types.ts";
import { completeLines, readRange, readTailLines } from "./util/file-tail.ts";

// Reading a line-per-record (JSONL) transcript, with NO knowledge of what a record
// looks like.
//
// Everything here is about which BYTES to read to satisfy a turn budget: opening turns,
// recent turns, or turns appended since an offset. None of that depends on whose
// transcript it is. What a line MEANS is the harness's business, supplied as a `parse`
// function, so a second JSONL-writing agent is a parser and a `narration` reader rather
// than a second copy of the windowing.
//
// `jsonlMessages` builds the `TranscriptMessages` capability from those two pieces. A
// harness whose record is not one-JSON-object-per-line implements the interface itself;
// nothing here is load-bearing for the contract, only for the shape we happen to have
// twice.

const NL = 0x0a; // "\n"
/** Starting byte guess for a live stream's initial history. */
const INIT_TAIL_BYTES = 512 * 1024;
/** Turns a live stream aims to send on connect. */
const INIT_LIMIT = 80;
/** Starting byte guess for one page of older history. */
const PAGE_TAIL_BYTES = 512 * 1024;
/** Turns one backward page aims to carry. */
const PAGE_LIMIT = 80;
/** Starting byte guess for the opening turns (the session's original goal). */
const WINDOW_HEAD_BYTES = 128 * 1024;
/** Starting byte guess for the recent context (the pending question). */
const WINDOW_TAIL_BYTES = 384 * 1024;
/** First guess at a `since` window, so one long-running item can't return a whole file. */
const SINCE_MAX_BYTES = 512 * 1024;
/**
 * Turns a `since` window aims to carry, once its byte guess comes up short.
 *
 * `since` feeds an LLM prompt directly, so it needs a ceiling - but a byte ceiling was
 * the wrong one, for the reason `grow` documents. A turn count bounds the prompt in the
 * units the prompt is actually built from (`formatTranscript` caps each message), and it
 * bounds it the same way whichever harness wrote the file.
 */
const SINCE_MAX_TURNS = 48;

/**
 * Hard ceiling on one grown read, whatever turn count was asked for.
 *
 * Reading and parsing JSONL costs about 3ms/MB, so this is where a card open stops being
 * free rather than where it starts being slow - and it has to be generous, because the
 * whole point of `grow` is that the bytes a turn count costs are not ours to predict.
 */
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * Read a widening slice until it yields `want` turns, and report the slice that did.
 *
 * **A byte window is only a proxy for a turn count, and how good a proxy it is belongs
 * to the harness's record shape, not to this file.** Claude's transcript spends ~98% of
 * its bytes on records that ARE turns, so 512 KB of it is roughly a screen of
 * conversation. A Codex rollout spends 99.7% of its bytes on tool output and reasoning
 * records: the same 512 KB of a real 4.4 MB rollout carried SIX turns of a twenty-six
 * turn session, and the dashboard rendered those six AS the conversation - history that
 * was sitting in the file, lost to arithmetic that had only ever been measured against
 * one harness. No single constant serves both, so the turn count is what is fixed here
 * and the bytes are what move.
 *
 * `read` is handed a byte budget and returns the turns inside it; it must be monotonic
 * (a bigger budget returns a superset), which every caller below satisfies by growing an
 * anchored window. When a read comes up short we EXTRAPOLATE from the density it just
 * measured rather than doubling blindly, so the usual case is two reads and not five.
 * Growth stops at `limit` (the bytes actually available to this window), at
 * `MAX_SCAN_BYTES`, or as soon as `want` turns are in hand.
 */
function grow(
  limit: number,
  want: number,
  start: number,
  read: (bytes: number) => TranscriptMessage[],
): { messages: TranscriptMessage[]; bytes: number } {
  const ceiling = Math.min(limit, MAX_SCAN_BYTES);
  let bytes = Math.min(Math.max(start, 0), ceiling);
  let messages = read(bytes);
  while (messages.length < want && bytes < ceiling) {
    // Density measured, not guessed: the bytes that produced `messages.length` turns say
    // what `want` turns should cost. The 5/4 is slack for a denser stretch ahead; the
    // `bytes * 2` floor is what keeps a window that parsed to nothing making progress.
    const est = messages.length > 0 ? Math.ceil((bytes * want * 5) / (messages.length * 4)) : 0;
    const next = Math.min(ceiling, Math.max(est, bytes * 2, 1));
    if (next <= bytes) break;
    bytes = next;
    messages = read(bytes);
  }
  return { messages, bytes };
}

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
 * Initial, head/tail, and forward-from-offset reads grow only to `MAX_SCAN_BYTES`.
 * Appended stream reads start at the last reported offset, so they parse only newly
 * completed records.
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
   *
   * Both halves GROW until they hold the turns they were asked for (see `grow`), and the
   * tail grows first because it is the half a reader is answering from. What the tail
   * takes, the head may not read again: a harness whose records carry no id of their own
   * synthesizes one per BATCH (see `parseSeq` in the Codex parser), so two overlapping
   * reads de-dupe against nothing and the same turn arrives twice.
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
    // Tail begins mid-file (drop the partial first line) but ends at EOF (keep the last
    // line - parseLines drops it only if it isn't valid JSON).
    const tail = grow(size, tailTurns, WINDOW_TAIL_BYTES, (bytes) =>
      parseMany(completeLines(readRange(path, size - bytes, size), bytes < size, false)),
    );
    if (tail.bytes >= size) {
      // The tail grew to the whole file, so head and tail come out of ONE parse - which
      // is what makes ids comparable, and what lets this report honestly that nothing
      // was elided when the conversation is short enough to fit.
      const all = tail.messages;
      if (all.length <= headTurns + tailTurns) return { messages: all, truncated: false, headCount: 0 };
      const head = all.slice(0, headTurns);
      return { messages: [...head, ...all.slice(-tailTurns)], truncated: true, headCount: head.length };
    }
    // Head begins at byte 0 (first line is whole) but ends mid-file (drop the partial
    // last line), and stops short of wherever the tail began.
    const headLimit = size - tail.bytes;
    const head = grow(headLimit, headTurns, WINDOW_HEAD_BYTES, (bytes) =>
      parseMany(completeLines(readRange(path, 0, bytes), false, true)),
    ).messages.slice(0, headTurns);
    return {
      messages: [...head, ...tail.messages.slice(-tailTurns)],
      truncated: true,
      headCount: head.length,
    };
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
    const available = size - offset;
    // Bound the window from the TAIL when an item wrote more than the cap: the
    // recent turns are what show whether the work landed. The cap GROWS until it holds
    // `SINCE_MAX_TURNS` - a verifier handed a byte cap on a rollout could otherwise read
    // half a megabyte of one command's output and conclude the agent did nothing.
    let truncated = false;
    const read = (bytes: number): TranscriptMessage[] => {
      truncated = bytes < available;
      const buf = readRange(path, size - bytes, size);
      // Drop the partial first line ONLY when we truncated into the middle of a line.
      // `offset` itself is a line boundary (it was EOF when the item was delivered),
      // so dropping there would discard a real turn - the item's opening one. If the
      // file happened to end mid-line at delivery, parseLines skips the unparseable
      // fragment anyway, so not dropping is safe in both cases.
      return parseMany(completeLines(buf, truncated, false));
    };
    const { messages } = grow(available, SINCE_MAX_TURNS, Math.min(maxBytes, available), read);
    // headCount is 0 even when truncated: this window drops a PREFIX rather than a
    // middle, so the turns it returns are always contiguous and a reader slicing
    // forward from 0 can never run back into an elided boundary. The turn cap drops a
    // prefix too, so it reports itself the same way - a verifier told the window is
    // complete when it is not reads silence as "the agent did nothing".
    return {
      messages: messages.slice(-SINCE_MAX_TURNS),
      truncated: truncated || messages.length > SINCE_MAX_TURNS,
      headCount: 0,
    };
  };

  /**
   * Read the tail for a stream's initial view, and report both ends of what it read.
   *
   * This is the history the dashboard OPENS on: a card open, and every EventSource
   * reconnect, so every daemon restart. It grows to `INIT_LIMIT` turns rather than
   * budgeting bytes - a fixed byte tail meant a long Codex session's card came back
   * holding six turns of a conversation the file still had all of.
   *
   * It is no longer the ONLY history the dashboard can show, which is what `start` is
   * for: `before(path, start)` reads the page above this one, so a turn outside this
   * window is now merely off-screen rather than unreachable. That was the second half of
   * one complaint - the first was that the window read too few turns, this was that
   * nothing could ask for the rest.
   *
   * The result is deliberately NOT trimmed to `INIT_LIMIT`. `grow` stops at the first
   * read that reaches the target, so overshoot is one read's worth and bounded by
   * `INIT_TAIL_BYTES`; trimming would leave `start` pointing at turns that were cut, and
   * the next page back would re-read every one of them. An honest anchor is worth more
   * than an exact turn count - and in the shape that overshoots most, a small file read
   * whole, the overshoot IS the rest of the conversation.
   */
  const initial = (path: string): TranscriptInitialRead => {
    const size = statSync(path).size;
    let pos = size;
    let begin = 0;
    const read = (bytes: number): TranscriptMessage[] => {
      const anchor = Math.max(0, size - bytes);
      const buf = readRange(path, anchor, size);
      // If we began mid-file, drop the partial first line.
      let from = 0;
      if (anchor > 0) {
        const nl = buf.indexOf(NL);
        from = nl >= 0 ? nl + 1 : buf.length;
      }
      // Only parse up to the last newline; a trailing partial line stays for next read.
      const lastNl = buf.lastIndexOf(NL);
      const end = lastNl >= 0 ? lastNl + 1 : from;
      begin = anchor + from;
      pos = anchor + end;
      const text = buf.subarray(from, end).toString("utf8");
      return parseMany(text ? text.split("\n") : []);
    };
    const { messages } = grow(size, INIT_LIMIT, INIT_TAIL_BYTES, read);
    return { messages, pos, start: begin, atStart: begin <= 0 };
  };

  /**
   * Read the page of turns immediately BEFORE a byte offset.
   *
   * The mirror of `initial`: same growth, same turn budget, anchored at the top of a
   * window the caller already holds instead of at EOF. Chaining it - each page's `start`
   * becoming the next call's `before` - walks a session back to its first turn.
   *
   * The returned range abuts the requested one EXACTLY, which is a correctness property
   * rather than tidiness. `start` sits just after the newline preceding the first whole
   * record, so a page can neither skip a turn (a gap nobody would know was there) nor
   * repeat one. Repeats are the sharper edge: most rollout records carry no id of their
   * own, so theirs is synthesized per parse batch and two overlapping reads de-dupe
   * against nothing - the same reason `window` reads head and tail as ranges that cannot
   * overlap.
   */
  const before = (path: string, offset: number, wantTurns = PAGE_LIMIT): TranscriptPage => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { messages: [], start: 0, end: 0, atStart: true };
    }
    // An offset past EOF means the file was rotated or cleared under us, so the anchor
    // names a byte that no longer exists. Clamp rather than throw: the stream's own
    // truncation check re-seeds the panel a tick later, and until then an empty page ends
    // the scroll-back cleanly instead of surfacing an error the operator cannot act on.
    const end = Math.max(0, Math.min(offset, size));
    if (end === 0) return { messages: [], start: 0, end: 0, atStart: true };
    let begin = end;
    const read = (bytes: number): TranscriptMessage[] => {
      const anchor = Math.max(0, end - bytes);
      const buf = readRange(path, anchor, end);
      // Drop the partial first line only when this read began mid-file. The far end needs
      // no such care: `end` came from an earlier read's line boundary, so the range
      // already finishes on a whole record.
      let from = 0;
      if (anchor > 0) {
        const nl = buf.indexOf(NL);
        from = nl >= 0 ? nl + 1 : buf.length;
      }
      begin = anchor + from;
      const text = buf.subarray(from).toString("utf8");
      return parseMany(text ? text.split("\n") : []);
    };
    const { messages } = grow(end, wantTurns, PAGE_TAIL_BYTES, read);
    // A page that renders nothing is not the end of the history: a stretch of pure tool
    // output can fill a window with no turn in it, and `begin` still moved, so the caller
    // pages on. `atStart` is reserved for the two cases where it genuinely cannot - the
    // top of the file, and a record too large for the scan ceiling to step over.
    return { messages, start: begin, end, atStart: begin <= 0 || begin >= end };
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

  return { window, since, size: transcriptSize, initial, before, appended, narration };
}
