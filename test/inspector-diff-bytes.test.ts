import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// `fetchDiff` is the public path the byte cap actually has to hold on: the Inspector's
// prompt is built from what this returns, and `MISSION_INSPECTOR_MAX_DIFF_BYTES` promises
// that figure in bytes. Testing the clip helper alone would leave the two things that can
// still be wrong out here - which units the `truncated` flag is decided in, and whether the
// cap is applied to the diff at all.
//
// The measured defect: `full.slice(0, maxBytes)` counted UTF-16 code units, so a diff of
// CJK, emoji or box-drawing content - all of which turn up in test fixtures and terminal
// captures - passed roughly 3x the advertised ceiling into the prompt, taking the worst
// case from ~944KB to ~1.74MB. Worse, a diff whose code-unit count sat under the cap was
// never clipped at all AND reported `truncated: false`, so the ceiling was simply inert.
//
// Driven through a fake `gh` on PATH rather than a stubbed `run`, because the units
// question spans the subprocess boundary: `gh` hands us bytes and node decodes them into a
// string, and that decode is exactly where the two measures diverge.

const temp = mkdtempSync(join(tmpdir(), "mission-inspector-diff-bytes-"));
const binDir = join(temp, "bin");
const diffPath = join(temp, "payload.diff");
mkdirSync(binDir, { recursive: true });

process.env.FAKE_DIFF_PATH = diffPath;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;

// The fake serves the payload file verbatim as bytes, so the test and the subprocess
// cannot drift about what the diff "is".
const ghPath = join(binDir, "gh");
writeFileSync(
  ghPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "api") {
  process.stdout.write(fs.readFileSync(process.env.FAKE_DIFF_PATH));
} else {
  process.stderr.write("unexpected gh call: " + process.argv.slice(2).join(" "));
  process.exit(1);
}
`,
);
chmodSync(ghPath, 0o755);

const { fetchDiff } = await import("../src/server/inspector/github.ts");

after(() => rmSync(temp, { recursive: true, force: true }));

const REPLACEMENT = "�";

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    const next = value.charCodeAt(i + 1);
    if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      i++;
      continue;
    }
    return true;
  }
  return false;
}

function serve(payload: string): void {
  writeFileSync(diffPath, payload, "utf8");
}

async function fetch(maxBytes: number) {
  const res = await fetchDiff(null, "acme", "widgets", 7, maxBytes);
  // `GhResult` is not a discriminated union - `value` is optional whatever `ok` says - so
  // this has to be checked rather than narrowed, or a silently failing fake `gh` would
  // read as a diff of `undefined` and every assertion below would be vacuous.
  const value = res.value;
  if (!res.ok || !value) throw new Error(`fetchDiff failed: ${res.error ?? "no value"}`);
  return value;
}

test("a multibyte diff is capped in BYTES and decodes cleanly", async () => {
  // 3-byte characters: the shape that measured 3x the ceiling.
  const payload = `diff --git a/i18n.ts b/i18n.ts\n--- a/i18n.ts\n+++ b/i18n.ts\n${
    "+  label: \"日本語のテキスト\",\n".repeat(20_000)
  }`;
  serve(payload);
  const cap = 100_000;
  assert.ok(Buffer.byteLength(payload, "utf8") > cap, "the payload genuinely exceeds the cap");

  const value = await fetch(cap);
  const bytes = Buffer.byteLength(value.diff, "utf8");

  assert.ok(bytes <= cap, `diff is ${bytes} bytes, cap is ${cap}`);
  assert.ok(!value.diff.includes(REPLACEMENT), "no U+FFFD in the returned diff");
  assert.ok(!hasLoneSurrogate(value.diff), "no split surrogate pair at the tail");
  assert.equal(value.truncated, true, "reported truncated, from the byte comparison");
  assert.ok(payload.startsWith(value.diff), "a prefix of the real diff, nothing invented");
  // A ceiling may err short, but only by less than one character's worth.
  assert.ok(cap - bytes < 4, `spent ${bytes} of ${cap} bytes`);
});

test("emoji and box-drawing content cannot break the tail either", async () => {
  const payload = `diff --git a/tui.ts b/tui.ts\n${"+  \u{1F600} ┌───┐ é ok\n".repeat(5_000)}`;
  serve(payload);
  // Sweep caps around a 4-byte character so the cut lands inside one.
  for (let cap = 1_000; cap < 1_040; cap++) {
    const value = await fetch(cap);
    const bytes = Buffer.byteLength(value.diff, "utf8");
    assert.ok(bytes <= cap, `cap ${cap}: ${bytes} bytes`);
    assert.ok(!value.diff.includes(REPLACEMENT), `cap ${cap}: no U+FFFD`);
    assert.ok(!hasLoneSurrogate(value.diff), `cap ${cap}: no lone surrogate`);
    assert.ok(payload.startsWith(value.diff), `cap ${cap}: still a prefix`);
  }
});

test("the inert-cap regression: under the cap by code units, over it by bytes", async () => {
  // The exact case the old code got wrong in BOTH directions at once. 30_000 CJK
  // characters are 30_000 code units - under a 50_000 cap, so `full.slice` returned the
  // whole thing and `full.length > maxBytes` reported false - but 90_000 bytes.
  const body = "日".repeat(30_000);
  const payload = `diff --git a/x b/x\n+${body}\n`;
  serve(payload);
  const cap = 50_000;
  assert.ok(payload.length < cap, "under the cap by code units, as the old flag measured");
  assert.ok(Buffer.byteLength(payload, "utf8") > cap, "but over it by bytes");

  const value = await fetch(cap);
  assert.ok(Buffer.byteLength(value.diff, "utf8") <= cap, "clipped to the byte ceiling");
  assert.equal(value.truncated, true, "and says so - the old flag said false here");
});

test("an ASCII diff is unchanged in behaviour", async () => {
  const payload = `diff --git a/a.ts b/a.ts\n${"+const value = 1;\n".repeat(4_000)}`;
  serve(payload);
  const cap = 10_000;

  const value = await fetch(cap);
  // For ASCII the byte cap and the old code-unit cap are the same cut, exactly.
  assert.equal(value.diff, payload.slice(0, cap), "identical to what slice() produced");
  assert.equal(value.diff.length, cap, "a full cap's worth");
  assert.equal(value.truncated, true);
});

test("a diff under the cap is returned whole and not flagged", async () => {
  const payload = "diff --git a/s.ts b/s.ts\n+const ok = 日本語;\n";
  serve(payload);

  const value = await fetch(400_000);
  assert.equal(value.diff, payload, "returned byte-for-byte");
  assert.equal(value.truncated, false, "nothing was dropped");
});
