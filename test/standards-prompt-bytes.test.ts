import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStandards } from "../src/server/standards.ts";
import { buildReviewPrompt } from "../src/server/inspector/prompt.ts";

// What a duplicated standards doc COSTS, measured in the bytes that actually reach the
// API - not in whether `readStandards` returns the right array length, which the unit
// tests beside this one already pin.
//
// The two are worth separating because the defect was only ever visible at this end. A
// repo that ships one of AGENTS.md / CLAUDE.md as a symlink to the other - which this
// repo does - satisfied both entries of ROOT_NAMES, and de-duplication keyed on the
// REQUESTED path emitted the same file twice. Nothing was wrong-looking about it: the
// bundle was well-formed, the prompt was well-formed, every finding still worked, and
// the second copy was simply paid for on every Inspector review and every Foreman
// verify.
//
// A regression here is silent for the same reason, so the guard has to be a byte count
// rather than an eyeball: this builds the prompt BOTH ways from the same repo and
// asserts the difference.
//
// The fixture is sized at MAX_FILE_BYTES deliberately, which is the WORST case rather
// than any particular repo's: the waste is `min(fileSize, MAX_FILE_BYTES)`, so it tracks
// whatever the root doc currently weighs. That is also why this test builds its own repo
// instead of reading the checkout it runs in - AGENTS.md was streamlined from 80,918 to
// 6,076 bytes while this fix was in review, which moved the real-checkout saving from
// 24,605 bytes to 6,093 without anything here changing. A guard pinned to the live file
// would have started failing for a reason that has nothing to do with the defect.
// `docs/evidence/inspector-prompt-bytes.md` is where the checkout-specific number lives,
// and it is re-measurable by design.

/** Mirrors MAX_FILE_BYTES, so the numbers here are the ones production actually pays. */
const DOC_BYTES = 24 * 1024;
const MARKER = "the one contract this repo asserts";

function repoWithSymlinkedDoc(): { root: string; doc: string } {
  const root = mkdtempSync(join(tmpdir(), "standards-bytes-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // A realistically sized doc: the duplicate is only interesting at this scale.
  const doc = `# ${MARKER}\n${"x".repeat(DOC_BYTES - MARKER.length - 3)}`;
  writeFileSync(join(root, "AGENTS.md"), doc);
  symlinkSync(join(root, "AGENTS.md"), join(root, "CLAUDE.md"));
  return { root, doc };
}

function reviewPrompt(standards: ReturnType<typeof readStandards>): string {
  return buildReviewPrompt({
    brief: { text: "Review this change.", source: "default", truncated: false },
    standards,
    prTitle: "a small pull request",
    prBody: "a small pull request body",
    diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    diffTruncated: false,
    changedPaths: ["src/a.ts"],
    open: [],
    round: 1,
  });
}

test("a symlinked repo doc reaches the Inspector prompt ONCE, and the saving is real bytes", () => {
  const { root } = repoWithSymlinkedDoc();
  const standards = readStandards(root, ["src/a.ts"]);

  // The bundle first: one file is one document, whatever it is named.
  assert.equal(standards.docs.length, 1, "AGENTS.md and its CLAUDE.md symlink are one doc");

  const fixed = reviewPrompt(standards);

  // Exactly what the pre-fix code produced: the same document under both names. Built
  // from the SAME bundle so the comparison isolates the duplicate and nothing else.
  const duplicated = reviewPrompt({
    ...standards,
    docs: [standards.docs[0]!, { ...standards.docs[0]!, path: "CLAUDE.md" }],
  });

  const saved = Buffer.byteLength(duplicated) - Buffer.byteLength(fixed);
  assert.ok(
    saved >= DOC_BYTES,
    `de-duplicating must save at least the doc itself: saved ${saved} of ${DOC_BYTES} bytes`,
  );

  // And the direct statement of the defect: the contract is not in the prompt twice.
  assert.equal(
    fixed.split(MARKER).length - 1,
    1,
    "the repo's contract must appear once in the prompt, not once per name it has",
  );
  assert.equal(
    duplicated.split(MARKER).length - 1,
    2,
    "the comparison is only meaningful if the duplicated build really does carry it twice",
  );
});

test("two genuinely different root docs both still reach the prompt", () => {
  // The over-dedup side, asserted where it would actually hurt. Keying identity on the
  // resolved path (not on the text) is what keeps this true: a repo asserting two
  // contracts must not silently have one of them dropped from the reviewer's prompt,
  // and that failure looks exactly like a well-formed prompt.
  const root = mkdtempSync(join(tmpdir(), "standards-bytes-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# the agent contract");
  writeFileSync(join(root, "CLAUDE.md"), "# a genuinely separate contract");

  const prompt = reviewPrompt(readStandards(root, ["src/a.ts"]));
  assert.match(prompt, /the agent contract/);
  assert.match(prompt, /a genuinely separate contract/);
});
