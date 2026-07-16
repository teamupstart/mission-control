import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headlessTranscriptDir, pruneHeadlessTranscripts } from "../src/server/goal/prune.ts";
import { HEADLESS_CWD } from "../src/server/claude-cli.ts";

// This module DELETES files, so the tests are about what it must never touch at least as much
// as about what it removes.

const root = mkdtempSync(join(tmpdir(), "prune-"));
after(() => rmSync(root, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
const now = 1_000_000_000_000;

/** Write a transcript with a given age. */
function transcript(dir: string, name: string, ageMs: number): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, '{"type":"user"}\n');
  const t = (now - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}

test("the headless dir is derived from the REAL path of the cwd our runs spawn in", () => {
  // The whole safety argument: `runClaudeText` always spawns in HEADLESS_CWD, and Claude
  // derives a transcript's project dir from the spawner's cwd. So this points at a directory
  // no real session can write to - a real session's cwd is a repo, not the temp dir.
  //
  // The realpath is the part that was wrong first time and passed a weaker test anyway. Claude
  // resolves symlinks before encoding, and on macOS os.tmpdir() is /var/folders/…/T, really
  // /private/var/folders/…/T. Deriving from the UNRESOLVED path names a directory that does
  // not exist, so the sweep silently removes nothing forever. Verified against a real
  // `claude -p`: it wrote to the `-private-` form.
  const dir = headlessTranscriptDir("/projects");
  assert.equal(dir, join("/projects", realpathSync(HEADLESS_CWD).replace(/[/.]/g, "-")));
  assert.doesNotMatch(dir, /[/.]$/);

  // Pin the symlink resolution itself where the platform actually has one, rather than only
  // restating the implementation above.
  if (realpathSync(HEADLESS_CWD) !== HEADLESS_CWD) {
    assert.notEqual(
      dir,
      join("/projects", HEADLESS_CWD.replace(/[/.]/g, "-")),
      "derived from the unresolved path - this sweep would be a silent no-op",
    );
  }
});

test("old headless transcripts go, recent ones stay", () => {
  const dir = join(root, "sweep");
  const old = transcript(dir, "old.jsonl", 3 * DAY);
  const fresh = transcript(dir, "fresh.jsonl", 60_000);
  assert.equal(pruneHeadlessTranscripts(dir, DAY, now), 1);
  assert.equal(existsSync(old), false, "an old transcript survived");
  assert.equal(existsSync(fresh), true, "a recent transcript was deleted");
});

test("age is measured from the last write, not the first", () => {
  // A headless run APPENDS as it streams, so mtime is when it finished. Keying on birthtime
  // would start the clock at spawn and could delete a long run that is still writing.
  const dir = join(root, "mtime");
  const p = transcript(dir, "still-writing.jsonl", 5 * DAY);
  const recent = (now - 1000) / 1000;
  utimesSync(p, (now - 5 * DAY) / 1000, recent); // created long ago, written just now
  assert.equal(pruneHeadlessTranscripts(dir, DAY, now), 0);
  assert.equal(existsSync(p), true, "deleted a transcript that was still being written");
});

test("nothing but .jsonl is touched", () => {
  // The promise is "the transcripts our own runs wrote", not "whatever is in this directory".
  const dir = join(root, "mixed");
  transcript(dir, "old.jsonl", 3 * DAY);
  const other = transcript(dir, "notes.md", 3 * DAY);
  mkdirSync(join(dir, "subdir"), { recursive: true });
  assert.equal(pruneHeadlessTranscripts(dir, DAY, now), 1);
  assert.equal(existsSync(other), true, "deleted a non-transcript");
  assert.equal(existsSync(join(dir, "subdir")), true, "deleted a directory");
});

test("a machine that has never run one sweeps cleanly", () => {
  // The normal case on a fresh install - absence is not an error.
  assert.equal(pruneHeadlessTranscripts(join(root, "does-not-exist"), DAY, now), 0);
});
