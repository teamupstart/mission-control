import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  clipUtf8,
  SHAPING_LIMITS,
  ShapingFactsSchema,
  utf8Length,
  type ShapingEntry,
  type ShapingFacts,
  type ShapingRequest,
  type ShapingResult,
} from "@shared/shaping.ts";
import { decodeUtf8Whole } from "../../util/utf8.ts";
import type { TransportContext, TransportReply } from "../transports/types.ts";

/**
 * `repository-files`: the one gatherer that ships inside Mission Control. It reads only the
 * files its options name, from the worktree of the repository a call is about, and turns them
 * into context entries, a summary and facts. Nothing else in the worktree is listed or read.
 *
 * It runs on the daemon's event loop, so it is bounded by construction: an open that cannot
 * block, a handle whose identity is checked before anything is read from it, a read that stops
 * at its limit, fixed limits, and the call's signal checked between files.
 *
 * Every check is made on the file that is read, never on a path that is read afterwards: a
 * worktree file can be replaced while shaping runs. The checks are portable (Node has no
 * `openat`, `openat2` or `O_NOFOLLOW_ANY`), and they prove that no file outside the worktree is
 * read while the worktree's directories are not being rearranged during the read. A process
 * running as the operator that swaps a directory on the path between the lookup and the
 * identity check, in a tight race, can still get an outside file read. That process can read
 * the file itself, and processes running as the operator are not a boundary (`plan.md`).
 *
 * A file that cannot be used is a skip with one reason, recorded as a note. A skip is not a
 * failure: the reply is never `degraded` because of one, and the launch is never affected.
 */

const KIB = 1024;

/** The largest file this gatherer opens a read on, whatever its cap. Checked on the open handle. */
export const REPOSITORY_FILE_MAX_BYTES = 4 * KIB * KIB;
/** The most a facts file may hold. Facts are at most 64 names of at most 1024 characters a value. */
export const REPOSITORY_FACTS_MAX_BYTES = 64 * KIB;

/** Why a named file contributed nothing. Each has one sentence in the reply's notes. */
export const REPOSITORY_FILE_SKIPS = [
  "missing", "outside-worktree", "not-a-regular-file", "too-large", "unreadable", "empty",
] as const;
export type RepositoryFileSkip = (typeof REPOSITORY_FILE_SKIPS)[number];


/**
 * The filesystem calls the reader makes, so a test can replace a file or a directory at an exact
 * point between them. Production passes `node:fs/promises`.
 */
export interface RepositoryFilesFs {
  realpath(target: string): Promise<string>;
  lstat(target: string): Promise<BigIntStats>;
  open(target: string, flags: number): Promise<Pick<FileHandle, "read" | "close"> & { stat(): Promise<BigIntStats> }>;
}

export const NODE_REPOSITORY_FILES_FS: RepositoryFilesFs = {
  realpath: (target) => realpath(target),
  lstat: (target) => lstat(target, { bigint: true }),
  async open(target, flags) {
    const handle = await open(target, flags);
    return {
      read: handle.read.bind(handle) as FileHandle["read"],
      close: () => handle.close(),
      stat: () => handle.stat({ bigint: true }),
    };
  },
};

/** Thrown by a gated call that was stopped before it started. Read as `stopped`, never as a skip. */
export class CallStopped extends Error {
  constructor() { super("The shaping call stopped before this filesystem call started."); }
}

/**
 * At most one filesystem call in flight across every `repository-files` call in the daemon.
 *
 * Node runs these calls on its shared worker pool, four threads by default, and a call already
 * running on a hung network mount cannot be cancelled: it holds its thread until the mount
 * answers, deadline or not. With every call through this gate, a stalled worktree can hold at most
 * one of those threads, and unrelated daemon file work keeps the others. A caller waits for the
 * gate without holding a thread, and gives up as soon as its call is stopped. Local reads are a
 * few milliseconds, so the queue costs little.
 */
export class FsGate {
  private busy = false;
  private readonly waiting = new Set<() => void>();

