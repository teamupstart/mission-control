// The whole anchor question for line comments, in one browser-safe module.
//
// A line number is not an anchor. The agent edits the file between deliveries, so by the
// time the next comment goes the number it was written against names a stranger's line.
// What survives an edit is the TEXT, which is the Inspector's rule - `fingerprint()`
// (src/server/inspector/marker.ts) deliberately excludes the line number so a push that
// shifts code down does not re-raise everything - applied to a live working file rather
// than to a pull request.
//
// Nothing here does I/O, reads a database, or imports from `node:`. `src/shared/` is a
// controlled path (no `node:` imports), and this module is additionally the one part of
// the feature that three renderers, the daemon's re-anchor pass, and the store all have to
// agree about, so it is kept pure and tested exhaustively.

/** Which renderer produced an anchor. Persisted, so append-only. */
export const FILE_COMMENT_SURFACES = ["editor", "markdown", "html"] as const;
export type FileCommentSurface = (typeof FILE_COMMENT_SURFACES)[number];

const SURFACE_SET = new Set<string>(FILE_COMMENT_SURFACES);

export function isFileCommentSurface(value: string): value is FileCommentSurface {
  return SURFACE_SET.has(value);
}

/**
 * How much anchored source text a thread may carry.
 *
 * Bounded because the quote rides the wire on every snapshot AND is pasted verbatim into
 * the payload the agent reads, so an unbounded one is both a snapshot cost and a prompt
 * cost. 4,000 characters is roughly a 60-line block of prose or code, which is far more
 * than any block a human points at; a selection larger than that is truncated at creation
 * rather than refused, because refusing to save a comment someone just wrote is worse than
 * anchoring it to its first 4,000 characters.
 */
export const FILE_COMMENT_QUOTE_MAX = 4_000;

/** The shape every surface produces and the store persists. */
export interface FileCommentAnchor {
  /** Repository-relative, exactly as the Files tab lists it. */
  path: string;
  /** 1-based, inclusive, in the file's SOURCE - never in a rendered view. */
  startLine: number;
  /** 1-based, inclusive. Equal to `startLine` for a single-line anchor. */
  endLine: number;
  /** The anchored source text, bounded by `FILE_COMMENT_QUOTE_MAX`. */
  quote: string;
  /** `sha256(path + LF + normalized quote)`. Excludes the line numbers, as above. */
  quoteHash: string;
  /**
   * The `SessionFileDocument.revision` this anchor was last valid AGAINST - not the newest
   * one seen. A successful re-anchor advances it; an `outdated` one leaves it alone,
   * because an outdated anchor was not valid against the revision that outdated it.
   *
   * Null only for an anchor created against a document whose revision was unknown.
   */
  revision: string | null;
  surface: FileCommentSurface;
}

/**
 * Line endings folded, trailing whitespace per line dropped, blank leading and trailing
 * lines dropped. Deliberately conservative compared with `fingerprint()`'s title
 * normalization: this is SOURCE, so case, indentation and punctuation are content, and
 * absorbing them would let a quote match a line that does not actually say the same thing.
 *
 * What it does absorb is the noise an editor introduces without anyone typing: a CRLF
 * checkout, a trailing space stripped on save, a selection that swept up the blank line
 * after the paragraph.
 */
export function normalizeQuote(quote: string): string {
  const lines = quote.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n");
}

/** Clamp a selection to what a thread may carry. See `FILE_COMMENT_QUOTE_MAX`. */
export function boundQuote(quote: string): string {
  return quote.length <= FILE_COMMENT_QUOTE_MAX ? quote : quote.slice(0, FILE_COMMENT_QUOTE_MAX);
}

/**
 * The anchor's identity: `sha256(path + LF + normalized quote)`, hex.
 *
 * Excludes the line numbers for `fingerprint()`'s reason, and includes the path because
 * the same paragraph in two files is two different comments. Computed on the server for
 * persistence and in the browser for a draft, which is why it is here and synchronous -
 * Web Crypto's digest is a promise, and `node:crypto` is forbidden in this directory.
 */
export function fileCommentQuoteHash(path: string, quote: string): string {
  return sha256Hex(`${path}\n${normalizeQuote(quote)}`);
}

