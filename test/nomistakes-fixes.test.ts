import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFixLog, parseFixSubject } from "../src/server/nomistakes-fixes.ts";

// The git log parse and the subject grammar. Both are shapes we don't control -
// no-mistakes writes the subject, git writes the numstat - so they're pinned here
// rather than exercised through a real repo.

const REC = "\x00";
const F = "\x1f";

/** Build the `--format=%x00%h%x1f%ct%x1f%s --numstat` output git actually emits. */
function log(...commits: Array<{ sha: string; ct: number; subject: string; stats?: string[] }>): string {
  return commits
    .map((c) => `${REC}${c.sha}${F}${c.ct}${F}${c.subject}\n${(c.stats ?? []).join("\n")}\n`)
    .join("");
}

test("parseFixSubject splits the step from the summary", () => {
  assert.deepEqual(parseFixSubject("no-mistakes(review): drop the unused import"), {
    step: "review",
    summary: "drop the unused import",
  });
});

test("parseFixSubject keeps a summary that itself contains a colon", () => {
  // Real: "no-mistakes(review): fix(queue): queues survive a restart". Splitting
  // on the last colon (or greedily) would eat half the summary.
  assert.deepEqual(
    parseFixSubject("no-mistakes(review): fix(queue): queues survive a restart"),
    { step: "review", summary: "fix(queue): queues survive a restart" },
  );
});

test("parseFixSubject rejects subjects that aren't no-mistakes fixes", () => {
  for (const s of [
    "chore: unrelated commit",
    "no-mistakes: missing the step",
    "no-mistakes(review):", // no summary
    "fix no-mistakes(review): not at the start",
    "",
  ]) {
    assert.equal(parseFixSubject(s), null, `should reject: ${s}`);
  }
});

test("parseFixLog reads a commit with its per-file numstat", () => {
  const out = parseFixLog(
    log({
      sha: "0eda227",
      ct: 1784085493,
      subject: "no-mistakes(review): queues survive a restart",
      stats: ["184\t12\tsrc/server/queue.ts", "96\t8\tsrc/server/registry.ts"],
    }),
  );
  assert.equal(out.length, 1);
  const fix = out[0]!;
  assert.equal(fix.sha, "0eda227");
  assert.equal(fix.step, "review");
  assert.equal(fix.summary, "queues survive a restart");
  assert.equal(fix.committedAt, 1784085493 * 1000); // seconds -> ms
  assert.equal(fix.filesChanged, 2);
  assert.equal(fix.added, 280);
  assert.equal(fix.removed, 20);
  assert.deepEqual(fix.files, [
    { path: "src/server/queue.ts", added: 184, removed: 12 },
    { path: "src/server/registry.ts", added: 96, removed: 8 },
  ]);
});

test("parseFixLog counts a binary file but doesn't score it", () => {
  // git reports `-` for both sides of a binary change; Number("-") is NaN, which
  // would poison the whole diffstat.
  const out = parseFixLog(
    log({
      sha: "abc1234",
      ct: 1,
      subject: "no-mistakes(document): add the diagram",
      stats: ["-\t-\tdocs/arch.png", "4\t2\tdocs/arch.md"],
    }),
  );
  const fix = out[0]!;
  assert.equal(fix.filesChanged, 2);
  assert.equal(fix.added, 4);
  assert.equal(fix.removed, 2);
  assert.deepEqual(fix.files[0], { path: "docs/arch.png", added: 0, removed: 0 });
});

test("parseFixLog keeps a rename's arrow path intact", () => {
  const out = parseFixLog(
    log({
      sha: "def5678",
      ct: 1,
      subject: "no-mistakes(review): rename the module",
      stats: ["1\t1\tsrc/{old => new}/thing.ts"],
    }),
  );
  assert.deepEqual(out[0]!.files, [{ path: "src/{old => new}/thing.ts", added: 1, removed: 1 }]);
});

test("parseFixLog reads several commits and drops non-fix subjects", () => {
  // --grep is only a prefilter (and it's a basic-regex match), so the parse is
  // the real gate: anything that isn't a fix subject must not become a fix.
  const out = parseFixLog(
    log(
      { sha: "aaa1111", ct: 3, subject: "no-mistakes(review): first", stats: ["1\t0\ta.ts"] },
      { sha: "bbb2222", ct: 2, subject: "chore: hand-written commit", stats: ["9\t9\tb.ts"] },
      { sha: "ccc3333", ct: 1, subject: "no-mistakes(lint): second", stats: ["2\t1\tc.ts"] },
    ),
  );
  assert.deepEqual(
    out.map((f) => f.sha),
    ["aaa1111", "ccc3333"],
  );
  assert.deepEqual(
    out.map((f) => f.step),
    ["review", "lint"],
  );
});

test("parseFixLog handles a commit that changed nothing", () => {
  // A fix round can commit with no numstat rows behind it; it should still list
  // rather than being dropped or reported as NaN.
  const out = parseFixLog(log({ sha: "eee5555", ct: 7, subject: "no-mistakes(lint): apply fixes" }));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.filesChanged, 0);
  assert.equal(out[0]!.added, 0);
  assert.equal(out[0]!.removed, 0);
  assert.deepEqual(out[0]!.files, []);
});

test("parseFixLog returns nothing for empty output", () => {
  assert.deepEqual(parseFixLog(""), []);
  assert.deepEqual(parseFixLog("\n"), []);
});

test("parseFixLog keeps the true file count when it stops listing names", () => {
  // The names are capped at 60; `filesChanged` must stay honest, or the detail
  // ends up disagreeing with the row above it about the same commit.
  const stats = Array.from({ length: 70 }, (_, i) => `1\t0\tsrc/f${i}.ts`);
  const out = parseFixLog(
    log({ sha: "big1234", ct: 1, subject: "no-mistakes(review): touch everything", stats }),
  );
  const fix = out[0]!;
  assert.equal(fix.filesChanged, 70, "the count is complete");
  assert.equal(fix.files.length, 60, "the listed names are capped");
  assert.equal(fix.added, 70, "every file still scores");
});