  /** Run `op` alone. A `signal` stopped before `op` starts throws `CallStopped` and starts nothing. */
  async run<T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // A stopped caller may have been the one a release woke. It passes the turn on before it
    // leaves, or the waiters behind it would wait on a gate nobody holds.
    const stop = (): never => {
      if (!this.busy) this.wakeOne();
      throw new CallStopped();
    };
    while (this.busy) {
      if (signal?.aborted) stop();
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiting.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.waiting.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal?.aborted) stop();
    this.busy = true;
    try {
      return await op();
    } finally {
      this.busy = false;
      this.wakeOne();
    }
  }

  /** Wake one waiter. It looks again, and waits again if another call took the gate first. */
  private wakeOne(): void {
    const [next] = this.waiting;
    next?.();
  }

  /** Calls waiting for the gate, for tests. */
  get queued(): number { return this.waiting.size; }
}

/** The daemon's one gate for this gatherer. */
export const REPOSITORY_FILES_GATE = new FsGate();

/**
 * `fs` with every call through `gate`. Calls for a stopped `signal` throw `CallStopped` instead of
 * starting. A handle's close is gated too, but never stopped: an opened file is always closed.
 */
export function gatedFs(fs: RepositoryFilesFs, signal: AbortSignal | undefined, gate: FsGate = REPOSITORY_FILES_GATE): RepositoryFilesFs {
  return {
    realpath: (target) => gate.run(() => fs.realpath(target), signal),
    lstat: (target) => gate.run(() => fs.lstat(target), signal),
    async open(target, flags) {
      const handle = await gate.run(() => fs.open(target, flags), signal);
      return {
        read: ((...args: Parameters<FileHandle["read"]>) => gate.run(() => handle.read(...args), signal)) as FileHandle["read"],
        stat: () => gate.run(() => handle.stat(), signal),
        close: () => gate.run(() => handle.close()),
      };
    },
  };
}

/**
 * `O_NOFOLLOW` refuses a final component that became a link after the lookup. `O_NONBLOCK`
 * makes the open return at once for a named pipe with no writer or a device, instead of waiting
 * past the deadline where no abort check could release it. The handle is never read from
 * unless it is a regular file, for which `O_NONBLOCK` changes nothing.
 */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export type FileRead =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; skip: RepositoryFileSkip }
  // The call was stopped before this file was opened or read. Not a skip: nothing is recorded.
  | { ok: false; stopped: true };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** A lookup that failed: no such file, or one the operator cannot read. */
