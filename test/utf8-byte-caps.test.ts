import { test } from "node:test";
import assert from "node:assert/strict";
import { clipUtf8Bytes, decodeUtf8Whole, utf8Bytes } from "../src/server/util/utf8.ts";

// Every cap in this codebase spelled `*_BYTES` is a promise about what leaves the
// process, and `String.prototype.slice` cannot keep it: it counts UTF-16 code units, so
// one CJK, emoji or box-drawing character costs three or four bytes against a budget
// that charged it one. The Inspector's diff cap was applied that way, and a 400_000
// ceiling measured 1_200_000 bytes on 3-byte content - 3x, taking the worst-case prompt
// from ~944KB to ~1.74MB. The env var promising bytes is INSPECTOR_MAX_DIFF_BYTES.
//
// The second half matters as much as the first: these tails are READ by a model, not
// just counted. A cut through a multi-byte sequence decodes to U+FFFD and a cut through
// a surrogate pair leaves a lone code unit, either of which can break the parse of the
// diff fence it sits in. So a cap that is honoured by mangling the last character has
// only traded one defect for a quieter one - which is exactly what the binary-search
// helper this replaced did.

const REPLACEMENT = "�";

/** A lone surrogate is invisible in most assertions; look for it directly. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    // A well-formed pair is a high unit followed by a low one.
    const isHigh = code <= 0xdbff;
    const next = value.charCodeAt(i + 1);
    if (isHigh && next >= 0xdc00 && next <= 0xdfff) {
      i++;
      continue;
    }
    return true;
  }
  return false;
}

test("a multibyte diff capped at N bytes never exceeds N bytes", () => {
  // The measured regression: 3-byte characters against a byte-named cap.
  const cjk = "日".repeat(400_000);
  assert.equal(cjk.length, 400_000, "400k code units");
  assert.equal(utf8Bytes(cjk), 1_200_000, "but 1.2MB of UTF-8");

  // What the old code did, pinned so the bug cannot come back looking reasonable.
  assert.equal(utf8Bytes(cjk.slice(0, 400_000)), 1_200_000, "slice() blows the cap 3x");

  const clipped = clipUtf8Bytes(cjk, 400_000);
  assert.ok(utf8Bytes(clipped) <= 400_000, "clip honours the byte ceiling");
});

test("a capped multibyte diff decodes without replacement characters", () => {
  // Cut at EVERY offset through a mixture of 1-, 2-, 3- and 4-byte characters, because
  // the interesting cases are exactly the ones that land inside a sequence.
  const mixed = "aé日\u{1F600}─b".repeat(200);
  for (let cap = 0; cap <= utf8Bytes(mixed); cap++) {
    const out = clipUtf8Bytes(mixed, cap);
    assert.ok(utf8Bytes(out) <= cap, `cap ${cap}: within ceiling`);
    assert.ok(!out.includes(REPLACEMENT), `cap ${cap}: no U+FFFD`);
    assert.ok(!hasLoneSurrogate(out), `cap ${cap}: no split surrogate pair`);
    assert.ok(mixed.startsWith(out), `cap ${cap}: a prefix, nothing invented`);
  }
});

test("clipping never spends more than a character's worth of the budget", () => {
  // The cap is a ceiling, so erring short is correct - but it must err by at most the
  // 3 bytes of a partial sequence, not silently return far less than asked for.
  const cjk = "日".repeat(100);
  for (let cap = 0; cap <= utf8Bytes(cjk); cap++) {
    const spent = utf8Bytes(clipUtf8Bytes(cjk, cap));
    assert.ok(cap - spent < 4, `cap ${cap}: left ${cap - spent} bytes unused`);
  }
});

test("an ASCII diff is unchanged in behaviour", () => {
  // The overwhelmingly common case must still cut exactly where it always did, or this
  // fix silently reshapes every review prompt it was supposed to leave alone.
  const ascii = "diff --git a/x b/x\n+const a = 1;\n".repeat(500);
  for (const cap of [0, 1, 17, 999, ascii.length - 1, ascii.length, ascii.length + 10]) {
    assert.equal(clipUtf8Bytes(ascii, cap), ascii.slice(0, cap), `cap ${cap}: identical to slice`);
  }
  assert.equal(clipUtf8Bytes(ascii, ascii.length), ascii, "an under-cap diff is untouched");
});

test("an under-cap string is returned identically, multibyte included", () => {
  const value = "日本語 \u{1F600} ┌─┐";
  assert.equal(clipUtf8Bytes(value, utf8Bytes(value)), value, "exactly at the cap");
  assert.equal(clipUtf8Bytes(value, utf8Bytes(value) + 1), value, "one byte over");
  assert.equal(clipUtf8Bytes("", 100), "", "empty");
});

test("a nonsensical cap clips to nothing rather than to the tail", () => {
  // Buffer.subarray reads a negative end as an offset from the END, so an unguarded
  // implementation hands back nearly the whole string for a cap that asked for none.
  assert.equal(clipUtf8Bytes("日本語テキスト", 0), "");
  assert.equal(clipUtf8Bytes("日本語テキスト", -20), "");
});

test("decodeUtf8Whole drops a partial tail instead of baking in U+FFFD", () => {
  // The bounded-read case: the caller already holds bytes and cut them itself. Decoding
  // with toString() first is unrepairable - the replacement character is already in the
  // string, so no later clip can remove it.
  const buf = Buffer.from("ab\u{1F600}cd", "utf8");
  for (let n = 0; n <= buf.length; n++) {
    const out = decodeUtf8Whole(buf.subarray(0, n));
    assert.ok(!out.includes(REPLACEMENT), `n=${n}: no U+FFFD`);
    assert.ok(!hasLoneSurrogate(out), `n=${n}: no lone surrogate`);
    assert.ok(utf8Bytes(out) <= n, `n=${n}: within the bytes read`);
  }
  // The contrast that motivates it, pinned.
  assert.ok(buf.subarray(0, 4).toString("utf8").includes(REPLACEMENT), "toString mangles");
  assert.ok(!decodeUtf8Whole(buf.subarray(0, 4)).includes(REPLACEMENT), "decode does not");
});

test("the byte-cap helpers agree with what a caller uses to set `truncated`", () => {
  // fetchDiff reports `truncated` from utf8Bytes(full) > maxBytes, so the two have to
  // measure the same units - a flag derived from full.length said "not truncated" for a
  // diff this clip had just cut.
  const cjk = "日".repeat(1_000);
  const cap = 900;
  assert.ok(utf8Bytes(cjk) > cap, "genuinely over the byte cap");
  assert.notEqual(clipUtf8Bytes(cjk, cap), cjk, "so it must actually clip");
  // The old flag: 1_000 code units against a 900 cap. Right here by luck, wrong in
  // general - a 400-char CJK diff is 1_200 bytes and reported itself as complete.
  const short = "日".repeat(400);
  assert.ok(short.length < 900, "under the cap by code units");
  assert.ok(utf8Bytes(short) > 900, "over it by bytes - the flag would have lied");
});