/**
 * What a re-anchor pass concluded. Exactly three outcomes - unchanged, moved, outdated -
 * and the revision RIDES on the outcome rather than becoming a fourth.
 *
 * `unchanged` and `moved` both carry a revision for the caller to persist. `outdated`
 * carries none, deliberately: the column records the revision the anchor was last VALID
 * against, and an outdated anchor was not valid against this one.
 */
export type ReanchorOutcome =
  | { kind: "unchanged"; startLine: number; endLine: number; revision: string | null }
  | { kind: "moved"; startLine: number; endLine: number; revision: string | null }
  | { kind: "outdated" };

/**
 * Where does this anchor point in `newText`?
 *
 * `revision` is the revision OF `newText`, and it is an argument rather than something the
 * caller resolves afterwards because the first rule below is what decides whether the
 * quote is searched for at all. Drop it from the signature and that rule cannot be
 * evaluated, so every send rescans the whole file.
 *
 * The rules, in order:
 *
 * 1. Revision matches the anchor's - the bytes have not moved, so the lines are exact and
 *    there is nothing to do.
 * 2. Quote found exactly once - the anchor is that occurrence.
 * 3. Quote found several times - take the occurrence NEAREST the anchor's previous start.
 *    A repeated paragraph is ordinary in a document, and "nearest" is the only answer that
 *    does not move a comment across a file because a later section repeats a sentence.
 * 4. Quote not found - `outdated`. The caller keeps the quote, the last known line, and
 *    the thread's status; `outdated` is a flag beside a status, never one of its values.
 */
export function reanchor(
  anchor: FileCommentAnchor,
  newText: string,
  revision: string | null,
): ReanchorOutcome {
  // Rule 1. A null revision on either side is "unknown", never "the same", so it falls
  // through to the search - the cost of a rescan is far below the cost of sending a
  // comment about text that has since been deleted.
  if (revision !== null && anchor.revision !== null && revision === anchor.revision) {
    return {
      kind: "unchanged",
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      revision,
    };
  }

  const needle = normalizeQuote(anchor.quote);
  // An empty quote cannot be searched for, so it can never be confirmed present. Reporting
  // it outdated is the honest answer and is what holds it at the head of the queue rather
  // than matching it against line 1 of every file.
  if (needle === "") return { kind: "outdated" };

  const needleLines = needle.split("\n");
  const haystack = newText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));

  const starts: number[] = [];
  for (let i = 0; i + needleLines.length <= haystack.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needleLines.length; j += 1) {
      if (haystack[i + j] !== needleLines[j]) {
        hit = false;
        break;
      }
    }
    if (hit) starts.push(i + 1);
  }

  // Rule 4.
  if (starts.length === 0) return { kind: "outdated" };

  // Rules 2 and 3 are the same selection: with one occurrence "nearest" is that one.
  let best = starts[0]!;
  for (const start of starts) {
    if (Math.abs(start - anchor.startLine) < Math.abs(best - anchor.startLine)) best = start;
  }
  const startLine = best;
  const endLine = best + needleLines.length - 1;
  const kind = startLine === anchor.startLine && endLine === anchor.endLine ? "unchanged" : "moved";
  return { kind, startLine, endLine, revision };
}

/**
 * The source slice a line range names, 1-based and inclusive - the other half of the
 * anchor contract, used when a surface reports a RANGE (Markdown's `node.position`, the
 * HTML preview's resolved structural path) and the quote has to be read out of the file.
 *
 * Out-of-range lines are clamped rather than refused, following `snapToLine`
 * (`src/server/inspector/verdict.ts`): a range that half-overhangs the end of a file is a
 * stale render, and the nearest real text is a better anchor than none.
 */
export function sliceLines(text: string, startLine: number, endLine: number): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const from = Math.max(1, Math.min(startLine, lines.length));
  const to = Math.max(from, Math.min(endLine, lines.length));
  return lines.slice(from - 1, to).join("\n");
}

/**
 * SHA-256 as a browser-safe pure function, for `sha1Hex`'s reason (`src/shared/session.ts`):
 * Web Crypto's digest is asynchronous and `node:crypto` is forbidden here, and the daemon
 * and the browser must not end up with two hash algorithms for one column.
 *
 * This is not a security boundary. The hash is a stable identity for "this text in this
 * file", never a capability - the server mints thread ids and no model supplies one.
 */
export function sha256Hex(input: string): string {
  const K = SHA256_K;
  const source = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;

  const view = new DataView(bytes.buffer);
  const bitLength = source.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, "0")).join("");
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