function lookupSkip(error: unknown): RepositoryFileSkip {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** A configured path names a file under the worktree: relative, with no `..` segment. */
function pathIsConfinable(configured: string): boolean {
  if (path.isAbsolute(configured) || path.win32.isAbsolute(configured)) return false;
  return !configured.split(/[\\/]/).includes("..");
}

/**
 * Bytes to text: invalid UTF-8 replaced, and at most `cap` bytes of UTF-8, cut at the last line
 * boundary that fits. `exceeded` says the bytes are a prefix of the file, so the line they end in
 * is incomplete even when it fits. A byte order mark is already gone (`contentWithinCap`).
 */
export function fileText(bytes: Buffer, cap: number, exceeded: boolean): { text: string; truncated: boolean } {
  // At a cut, a whole-character decode: the read stopped inside the file, so an incomplete
  // sequence at its end is where the cut fell, and is dropped rather than rendered as U+FFFD.
  // When the whole file was read, its last bytes are the file's own, so an incomplete sequence
  // there is malformed input and is replaced like any other: dropping it could turn a facts file
  // with trailing garbage into valid JSON. Each U+FFFD is three bytes, so the cap is applied to
  // the decoded text rather than to the bytes that were read.
  const text = exceeded ? decodeUtf8Whole(bytes) : bytes.toString("utf8");
  if (!exceeded && utf8Length(text) <= cap) return { text, truncated: false };
  return { text: cutAtLastLine(text, cap), truncated: true };
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Bytes kept past the cap, so the line cut can tell whether the cap fell exactly on a line's end:
 * two, the length of a CRLF separator.
 */
const LINE_END_LOOKAHEAD = 2;

/** How many bytes a read of a file capped at `cap` asks for: a byte order mark and the lookahead on top. */
export function boundedReadBytes(cap: number): number {
  return cap + UTF8_BOM.length + LINE_END_LOOKAHEAD;
}

/**
 * A bounded read's content: a leading byte order mark dropped, then at most `cap` bytes and the
 * lookahead past them, and whether the content is longer than `cap`. The mark is removed before
 * the cap applies, so it never counts against a file's limit, and a facts file of exactly 64 KiB
 * behind a mark is whole.
 */
export function contentWithinCap(bytes: Buffer, cap: number): { bytes: Buffer; exceeded: boolean } {
  const content = bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? bytes.subarray(UTF8_BOM.length) : bytes;
  return { bytes: content.subarray(0, cap + LINE_END_LOOKAHEAD), exceeded: content.length > cap };
}

/**
 * `text` is longer than `cap`, or is a prefix of a longer file: the longest prefix within `cap`
 * that ends at a line boundary, LF or CRLF. A cap that lands just before either separator keeps
 * the line it ends, and a cut never leaves the carriage return of a CRLF behind. A newline at
 * offset zero is a boundary like any other, so a file that opens with a blank line never
 * publishes part of the line after it. Only text with no boundary in range is cut at a character
 * boundary, so one long line still contributes.
 */
function cutAtLastLine(text: string, cap: number): string {
  const clipped = clipUtf8(text, cap);
  const next = text.slice(clipped.length, clipped.length + 2);
  // The whole CRLF is past the cap: the clipped text ends exactly at a line's end and is the
  // line's own content, a carriage return of its own included.
  if (next === "\r\n") return clipped;
  // An LF just past the cap whose CR is the clipped text's last character: that CR is the
  // separator's, not the line's.
  if (next.startsWith("\n")) return withoutCarriageReturn(clipped);
  const newline = clipped.lastIndexOf("\n");
  return newline >= 0 ? withoutCarriageReturn(clipped.slice(0, newline)) : clipped;
}

/** A line cut at its LF keeps no carriage return of a CRLF. */
function withoutCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * At most `limit` bytes from the start of `handle`, read until the limit or the end of the file,
 * whichever comes first, so a file that grows during the read is still cut off. `stopped` is
 * checked before every read, because one read on a slow mount can return after the deadline:
 * null means the call stopped and no further read was started.
 */
async function readUpTo(handle: Pick<FileHandle, "read">, limit: number, stopped: () => boolean): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(limit);
  let length = 0;
  while (length < limit) {
    if (stopped()) return null;
    const { bytesRead } = await handle.read(buffer, length, limit - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

/**
 * Read one configured file from the worktree whose real path is `root`, at most `cap` bytes of
 * text. The order is the guarantee: the path, then an open that cannot block or follow a final
 * link, then the identity of the handle, and only then the read, from that handle.
 */
export async function readWorktreeFile(
  root: string,
  configured: string,
  cap: number,
  files: RepositoryFilesFs = NODE_REPOSITORY_FILES_FS,
  signal?: AbortSignal,
): Promise<FileRead> {
  if (!pathIsConfinable(configured)) return { ok: false, skip: "outside-worktree" };
  // Every call goes through the daemon's one gate (`REPOSITORY_FILES_GATE`).
  const fs = gatedFs(files, signal);
  // A failed call is a skip, unless it was stopped before it started.
  const failed = (error: unknown, skip: RepositoryFileSkip): FileRead =>
    error instanceof CallStopped ? { ok: false, stopped: true } : { ok: false, skip };
  // Every filesystem call below can stall on a slow mount. The signal is checked before each one
  // starts, so a call stopped at its deadline starts no further I/O: a lookup that returns late is
  // the last one, and an open handle goes straight to `finally` to be closed.
  const stopped = () => signal?.aborted === true;
  if (stopped()) return { ok: false, stopped: true };

  // Path. The real path, with every link resolved, must lie inside the worktree's real path.
  let real: string;
  try { real = await fs.realpath(path.join(root, configured)); }
  catch (error) { return failed(error, lookupSkip(error)); }
  if (!inside(root, real)) return { ok: false, skip: "outside-worktree" };
  if (stopped()) return { ok: false, stopped: true };
  try {
    const info = await fs.lstat(real);
    // Never opened: a directory, a socket, a pipe or a device is skipped on its lookup alone.
    if (!info.isFile()) return { ok: false, skip: "not-a-regular-file" };
  } catch (error) {
    return failed(error, lookupSkip(error));
  }

  // Open.
  if (stopped()) return { ok: false, stopped: true };
  let handle: Awaited<ReturnType<RepositoryFilesFs["open"]>>;
  try { handle = await fs.open(real, OPEN_FLAGS); }
  catch (error) {
    // ELOOP: the final component was replaced by a link after the lookup.
    return failed(error, errorCode(error) === "ELOOP" ? "not-a-regular-file" : lookupSkip(error));
  }
  try {
    // Identity. Everything is decided on the handle, which is the file that will be read.
    if (stopped()) return { ok: false, stopped: true };
    let opened: BigIntStats;
    try { opened = await handle.stat(); }
    catch (error) { return failed(error, "unreadable"); }
    if (!opened.isFile()) return { ok: false, skip: "not-a-regular-file" };
    if (opened.size > BigInt(REPOSITORY_FILE_MAX_BYTES)) return { ok: false, skip: "too-large" };
    if (stopped()) return { ok: false, stopped: true };
    // The real path, looked up again, must still be free of links, inside the worktree, and name
    // the same device and inode as the handle. A directory on the way swapped while the open ran
    // leaves the handle naming some other file, whose inode is not the one inside the worktree.
    // This is an identity check, not a second path check: a file moved or hard-linked into the
    // worktree is a worktree file.
    let again: string;
    let named: BigIntStats;
    try { again = await fs.realpath(real); }
    catch (error) { return failed(error, lookupSkip(error)); }
    if (stopped()) return { ok: false, stopped: true };
    try { named = await fs.lstat(real); }
    catch (error) { return failed(error, lookupSkip(error)); }
    if (again !== real || !inside(root, again) || !named.isFile() || !sameFile(named, opened)) {
      return { ok: false, skip: "outside-worktree" };
    }

    // Read, from the handle, with a hard limit: a file that grows meanwhile is still cut off. The
    // read allows a byte order mark and the line-end lookahead on top of the cap.
    let read: Buffer | null;
    try { read = await readUpTo(handle, boundedReadBytes(cap), stopped); }
    catch (error) { return failed(error, "unreadable"); }
    if (read === null) return { ok: false, stopped: true };
    const bounded = contentWithinCap(read, cap);
    const { text, truncated } = fileText(bounded.bytes, cap, bounded.exceeded);
    // `empty` is a claim about the whole decoded file, so only text that was neither a prefix of
    // the file nor cut can make it. A file whose first `cap` bytes are white space is not empty,
    // and neither is one whose replacement characters pushed it past the cap so the line cut left
    // nothing: both come back truncated, and the caller decides what a blank cut is worth (a
    // facts file still reports its size). White space is one byte a character, so decoded text
    // that is blank and whole never needs cutting, and a cut text was never blank.
    if (!bounded.exceeded && !truncated && text.trim() === "") return { ok: false, skip: "empty" };
    return { ok: true, text, truncated };
  } finally {
    await handle.close().catch(() => {});
  }
}

export interface RepositoryFilesOptions {
  include: ReadonlyArray<{ path: string; maxBytes: number }>;
  summary?: string | undefined;
  facts?: string | undefined;
}

/** The most of a path's escaped form one note quotes. */
const QUOTED_PATH_CHARS = 200;

/**
 * A configured path as a note quotes it: JSON-escaped, with the escaped form held to
 * `QUOTED_PATH_CHARS`. The bound is applied after escaping, because one control character
 * escapes to six (`\u0001`), so a raw clip could still quote more than a note can carry.
 *
 * A longer path keeps its start and its end around `...`: the start names where it is, and the
 * end is its file name, so two long paths under one deep directory still read differently. Each
 * cut is made between characters, never inside an escape or a surrogate pair.
 */
export function quotedPath(configured: string): string {
  const escaped = Array.from(configured, (char) => JSON.stringify(char).slice(1, -1));
  const whole = escaped.join("");
  if (whole.length <= QUOTED_PATH_CHARS) return `"${whole}"`;
  let head = "";
  let start = 0;
  while (start < escaped.length && head.length + escaped[start]!.length <= QUOTED_PATH_CHARS / 2) head += escaped[start++];
  let tail = "";
  for (let end = escaped.length - 1; end >= start && head.length + tail.length + escaped[end]!.length <= QUOTED_PATH_CHARS; end--) {
    tail = escaped[end] + tail;
  }
  return `"${head}...${tail}"`;
}

/**
 * One skip as one short sentence: the role, the path and the reason's id, which the guide's table
 * explains. Kept short because the record holds a shaper's reason to 500 characters, so a terse
 * sentence lets that record name as many skipped files as it can.
 *
 * An include is named by its position as well as its path. A long path is quoted by its start and
 * its end, so two long paths that differ only in the middle could otherwise read alike; their
 * positions never do.
 */
function skipNote(role: { include: number } | "summary" | "facts", configured: string, reason: string): string {
  const what = typeof role === "object" ? `include ${role.include} ` : role === "summary" ? "the summary " : "the facts file ";
  return `Skipped ${what}${quotedPath(configured)} (${reason}).`;
}

/**
 * A read that was cut and left nothing but white space: a capped prefix that is blank, or a whole
 * file whose replacement characters outgrew the cap so no line fit. The file is not empty, so it
 * is not reported as `empty`, but a blank cut is no context either: it is noted, marks the reply
 * truncated, and contributes nothing.
 */
function blankCut(read: Extract<FileRead, { ok: true }>): boolean {
  return read.truncated && read.text.trim() === "";
}

function blankCutReason(cap: number): string {
  return `cut to nothing at its ${cap}-byte cap`;
}

/** A facts file's text as `repo.facts`: one JSON object of strings or lists of strings, at most 64 names. */
function parseFacts(text: string): ShapingFacts | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = ShapingFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What the gatherer collected from one worktree, before it is a reply. Null when the call was
 * stopped between files.
 */
export async function gatherRepositoryFiles(
  root: string,
  options: RepositoryFilesOptions,
  signal: AbortSignal,
  fs: RepositoryFilesFs = NODE_REPOSITORY_FILES_FS,
): Promise<ShapingResult | null> {
  const guidance: ShapingEntry[] = [];
  const skips: string[] = [];
  let summary: string | undefined;
  // Content was cut: a summary cut to fit, or a file cut to nothing. Selectors or the section get
  // less than the file holds, so the reply says its context is incomplete, entry or not.
  let cut = false;
  let facts: ShapingFacts | undefined;

  // The schema already bounds `include` below the reply's entry cap; this keeps the reply valid
  // even for a build whose schema allows more.
  for (const [index, { path: configured, maxBytes }] of options.include.slice(0, SHAPING_LIMITS.replyEntries).entries()) {
    // The include's position, counted from 1, names it in a note even when two long paths read alike.
    const position = index + 1;
    if (signal.aborted) return null;
    // An entry's id and title are its path, and both are held to fewer characters than a
    // configured path may have. A longer path is skipped unread: as an id it would make the whole
    // reply invalid, and every other entry with it.
    if (configured.length > Math.min(SHAPING_LIMITS.entryIdChars, SHAPING_LIMITS.entryTitleChars)) {
      skips.push(skipNote({ include: position }, configured, `path longer than ${SHAPING_LIMITS.entryIdChars} characters, the limit on an entry's id`));
      continue;
    }
    const cap = Math.min(maxBytes, SHAPING_LIMITS.entryBytes);
    const read = await readWorktreeFile(root, configured, cap, fs, signal);
    if ("stopped" in read) return null;
    if (!read.ok) { skips.push(skipNote({ include: position }, configured, read.skip)); continue; }
    if (blankCut(read)) { cut = true; skips.push(skipNote({ include: position }, configured, blankCutReason(cap))); continue; }
    guidance.push({ id: configured, title: configured, path: configured, body: read.text, ...(read.truncated ? { truncated: true } : {}) });
  }

  if (options.summary !== undefined) {
    if (signal.aborted) return null;
    const read = await readWorktreeFile(root, options.summary, SHAPING_LIMITS.summaryBytes, fs, signal);
    if ("stopped" in read) return null;
    if (!read.ok) skips.push(skipNote("summary", options.summary, read.skip));
    else if (blankCut(read)) { cut = true; skips.push(skipNote("summary", options.summary, blankCutReason(SHAPING_LIMITS.summaryBytes))); }
    else { summary = read.text; cut ||= read.truncated; }
  }

  if (options.facts !== undefined) {
    if (signal.aborted) return null;
    const read = await readWorktreeFile(root, options.facts, REPOSITORY_FACTS_MAX_BYTES, fs, signal);
    if ("stopped" in read) return null;
    if (!read.ok) skips.push(skipNote("facts", options.facts, read.skip));
    else if (read.truncated) {
      skips.push(skipNote("facts", options.facts, `larger than ${REPOSITORY_FACTS_MAX_BYTES / KIB} KiB once decoded, so no facts`));
    } else {
      const parsed = parseFacts(read.text);
      if (parsed) facts = parsed;
      else {
        skips.push(skipNote("facts", options.facts, `not a flat JSON object of strings or string lists with at most ${SHAPING_LIMITS.facts} names, so no facts`));
      }
    }
  }
  if (signal.aborted) return null;

  return {
    guidance,
    ...(cut ? { truncated: true } : {}),
    ...(summary !== undefined || facts !== undefined ? { repo: { ...(facts ? { facts } : {}), ...(summary !== undefined ? { summary } : {}) } } : {}),
    ...(skips.length ? { notes: skipNotes(skips) } : {}),
  };
}

/**
 * Every skip, each with its path and reason, within both of the reply's caps on notes: how many,
 * and how long each one is. One note per skip while they fit; past the count, consecutive
 * sentences share a note up to its length.
 *
 * A sentence quotes at most 200 characters of escaped path and a fixed reason, so it is about a
 * third of a note, and even 32 includes, a summary and a facts file pack well inside the count:
 * no skip is dropped or reduced to a count. Both caps are still enforced here rather than
 * assumed, because a reply over either is invalid and would lose the entries that were read.
 */
export function skipNotes(skips: readonly string[]): string[] {
  const { replyNotes, replyNoteChars } = SHAPING_LIMITS;
  const fit = (text: string) => (text.length <= replyNoteChars ? text : `${text.slice(0, replyNoteChars - 3)}...`);
  const sentences = skips.map(fit);
  if (sentences.length <= replyNotes) return sentences;
  const notes: string[] = [];
  for (const sentence of sentences) {
    const last = notes.at(-1);
    if (last !== undefined && last.length + 1 + sentence.length <= replyNoteChars) notes[notes.length - 1] = `${last} ${sentence}`;
    else notes.push(sentence);
  }
  return notes.length <= replyNotes ? notes : [...notes.slice(0, replyNotes - 1), fit(notes.slice(replyNotes - 1).join(" "))];
}

/** The `builtin` transport's entry for `repository-files`. */
export async function callRepositoryFiles(
  request: ShapingRequest,
  options: RepositoryFilesOptions,
  ctx: Pick<TransportContext, "signal">,
  fs: RepositoryFilesFs = NODE_REPOSITORY_FILES_FS,
): Promise<TransportReply> {
  const worktree = request.repo.path;
  if (!worktree) return { kind: "unavailable", reason: "The repository's worktree is not available on this machine." };
  const stoppedReply: TransportReply = { kind: "timed_out", reason: "The shaping step stopped before every configured file was read." };
  // The worktree's own lookups are gated and checked like every file's: none starts once the
  // call stopped.
  if (ctx.signal.aborted) return stoppedReply;
  const gated = gatedFs(fs, ctx.signal);
  let root: string;
  try {
    root = await gated.realpath(worktree);
    if (ctx.signal.aborted) return stoppedReply;
    if (!(await gated.lstat(root)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    if (error instanceof CallStopped) return stoppedReply;
    return { kind: "unavailable", reason: "The repository's worktree is not available on this machine." };
  }
  const result = await gatherRepositoryFiles(root, options, ctx.signal, fs);
  if (!result) return stoppedReply;
  return { kind: "data", data: result };
}
