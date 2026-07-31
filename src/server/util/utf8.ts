import { StringDecoder } from "node:string_decoder";

/**
 * Clipping a string to a BYTE ceiling, which `String.prototype.slice` cannot do.
 *
 * The sibling `prompt-text.ts` is the character-arithmetic one and says so; its cap is
 * spelled `PROMPT_CAP` and promises nothing about bytes. This module is for the other
 * kind of limit - the ones spelled `*_BYTES`, which are promises about what leaves the
 * process: a prompt budget, a stored payload, a pipe ceiling. `slice` counts UTF-16 code
 * units, so a cap applied with it charges one unit for a character that costs three or
 * four bytes on the wire, and the promise silently is not kept.
 *
 * It is not a rounding error. Measured on the Inspector's diff path, a 400_000 cap over
 * CJK, emoji or box-drawing content - all of which turn up in test fixtures and terminal
 * captures, and any of which is 3-4 bytes - produced 1_200_000 bytes, 3x the advertised
 * ceiling, taking the worst-case prompt from ~944KB to ~1.74MB.
 */

/**
 * Clip `value` to at most `maxBytes` of UTF-8, cutting only on a character boundary.
 *
 * The boundary matters because these tails are READ, not just counted: a cut through a
 * multi-byte sequence decodes to U+FFFD and a cut through a surrogate pair leaves a lone
 * code unit, either of which can break a model's parse of the fence the text sits in.
 *
 * `StringDecoder` is what buys that, and it is why this is not a binary search over
 * `slice`: it emits only whole characters and holds an incomplete trailing sequence in
 * its own buffer, which we discard by never calling `end()`. A search over `slice`
 * indices respects the byte cap but can still return a lone high surrogate as its last
 * code unit - measured, and the reason the workflow context helper this replaced was
 * only half right.
 *
 * The result is therefore <= `maxBytes` and never ends mid-character, which means up to
 * 3 bytes of the budget can go unspent when the boundary does not line up. That is the
 * correct direction to err for a ceiling.
 */
export function clipUtf8Bytes(value: string, maxBytes: number): string {
  // Guard the negative case explicitly: `subarray` reads a negative end as an offset
  // from the tail, so a nonsense cap would silently return nearly the whole string.
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  return decodeUtf8Whole(buf.subarray(0, maxBytes));
}

/**
 * Decode a buffer to a string, DROPPING an incomplete multi-byte sequence at its tail.
 *
 * For a caller that already holds bytes and cut them itself - a bounded `read`, a pipe
 * window. `buf.toString("utf8")` is the tempting one and it cannot be repaired after
 * the fact: it renders the partial tail as U+FFFD, so clipping the resulting string
 * only moves a replacement character around. The cut has to be judged on the bytes.
 */
export function decodeUtf8Whole(buf: Buffer): string {
  return new StringDecoder("utf8").write(buf);
}

/** UTF-8 byte length, so a caller deciding `truncated` measures the same units it caps. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
